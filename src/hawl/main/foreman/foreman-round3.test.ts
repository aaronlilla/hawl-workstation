// Foreman tests, part 4: defects found by the round 2 critic. Each test names its S-line.
import { describe, expect, it } from 'vitest'
import { checkContract } from '../../shared/gateway-contract/contract'
import { checkExtendedMenu, checkHandBack } from './m2-schemas'
import { HOUR_MS, MINUTE_MS, T0, code, makeRig, ready } from './rig.test-support'

const DAY_MS = 24 * HOUR_MS

describe('S16/S17/S18 a yard with one agent does not get stuck', () => {
  it('S17: the sole agent restarts after its lease lapsed and is offered the job again', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e1 = rig.claim('j1', 'a1')
    rig.adv(31 * MINUTE_MS)
    expect(rig.offers).toHaveLength(1)
    rig.foreman.agentUp('a1')
    expect(rig.offers).toHaveLength(2)
    // The revoke used epoch e1 + 1, so the new offer is e1 + 2: an old epoch can never be mistaken for a new one.
    expect(rig.offers[1]).toMatchObject({ agentId: 'a1', offer: { epoch: e1 + 2 } })
    const e2 = rig.claim('j1', 'a1')
    expect(code(() => rig.done('j1', 'a1', e1))).toBe('claim_revoked')
    rig.done('j1', 'a1', e2)
    rig.verify('j1')
    expect(rig.foreman.jobView('j1').state).toBe('verified')
    rig.conforms()
  })

  it('S16: the sole agent missed the offer (10 min), comes back, and is offered the job again', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.adv(11 * MINUTE_MS)
    expect(rig.foreman.jobView('j1')).toMatchObject({ exec: 'queued' })
    expect(rig.offers).toHaveLength(1)
    rig.foreman.agentUp('a1')
    expect(rig.offers).toHaveLength(2)
  })

  it('S16: an agent that said no is not offered the same job again just because it restarted', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.agentDecline('j1', 'a1', 1, 'not my repo')
    rig.foreman.agentUp('a1')
    expect(rig.offers).toHaveLength(1)
  })

  it('S18: the sole agent declined and stays online: the owner is told at the hold time, not left in the dark', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.agentDecline('j1', 'a1', 1)
    rig.adv(4 * HOUR_MS - MINUTE_MS)
    expect(rig.notices).toEqual([])
    rig.adv(MINUTE_MS)
    expect(rig.notices).toEqual([{ kind: 'job_unclaimed', taskId: 'j1' }])
    rig.adv(HOUR_MS)
    expect(rig.notices).toHaveLength(1)
  })

  it('S48: a job nobody in the yard would take counts as needing the owner in the heartbeat', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.agentDecline('j1', 'a1', 1)
    rig.adv(4 * HOUR_MS)
    expect(rig.beats.at(-1)).toMatchObject({ needs_human: 1 })
  })

  it('S18: handed back after 24 h with the true reason: nobody took it, not "yard offline"', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.agentDecline('j1', 'a1', 1)
    rig.adv(DAY_MS)
    expect(rig.handBacks).toEqual([{ taskId: 'j1', op: 'release', reason: 'no_agent_took_it' }])
  })

  it('S18: the hand-back reason is "yard_offline" when nobody was online', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.agentDown('a1')
    rig.adv(DAY_MS)
    expect(rig.handBacks).toEqual([{ taskId: 'j1', op: 'release', reason: 'yard_offline' }])
  })

  it('S18: a job queued behind a busy agent is not flagged at 4 h, and is handed back as "yard_busy"', () => {
    const rig = ready({ leaseMs: 40 * MINUTE_MS }, ['a1'])
    rig.send('j1')
    const e = rig.claim('j1', 'a1')
    rig.send('j2')
    for (let i = 0; i < 72; i++) {
      rig.adv(20 * MINUTE_MS)
      rig.foreman.agentRenew('j1', 'a1', e)
    }
    expect(rig.notices.filter((n) => n.taskId === 'j2')).toEqual([
      { kind: 'job_released', taskId: 'j2' }
    ])
    expect(rig.handBacks).toEqual([{ taskId: 'j2', op: 'release', reason: 'yard_busy' }])
  })

  it('S20: after "nobody took it" the owner can have the job tried again', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.agentDecline('j1', 'a1', 1)
    expect(code(() => rig.foreman.resolveNeedsHuman('j1', 'usr_aaron'))).toBe('bad_state')
    rig.adv(4 * HOUR_MS)
    rig.foreman.resolveNeedsHuman('j1', 'usr_aaron', 'try again')
    expect(rig.offers).toHaveLength(2)
  })
})

