// The key manifest: the relay's signing keys, signed by an offline root key whose public half is pinned here.
// Port of packages/cli/src/daemon/manifest.ts, written against node:crypto only (spec 04 section 6).
import { createPublicKey, type KeyObject, verify as nodeVerify } from 'node:crypto'
import { type FetchLike, type Jwk, jcs, trimUrl } from './core'

/** Offline root public keys the production relay is trusted through. Same as packages/cli manifest.ts. */
export const PINNED_ROOTS: Record<string, Jwk> = {
  root_1: { kty: 'OKP', crv: 'Ed25519', x: 'xMF_I_Fs57p7Hsu4ksrGA_OPkJoMnVKqKjahxdi2byg' }
}

/** Hosts a dev root may vouch for: this machine and our own staging relay. Never the prod relay. */
export const DEV_ROOT_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'relay-staging.hawl.ai']

/**
 * The pinned roots, plus a dev root from `HAWL_DEV_PINNED_ROOTS` (JSON `{root_id: jwk}`) only while
 * the relay URL is loopback or staging. A dev root can never vouch for the production relay.
 */
export function pinnedRoots(
  relayUrl: string,
  env: Record<string, string | undefined> = process.env
): Record<string, Jwk> {
  const dev = env.HAWL_DEV_PINNED_ROOTS
  if (!dev) {
    return { ...PINNED_ROOTS }
  }
  try {
    if (!DEV_ROOT_HOSTS.includes(new URL(relayUrl).hostname)) {
      return { ...PINNED_ROOTS }
    }
    return { ...(JSON.parse(dev) as Record<string, Jwk>), ...PINNED_ROOTS }
  } catch {
    return { ...PINNED_ROOTS }
  }
}

export type KeyManifest = {
  payload: {
    v: 1
    seq: number
    not_before: string
    not_after: string
    keys: { kid: string; jwk: Jwk; status: string }[]
    revoked: { kid: string; at: string; reason?: string }[]
  }
  sig: { alg: 'EdDSA'; kid: string; sig: string }
}

export type ManifestReject =
  | 'schema'
  | 'unknown_root'
  | 'root_sig'
  | 'rollback'
  | 'not_yet_valid'
  | 'expired'

export type AcceptResult =
  | { ok: true; seq: number; changed: boolean }
  | { ok: false; reason: ManifestReject }

/** Where the accepted manifest is kept between runs. A planted copy is re-verified on load. */
export type ManifestPersistence = {
  load(): Promise<unknown | null>
  save(m: KeyManifest): Promise<void>
}

export const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function manifestShapeOk(m: unknown): m is KeyManifest {
  if (!isObj(m) || !isObj(m.payload) || !isObj(m.sig)) {
    return false
  }
  const p = m.payload
  const s = m.sig
  return (
    p.v === 1 &&
    Number.isInteger(p.seq) &&
    isStr(p.not_before) &&
    isStr(p.not_after) &&
    Array.isArray(p.keys) &&
    p.keys.every((k) => isObj(k) && isStr(k.kid) && isObj(k.jwk)) &&
    Array.isArray(p.revoked) &&
    p.revoked.every((r) => isObj(r) && isStr(r.kid) && isStr(r.at)) &&
    s.alg === 'EdDSA' &&
    isStr(s.kid) &&
    isStr(s.sig)
  )
}

export function importJwk(jwk: Jwk): KeyObject | null {
  try {
    return createPublicKey({ key: jwk, format: 'jwk' })
  } catch {
    return null
  }
}

export const B64URL = /^[A-Za-z0-9_-]*$/
export function fromB64url(s: string): Buffer | null {
  return B64URL.test(s) ? Buffer.from(s, 'base64url') : null
}

export function verifyDetached(
  alg: 'EdDSA' | 'ES256',
  key: KeyObject,
  data: Uint8Array,
  sigB64: string
): boolean {
  const sig = fromB64url(sigB64)
  if (!sig || sig.length !== 64) {
    return false
  }
  try {
    return alg === 'EdDSA'
      ? nodeVerify(null, data, key, sig)
      : nodeVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
  } catch {
    return false
  }
}

