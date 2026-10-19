// Foreman tests, one block per SPEC line (m2-contract.md section 1). Every test name
// starts with its S-number. Time is a fake clock; nothing sleeps.
//
//   S9   hop through the foreman        S10  direct lines
//   S11  menu publish                   S12  nothing routes on a draft
//   S15  accept while agents offline    S16  claim + renewing lease
//   S17  revoke on lapse, late done     S18  hold 4 h, release 24 h
//   S19  routing reason (history)       S20  decline / reroute history
//   S21  idempotent offers              S23-S25 work cards (cards.test.ts + job close here)
//   S48  menu + heartbeat as a gateway yard
//   Plus the plan's decisions: self-hosted paused state, offline queue handover.
import { describe, expect, it } from 'vitest'
import { checkContract } from '../../shared/gateway-contract/contract'
import { CAPS, HOUR_MS, MINUTE_MS, T0, code, makeRig, ready, SHA } from './rig.test-support'

describe('S11 menu publish and S12 drafts', () => {
  it('S11: publishes a contract-valid menu with only open capabilities and no foreman-only keys', () => {
    const rig = makeRig()
    const { menu, revision } = rig.publish()
    expect(revision).toBe(1)
    expect(checkContract('menu', menu)).toBeNull()
    expect(menu.capabilities.map((c) => c.id)).toEqual([
      'fix-bug',
      'review-pr',
      'audit',
      'night-shift'
    ])
    const text = JSON.stringify(menu)
    for (const leak of ['approval', 'acceptWhenOffline', 'acceptFrom', 'open"']) {
      expect(text).not.toContain(leak)
    }
    expect(menu.routing_policy?.auto_accept).toBe(false) // audit asks the owner
    expect(rig.menus).toHaveLength(1)
  })

  it('S11: a second publish bumps the revision and sends again', () => {
    const rig = makeRig()
    rig.publish()
    rig.foreman.setCapabilities([{ id: 'fix-bug', description: 'Fix bugs' }])
    expect(rig.publish().revision).toBe(2)
    expect(rig.menus[1].menu.capabilities).toHaveLength(1)
    expect(rig.menus[1].menu.routing_policy?.auto_accept).toBe(true)
  })

  it('S11: a menu the contract rejects is not sent', () => {
    const rig = makeRig()
    rig.foreman.setCapabilities([{ id: 'Bad Slug!', description: 'x' }])
    expect(code(() => rig.publish())).toBe('bad_menu')
    expect(rig.menus).toHaveLength(0)
  })

  it('S12: nothing routes on a draft until the owner publishes it', () => {
    const rig = makeRig()
    rig.publish()
    rig.foreman.setCapabilities([...CAPS, { id: 'new-cap', description: 'Drafted' }])
    expect(rig.send('j1', 'new-cap').outcome).toBe('declined')
    rig.publish()
    expect(rig.send('j2', 'new-cap').outcome).toBe('accepted')
  })
})

describe('S48 gateway yard: menu and heartbeat', () => {
  it('S48: every heartbeat is contract-valid and state follows the agents', () => {
    const rig = ready()
    rig.foreman.tick()
    expect(rig.beats.at(-1)?.state).toBe('offline') // foreman up, no agent online
    rig.foreman.agentUp('a1')
    expect(rig.beats.at(-1)?.state).toBe('online')
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.foreman.tick()
    const busy = rig.beats.at(-1)
    expect(busy?.state).toBe('busy')
    expect(busy?.workers).toEqual({ busy: 1, idle: 0 })
    expect(busy?.load).toEqual({ active_tasks: 1, queued: 0 })
    rig.foreman.pause()
    rig.foreman.tick()
    expect(rig.beats.at(-1)?.state).toBe('paused')
    for (const b of rig.beats) {
      expect(checkContract('heartbeat', b)).toBeNull()
    }
  })

  it('S48: a heartbeat goes out every 30 s even when nothing changed, and not before', () => {
    const rig = ready({}, ['a1'])
    const n = rig.beats.length
    rig.adv(29_000)
    expect(rig.beats.length).toBe(n)
    rig.adv(1_000)
    expect(rig.beats.length).toBe(n + 1)
  })

  it.each([
    ['summary', false],
    ['private', false],
    ['full', true]
  ] as const)('S48: agents are listed only at visibility full (%s -> %s)', (visibility, listed) => {
    const rig = ready({ visibility }, ['a1', 'a2'])
    rig.foreman.tick()
    const hb = rig.beats.at(-1)
    expect(hb?.agents !== undefined).toBe(listed)
    expect(checkContract('heartbeat', hb)).toBeNull()
  })

  it('S48: needs_human counts held jobs and pending line requests', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1', 'audit') // held
    rig.foreman.tick()
    expect(rig.foreman.heartbeat().needs_human).toBe(1)
  })
})