describe('S21 a handed-back job can come back, an ended one stays one job', () => {
  it('S21: a job handed back by the owner and offered again later is a new offer, with its history kept', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e1 = rig.claim('j1', 'a1')
    rig.foreman.decline('j1', 'usr_aaron', 'wrong yard')
    expect(rig.foreman.jobView('j1').state).toBe('reassigned')
    rig.adv(HOUR_MS)
    const again = rig.send('j1')
    expect(again.outcome).toBe('accepted')
    expect(rig.foreman.jobView('j1').state).toBe('accepted')
    expect(rig.foreman.jobView('j1').history.map((h) => h.kind)).toEqual(['decline', 'reoffer'])
    expect(rig.offers.at(-1)?.offer.epoch).toBeGreaterThan(e1)
    expect(code(() => rig.done('j1', 'a1', e1))).toBe('claim_revoked')
    const e2 = rig.claim('j1', 'a1')
    rig.done('j1', 'a1', e2)
    rig.verify('j1')
    expect(rig.foreman.jobView('j1').state).toBe('verified')
    rig.conforms()
  })

  it('S21: a job released after 24 h and offered again is a new offer too', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.agentDown('a1')
    rig.adv(DAY_MS)
    expect(rig.foreman.jobView('j1').state).toBe('reassigned')
    rig.adv(MINUTE_MS)
    rig.foreman.agentUp('a1')
    expect(rig.send('j1').outcome).toBe('accepted')
    expect(rig.offers.at(-1)).toMatchObject({ agentId: 'a1' })
    rig.conforms()
  })

  it('S21: the same hand-back offer delivered twice is still one job', () => {
    const rig = ready({}, ['a1'])
    const first = rig.offerEvent('j1')
    rig.foreman.intake({ offer: first, requester: 'site' })
    rig.foreman.decline('j1', 'usr_aaron', 'no')
    expect(rig.foreman.intake({ offer: first, requester: 'site' }).outcome).toBe('duplicate')
    expect(rig.foreman.jobView('j1').state).toBe('reassigned')
  })

  it('S21: a job declined while paused is the same job after resume, whether or not it was forgotten', () => {
    const rig = ready({}, ['a1'])
    rig.foreman.pause()
    const offer = rig.offerEvent('j1')
    expect(rig.foreman.intake({ offer, requester: 'site' }).outcome).toBe('declined')
    rig.foreman.resume()
    expect(rig.foreman.intake({ offer, requester: 'site' }).outcome).toBe('duplicate')
    rig.adv(31 * DAY_MS)
    expect(rig.foreman.jobIds()).toEqual([])
    const late = rig.foreman.intake({ offer, requester: 'site' })
    expect(late.outcome).toBe('duplicate')
    expect(late.view.state).toBe('declined')
    expect(rig.events('accept')).toHaveLength(0)
  })

  it('S21: a forgotten handed-back job can still be offered again, but its old offer is a duplicate', () => {
    const rig = ready({}, ['a1'])
    const first = rig.offerEvent('j1')
    rig.foreman.intake({ offer: first, requester: 'site' })
    rig.foreman.decline('j1', 'usr_aaron', 'no')
    rig.adv(31 * DAY_MS)
    expect(rig.foreman.jobIds()).toEqual([])
    expect(rig.foreman.intake({ offer: first, requester: 'site' }).outcome).toBe('duplicate')
    expect(rig.send('j1').outcome).toBe('accepted')
  })

  it('S21: tombstones survive snapshot and restore', () => {
    const a = ready()
    a.foreman.pause()
    const offer = a.offerEvent('j1')
    a.foreman.intake({ offer, requester: 'site' })
    a.adv(31 * DAY_MS)
    const b = makeRig()
    b.foreman.restore(JSON.parse(JSON.stringify(a.foreman.snapshot())))
    expect(b.foreman.intake({ offer, requester: 'site' }).outcome).toBe('duplicate')
  })
})

