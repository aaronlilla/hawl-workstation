// The worker socket (`/v1/ws`, subprotocol relay.v1): hello, signed auth, ready, deliveries, notices.
// Reconnects with jittered backoff and asks for everything after the last delivery it saw.
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { Rpc } from './rpc'
import { b64url, HawlApiError, handshakeInput, signEd25519, wsUrlFor } from './core'
import type {
  AgentSocketEvents,
  AgentSocketOptions,
  Hello,
  Ready,
  SocketState
} from './agent-socket-types'

export type * from './agent-socket-types'

/** Close codes after which retrying fast cannot help: refused handshake, suspended, CLI too old. */
const SLOW_RETRY = new Set([4401, 4403, 4426])
const REPLACED = 4409

export class AgentSocket extends EventEmitter {
  state: SocketState = 'idle'
  notice = { unread: 0, needs_action: 0 }
  /** Highest `inbox_seq` seen so far. */
  lastSeq: number
  readonly #o: AgentSocketOptions
  #ws: WebSocket | null = null
  #timer: NodeJS.Timeout | null = null
  #watchdog: NodeJS.Timeout | null = null
  #backoff: number
  #stopped = false
  #lastSeen = 0
  readonly #rpc = new Rpc()
  readonly #seen = new Set<number>()

  constructor(o: AgentSocketOptions) {
    super()
    this.#o = o
    this.#backoff = o.reconnectMs?.min ?? 1000
    this.lastSeq = o.afterSeq ?? 0
  }

  override on<K extends keyof AgentSocketEvents>(
    ev: K,
    fn: (...a: AgentSocketEvents[K]) => void
  ): this {
    return super.on(ev, fn as (...a: unknown[]) => void)
  }