describe('S9 hop: Dispatcher to foreman to inner agent', () => {
  it('S9: the offer is accepted by the foreman, then offered to an inner agent, then claimed', () => {
    const rig = ready({}, ['a1'])
    const r = rig.send('j1')
    expect(r.outcome).toBe('accepted')
    expect(rig.events().map((e) => e.event)).toEqual(['accept'])
    expect(rig.offers).toHaveLength(1)
    expect(rig.offers[0]).toMatchObject({
      agentId: 'a1',
      offer: { taskId: 'j1', epoch: 1, capability: 'fix-bug' }
    })
    expect(rig.foreman.jobView('j1')).toMatchObject({
      state: 'accepted',
      exec: 'offered',
      holder: 'foreman'
    })
    rig.claim('j1', 'a1')
    expect(rig.foreman.jobView('j1')).toMatchObject({ exec: 'running', holder: 'a1' })
    rig.conforms()
  })

  it('S9: the foreman gives the inner agent the acceptance lines and deadline, not the requester text', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1', 'fix-bug', 'site', { extra: { deadline: '2026-10-20T00:00:00.000Z' } })
    expect(rig.offers[0].offer.acceptance).toEqual(['tests pass'])
    expect(rig.offers[0].offer.deadline).toBe('2026-10-20T00:00:00.000Z')
  })
})

describe('intake refusals (contract table: menu closed, sender not allowed, paused)', () => {
  it.each([
    ['paused', 'fix-bug', 'site', {}, true, 'paused'],
    ['unknown capability', 'nope', 'site', {}, false, 'no_such_capability'],
    ['closed capability', 'closed-cap', 'site', {}, false, 'no_such_capability'],
    ['no capability named', null, 'site', {}, false, 'no_such_capability'],
    [
      'sender not on the list',
      'fix-bug',
      'rival',
      { acceptFrom: ['friend'] },
      false,
      'not_accepted_from'
    ],
    ['night shift with nobody online', 'night-shift', 'site', {}, false, 'offline']
  ] as const)('S9: declines %s', (_n, cap, requester, cfg, pause, reason) => {
    const rig = ready(structuredClone(cfg) as Parameters<typeof ready>[0])
    if (pause) {
      rig.foreman.pause()
    }
    const r = rig.send('j1', cap, requester)
    expect(r.outcome).toBe('declined')
    expect(r.reason).toBe(reason)
    expect(rig.events().map((e) => [e.event, e.reason])).toEqual([['decline', reason]])
    expect(rig.foreman.jobView('j1').state).toBe('declined')
    rig.conforms()
  })

  it('S9: "site" in accept_from lets any sender in', () => {
    const rig = ready({ acceptFrom: ['site'] })
    expect(rig.send('j1', 'fix-bug', 'whoever').outcome).toBe('accepted')
  })

  it('S9: an offer for another yard, or one the contract rejects, is an error and creates no job', () => {
    const rig = ready()
    const bad = { ...rig.offerEvent('x'), yard: 'someone-else' }
    expect(code(() => rig.foreman.intake({ offer: bad, requester: 'site' }))).toBe('wrong_yard')
    const extra = { ...rig.offerEvent('y'), surprise: 1 } as never
    expect(code(() => rig.foreman.intake({ offer: extra, requester: 'site' }))).toBe('bad_offer')
    const wrongEvent = { ...rig.offerEvent('z'), event: 'accept' } as never
    expect(code(() => rig.foreman.intake({ offer: wrongEvent, requester: 'site' }))).toBe(
      'bad_offer'
    )
    expect(rig.foreman.jobIds()).toEqual([])
  })
})

