// The person's side of the relay (UserJWT). The relay only accepts a UserJWT that the web app
// mints at `GET /api/relay-token` for a signed-in session cookie, so the workstation signs in to
// the web app the same way the browser does: an emailed 6-digit code (Better Auth emailOTP), then
// keeps the session cookie and trades it for 15 minute UserJWTs. A passkey or OAuth sign-in done in
// a browser window works too: hand the cookie header to `WebSession.fromCookie`.
import { withRetry, type RetryOptions } from './retry'
import {
  assertSecureRelayUrl,
  type FetchLike,
  type Sleep,
  HawlApiError,
  isTimeoutError,
  type TokenSource,
  trimUrl,
  withTimeout
} from './core'

export const DEFAULT_WEB_ORIGIN = 'https://hawl.ai'

/** Turn `Set-Cookie` header values into a `Cookie` request header (name=value pairs, no attributes). */
export function cookieHeaderFromSetCookie(setCookies: readonly string[], prior = ''): string {
  const jar = new Map<string, string>()
  for (const part of prior.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) {
      jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
    }
  }
  for (const sc of setCookies) {
    const first = sc.split(';')[0] ?? ''
    const i = first.indexOf('=')
    if (i <= 0) {
      continue
    }
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    // Max-Age=0 or an expired date is how a server deletes a cookie.
    const dead = /;\s*max-age=0\b/i.test(sc) || /;\s*expires=thu, 01 jan 1970/i.test(sc)
    if (dead || value === '') {
      jar.delete(name)
    } else {
      jar.set(name, value)
    }
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

export type WebSessionOptions = {
  webOrigin?: string
  fetch?: FetchLike
  /** Deadline for one call, ms. Default 20 s. */
  timeoutMs?: number
  now?: () => number
  sleep?: Sleep
  maxRetries?: number
  /** Called whenever the cookie header changes (after sign-in, after the server rotates it). Persist it. */
  onCookie?: (cookie: string) => void
}

/** Epoch ms of a JWT's `exp`, or null if it cannot be read. */
export function jwtExpiryMs(jwt: string): number | null {
  try {
    const body = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof body.exp === 'number' ? body.exp * 1000 : null
  } catch {
    return null
  }
}

export class WebSession implements TokenSource {
  readonly webOrigin: string
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #onCookie: ((c: string) => void) | undefined
  #cookie: string
  #tok: { value: string; expMs: number } | null = null
  #inflight: Promise<string> | null = null
  readonly #retry: RetryOptions

  private constructor(cookie: string, o: WebSessionOptions) {
    this.#cookie = cookie
    assertSecureRelayUrl(o.webOrigin ?? DEFAULT_WEB_ORIGIN)
    this.webOrigin = trimUrl(o.webOrigin ?? DEFAULT_WEB_ORIGIN)
    this.#fetch = withTimeout(o.fetch ?? fetch, o.timeoutMs)
    this.#now = o.now ?? Date.now
    this.#onCookie = o.onCookie
    this.#retry = o
  }

  /** A session you already hold (restored from storage, or read from a browser window). */
  static fromCookie(cookie: string, o: WebSessionOptions = {}): WebSession {
    return new WebSession(cookie, o)
  }

  /** Step 1 of the emailed-code sign-in. Always answers the same, whether or not the address has an account. */
  static async sendCode(email: string, o: WebSessionOptions = {}): Promise<void> {
    assertSecureRelayUrl(o.webOrigin ?? DEFAULT_WEB_ORIGIN)
    const origin = trimUrl(o.webOrigin ?? DEFAULT_WEB_ORIGIN)
    const res = await webPost(
      withTimeout(o.fetch ?? fetch, o.timeoutMs),
      origin,
      '/api/auth/email-otp/send-verification-otp',
      {
        email,
        type: 'sign-in'
      }
    )
    if (!res.ok) {
      throw await webError(res, 'The sign-in code could not be sent.')
    }
  }

  /** Step 2: the 6 digits from the email. Returns a signed-in session. */
  static async verifyCode(
    email: string,
    otp: string,
    o: WebSessionOptions = {}
  ): Promise<WebSession> {
    assertSecureRelayUrl(o.webOrigin ?? DEFAULT_WEB_ORIGIN)
    const origin = trimUrl(o.webOrigin ?? DEFAULT_WEB_ORIGIN)
    const res = await webPost(
      withTimeout(o.fetch ?? fetch, o.timeoutMs),
      origin,
      '/api/auth/sign-in/email-otp',
      {
        email,
        otp
      }
    )
    if (!res.ok) {
      throw await webError(res, 'That code did not work.')
    }
    const cookie = cookieHeaderFromSetCookie(res.headers.getSetCookie())
    if (!cookie) {
      throw new HawlApiError(
        res.status,
        'no_session',
        'Sign-in worked but the site sent no session.'
      )
    }
    const s = new WebSession(cookie, o)
    o.onCookie?.(cookie)
    return s
  }

  /** The cookie header to persist (in the OS keyring). */
  get cookie(): string {
    return this.#cookie
  }

  async token(): Promise<string> {
    const t = this.#tok
    if (t && t.expMs - 60_000 > this.#now()) {
      return t.value
    }
    this.#inflight ??= withRetry(() => this.#mint(), this.#retry).finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  invalidate(): void {
    this.#tok = null
  }

  /** `POST /api/auth/sign-out`; forgets the cookie. */
  async signOut(): Promise<void> {
    try {
      await webPost(this.#fetch, this.webOrigin, '/api/auth/sign-out', {}, this.#cookie)
    } finally {
      this.#cookie = ''
      this.#tok = null
      this.#onCookie?.('')
    }
  }

  async #mint(): Promise<string> {
    if (!this.#cookie) {
      throw new HawlApiError(
        401,
        'signed_out',
        'Sign in to Hawl to see approvals and the site feed.'
      )
    }
    let res: Response
    try {
      res = await this.#fetch(`${this.webOrigin}/api/relay-token`, {
        headers: {
          cookie: this.#cookie,
          // The route accepts only same-origin calls; it falls back to Origin when no
          // Sec-Fetch-Site is sent (lib/auth/relay-token.ts isSameOrigin), which is the honest case here.
          origin: this.webOrigin
        }
      })
    } catch (e) {
      throw webNetError(e, this.webOrigin)
    }
    if (res.status === 401) {
      this.#cookie = ''
      this.#onCookie?.('')
      throw new HawlApiError(401, 'session_expired', 'Your Hawl session ended. Sign in again.')
    }
    if (!res.ok) {
      throw await webError(res, 'Could not get a session token.')
    }
    const rotated = res.headers.getSetCookie()
    if (rotated.length > 0) {
      const next = cookieHeaderFromSetCookie(rotated, this.#cookie)
      if (next !== this.#cookie) {
        this.#cookie = next
        this.#onCookie?.(next)
      }
    }
    const j = (await res.json()) as { token: string; expires_at?: number }
    const expMs =
      (j.expires_at ? j.expires_at * 1000 : jwtExpiryMs(j.token)) ?? this.#now() + 10 * 60_000
    this.#tok = { value: j.token, expMs }
    return j.token
  }
}

function webNetError(e: unknown, origin: string): HawlApiError {
  return isTimeoutError(e)
    ? new HawlApiError(0, 'timeout', `${origin} did not answer in time.`)
    : new HawlApiError(0, 'network_error', `Could not reach ${origin}: ${String(e)}`)
}

async function webPost(
  f: FetchLike,
  origin: string,
  path: string,
  body: unknown,
  cookie?: string
): Promise<Response> {
  try {
    return await f(origin + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        ...(cookie ? { cookie } : {})
      },
      body: JSON.stringify(body)
    })
  } catch (e) {
    throw webNetError(e, origin)
  }
}

async function webError(res: Response, fallback: string): Promise<HawlApiError> {
  let code = `http_${res.status}`
  let message = fallback
  try {
    const j = (await res.json()) as { code?: string; message?: string; error?: { code?: string } }
    code = j.code ?? j.error?.code ?? code
    message = j.message ?? message
  } catch {
    // not JSON
  }
  const ra = Number(res.headers.get('retry-after'))
  return new HawlApiError(res.status, code, message, { retryAfter: ra > 0 ? ra : null })
}
