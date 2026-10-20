// The relay link against a recording fake: routes, bodies, retry and refusal. Not a real relay (see the file header).
import { describe, expect, it } from 'vitest'
import { Foreman } from './foreman'
import { createRelayTransport, ROUTES } from './relay-transport'
import type { RelayHttpLike, RelayTarget } from './relay-transport'
import { CAPS, HOUR_MS, SHA, T0 } from './rig.test-support'
import type { OwnerNotice, RequesterNotice } from './types'

const TARGET: RelayTarget = { yardId: 'vil_yard1', siteId: 'twn_site1' }

type Call = { method: string; path: string; body?: unknown; plane?: string }

function fakeRelay(handler: (c: Call) => unknown = () => ({})) {
  const calls: Call[] = []
  const http: RelayHttpLike = {
    request: async (method, path, opts) => {
      const c: Call = { method, path, body: opts?.body, plane: opts?.plane }
      calls.push(c)
      return handler(c)
    }
  }
  return { http, calls }
}

const httpError = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { status })

function yard(handler?: (c: Call) => unknown, publish = true) {
  const relay = fakeRelay(
    handler ?? ((c) => (c.method === 'PUT' ? { revision: 1 } : {}))
  )
  const owner: OwnerNotice[] = []
  const requester: RequesterNotice[] = []
  let t = T0
  const f = new Foreman(
    { yard: 'acme-dev', owner: 'usr_aaron', displayName: "Aaron's yard" },
    {
      clock: { now: () => t },
      transport: createRelayTransport(relay.http, TARGET, {
        owner: (n) => {
          owner.push(n)
        },
        requester: (n) => {
          requester.push(n)
        }
      }),
      agents: { offer: () => undefined, revoke: () => undefined }
    }
  )
  f.setCapabilities(CAPS)
  if (publish) {
    f.publishMenu()
  }
  const settle = async (): Promise<void> => {
    // Let every promise the transport started finish (they are all already resolved or rejected).
    await new Promise((r) => setTimeout(r, 0))
  }
  return {
    f,
    relay,
    owner,
    requester,
    settle,
    adv: async (ms: number) => {
      t += ms
      f.tick()
      await settle()
    },
    offer: (id: string, extra = {}) => ({
      yard: 'acme-dev',
      task_id: id,
      event: 'offer' as const,
      at: new Date(t).toISOString(),
      capability: 'fix-bug',
      ...extra
    })
  }
}

describe('S48 the relay link sends the menu and heartbeat the way the contract says', () => {
  it('S48: the heartbeat goes to the agent route with the strict contract body', async () => {
    const y = yard(undefined, false)
    y.f.tick()
    await y.settle()
    expect(y.relay.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/agent/yard/heartbeat',
      plane: 'agent',
      body: { yard: 'acme-dev', state: 'offline' }
    })
  })

  it('S11: a published menu is written, then published with the revision the relay gave back', async () => {
    const y = yard((c) => (c.method === 'PUT' ? { revision: 7 } : {}), false)
    y.f.publishMenu()
    await y.settle()
    const calls = y.relay.calls.filter((c) => c.path.includes('/menu'))
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /v1/yards/vil_yard1/sites/twn_site1/menu',
      'POST /v1/yards/vil_yard1/sites/twn_site1/menu/publish'
    ])
    expect(calls[0].body).toMatchObject({ menu: { yard: 'acme-dev', hold_minutes: 240, release_minutes: 1440 } })
    expect(calls[0].body).not.toHaveProperty('if_revision')
    expect(calls[1].body).toEqual({ draft_revision: 7 })
    // The next menu says which revision it replaces.
    y.f.setCapabilities([{ id: 'fix-bug', description: 'Fix' }])
    y.f.publishMenu()
    await y.settle()
    const second = y.relay.calls.filter((c) => c.method === 'PUT')[1]
    expect(second.body).toMatchObject({ if_revision: 7 })
  })

  it('S11: a menu the relay says moved (409) is tried again with the relay’s own revision', async () => {
    let puts = 0
    const y = yard((c) => {
      if (c.method === 'PUT') {
        puts++
        if (puts === 1) {
          throw httpError(409)
        }
        return { revision: 12 }
      }
      if (c.method === 'GET') {
        return { draft_revision: 11 }
      }
      return {}
    }, false)
    y.f.publishMenu()
    await y.settle()
    expect(y.f.outbox()).toHaveLength(1)
    await y.adv(1000)
    const puts_ = y.relay.calls.filter((c) => c.method === 'PUT')
    expect(puts_[1].body).toMatchObject({ if_revision: 11 })
    expect(y.f.outbox()).toEqual([])
  })
})