describe('ask owner, auto-accept and budget', () => {
  it('S9: an ask-owner capability is held, the owner is told, and acceptance waits for the owner', () => {
    const rig = ready({}, ['a1'])
    const r = rig.send('j1', 'audit')
    expect(r.outcome).toBe('held')
    expect(rig.notices).toEqual([{ kind: 'job_needs_approval', taskId: 'j1' }])
    expect(rig.events()).toEqual([])
    expect(rig.offers).toHaveLength(0)
    expect(r.view.statusText).toBe('waiting for the owner')
    rig.foreman.ownerDecision('j1', 'accept', 'usr_aaron')
    expect(rig.events().map((e) => e.event)).toEqual(['accept'])
    expect(rig.offers).toHaveLength(1)
    rig.conforms()
  })

  it('S20: the owner can decline a held job and the reason is kept', () => {
    const rig = ready()
    rig.send('j1', 'audit')
    rig.foreman.ownerDecision('j1', 'decline', 'usr_aaron', 'not this week')
    expect(rig.events()).toMatchObject([{ event: 'decline', reason: 'not this week' }])
    expect(rig.foreman.jobView('j1').history).toMatchObject([
      { kind: 'decline', by: 'usr_aaron', reason: 'not this week' }
    ])
    expect(code(() => rig.foreman.ownerDecision('j1', 'accept', 'usr_aaron'))).toBe('bad_state')
  })

  it('S18: a held job nobody answers goes back after the release time', () => {
    const rig = ready()
    rig.send('j1', 'audit')
    rig.adv(24 * HOUR_MS - 1)
    expect(rig.events()).toEqual([])
    rig.adv(1)
    expect(rig.events()).toMatchObject([{ event: 'decline', reason: 'owner_no_answer' }])
  })

  it('S9: auto-accept off makes every job wait for the owner', () => {
    const rig = ready()
    rig.foreman.setAutoAccept(false)
    expect(rig.send('j1').outcome).toBe('held')
  })

  it('S9: the daily budget holds new jobs once reached, and resets the next day', () => {
    const rig = ready({ dailyBudgetUsd: 5 })
    rig.foreman.recordCost(5)
    expect(rig.send('j1').outcome).toBe('held')
    rig.adv(24 * HOUR_MS) // next UTC day
    expect(rig.send('j2').outcome).toBe('accepted')
  })
})

describe('S15 accept while every agent is offline', () => {
  it('S15: with no agent online the job is accepted within 10 s and shown "queued, not running"', () => {
    const rig = ready()
    const r = rig.send('j1')
    const accept = rig.events('accept')[0]
    expect(Date.parse(accept.at) - T0).toBeLessThanOrEqual(10_000)
    expect(r.outcome).toBe('accepted')
    expect(r.view).toMatchObject({
      state: 'accepted',
      exec: 'queued',
      queuedNotRunning: true,
      eta: null
    })
    expect(r.view.statusText).toBe('queued, not running (last contact never)')
    expect(rig.offers).toHaveLength(0)
    expect(rig.foreman.claimsOf('j1')).toEqual([])
  })

  it('S15: the status shows when the yard was last heard from', () => {
    const rig = ready({}, ['a1'])
    rig.adv(MINUTE_MS)
    rig.foreman.agentDown('a1')
    rig.adv(MINUTE_MS)
    const r = rig.send('j1')
    expect(r.view.statusText).toBe(
      `queued, not running (last contact ${new Date(T0 + MINUTE_MS).toISOString()})`
    )
    expect(r.view.lastContactAt).toBe(T0 + MINUTE_MS)
  })

  it('S15: it is never "running" until a claim exists, and the first agent to come online gets the job', () => {
    const rig = ready()
    rig.send('j1')
    expect(rig.foreman.jobView('j1').exec).not.toBe('running')
    rig.adv(HOUR_MS)
    rig.foreman.agentUp('a1')
    expect(rig.offers.map((o) => o.agentId)).toEqual(['a1'])
    expect(rig.foreman.jobView('j1').exec).toBe('offered')
    rig.claim('j1', 'a1')
    expect(rig.foreman.jobView('j1').exec).toBe('running')
  })

  it('S15: an eta is promised only while an agent is online', () => {
    const rig = ready({}, ['a1'])
    expect(rig.send('j1').view.eta).toBe(T0 + 30 * MINUTE_MS)
    const rig2 = ready()
    expect(rig2.send('j1').view.eta).toBeNull()
  })
})