/**
 * The highest root-signed relay key manifest accepted so far. A lower `seq`, or the same `seq`
 * with different content, is refused (rollback). Fails closed: with no manifest, or outside its
 * window, no relay key is available and every delivery is dropped.
 */
export class ManifestStore {
  #m: KeyManifest | null = null
  readonly #roots: Record<string, Jwk>
  readonly #clock: () => number
  readonly #persist: ManifestPersistence | undefined

  constructor(
    roots: Record<string, Jwk>,
    o: { clock?: () => number; persist?: ManifestPersistence } = {}
  ) {
    this.#roots = roots
    this.#clock = o.clock ?? Date.now
    this.#persist = o.persist
  }

  /** Re-verify and adopt the saved copy, if any. */
  async load(): Promise<void> {
    try {
      const saved = await this.#persist?.load()
      if (saved && this.#check(saved).ok) {
        this.#m = saved as KeyManifest
      }
    } catch {
      this.#m = null
    }
  }

  #check(m: unknown): { ok: true } | { ok: false; reason: ManifestReject } {
    if (!manifestShapeOk(m)) {
      return { ok: false, reason: 'schema' }
    }
    const rootJwk = this.#roots[m.sig.kid]
    const root = rootJwk ? importJwk(rootJwk) : null
    if (!root) {
      return { ok: false, reason: 'unknown_root' }
    }
    if (!verifyDetached('EdDSA', root, Buffer.from(jcs(m.payload), 'utf8'), m.sig.sig)) {
      return { ok: false, reason: 'root_sig' }
    }
    return { ok: true }
  }

  get seq(): number {
    return this.#m?.payload.seq ?? -1
  }

  /** True while the held manifest is inside its not_before..not_after window. */
  get usable(): boolean {
    const m = this.#m
    if (!m) {
      return false
    }
    const now = this.#clock()
    return now >= Date.parse(m.payload.not_before) && now <= Date.parse(m.payload.not_after)
  }

  async accept(candidate: unknown): Promise<AcceptResult> {
    const c = this.#check(candidate)
    if (!c.ok) {
      return c
    }
    const m = candidate as KeyManifest
    const now = this.#clock()
    if (now < Date.parse(m.payload.not_before)) {
      return { ok: false, reason: 'not_yet_valid' }
    }
    if (now > Date.parse(m.payload.not_after)) {
      return { ok: false, reason: 'expired' }
    }
    const held = this.#m
    if (held) {
      if (m.payload.seq < held.payload.seq) {
        return { ok: false, reason: 'rollback' }
      }
      if (m.payload.seq === held.payload.seq) {
        return jcs(m.payload) === jcs(held.payload)
          ? { ok: true, seq: m.payload.seq, changed: false }
          : { ok: false, reason: 'rollback' }
      }
    }
    this.#m = m
    try {
      await this.#persist?.save(m)
    } catch {
      // Keeping it in memory is enough for this run.
    }
    return { ok: true, seq: m.payload.seq, changed: true }
  }

  /**
   * Relay signing key `kid`, or null. `at` is the time the signature claims: a key revoked at
   * or before `at` is refused, and an unreadable `at` for a revoked key is refused too.
   */
  relayKey(kid: string, at: string): KeyObject | null {
    const m = this.#m
    if (!m || !this.usable) {
      return null
    }
    const k = m.payload.keys.find((x) => x.kid === kid)
    if (!k) {
      return null
    }
    const rev = m.payload.revoked.find((x) => x.kid === kid)
    if (rev) {
      const atMs = Date.parse(at)
      if (Number.isNaN(atMs) || !(atMs < Date.parse(rev.at))) {
        return null
      }
    }
    return importJwk(k.jwk)
  }
}

/** GET `/.well-known/relay-key-manifest.json` and offer it to the store. */
export async function refreshManifest(
  store: ManifestStore,
  relayUrl: string,
  fetchImpl: FetchLike = fetch
): Promise<AcceptResult | { ok: false; reason: 'fetch' }> {
  try {
    const res = await fetchImpl(`${trimUrl(relayUrl)}/.well-known/relay-key-manifest.json`, {
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) {
      return { ok: false, reason: 'fetch' }
    }
    return await store.accept(await res.json())
  } catch {
    return { ok: false, reason: 'fetch' }
  }
}

