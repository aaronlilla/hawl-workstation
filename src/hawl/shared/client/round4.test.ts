// Round 4: failures that must not lose work, plus the success paths that had no test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  AgentSocket,
  type Credentials,
  HawlApiError,
  HawlClient,
  Http,
  senderKeyFetcher,
  startDeviceSignIn,
  type TokenSource,
  TownEventStream,
  wsUrlFor
} from './index'
import { FakeRelay } from './fake-relay'
import { makeSender, TrustFixture, type SenderKey } from './trust-fixture'

let relay: FakeRelay
let cred: Credentials
let fx: TrustFixture
let sender: SenderKey
const stoppers: (() => void)[] = []
const user: TokenSource = { token: async () => 'user-jwt-1', invalidate() {} }

beforeEach(async () => {
  relay = await new FakeRelay().start()
  fx = new TrustFixture()
  relay.trust = fx
  sender = makeSender('key_sender1')
  relay.senderKeys.set(sender.kid, { public_jwk: sender.jwk })
  cred = await (
    await startDeviceSignIn({ site: 'aarons-site', relayUrl: relay.url, sleep: async () => {}, pollMs: 1 })
  ).wait()
})
afterEach(async () => {
  for (const s of stoppers.splice(0)) {
    s()
  }
  await relay.stop()
})

function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn()
      if (v) {
        return resolve(v as T)
      }
      if (Date.now() - t0 > ms) {
        return reject(new Error(`timed out waiting: ${fn.toString()}`))
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

const mkClient = () =>
  new HawlClient({ credentials: cred, user, trust: { roots: fx.roots, minRefreshGapMs: 0 }, fetch })

describe('a passing sender-key failure does not lose the delivery', () => {
  it('asks the relay again and hands it over once the key lookup works', async () => {
    relay.inbox.push(fx.envelope({ seq: 1, recipient: cred.residentId, sender }))
    relay.failNext(/\/v1\/keys\//, 503, 6)
    const s = mkClient().socket({ reconnectMs: { min: 10, max: 40 }, random: () => 0, retryDeliveryMs: 20 })
    stoppers.push(() => s.stop())
    const got: unknown[] = []
    const dropped: string[] = []
    s.on('deliver', (e) => got.push(e))
    s.on('dropped', (d) => dropped.push(d.reason))
    s.start()
    await until(() => got.length === 1, 8000)
    expect(dropped.length).toBeGreaterThan(0)
    expect(new Set(dropped)).toEqual(new Set(['sender_key_unavailable']))
    expect(got).toHaveLength(1)
  })

  it('a 404 for the key is still a permanent sender_sig drop and is not retried', async () => {
    relay.inbox.push(fx.envelope({ seq: 1, recipient: cred.residentId, sender: makeSender('key_nobody') }))
    const s = mkClient().socket({ reconnectMs: { min: 10, max: 40 }, random: () => 0, retryDeliveryMs: 20 })
    stoppers.push(() => s.stop())
    const dropped: string[] = []
    s.on('dropped', (d) => dropped.push(d.reason))
    s.start()
    await until(() => dropped.length >= 1)
    await new Promise((r) => setTimeout(r, 150))
    expect(dropped).toEqual(['sender_sig'])
  })

  it('the fetcher throws on a 5xx, answers null on a 404, and refetches after the ttl', async () => {
    let now = 0
    let calls = 0
    let mode: 'ok' | 'boom' | 'missing' | 'compromised' = 'ok'
    const get = async () => {
      calls++
      if (mode === 'boom') {
        throw new HawlApiError(503, 'unavailable', 'x')
      }
      if (mode === 'missing') {
        throw new HawlApiError(404, 'not_found', 'x')
      }
      return { public_jwk: sender.jwk, compromised_at: mode === 'compromised' ? new Date(1000).toISOString() : null }
    }
    const f = senderKeyFetcher(get, { ttlMs: 1000, now: () => now })
    const at = new Date(5000).toISOString()
    expect(await f('k1', at)).not.toBeNull()
    expect(await f('k1', at)).not.toBeNull()
    expect(calls).toBe(1)
    now = 2000
    mode = 'compromised'
    expect(await f('k1', at)).toBeNull() // marked compromised after the first fetch: seen after the ttl
    expect(calls).toBe(2)
    mode = 'boom'
    now = 4000
    await expect(f('k1', at)).rejects.toMatchObject({ name: 'SenderKeyUnavailable' })
    mode = 'missing'
    expect(await f('k2', at)).toBeNull()
  })
})

describe('frames are not lost or repeated quietly', () => {
  it('a delivery without a seq is handed over once even if the relay pushes it again', async () => {
    const s = new AgentSocket({
      credentials: cred,
      insecureNoVerify: true,
      reconnectMs: { min: 10, max: 40 },
      random: () => 0
    })
    stoppers.push(() => s.stop())
    const got: unknown[] = []
    s.on('deliver', (e) => got.push(e))
    s.start()
    await until(() => s.state === 'connected')
    const e = fx.envelope({ seq: 1, recipient: cred.residentId, sender }) as {
      relay: { delivery: Record<string, unknown> }
    }
    delete e.relay.delivery.inbox_seq
    relay.pushDeliver(e)
    relay.pushDeliver(e)
    await new Promise((r) => setTimeout(r, 100))
    expect(got).toHaveLength(1)
  })

  it('too many frames while the relay is verified close the socket with an error, not a silent drop', async () => {
    const errors: string[] = []
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.on('listening', r))
    stoppers.push(() => wss.close())
    const port = (wss.address() as { port: number }).port
    let closedCode = 0
    wss.on('connection', (ws) => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          nonce: 'n'.repeat(43),
          server_time: new Date().toISOString(),
          relay_kid: 'rk_test',
          protocol: 1
        })
      )
      ws.on('message', () => {
        ws.send(
          JSON.stringify({ t: 'ready', session_id: 's', resident_id: cred.residentId, pending: 0, heartbeat_s: 25, relay_sig: 'x' })
        )
        for (let i = 0; i < 2100; i++) {
          ws.send(JSON.stringify({ t: 'notice', unread: i, needs_action: 0 }))
        }
      })
      ws.on('close', (c) => (closedCode = c))
    })
    const s = new AgentSocket({
      credentials: { ...cred, relayUrl: `http://127.0.0.1:${port}` },
      verifyReady: () => new Promise((r) => setTimeout(() => r(true), 400)),
      insecureNoVerify: true,
      reconnectMs: { min: 5000, max: 5000 },
      random: () => 0
    })
    stoppers.push(() => s.stop())
    s.on('error', (e) => errors.push((e as { code?: string }).code ?? e.message))
    s.start()
    await until(() => errors.includes('handshake_overflow'))
    await until(() => closedCode !== 0)
    expect(closedCode).toBe(1013)
    expect(s.state).not.toBe('connected')
  })
})