describe('S19 every routing decision says why', () => {
  it('S19: the job and the offer carry the reason and the agents passed over', () => {
    const rig = ready({}, ['a1', 'a2'])
    rig.foreman.agentUp('a3')
    rig.foreman.agentAway('a3', true)
    rig.send('j1')
    expect(rig.offers[0].offer.why).toBe('least loaded')
    expect(rig.foreman.jobView('j1').routing).toMatchObject([
      {
        agentId: 'a1',
        epoch: 1,
        via: 'least loaded',
        skipped: [
          { agentId: 'a3', why: 'away' },
          { agentId: 'a2', why: 'not chosen' }
        ]
      }
    ])
  })

  it('S19: a rule that routed the job is named', () => {
    const rig = ready({}, ['a1', 'a2'])
    const id = rig.foreman.addRule({ capability: 'fix-bug' }, { agentId: 'a2' })
    rig.send('j1')
    expect(rig.foreman.jobView('j1').routing[0]).toMatchObject({
      agentId: 'a2',
      via: `rule ${id} (owner)`
    })
    expect(rig.offers[0].offer.why).toBe(`rule ${id} (owner)`)
  })

  it('S19: the requester preference, and agents that already turned it down, are shown', () => {
    const rig = ready({}, ['a1', 'a2', 'a3'])
    rig.send('j1', 'fix-bug', 'site', { preferAgent: 'a2' })
    expect(rig.foreman.jobView('j1').routing[0]).toMatchObject({
      agentId: 'a2',
      via: 'requester preference'
    })
    rig.foreman.agentDecline('j1', 'a2', 1)
    expect(rig.foreman.jobView('j1').routing[1]).toMatchObject({
      agentId: 'a1',
      via: 'least loaded',
      skipped: [
        { agentId: 'a2', why: 'already tried' },
        { agentId: 'a3', why: 'not chosen' }
      ]
    })
  })

  it('S19: a busy agent and an agent outside the capability list are named as such', () => {
    const rig = ready({}, ['a1', 'a2'])
    rig.foreman.agentUp('a3')
    rig.setCaps([{ id: 'fix-bug', description: 'x', agents: ['a1', 'a2'] }])
    rig.publish()
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.send('j2')
    expect(rig.foreman.jobView('j2').routing[0]).toMatchObject({
      agentId: 'a2',
      skipped: expect.arrayContaining([
        { agentId: 'a1', why: 'busy' },
        { agentId: 'a3', why: 'not allowed for this capability' }
      ])
    })
  })
})

describe('S20 an explicit pick beats a standing rule', () => {
  it('S20/S35: a send-back goes to the agent that did the work, even if a newer rule names another', () => {
    const rig = ready({}, ['a1', 'a2'])
    rig.foreman.addRule({ capability: 'fix-bug' }, { agentId: 'a2' })
    rig.send('j1')
    const e = rig.claim('j1', 'a2')
    rig.foreman.addRule({ capability: 'fix-bug' }, { agentId: 'a1' })
    rig.done('j1', 'a2', e)
    rig.verify('j1', 'reject')
    expect(rig.offers.at(-1)).toMatchObject({ agentId: 'a2' })
    expect(rig.foreman.jobView('j1').routing.at(-1)?.via).toContain('pinned')
  })

  it('S20: the agent the owner reroutes a job to gets it, whatever the rules say', () => {
    const rig = ready({}, ['a1', 'a2', 'a3'])
    rig.foreman.addRule({ capability: 'fix-bug' }, { agentId: 'a3' })
    rig.send('j1')
    rig.claim('j1', 'a3')
    rig.foreman.reroute('j1', { toAgent: 'a2', by: 'usr_aaron' })
    expect(rig.offers.at(-1)).toMatchObject({ agentId: 'a2' })
  })
})