describe('S16 claim with a renewing lease', () => {
  it('S16: running starts at the claim, with a 30 minute lease', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    expect(rig.foreman.jobView('j1').exec).toBe('offered')
    rig.claim('j1', 'a1')
    const v = rig.foreman.jobView('j1')
    expect(v.exec).toBe('running')
    expect(v.claim).toMatchObject({
      agentId: 'a1',
      epoch: 1,
      state: 'active',
      leaseExpiresAt: T0 + 30 * MINUTE_MS
    })
  })

  it('S16: activity renews the lease, so a working agent is not revoked', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e = rig.claim('j1', 'a1')
    rig.adv(20 * MINUTE_MS)
    rig.foreman.agentRenew('j1', 'a1', e)
    rig.adv(20 * MINUTE_MS) // 40 min in: past the first lease, inside the renewed one
    expect(rig.foreman.jobView('j1')).toMatchObject({ exec: 'running', holder: 'a1' })
    expect(rig.revokes).toHaveLength(0)
    rig.adv(11 * MINUTE_MS) // 51 min: renewed lease (50 min) lapsed
    expect(rig.revokes).toHaveLength(1)
  })

  it('S16: progress counts as activity', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e = rig.claim('j1', 'a1')
    rig.adv(25 * MINUTE_MS)
    rig.foreman.agentProgress('j1', 'a1', e, 'half done')
    rig.adv(25 * MINUTE_MS)
    expect(rig.foreman.jobView('j1').exec).toBe('running')
    expect(rig.events('progress')).toHaveLength(1)
  })

  it('S16: an unanswered offer expires after 10 minutes and goes to the next agent', () => {
    const rig = ready({}, ['a1', 'a2'])
    rig.send('j1')
    expect(rig.offers.map((o) => o.agentId)).toEqual(['a1'])
    rig.adv(10 * MINUTE_MS)
    expect(rig.offers.map((o) => o.agentId)).toEqual(['a1', 'a2'])
    expect(rig.revokes[0]).toMatchObject({ agentId: 'a1', revoke: { reason: 'offer_expired' } })
    expect(code(() => rig.foreman.agentAccept('j1', 'a1', 1))).toBe('claim_revoked')
    expect(rig.foreman.jobView('j1').history).toMatchObject([{ kind: 'timeout', agentId: 'a1' }])
  })

  it('S16: an agent that declines the offer passes it on and the decline is kept', () => {
    const rig = ready({}, ['a1', 'a2'])
    rig.send('j1')
    rig.foreman.agentDecline('j1', 'a1', 1, 'busy elsewhere')
    expect(rig.offers.map((o) => o.agentId)).toEqual(['a1', 'a2'])
    expect(rig.foreman.jobView('j1').history).toMatchObject([
      { kind: 'decline', agentId: 'a1', reason: 'busy elsewhere' }
    ])
  })

  it('S16: one agent runs one job at a time; the next job waits queued, then is offered when it frees up', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.send('j2')
    const e = rig.claim('j1', 'a1')
    expect(rig.foreman.jobView('j2')).toMatchObject({ exec: 'queued', queuedNotRunning: true })
    expect(rig.offers).toHaveLength(1)
    rig.done('j1', 'a1', e)
    expect(rig.offers.map((o) => o.offer.taskId)).toEqual(['j1', 'j2'])
  })
})

