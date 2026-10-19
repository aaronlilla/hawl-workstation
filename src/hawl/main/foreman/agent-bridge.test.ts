// The agent door against a real loopback server: auth, the whole job from offer to done, and presence.
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBridge } from './agent-bridge'
import { AgentHub } from './agent-hub'
import type { AgentEvent } from './agent-hub'
import { Foreman } from './foreman'
import { CAPS, MINUTE_MS, SHA, T0 } from './rig.test-support'
import { ForemanRuntime } from './runtime'
import { memoryStorage } from './runtime.test-support'
import type { LifecycleEvent } from '../../shared/gateway-contract/contract'

const open: AgentBridge[] = []
afterEach(async () => {
  for (const b of open.splice(0)) {
    await b.close()
  }
})

async function start(presenceMs = 45_000) {
  let t = T0
  const sent: LifecycleEvent[] = []
  const seen: AgentEvent[] = []
  const hub = new AgentHub({ onEvent: (e) => seen.push(e) })
  const foreman = new Foreman(
    { yard: 'acme-dev', owner: 'usr_aaron', displayName: 'Yard' },
    {
      clock: { now: () => t },
      transport: {
        sendMenu: () => undefined,
        sendHeartbeat: () => undefined,
        sendLifecycle: (ev) => {
          sent.push(ev)
        },
        notifyOwner: () => undefined,
        notifyRequester: () => undefined,
        handBack: () => undefined
      },
      agents: hub.port
    }
  )
  const rt = new ForemanRuntime({
    foreman,
    clock: { now: () => t },
    storage: memoryStorage().api,
    scheduler: { set: () => 0, clear: () => undefined }
  })
  rt.start()
  rt.run((f) => {
    f.setCapabilities(CAPS)
    f.publishMenu()
  })
  const bridge = new AgentBridge({ rt, hub, presenceMs, now: () => t })
  open.push(bridge)
  const port = await bridge.listen(0)
  const base = `http://127.0.0.1:${port}`
  const call = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
    return { status: r.status, json: (await r.json()) as Record<string, unknown> }
  }
  const events = async (agentId: string, after = 0, wait = 0) => {
    const r = await fetch(`${base}/v1/events?agentId=${agentId}&after=${after}&wait=${wait}`, {
      headers: { authorization: `Bearer ${bridge.token}` }
    })
    return { status: r.status, json: (await r.json()) as { events: AgentEvent[]; seq: number } }
  }
  const offer = (id: string) =>
    rt.run((f) =>
      f.intake({
        offer: {
          yard: 'acme-dev',
          task_id: id,
          event: 'offer',
          at: new Date(t).toISOString(),
          capability: 'fix-bug',
          acceptance: ['tests pass']
        },
        requester: 'site'
      })
    )
  return {
    rt,
    foreman,
    bridge,
    base,
    call,
    events,
    offer,
    sent,
    seen,
    adv: (ms: number) => {
      t += ms
      foreman.tick()
    }
  }
}

describe('S16 the door is for local agents with the token only', () => {
  it('S16: no token, a wrong token, a foreign host name and a non-JSON body are all refused', async () => {
    const s = await start()
    const url = `${s.base}/v1/up`
    const body = JSON.stringify({ agentId: 'a1' })
    const post = (headers: Record<string, string>) => fetch(url, { method: 'POST', headers, body })
    expect((await post({ 'content-type': 'application/json' })).status).toBe(401)
    expect((await post({ 'content-type': 'application/json', authorization: 'Bearer nope' })).status).toBe(401)
    // fetch cannot set Host, so use a raw request: a name pointed at 127.0.0.1 must not get in.
    const status = await new Promise<number>((ok, fail) => {
      const r = httpRequest(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${s.bridge.token}`,
            host: 'evil.example'
          }
        },
        (res) => ok(res.statusCode ?? 0)
      )
      r.on('error', fail)
      r.end(body)
    })
    expect(status).toBe(401)
    expect((await post({ 'content-type': 'text/plain', authorization: `Bearer ${s.bridge.token}` })).status).toBe(415)
    expect((await fetch(url, { headers: { authorization: `Bearer ${s.bridge.token}` } })).status).toBe(405)
    expect((await s.call('/v1/nope')).status).toBe(404)
    expect((await s.call('/v1/up', { agentId: 'a1' })).status).toBe(200)
    expect(s.foreman.agents().map((a) => a.id)).toEqual(['a1'])
  })

  it('S16: a body that is too big or not an object is refused', async () => {
    const s = await start()
    const big = await fetch(`${s.base}/v1/up`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'a1', label: 'x'.repeat(70_000) })
    }).catch(() => ({ status: 413 }))
    expect(big.status).toBe(413)
    const arr = await fetch(`${s.base}/v1/up`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.bridge.token}`, 'content-type': 'application/json' },
      body: '[1]'
    })
    expect(arr.status).toBe(400)
  })
})

