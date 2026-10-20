// The door the inner agents (one per Orca terminal) use to talk to the foreman, and the foreman's AgentPort.
//
// A tiny JSON-over-HTTP server on 127.0.0.1 only. The terminal gets its address and token in its
// environment (HAWL_FOREMAN_URL, HAWL_FOREMAN_TOKEN, HAWL_AGENT_ID); a Hawl-aware agent (the hawl CLI) calls:
//   POST /v1/up|down|away|accept|decline|renew|progress|done|card/start|card/update
//   GET  /v1/events?agentId=..&after=N&wait=S   offers and revokes for that agent, long-polled
// Offers and revokes are never typed into the terminal: they wait here for the agent to fetch, and go to the
// app's terminal strip through `onEvent`. An agent that stops calling for `presenceMs` counts as down (S16, S17).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ForemanRuntime } from './runtime'
import { ForemanError } from './types'
import type { AgentEvent, AgentHub } from './agent-hub'

export type BridgeOptions = {
  rt: ForemanRuntime
  /** The same hub the Foreman was built with (`deps.agents = hub.port`). */
  hub: AgentHub
  /** Default: 24 random bytes, base64url. */
  token?: string
  /** An agent not heard from for this long is down. Default 45 s (the long poll is 25 s at most). */
  presenceMs?: number
  now?: () => number
}

const MAX_BODY = 64 * 1024
const MAX_WAIT_S = 25

const STATUS: Record<string, number> = {
  unknown_task: 404,
  unknown_card: 404,
  claim_revoked: 409,
  claim_taken: 409,
  bad_state: 409
}

function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new ForemanError('bad_offer', `${name} must be a non-empty string up to ${max} characters`)
  }
  return v
}

function opt(v: unknown, name: string, max = 500): string | undefined {
  return v === undefined || v === null ? undefined : str(v, name, max)
}

function epochOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ForemanError('bad_offer', 'epoch must be a whole number from 1')
  }
  return v
}

export class AgentBridge {
  readonly token: string
  readonly #o: Required<Pick<BridgeOptions, 'rt' | 'hub' | 'presenceMs' | 'now'>>
  readonly #up = new Set<string>()
  readonly #heard = new Map<string, number>()
  #server: Server | null = null
  #sweeper: ReturnType<typeof setInterval> | null = null
  port = 0

