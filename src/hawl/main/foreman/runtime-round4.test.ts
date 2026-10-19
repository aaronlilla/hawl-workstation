// Round 4, runtime side: sleep and restart, write-ahead through a real snapshot store, a damaged file,
// and the real 4 h / 24 h clocks on timers and a real file.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileStorage } from './file-storage'
import { Foreman } from './foreman'
import { ForemanRuntime } from './runtime'
import { HOUR_MS, MINUTE_MS, code } from './rig.test-support'
import { memoryStorage, setup } from './runtime.test-support'
import type { HandBack, OwnerNotice } from './types'

function running() {
  const s = setup()
  s.rt.start()
  s.rt.run((f) => {
    f.publishMenu()
    f.agentUp('a1')
  })
  s.rt.run((f) => f.intake({ offer: s.rig.offerEvent('j1'), requester: 'site' }))
  const epoch = s.rig.claim('j1', 'a1')
  return { ...s, epoch }
}

describe('S17 a laptop that sleeps does not lose its running jobs', () => {
  it('S17: asleep 2 h, the agent renews before the late timer fires: the claim stands', () => {
    const { rig, rt, epoch } = running()
    rig.skip(2 * HOUR_MS)
    // The timer is overdue but has not run; the agent's message arrives first.
    rt.run((f) => f.agentRenew('j1', 'a1', epoch))
    expect(rig.foreman.jobView('j1')).toMatchObject({ exec: 'running', holder: 'a1' })
    expect(rig.revokes).toEqual([])
    rt.stop()
  })

  it('S17: asleep 2 h, the late timer fires first: it renews, then the agent renews and finishes', () => {
    const { rig, sched, rt, epoch } = running()
    rig.skip(2 * HOUR_MS)
    sched.advance(0)
    rt.run((f) => f.agentRenew('j1', 'a1', epoch))
    rig.done('j1', 'a1', epoch)
    expect(rig.events('done')).toHaveLength(1)
    expect(rig.revokes).toEqual([])
    rt.stop()
  })

  it('S17: a short pause (a slow tick, under 2 min) is not a sleep: a lapsed lease is still revoked', () => {
    const { rig, sched, rt, epoch } = running()
    // The agent went quiet for 31 minutes while the runtime ticked normally.
    sched.advance(31 * MINUTE_MS)
    expect(rig.revokes).toMatchObject([{ revoke: { epoch, reason: 'lease_lapsed' } }])
    expect(code(() => rt.run((f) => f.agentRenew('j1', 'a1', epoch)))).toBe('claim_revoked')
    rt.stop()
  })

  it('S17: the app is closed with a job running and opened 3 h later: running leases are renewed once, not revoked', () => {
    const a = running()
    a.rt.stop()
    const b = setup(a.storage)
    b.rig.skip(3 * HOUR_MS)
    expect(b.rt.start()).toEqual({ restored: true, resumed: true })
    // The terminal comes back and carries on with the same claim.
    b.rt.run((f) => f.agentUp('a1'))
    b.rt.run((f) => f.agentRenew('j1', 'a1', a.epoch))
    expect(b.rig.foreman.jobView('j1')).toMatchObject({ exec: 'running', holder: 'a1' })
    expect(b.rig.revokes).toEqual([])
    b.rt.stop()
  })

  it('S17: closed and opened a minute later is a plain restart: nothing is renewed', () => {
    const a = running()
    a.rt.stop()
    const b = setup(a.storage)
    b.rig.skip(MINUTE_MS)
    expect(b.rt.start()).toEqual({ restored: true, resumed: false })
    b.rt.stop()
  })

  it('S17: closed with a job running; the agent never comes back: the claim is revoked 30 minutes after reopening', () => {
    const a = running()
    a.rt.stop()
    const b = setup(a.storage)
    b.rig.skip(3 * HOUR_MS)
    b.rt.start()
    b.sched.advance(31 * MINUTE_MS)
    expect(b.rig.revokes).toMatchObject([{ agentId: 'a1', revoke: { reason: 'lease_lapsed' } }])
    b.rt.stop()
  })
})

