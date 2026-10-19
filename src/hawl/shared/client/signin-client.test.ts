import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPublicKey, verify } from 'node:crypto'
import {
  AgentTokenSource,
  clientAssertion,
  type Credentials,
  generateWorkerKey,
  HawlApiError,
  HawlClient,
  jcs,
  MemoryCredentialStore,
  startDeviceSignIn,
  type TokenSource
} from './index'
import { FakeRelay } from './fake-relay'

let relay: FakeRelay
beforeEach(async () => {
  relay = await new FakeRelay().start()
})
afterEach(async () => {
  await relay.stop()
})

const noSleep = async () => {}

async function signIn(): Promise<Credentials> {
  const s = await startDeviceSignIn({ site: 'aarons-site', relayUrl: relay.url, sleep: noSleep, pollMs: 1 })
  return s.wait()
}

const userSource = (token = relay.userToken): TokenSource & { invalidated: number } => ({
  invalidated: 0,
  token: async () => token,
  invalidate() {
    this.invalidated++
  }
})

describe('core', () => {
  it('canonical JSON sorts keys, drops undefined, keeps arrays in order', () => {
    expect(jcs({ b: 1, a: [3, 2, { z: null, y: 'x' }], u: undefined })).toBe('{"a":[3,2,{"y":"x","z":null}],"b":1}')
  })

  it('client assertion is a 60 s EdDSA JWT that verifies with the public key', () => {
    const k = generateWorkerKey()
    const jwt = clientAssertion('res_X', 'key_Y', k.privateJwk, 'https://relay.test', new Date(1_800_000_000_000))
    const [h, p, s] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'key_Y' })
    const c = JSON.parse(Buffer.from(p, 'base64url').toString())
    expect(c).toMatchObject({ iss: 'res_X', sub: 'res_X', aud: 'https://relay.test', iat: 1_800_000_000, exp: 1_800_000_060 })
    expect(verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: k.publicJwk, format: 'jwk' }), Buffer.from(s, 'base64url'))).toBe(true)
  })

  it('memory store round-trips and clears', async () => {
    const st = new MemoryCredentialStore()
    expect(await st.load()).toBeNull()
    const c = { relayUrl: 'u', residentId: 'r', kid: 'k', townId: 't', townSlug: 's', privateJwk: {} }
    await st.save(c)
    expect(await st.load()).toEqual(c)
    await st.clear()
    expect(await st.load()).toBeNull()
  })
})

