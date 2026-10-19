// Trust checks a recipient makes before it believes a delivery or the relay itself (spec 04 4.2, 5.2).
// Port of packages/cli/src/daemon/{senderkeys,verify}.ts and the ready check in daemon/ws.ts.
//   - every `deliver` is checked: schema, relay_sig, sender_sig, request_hash, view_sha256, recipient
//   - the `ready` frame's relay_sig proves the socket really is the relay
import { createHash, type KeyObject } from 'node:crypto'
import { type FetchLike, type Jwk, jcs } from './core'
import type { Hello, Ready } from './agent-socket-types'
import {
  type AcceptResult,
  fromB64url,
  importJwk,
  isObj,
  isStr,
  ManifestStore,
  type ManifestPersistence,
  pinnedRoots,
  refreshManifest,
  verifyDetached
} from './manifest'

export * from './manifest'

// ---- sender keys --------------------------------------------------------------------------------

export type SenderKeyLookup = (kid: string, at: string) => Promise<KeyObject | null>

/**
 * Sender key for `sender_sig.kid` via `GET /v1/keys/{kid}` (agent plane). Retired keys still verify;
 * a key compromised at or before the message's receipt does not. Cached per kid.
 */
export function senderKeyFetcher(
  getJson: (path: string) => Promise<unknown>
): SenderKeyLookup {
  const cache = new Map<string, { key: KeyObject; compromisedAt: number | null }>()
  return async (kid, at) => {
    let hit = cache.get(kid)
    if (!hit) {
      try {
        const body = (await getJson(`/v1/keys/${encodeURIComponent(kid)}`)) as {
          public_jwk?: Jwk
          compromised_at?: string | null
        }
        const key = body.public_jwk ? importJwk(body.public_jwk) : null
        if (!key) {
          return null
        }
        hit = {
          key,
          compromisedAt: body.compromised_at ? Date.parse(body.compromised_at) : null
        }
        cache.set(kid, hit)
      } catch {
        return null
      }
    }
    if (hit.compromisedAt !== null) {
      const t = Date.parse(at)
      if (Number.isNaN(t) || t >= hit.compromisedAt) {
        return null
      }
    }
    return hit.key
  }
}

// ---- the envelope -------------------------------------------------------------------------------

export type DropReason =
  | 'schema'
  | 'manifest_unusable'
  | 'relay_key_unknown'
  | 'relay_sig'
  | 'sender_sig'
  | 'client_request_encoding'
  | 'request_hash'
  | 'view_sha256'
  | 'recipient'

const sha256b64 = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('base64url')

function envelopeShapeOk(e: unknown): boolean {
  if (!isObj(e) || e.v !== 1 || !isStr(e.client_request) || !isObj(e.view)) {
    return false
  }
  if (!Array.isArray(e.view.parts) || !isObj(e.relay) || !isObj(e.relay_sig)) {
    return false
  }
  const r = e.relay
  const sig = e.relay_sig
  const d = r.delivery
  if (
    !isStr(sig.kid) ||
    !isStr(sig.sig) ||
    sig.alg !== 'ES256' ||
    !isStr(r.received_at) ||
    !isStr(r.request_hash) ||
    !isStr(r.view_sha256) ||
    !isObj(d) ||
    !isStr(d.recipient_resident_id)
  ) {
    return false
  }
  if (e.sender_sig !== undefined) {
    const s = e.sender_sig
    if (!isObj(s) || s.alg !== 'EdDSA' || s.covers !== 'client_request' || !isStr(s.kid) || !isStr(s.sig)) {
      return false
    }
  }
  return true
}

/** The bytes relay_sig covers: v, sender_sig, view and relay without delivery.attempt (spec 04 4.2). */
function relaySigInput(e: Record<string, unknown>): Buffer {
  const relay = e.relay as Record<string, unknown>
  const { attempt: _a, ...delivery } = relay.delivery as Record<string, unknown>
  const payload: Record<string, unknown> = { v: e.v, view: e.view, relay: { ...relay, delivery } }
  if (e.sender_sig !== undefined) {
    payload.sender_sig = e.sender_sig
  }
  return Buffer.from(jcs(payload), 'utf8')
}

export type VerifyContext = {
  manifests: ManifestStore
  /** The worker this socket belongs to: a delivery must name it as the recipient. */
  residentId: string
  senderKey?: SenderKeyLookup
}

/**
 * Everything a recipient checks before it trusts a delivery. null means verified, otherwise the first
 * failing check.
 */