describe('S11/S20 the m2 shapes are checked against a schema', () => {
  it('S11: the extended menu the foreman publishes fits the m2 menu additions', () => {
    const rig = ready()
    const { extended } = rig.publish()
    expect(checkExtendedMenu(extended)).toBeNull()
    expect(checkContract('menu', rig.menus.at(-1)?.menu)).toBeNull()
  })

  it('S11: a field outside the m2 list, or a value outside its range, is refused', () => {
    const rig = ready()
    const ext = structuredClone(rig.publish().extended) as Record<string, unknown>
    expect(checkExtendedMenu({ ...ext, surprise: 1 })).toMatch(/not allowed/)
    expect(checkExtendedMenu({ ...ext, direct_lines: 'sometimes' })).toMatch(/enum/)
    expect(checkExtendedMenu({ ...ext, hold_minutes: 0 })).toMatch(/minimum/)
  })

  it('S11: a menu whose station ids are not vil_ ids is not sent', () => {
    const rig = makeRig()
    rig.setCaps([{ id: 'fix-bug', description: 'x', stations: ['laptop'] }])
    expect(code(() => rig.publish())).toBe('bad_menu')
    expect(rig.menus).toHaveLength(0)
  })

  it('S20: the hand-back body is exactly {op: decline|release, reason?}', () => {
    expect(checkHandBack('decline', 'wrong yard')).toBeNull()
    expect(checkHandBack('release', '')).toBeNull()
    expect(checkHandBack('hold', 'x')).toMatch(/enum/)
    expect(checkHandBack('decline', 'x'.repeat(501))).toMatch(/too long/)
  })

  it('S20: a hand-back with no reason sends the op as the reason, so the body is always valid', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.decline('j1', 'usr_aaron', '')
    expect(rig.handBacks).toEqual([{ taskId: 'j1', op: 'decline', reason: 'decline' }])
  })
})

describe('S9 an offer with no capability', () => {
  it('S9: is held for the owner by default, with the acceptance lines, and runs once the owner accepts', () => {
    const rig = ready({}, ['a1'])
    const r = rig.send('j1', null)
    expect(r.outcome).toBe('held')
    expect(rig.notices).toEqual([{ kind: 'job_needs_approval', taskId: 'j1' }])
    rig.foreman.ownerDecision('j1', 'accept', 'usr_aaron')
    expect(rig.offers[0]).toMatchObject({
      agentId: 'a1',
      offer: { capability: null, acceptance: ['tests pass'] }
    })
    rig.conforms()
  })

  it('S9: is accepted at once when the owner chose freeformApproval auto', () => {
    const rig = ready({ freeformApproval: 'auto' }, ['a1'])
    expect(rig.send('j1', null).outcome).toBe('accepted')
    expect(rig.offers).toHaveLength(1)
  })

  it('S9: is still refused when paused or from a sender that is not allowed', () => {
    const a = ready({ freeformApproval: 'auto', acceptFrom: ['friend'] })
    expect(a.send('j1', null, 'rival')).toMatchObject({
      outcome: 'declined',
      reason: 'not_accepted_from'
    })
    const b = ready({ freeformApproval: 'auto' })
    b.foreman.pause()
    expect(b.send('j2', null)).toMatchObject({ outcome: 'declined', reason: 'paused' })
  })
})

describe('restart: agents and heartbeat survive', () => {
  it('S17: a restored foreman knows its agents (offline until they announce) and a claim survives their return', () => {
    const a = ready({}, ['a1'])
    a.foreman.agentUp('a2', { label: 'Laptop 2', capacity: 2 })
    a.send('j1')
    const e = a.claim('j1', 'a1')
    a.adv(5 * MINUTE_MS)
    const b = makeRig()
    b.foreman.restore(JSON.parse(JSON.stringify(a.foreman.snapshot())))
    expect(b.foreman.agents()).toMatchObject([
      { id: 'a1', online: false },
      { id: 'a2', label: 'Laptop 2', capacity: 2, online: false }
    ])
    b.foreman.agentUp('a1')
    b.foreman.agentRenew('j1', 'a1', e)
    expect(b.foreman.jobView('j1')).toMatchObject({ holder: 'a1', exec: 'running' })
  })

  it('S48: the heartbeat clock restores, so a restart does not re-send an unchanged beat', () => {
    const a = ready()
    a.adv(10_000)
    expect(a.beats).toHaveLength(1)
    const snap = JSON.parse(JSON.stringify(a.foreman.snapshot()))
    expect(snap.lastBeatAt).not.toBeNull()
    const b = makeRig()
    b.skip(10_000)
    b.foreman.restore(snap)
    b.foreman.tick()
    expect(b.beats).toHaveLength(0)
    // The 30 s cadence continues from the restored time (the first beat went out at T0), not from the restart.
    b.adv(19_000)
    expect(b.beats).toHaveLength(0)
    b.adv(2_000)
    expect(b.beats).toHaveLength(1)
    b.adv(10_000)
    expect(b.beats).toHaveLength(1)
  })

  it('S17: a snapshot from before agents and tombstones were saved still restores', () => {
    const a = ready({}, ['a1'])
    a.send('j1')
    const snap = JSON.parse(JSON.stringify(a.foreman.snapshot()))
    // A real old file has no version and none of the later fields.
    for (const k of ['version', 'agents', 'tombs', 'lastBeatAt', 'lastBeatSig', 'outbox', 'outSeq', 'dead', 'settings', 'savedAt']) {
      delete snap[k]
    }
    for (const j of snap.jobs) {
      delete j.pinAgent
      delete j.routing
      delete j.offerAt
      delete j.transferred
    }
    const b = makeRig()
    b.foreman.restore(snap)
    b.foreman.agentUp('a1')
    expect(b.foreman.jobView('j1').routing).toEqual([])
    expect(b.send('j1').outcome).toBe('duplicate')
  })
})

