// Device-code sign-in: the person types a code at hawl.ai/device, this app proves it holds the key.
// Same flow as packages/cli/src/commands/join.ts (join/start, then join/:jrq/claim with a signed nonce).
import { randomBytes } from 'node:crypto'
import {
  b64url,
  type Credentials,
  type FetchLike,
  generateWorkerKey,
  HawlApiError,
  jcs,
  realSleep,
  signEd25519,
  type Sleep,
  trimUrl,
  type WorkerKey
} from './core'

export const DEFAULT_RELAY_URL = 'https://relay.hawl.ai'
export const DEVICE_PAGE = 'https://hawl.ai/device'
/** Workers made by the workstation show this platform on the dashboard. */
export const WORKSTATION_PLATFORM = 'hawl_workstation'

export type SignInOptions = {
  /** Site slug, e.g. `acme`. */
  site: string
  relayUrl?: string
  folderLabel?: string
  machineName?: string
  cliVersion?: string
  fetch?: FetchLike
  sleep?: Sleep
  now?: () => number
  /** Claim poll interval. Default 5 s. */
  pollMs?: number
}

export type ClaimOutcome = { state: 'pending' } | { state: 'claimed'; credentials: Credentials }

export class DeviceSignIn {
  readonly joinId: string
  /** Shown to the person; they type it at `verificationUri`. */
  readonly userCode: string
  /** Must match what the page shows. */
  readonly fingerprint: string
  readonly expiresAt: number
  readonly verificationUri = DEVICE_PAGE
  readonly #key: WorkerKey
  readonly #o: Required<Pick<SignInOptions, 'site'>> & SignInOptions
  readonly #base: string
  readonly #fetch: FetchLike

  constructor(
    o: SignInOptions,
    key: WorkerKey,
    started: { join_id: string; user_code: string; key_fingerprint: string; expires_in: number }
  ) {
    this.#o = o
    this.#key = key
    this.#base = trimUrl(o.relayUrl ?? DEFAULT_RELAY_URL)
    this.#fetch = o.fetch ?? fetch
    this.joinId = started.join_id
    this.userCode = started.user_code
    this.fingerprint = started.key_fingerprint
    this.expiresAt = (o.now ?? Date.now)() + started.expires_in * 1000
  }

  /** One claim attempt. 202 is pending; any other 4xx means expired, denied or unknown. */
  async claim(): Promise<ClaimOutcome> {
    const ts = Math.floor((this.#o.now ?? Date.now)() / 1000)
    const nonce = randomBytes(16).toString('hex')
    const sig = b64url(
      signEd25519(this.#key.privateJwk, Buffer.from(jcs({ join_id: this.joinId, nonce, ts })))
    )
    const res = await this.#fetch(`${this.#base}/v1/join/${this.joinId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, ts, sig })
    })
    if (res.status === 202) {
      return { state: 'pending' }
    }
    // 408, 425, 429 and 5xx are the relay or the network being busy, not the code being dead.
    if (res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      throw new HawlApiError(res.status, 'relay_unavailable', 'The relay is not answering.', {
        retryAfter: ra > 0 ? ra : null
      })
    }
    if (!res.ok) {
      throw new HawlApiError(
        res.status,
        'code_expired',
        'The code expired or was not approved. Start sign-in again.'
      )
    }
    const c = (await res.json()) as {
      resident_id: string
      kid: string
      town_id: string
      relay_url?: string
      needs_owner_approval?: boolean
    }
    return {
      state: 'claimed',
      credentials: {
        relayUrl: c.relay_url ?? this.#base,
        residentId: c.resident_id,
        kid: c.kid,
        townId: c.town_id,
        townSlug: this.#o.site,
        privateJwk: this.#key.privateJwk,
        needsOwnerApproval: c.needs_owner_approval === true
      }
    }
  }

  /**
   * Poll until approved. Relay outages and network errors keep polling until the code expires;
   * an expired or refused code throws. `signal` cancels.
   */
  async wait(o: { signal?: AbortSignal; onTick?: () => void } = {}): Promise<Credentials> {
    const sleep = this.#o.sleep ?? realSleep
    const now = this.#o.now ?? Date.now
    let retryAfterMs = 0
    for (;;) {
      if (o.signal?.aborted) {
        throw new HawlApiError(0, 'cancelled', 'Sign-in cancelled.')
      }
      try {
        const r = await this.claim()
        if (r.state === 'claimed') {
          return r.credentials
        }
      } catch (e) {
        const transient = !(e instanceof HawlApiError) || e.code === 'relay_unavailable'
        if (!transient) {
          throw e
        }
        retryAfterMs = e instanceof HawlApiError && e.retryAfter ? e.retryAfter * 1000 : 0
      }
      if (now() >= this.expiresAt) {
        throw new HawlApiError(0, 'timeout', 'Timed out waiting for approval. Start sign-in again.')
      }
      o.onTick?.()
      // A rate-limited relay says how long to leave it alone.
      await sleep(Math.max(this.#o.pollMs ?? 5000, retryAfterMs))
      retryAfterMs = 0
    }
  }
}

/** Step 1: make a key, ask the relay for a code. Nothing is stored until the claim succeeds. */
export async function startDeviceSignIn(o: SignInOptions): Promise<DeviceSignIn> {
  const key = generateWorkerKey()
  const base = trimUrl(o.relayUrl ?? DEFAULT_RELAY_URL)
  const res = await (o.fetch ?? fetch)(`${base}/v1/join/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      town_slug: o.site,
      public_jwk: key.publicJwk,
      platform: WORKSTATION_PLATFORM,
      host_hint: 'Hawl Workstation',
      folder_label: (o.folderLabel ?? 'workstation').slice(0, 120),
      machine_name: o.machineName?.slice(0, 40),
      cli_version: o.cliVersion ?? '0.0.0'
    })
  })
  if (!res.ok) {
    let msg = `sign-in start failed (${res.status})`
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } }
      msg = j.error?.message ?? msg
      throw new HawlApiError(res.status, j.error?.code ?? `http_${res.status}`, msg)
    } catch (e) {
      if (e instanceof HawlApiError) {
        throw e
      }
      throw new HawlApiError(res.status, `http_${res.status}`, msg)
    }
  }
  return new DeviceSignIn(o, key, await res.json())
}
