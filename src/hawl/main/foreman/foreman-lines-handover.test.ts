// Foreman tests, part 2: direct lines (S10), paused foreman, offline queue handover
// (S15 decision, S18, S21), restart (S17, S18) and contract conformance (S48).
import { describe, expect, it } from 'vitest'
import { checkContract } from '../../shared/gateway-contract/contract'
import { HOUR_MS, MINUTE_MS, T0, code, makeRig, ready, type Rig } from './rig.test-support'

describe('S10 direct lines', () => {
  function lineRig(policy: 'job_parties' | 'ask_owner' | 'never') {
    const rig = ready({ directLines: policy }, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    return rig
  }
  const open = (rig: Rig, extra: { origin?: 'local' | 'remote'; ttlMinutes?: number } = {}) =>
    rig.foreman.openLine('j1', {
      fromInner: 'a1',
      toVillage: 'qa-yard',
      purpose: 'ask about the test setup',
      ttlMinutes: 60,
      ...extra
    })
  const state = (rig: Rig) => rig.foreman.jobView('j1').line?.state

  it.each([
    ['ask_owner', 'owner yes then remote yes', 'open'],
    ['ask_owner', 'remote yes then owner yes', 'open'],
    ['ask_owner', 'owner yes, remote no', 'rejected'],
    ['ask_owner', 'owner no', 'rejected'],
    ['job_parties', 'remote yes', 'open'],
    ['job_parties', 'remote no', 'rejected'],
    ['never', 'nothing', 'rejected']
  ] as const)('S10: %s, %s -> line %s', (policy, script, expected) => {
    const rig = lineRig(policy)
    open(rig)
    expect(rig.events('direct_line_open')).toHaveLength(1)
    const steps = script.split(/, | then /)
    for (const s of steps) {
      if (s === 'owner yes') {
        rig.foreman.decideLine('j1', true)
      }
      if (s === 'owner no') {
        rig.foreman.decideLine('j1', false, 'not now')
      }
      if (s === 'remote yes') {
        rig.foreman.remoteLineDecision('j1', true)
      }
      if (s === 'remote no') {
        rig.foreman.remoteLineDecision('j1', false)
      }
    }
    expect(state(rig)).toBe(expected)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(expected === 'open')
    if (policy === 'ask_owner') {
      expect(rig.notices.at(-1)).toEqual({ kind: 'line_request', taskId: 'j1' })
    }
  })

  it('S10: the other yard is not let in until BOTH foremen said yes', () => {
    const rig = lineRig('ask_owner')
    open(rig)
    rig.foreman.decideLine('j1', true)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(false)
    rig.foreman.remoteLineDecision('j1', true)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(true)
    expect(rig.foreman.lineAllows('j1', 'a1', 'other-yard')).toBe(false)
    expect(rig.foreman.lineAllows('j1', 'a9', 'qa-yard')).toBe(false)
    rig.conforms()
  })

  it('S10: the line closes when the job closes, and later messages are refused', () => {
    const rig = lineRig('job_parties')
    open(rig)
    rig.foreman.remoteLineDecision('j1', true)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(true)
    rig.done('j1', 'a1', 1)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(true) // done is not closed yet
    rig.verify('j1')
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(false)
    expect(rig.foreman.jobView('j1').line).toMatchObject({
      state: 'closed',
      closeReason: 'job_closed'
    })
  })

  it('S10: a cancelled job closes its line too', () => {
    const rig = lineRig('job_parties')
    open(rig)
    rig.foreman.remoteLineDecision('j1', true)
    rig.inbound({ task_id: 'j1', event: 'cancel' })
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(false)
  })

  it('S10: a line also ends at its time limit', () => {
    const rig = lineRig('job_parties')
    open(rig, { ttlMinutes: 10 })
    rig.foreman.remoteLineDecision('j1', true)
    rig.adv(10 * MINUTE_MS - 1)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(true)
    rig.adv(1)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(false)
    expect(rig.foreman.jobView('j1').line).toMatchObject({ state: 'closed', closeReason: 'ttl' })
  })

  it('S10: the clock for the time limit starts when the line opens, not when it was asked for', () => {
    const rig = lineRig('ask_owner')
    open(rig, { ttlMinutes: 10 })
    rig.adv(HOUR_MS)
    rig.foreman.decideLine('j1', true)
    rig.foreman.remoteLineDecision('j1', true)
    expect(rig.foreman.lineAllows('j1', 'a1', 'qa-yard')).toBe(true)
  })

  it('S10: a line asked for by the other yard needs only our approval', () => {
    const rig = lineRig('ask_owner')
    open(rig, { origin: 'remote' })
    expect(rig.events('direct_line_open')).toHaveLength(0) // theirs to send
    rig.foreman.decideLine('j1', true)
    expect(rig.events('direct_line_approve')).toHaveLength(1)
    expect(state(rig)).toBe('open')
  })

  it('S10: one line per job at a time, only on an accepted job, with the contract limits', () => {
    const rig = lineRig('ask_owner')
    open(rig)
    expect(code(() => open(rig))).toBe('bad_line')
    expect(code(() => rig.foreman.decideLine('j1', true))).toBeUndefined()
    expect(code(() => rig.foreman.decideLine('j1', true))).toBe('bad_line') // already answered
    const rig2 = ready({ directLines: 'ask_owner' }, ['a1'])
    rig2.send('j2', 'audit') // held, not accepted
    expect(
      code(() =>
        rig2.foreman.openLine('j2', {
          fromInner: 'a1',
          toVillage: 'v',
          purpose: 'p',
          ttlMinutes: 5
        })
      )
    ).toBe('bad_line')
    const rig3 = lineRig('ask_owner')
    expect(code(() => open(rig3, { ttlMinutes: 0 }))).toBe('bad_event')
    expect(code(() => open(rig3, { ttlMinutes: 1441 }))).toBe('bad_event')
  })

  it('S10: after a rejected line a new one can be asked for', () => {
    const rig = lineRig('ask_owner')
    open(rig)
    rig.foreman.decideLine('j1', false)
    expect(state(rig)).toBe('rejected')
    open(rig)
    expect(state(rig)).toBe('requested')
  })
})

describe('paused foreman', () => {
  it('S22 (yard side): paused declines new jobs, offers nothing, and tells the Dispatcher it is paused', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.send('j2') // queued behind a1
    rig.foreman.pause()
    expect(rig.send('j3')).toMatchObject({ outcome: 'declined', reason: 'paused' })
    expect(rig.foreman.heartbeat().state).toBe('paused')
    rig.done('j1', 'a1', 1)
    expect(rig.offers.map((o) => o.offer.taskId)).toEqual(['j1']) // j2 not offered while paused
    rig.foreman.resume()
    expect(rig.offers.map((o) => o.offer.taskId)).toEqual(['j1', 'j2'])
  })

  it('S22 (yard side): a running claim keeps its lease while paused', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    const e = rig.claim('j1', 'a1')
    rig.foreman.pause()
    rig.adv(20 * MINUTE_MS)
    rig.foreman.agentRenew('j1', 'a1', e)
    expect(rig.foreman.jobView('j1').exec).toBe('running')
  })
})

