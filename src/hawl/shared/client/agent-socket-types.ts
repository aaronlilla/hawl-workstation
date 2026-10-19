// Types for the worker socket.
import type { Credentials } from './core'

export type SocketState = 'idle' | 'connecting' | 'handshake' | 'connected' | 'replaced' | 'stopped'

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
  verifyReady?: (hello: Hello, ready: Ready, clientNonce: string) => boolean
  /**
   * Checked on every `deliver` before it is handed over: the relay signature and sender signature
   * (the CLI daemon's verifyEnvelope). Return null to accept, or a reason to drop it. A dropped
   * delivery is reported as `dropped`, never emitted as `deliver`, and never acked.
   */
  verifyDelivery?: (env: Record<string, unknown>) => Promise<string | null> | string | null
  reconnectMs?: { min: number; max: number }
  handshakeTimeoutMs?: number
  /** No frame for this long means a half-open socket: reconnect. The relay pings every 25 s. */
  staleMs?: number
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
  error: [Error]
}

/** Close codes after which retrying fast cannot help: refused handshake, suspended, CLI too old, rate limited. */
export const SLOW_RETRY = new Set([4401, 4403, 4426, 4429])
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