  start(): void {
    this.#stopped = false
    this.#connect()
    const every = this.#o.watchdogMs ?? 5000
    this.#watchdog = setInterval(() => {
      if (this.state === 'connected' && Date.now() - this.#lastSeen > (this.#o.staleMs ?? 70_000)) {
        this.kick()
      }
    }, every)
    this.#watchdog.unref()
  }

  stop(): void {
    this.#stopped = true
    this.#rpc.failAll('socket stopped')
    if (this.#timer) {
      clearTimeout(this.#timer)
    }
    if (this.#watchdog) {
      clearInterval(this.#watchdog)
    }
    this.#timer = null
    this.#ws?.close(1000)
    this.#set('stopped')
  }

  /** Reconnect now (network change, wake from sleep). Skips the wait. */
  kick(): void {
    if (this.#stopped) {
      return
    }
    this.#backoff = this.#o.reconnectMs?.min ?? 1000
    if (this.#ws) {
      this.#ws.terminate()
    } else if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
      this.#connect()
    }
  }

  /** Fire-and-forget frame. False when the socket is not ready. */
  send(frame: Record<string, unknown>): boolean {
    if (this.state !== 'connected' || this.#ws?.readyState !== WebSocket.OPEN) {
      return false
    }
    this.#ws.send(JSON.stringify(frame))
    return true
  }

  /** Tell the relay these deliveries are safe in local storage. */
  ack(upToSeq: number): boolean {
    return this.send({ t: 'ack', up_to_seq: upToSeq })
  }

  /** Ask for deliveries after `afterSeq`; they arrive as `deliver` events. */
  fetchInbox(afterSeq: number = this.lastSeq, limit = 100): boolean {
    return this.send({ t: 'inbox.fetch', after_seq: afterSeq, limit })
  }

  setPresence(status: 'idle' | 'busy' | 'away'): boolean {
    return this.send({ t: 'presence.set', status })
  }

  /** A non-send tool over the socket (`tool.call`); send-type tools need the signed HTTP path. */
  tool(name: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    return this.#rpc.call((id) => this.send({ t: 'tool.call', id, name, args }), timeoutMs)
  }

  #set(s: SocketState): void {
    if (this.state === s) {
      return
    }
    this.state = s
    this.emit('state', s)
  }

  #connect(): void {
    if (this.#stopped) {
      return
    }
    this.#set('connecting')
    const c = this.#o.credentials
    const ws = new WebSocket(wsUrlFor(c.relayUrl, '/v1/ws'), 'relay.v1')
    this.#ws = ws
    let hello: Hello | null = null
    let clientNonce = ''
    let ready = false
    this.#lastSeen = Date.now()
    const hs = setTimeout(
      () => ws.close(4408, 'handshake timeout'),
      this.#o.handshakeTimeoutMs ?? 10_000
    )

    ws.on('message', (raw) => {
      this.#lastSeen = Date.now()
      let f: Record<string, unknown>
      try {
        f = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (!ready) {
        if (f.t === 'hello' && !hello) {
          hello = f as unknown as Hello
          this.#set('handshake')
          clientNonce = b64url(randomBytes(32))
          const sig = signEd25519(
            c.privateJwk,
            handshakeInput({
              nonce: hello.nonce,
              clientNonce,
              residentId: c.residentId,
              serverTime: hello.server_time
            })
          )
          ws.send(
            JSON.stringify({
              t: 'auth',
              resident_id: c.residentId,
              kid: c.kid,
              client_nonce: clientNonce,
              sig: b64url(sig),
              client: { name: 'hawl-workstation', version: this.#o.version ?? '0.0.0' }
            })
          )
          return
        }
        if (f.t === 'ready' && hello) {
          const r = f as unknown as Ready
          if (r.resident_id !== c.residentId) {
            this.emit(
              'error',
              new HawlApiError(0, 'bad_ready', 'The relay answered for another worker.')
            )
            ws.close(4401, 'handshake refused')
            return
          }
          if (this.#o.verifyReady && !this.#o.verifyReady(hello, r, clientNonce)) {
            this.emit(
              'error',
              new HawlApiError(0, 'relay_not_trusted', 'The relay identity did not verify.')
            )
            ws.close(4401, 'handshake refused')
            return
          }
          ready = true
          clearTimeout(hs)
          this.#backoff = this.#o.reconnectMs?.min ?? 1000
          this.#set('connected')
          this.emit('ready', r)
          // The relay pushes whatever is claimable; this also covers rows already delivered but never acked.
          if (this.lastSeq > 0) {
            this.fetchInbox(this.lastSeq)
          }
          return
        }
        if (f.t === 'error') {
          const e = (f.error ?? {}) as { code?: string; message?: string }
          this.emit(
            'error',
            new HawlApiError(0, e.code ?? 'handshake_error', e.message ?? 'Handshake failed.')
          )
        }
        return // nothing else is trusted before ready
      }
      this.#onFrame(f)
    })

    ws.on('close', (code) => {
      clearTimeout(hs)
      if (this.#ws !== ws) {
        return
      }
      this.#ws = null
      this.#rpc.failAll('relay connection closed')
      if (this.#stopped) {
        return
      }
      if (code === REPLACED) {
        // Another session of this worker took over. Fighting for the socket would flap both.
        this.#set('replaced')
        return
      }
      this.#set('connecting')
      const max = this.#o.reconnectMs?.max ?? 30_000
      if (SLOW_RETRY.has(code)) {
        this.#backoff = max
      }
      const r = (this.#o.random ?? Math.random)()
      const wait = Math.round(this.#backoff / 2 + (this.#backoff / 2) * r)
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.#connect()
      }, wait)
      this.#backoff = Math.min(this.#backoff * 2, max)
    })
    ws.on('error', () => {
      // 'close' follows and schedules the retry
    })
  }

  #onFrame(f: Record<string, unknown>): void {
    switch (f.t) {
      case 'ping':
        this.send({ t: 'pong', ts: f.ts })
        return
      case 'deliver': {
        const env = f.envelope as Record<string, unknown>
        const seq = seqOf(env)
        if (seq !== null) {
          // Unacked rows come again after a reconnect: hand each one over once per run.
          if (this.#seen.has(seq)) {
            return
          }
          this.#seen.add(seq)
          if (this.#seen.size > 5000) {
            this.#seen.delete(this.#seen.values().next().value as number)
          }
          if (seq > this.lastSeq) {
            this.lastSeq = seq
          }
        }
        this.emit('deliver', env)
        return
      }
      case 'notice':
        this.notice = {
          unread: Number(f.unread ?? 0),
          needs_action: Number(f.needs_action ?? 0)
        }
        this.emit('notice', this.notice)
        return
      case 'control':
        this.emit('control', f)
        return
      case 'tool.result':
      case 'error': {
        if (!this.#rpc.answer(f) && f.t === 'error') {
          const e = (f.error ?? {}) as { code?: string; message?: string }
          this.emit(
            'error',
            new HawlApiError(0, e.code ?? 'relay_error', e.message ?? 'Relay error.')
          )
        }
      }
    }
  }
}

function seqOf(env: Record<string, unknown> | undefined): number | null {
  const relay = env?.relay as { delivery?: { inbox_seq?: unknown } } | undefined
  const v = relay?.delivery?.inbox_seq
  return typeof v === 'number' ? v : null
}