describe('S15 decision: offline answering service hands its queue over', () => {
  const entry = (
    id: string,
    ageMs: number,
    extra: { ownerNotified?: boolean; cap?: string } = {}
  ) => {
    const rigForOffer = makeRig()
    return {
      offer: rigForOffer.offerEvent(id, extra.cap ?? 'fix-bug'),
      requester: 'site',
      acceptedAt: T0 - ageMs,
      ...(extra.ownerNotified !== undefined ? { ownerNotified: extra.ownerNotified } : {})
    }
  }

  it('S15: queue order is kept (oldest accept first) whatever order they arrive in', () => {
    const rig = ready({}, ['a1', 'a2', 'a3'])
    const r = rig.foreman.adoptQueue([
      entry('jC', 30 * MINUTE_MS),
      entry('jA', 2 * HOUR_MS),
      entry('jB', HOUR_MS)
    ])
    expect(r.adopted).toEqual(['jA', 'jB', 'jC'])
    expect(rig.offers.map((o) => o.offer.taskId)).toEqual(['jA', 'jB', 'jC'])
  })

  it('S15: no second "accept" is sent for jobs the service already accepted', () => {
    const rig = ready({}, ['a1'])
    rig.foreman.adoptQueue([entry('jA', HOUR_MS)])
    expect(rig.events()).toEqual([])
    expect(rig.foreman.jobView('jA')).toMatchObject({ state: 'accepted', exec: 'offered' })
    const e = rig.claim('jA', 'a1')
    rig.done('jA', 'a1', e)
    rig.verify('jA')
    expect(rig.foreman.jobView('jA').state).toBe('verified')
  })

  it('S21: handing the same queue over twice, or re-offering an adopted job, makes no second job', () => {
    const rig = ready()
    const q = [entry('jA', HOUR_MS), entry('jB', HOUR_MS)]
    expect(rig.foreman.adoptQueue(q).adopted).toEqual(['jA', 'jB'])
    expect(rig.foreman.adoptQueue(q)).toEqual({ adopted: [], skipped: ['jA', 'jB'] })
    expect(rig.send('jA').outcome).toBe('duplicate')
    expect(rig.foreman.jobIds()).toEqual(['jA', 'jB'])
  })

  it.each([
    ['5 h old, owner not told yet', 5 * HOUR_MS, false, ['job_held_offline'], false],
    ['5 h old, owner already told', 5 * HOUR_MS, true, [], false],
    ['1 h old', HOUR_MS, false, [], false],
    ['25 h old', 25 * HOUR_MS, false, ['job_held_offline', 'job_released'], true]
  ] as const)(
    'S18: hold and release count from the service accept time (%s)',
    (_n, age, told, notices, released) => {
      const rig = ready()
      rig.foreman.adoptQueue([entry('jA', age, { ownerNotified: told })])
      expect(rig.notices.map((n) => n.kind)).toEqual(notices)
      expect(rig.events('cancel').length === 1).toBe(released)
    }
  )

  it('S15: a job for a capability closed since is still honoured: the service already promised it', () => {
    const rig = ready({}, ['a1'])
    rig.foreman.adoptQueue([entry('jA', HOUR_MS, { cap: 'closed-cap' })])
    expect(rig.foreman.jobView('jA').exec).toBe('offered')
  })

  it('S15: exporting the queue and adopting it elsewhere gives the same jobs in the same order', () => {
    const a = ready()
    a.send('j1')
    a.adv(MINUTE_MS)
    a.send('j2')
    a.adv(MINUTE_MS)
    a.send('j3', 'review-pr')
    const exported = a.foreman.exportQueue()
    expect(exported.map((e) => e.offer.task_id)).toEqual(['j1', 'j2', 'j3'])
    expect(exported[2].offer.capability).toBe('review-pr')
    const b = ready()
    b.adv(10 * MINUTE_MS)
    expect(b.foreman.adoptQueue(JSON.parse(JSON.stringify(exported))).adopted).toEqual([
      'j1',
      'j2',
      'j3'
    ])
    for (const id of ['j1', 'j2', 'j3']) {
      expect(b.foreman.jobView(id).queuedNotRunning).toBe(true)
    }
  })

  it('S15: running jobs are not exported: they keep their lease with this foreman', () => {
    const rig = ready({}, ['a1'])
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.send('j2')
    expect(rig.foreman.exportQueue().map((e) => e.offer.task_id)).toEqual(['j2'])
  })

  it('S15: an entry that is not an offer for this yard is refused', () => {
    const rig = ready()
    const bad = { ...entry('jA', 0), offer: { ...entry('jA', 0).offer, yard: 'else' } }
    expect(code(() => rig.foreman.adoptQueue([bad]))).toBe('bad_offer')
  })
})