describe('S9/S16/S17 one agent takes a job from offer to done through the door', () => {
  it('S9: offer arrives as an event, accept starts the lease, renew and progress hold it, done goes to the Dispatcher', async () => {
    const s = await start()
    await s.call('/v1/up', { agentId: 'term_1', label: 'Terminal 1' })
    expect(s.offer('hnd_1').outcome).toBe('accepted')
    const got = await s.events('term_1')
    expect(got.json.events).toMatchObject([
      { type: 'offer', agentId: 'term_1', taskId: 'hnd_1', epoch: 1, capability: 'fix-bug', acceptance: ['tests pass'] }
    ])
    // The same event reached the app's terminal strip.
    expect(s.seen).toMatchObject([{ type: 'offer', taskId: 'hnd_1' }])
    const acc = await s.call('/v1/accept', { agentId: 'term_1', taskId: 'hnd_1', epoch: 1 })
    expect(acc).toMatchObject({ status: 200, json: { duplicate: false } })
    expect(s.foreman.jobView('hnd_1')).toMatchObject({ exec: 'running', holder: 'term_1' })
    // The same accept again is a no-op (S21).
    expect((await s.call('/v1/accept', { agentId: 'term_1', taskId: 'hnd_1', epoch: 1 })).json).toMatchObject({ duplicate: true })
    s.adv(20 * MINUTE_MS)
    expect((await s.call('/v1/renew', { agentId: 'term_1', taskId: 'hnd_1', epoch: 1 })).status).toBe(200)
    s.adv(20 * MINUTE_MS)
    expect((await s.call('/v1/progress', { agentId: 'term_1', taskId: 'hnd_1', epoch: 1, note: 'tests running' })).status).toBe(200)
    const card = await s.call('/v1/card/start', { agentId: 'term_1', title: 'Fix the login bug', jobId: 'hnd_1' })
    expect(card.status).toBe(200)
    expect((await s.call('/v1/card/update', { cardId: card.json.id, state: 'done' })).status).toBe(200)
    const done = await s.call('/v1/done', {
      agentId: 'term_1',
      taskId: 'hnd_1',
      epoch: 1,
      revisionSha: SHA,
      evidence: [{ kind: 'sha', ref: SHA }]
    })
    expect(done.status).toBe(200)
    expect(s.sent.map((e) => e.event)).toEqual(['accept', 'progress', 'done'])
    expect(s.foreman.jobView('hnd_1').state).toBe('done')
  })

  it('S17: a lease that lapses sends the agent a revoke event, and its late done is refused with 409', async () => {
    const s = await start()
    await s.call('/v1/up', { agentId: 'term_1' })
    s.offer('hnd_1')
    await s.call('/v1/accept', { agentId: 'term_1', taskId: 'hnd_1', epoch: 1 })
    s.adv(31 * MINUTE_MS)
    const got = await s.events('term_1', 1)
    expect(got.json.events).toMatchObject([{ type: 'revoke', taskId: 'hnd_1', epoch: 1, reason: 'lease_lapsed' }])
    const late = await s.call('/v1/done', {
      agentId: 'term_1',
      taskId: 'hnd_1',
      epoch: 1,
      revisionSha: SHA,
      evidence: [{ kind: 'sha', ref: SHA }]
    })
    expect(late).toMatchObject({ status: 409, json: { error: 'claim_revoked' } })
  })

  it('S16: an unknown task is 404; a bad epoch or missing agent id is 400 and changes nothing', async () => {
    const s = await start()
    expect((await s.call('/v1/accept', { agentId: 'a1', taskId: 'nope', epoch: 1 })).status).toBe(404)
    expect((await s.call('/v1/accept', { agentId: 'a1', taskId: 'x', epoch: 0 })).status).toBe(400)
    expect((await s.call('/v1/accept', { taskId: 'x', epoch: 1 })).status).toBe(400)
    expect((await s.call('/v1/up', { agentId: 'a1', capacity: 99 })).status).toBe(400)
    expect((await s.call('/v1/done', { agentId: 'a1', taskId: 'x', epoch: 1, revisionSha: SHA, evidence: [] })).status).toBe(400)
    expect(s.foreman.agents()).toEqual([])
  })

  it('S16: a long poll waits for the offer and returns the moment it arrives', async () => {
    const s = await start()
    await s.call('/v1/up', { agentId: 'term_1' })
    const waiting = s.events('term_1', 0, 5)
    await new Promise((r) => setTimeout(r, 50))
    s.offer('hnd_1')
    const got = await waiting
    expect(got.json.events).toMatchObject([{ type: 'offer', taskId: 'hnd_1' }])
  })

  it('S16: a poll with nothing new returns empty after the wait, and a late agent still gets what it missed', async () => {
    const s = await start()
    await s.call('/v1/up', { agentId: 'term_1' })
    const t0 = Date.now()
    const none = await s.events('term_1', 0, 1)
    expect(none.json.events).toEqual([])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    s.offer('hnd_1')
    const later = await s.events('term_1', 0, 0)
    expect(later.json.events).toHaveLength(1)
    const after = await s.events('term_1', later.json.seq, 0)
    expect(after.json.events).toEqual([])
  })
})