describe('S21 write-ahead through a real snapshot store', () => {
  it('S21: at the moment the accept is sent, the saved text already holds the accepted job and the accept', () => {
    const { rig, rt, storage } = setup()
    rt.start()
    rt.run((f) => f.publishMenu())
    const before = storage.all.length
    rt.run((f) => f.intake({ offer: rig.offerEvent('j1'), requester: 'site' }))
    expect(rig.events('accept')).toHaveLength(1)
    const firstWrite = JSON.parse(storage.all[before])
    expect(firstWrite.jobs[0]).toMatchObject({ taskId: 'j1', state: 'accepted' })
    expect(firstWrite.outbox.map((i: { effect: { kind: string } }) => i.effect.kind)).toEqual([
      'lifecycle'
    ])
    rt.stop()
  })

  it('S21: the relay is down when the app closes: the reopened app sends the accept once and does not accept twice', () => {
    const a = setup()
    a.rt.start()
    a.rt.run((f) => f.publishMenu())
    a.rig.faults.sendLifecycle = 1000
    a.rt.run((f) => f.intake({ offer: a.rig.offerEvent('j1'), requester: 'site' }))
    expect(a.rig.events('accept')).toHaveLength(0)
    a.rt.stop()
    expect(JSON.parse(a.storage.text ?? '{}').outbox).toHaveLength(1)

    const b = setup(a.storage)
    b.rt.start()
    expect(b.rig.events('accept')).toHaveLength(1)
    expect(b.rt.run((f) => f.intake({ offer: a.rig.offerEvent('j1'), requester: 'site' })).outcome).toBe(
      'duplicate'
    )
    b.rig.adv(HOUR_MS)
    expect(b.rig.events('accept')).toHaveLength(1)
    expect(b.rig.foreman.outbox()).toEqual([])
    b.rt.stop()
  })

  it('S21: when the disk refuses the save nothing is sent, the error is reported, and the send goes once the disk works', () => {
    const errors: unknown[] = []
    const { rig, sched, rt, storage } = setup(memoryStorage(), errors)
    rt.start()
    rt.run((f) => f.publishMenu())
    const write = storage.api.write
    let full = true
    storage.api.write = (t) => {
      if (full) {
        throw new Error('disk full')
      }
      write(t)
    }
    rt.run((f) => f.intake({ offer: rig.offerEvent('j1'), requester: 'site' }))
    expect(rig.events('accept')).toHaveLength(0)
    expect(errors.length).toBeGreaterThan(0)
    full = false
    sched.advance(2000)
    expect(rig.events('accept')).toHaveLength(1)
    rt.stop()
  })
})

describe('S17 a damaged saved file', () => {
  it('S17: a file with no rules list is set aside, reported, and the foreman starts empty and works', () => {
    const a = running()
    const damaged = JSON.parse(a.storage.text ?? '{}')
    delete damaged.rules
    a.rt.stop()
    const errors: unknown[] = []
    const b = setup(memoryStorage(JSON.stringify(damaged)), errors)
    expect(b.rt.start()).toEqual({ restored: false, resumed: false })
    expect(b.storage.quarantined).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(b.rig.foreman.jobIds()).toEqual([])
    expect(b.rig.foreman.rules()).toEqual([])
    expect(b.rig.foreman.agents()).toEqual([])
    // It is a working foreman, not a wreck.
    b.rt.run((f) => {
      f.publishMenu()
      f.agentUp('a1')
    })
    expect(b.rt.run((f) => f.intake({ offer: b.rig.offerEvent('j2'), requester: 'site' })).outcome).toBe(
      'accepted'
    )
    b.rt.stop()
  })

  it('S17: a file from a newer foreman is not read and not overwritten blindly', () => {
    const a = running()
    const newer = JSON.parse(a.storage.text ?? '{}')
    newer.version = 7
    a.rt.stop()
    const errors: unknown[] = []
    const b = setup(memoryStorage(JSON.stringify(newer)), errors)
    expect(b.rt.start().restored).toBe(false)
    expect(b.storage.quarantined).toHaveLength(1)
    expect(String(errors[0])).toMatch(/newer foreman/)
    b.rt.stop()
  })
})