describe('S15 handover is one-way until the job is adopted back', () => {
  it('S15: held jobs are exported too, and adopted as held (still waiting for the owner)', () => {
    const a = ready()
    a.send('jAudit', 'audit')
    a.send('jFix')
    const exported = a.foreman.exportQueue()
    expect(exported.map((e) => [e.offer.task_id, e.held ?? false])).toEqual([
      ['jAudit', true],
      ['jFix', false]
    ])
    const b = ready()
    b.foreman.adoptQueue(JSON.parse(JSON.stringify(exported)))
    expect(b.foreman.jobView('jAudit')).toMatchObject({ state: 'asked', exec: 'held' })
    expect(b.notices).toEqual([])
    b.foreman.ownerDecision('jAudit', 'accept', 'usr_aaron')
    expect(b.foreman.jobView('jAudit').state).toBe('accepted')
  })

  it('S15: an exported job gets no hold notice, release or offer from this foreman', () => {
    const rig = ready({}, ['a1'])
    rig.foreman.agentDown('a1')
    rig.send('j1')
    rig.foreman.exportQueue()
    rig.foreman.agentUp('a1')
    rig.adv(DAY_MS + HOUR_MS)
    expect(rig.offers).toHaveLength(0)
    expect(rig.notices).toEqual([])
    expect(rig.handBacks).toEqual([])
    expect(code(() => rig.foreman.decline('j1', 'usr_aaron', 'no'))).toBe('bad_state')
  })

  it('S15: the offer an agent has not answered is withdrawn when the job is exported', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.foreman.exportQueue()
    expect(rig.revokes).toMatchObject([{ agentId: 'a1', revoke: { reason: 'handed_over' } }])
    expect(code(() => rig.foreman.agentAccept('j1', 'a1', 1))).toBe('claim_revoked')
  })

  it('S15: adopting an exported job back returns it, with the service accept time for the clocks', () => {
    const rig = ready()
    rig.send('j1')
    const exported = rig.foreman.exportQueue()
    rig.adv(5 * HOUR_MS)
    expect(rig.notices).toEqual([])
    const back = JSON.parse(JSON.stringify([{ ...exported[0], ownerNotified: true }]))
    expect(rig.foreman.adoptQueue(back).adopted).toEqual(['j1'])
    rig.adv(MINUTE_MS)
    expect(rig.notices).toEqual([])
    rig.foreman.agentUp('a1')
    expect(rig.offers).toHaveLength(1)
    rig.adv(18 * HOUR_MS)
    expect(rig.handBacks).toEqual([])
    rig.adv(2 * HOUR_MS)
    expect(rig.handBacks).toMatchObject([{ op: 'release' }])
  })

  it('S21: a job already running here is skipped when the service lists it', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const offer = rig.offerEvent('j1')
    expect(rig.foreman.adoptQueue([{ offer, requester: 'site', acceptedAt: T0 }])).toEqual({
      adopted: [],
      skipped: ['j1']
    })
  })
})