describe('S16/S17 an agent that goes quiet is down', () => {
  it('S16: no call for the presence time marks it down, and an offer it was sitting on moves to the next agent', async () => {
    const s = await start(60_000)
    await s.call('/v1/up', { agentId: 'term_1' })
    await s.call('/v1/up', { agentId: 'term_2' })
    s.offer('hnd_1')
    expect(s.foreman.jobView('hnd_1').claim?.agentId).toBe('term_1')
    s.adv(30_000)
    // term_2 keeps polling; term_1 does not.
    await s.events('term_2', 0, 0)
    s.adv(40_000)
    await s.events('term_2', 0, 0)
    s.bridge.sweep()
    expect(s.foreman.agents().find((a) => a.id === 'term_1')?.online).toBe(false)
    expect(s.foreman.agents().find((a) => a.id === 'term_2')?.online).toBe(true)
    expect(s.foreman.jobView('hnd_1').claim?.agentId).toBe('term_2')
  })

  it('S17: a running agent that goes quiet loses the claim after the presence time and the 2 minute grace', async () => {
    const s = await start(60_000)
    await s.call('/v1/up', { agentId: 'term_1' })
    await s.call('/v1/up', { agentId: 'term_2' })
    s.offer('hnd_1')
    await s.call('/v1/accept', { agentId: 'term_1', taskId: 'hnd_1', epoch: 1 })
    s.adv(61_000)
    await s.events('term_2', 0, 0)
    s.bridge.sweep()
    expect(s.foreman.jobView('hnd_1')).toMatchObject({ exec: 'running', holder: 'term_1' })
    s.adv(2 * MINUTE_MS + 1000)
    expect(s.foreman.jobView('hnd_1').claim?.agentId).toBe('term_2')
  })

  it('S16: saying down, or coming back with up, is honoured at once', async () => {
    const s = await start()
    await s.call('/v1/up', { agentId: 'term_1' })
    await s.call('/v1/down', { agentId: 'term_1' })
    expect(s.foreman.agents()[0].online).toBe(false)
    await s.call('/v1/up', { agentId: 'term_1' })
    expect(s.foreman.agents()[0].online).toBe(true)
    await s.call('/v1/away', { agentId: 'term_1', away: true })
    expect(s.foreman.agents()[0].away).toBe(true)
    expect((await s.call('/v1/away', { agentId: 'term_1', away: 'yes' })).status).toBe(400)
  })
})