describe('device-code sign-in', () => {
  it('gets a code, polls while pending, then returns credentials the relay accepts', async () => {
    relay.approveAfterPolls = 3
    let sleeps = 0
    const s = await startDeviceSignIn({
      site: 'aarons-site',
      relayUrl: relay.url,
      sleep: async () => {
        sleeps++
      }
    })
    expect(s.userCode).toBe('ABCD-EFGH')
    expect(s.verificationUri).toBe('https://hawl.ai/device')
    const cred = await s.wait()
    expect(sleeps).toBe(3)
    expect(cred.residentId).toMatch(/^res_/)
    expect(cred.townSlug).toBe('aarons-site')
    expect(cred.relayUrl).toBe(relay.url)
    expect(cred.privateJwk.d).toBeTruthy()
    // The credentials work: exchange an assertion and read /v1/me.
    const me = await new HawlClient({ credentials: cred }).me()
    expect(me.resident_id).toBe(cred.residentId)
    expect(me.platform).toBe('hawl_workstation')
  })

  it('start sends only the public key, never the private one', async () => {
    await signIn()
    const start = relay.requests.find((r) => r.path === '/v1/join/start')
    expect(JSON.stringify(start?.body)).not.toContain('"d"')
    expect((start?.body as { platform: string }).platform).toBe('hawl_workstation')
  })

  it('an expired or refused code throws code_expired instead of polling forever', async () => {
    const s = await startDeviceSignIn({ site: 'aarons-site', relayUrl: relay.url, sleep: noSleep, pollMs: 1 })
    relay.joins.clear()
    await expect(s.wait()).rejects.toMatchObject({ code: 'code_expired', status: 404 })
  })

  it('keeps polling through relay 503s and network blips', async () => {
    relay.failNext(/\/claim$/, 503, 2)
    const cred = await signIn()
    expect(cred.residentId).toMatch(/^res_/)
  })

  it('stops at the deadline', async () => {
    relay.approveAfterPolls = 1_000_000
    let t = 0
    const s = await startDeviceSignIn({ site: 'aarons-site', relayUrl: relay.url, sleep: async () => { t += 400_000 }, now: () => t, pollMs: 1 })
    await expect(s.wait()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('can be cancelled', async () => {
    relay.approveAfterPolls = 1_000_000
    const ac = new AbortController()
    const s = await startDeviceSignIn({ site: 'aarons-site', relayUrl: relay.url, sleep: async () => ac.abort(), pollMs: 1 })
    await expect(s.wait({ signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('a site the relay does not know is a plain error', async () => {
    relay.failNext(/join\/start/, 404)
    await expect(startDeviceSignIn({ site: 'nope', relayUrl: relay.url })).rejects.toBeInstanceOf(HawlApiError)
  })
})

describe('http and tokens', () => {
  it('exchanges one assertion and reuses the token', async () => {
    const c = new HawlClient({ credentials: await signIn() })
    await c.me()
    await c.me()
    await c.workers.who()
    expect(relay.tokenCount).toBe(1)
  })

  it('concurrent first calls share one exchange', async () => {
    const c = new HawlClient({ credentials: await signIn() })
    await Promise.all([c.me(), c.me(), c.me(), c.workers.who()])
    expect(relay.tokenCount).toBe(1)
  })

  it('renews before expiry', async () => {
    relay.tokenTtlS = 20 // under the 30 s early-renew margin: every call asks again
    const c = new HawlClient({ credentials: await signIn() })
    await c.me()
    await c.me()
    expect(relay.tokenCount).toBe(2)
  })

  it('a 401 drops the token, gets a new one and retries once', async () => {
    const c = new HawlClient({ credentials: await signIn() })
    await c.me()
    relay.tokens.clear() // relay forgot it (restart, epoch bump)
    const me = await c.me()
    expect(me.handle).toBe('workstation')
    expect(relay.tokenCount).toBe(2)
  })

  it('a worker the relay revoked fails with a 401 after one refresh, not a loop', async () => {
    const cred = await signIn()
    const c = new HawlClient({ credentials: cred })
    relay.workers.clear()
    await expect(c.me()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
    expect(relay.requests.filter((r) => r.path === '/v1/auth/token').length).toBe(1)
  })

  it('retries GET on 503 and honours Retry-After on 429', async () => {
    const waits: number[] = []
    const c = new HawlClient({ credentials: await signIn(), sleep: async (ms) => void waits.push(ms) })
    relay.failNext(/\/v1\/me$/, 503, 2)
    expect((await c.me()).handle).toBe('workstation')
    expect(waits).toEqual([250, 500])
    waits.length = 0
    relay.failNext(/\/v1\/channels$/, 429, 1, 3)
    await c.channels.list()
    expect(waits).toEqual([3000])
  })

  it('gives up after the retry budget with the relay error intact', async () => {
    const c = new HawlClient({ credentials: await signIn(), sleep: noSleep })
    relay.failNext(/\/v1\/me$/, 503, 10)
    await expect(c.me()).rejects.toMatchObject({ status: 503, code: 'unavailable' })
    expect(relay.requests.filter((r) => r.path === '/v1/me').length).toBe(3)
  })

  it('does not retry a POST', async () => {
    const c = new HawlClient({ credentials: await signIn(), sleep: noSleep })
    relay.failNext(/handoffs\/hnd_1\/act/, 503, 1)
    await expect(c.handoffs.accept('hnd_1')).rejects.toMatchObject({ status: 503 })
    expect(relay.requests.filter((r) => r.path.endsWith('/act')).length).toBe(1)
  })

  it('reports an unreachable relay as network_error', async () => {
    const cred = await signIn()
    const c = new HawlClient({ credentials: { ...cred, relayUrl: 'http://127.0.0.1:1' }, sleep: noSleep, maxRetries: 0 })
    await expect(c.me()).rejects.toMatchObject({ code: 'network_error' })
  })

  it('user-plane calls without a user source fail before the network', async () => {
    const c = new HawlClient({ credentials: await signIn() })
    const before = relay.requests.length
    await expect(c.approvals.list(relay.townId)).rejects.toMatchObject({ status: 401 })
    expect(relay.requests.length).toBe(before + 0)
    expect(() => c.townEvents(relay.townId)).toThrow(HawlApiError)
  })

  it('token source is usable on its own', async () => {
    const src = new AgentTokenSource(await signIn(), {})
    expect(await src.token()).toBe(await src.token())
    src.invalidate()
    expect(await src.token()).toMatch(/agent-tok-2/)
  })
})

describe('api surface', () => {
  let c: HawlClient
  beforeEach(async () => {
    c = new HawlClient({ credentials: await signIn(), user: userSource() })
  })

  it('workers, handoffs, board, channels', async () => {
    expect((await c.workers.who()).workers.length).toBe(2)
    expect((await c.workers.who('sam')).workers.length).toBe(1)
    expect((await c.handoffs.list({ mine: true })).handoffs[0]).toMatchObject({ handoff_id: 'hnd_1' })
    expect(await c.handoffs.get('hnd_1')).toMatchObject({ state: 'accepted' })
    const done = await c.handoffs.done('hnd_1', { pr_url: 'https://github.com/a/b/pull/1', note: 'ok' })
    expect(done).toMatchObject({ echo: { op: 'done', evidence: { note: 'ok' } } })
    expect((await c.board.read()).pins).toEqual([])
    expect((await c.channels.list()).items.map((i) => i.kind)).toEqual(['square', 'room'])
  })

  it('user plane: approvals list and approve carry the user token, not the worker token', async () => {
    expect((await c.approvals.list(relay.townId)).items[0]).toMatchObject({ approval_id: 'apr_1', state: 'pending' })
    expect(await c.approvals.approve('apr_1', 'looks right')).toMatchObject({ state: 'approved', note: 'looks right' })
    const hits = relay.requests.filter((r) => r.path.includes('approv'))
    expect(hits.every((h) => h.auth === `Bearer ${relay.userToken}`)).toBe(true)
  })

  it('a wrong user token is a 401 and asks the source to drop it once', async () => {
    const src = userSource('stale')
    const c2 = new HawlClient({ credentials: c.credentials, user: src })
    await expect(c2.approvals.list(relay.townId)).rejects.toMatchObject({ status: 401 })
    expect(src.invalidated).toBe(1)
  })

  it('handoff create signs the exact canonical bytes the relay verifies', async () => {
    const out = await c.send.handoff({
      to: 'sam',
      task_type: 'code',
      title: 'Fix login',
      spec: 'Make the login button work.',
      criteria: [{ id: 'c1', text: 'button works', check: 'manual' }],
      verifier: 'any_other_owner'
    })
    expect(out).toMatchObject({ message_id: 'msg_1' })
    const s = relay.signedSends[0]!
    expect(s.sigOk).toBe(true)
    expect(s.tool).toBe('handoff')
    expect(s.cr).toMatchObject({
      v: 1,
      sender_resident_id: c.credentials.residentId,
      kid: c.credentials.kid,
      intent: 'request_action',
      to: { kind: 'worker', resident_id: 'res_SAM' },
      conversation_id: null,
      content: {
        parts: [
          { kind: 'text', text: 'Make the login button work.' },
          { kind: 'data', data: { handoff: { title: 'Fix login', task_type: 'code', verifier: 'any_other_owner' } } }
        ]
      }
    })
    // The terms in the data part must not carry `spec` or `to`: the relay rebuilds them from the other args.
    const data = (s.cr.content as { parts: { data?: { handoff: Record<string, unknown> } }[] }).parts[1]!.data!.handoff
    expect(Object.keys(data).sort()).toEqual(['criteria', 'task_type', 'title', 'verifier'])
  })

  it('dm, square and room posts are signed too; an unknown worker or room is a 404', async () => {
    await c.send.dm('kit', 'ping', { intent: 'ask' })
    await c.send.square('hello', { mentions: ['sam'] })
    await c.send.room('#build', 'green', { data: { n: 1 } })
    expect(relay.signedSends.map((s) => s.sigOk)).toEqual([true, true, true])
    // Plain messages use POST /v1/messages with an Idempotency-Key equal to the signed one.
    expect(relay.signedSends.map((s) => s.tool)).toEqual(['message', 'message', 'message'])
    expect(relay.signedSends[0]!.cr).toMatchObject({ intent: 'ask', to: { kind: 'worker', resident_id: 'res_KIT' } })
    expect(relay.signedSends[1]!.cr.to).toEqual({ kind: 'channel', channel_id: 'chn_SQ', mentions: ['res_SAM'] })
    expect(relay.signedSends[2]!.cr.to).toEqual({ kind: 'channel', channel_id: 'chn_R1', mentions: [] })
    await expect(c.send.dm('ghost', 'x')).rejects.toMatchObject({ status: 404 })
    await expect(c.send.room('nope', 'x')).rejects.toMatchObject({ status: 404 })
  })

  it('each signed send gets its own idempotency key', async () => {
    await c.send.dm('kit', 'a')
    await c.send.dm('kit', 'a')
    const keys = relay.signedSends.map((s) => s.cr.idempotency_key)
    expect(new Set(keys).size).toBe(2)
  })

  it('files: upload declares size and hash, PUTs the bytes, download returns them', async () => {
    const bytes = new TextEncoder().encode('hello hawl')
    const up = await c.files.upload('note.txt', bytes, 'text/plain')
    const decl = relay.requests.find((r) => r.path === '/v1/files/uploads')!.body as { sha256: string; bytes: number; name: string }
    expect(decl).toMatchObject({ bytes: 10, name: 'note.txt' })
    expect(up.result.sha256).toBe(decl.sha256)
    expect(new TextDecoder().decode(await c.files.download('fil_1'))).toBe('hello hawl')
  })

  it('inbox list pages after a seq', async () => {
    relay.inbox.push(env(1), env(2), env(3))
    const r = await c.inbox.list(1)
    expect(r.items.map((i) => i.inbox_seq)).toEqual([2, 3])
  })
})

function env(seq: number): Record<string, unknown> {
  return { relay: { message_id: `msg_${seq}`, delivery: { inbox_seq: seq } } }
}
