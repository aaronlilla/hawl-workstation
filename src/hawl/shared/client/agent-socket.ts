// The worker socket (`/v1/ws`, subprotocol relay.v1): hello, signed auth, ready, deliveries, notices.
// Reconnects with jittered backoff and asks for everything after the last delivery it saw.
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { Handshake } from './agent-handshake'
import { Rpc } from './rpc'
import { HawlApiError, wsUrlFor } from './core'
import {
  type AgentSocketEvents,
  type AgentSocketOptions,
  checkDelivery,
  DRAINING,
  DRAINING_FLOOR_MS,
  REPLACED,
  seqOf,
  SLOW_RETRY,
  type SocketState,
  TERMINAL
} from './agent-socket-types'

import { DeliveryRetry, DeliverySeen, RETRYABLE } from './delivery-seen'

export type * from './agent-socket-types'

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
  #chain: Promise<void> = Promise.resolve()
  readonly #rpc = new Rpc()
  readonly #seen = new DeliverySeen()
  #strikes = 0
  readonly #retry = new DeliveryRetry()

  constructor(o: AgentSocketOptions) {
    super()
    if (!o.verifyDelivery && !o.insecureNoVerify) {
      throw new Error(
        'AgentSocket needs verifyDelivery (use HawlClient.socket(), or set insecureNoVerify for tests).'
      )
    }
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

  /** Safe to call again: after a stop, or after `replaced` to take the socket back. */
  start(): void {
    this.#stopped = false
    if (this.state === 'refused') {
      this.#strikes = 0
      this.state = 'idle'
    }
    if (this.#ws || this.#timer) {
      return // already connecting or connected
    }
    this.#connect()
    if (this.#watchdog) {
      return
    }
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
    this.#retry.clear()
    if (this.#timer) {
      clearTimeout(this.#timer)
    }
    if (this.#watchdog) {
      clearInterval(this.#watchdog)
    }
    this.#watchdog = null
    this.#timer = null
    const ws = this.#ws
    this.#ws = null // so a start() right after stop() connects again, and the old close is ignored
    ws?.close(1000)
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

  /** An 'error' event nobody listens to would throw inside a socket callback and kill the process. */
  #fail(e: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', e)
    }
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
    this.#lastSeen = Date.now()
    const hs = setTimeout(
      () => ws.close(4408, 'handshake timeout'),
      this.#o.handshakeTimeoutMs ?? 10_000
    )
    const shake = new Handshake({
      ws,
      credentials: c,
      version: this.#o.version ?? '0.0.0',
      verifyReady: this.#o.verifyReady,
      current: () => this.#ws === ws,
      onHello: () => this.#set('handshake'),
      onError: (e) => this.#fail(e),
      onReady: (r) => {
        clearTimeout(hs)
        this.#backoff = this.#o.reconnectMs?.min ?? 1000
        this.#strikes = 0
        this.#set('connected')
        this.emit('ready', r)
        // The relay pushes whatever is claimable; this also covers rows already delivered but never acked.
        if (this.lastSeq > 0) {
          this.fetchInbox(this.lastSeq)
        }
      },
      replay: (frames) => frames.forEach((fr) => this.#onFrame(fr))
    })

    ws.on('message', (raw) => {
      this.#lastSeen = Date.now()
      let f: Record<string, unknown>
      try {
        f = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (shake.ready) {
        this.#onFrame(f)
      } else {
        shake.feed(f)
      }
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
      const terminal = TERMINAL.get(code)
      if (terminal) {
        this.#set('refused')
        this.emit('refused', { code, reason: terminal })
        return
      }
      if (code === 4401 && !shake.untrusted && !shake.ready) {
        this.#strikes++
        if (this.#strikes >= (this.#o.authStrikes ?? 5)) {
          this.#set('refused')
          this.emit('refused', { code, reason: 'auth_failed' })
          return
        }
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
      } else if (code === DRAINING) {
        this.#backoff = Math.max(this.#backoff, Math.min(max, DRAINING_FLOOR_MS))
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

  async #hand(env: Record<string, unknown>): Promise<void> {
    const check = this.#o.verifyDelivery
    const reason = check ? await checkDelivery(check, env) : null
    if (reason !== null) {
      if (RETRYABLE.has(reason) || reason.startsWith('verify_error')) {
        // Our key list may be old, or a key lookup hit a passing failure: let a later fetch hand it over again.
        this.#seen.release(env)
        const seq = seqOf(env)
        if (seq !== null) {
          this.#retry.schedule(
            seq,
            this.#o.retryDeliveryMs ?? 1000,
            () => !this.#stopped && this.fetchInbox(seq - 1)
          )
        }
      }
      this.emit('dropped', { envelope: env, reason })
      return
    }
    const done = seqOf(env)
    if (done !== null) {
      this.#retry.done(done)
    }
    this.emit('deliver', env)
  }

  #onFrame(f: Record<string, unknown>): void {
    switch (f.t) {
      case 'ping':
        this.send({ t: 'pong', ts: f.ts })
        return
      case 'deliver': {
        const env = f.envelope as Record<string, unknown>
        if (!this.#seen.take(env)) {
          return
        }
        const seq = seqOf(env)
        if (seq !== null && seq > this.lastSeq) {
          this.lastSeq = seq
        }
        if (this.#o.verifyDelivery) {
          // Keep arrival order while the checks run.
          this.#chain = this.#chain.then(() => this.#hand(env))
        } else {
          this.emit('deliver', env)
        }
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
          this.#fail(new HawlApiError(0, e.code ?? 'relay_error', e.message ?? 'Relay error.'))
        }
      }
    }
  }
}