describe('S18 the real clocks: 4 h and 24 h on real timers and a real file', { timeout: 120_000 }, () => {
  const dirs: string[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  function make(path: string, notices: OwnerNotice[], backs: HandBack[]) {
    // Default config: hold 4 h, release 24 h, heartbeat 30 s. Nothing shortened.
    const foreman = new Foreman(
      { yard: 'acme-dev', owner: 'usr_aaron', displayName: 'Yard' },
      {
        clock: { now: Date.now },
        transport: {
          sendMenu: () => {},
          sendHeartbeat: () => {},
          sendLifecycle: () => {},
          notifyOwner: (n) => {
            notices.push(n)
          },
          notifyRequester: () => {},
          handBack: (b) => {
            backs.push(b)
          }
        },
        agents: { offer: () => {}, revoke: () => {} }
      }
    )
    return new ForemanRuntime({ foreman, clock: { now: Date.now }, storage: fileStorage(path) })
  }

  it('S18: the owner is told at 4 h and the job goes back at 24 h, across a restart at 10 h', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hawl-foreman-real-'))
    dirs.push(dir)
    const path = join(dir, 'foreman.json')
    const notices: OwnerNotice[] = []
    const backs: HandBack[] = []
    const rt = make(path, notices, backs)
    rt.start()
    rt.run((f) => {
      f.setCapabilities([{ id: 'fix-bug', description: 'Fix a bug' }])
      f.publishMenu()
      f.intake({
        offer: {
          yard: 'acme-dev',
          task_id: 'j1',
          event: 'offer',
          at: new Date().toISOString(),
          capability: 'fix-bug'
        },
        requester: 'site'
      })
    })
    await vi.advanceTimersByTimeAsync(4 * HOUR_MS - MINUTE_MS)
    expect(notices).toEqual([])
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS)
    expect(notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    await vi.advanceTimersByTimeAsync(6 * HOUR_MS)
    expect(backs).toEqual([])
    rt.stop()
    // The app is closed from 10 h; the file is on disk and no temp file is left.
    expect(readdirSync(dir)).toEqual(['foreman.json'])
    expect(JSON.parse(readFileSync(path, 'utf8')).jobs[0]).toMatchObject({ taskId: 'j1', state: 'accepted' })

    const rt2 = make(path, notices, backs)
    expect(rt2.start()).toMatchObject({ restored: true })
    // The owner was already told: no second notice after the restart.
    expect(notices).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(13 * HOUR_MS)
    expect(backs).toEqual([])
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS)
    expect(backs).toMatchObject([{ taskId: 'j1', op: 'release', reason: 'yard_offline' }])
    expect(notices.map((n) => n.kind)).toEqual(['job_held_offline', 'job_released'])
    rt2.stop()
  })

  it('S17: a 30 minute lease on the real clock: a renew at 29 minutes keeps it, silence to 31 revokes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hawl-foreman-real-'))
    dirs.push(dir)
    const revokes: unknown[] = []
    const foreman = new Foreman(
      { yard: 'acme-dev', owner: 'usr_aaron', displayName: 'Yard' },
      {
        clock: { now: Date.now },
        transport: {
          sendMenu: () => {},
          sendHeartbeat: () => {},
          sendLifecycle: () => {},
          notifyOwner: () => {},
          notifyRequester: () => {},
          handBack: () => {}
        },
        agents: {
          offer: () => {},
          revoke: (id, r) => {
            revokes.push({ id, ...r })
          }
        }
      }
    )
    const rt = new ForemanRuntime({
      foreman,
      clock: { now: Date.now },
      storage: fileStorage(join(dir, 'foreman.json'))
    })
    rt.start()
    rt.run((f) => {
      f.setCapabilities([{ id: 'fix-bug', description: 'Fix a bug' }])
      f.publishMenu()
      f.agentUp('a1')
      f.intake({
        offer: {
          yard: 'acme-dev',
          task_id: 'j1',
          event: 'offer',
          at: new Date().toISOString(),
          capability: 'fix-bug'
        },
        requester: 'site'
      })
      f.agentAccept('j1', 'a1', 1)
    })
    await vi.advanceTimersByTimeAsync(29 * MINUTE_MS)
    rt.run((f) => f.agentRenew('j1', 'a1', 1))
    await vi.advanceTimersByTimeAsync(29 * MINUTE_MS)
    expect(revokes).toEqual([])
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS)
    expect(revokes).toMatchObject([{ id: 'a1', epoch: 1, reason: 'lease_lapsed' }])
    rt.stop()
  })
})
