import { withRetry, type RetryOptions } from './retry'
import {
  clientAssertion,
  type Credentials,
  type FetchLike,
  assertSecureRelayUrl,
  DEFAULT_TIMEOUT_MS,
  HawlApiError,
  isTimeoutError,
  realSleep,
  type Sleep,
  type TokenSource,
  timeoutSignal,
  trimUrl,
  withTimeout
} from './core'

export type Plane = 'agent' | 'user' | 'none'

export type HttpOptions = {
  baseUrl: string
  fetch?: FetchLike
  sleep?: Sleep
  /** Extra tries for idempotent calls on network errors, 429, 502, 503 and 504. Default 2. */
  maxRetries?: number
  /** Cap on one backoff wait, ms. Default 5000. */
  maxBackoffMs?: number
  /** Deadline for one HTTP call, headers and body, ms. Default 20 s. */
  timeoutMs?: number
  agent?: TokenSource
  user?: TokenSource
}

export type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  plane?: Plane
  headers?: Record<string, string>
  /** Retry on transient failures. Default: true for GET, false otherwise. */
  idempotent?: boolean
  signal?: AbortSignal
  /** Deadline for this call, ms. Default: the client's timeoutMs (uploads and downloads may want more). */
  timeoutMs?: number
  /** Raw request body (file upload). */
  rawBody?: Uint8Array
  /** Return the Response body bytes instead of parsing JSON. */
  asBytes?: boolean
}

const TRANSIENT = new Set([429, 502, 503, 504])

export class Http {
  readonly baseUrl: string
  readonly #o: HttpOptions
  readonly #fetch: FetchLike
  readonly #sleep: Sleep

  constructor(o: HttpOptions) {
    assertSecureRelayUrl(o.baseUrl)
    this.#o = o
    this.baseUrl = trimUrl(o.baseUrl)
    this.#fetch = o.fetch ?? fetch
    this.#sleep = o.sleep ?? realSleep
  }

  async request<T = unknown>(method: string, path: string, r: RequestOptions = {}): Promise<T> {
    const plane = r.plane ?? 'agent'
    const retriable = r.idempotent ?? method === 'GET'
    const max = retriable ? (this.#o.maxRetries ?? 2) : 0
    const cap = this.#o.maxBackoffMs ?? 5000
    let refreshed = false
    let attempt = 0
    for (;;) {
      const source = plane === 'agent' ? this.#o.agent : plane === 'user' ? this.#o.user : undefined
      if (plane !== 'none' && !source) {
        throw new HawlApiError(401, 'unauthenticated', `No ${plane} credentials are set.`)
      }
      const headers: Record<string, string> = { ...r.headers }
      if (source) {
        headers.authorization = `Bearer ${await source.token()}`
      }
      let payload: string | Uint8Array | undefined
      if (r.rawBody) {
        payload = r.rawBody
      } else if (r.body !== undefined) {
        headers['content-type'] = 'application/json'
        payload = JSON.stringify(r.body)
      }
      let res: Response | null = null
      let body: Uint8Array | string = ''
      let netErr: unknown = null
      try {
        const init: RequestInit = { method, headers }
        if (payload !== undefined) {
          init.body = payload as BodyInit
        }
        init.signal = timeoutSignal(
          r.timeoutMs ?? this.#o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          r.signal
        )
        res = await this.#fetch(this.url(path, r.query), init)
        // Read the body inside the deadline too, so a stalled body cannot hang the call.
        if (res.ok) {
          body = r.asBytes ? new Uint8Array(await res.arrayBuffer()) : await res.text()
        }
      } catch (e) {
        if (r.signal?.aborted) {
          throw e
        }
        res = null
        netErr = e
      }
      if (res && res.status === 401 && source && !refreshed) {
        refreshed = true
        source.invalidate()
        continue
      }
      const transient = netErr !== null || (res !== null && TRANSIENT.has(res.status))
      if (transient && attempt < max) {
        const ra = res ? Number(res.headers.get('retry-after')) : 0
        const wait = ra > 0 ? ra * 1000 : 250 * 2 ** attempt
        attempt++
        await this.#sleep(Math.min(wait, cap))
        continue
      }
      if (!res) {
        throw netError(netErr)
      }
      if (!res.ok) {
        throw await toError(res)
      }
      if (r.asBytes) {
        return body as T
      }
      const text = body as string
      if (!text) {
        return {} as T
      }
      try {
        return JSON.parse(text) as T
      } catch {
        throw new HawlApiError(
          res.status,
          'bad_response',
          'The relay answered with something that is not JSON (a proxy or a captive page?).'
        )
      }
    }
  }

  get<T = unknown>(path: string, r: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, r)
  }
  post<T = unknown>(path: string, body?: unknown, r: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, { ...r, body })
  }
  put<T = unknown>(path: string, r: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, r)
  }
  delete<T = unknown>(path: string, r: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, r)
  }

  url(path: string, query?: RequestOptions['query']): string {
    const u = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) {
        continue
      }
      u.searchParams.set(k, String(v))
    }
    return u.toString()
  }
}

