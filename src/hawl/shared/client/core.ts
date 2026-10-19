// Small pieces shared by the client: errors, canonical JSON, keys, assertions, token storage.
// Node only (uses node:crypto); the renderer talks to this through the main process.
import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign
} from 'node:crypto'

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
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
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
  return Buffer.from(
    `relay.v1|${p.nonce}|${p.clientNonce}|${p.residentId}|${p.serverTime}`,
    'utf8'
  )
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
export interface CredentialStore {
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
export interface TokenSource {
  token(): Promise<string>
  /** The relay said 401: drop what is cached so the next `token()` fetches a new one. */
  invalidate(): void
}

export type FetchLike = typeof fetch
export type Sleep = (ms: number) => Promise<void>
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function trimUrl(u: string): string {
  return u.replace(/\/+$/, '')
}

export function wsUrlFor(relayUrl: string, path: string): string {
  return trimUrl(relayUrl).replace(/^http/i, 'ws') + path
}