describe('S17 revoke on lapse, refuse late done', () => {
  function lapsed() {
    const rig = ready({}, ['a1', 'a2'])
    rig.send('j1')
    const e1 = rig.claim('j1', 'a1')
    return { rig, e1 }
  }

  it('S17: the lapsed claim is revoked BEFORE the job is offered to another agent', () => {
    const { rig } = lapsed()
    rig.adv(30 * MINUTE_MS)
    const revokeAt = rig.calls.indexOf('revoke:a1:j1:e1')
    const offerAt = rig.calls.findIndex((c) => c.startsWith('offer:a2:j1'))
    expect(revokeAt).toBeGreaterThan(-1)
    expect(offerAt).toBeGreaterThan(revokeAt)
    expect(rig.revokes[0].revoke.reason).toBe('lease_lapsed')
    const claims = rig.foreman.claimsOf('j1')
    expect(claims[0]).toMatchObject({ agentId: 'a1', state: 'revoked', endReason: 'lease_lapsed' })
    expect(claims[1].epoch).toBeGreaterThan(claims[0].epoch + 1) // epoch moved on at revoke
  })

  it('S17: a "done" from the revoked agent is refused, even when no tick ran since the lease ended', () => {
    const { rig, e1 } = lapsed()
    rig.skip(31 * MINUTE_MS) // nothing has run yet: the call itself must catch up first
    expect(code(() => rig.done('j1', 'a1', e1))).toBe('claim_revoked')
    expect(rig.events('done')).toHaveLength(0)
    expect(rig.calls).toContain('revoke:a1:j1:e1')
  })

  it('S17: a revoked agent cannot renew, progress or accept again', () => {
    const { rig, e1 } = lapsed()
    rig.adv(31 * MINUTE_MS)
    expect(code(() => rig.foreman.agentRenew('j1', 'a1', e1))).toBe('claim_revoked')
    expect(code(() => rig.foreman.agentProgress('j1', 'a1', e1))).toBe('claim_revoked')
    expect(code(() => rig.foreman.agentAccept('j1', 'a1', e1))).toBe('claim_revoked')
  })

  it('S17: the new holder finishes the job normally, and the old epoch stays refused', () => {
    const { rig, e1 } = lapsed()
    rig.adv(31 * MINUTE_MS)
    const e2 = rig.claim('j1', 'a2')
    expect(code(() => rig.done('j1', 'a1', e2))).toBe('claim_revoked') // wrong agent for that epoch
    expect(code(() => rig.done('j1', 'a1', e1))).toBe('claim_revoked')
    rig.done('j1', 'a2', e2)
    rig.verify('j1')
    expect(rig.foreman.jobView('j1').state).toBe('verified')
    rig.conforms()
  })

  it('S17: with one laptop only, the job waits queued after the revoke instead of going back to it', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.adv(30 * MINUTE_MS)
    expect(rig.foreman.jobView('j1')).toMatchObject({
      exec: 'queued',
      queuedNotRunning: true,
      holder: 'foreman'
    })
    expect(rig.offers).toHaveLength(1)
  })
})

