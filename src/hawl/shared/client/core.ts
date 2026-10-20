// Small pieces shared by the client: errors, canonical JSON, keys, assertions, token storage.
// Node only (uses node:crypto); the renderer talks to this through the main process.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign as nodeSign } from 'node:crypto'

export type Jwk = Record<string, string>

/** A relay refusal or transport failure. `code` is the protocol error code when the relay sent one. */
export class HawlApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter: number | null
  readonly requestId: string | null
  readonly details: Record<string, unknown> | undefined
  constructor(
    status: number,
    code: string,
    message: string,
    opts: {
      retryAfter?: number | null
      requestId?: string | null
      details?: Record<string, unknown> | undefined
    } = {}
  ) {
    super(message)
    this.name = 'HawlApiError'
    this.status = status
    this.code = code
    this.retryAfter = opts.retryAfter ?? null
    this.requestId = opts.requestId ?? null
    this.details = opts.details
  }
}

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url')
}

/** RFC 8785 style canonical JSON for the value shapes the relay signs (strings, numbers, nesting). */
export function jcs(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) {
    return `[${v.map(jcs).join(',')}]`
  }
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(',')}}`
}

export type WorkerKey = { publicJwk: Jwk; privateJwk: Jwk }

export function generateWorkerKey(): WorkerKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' }) as Jwk
  const priv = privateKey.export({ format: 'jwk' }) as Jwk
  return {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: String(pub.x) },
    privateJwk: { kty: 'OKP', crv: 'Ed25519', x: String(priv.x), d: String(priv.d) }
  }
}

export function signEd25519(privateJwk: Jwk, data: Uint8Array): Buffer {
  return nodeSign(null, data, createPrivateKey({ key: privateJwk, format: 'jwk' }))
}

/** EdDSA client assertion for `POST /v1/auth/token`. Lives 60 s (same shape as the CLI's join.ts). */
export function clientAssertion(
  residentId: string,
  kid: string,
  privateJwk: Jwk,
  audience: string,
  now: Date = new Date()
): string {
  const iat = Math.floor(now.getTime() / 1000)
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })))
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        iss: residentId,
        sub: residentId,
        aud: audience,
        iat,
        exp: iat + 60,
        jti: randomBytes(12).toString('hex')
      })
    )
  )
  return `${head}.${body}.${b64url(signEd25519(privateJwk, Buffer.from(`${head}.${body}`)))}`
}

/** What the relay's ResidentWS handshake signs (04 section 5.2). */
export function handshakeInput(p: {
  nonce: string
  clientNonce: string
  residentId: string
  serverTime: string
}): Buffer {
  return Buffer.from(`relay.v1|${p.nonce}|${p.clientNonce}|${p.residentId}|${p.serverTime}`, 'utf8')
}

/** Everything a signed-in workstation keeps. The private key never leaves the store. */
export type Credentials = {
  relayUrl: string
  residentId: string
  kid: string
  townId: string
  townSlug: string
  privateJwk: Jwk
  needsOwnerApproval?: boolean
}

/** Storage seam. The OS keyring implementation lives elsewhere; tests use MemoryCredentialStore. */
export type CredentialStore = {
  load(): Promise<Credentials | null>
  save(c: Credentials): Promise<void>
  clear(): Promise<void>
}

export class MemoryCredentialStore implements CredentialStore {
  #c: Credentials | null = null
  async load(): Promise<Credentials | null> {
    return this.#c ? { ...this.#c } : null
  }
  async save(c: Credentials): Promise<void> {
    this.#c = { ...c }
  }
  async clear(): Promise<void> {
    this.#c = null
  }
}

/** Anything that can hand out a bearer token: the agent plane here, a UserJWT source for the user plane. */
export type TokenSource = {
  token(): Promise<string>
  /** The relay said 401: drop what is cached so the next `token()` fetches a new one. */
  invalidate(): void
}

export type FetchLike = typeof fetch
export type Sleep = (ms: number) => Promise<void>
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Default cap on one network call. A captive portal or half-open socket must not freeze the app. */
export const DEFAULT_TIMEOUT_MS = 20_000

/** A signal that fires after `ms`, or when `signal` does, whichever is first. */
export function timeoutSignal(ms: number, signal?: AbortSignal | null): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

/** True when an error came from a timeout signal (not a caller cancel). */
export function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.name === 'TimeoutError'
}

/** Wrap a fetch so every call carries a deadline (the caller's own signal still works). */
export function withTimeout(f: FetchLike, ms: number = DEFAULT_TIMEOUT_MS): FetchLike {
  return ((input: Parameters<FetchLike>[0], init?: RequestInit) =>
    f(input, { ...init, signal: timeoutSignal(ms, init?.signal) })) as FetchLike
}

export function trimUrl(u: string): string {
  return u.replace(/\/+$/, '')
}

/** Exactly localhost, ::1 or a dotted-quad IPv4 in 127.0.0.0/8. A prefix match would admit 127.evil.com. */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') {
    return true
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return !!m && m.slice(1).every((o) => Number(o) <= 255) && Number(m[1]) === 127
}

/** Loopback hosts may use plain http/ws (local stack). Anything else must be https/wss. */
export function assertSecureRelayUrl(relayUrl: string): void {
  let u: URL
  try {
    u = new URL(relayUrl)
  } catch {
    throw new HawlApiError(0, 'bad_relay_url', 'The relay URL is not a valid URL.')
  }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const loopback = isLoopbackHost(host)
  if (u.protocol !== 'https:' && u.protocol !== 'wss:' && !loopback) {
    throw new HawlApiError(
      0,
      'insecure_relay_url',
      'Refusing to talk to a non-local relay over plain http. Use https.'
    )
  }
}

export function wsUrlFor(relayUrl: string, path: string): string {
  assertSecureRelayUrl(relayUrl)
  return trimUrl(relayUrl).replace(/^http/i, 'ws') + path
}
