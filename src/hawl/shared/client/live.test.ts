import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSocket, type Credentials, HawlClient, startDeviceSignIn, type TokenSource } from './index'
import { FakeRelay } from './fake-relay'

let relay: FakeRelay
let cred: Credentials
const stoppers: (() => void)[] = []

beforeEach(async () => {
  relay = await new FakeRelay().start()
  const s = await startDeviceSignIn({ site: 'aarons-site', relayUrl: relay.url, sleep: async () => {}, pollMs: 1 })
  cred = await s.wait()
})
afterEach(async () => {
  for (const s of stoppers.splice(0)) s()
  await relay.stop()
})

const env = (seq: number): Record<string, unknown> => ({ relay: { message_id: `msg_${seq}`, delivery: { inbox_seq: seq } } })

function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn()
      if (v) return resolve(v as T)
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting: ${fn.toString()}`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function sock(o: Partial<ConstructorParameters<typeof AgentSocket>[0]> = {}): AgentSocket {
  const s = new AgentSocket({ credentials: cred, reconnectMs: { min: 10, max: 40 }, random: () => 0, ...o })
  stoppers.push(() => s.stop())
  return s
}

describe('agent socket', () => {
  it('does the signed handshake and reaches connected', async () => {
    const s = sock()
    const ready = new Promise<{ resident_id: string }>((r) => s.on('ready', r))
    s.start()
    expect((await ready).resident_id).toBe(cred.residentId)
    expect(s.state).toBe('connected')
    expect(relay.handshakes).toBe(1)
  })

  it('a wrong key never gets past the handshake', async () => {
    const other = await (await startDeviceSignIn({ site: 'aarons-site', relayUrl: relay.url, sleep: async () => {}, pollMs: 1 })).wait()
    // Right worker id and kid, someone else's private key.
    const s = sock({ credentials: { ...cred, privateJwk: other.privateJwk } })
    const states: string[] = []
    s.on('state', (x) => states.push(x))
    s.start()
    await until(() => states.filter((x) => x === 'connecting').length >= 3)
    expect(states).not.toContain('connected')
    expect(relay.handshakes).toBe(0)
  })

  it('delivers each message once, in order, and tracks the last seq', async () => {
    relay.inbox.push(env(1), env(2))
    const got: number[] = []
    const s = sock()
    s.on('deliver', (e) => got.push((e.relay as { delivery: { inbox_seq: number } }).delivery.inbox_seq))
    s.start()
    await until(() => got.length === 2)
    relay.pushDeliver(env(3))
    await until(() => got.length === 3)
    expect(got).toEqual([1, 2, 3])
    expect(s.lastSeq).toBe(3)
  })

  it('after a drop it reconnects and asks for the missed messages, with no duplicates', async () => {
    const got: number[] = []
    const s = sock()
    s.on('deliver', (e) => got.push((e.relay as { delivery: { inbox_seq: number } }).delivery.inbox_seq))
    s.start()
    await until(() => s.state === 'connected')
    relay.pushDeliver(env(1))
    await until(() => got.length === 1)
    relay.dropAgents(1006)
    // Mail that arrives while the app is offline.
    relay.inbox.push(env(2), env(3))
    await until(() => relay.handshakes === 2 && s.state === 'connected')
    await until(() => got.length === 3)
    // The relay re-pushed 1..3 on ready and answered inbox.fetch(after 1) too: each handed over once.
    expect(got).toEqual([1, 2, 3])
  })

  it('a replaced session stops and does not fight for the socket', async () => {
    const s = sock()
    s.start()
    await until(() => s.state === 'connected')
    relay.dropAgents(4409)
    await until(() => s.state === 'replaced')
    await new Promise((r) => setTimeout(r, 150))
    expect(relay.handshakes).toBe(1)
  })

  it('retries after a refused handshake (4401) with the long wait', async () => {
    const s = sock()
    s.start()
    await until(() => s.state === 'connected')
    relay.dropAgents(4401)
    await until(() => relay.handshakes === 2, 3000)
  })

  it('stop() ends it for good', async () => {
    const s = sock()
    s.start()
    await until(() => s.state === 'connected')
    s.stop()
    expect(s.state).toBe('stopped')
    await new Promise((r) => setTimeout(r, 100))
    expect(relay.handshakes).toBe(1)
  })

  it('tool calls over the socket resolve and reject with the relay error', async () => {
    const s = sock()
    s.start()
    await until(() => s.state === 'connected')
    expect(await s.tool('who')).toEqual({ workers: [] })
    await expect(s.tool('nope')).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('tool calls fail fast while disconnected', async () => {
    const s = sock()
    await expect(s.tool('who')).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('client.socket() wires the same credentials', async () => {
    const s = new HawlClient({ credentials: cred }).socket({ reconnectMs: { min: 10, max: 40 } })
    stoppers.push(() => s.stop())
    s.start()
    await until(() => s.state === 'connected')
  })
})

const user = (): TokenSource & { invalidated: number } => ({
  invalidated: 0,
  token: async () => relay.userToken,
  invalidate() {
    this.invalidated++
  }
})

function ev(seq: number, streams?: string[]) {
  return { seq, event: `e${seq}`, ...(streams ? { streams } : {}) }
}

describe('town events', () => {
  const mk = (u: TokenSource = user(), o: { socketOnly?: boolean } = {}) => {
    const c = new HawlClient({ credentials: cred, user: u, webOrigin: relay.webOrigin })
    const s = c.townEvents(relay.townId, o)
    stoppers.push(() => s.stop())
    return s
  }

  it('replays history by pages, then goes live without repeating the last page', async () => {
    for (let i = 1; i <= 5; i++) relay.events.push(ev(i))
    const s = mk()
    const seqs: number[] = []
    const streams: (string | undefined)[] = []
    s.on('event', (e) => {
      seqs.push(e.seq)
      streams.push(e.stream)
    })
    await s.start()
    await until(() => s.state === 'live')
    expect(seqs).toEqual([1, 2, 3, 4, 5])
    expect(streams.every((x) => x === undefined)).toBe(true)
    // All five came from REST (no `stream` field), none repeated by the socket.
    expect(relay.requests.filter((r) => r.path.includes('/events')).length).toBe(4) // 2+2+1 events, then an empty page
    relay.addEvent(ev(6))
    await until(() => seqs.length === 6)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('sends the web origin and the user token on the console socket', async () => {
    const s = mk()
    await s.start()
    await until(() => s.state === 'live')
    expect(relay.consoleOrigins).toEqual([relay.webOrigin])
  })

  it('names the stream on socket frames and keeps both frames of a two-stream event', async () => {
    const s = mk(user(), { socketOnly: true })
    const got: { seq: number; stream?: string }[] = []
    s.on('event', (e) => got.push({ seq: e.seq, ...(e.stream ? { stream: e.stream } : {}) }))
    await s.start()
    await until(() => s.state === 'live')
    relay.addEvent(ev(1, ['feed', 'needs_action']))
    await until(() => got.length === 2)
    expect(got).toEqual([
      { seq: 1, stream: 'feed' },
      { seq: 1, stream: 'needs_action' }
    ])
  })

  it('resumes after the socket drops: no gap, no duplicate', async () => {
    const s = mk(user(), { socketOnly: true })
    const got: string[] = []
    s.on('event', (e) => got.push(`${e.stream}:${e.seq}`))
    // Three two-stream events waiting; the relay cuts the socket after 3 frames (mid-event 2).
    for (let i = 1; i <= 3; i++) relay.events.push(ev(i, ['feed', 'needs_action']))
    relay.consoleDropAfter = 3
    await s.start()
    await until(() => got.length >= 6, 8000)
    expect(got.sort()).toEqual(['feed:1', 'feed:2', 'feed:3', 'needs_action:1', 'needs_action:2', 'needs_action:3'])
  })

  it('a 4401 close asks the token source for a fresh token', async () => {
    const u = user()
    const s = mk(u, { socketOnly: true })
    await s.start()
    await until(() => s.state === 'live')
    for (const w of relay.consoleConns) w.close(4401, 'expired')
    await until(() => u.invalidated === 1)
    await until(() => relay.consoleConns.length === 1 && s.state === 'live')
  })

  it('stop() closes the socket and does not reconnect', async () => {
    const s = mk()
    await s.start()
    await until(() => s.state === 'live')
    s.stop()
    await new Promise((r) => setTimeout(r, 100))
    expect(relay.consoleOrigins.length).toBe(1)
  })

  it('a failed REST page is reported and the socket still replays from the cursor', async () => {
    for (let i = 1; i <= 3; i++) relay.events.push(ev(i))
    relay.failNext(/\/events$/, 500, 5)
    const s = mk()
    const errs: Error[] = []
    const seqs: number[] = []
    s.on('error', (e) => errs.push(e))
    s.on('event', (e) => seqs.push(e.seq))
    await s.start()
    await until(() => seqs.length === 3)
    expect(errs.length).toBe(1)
    expect(seqs).toEqual([1, 2, 3])
  })
})
