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
  notice: [{ unread: number; needs_action: number }]
  control: [Record<string, unknown>]
  error: [Error]
}