describe('restart: snapshot and restore', () => {
  it('S17: a restored foreman still revokes a lapsed lease and refuses the late done', () => {
    const a = ready({}, ['a1'])
    a.send('j1')
    const e = a.claim('j1', 'a1')
    a.foreman.cards.start('a1', { title: 'Fixing it', jobId: 'j1' })
    const snap = JSON.parse(JSON.stringify(a.foreman.snapshot()))

    const b = makeRig()
    b.foreman.restore(snap)
    b.foreman.agentUp('a1')
    b.foreman.agentUp('a2')
    b.adv(31 * MINUTE_MS)
    expect(b.revokes).toMatchObject([{ agentId: 'a1', revoke: { reason: 'lease_lapsed' } }])
    expect(code(() => b.done('j1', 'a1', e))).toBe('claim_revoked')
    expect(b.offers.at(-1)?.agentId).toBe('a2')
    expect(b.foreman.cards.count()).toBe(1)
  })

  it('S18: restored hold and release timers still fire', () => {
    const a = ready()
    a.send('j1')
    const b = makeRig()
    b.foreman.restore(JSON.parse(JSON.stringify(a.foreman.snapshot())))
    b.adv(4 * HOUR_MS)
    expect(b.notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    expect(b.foreman.menuRevision).toBe(1)
  })
})

describe('contract conformance', () => {
  it('S48: every event the foreman puts on the wire is legal in the reference gateway, across mixed jobs', () => {
    const rig = ready({}, ['a1', 'a2'])
    // j1: full path with one send-back and a progress note
    rig.send('j1')
    let e = rig.claim('j1', 'a1')
    rig.foreman.agentProgress('j1', 'a1', e, 'started')
    rig.done('j1', 'a1', e)
    rig.verify('j1', 'reject')
    e = rig.claim('j1', 'a1')
    rig.done('j1', 'a1', e)
    rig.verify('j1', 'pass')
    // j2: refused; j3: held then declined; j4: lease lapse then finished by the other agent
    rig.send('j2', 'nope')
    rig.send('j3', 'audit')
    rig.foreman.ownerDecision('j3', 'decline', 'usr_aaron', 'busy')
    rig.send('j4')
    rig.claim('j4', 'a1')
    rig.adv(31 * MINUTE_MS)
    const e4 = rig.claim('j4', 'a2')
    rig.done('j4', 'a2', e4)
    rig.verify('j4')
    // j5: owner declines after accepting; j6: released after 24 h with nobody free
    rig.send('j5')
    rig.claim('j5', 'a1')
    rig.foreman.decline('j5', 'usr_aaron', 'wrong yard')
    rig.foreman.agentDown('a1')
    rig.foreman.agentDown('a2')
    rig.send('j6')
    rig.adv(25 * HOUR_MS)
    // j7: direct line
    rig.foreman.agentUp('a1')
    rig.send('j7')
    rig.claim('j7', 'a1')
    rig.foreman.openLine('j7', { fromInner: 'a1', toVillage: 'qa', purpose: 'ask', ttlMinutes: 30 })
    rig.foreman.decideLine('j7', true)
    rig.conforms()
    expect(rig.events().length).toBeGreaterThanOrEqual(15)
    for (const w of rig.wire) {
      expect(checkContract('lifecycle', w.ev)).toBeNull()
    }
  })
})
