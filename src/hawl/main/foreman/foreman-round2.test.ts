// Foreman tests, part 3: defects found by the round 1 critic. Each test names its S-line.
import { describe, expect, it } from 'vitest'
import { HOUR_MS, MINUTE_MS, T0, code, makeRig, ready } from './rig.test-support'
import type { CapabilityConfig } from './types'

describe('S20 rules and stopped jobs', () => {
  it('S20: a second correction replaces the first, so the newest rule wins', () => {
    const rig = ready({}, ['a1'])
    rig.foreman.agentUp('a2', { capacity: 3 })
    rig.foreman.agentUp('a3', { capacity: 3 })
    rig.send('j1', 'fix-bug', 'friend')
    rig.claim('j1', 'a1')
    rig.foreman.reroute('j1', { toAgent: 'a2', by: 'usr_aaron', makeRule: true })
    rig.foreman.reroute('j1', { toAgent: 'a3', by: 'usr_aaron', makeRule: true })
    expect(rig.foreman.rules()).toMatchObject([{ action: { agentId: 'a3' } }])
    rig.send('j2', 'fix-bug', 'friend')
    expect(rig.offers.at(-1)).toMatchObject({ agentId: 'a3' })
  })

  it('S20: when the newest rule agent cannot take the job, an older matching rule still can', () => {
    const rig = ready({}, ['a1', 'a2', 'a3'])
    rig.foreman.addRule({ capability: 'fix-bug' }, { agentId: 'a2' })
    rig.foreman.addRule({ fromYard: 'friend' }, { agentId: 'a3' })
    rig.foreman.agentDown('a3')
    rig.send('j1', 'fix-bug', 'friend')
    expect(rig.offers.at(-1)).toMatchObject({ agentId: 'a2' })
  })

  it('S20: a person rerouting a job that stopped after 3 reroutes gets it offered again', () => {
    const rig = ready({}, ['a1', 'a2', 'a3', 'a4'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    for (const to of ['a2', 'a3', 'a4']) {
      rig.foreman.reroute('j1', { toAgent: to, by: 'usr_aaron' })
    }
    expect(rig.foreman.jobView('j1').needsHuman).toBe(true)
    const before = rig.offers.length
    rig.foreman.reroute('j1', { toAgent: 'a2', by: 'usr_aaron', reason: 'try a2 again' })
    expect(rig.offers.slice(before)).toMatchObject([{ agentId: 'a2' }])
    expect(rig.foreman.jobView('j1')).toMatchObject({ needsHuman: false, exec: 'offered' })
  })

  it('S20: resolveNeedsHuman puts a stopped job back in the queue and records who did it', () => {
    const rig = ready({}, ['a1', 'a2', 'a3', 'a4'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    for (const to of ['a2', 'a3', 'a4']) {
      rig.foreman.reroute('j1', { toAgent: to, by: 'usr_aaron' })
    }
    const before = rig.offers.length
    rig.foreman.resolveNeedsHuman('j1', 'usr_aaron', 'looked at it')
    expect(rig.offers.length).toBe(before + 1)
    expect(rig.foreman.jobView('j1').needsHuman).toBe(false)
    expect(rig.foreman.jobView('j1').history.at(-1)).toMatchObject({
      kind: 'resume',
      by: 'usr_aaron',
      reason: 'looked at it'
    })
    expect(code(() => rig.foreman.resolveNeedsHuman('j1', 'usr_aaron'))).toBe('bad_state')
  })

  it('S35: a job stopped by 3 send-backs can be resumed by a person', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    let e = rig.claim('j1', 'a1')
    for (let i = 1; i <= 3; i++) {
      rig.done('j1', 'a1', e)
      rig.verify('j1', 'reject')
      if (i < 3) {
        e = rig.claim('j1', 'a1')
      }
    }
    expect(rig.foreman.jobView('j1').needsHuman).toBe(true)
    rig.foreman.resolveNeedsHuman('j1', 'usr_requester')
    expect(rig.offers.at(-1)).toMatchObject({ agentId: 'a1' })
    // Counters start over, so the next reject is a first send-back again.
    e = rig.claim('j1', 'a1')
    rig.done('j1', 'a1', e)
    rig.verify('j1', 'reject')
    expect(rig.foreman.jobView('j1').needsHuman).toBe(false)
  })

  it('S35: the third send-back tells the requester, not the yard owner', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1', 'fix-bug', 'friend')
    let e = rig.claim('j1', 'a1')
    for (let i = 1; i <= 3; i++) {
      rig.done('j1', 'a1', e)
      rig.verify('j1', 'reject')
      if (i < 3) {
        e = rig.claim('j1', 'a1')
      }
    }
    expect(rig.requesterNotices).toEqual([
      { kind: 'send_back_limit', taskId: 'j1', requester: 'friend' }
    ])
    expect(rig.notices.filter((n) => n.kind === 'needs_human')).toEqual([])
  })

  it('S20: a rule needs something to match, and a job with no capability cannot become one', () => {
    const rig = ready({}, ['a1', 'a2'])
    expect(code(() => rig.foreman.addRule({}, { agentId: 'a1' }))).toBe('bad_rule')
    expect(code(() => rig.foreman.addRule({ capability: undefined }, { agentId: 'a1' }))).toBe(
      'bad_rule'
    )
    const offer = rig.offerEvent('jx', null)
    rig.foreman.adoptQueue([{ offer, requester: 'site', acceptedAt: T0 }])
    expect(code(() => rig.foreman.reroute('jx', { toAgent: 'a2', by: 'o', makeRule: true }))).toBe(
      'bad_rule'
    )
    expect(rig.foreman.rules()).toEqual([])
    expect(rig.foreman.jobView('jx').history).toEqual([])
  })
})

describe('S18 clocks restart when a job stops running', () => {
  it('S18: a job whose lease lapses after the 24 h mark is flagged and handed back, counting from the lapse', () => {
    const rig = ready({ leaseMs: 30 * HOUR_MS }, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.adv(25 * HOUR_MS)
    expect(rig.notices).toEqual([])
    rig.foreman.agentDown('a1')
    rig.adv(5 * HOUR_MS) // lease lapsed here: waiting starts again
    expect(rig.foreman.jobView('j1').exec).toBe('queued')
    expect(rig.notices).toEqual([])
    rig.adv(4 * HOUR_MS)
    expect(rig.notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    rig.adv(20 * HOUR_MS - 1)
    expect(rig.handBacks).toHaveLength(0)
    rig.adv(1)
    expect(rig.handBacks).toEqual([{ taskId: 'j1', op: 'release', reason: 'yard_offline' }])
  })

  it('S18: a job sent back after the 24 h mark is not handed back at once', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e = rig.claim('j1', 'a1')
    rig.foreman.agentRenew('j1', 'a1', e)
    rig.done('j1', 'a1', e)
    rig.adv(30 * HOUR_MS)
    rig.verify('j1', 'reject')
    expect(rig.handBacks).toHaveLength(0)
    rig.adv(24 * HOUR_MS - 1)
    expect(rig.handBacks).toHaveLength(0)
    rig.adv(1)
    expect(rig.handBacks).toHaveLength(1)
  })

  it('S18: busy agents are not "offline": no notice while one is online, one after they all go', () => {
    const rig = ready({ leaseMs: 100 * HOUR_MS }, ['a1'])
    rig.send('t1')
    rig.claim('t1', 'a1')
    rig.send('t2')
    rig.adv(5 * HOUR_MS)
    expect(rig.foreman.jobView('t2').exec).toBe('queued')
    expect(rig.notices).toEqual([])
    rig.foreman.agentDown('a1')
    rig.adv(31 * MINUTE_MS)
    expect(rig.notices).toEqual([{ kind: 'job_held_offline', taskId: 't2' }])
  })
})

describe('S10 a line belongs to the agent that asked for it', () => {
  it('S10: when the claim is revoked the line closes, and the new holder has none', () => {
    const rig = ready({ directLines: 'job_parties' }, ['a1', 'a2'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.foreman.openLine('j1', { fromInner: 'a1', toVillage: 'qa', purpose: 'ask', ttlMinutes: 60 })
    rig.foreman.remoteLineDecision('j1', true)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa')).toBe(true)
    rig.foreman.agentDown('a1')
    rig.adv(31 * MINUTE_MS) // lease lapses, a2 is offered the job
    rig.claim('j1', 'a2')
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa')).toBe(false)
    expect(rig.foreman.lineAllows('j1', 'a2', 'qa')).toBe(false)
    expect(rig.foreman.jobView('j1').line).toMatchObject({
      state: 'closed',
      closeReason: 'claim_revoked'
    })
  })
})

describe('S11 the published menu carries the policy', () => {
  const caps: CapabilityConfig[] = [
    {
      id: 'fix-bug',
      description: 'Fix a bug',
      typical_minutes: 30,
      keywords: ['bug', 'crash'],
      stations: ['vil_abc'],
      next: ['review-pr']
    },
    { id: 'audit', description: 'Audit', approval: 'ask_owner', acceptFrom: ['site', 'friend'] },
    { id: 'night', description: 'Night only', acceptWhenOffline: false },
    { id: 'closed-cap', description: 'Not taking this', open: false }
  ]

  it('S11: the ledger menu says auto or ask owner, open or closed, and the hold and release times', () => {
    const rig = makeRig({ holdMs: 2 * HOUR_MS, releaseMs: 6 * HOUR_MS, directLines: 'never' }, caps)
    const { menu, extended } = rig.publish()
    expect(menu.capabilities.map((c) => c.id)).toEqual(['fix-bug', 'audit', 'night'])
    expect(extended).toMatchObject({
      hold_minutes: 120,
      release_minutes: 360,
      direct_lines: 'never'
    })
    const by = Object.fromEntries(extended.capabilities.map((c) => [c.id, c]))
    expect(by['fix-bug']).toMatchObject({
      open: true,
      approval: 'auto',
      accept_when_offline: true,
      keywords: ['bug', 'crash'],
      stations: ['vil_abc'],
      next: ['review-pr']
    })
    expect(by.audit).toMatchObject({ approval: 'ask_owner', accept_from: ['site', 'friend'] })
    expect(by.night.accept_when_offline).toBe(false)
    expect(by['closed-cap'].open).toBe(false)
    expect(rig.menus.at(-1)?.extended).toEqual(extended)
  })

  it('S11: the default hold and release are 240 and 1440 minutes', () => {
    const rig = makeRig({}, caps)
    expect(rig.publish().extended).toMatchObject({
      hold_minutes: 240,
      release_minutes: 1440,
      direct_lines: 'ask_owner'
    })
  })

  it('S11: the strict gateway menu never gets the extra fields', () => {
    const rig = makeRig({}, caps)
    const { menu } = rig.publish()
    for (const c of menu.capabilities) {
      expect(Object.keys(c).filter((k) => ['open', 'approval', 'keywords'].includes(k))).toEqual([])
    }
    expect('hold_minutes' in menu).toBe(false)
  })
})

describe('restart keeps ids unique', () => {
  it('S20/S23: ids made after a restore do not repeat ids made before it', () => {
    const a = ready({}, ['a1'])
    const ruleA = a.foreman.addRule({ capability: 'fix-bug' }, { agentId: 'a1' })
    const cardA = a.foreman.cards.start('a1', { title: 'first' })
    const snap = a.foreman.snapshot()
    const b = makeRig()
    b.foreman.restore(snap)
    const ruleB = b.foreman.addRule({ capability: 'review-pr' }, { agentId: 'a1' })
    const cardB = b.foreman.cards.start('a2', { title: 'second' })
    expect(ruleB).not.toBe(ruleA)
    expect(cardB.id).not.toBe(cardA.id)
    expect(b.foreman.cards.count()).toBe(2)
    expect(b.foreman.rules().map((r) => r.id)).toEqual([ruleA, ruleB])
  })
})

describe('housekeeping', () => {
  it('S21: finished jobs are forgotten after the retention time, running ones never', () => {
    const rig = ready({ leaseMs: 100 * 24 * HOUR_MS }, ['a1', 'a2'])
    rig.send('done1')
    const e = rig.claim('done1', 'a1')
    rig.done('done1', 'a1', e)
    rig.verify('done1')
    rig.send('refused', 'nope')
    rig.send('live')
    rig.claim('live', 'a1')
    rig.adv(29 * 24 * HOUR_MS)
    expect(rig.foreman.jobIds()).toEqual(['done1', 'refused', 'live'])
    rig.adv(2 * 24 * HOUR_MS)
    expect(rig.foreman.jobIds()).toEqual(['live'])
    expect(rig.foreman.snapshot().jobs.map((j) => j.taskId)).toEqual(['live'])
  })

  it.each([
    ['UTC', 'UTC', true],
    ['Pacific/Auckland (the owner day turned over)', 'Pacific/Auckland', false]
  ])('S18: the daily budget resets at midnight in the owner zone (%s)', (_n, timeZone, held) => {
    // 08:00 UTC is evening in Auckland; 11:00 UTC is just past midnight there.
    const rig = ready({ dailyBudgetUsd: 10, timeZone }, ['a1'])
    rig.foreman.recordCost(10)
    expect(rig.send('before').outcome).toBe('held')
    rig.adv(3 * HOUR_MS)
    expect(rig.send('after').outcome).toBe(held ? 'held' : 'accepted')
  })

  it('S18: only today spend is kept', () => {
    const rig = ready({ dailyBudgetUsd: 10 }, ['a1'])
    rig.foreman.recordCost(4)
    rig.adv(24 * HOUR_MS)
    rig.foreman.recordCost(4)
    expect(rig.foreman.snapshot().spent).toHaveLength(1)
    expect(rig.send('j1').outcome).toBe('accepted')
  })
})
