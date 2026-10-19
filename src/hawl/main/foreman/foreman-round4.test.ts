// Round 4: the defects a critic reproduced against round 3, each one with the exact case that failed.
// A relay that is down, a crash between "decide" and "save", a laptop that sleeps, an agent that
// disconnects, a damaged file, a menu that cannot be sent. Every test names its S-line.
import { describe, expect, it } from 'vitest'
import { Foreman } from './foreman'
import type { ForemanSnapshot } from './foreman'
import { HOUR_MS, MINUTE_MS, T0, code, makeRig, ready } from './rig.test-support'

describe('S15/S21 a relay that is down never leaves a job half moved', () => {
  it('S15/S21: accept cannot be sent: the job is still accepted and queued, the offer is a duplicate, accept goes once on retry', () => {
    const r = ready({}, ['a1'])
    r.faults.sendLifecycle = 1
    expect(r.send('j1').outcome).toBe('accepted')
    // State moved even though the wire did not.
    expect(r.foreman.jobView('j1')).toMatchObject({ state: 'accepted', exec: 'offered' })
    expect(r.offers.map((o) => o.agentId)).toEqual(['a1'])
    expect(r.events('accept')).toHaveLength(0)
    expect(r.foreman.outbox()).toHaveLength(1)
    expect(r.foreman.outbox()[0]).toMatchObject({ attempts: 1 })
    // The Dispatcher sends the same offer again (it never saw an accept): nothing changes, nothing is sent.
    expect(r.foreman.intake({ offer: r.offerEvent('j1'), requester: 'site' }).outcome).toBe(
      'duplicate'
    )
    expect(r.events('accept')).toHaveLength(0)
    r.adv(999)
    expect(r.events('accept')).toHaveLength(0)
    r.adv(1)
    expect(r.events('accept')).toHaveLength(1)
    expect(r.foreman.outbox()).toEqual([])
    r.adv(HOUR_MS)
    expect(r.events('accept')).toHaveLength(1)
    r.conforms()
  })

  it('S18: the hold and release clocks of a job whose accept could not be sent still run', () => {
    const r = ready()
    r.faults.sendLifecycle = 1
    r.send('j1')
    r.adv(4 * HOUR_MS + MINUTE_MS)
    expect(r.notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    r.adv(20 * HOUR_MS)
    expect(r.handBacks).toMatchObject([{ taskId: 'j1', op: 'release', reason: 'yard_offline' }])
    expect(r.events('accept')).toHaveLength(1)
  })

  it('S21: effects keep their order: progress never passes an accept that has not gone out', () => {
    const r = ready({}, ['a1'])
    r.faults.sendLifecycle = 1
    r.send('j1')
    const epoch = r.claim('j1', 'a1')
    r.foreman.agentProgress('j1', 'a1', epoch, 'started')
    expect(r.events()).toHaveLength(0)
    expect(r.foreman.outbox().map((i) => i.effect.kind)).toEqual(['lifecycle', 'lifecycle'])
    r.adv(1000)
    expect(r.events().map((e) => e.event)).toEqual(['accept', 'progress'])
    r.conforms()
  })

  it('S21: each failed try waits twice as long, up to a minute', () => {
    const r = ready()
    r.faults.sendLifecycle = 3
    r.send('j1')
    const retryAt = (): number => r.foreman.outbox()[0].retryAt - r.now()
    expect(retryAt()).toBe(1000)
    r.adv(1000)
    expect(retryAt()).toBe(2000)
    r.adv(2000)
    expect(retryAt()).toBe(4000)
    r.adv(4000)
    expect(r.events('accept')).toHaveLength(1)
  })

  it('S21: an effect the other side refuses for good is dropped, listed as dead, and the queue moves on', () => {
    const r = ready()
    r.faults.sendLifecycle = 1
    r.permanent(true)
    r.send('j1')
    expect(r.foreman.outbox()).toEqual([])
    expect(r.foreman.deadEffects()).toMatchObject([{ kind: 'lifecycle', ref: 'j1' }])
    // The job itself is unaffected.
    expect(r.foreman.jobView('j1').state).toBe('accepted')
  })

  it('S21: an effect that stays undeliverable for a day is dropped', () => {
    const r = ready({ outboxMaxAgeMs: 2 * HOUR_MS })
    r.faults.sendLifecycle = 1000
    r.send('j1')
    for (let i = 0; i < 130; i++) {
      r.adv(MINUTE_MS)
    }
    expect(r.foreman.outbox()).toEqual([])
    expect(r.foreman.deadEffects()).toMatchObject([
      { kind: 'lifecycle', reason: 'too old to deliver' }
    ])
  })

  it('S11: a menu that cannot be sent keeps its revision, is sent on retry, and a newer menu replaces it', () => {
    const r = ready()
    r.faults.sendMenu = 3
    // ready() already published revision 1 (sent). Now two publishes fail.
    r.setCaps([{ id: 'fix-bug', description: 'Fix a bug' }])
    const second = r.foreman.publishMenu()
    expect(second.revision).toBe(2)
    expect(r.foreman.menuRevision).toBe(2)
    expect(r.menus.map((m) => m.revision)).toEqual([1])
    r.setCaps([{ id: 'review-pr', description: 'Review a pull request' }])
    expect(r.foreman.publishMenu().revision).toBe(3)
    // Only the newest menu waits: revision 2 was replaced before it ever went out.
    expect(r.foreman.outbox()).toHaveLength(1)
    for (let i = 0; i < 10; i++) {
      r.adv(1000)
    }
    expect(r.menus.map((m) => m.revision)).toEqual([1, 3])
    expect(r.menus.at(-1)?.menu.capabilities.map((c) => c.id)).toEqual(['review-pr'])
  })

  it('S18: the owner notice is not held back by a relay that is down', () => {
    const r = ready()
    r.faults.sendLifecycle = 1000
    r.send('j1', 'audit')
    // The accept is stuck behind the relay; the "needs your OK" notice still reached the owner.
    expect(r.notices).toEqual([{ kind: 'job_needs_approval', taskId: 'j1' }])
    r.foreman.ownerDecision('j1', 'accept', 'owner')
    expect(r.events('accept')).toHaveLength(0)
    expect(r.foreman.outbox().map((i) => i.effect.kind)).toEqual(
      ['lifecycle', 'lifecycle'].slice(0, 1)
    )
  })

  it('S48: a heartbeat that cannot be sent is not queued; the next call sends a fresh one', () => {
    const r = makeRig()
    r.faults.sendHeartbeat = 1
    r.publish()
    expect(r.beats).toHaveLength(0)
    r.adv(1000)
    expect(r.beats).toHaveLength(1)
    expect(r.foreman.outbox()).toEqual([])
  })

  it('S16: an agent port that throws on an offer does not break the foreman; the offer times out to the next agent', () => {
    const r = ready({}, ['a1', 'a2'])
    r.faults.offer = 1
    r.send('j1')
    expect(r.foreman.jobView('j1').exec).toBe('offered')
    r.adv(10 * MINUTE_MS)
    expect(r.offers.map((o) => o.agentId)).toEqual(['a2'])
  })
})

describe('S21 write-ahead: the effect is on disk before it is on the wire', () => {
  it('S21: the snapshot is saved after the effect is queued and before it is sent', () => {
    const r = ready()
    const saved: ForemanSnapshot[] = []
    r.foreman.attach({
      persist: () => {
        r.calls.push('save')
        saved.push(r.foreman.snapshot())
      }
    })
    r.send('j1')
    expect(r.calls.indexOf('save')).toBeGreaterThan(-1)
    expect(r.calls.indexOf('save')).toBeLessThan(r.calls.indexOf('out:accept:j1'))
    expect(saved[0].outbox.map((i) => i.effect.kind)).toEqual(['lifecycle'])
    expect(saved[0].jobs[0]).toMatchObject({ taskId: 'j1', state: 'accepted' })
  })

  it('S21: a crash between the save and the send: the restarted foreman still has the job and sends the accept once', () => {
    const a = ready()
    const saved: ForemanSnapshot[] = []
    a.foreman.attach({ persist: () => void saved.push(a.foreman.snapshot()) })
    a.send('j1')
    // The process dies right after the save: use the snapshot taken at that moment.
    const b = makeRig()
    b.foreman.restore(JSON.parse(JSON.stringify(saved[0])))
    b.foreman.tick()
    expect(b.events('accept')).toHaveLength(1)
    expect(b.foreman.jobView('j1')).toMatchObject({ state: 'accepted' })
    // The redelivered offer is a duplicate, not a second job and not a second accept.
    expect(b.foreman.intake({ offer: b.offerEvent('j1'), requester: 'site' }).outcome).toBe(
      'duplicate'
    )
    b.adv(HOUR_MS)
    expect(b.events('accept')).toHaveLength(1)
  })

  it('S21: when the save fails nothing is sent, and it is sent once the disk works again', () => {
    const r = ready()
    let diskFull = true
    r.foreman.attach({
      persist: () => {
        if (diskFull) {
          throw new Error('disk full')
        }
      }
    })
    r.send('j1')
    expect(r.events('accept')).toHaveLength(0)
    r.adv(500)
    expect(r.events('accept')).toHaveLength(0)
    diskFull = false
    r.adv(1000)
    expect(r.events('accept')).toHaveLength(1)
  })
})

describe('S17 a foreman that was not running does not revoke the work of agents that slept with it', () => {
  it('S17: asleep for 2 h, then the agent renews: the claim stands and the job keeps running', () => {
    const r = ready({}, ['a1'])
    r.send('j1')
    const epoch = r.claim('j1', 'a1')
    r.skip(2 * HOUR_MS)
    // The runtime notices the late timer and calls this before anything else.
    expect(r.foreman.resumeAfterGap()).toBe(1)
    r.foreman.agentRenew('j1', 'a1', epoch)
    expect(r.foreman.jobView('j1')).toMatchObject({ exec: 'running', holder: 'a1' })
    expect(r.revokes).toEqual([])
    r.done('j1', 'a1', epoch)
    expect(r.events('done')).toHaveLength(1)
  })

  it('S17: with no grace the same sleep does revoke (the lease is real time): the grace is what saves it', () => {
    const r = ready({}, ['a1'])
    r.send('j1')
    const epoch = r.claim('j1', 'a1')
    r.skip(2 * HOUR_MS)
    expect(code(() => r.foreman.agentRenew('j1', 'a1', epoch))).toBe('claim_revoked')
    expect(r.foreman.jobView('j1').exec).toBe('queued')
  })

  it('S17: after the grace an agent that never comes back still loses the claim 30 minutes later', () => {
    const r = ready({}, ['a1', 'a2'])
    r.send('j1')
    const epoch = r.claim('j1', 'a1')
    r.skip(2 * HOUR_MS)
    r.foreman.resumeAfterGap()
    r.foreman.agentDown('a1')
    r.adv(31 * MINUTE_MS)
    expect(r.revokes).toMatchObject([{ agentId: 'a1', revoke: { epoch } }])
    expect(code(() => r.done('j1', 'a1', epoch))).toBe('claim_revoked')
  })

  it('S16: an offer that nobody answered during the sleep is open for its full time again', () => {
    const r = ready({}, ['a1'])
    r.send('j1')
    r.skip(3 * HOUR_MS)
    r.foreman.resumeAfterGap()
    expect(r.foreman.jobView('j1').exec).toBe('offered')
    const epoch = r.offers[0].offer.epoch
    r.foreman.agentAccept('j1', 'a1', epoch)
    expect(r.foreman.jobView('j1').exec).toBe('running')
  })
})

describe('S16/S17 an agent that goes down is noticed', () => {
  it('S16: an offer to an agent that goes down moves to the next agent at once, not after 10 minutes', () => {
    const r = ready({}, ['a1', 'a2'])
    r.send('j1')
    expect(r.offers.map((o) => o.agentId)).toEqual(['a1'])
    r.foreman.agentDown('a1')
    expect(r.offers.map((o) => o.agentId)).toEqual(['a1', 'a2'])
    expect(r.revokes).toMatchObject([{ agentId: 'a1', revoke: { reason: 'agent_down' } }])
    expect(r.foreman.jobView('j1')).toMatchObject({ exec: 'offered', claim: { agentId: 'a2' } })
    // a1 is back: the job it lost is not offered a third time while a2 holds it, and a1 was not marked as having refused it.
    r.foreman.agentUp('a1')
    expect(r.foreman.jobView('j1').claim?.agentId).toBe('a2')
    expect(r.foreman.jobView('j1').history.map((h) => h.kind)).toEqual(['timeout'])
  })

  it('S16: the only agent goes down: the job waits queued and goes back to that agent when it returns', () => {
    const r = ready({}, ['a1'])
    r.send('j1')
    r.foreman.agentDown('a1')
    expect(r.foreman.jobView('j1')).toMatchObject({ exec: 'queued', queuedNotRunning: true })
    r.adv(MINUTE_MS)
    r.foreman.agentUp('a1')
    expect(r.foreman.jobView('j1')).toMatchObject({
      exec: 'offered',
      claim: { agentId: 'a1', epoch: 2 }
    })
  })

  it('S17: a running agent that goes down loses the claim after the 2 minute grace and the job moves on', () => {
    const r = ready({}, ['a1', 'a2'])
    r.send('j1')
    const epoch = r.claim('j1', 'a1')
    r.foreman.agentDown('a1')
    r.adv(MINUTE_MS)
    expect(r.foreman.jobView('j1').exec).toBe('running')
    r.adv(MINUTE_MS + 1000)
    expect(r.revokes).toMatchObject([{ agentId: 'a1', revoke: { epoch, reason: 'lease_lapsed' } }])
    expect(r.foreman.jobView('j1')).toMatchObject({ exec: 'offered', claim: { agentId: 'a2' } })
    expect(code(() => r.done('j1', 'a1', epoch))).toBe('claim_revoked')
  })

  it('S17: a running agent that reconnects inside the grace keeps its claim and gets a full lease', () => {
    const r = ready({}, ['a1', 'a2'])
    r.send('j1')
    const epoch = r.claim('j1', 'a1')
    r.foreman.agentDown('a1')
    r.adv(90_000)
    r.foreman.agentUp('a1')
    r.adv(29 * MINUTE_MS)
    expect(r.foreman.jobView('j1')).toMatchObject({ exec: 'running', holder: 'a1' })
    r.foreman.agentRenew('j1', 'a1', epoch)
    expect(r.revokes).toEqual([])
  })
})

describe('S17 a damaged saved file leaves the foreman as it was', () => {
  function good(): Record<string, unknown> {
    const a = ready({}, ['a1'])
    a.send('j1')
    return JSON.parse(JSON.stringify(a.foreman.snapshot()))
  }

  it('S17: a file with no rules list is refused whole: the foreman keeps what it had, nothing is half loaded', () => {
    const b = ready({}, ['a1'])
    b.send('j9')
    const snap = good()
    delete snap.rules
    expect(code(() => b.foreman.restore(snap))).toBe('bad_snapshot')
    expect(b.foreman.jobIds()).toEqual(['j9'])
    expect(b.foreman.rules()).toEqual([])
    expect(b.foreman.agents().map((x) => x.id)).toEqual(['a1'])
  })

  it('S17: each way a file can be wrong is refused before anything changes', () => {
    const cases: [string, (s: Record<string, unknown>) => void][] = [
      ['not an object', () => undefined],
      [
        'a job without an id',
        (s) =>
          (s.jobs as Record<string, unknown>[])[0] &&
          delete (s.jobs as Record<string, unknown>[])[0].taskId
      ],
      [
        'a job in an unknown state',
        (s) => ((s.jobs as Record<string, unknown>[])[0].state = 'flying')
      ],
      ['two jobs with one id', (s) => (s.jobs as unknown[]).push((s.jobs as unknown[])[0])],
      ['seq not a number', (s) => (s.seq = 'x')],
      ['a task without a key', (s) => (s.tasks as unknown[]).push({ kind: 'delegate' })],
      ['an outbox item with no effect', (s) => (s.outbox as unknown[]).push({ id: 1 })],
      ['a card without an id', (s) => (s.cards = { cards: [{}], publish: [] })],
      ['paused not true or false', (s) => (s.paused = 'no')],
      ['a newer version', (s) => (s.version = 99)]
    ]
    for (const [name, damage] of cases) {
      const b = ready({}, ['a1'])
      b.send('j9')
      const snap = good()
      damage(snap)
      const input = name === 'not an object' ? 'text' : snap
      expect(
        code(() => b.foreman.restore(input)),
        name
      ).toBe('bad_snapshot')
      expect(b.foreman.jobIds(), name).toEqual(['j9'])
    }
  })

  it('S17: a file from before versions existed is upgraded; the same file marked version 1 loads too', () => {
    const snap = good()
    for (const k of [
      'version',
      'agents',
      'tombs',
      'outbox',
      'outSeq',
      'dead',
      'settings',
      'savedAt'
    ]) {
      delete snap[k]
    }
    for (const v of [undefined, 1]) {
      const b = makeRig()
      if (v) {
        snap.version = v
      }
      expect(b.foreman.restore(snap)).toEqual({ savedAt: 0 })
      expect(b.foreman.jobIds()).toEqual(['j1'])
      expect(b.foreman.snapshot().version).toBe(2)
    }
  })

  it('S17: a snapshot written now carries its version and reads back to the same snapshot', () => {
    const a = ready({}, ['a1'])
    a.send('j1')
    a.foreman.addRule({ capability: 'fix-bug' }, { agentId: 'a1' })
    const snap = a.foreman.snapshot()
    expect(snap.version).toBe(2)
    const b = makeRig()
    b.foreman.restore(JSON.parse(JSON.stringify(snap)))
    const again = b.foreman.snapshot()
    // Agents come back offline and the outbox waits for a retry time of "now"; everything else is equal.
    expect({ ...again, savedAt: 0, agents: [], outbox: [] }).toEqual({
      ...snap,
      savedAt: 0,
      agents: [],
      outbox: []
    })
  })
})

describe('S18 the hold and release times can be changed from the console', () => {
  it('S18: a new hold time moves the clocks of a job that is already waiting', () => {
    const r = ready()
    r.send('j1')
    r.foreman.setTimes({ holdMs: HOUR_MS, releaseMs: 2 * HOUR_MS })
    r.adv(HOUR_MS + MINUTE_MS)
    expect(r.notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    r.adv(HOUR_MS)
    expect(r.handBacks).toMatchObject([{ taskId: 'j1', op: 'release' }])
  })

  it('S18: the menu shows the new times after the next publish, and they survive a restart', () => {
    const r = ready()
    r.foreman.setTimes({ holdMs: 30 * MINUTE_MS, releaseMs: 6 * HOUR_MS })
    expect(r.publish().extended).toMatchObject({ hold_minutes: 30, release_minutes: 360 })
    const b = makeRig()
    b.foreman.restore(JSON.parse(JSON.stringify(r.foreman.snapshot())))
    expect(b.foreman.settings()).toMatchObject({ holdMs: 30 * MINUTE_MS, releaseMs: 6 * HOUR_MS })
  })

  it('S18: times outside the allowed range are refused and change nothing', () => {
    const r = ready()
    for (const t of [
      { holdMs: 1000 },
      { holdMs: 8 * 24 * HOUR_MS },
      { releaseMs: HOUR_MS },
      { holdMs: 5 * HOUR_MS, releaseMs: 2 * HOUR_MS },
      { releaseMs: 31 * 24 * HOUR_MS },
      { holdMs: 1.5 * MINUTE_MS + 0.5 }
    ]) {
      expect(
        code(() => r.foreman.setTimes(t)),
        JSON.stringify(t)
      ).toBe('bad_setting')
    }
    expect(r.foreman.settings()).toMatchObject({ holdMs: 4 * HOUR_MS, releaseMs: 24 * HOUR_MS })
  })
})

describe('S21 an async transport', () => {
  function asyncRig() {
    let t = T0
    const sent: string[] = []
    const pending: { name: string; ok: () => void; fail: (e: Error) => void }[] = []
    const send = (name: string): Promise<void> =>
      new Promise<void>((ok, fail) => {
        pending.push({ name, ok, fail })
      })
    let changes = 0
    const f = new Foreman(
      { yard: 'acme-dev', owner: 'usr_a', displayName: 'Y' },
      {
        clock: { now: () => t },
        transport: {
          sendMenu: () => send('menu'),
          sendHeartbeat: () => undefined,
          sendLifecycle: (ev) => send(ev.event),
          notifyOwner: () => send('owner'),
          notifyRequester: () => send('requester'),
          handBack: () => send('handback')
        },
        agents: { offer: () => undefined, revoke: () => undefined }
      }
    )
    f.attach({ onChange: () => void changes++ })
    return {
      f,
      pending,
      sent,
      advance: (ms: number) => {
        t += ms
        f.tick()
      },
      settle: async (i: number, how: 'ok' | Error) => {
        const p = pending[i]
        if (how === 'ok') {
          p.ok()
          sent.push(p.name)
        } else {
          p.fail(how)
        }
        await Promise.resolve()
        await Promise.resolve()
      },
      changes: () => changes,
      now: () => t
    }
  }

  it('S21: an effect refused for good by an async relay is dropped and the one behind it goes at once', async () => {
    const a = asyncRig()
    a.f.setCapabilities([{ id: 'fix-bug', description: 'Fix' }])
    a.f.publishMenu()
    a.f.intake({
      offer: {
        yard: 'acme-dev',
        task_id: 'j1',
        event: 'offer',
        at: new Date(a.now()).toISOString(),
        capability: 'fix-bug'
      },
      requester: 'site'
    })
    expect(a.pending.map((p) => p.name)).toEqual(['menu'])
    await a.settle(0, Object.assign(new Error('422'), { permanent: true }))
    // No tick, no new call: the refusal itself moves the queue on.
    expect(a.pending.map((p) => p.name)).toEqual(['menu', 'accept'])
    expect(a.f.deadEffects()).toMatchObject([{ kind: 'menu' }])
    await a.settle(1, 'ok')
    expect(a.f.outbox()).toEqual([])
  })

  it('S21: every failed delivery is reported to the error hook with where it happened', () => {
    const r = ready()
    const seen: string[] = []
    r.foreman.attach({ onError: (_e, where) => void seen.push(where) })
    r.faults.sendLifecycle = 2
    r.send('j1')
    r.adv(1000)
    expect(seen).toEqual(['deliver lifecycle', 'deliver lifecycle'])
  })

  it('S21: the second effect waits until the first is confirmed; a rejection is retried; order holds', async () => {
    const a = asyncRig()
    a.f.setCapabilities([{ id: 'fix-bug', description: 'Fix' }])
    a.f.publishMenu()
    a.f.intake({
      offer: {
        yard: 'acme-dev',
        task_id: 'j1',
        event: 'offer',
        at: new Date(a.now()).toISOString(),
        capability: 'fix-bug'
      },
      requester: 'site'
    })
    // Only the menu is in flight; the accept waits behind it.
    expect(a.pending.map((p) => p.name)).toEqual(['menu'])
    await a.settle(0, new Error('503'))
    expect(a.f.outbox().map((i) => i.effect.kind)).toEqual(['menu', 'lifecycle'])
    a.advance(1000)
    expect(a.pending.map((p) => p.name)).toEqual(['menu', 'menu'])
    await a.settle(1, 'ok')
    expect(a.pending.map((p) => p.name)).toEqual(['menu', 'menu', 'accept'])
    await a.settle(2, 'ok')
    expect(a.sent).toEqual(['menu', 'accept'])
    expect(a.f.outbox()).toEqual([])
    expect(a.changes()).toBeGreaterThanOrEqual(3)
  })
})