describe('town events', () => {
  it('a relay error frame on the console socket with no error listener does not throw', async () => {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.on('listening', r))
    stoppers.push(() => wss.close())
    wss.on('connection', (ws) =>
      ws.on('message', () => ws.send(JSON.stringify({ t: 'error', error: { code: 'boom', message: 'boom' } })))
    )
    const seen: unknown[] = []
    const on = (e: unknown) => seen.push(e)
    process.on('uncaughtException', on)
    try {
      const http = new Http({ baseUrl: relay.url, user, fetch })
      const st = new TownEventStream({
        relayUrl: `http://127.0.0.1:${(wss.address() as { port: number }).port}`,
        townId: 'twn_x',
        user,
        http,
        socketOnly: true,
        reconnectMs: { min: 5000, max: 5000 }
      })
      stoppers.push(() => st.stop())
      await st.start()
      await new Promise((r) => setTimeout(r, 200))
      expect(seen).toEqual([])
    } finally {
      process.off('uncaughtException', on)
    }
  })

  it('a manual replay with the socket live does not emit an event twice', async () => {
    relay.addEvent({ seq: 1, event: 'a' })
    const http = new Http({ baseUrl: relay.url, user, fetch })
    const st = new TownEventStream({ relayUrl: relay.url, townId: relay.townId, user, http, settleMs: 20, origin: relay.webOrigin })
    stoppers.push(() => st.stop())
    const got: number[] = []
    st.on('event', (e) => got.push(e.seq))
    await st.start()
    await until(() => st.state === 'live')
    // The relay has event 2, the socket has not delivered it yet: replay takes it first.
    relay.events.push({ seq: 2, event: 'b' })
    await st.replay()
    for (const w of relay.consoleConns) {
      w.send(JSON.stringify({ t: 'feed', seq: 2, town_id: relay.townId, at: 'x', event: 'b' }))
    }
    await new Promise((r) => setTimeout(r, 150))
    expect(got).toEqual([1, 2])
  })
})

describe('transport', () => {
  it('a non-JSON 200 is a HawlApiError with a code', async () => {
    const http = new Http({
      baseUrl: 'https://relay.test',
      fetch: (async () => new Response('<html>captcha</html>', { status: 200 })) as typeof fetch,
      agent: user
    })
    await expect(http.get('/v1/me')).rejects.toMatchObject({ name: 'HawlApiError', code: 'bad_response' })
  })

  it('refuses plain http to a non-loopback relay, allows loopback', () => {
    expect(() => wsUrlFor('http://relay.example.com', '/v1/ws')).toThrow(/https/)
    expect(() => new Http({ baseUrl: 'http://relay.example.com' })).toThrow(/https/)
    expect(wsUrlFor('http://127.0.0.1:8080', '/v1/ws')).toBe('ws://127.0.0.1:8080/v1/ws')
    expect(wsUrlFor('https://relay.hawl.ai', '/v1/ws')).toBe('wss://relay.hawl.ai/v1/ws')
    expect(wsUrlFor('http://localhost:1', '/x')).toBe('ws://localhost:1/x')
    expect(wsUrlFor('http://[::1]:1', '/x')).toBe('ws://[::1]:1/x')
  })
})

describe('success paths', () => {
  it('channels.thread, discussHandoff, limits.resume, handoffs.send auto', async () => {
    const c = mkClient()
    const t = relay.townId
    expect(await c.channels.thread(t, 'chn_1', 'msg_1')).toMatchObject({ root: { message_id: 'msg_1' } })
    expect(await c.channels.discussHandoff(t, 'hnd_1')).toMatchObject({ channel_id: 'chn_1', created: true })
    expect(await c.site.limits.resume(t, 'hnd_1')).toEqual({ resumed: true })
    expect(await c.handoffs.send(t, { to: 'auto', spec: 'do it' })).toMatchObject({
      handoff_id: 'hnd_9',
      routed: true,
      assignee: 'res_picked'
    })
  })

  it('approvals.list says when the relay page is full', async () => {
    const c = mkClient()
    relay.approvalCount = 3
    const a = await c.approvals.list(relay.townId)
    expect(a.truncated).toBe(false)
    expect(a.items).toHaveLength(3)
    relay.approvalCount = 100
    expect((await c.approvals.list(relay.townId)).truncated).toBe(true)
  })
})
