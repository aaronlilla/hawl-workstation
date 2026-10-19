// Site events for a signed-in member: REST replay first, then the console socket with a cursor.
// Needs the user plane (UserJWT): `/v1/towns/:twn/events` and `/v1/console/ws` refuse worker tokens.
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { HawlApiError, type TokenSource, wsUrlFor } from './core'
import type { Http } from './http'

export const CONSOLE_STREAMS = ['feed', 'handoffs', 'workers', 'needs_action', 'files', 'map'] as const
export type ConsoleStreamName = (typeof CONSOLE_STREAMS)[number]

/** A site event. REST rows have no `stream`; socket frames name the stream they came on (`t`). */
export type TownEventFrame = {
  seq: number
  event: string
  at: string
  town_id: string
  stream?: ConsoleStreamName
  [k: string]: unknown
}

export type TownEventStreamOptions = {
  relayUrl: string
  townId: string
  user: TokenSource
  http: Http
  streams?: readonly ConsoleStreamName[]
  /** Last seq the caller already has. Default 0: replay everything the relay still holds. */
  afterSeq?: number
  /** Must equal the web origin the relay allows for `/v1/console/ws`. */
  origin?: string
  reconnectMs?: { min: number; max: number }
  random?: () => number
  /** Skip the REST replay and let the socket replay from `afterSeq`. */
  socketOnly?: boolean
}

export interface TownEventStreamEvents {
  event: [TownEventFrame]
  state: ['replaying' | 'connecting' | 'live' | 'stopped']
  error: [Error]
}

/**
 * Emits each event once. After a drop it reconnects and resubscribes one seq back, because a
 * single event can arrive as several frames (one per stream) and the cut may fall between them.
 */
export class TownEventStream extends EventEmitter {
  /** Highest seq emitted. */
  cursor: number
  state: 'idle' | 'replaying' | 'connecting' | 'live' | 'stopped' = 'idle'
  readonly #o: TownEventStreamOptions
  #ws: WebSocket | null = null
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #floor = 0
  #backoff: number
  readonly #seen = new Set<string>()

  constructor(o: TownEventStreamOptions) {
    super()
    this.#o = o
    this.cursor = o.afterSeq ?? 0
    this.#backoff = o.reconnectMs?.min ?? 1000
  }

  override on<K extends keyof TownEventStreamEvents>(
    ev: K,
    fn: (...a: TownEventStreamEvents[K]) => void
  ): this {
    return super.on(ev, fn as (...a: unknown[]) => void)
  }

  async start(): Promise<void> {
    this.#stopped = false
    if (!this.#o.socketOnly) {
      this.#set('replaying')
      try {
        await this.replay()
      } catch (e) {
        this.emit('error', e as Error)
        // The socket replays from the cursor too, so a failed REST page is not fatal.
      }
    }
    // History came from REST; socket frames at or below it would repeat it.
    this.#floor = this.#o.socketOnly ? 0 : this.cursor
    this.#connect()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#ws?.close(1000)
    this.#set('stopped')
  }

  /** Page through `GET /v1/towns/:twn/events` until the relay has nothing newer. */
  async replay(): Promise<number> {
    let n = 0
    for (;;) {
      const before = this.cursor
      const page = await this.#o.http.get<{ events: TownEventFrame[]; next_after_seq: number }>(
        `/v1/towns/${this.#o.townId}/events`,
        { plane: 'user', query: { after_seq: this.cursor } }
      )
      if (page.events.length === 0) return n
      for (const e of page.events) {
        if (this.#take(`rest:${e.seq}`, e.seq)) {
          this.emit('event', e)
          n++
        }
      }
      // A page that does not move the cursor would loop forever.
      if (page.next_after_seq <= before) return n
      this.cursor = Math.max(this.cursor, page.next_after_seq)
    }
  }

  #take(key: string, seq: number): boolean {
    if (this.#seen.has(key)) return false
    this.#seen.add(key)
    if (this.#seen.size > 20_000) this.#seen.delete(this.#seen.values().next().value as string)
    if (seq > this.cursor) this.cursor = seq
    return true
  }

  #set(s: TownEventStream['state']): void {
    if (this.state === s) return
    this.state = s
    this.emit('state', s)
  }

  #connect(): void {
    if (this.#stopped) return
    this.#set('connecting')
    const headers: Record<string, string> = {}
    if (this.#o.origin) headers.origin = this.#o.origin
    const ws = new WebSocket(wsUrlFor(this.#o.relayUrl, '/v1/console/ws'), { headers })
    this.#ws = ws
    ws.on('open', () => {
      void (async () => {
        try {
          const jwt = await this.#o.user.token()
          ws.send(JSON.stringify({ t: 'auth', jwt, town_id: this.#o.townId }))
          ws.send(
            JSON.stringify({
              t: 'subscribe',
              streams: [...(this.#o.streams ?? CONSOLE_STREAMS)],
              after_seq: Math.max(0, this.cursor - 1)
            })
          )
          this.#backoff = this.#o.reconnectMs?.min ?? 1000
          this.#set('live')
        } catch (e) {
          this.emit('error', e as Error)
          ws.close(1011, 'no token')
        }
      })()
    })
    ws.on('message', (raw) => {
      let f: Record<string, unknown>
      try {
        f = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (f.t === 'error') {
        const e = (f.error ?? {}) as { code?: string; message?: string }
        this.emit('error', new HawlApiError(0, e.code ?? 'relay_error', e.message ?? 'Relay error.'))
        return
      }
      if (typeof f.seq !== 'number' || typeof f.t !== 'string' || f.seq <= this.#floor) return
      if (!this.#take(`${f.t}:${f.seq}`, f.seq)) return
      const { t, ...rest } = f
      this.emit('event', { ...rest, stream: t } as TownEventFrame)
    })
    ws.on('close', (code) => {
      if (this.#ws !== ws) return
      this.#ws = null
      if (this.#stopped) return
      // 4401: the UserJWT expired or was refused. Fetch a fresh one on the way back.
      if (code === 4401) this.#o.user.invalidate()
      this.#set('connecting')
      const max = this.#o.reconnectMs?.max ?? 30_000
      const r = (this.#o.random ?? Math.random)()
      const wait = Math.round(this.#backoff / 2 + (this.#backoff / 2) * r)
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.#connect()
      }, wait)
      this.#backoff = Math.min(this.#backoff * 2, max)
    })
    ws.on('error', () => {
      // 'close' follows
    })
  }
}
