// Device-code sign-in: the person types a code at hawl.ai/device, this app proves it holds the key.
// Same flow as packages/cli/src/commands/join.ts (join/start, then join/:jrq/claim with a signed nonce).
import { randomBytes } from 'node:crypto'
import {
  assertSecureRelayUrl,
  b64url,
  type Credentials,
  type FetchLike,
  generateWorkerKey,
  HawlApiError,
  isTimeoutError,
  jcs,
  realSleep,
  signEd25519,
  type Sleep,
  trimUrl,
  type WorkerKey,
  withTimeout
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
  /** Deadline for one call, ms. Default 20 s. */
  timeoutMs?: number
  /**
   * The page where the person types the code. Defaults to hawl.ai/device only when the relay is the
   * production one; for any other relay the page is unknown, so `verificationUri` is null unless given.
   */
  devicePage?: string
}

export type ClaimOutcome = { state: 'pending' } | { state: 'claimed'; credentials: Credentials }

export class DeviceSignIn {
  readonly joinId: string
  /** Shown to the person; they type it at `verificationUri`. */
  readonly userCode: string
  /** Must match what the page shows. */
  readonly fingerprint: string
  readonly expiresAt: number
  /** Where the person types the code; null when the relay is not production and no page was given. */
  readonly verificationUri: string | null
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
    assertSecureRelayUrl(o.relayUrl ?? DEFAULT_RELAY_URL)
    this.#base = trimUrl(o.relayUrl ?? DEFAULT_RELAY_URL)
    this.#fetch = withTimeout(o.fetch ?? fetch, o.timeoutMs)
    this.verificationUri =
      o.devicePage ?? (this.#base === trimUrl(DEFAULT_RELAY_URL) ? DEVICE_PAGE : null)
    this.joinId = started.join_id
    this.userCode = started.user_code
    this.fingerprint = started.key_fingerprint
    this.expiresAt = (o.now ?? Date.now)() + started.expires_in * 1000
  }

  /** One claim attempt. 202 is pending; any other 4xx means expired, denied or unknown. */
  async claim(signal?: AbortSignal): Promise<ClaimOutcome> {
    const ts = Math.floor((this.#o.now ?? Date.now)() / 1000)
    const nonce = randomBytes(16).toString('hex')
    const sig = b64url(
      signEd25519(this.#key.privateJwk, Buffer.from(jcs({ join_id: this.joinId, nonce, ts })))
    )
    let res: Response
    try {
      res = await this.#fetch(`${this.#base}/v1/join/${this.joinId}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, ts, sig }),
        ...(signal ? { signal } : {})
      })
    } catch (e) {
      throw unreachable(e)
    }
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
    if (res.status === 404 || res.status === 410) {
      // The relay answers 404 for every dead end (expired, denied by the owner, unknown id, bad
      // signature, a clock too far off), so the app cannot tell them apart.
      throw new HawlApiError(
        res.status,
        'code_expired',
        "The code expired, was refused, or this computer's clock is off. Start sign-in again."
      )
    }
    if (!res.ok) {
      throw await claimError(res)
    }
    let c: {
      resident_id: string
      kid: string
      town_id: string
      relay_url?: string
      needs_owner_approval?: boolean
    }
    try {
      c = (await res.json()) as typeof c
    } catch (e) {
      if (isTimeoutError(e)) {
        throw unreachable(e)
      }
      // The relay may already have handed the key over; claiming again would be refused.
      throw new HawlApiError(
        res.status,
        'bad_response',
        'The relay answered the sign-in with something unreadable. Start sign-in again.'
      )
    }
    if (!c.resident_id || !c.kid || !c.town_id) {
      throw new HawlApiError(res.status, 'bad_response', 'The relay sign-in answer was incomplete.')
    }
    return {
      state: 'claimed',
      credentials: {
        relayUrl: this.#trustedRelayUrl(c.relay_url),
        residentId: c.resident_id,
        kid: c.kid,
        townId: c.town_id,
        townSlug: this.#o.site,
        privateJwk: this.#key.privateJwk,
        needsOwnerApproval: c.needs_owner_approval === true
      }
    }
  }

  /** The relay may name its own public URL, but only on the host the person signed in against. */
  #trustedRelayUrl(claimed: string | undefined): string {
    if (!claimed) {
      return this.#base
    }
    try {
      assertSecureRelayUrl(claimed)
      if (new URL(claimed).host === new URL(this.#base).host) {
        return trimUrl(claimed)
      }
    } catch {
      // fall through to the URL the person chose
    }
    return this.#base
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
        throw cancelled()
      }
      try {
        const r = await this.claim(o.signal)
        if (r.state === 'claimed') {
          return r.credentials
        }
      } catch (e) {
        if (o.signal?.aborted) {
          throw cancelled()
        }
        const transient =
          !(e instanceof HawlApiError) ||
          e.code === 'relay_unavailable' ||
          e.code === 'network_error' ||
          e.code === 'timeout'
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
      await abortable(sleep(Math.max(this.#o.pollMs ?? 5000, retryAfterMs)), o.signal)
      retryAfterMs = 0
    }
  }
}

function cancelled(): HawlApiError {
  return new HawlApiError(0, 'cancelled', 'Sign-in cancelled.')
}

/** Resolves with `p`, or rejects as cancelled the moment `signal` aborts (the sleep itself keeps running). */
function abortable(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return p
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(cancelled())
    if (signal.aborted) {
      return onAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

function unreachable(e: unknown): HawlApiError {
  return isTimeoutError(e)
    ? new HawlApiError(0, 'timeout', 'The relay did not answer in time.')
    : new HawlApiError(0, 'network_error', `Could not reach the relay: ${String(e)}`)
}

async function claimError(res: Response): Promise<HawlApiError> {
  let code = `http_${res.status}`
  let message = `Sign-in failed (${res.status}).`
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string } }
    code = j.error?.code ?? code
    message = j.error?.message ?? message
  } catch {
    // keep the status
  }
  return new HawlApiError(res.status, code, message)
}

/** Step 1: make a key, ask the relay for a code. Nothing is stored until the claim succeeds. */
export async function startDeviceSignIn(o: SignInOptions): Promise<DeviceSignIn> {
  assertSecureRelayUrl(o.relayUrl ?? DEFAULT_RELAY_URL)
  const key = generateWorkerKey()
  const base = trimUrl(o.relayUrl ?? DEFAULT_RELAY_URL)
  let res: Response
  try {
    res = await withTimeout(o.fetch ?? fetch, o.timeoutMs)(`${base}/v1/join/start`, {
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
  } catch (e) {
    throw unreachable(e)
  }
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
  let started: {
    join_id?: unknown
    user_code?: unknown
    key_fingerprint?: unknown
    expires_in?: unknown
  }
  try {
    started = (await res.json()) as typeof started
  } catch (e) {
    if (isTimeoutError(e)) {
      throw unreachable(e)
    }
    throw badStart(res.status)
  }
  if (
    typeof started?.join_id !== 'string' ||
    typeof started.user_code !== 'string' ||
    typeof started.key_fingerprint !== 'string' ||
    typeof started.expires_in !== 'number' ||
    !(started.expires_in > 0)
  ) {
    throw badStart(res.status)
  }
  return new DeviceSignIn(o, key, {
    join_id: started.join_id,
    user_code: started.user_code,
    key_fingerprint: started.key_fingerprint,
    expires_in: started.expires_in
  })
}

function badStart(status: number): HawlApiError {
  return new HawlApiError(
    status,
    'bad_response',
    'The relay answered the sign-in start with something unreadable. Check the relay URL and try again.'
  )
}
