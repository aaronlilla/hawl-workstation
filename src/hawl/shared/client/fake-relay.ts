// A fake relay for the client tests. It checks what the real relay checks: the join claim
// signature, the 60 s client assertion, the WS handshake signature, the sender_sig on signed sends.
// It is a stand-in, not the relay: see the local-relay smoke script for the real one.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import type { Jwk } from './core'
import { authRoutes } from './fake-relay-auth'
import { agentRoutes } from './fake-relay-agent'
import type { Ctx, JoinRec, WorkerRec } from './fake-relay-ctx'
import { userRoutes } from './fake-relay-user'
import { agentWs, consoleWs, pushEvent } from './fake-relay-ws'
import type { TrustFixture } from './trust-fixture'

type Rule = { match: RegExp; status: number; retryAfter?: number; times: number }

export type FakeEvent = { seq: number; event: string; kind?: string; [k: string]: unknown }

export class FakeRelay {
  server!: Server
  wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (set) => (set.has('relay.v1') ? 'relay.v1' : false)
  })
  consoleWss = new WebSocketServer({ noServer: true })
  url = ''
  readonly townId = 'twn_01TEST'
  readonly userToken = 'user-jwt-1'
  readonly webOrigin = 'https://hawl.test'
  workers = new Map<string, WorkerRec>()
  joins = new Map<string, JoinRec>()
  tokens = new Map<string, { res: string; expMs: number }>()
  seenJti = new Set<string>()
  requests: { method: string; path: string; auth: string | undefined; body: unknown }[] = []
  rules: Rule[] = []
  /** Approve joins after this many 202s. */
  approveAfterPolls = 1
  tokenTtlS = 600
  tokenCount = 0
  events: FakeEvent[] = []
  /** Rows the inbox holds (envelope with relay.delivery.inbox_seq). */
  inbox: Record<string, unknown>[] = []
  agentConns: WebSocket[] = []
  consoleConns: WebSocket[] = []
  consoleOrigins: (string | undefined)[] = []
  /** Every `auth` frame the console socket got (the jwt strings), across connections. */
  consoleAuths: string[] = []
  /** Close every console socket with 4401 right after reading `auth`, like a revoked member. */
  consoleRefuseAuth = false
  /** Extra check on the console jwt (default: equals `userToken`). */
  acceptJwt: ((jwt: string) => boolean) | null = null
  handshakes = 0
  eventPageSize = 2
  /** Close the console socket after sending this many frames per subscription (0 = never). */
  consoleDropAfter = 0
  files = new Map<string, Buffer>()
  /** When set: the manifest, relay-signed `ready` frames and sender keys, like the real relay. */
  trust: TrustFixture | null = null
  approvalCount = 1
  senderKeys = new Map<string, { public_jwk: Jwk; compromised_at?: string | null }>()
  manifestOverride: unknown = undefined
  signedSends: { tool: string; args: unknown; cr: Record<string, unknown>; sigOk: boolean }[] = []

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.#http(req, res))
    this.server.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path === '/v1/ws') {
        const offered = String(req.headers['sec-websocket-protocol'] ?? '')
        if (!offered.includes('relay.v1')) {
          socket.destroy()
          return
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => agentWs(this, ws))
      } else if (path === '/v1/console/ws') {
        this.consoleOrigins.push(req.headers.origin)
        if (req.headers.origin !== this.webOrigin) {
          socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
          socket.destroy()
          return
        }
        this.consoleWss.handleUpgrade(req, socket, head, (ws) => consoleWs(this, ws))
      } else {
        socket.destroy()
      }
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    for (const w of [...this.agentConns, ...this.consoleConns]) {
      w.terminate()
    }
    this.wss.close()
    this.consoleWss.close()
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  addEvent(e: FakeEvent): void {
    this.events.push(e)
    for (const ws of this.consoleConns) {
      const sub = (ws as WebSocket & { sub?: { streams: string[] } }).sub
      if (sub && ws.readyState === ws.OPEN) {
        pushEvent(this, ws, e)
      }
    }
  }

  failNext(match: RegExp, status: number, times = 1, retryAfter?: number): void {
    this.rules.push({ match, status, times, ...(retryAfter !== undefined ? { retryAfter } : {}) })
  }

  /** Close every agent socket with a code (relay restart, suspension, replaced). */
  dropAgents(code: number): void {
    for (const w of this.agentConns) {
      if (code === 1006) {
        w.terminate()
      } else {
        w.close(code, 'test')
      }
    }
  }

  // ---- HTTP -----------------------------------------------------------------------------------

  async #http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) {
      chunks.push(c as Buffer)
    }
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const ctype = String(req.headers['content-type'] ?? '')
    let body: unknown = undefined
    if (ctype.includes('json') && raw.length) {
      body = JSON.parse(raw.toString('utf8'))
    }
    this.requests.push({
      method: req.method ?? '',
      path: path + url.search,
      auth: req.headers.authorization,
      body
    })

    const rule = this.rules.find((r) => r.times > 0 && r.match.test(path))
    if (rule) {
      rule.times--
      if (rule.retryAfter !== undefined) {
        res.setHeader('retry-after', String(rule.retryAfter))
      }
      return this.err(
        res,
        rule.status,
        rule.status === 429 ? 'rate_limited' : 'unavailable',
        'try later'
      )
    }

    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(v))
    }
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
    const agent = (): WorkerRec | null => {
      const t = bearer ? this.tokens.get(bearer) : undefined
      if (!t || t.expMs < Date.now()) {
        return null
      }
      return this.workers.get(t.res) ?? null
    }
    const user = () => bearer === this.userToken
    const m = req.method ?? 'GET'

    const ctx: Ctx = { r: this, req, res, url, path, m, body, raw, bearer, json, agent, user }
    for (const route of [authRoutes, agentRoutes, userRoutes]) {
      route(ctx)
      if (res.writableEnded) {
        return
      }
    }
  }

  pushDeliver(e: Record<string, unknown>): void {
    this.inbox.push(e)
    for (const ws of this.agentConns) {
      ws.send(JSON.stringify({ t: 'deliver', envelope: e }))
    }
  }

  err(res: ServerResponse, status: number, code: string, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code, message, request_id: 'req_t', retry_after: null } }))
  }
}