describe('S18 hold and release', () => {
  it('S18: defaults are 4 h to tell the owner and 24 h to hand the job back', () => {
    const rig = ready()
    rig.send('j1')
    rig.adv(4 * HOUR_MS - 1)
    expect(rig.notices).toEqual([])
    rig.adv(1)
    expect(rig.notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    rig.adv(20 * HOUR_MS - 1)
    expect(rig.events('cancel')).toHaveLength(0)
    expect(rig.foreman.jobView('j1').exec).toBe('queued')
    rig.adv(1)
    expect(rig.events('cancel')).toMatchObject([{ reason: 'released: yard_offline' }])
    expect(rig.notices.map((n) => n.kind)).toEqual(['job_held_offline', 'job_released'])
    expect(rig.foreman.jobView('j1')).toMatchObject({ state: 'cancelled', exec: null })
    rig.conforms()
  })

  it.each([
    [{ holdMs: HOUR_MS, releaseMs: 2 * HOUR_MS }, HOUR_MS, 2 * HOUR_MS],
    [{ holdMs: 10 * MINUTE_MS, releaseMs: 30 * MINUTE_MS }, 10 * MINUTE_MS, 30 * MINUTE_MS]
  ])('S18: hold and release times are settings (%j)', (cfg, hold, release) => {
    const rig = ready(cfg)
    rig.send('j1')
    rig.adv(hold)
    expect(rig.notices.map((n) => n.kind)).toEqual(['job_held_offline'])
    rig.adv(release - hold)
    expect(rig.events('cancel')).toHaveLength(1)
  })

  it('S18: the owner is told once, even if the job sits queued for hours', () => {
    const rig = ready()
    rig.send('j1')
    rig.adv(10 * HOUR_MS)
    expect(rig.notices.filter((n) => n.kind === 'job_held_offline')).toHaveLength(1)
  })

  it('S18: a job an agent is running is neither flagged nor released', () => {
    const rig = ready({ leaseMs: 100 * HOUR_MS }, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.adv(30 * HOUR_MS)
    expect(rig.notices).toEqual([])
    expect(rig.events('cancel')).toHaveLength(0)
    expect(rig.foreman.jobView('j1').exec).toBe('running')
  })

  it('S18: released while an offer is still unanswered revokes that offer first', () => {
    const rig = ready({ offerMs: 100 * HOUR_MS }, ['a1'])
    rig.send('j1')
    rig.adv(24 * HOUR_MS)
    expect(rig.calls.indexOf('revoke:a1:j1:e1')).toBeLessThan(rig.calls.indexOf('out:cancel:j1'))
  })
})

describe('S19 / S20 decline, reroute and history', () => {
  it('S20: the owner declines an accepted job; it leaves as a cancel that says why, and history is kept', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.foreman.decline('j1', 'usr_aaron', 'wrong yard for this')
    expect(rig.events('cancel')).toMatchObject([{ reason: 'declined: wrong yard for this' }])
    expect(rig.revokes[0].revoke.reason).toBe('job_closed')
    expect(rig.foreman.jobView('j1').history).toMatchObject([
      { kind: 'decline', by: 'usr_aaron', reason: 'wrong yard for this' }
    ])
    rig.conforms()
  })

  it('S20: a reroute revokes the old claim first, offers the chosen agent, and records both', () => {
    const rig = ready({}, ['a1', 'a2'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.foreman.reroute('j1', { toAgent: 'a2', by: 'usr_aaron', reason: 'a2 knows this repo' })
    expect(rig.calls.indexOf('revoke:a1:j1:e1')).toBeLessThan(
      rig.calls.findIndex((c) => c.startsWith('offer:a2'))
    )
    expect(rig.foreman.jobView('j1').history).toMatchObject([
      {
        kind: 'reroute',
        by: 'usr_aaron',
        reason: 'a2 knows this repo',
        agentId: 'a1',
        toAgentId: 'a2'
      }
    ])
    expect(code(() => rig.done('j1', 'a1', 1))).toBe('claim_revoked')
  })

  it('S20: a job rerouted 3 times goes to a person and is not offered again', () => {
    const rig = ready({}, ['a1', 'a2', 'a3', 'a4'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.foreman.reroute('j1', { toAgent: 'a2', by: 'usr_aaron' })
    rig.foreman.reroute('j1', { toAgent: 'a3', by: 'usr_aaron' })
    const offered = rig.offers.length
    rig.foreman.reroute('j1', { toAgent: 'a4', by: 'usr_aaron' })
    expect(rig.offers).toHaveLength(offered)
    expect(rig.foreman.jobView('j1')).toMatchObject({ needsHuman: true, exec: 'queued' })
    expect(rig.notices.at(-1)).toEqual({ kind: 'needs_human', taskId: 'j1' })
    expect(rig.foreman.jobView('j1').history.filter((h) => h.kind === 'reroute')).toHaveLength(3)
  })

  it('S20: a reroute saved as a rule routes the next matching job the same way', () => {
    const rig = ready({}, ['a1'])
    rig.foreman.agentUp('a2', { capacity: 3 })
    rig.send('j1', 'fix-bug', 'friend')
    rig.claim('j1', 'a1')
    rig.foreman.reroute('j1', { toAgent: 'a2', by: 'usr_aaron', makeRule: true })
    expect(rig.foreman.rules()).toMatchObject([
      {
        match: { capability: 'fix-bug', fromYard: 'friend' },
        action: { agentId: 'a2' },
        source: 'correction'
      }
    ])
    rig.send('j2', 'fix-bug', 'friend') // a1 is free and sorts first, but the rule wins
    expect(rig.offers.at(-1)).toMatchObject({ agentId: 'a2', offer: { taskId: 'j2' } })
    rig.send('j3', 'fix-bug', 'someone-else') // different sender: no rule
    expect(rig.offers.at(-1)).toMatchObject({ agentId: 'a1', offer: { taskId: 'j3' } })
  })

  it('S20: only an accepted live job can be rerouted', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1', 'audit') // held
    expect(code(() => rig.foreman.reroute('j1', { toAgent: 'a1', by: 'x' }))).toBe('bad_state')
    expect(code(() => rig.foreman.reroute('nope', { toAgent: 'a1', by: 'x' }))).toBe('unknown_task')
  })

  it("S19: routing to inner agents follows rule, then the requester's preference, then the least loaded", () => {
    const rig = ready()
    for (const a of ['a1', 'a2', 'a3']) {
      rig.foreman.agentUp(a, { capacity: 2 })
    }
    rig.foreman.addRule({ capability: 'review-pr' }, { agentId: 'a3' })
    rig.send('r1', 'review-pr')
    expect(rig.offers.at(-1)?.agentId).toBe('a3') // rule
    rig.send('p1', 'fix-bug', 'site', { preferAgent: 'a2' })
    expect(rig.offers.at(-1)?.agentId).toBe('a2') // preference
    rig.send('l1', 'fix-bug')
    expect(rig.offers.at(-1)?.agentId).toBe('a1') // least loaded, then by id
    rig.send('l2', 'fix-bug')
    expect(rig.offers.at(-1)?.agentId).toBe('a1') // all equal: by id
    rig.send('l3', 'fix-bug')
    expect(rig.offers.at(-1)?.agentId).toBe('a2') // a1 now holds two: load beats id
  })

  it('S19: an agent list on a capability limits who may take it; away agents are skipped', () => {
    const rig = makeRig({}, [{ id: 'fix-bug', description: 'x', agents: ['a2'] }])
    rig.publish()
    rig.foreman.agentUp('a1')
    rig.foreman.agentUp('a2')
    rig.foreman.agentAway('a2', true)
    rig.send('j1')
    expect(rig.offers).toHaveLength(0)
    rig.foreman.agentAway('a2', false)
    expect(rig.offers.map((o) => o.agentId)).toEqual(['a2'])
  })

  it('S19: after three agents turn a job down the owner is told once and no fourth is asked', () => {
    const rig = ready({}, ['a1', 'a2', 'a3', 'a4'])
    rig.send('j1')
    for (const [i, a] of ['a1', 'a2', 'a3'].entries()) {
      rig.foreman.agentDecline('j1', a, i + 1)
    }
    expect(rig.offers.map((o) => o.agentId)).toEqual(['a1', 'a2', 'a3'])
    expect(rig.notices.filter((n) => n.kind === 'job_unclaimed')).toEqual([
      { kind: 'job_unclaimed', taskId: 'j1' }
    ])
    rig.adv(HOUR_MS)
    expect(rig.notices.filter((n) => n.kind === 'job_unclaimed')).toHaveLength(1)
  })
})

describe('S21 idempotency', () => {
  it('S21: the same offer delivered twice makes one job, one accept and one offer to an agent', () => {
    const rig = ready({}, ['a1'])
    const first = rig.send('j1')
    const second = rig.send('j1')
    expect(first.outcome).toBe('accepted')
    expect(second.outcome).toBe('duplicate')
    expect(rig.foreman.jobIds()).toEqual(['j1'])
    expect(rig.events('accept')).toHaveLength(1)
    expect(rig.offers).toHaveLength(1)
  })

  it('S21: a declined offer redelivered does not decline twice', () => {
    const rig = ready()
    rig.send('j1', 'nope')
    expect(rig.send('j1', 'nope').outcome).toBe('duplicate')
    expect(rig.events('decline')).toHaveLength(1)
  })

  it('S21: a redelivery after the agent started work changes nothing', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    expect(rig.send('j1').view).toMatchObject({ exec: 'running', holder: 'a1' })
    expect(rig.offers).toHaveLength(1)
  })

  it('S21: accepting the same offer twice is a no-op for the same agent and an error for any other', () => {
    const rig = ready({}, ['a1', 'a2'])
    rig.send('j1')
    expect(rig.foreman.agentAccept('j1', 'a1', 1)).toEqual({ duplicate: false })
    expect(rig.foreman.agentAccept('j1', 'a1', 1)).toEqual({ duplicate: true })
    expect(code(() => rig.foreman.agentAccept('j1', 'a2', 1))).toBe('claim_taken')
    expect(rig.foreman.claimsOf('j1')).toHaveLength(1)
  })

  it('S21: a repeated "done" is one done event and one execution', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e = rig.claim('j1', 'a1')
    expect(rig.done('j1', 'a1', e)).toEqual({ duplicate: false })
    expect(rig.done('j1', 'a1', e)).toEqual({ duplicate: true })
    expect(rig.events('done')).toHaveLength(1)
  })

  it('S21: a done the contract rejects leaves the claim alone', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e = rig.claim('j1', 'a1')
    const bad = (): unknown =>
      rig.foreman.agentDone('j1', 'a1', e, {
        revisionSha: 'not-a-sha',
        evidence: [{ kind: 'sha', ref: SHA }]
      })
    expect(code(bad)).toBe('bad_event')
    expect(rig.foreman.jobView('j1')).toMatchObject({ exec: 'running', state: 'accepted' })
  })
})

describe('closing a job', () => {
  it('S16: verify pass finishes the job and ends its cards', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e = rig.claim('j1', 'a1')
    const card = rig.foreman.cards.start('a1', { title: 'Fix login bug', jobId: 'j1' })
    rig.done('j1', 'a1', e)
    rig.verify('j1')
    expect(rig.foreman.jobView('j1')).toMatchObject({ state: 'verified', exec: null })
    expect(rig.foreman.cards.get(card.id)?.state).toBe('done')
    rig.conforms()
  })

  it('S35 (yard side): a reject sends the job back to the same agent; the third send-back goes to a person', () => {
    const rig = ready({}, ['a1', 'a2'])
    rig.send('j1')
    let e = rig.claim('j1', 'a1')
    for (let i = 1; i <= 3; i++) {
      rig.done('j1', 'a1', e)
      rig.verify('j1', 'reject')
      if (i < 3) {
        e = rig.claim('j1', 'a1')
      }
    }
    expect(rig.offers.map((o) => o.agentId)).toEqual(['a1', 'a1', 'a1'])
    expect(rig.foreman.jobView('j1')).toMatchObject({ state: 'accepted', needsHuman: true })
    expect(rig.notices.at(-1)).toEqual({ kind: 'needs_human', taskId: 'j1' })
    rig.conforms()
  })

  it('S16: a cancel from the requester revokes the live claim and tells the agent to stop', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.inbound({ task_id: 'j1', event: 'cancel', reason: 'no longer needed' })
    expect(rig.revokes).toMatchObject([{ agentId: 'a1', revoke: { reason: 'job_closed' } }])
    expect(rig.foreman.jobView('j1')).toMatchObject({ state: 'cancelled', exec: null })
    rig.adv(48 * HOUR_MS)
    expect(rig.notices).toEqual([]) // its timers died with it
  })

  it('S16: events the foreman cannot take inbound are refused', () => {
    const rig = ready()
    rig.send('j1')
    expect(code(() => rig.inbound({ task_id: 'j1', event: 'progress' }))).toBe('bad_event')
    expect(code(() => rig.verify('j1'))).toBe('bad_state') // verify before done
  })
})