describe('S9/S21 lifecycle events go to the right routes', () => {
  it('S15/S16: accept goes to the owner route; progress and done use the handoff routes, with evidence mapped', async () => {
    const y = yard()
    y.f.agentUp('a1')
    y.f.intake({ offer: y.offer('hnd_1'), requester: 'site' })
    await y.settle()
    const epoch = 1
    y.f.agentAccept('hnd_1', 'a1', epoch)
    y.f.agentProgress('hnd_1', 'a1', epoch, 'working')
    await y.settle()
    await y.settle()
    y.f.agentDone('hnd_1', 'a1', epoch, {
      revisionSha: SHA,
      evidence: [
        { kind: 'pr', ref: 'https://github.com/x/y/pull/1' },
        { kind: 'ci', ref: 'https://ci/run/9' },
        { kind: 'artifact', ref: 'file_1' }
      ]
    })
    for (let i = 0; i < 4; i++) {
      await y.settle()
    }
    const seen = y.relay.calls.filter((c) => c.path.startsWith('/v1/handoffs/'))
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/handoffs/hnd_1/foreman',
      'POST /v1/handoffs/hnd_1/renew',
      'POST /v1/handoffs/hnd_1/act'
    ])
    expect(seen[0]).toMatchObject({ body: { op: 'accept' }, plane: 'user' })
    expect(seen[2].body).toEqual({
      op: 'done',
      evidence: { sha: SHA, pr_url: 'https://github.com/x/y/pull/1', ci_url: 'https://ci/run/9', files: ['file_1'] }
    })
  })

  it('S18/S20: a job given back goes to the owner route as decline or release, with the reason', async () => {
    const y = yard()
    y.f.intake({ offer: y.offer('hnd_2'), requester: 'site' })
    await y.settle()
    y.f.decline('hnd_2', 'owner', 'not for us')
    await y.settle()
    await y.settle()
    expect(y.relay.calls.at(-1)).toMatchObject({
      path: '/v1/handoffs/hnd_2/foreman',
      body: { op: 'decline', reason: 'not for us' }
    })
    y.f.intake({ offer: y.offer('hnd_3'), requester: 'site' })
    await y.settle()
    await y.adv(24 * HOUR_MS + 1000)
    for (let i = 0; i < 6; i++) {
      await y.settle()
    }
    expect(y.relay.calls.at(-1)).toMatchObject({
      path: '/v1/handoffs/hnd_3/foreman',
      body: { op: 'release', reason: 'yard_offline' }
    })
  })

  it('S18: owner notices go to the app, not the relay', async () => {
    const y = yard()
    y.f.intake({ offer: y.offer('hnd_4', { capability: 'audit' }), requester: 'site' })
    for (let i = 0; i < 4; i++) {
      await y.settle()
    }
    expect(y.owner).toEqual([{ kind: 'job_needs_approval', taskId: 'hnd_4' }])
  })
})

describe('S21 failures: transient ones wait, final ones are dropped and listed', () => {
  it('S21: a relay that answers 503 then 200 gets the accept again, once, in order', async () => {
    let fails = 2
    const y = yard((c) => {
      if (c.path.endsWith('/foreman') && fails-- > 0) {
        throw httpError(503)
      }
      return {}
    })
    y.f.intake({ offer: y.offer('hnd_5'), requester: 'site' })
    await y.settle()
    expect(y.f.outbox()).toHaveLength(1)
    await y.adv(1000)
    expect(y.f.outbox()).toHaveLength(1)
    await y.adv(2000)
    expect(y.f.outbox()).toEqual([])
    expect(y.relay.calls.filter((c) => c.path.endsWith('/foreman'))).toHaveLength(3)
  })

  it('S21: a network error (no status) is also tried again', async () => {
    let down = true
    const y = yard(() => {
      if (down) {
        throw new Error('ECONNRESET')
      }
      return {}
    }, false)
    y.f.intake({ offer: y.offer('hnd_6'), requester: 'site' })
    await y.settle()
    expect(y.f.outbox()[0].lastError).toBe('ECONNRESET')
    down = false
    await y.adv(1000)
    expect(y.f.outbox()).toEqual([])
  })

  it('S21: 401, 403 and 429 are tried again (sign in again, rate limit); 404 and 422 are final', async () => {
    for (const [status, final] of [
      [401, false],
      [403, false],
      [429, false],
      [404, true],
      [422, true]
    ] as const) {
      const y = yard(() => {
        throw httpError(status)
      }, false)
      y.f.intake({ offer: y.offer('hnd_7'), requester: 'site' })
      await y.settle()
      expect(y.f.outbox().length, String(status)).toBe(final ? 0 : 1)
      expect(y.f.deadEffects().length, String(status)).toBe(final ? 1 : 0)
    }
  })

  it('S10: a direct line event has no relay route yet: it is dropped and listed, and the job carries on', async () => {
    const y = yard()
    y.f.agentUp('a1')
    y.f.intake({ offer: y.offer('hnd_8'), requester: 'site' })
    await y.settle()
    y.f.agentAccept('hnd_8', 'a1', 1)
    y.f.openLine('hnd_8', { fromInner: 'a1', toVillage: 'vil_other', purpose: 'compare', ttlMinutes: 30 })
    for (let i = 0; i < 4; i++) {
      await y.settle()
    }
    expect(y.f.deadEffects()).toMatchObject([{ kind: 'lifecycle', ref: 'hnd_8' }])
    expect(y.f.jobView('hnd_8').state).toBe('accepted')
  })

  it('S35: a requester notice without a route is dropped and listed rather than lost', async () => {
    const y = yard()
    y.f.agentUp('a1')
    y.f.intake({ offer: y.offer('hnd_9'), requester: 'site' })
    await y.settle()
    expect(ROUTES.foreman('hnd_9')).toBe('/v1/handoffs/hnd_9/foreman')
    // Three send-backs go to the requester.
    for (let round = 1; round <= 3; round++) {
      const epoch = y.f.claimsOf('hnd_9').length
      y.f.agentAccept('hnd_9', 'a1', epoch)
      y.f.agentDone('hnd_9', 'a1', epoch, { revisionSha: SHA, evidence: [{ kind: 'sha', ref: SHA }] })
      y.f.onLifecycle({
        yard: 'acme-dev',
        task_id: 'hnd_9',
        event: 'verify',
        at: new Date(T0).toISOString(),
        revision_sha: SHA,
        result: 'reject'
      })
      for (let i = 0; i < 4; i++) {
        await y.settle()
      }
    }
    expect(y.requester).toEqual([{ kind: 'send_back_limit', taskId: 'hnd_9', requester: 'site' }])
  })
})
