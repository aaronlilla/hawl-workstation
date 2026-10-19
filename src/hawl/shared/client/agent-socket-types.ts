// Types for the worker socket.
import type { Credentials } from './core'

export type SocketState =
  | 'idle'
  | 'connecting'
  | 'handshake'
  | 'connected'
  | 'replaced'
  | 'stopped'
  /** The relay will not take this worker (suspended, removed, key refused, client too old). Retrying stopped. */
  | 'refused'

export type Hello = { t: 'hello'; nonce: string; server_time: string; relay_kid: string }
export type Ready = {
  t: 'ready'
  session_id: string
  resident_id: string
  town_id: string
  pending: number
  heartbeat_s: number
  relay_sig: string
}

export type AgentSocketOptions = {
  credentials: Credentials
  version?: string
  /** Called with the relay's hello and ready frames. Return false to refuse the relay (identity pinning). */
  verifyReady?: (hello: Hello, ready: Ready, clientNonce: string) => boolean | Promise<boolean>
  /**
   * Checked on every `deliver` before it is handed over: the relay signature and sender signature
   * (the CLI daemon's verifyEnvelope). Return null to accept, or a reason to drop it. A dropped
   * delivery is reported as `dropped`, never emitted as `deliver`, and never acked.
   */
  verifyDelivery?: (env: Record<string, unknown>) => Promise<string | null> | string | null
  /**
   * Deliveries from other people's agents are content you must not trust unchecked. The socket therefore
   * refuses to be built without `verifyDelivery` unless this is set (tests against a fake relay).
   * `HawlClient.socket()` supplies a verifier built from the pinned roots.
   */
  insecureNoVerify?: boolean
  /** Failed handshakes in a row (close 4401) before the worker counts as refused. Default 5. */
  authStrikes?: number
  reconnectMs?: { min: number; max: number }
  handshakeTimeoutMs?: number
  /** No frame for this long means a half-open socket: reconnect. The relay pings every 25 s. */
  staleMs?: number
  /** First wait before asking again for a delivery whose check hit a passing failure. Default 1000, doubles, 5 tries. */
  retryDeliveryMs?: number
  watchdogMs?: number
  /** Jitter source in [0, 1). */
  random?: () => number
  /** Where to start asking for deliveries after a reconnect. */
  afterSeq?: number
}

export type AgentSocketEvents = {
  state: [SocketState]
  ready: [Ready]
  deliver: [Record<string, unknown>]
  dropped: [{ envelope: Record<string, unknown>; reason: string }]
  notice: [{ unread: number; needs_action: number }]
  control: [Record<string, unknown>]
  refused: [{ code: number; reason: 'suspended' | 'client_too_old' | 'auth_failed' | 'relay_not_trusted' }]
  error: [Error]
}

/** Close codes after which retrying fast cannot help: refused handshake, rate limited. */
export const SLOW_RETRY = new Set([4401, 4429])
/** Close codes that end the connection for good: suspended or removed worker, client too old. */
export const TERMINAL: ReadonlyMap<number, 'suspended' | 'client_too_old'> = new Map([
  [4403, 'suspended'],
  [4426, 'client_too_old']
])
/** The relay is restarting (4503): come back soon, but not in a tight loop. */
export const DRAINING = 4503
export const DRAINING_FLOOR_MS = 3000
/** Another session of this worker took over. */
export const REPLACED = 4409

/** `relay.delivery.inbox_seq` of an envelope, if it has one. */
export function seqOf(env: Record<string, unknown> | undefined): number | null {
  const relay = env?.relay as { delivery?: { inbox_seq?: unknown } } | undefined
  const v = relay?.delivery?.inbox_seq
  return typeof v === 'number' ? v : null
}

/** Run the caller's delivery check; a throw counts as a failed check. null means accepted. */
export async function checkDelivery(
  check: NonNullable<AgentSocketOptions['verifyDelivery']>,
  env: Record<string, unknown>
): Promise<string | null> {
  try {
    return await check(env)
  } catch (e) {
    return `verify_error: ${e instanceof Error ? e.message : String(e)}`
  }
}