function netError(e: unknown): HawlApiError {
  return isTimeoutError(e)
    ? new HawlApiError(0, 'timeout', 'The relay did not answer in time.')
    : new HawlApiError(0, 'network_error', `Could not reach the relay: ${String(e)}`)
}

async function toError(res: Response): Promise<HawlApiError> {
  let code = `http_${res.status}`
  let message = res.statusText || `HTTP ${res.status}`
  let requestId: string | null = null
  let details: Record<string, unknown> | undefined
  let retryAfter: number | null = null
  try {
    const j = (await res.json()) as {
      error?: {
        code?: string
        message?: string
        request_id?: string
        retry_after?: number | null
        details?: Record<string, unknown>
      }
    }
    if (j.error) {
      code = j.error.code ?? code
      message = j.error.message ?? message
      requestId = j.error.request_id ?? null
      details = j.error.details
      retryAfter = j.error.retry_after ?? null
    }
  } catch {
    // not JSON: keep the status text
  }
  const h = Number(res.headers.get('retry-after'))
  if (retryAfter === null && h > 0) {
    retryAfter = h
  }
  return new HawlApiError(res.status, code, message, { retryAfter, requestId, details })
}

/**
 * AgentToken source: signs a 60 s assertion with the worker key, exchanges it at
 * `POST /v1/auth/token`, and caches the 10 minute token. One exchange at a time.
 */
export class AgentTokenSource implements TokenSource {
  readonly #cred: Credentials
  readonly #fetch: FetchLike
  readonly #now: () => number
  #tok: { value: string; expMs: number } | null = null
  #inflight: Promise<string> | null = null
  readonly #retry: RetryOptions

  constructor(
    cred: Credentials,
    o: { fetch?: FetchLike; now?: () => number; timeoutMs?: number } & RetryOptions = {}
  ) {
    this.#cred = cred
    this.#fetch = withTimeout(o.fetch ?? fetch, o.timeoutMs)
    this.#now = o.now ?? Date.now
    this.#retry = o
  }

  async token(): Promise<string> {
    const t = this.#tok
    // Renew 30 s early so a call never leaves with a token that dies in flight.
    if (t && t.expMs - 30_000 > this.#now()) {
      return t.value
    }
    this.#inflight ??= withRetry(() => this.#exchange(), this.#retry).finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  invalidate(): void {
    this.#tok = null
  }

  async #exchange(): Promise<string> {
    assertSecureRelayUrl(this.#cred.relayUrl)
    const base = trimUrl(this.#cred.relayUrl)
    const assertion = clientAssertion(
      this.#cred.residentId,
      this.#cred.kid,
      this.#cred.privateJwk,
      base,
      new Date(this.#now())
    )
    let res: Response
    try {
      res = await this.#fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_assertion: assertion })
      })
    } catch (e) {
      throw netError(e)
    }
    if (!res.ok) {
      throw await toError(res)
    }
    let j: { access_token: string; expires_in: number }
    try {
      j = (await res.json()) as { access_token: string; expires_in: number }
    } catch (e) {
      if (isTimeoutError(e)) {
        throw netError(e)
      }
      throw new HawlApiError(res.status, 'bad_response', 'The token answer was not JSON.')
    }
    this.#tok = { value: j.access_token, expMs: this.#now() + j.expires_in * 1000 }
    return j.access_token
  }
}
