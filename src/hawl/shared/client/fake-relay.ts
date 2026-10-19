// oxlint-disable max-lines -- SAFETY: test fixture; one file keeps the fake relay's routes and sockets readable together.
// A fake relay for the client tests. It checks what the real relay checks: the join claim
// signature, the 60 s client assertion, the WS handshake signature, the sender_sig on signed sends.
// It is a stand-in, not the relay: see the local-relay smoke script for the real one.
import {
  createHash,
  createPublicKey,
  verify as nodeVerify,
  type KeyObject,
  randomUUID
} from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import { handshakeInput, jcs, type Jwk } from './core'

type WorkerRec = { id: string; kid: string; pub: KeyObject; jwk: Jwk; slug: string }
type JoinRec = { id: string; pub: KeyObject; jwk: Jwk; slug: string; polls: number; code: string }
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
        this.wss.handleUpgrade(req, socket, head, (ws) => this.#agentWs(ws))
      } else if (path === '/v1/console/ws') {
        this.consoleOrigins.push(req.headers.origin)
        if (req.headers.origin !== this.webOrigin) {
          socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
          socket.destroy()
          return
        }
        this.consoleWss.handleUpgrade(req, socket, head, (ws) => this.#consoleWs(ws))
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
        this.#pushEvent(ws, e)
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
      return this.#err(
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

    if (m === 'POST' && path === '/v1/join/start') {
      const b = body as { town_slug: string; public_jwk: Jwk; platform: string }
      if (
        b.public_jwk?.kty !== 'OKP' ||
        b.public_jwk.x?.length !== 43 ||
        !/^[a-z0-9_]{1,40}$/.test(b.platform)
      ) {
        return this.#err(res, 400, 'invalid_request', 'Bad public_jwk.')
      }
      const id = `jrq_${randomUUID()}`
      const jwk = { kty: 'OKP', crv: 'Ed25519', x: b.public_jwk.x }
      this.joins.set(id, {
        id,
        pub: createPublicKey({ key: jwk, format: 'jwk' }),
        jwk,
        slug: b.town_slug,
        polls: 0,
        code: 'ABCD-EFGH'
      })
      return json(201, {
        join_id: id,
        user_code: 'ABCD-EFGH',
        key_fingerprint: 'fp-test',
        expires_in: 600
      })
    }
    const claim = /^\/v1\/join\/([^/]+)\/claim$/.exec(path)
    if (m === 'POST' && claim) {
      const j = this.joins.get(claim[1] as string)
      if (!j) {
        return this.#err(res, 404, 'not_found', 'Not found.')
      }
      const c = body as { nonce: string; ts: number; sig: string }
      const ok = nodeVerify(
        null,
        Buffer.from(jcs({ join_id: j.id, nonce: c.nonce, ts: c.ts })),
        j.pub,
        Buffer.from(c.sig, 'base64url')
      )
      if (!ok) {
        return this.#err(res, 404, 'not_found', 'Not found.')
      }
      if (++j.polls <= this.approveAfterPolls) {
        return json(202, { state: 'pending' })
      }
      const rid = `res_${randomUUID()}`
      const kid = `key_${createHash('sha256')
        .update(j.jwk.x as string)
        .digest('hex')
        .slice(0, 20)}`
      this.workers.set(rid, { id: rid, kid, pub: j.pub, jwk: j.jwk, slug: j.slug })
      return json(200, {
        resident_id: rid,
        kid,
        town_id: this.townId,
        relay_url: this.url,
        needs_owner_approval: false
      })
    }
    if (m === 'POST' && path === '/v1/auth/token') {
      const a = (body as { client_assertion?: string })?.client_assertion ?? ''
      const [h, p, s] = a.split('.')
      try {
        const head = JSON.parse(Buffer.from(h as string, 'base64url').toString())
        const claims = JSON.parse(Buffer.from(p as string, 'base64url').toString()) as Record<
          string,
          unknown
        >
        const w = [...this.workers.values()].find((x) => x.kid === head.kid)
        const now = Math.floor(Date.now() / 1000)
        const good =
          w &&
          head.alg === 'EdDSA' &&
          nodeVerify(
            null,
            Buffer.from(`${h}.${p}`),
            w.pub,
            Buffer.from(s as string, 'base64url')
          ) &&
          claims.iss === w.id &&
          claims.sub === w.id &&
          claims.aud === this.url &&
          (claims.exp as number) - (claims.iat as number) <= 60 &&
          (claims.exp as number) > now &&
          !this.seenJti.has(String(claims.jti))
        if (!good || !w) {
          return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
        }
        this.seenJti.add(String(claims.jti))
        const tok = `agent-tok-${++this.tokenCount}`
        this.tokens.set(tok, { res: w.id, expMs: Date.now() + this.tokenTtlS * 1000 })
        return json(200, { access_token: tok, token_type: 'Bearer', expires_in: this.tokenTtlS })
      } catch {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
    }

    // agent plane
    const w = agent()
    if (m === 'GET' && path === '/v1/me') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      return json(200, {
        resident_id: w.id,
        town_id: this.townId,
        town_slug: w.slug,
        handle: 'workstation',
        display_name: 'Test',
        platform: 'hawl_workstation',
        status: 'active',
        limits: { send_per_min: 30, max_body_bytes: 32768 },
        unread: this.inbox.length,
        needs_action: 0
      })
    }
    if (m === 'POST' && path === '/v1/tools/call') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      const b = body as {
        name: string
        args: Record<string, unknown>
        client_request?: Record<string, unknown>
        sender_sig?: { sig: string; kid: string }
      }
      if (b.client_request) {
        const bytes = Buffer.from(jcs(b.client_request), 'utf8')
        const sigOk =
          nodeVerify(null, bytes, w.pub, Buffer.from(b.sender_sig?.sig ?? '', 'base64url')) &&
          b.sender_sig?.kid === w.kid
        this.signedSends.push({ tool: b.name, args: b.args, cr: b.client_request, sigOk })
        if (!sigOk) {
          return this.#err(res, 400, 'bad_signature', 'sender_sig does not verify.')
        }
        return json(200, { message_id: 'msg_1', state: 'queued', handoff_id: 'hnd_1' })
      }
      if (b.name === 'who') {
        return json(200, {
          workers: [
            { handle: 'sam', resident_id: 'res_SAM', status: 'idle' },
            { handle: 'kit', resident_id: 'res_KIT', status: 'busy' }
          ].filter((x) => !b.args.query || x.handle === b.args.query)
        })
      }
      if (b.name === 'handoff_list') {
        return json(200, { handoffs: [{ handoff_id: 'hnd_1', state: 'asked', title: 'Fix it' }] })
      }
      if (b.name === 'board_read') {
        return json(200, { pins: [] })
      }
      return json(200, {})
    }
    if (m === 'POST' && path === '/v1/messages') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      const b = body as {
        client_request: Record<string, unknown>
        sender_sig: { sig: string; kid: string }
      }
      if (
        !req.headers['idempotency-key'] ||
        req.headers['idempotency-key'] !== b.client_request.idempotency_key
      ) {
        return this.#err(res, 400, 'invalid_request', 'Idempotency-Key required.')
      }
      const sigOk =
        nodeVerify(
          null,
          Buffer.from(jcs(b.client_request), 'utf8'),
          w.pub,
          Buffer.from(b.sender_sig.sig, 'base64url')
        ) && b.sender_sig.kid === w.kid
      this.signedSends.push({ tool: 'message', args: undefined, cr: b.client_request, sigOk })
      if (!sigOk) {
        return this.#err(res, 400, 'bad_signature', 'sender_sig does not verify.')
      }
      return json(202, { message_id: 'msg_1', state: 'queued' })
    }
    if (m === 'GET' && path === '/v1/channels') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      return json(200, {
        items: [
          {
            channel_id: 'chn_SQ',
            kind: 'square',
            name: 'square',
            topic: null,
            member: true,
            wake_on: null
          },
          {
            channel_id: 'chn_R1',
            kind: 'room',
            name: 'build',
            topic: null,
            member: true,
            wake_on: null
          }
        ]
      })
    }
    if (m === 'GET' && path === '/v1/handoffs/hnd_1') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      return json(200, { handoff_id: 'hnd_1', state: 'accepted' })
    }
    if (m === 'POST' && path === '/v1/handoffs/hnd_1/act') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      return json(200, { handoff_id: 'hnd_1', state: 'done', echo: body })
    }
    if (m === 'GET' && path === '/v1/inbox') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      const after = Number(url.searchParams.get('after_seq') ?? 0)
      const items = this.inbox
        .filter((e) => seqOfEnv(e) > after)
        .map((e) => ({ inbox_seq: seqOfEnv(e), envelope: e }))
      return json(200, { items, unread: items.length, needs_action: 0 })
    }
    if (m === 'POST' && path === '/v1/files/uploads') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      const b = body as { name: string; mime: string; bytes: number; sha256: string }
      // The real relay takes the SHA-256 as 43 base64url characters (files/uploads.ts SHA_RE).
      if (!/^[A-Za-z0-9_-]{43}$/.test(b.sha256)) {
        return this.#err(res, 400, 'invalid_request', 'Bad sha256.')
      }
      return json(200, {
        upl_id: 'upl_1',
        put_url: `${this.url}/v1/files/uploads/upl_1`,
        expires_in: 300,
        expect: b
      })
    }
    if (m === 'PUT' && path === '/v1/files/uploads/upl_1') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      this.files.set('upl_1', raw)
      return json(200, {
        file_id: 'fil_1',
        state: 'scanning',
        sha256: createHash('sha256').update(raw).digest('base64url')
      })
    }
    if (m === 'GET' && path === '/v1/files/fil_1/content') {
      if (!w) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return void res.end(this.files.get('upl_1') ?? Buffer.alloc(0))
    }

    // user plane
    if (
      path.startsWith(`/v1/towns/${this.townId}/`) ||
      path.startsWith('/v1/approvals/') ||
      path === '/v1/me/sites'
    ) {
      if (!user()) {
        return this.#err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      if (m === 'GET' && path === '/v1/me/sites') {
        return json(200, { sites: [] })
      }
      if (m === 'GET' && path.endsWith('/approvals')) {
        return json(200, {
          items: [{ approval_id: 'apr_1', state: url.searchParams.get('state') }]
        })
      }
      if (m === 'POST' && path === '/v1/approvals/apr_1/approve') {
        return json(200, { state: 'approved', note: (body as { note?: string })?.note })
      }
      if (m === 'GET' && path.endsWith('/events')) {
        const after = Number(url.searchParams.get('after_seq') ?? 0)
        const page = this.events.filter((e) => e.seq > after).slice(0, this.eventPageSize)
        return json(200, {
          events: page.map((e) => ({ ...e, town_id: this.townId, at: '2026-10-19T00:00:00Z' })),
          next_after_seq: page.length ? (page.at(-1) as FakeEvent).seq : after
        })
      }
    }
    if (path.startsWith('/v1/')) {
      return this.#err(
        res,
        bearer ? 404 : 401,
        bearer ? 'not_found' : 'unauthenticated',
        'Not found.'
      )
    }
    json(404, {})
  }

  #err(res: ServerResponse, status: number, code: string, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code, message, request_id: 'req_t', retry_after: null } }))
  }

  // ---- agent socket ---------------------------------------------------------------------------

  #agentWs(ws: WebSocket): void {
    const nonce = randomUUID().replace(/-/g, '').padEnd(43, 'x')
    const serverTime = new Date().toISOString()
    ws.send(
      JSON.stringify({
        t: 'hello',
        nonce,
        server_time: serverTime,
        relay_kid: 'rk_test',
        protocol: 1
      })
    )
    let authed: WorkerRec | null = null
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Record<string, unknown>
      if (!authed) {
        const w = this.workers.get(String(f.resident_id))
        const good =
          f.t === 'auth' &&
          w &&
          w.kid === f.kid &&
          nodeVerify(
            null,
            handshakeInput({
              nonce,
              clientNonce: String(f.client_nonce),
              residentId: w.id,
              serverTime
            }),
            w.pub,
            Buffer.from(String(f.sig), 'base64url')
          )
        if (!good || !w) {
          return void ws.close(4401, 'auth failed')
        }
        authed = w
        this.handshakes++
        this.agentConns.push(ws)
        ws.on('close', () => {
          this.agentConns = this.agentConns.filter((x) => x !== ws)
        })
        ws.send(
          JSON.stringify({
            t: 'ready',
            session_id: 'ses_1',
            resident_id: w.id,
            town_id: this.townId,
            pending: this.inbox.length,
            heartbeat_s: 25,
            relay_sig: 'x'
          })
        )
        // The real relay pushes everything claimable after ready.
        for (const e of this.inbox) {
          ws.send(JSON.stringify({ t: 'deliver', envelope: e }))
        }
        return
      }
      if (f.t === 'inbox.fetch') {
        for (const e of this.inbox.filter((x) => seqOfEnv(x) > Number(f.after_seq))) {
          ws.send(JSON.stringify({ t: 'deliver', envelope: e }))
        }
        ws.send(JSON.stringify({ t: 'notice', unread: this.inbox.length, needs_action: 0 }))
      } else if (f.t === 'tool.call') {
        if (f.name === 'who') {
          ws.send(JSON.stringify({ t: 'tool.result', id: f.id, result: { workers: [] } }))
        } else {
          ws.send(
            JSON.stringify({
              t: 'tool.result',
              id: f.id,
              error: {
                code: 'invalid_request',
                message: 'Unknown tool.',
                request_id: 'r',
                retry_after: null
              }
            })
          )
        }
      } else if (f.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', ts: f.ts }))
      }
    })
  }

  pushDeliver(e: Record<string, unknown>): void {
    this.inbox.push(e)
    for (const ws of this.agentConns) {
      ws.send(JSON.stringify({ t: 'deliver', envelope: e }))
    }
  }

  // ---- console socket -------------------------------------------------------------------------

  #consoleWs(ws: WebSocket): void {
    let authed = false
    this.consoleConns.push(ws)
    ws.on('close', () => {
      this.consoleConns = this.consoleConns.filter((x) => x !== ws)
    })
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as {
        t: string
        jwt?: string
        streams?: string[]
        after_seq?: number
      }
      if (f.t === 'auth') {
        this.consoleAuths.push(String(f.jwt))
        const ok = this.acceptJwt ? this.acceptJwt(String(f.jwt)) : f.jwt === this.userToken
        if (!ok || this.consoleRefuseAuth) {
          return void ws.close(4401, 'auth failed')
        }
        authed = true
        return
      }
      if (f.t === 'subscribe' && authed) {
        ;(ws as WebSocket & { sub?: unknown }).sub = { streams: f.streams }
        let sent = 0
        for (const e of this.events.filter((x) => x.seq > (f.after_seq ?? 0))) {
          this.#pushEvent(ws, e)
          sent++
          if (this.consoleDropAfter && sent >= this.consoleDropAfter) {
            ws.close(1011, 'drop')
            return
          }
        }
      }
    })
  }

  #pushEvent(ws: WebSocket, e: FakeEvent): void {
    // One frame per stream, like the real relay (a single event can be in feed and needs_action).
    const streams: string[] = (e.streams as string[] | undefined) ?? ['feed']
    for (const t of streams) {
      ws.send(
        JSON.stringify({
          t,
          seq: e.seq,
          town_id: this.townId,
          at: '2026-10-19T00:00:00Z',
          event: e.event
        })
      )
    }
  }
}

function seqOfEnv(e: Record<string, unknown>): number {
  return (e.relay as { delivery: { inbox_seq: number } }).delivery.inbox_seq as number
}