  constructor(o: BridgeOptions) {
    this.token = o.token ?? randomBytes(24).toString('base64url')
    this.#o = {
      rt: o.rt,
      hub: o.hub,
      presenceMs: o.presenceMs ?? 45_000,
      now: o.now ?? Date.now
    }
  }

  /** Mark agents that have gone quiet as down. Runs every few seconds once listening; callable directly. */
  sweep(): void {
    const now = this.#o.now()
    for (const id of this.#up) {
      if (now - (this.#heard.get(id) ?? 0) > this.#o.presenceMs) {
        this.#up.delete(id)
        this.#o.rt.run((f) => f.agentDown(id))
      }
    }
  }

  #hear(agentId: string): void {
    this.#heard.set(agentId, this.#o.now())
  }

  async listen(port = 0): Promise<number> {
    const server = createServer((req, res) => {
      void this.#handle(req, res)
    })
    this.#server = server
    await new Promise<void>((ok, fail) => {
      server.once('error', fail)
      server.listen(port, '127.0.0.1', ok)
    })
    this.port = (server.address() as AddressInfo).port
    this.#sweeper = setInterval(() => this.sweep(), 5000)
    this.#sweeper.unref()
    return this.port
  }

  async close(): Promise<void> {
    if (this.#sweeper) {
      clearInterval(this.#sweeper)
    }
    this.#o.hub.closeAll()
    const s = this.#server
    this.#server = null
    if (s) {
      s.closeAllConnections()
      await new Promise<void>((ok) => s.close(() => ok()))
    }
  }

  #authorized(req: IncomingMessage): boolean {
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      // A page on the web must not reach this by pointing a name at 127.0.0.1.
      return false
    }
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''))
    const want = Buffer.from(this.token)
    return given.length === want.length && timingSafeEqual(given, want)
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (!this.#authorized(req)) {
        send(401, { error: 'unauthorized' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        send(200, await this.#poll(url))
        return
      }
      if (req.method !== 'POST') {
        send(405, { error: 'method_not_allowed' })
        return
      }
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        send(415, { error: 'send application/json' })
        return
      }
      const body = await readJson(req)
      send(200, this.#call(url.pathname, body) ?? { ok: true })
    } catch (err) {
      if (err instanceof ForemanError) {
        send(STATUS[err.code] ?? 400, { error: err.code, message: err.message })
      } else if (err instanceof BodyError) {
        send(err.status, { error: 'bad_body', message: err.message })
      } else {
        send(500, { error: 'internal', message: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  async #poll(url: URL): Promise<{ events: AgentEvent[]; seq: number }> {
    const agentId = str(url.searchParams.get('agentId'), 'agentId')
    const after = Number(url.searchParams.get('after') ?? 0)
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0), 0), MAX_WAIT_S)
    if (!Number.isFinite(after) || !Number.isFinite(wait)) {
      throw new ForemanError('bad_offer', 'after and wait are numbers')
    }
    this.#hear(agentId)
    const events = await this.#o.hub.fetch(agentId, after, wait * 1000)
    this.#hear(agentId)
    return { events, seq: this.#o.hub.seq(agentId) }
  }

  #call(path: string, b: Record<string, unknown>): unknown {
    const rt = this.#o.rt
    const agentId = (): string => {
      const id = str(b.agentId, 'agentId')
      this.#hear(id)
      return id
    }
    switch (path) {
      case '/v1/up': {
        const id = agentId()
        const cap = b.capacity
        if (cap !== undefined && (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > 16)) {
          throw new ForemanError('bad_offer', 'capacity is a whole number from 1 to 16')
        }
        this.#up.add(id)
        rt.run((f) => f.agentUp(id, { label: opt(b.label, 'label', 80), capacity: cap }))
        return undefined
      }
      case '/v1/down': {
        const id = agentId()
        this.#up.delete(id)
        rt.run((f) => f.agentDown(id))
        return undefined
      }
      case '/v1/away': {
        const id = agentId()
        if (typeof b.away !== 'boolean') {
          throw new ForemanError('bad_offer', 'away must be true or false')
        }
        const away = b.away
        rt.run((f) => f.agentAway(id, away))
        return undefined
      }
      case '/v1/accept': {
        const id = agentId()
        return rt.run((f) => f.agentAccept(str(b.taskId, 'taskId'), id, epochOf(b.epoch)))
      }
      case '/v1/decline': {
        const id = agentId()
        rt.run((f) => f.agentDecline(str(b.taskId, 'taskId'), id, epochOf(b.epoch), opt(b.reason, 'reason')))
        return undefined
      }
      case '/v1/renew': {
        const id = agentId()
        rt.run((f) => f.agentRenew(str(b.taskId, 'taskId'), id, epochOf(b.epoch)))
        return undefined
      }
      case '/v1/progress': {
        const id = agentId()
        rt.run((f) => f.agentProgress(str(b.taskId, 'taskId'), id, epochOf(b.epoch), opt(b.note, 'note')))
        return undefined
      }
      case '/v1/done': {
        const id = agentId()
        const ev = b.evidence
        if (!Array.isArray(ev) || ev.length === 0 || ev.length > 20) {
          throw new ForemanError('bad_event', 'evidence is a list of 1 to 20 items')
        }
        return rt.run((f) =>
          f.agentDone(str(b.taskId, 'taskId'), id, epochOf(b.epoch), {
            revisionSha: str(b.revisionSha, 'revisionSha', 40),
            evidence: ev as { kind: 'sha' | 'ci' | 'pr' | 'artifact'; ref: string }[]
          })
        )
      }
      case '/v1/card/start': {
        const id = agentId()
        return rt.run((f) =>
          f.cards.start(id, {
            title: str(b.title, 'title', 200),
            capability: opt(b.capability, 'capability', 64),
            repo: opt(b.repo, 'repo', 200),
            jobId: opt(b.jobId, 'jobId', 200)
          })
        )
      }
      case '/v1/card/update': {
        const state = b.state
        if (state !== undefined && !['working', 'paused', 'done', 'dropped'].includes(String(state))) {
          throw new ForemanError('bad_card', 'state is working, paused, done or dropped')
        }
        return rt.run((f) =>
          f.cards.update(str(b.cardId, 'cardId'), {
            state: state as 'working' | 'paused' | 'done' | 'dropped' | undefined,
            title: opt(b.title, 'title', 200)
          })
        )
      }
      default:
        throw new BodyError(404, `no such route ${path}`)
    }
  }
}

class BodyError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        fail(new BodyError(413, 'body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          throw new Error('not an object')
        }
        ok(v as Record<string, unknown>)
      } catch {
        fail(new BodyError(400, 'body must be a JSON object'))
      }
    })
    req.on('error', fail)
  })
}