export async function verifyEnvelope(env: unknown, ctx: VerifyContext): Promise<DropReason | null> {
  if (!envelopeShapeOk(env)) {
    return 'schema'
  }
  const e = env as Record<string, unknown> & {
    client_request: string
    view: unknown
    relay: { received_at: string; request_hash: string; view_sha256: string; delivery: { recipient_resident_id: string } }
    relay_sig: { kid: string; sig: string }
    sender_sig?: { kid: string; sig: string }
  }
  if (!ctx.manifests.usable) {
    return 'manifest_unusable'
  }
  const relayKey = ctx.manifests.relayKey(e.relay_sig.kid, e.relay.received_at)
  if (!relayKey) {
    return 'relay_key_unknown'
  }
  if (!verifyDetached('ES256', relayKey, relaySigInput(e), e.relay_sig.sig)) {
    return 'relay_sig'
  }
  const bytes = fromB64url(e.client_request)
  if (!bytes) {
    return 'client_request_encoding'
  }
  if (e.sender_sig) {
    const sender = (await ctx.senderKey?.(e.sender_sig.kid, e.relay.received_at)) ?? null
    if (!sender || !verifyDetached('EdDSA', sender, bytes, e.sender_sig.sig)) {
      return 'sender_sig'
    }
  }
  if (sha256b64(bytes) !== e.relay.request_hash) {
    return 'request_hash'
  }
  if (sha256b64(Buffer.from(jcs(e.view), 'utf8')) !== e.relay.view_sha256) {
    return 'view_sha256'
  }
  if (e.relay.delivery.recipient_resident_id !== ctx.residentId) {
    return 'recipient'
  }
  return null
}

/** What the relay signs in `ready.relay_sig`: JCS of the handshake transcript (spec 04 5.2). */
export function readySignInput(p: {
  nonce: string
  client_nonce: string
  resident_id: string
  session_id: string
  server_time: string
}): Buffer {
  return Buffer.from(
    jcs({
      nonce: p.nonce,
      client_nonce: p.client_nonce,
      resident_id: p.resident_id,
      session_id: p.session_id,
      server_time: p.server_time
    }),
    'utf8'
  )
}

export type DeliveryTrust = {
  manifests: ManifestStore
  /** For `AgentSocketOptions.verifyDelivery`. */
  verifyDelivery: (env: Record<string, unknown>) => Promise<string | null>
  /** For `AgentSocketOptions.verifyReady`. Fetches the manifest once if the relay key is not known yet. */
  verifyReady: (hello: Hello, ready: Ready, clientNonce: string) => Promise<boolean>
  refresh(): Promise<AcceptResult | { ok: false; reason: 'fetch' }>
}

/**
 * One trust object per worker: the pinned roots, the manifest it fetches from the relay, sender
 * keys through the agent plane, and the two callbacks the worker socket takes.
 */
export function createDeliveryTrust(o: {
  relayUrl: string
  residentId: string
  roots?: Record<string, Jwk>
  fetch?: FetchLike
  /** Authenticated GET on the agent plane (for sender keys). */
  getJson: (path: string) => Promise<unknown>
  persist?: ManifestPersistence
  clock?: () => number
  /** Wait at least this long between manifest fetches triggered by a miss. Default 15 s. */
  minRefreshGapMs?: number
}): DeliveryTrust {
  const manifests = new ManifestStore(o.roots ?? pinnedRoots(o.relayUrl), {
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.persist ? { persist: o.persist } : {})
  })
  const senderKey = senderKeyFetcher(o.getJson)
  const gap = o.minRefreshGapMs ?? 15_000
  const now = o.clock ?? Date.now
  let loaded: Promise<void> | null = null
  let lastFetch = -Infinity
  let inflight: Promise<AcceptResult | { ok: false; reason: 'fetch' }> | null = null

  const ensureLoaded = () => (loaded ??= manifests.load())
  const refresh = async () => {
    await ensureLoaded()
    inflight ??= refreshManifest(manifests, o.relayUrl, o.fetch).finally(() => {
      lastFetch = now()
      inflight = null
    })
    return inflight
  }
  /** A miss may only mean the manifest is old or not fetched yet: fetch once, rate limited. */
  const refreshOnMiss = async () => {
    await ensureLoaded()
    if (inflight || now() - lastFetch >= gap) {
      await refresh()
    }
  }

  return {
    manifests,
    refresh,
    async verifyDelivery(env) {
      await ensureLoaded()
      let reason = await verifyEnvelope(env, { manifests, residentId: o.residentId, senderKey })
      if (reason === 'manifest_unusable' || reason === 'relay_key_unknown') {
        await refreshOnMiss()
        reason = await verifyEnvelope(env, { manifests, residentId: o.residentId, senderKey })
      }
      return reason
    },
    async verifyReady(hello, ready, clientNonce) {
      await ensureLoaded()
      const check = () => {
        const key = manifests.relayKey(hello.relay_kid, hello.server_time)
        return (
          key !== null &&
          verifyDetached(
            'ES256',
            key,
            readySignInput({
              nonce: hello.nonce,
              client_nonce: clientNonce,
              resident_id: o.residentId,
              session_id: ready.session_id,
              server_time: hello.server_time
            }),
            ready.relay_sig
          )
        )
      }
      if (check()) {
        return true
      }
      await refreshOnMiss()
      return check()
    }
  }
}
