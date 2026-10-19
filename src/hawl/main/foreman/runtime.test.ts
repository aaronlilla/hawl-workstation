// Runtime, file storage and IPC tests. The runtime owns real time and the disk; the core never does.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileStorage } from './file-storage'
import { Foreman } from './foreman'
import { FOREMAN_CHANNELS, registerForemanIpc } from './ipc'
import type { IpcLike } from './ipc'
import { ForemanRuntime } from './runtime'
import { CAPS, HOUR_MS, MINUTE_MS, code } from './rig.test-support'
import { memoryStorage, setup } from './runtime.test-support'
import type { HandBack, OwnerNotice } from './types'

describe('S18 the runtime sleeps until something is due, with nobody calling the foreman', () => {
  it('S18: hold notice at 4 h and hand-back at 24 h happen from timers alone', () => {
    const { rig, sched, rt } = setup()
    rt.start()
    rt.run((f) => f.publishMenu())
    rt.run((f) => f.intake({ offer: rig.offerEvent('j1'), requester: 'site' }))
    sched.advance(4 * HOUR_MS - MINUTE_MS)
    expect(rig.notices).toEqual([])
    sched.advance(2 * MINUTE_MS)
    expect(rig.notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    sched.advance(20 * HOUR_MS)
    expect(rig.handBacks).toMatchObject([{ taskId: 'j1', op: 'release', reason: 'yard_offline' }])
    rt.stop()
  })

  it('S17: a lease that lapses is revoked by the timer, before any later call', () => {
    const { rig, sched, rt } = setup()
    rt.start()
    rt.run((f) => {
      f.publishMenu()
      f.agentUp('a1')
      f.intake({ offer: rig.offerEvent('j1'), requester: 'site' })
    })
    const epoch = rig.claim('j1', 'a1')
    sched.advance(31 * MINUTE_MS)
    expect(rig.revokes).toMatchObject([
      { agentId: 'a1', revoke: { epoch, reason: 'lease_lapsed' } }
    ])
    rt.stop()
  })

  it('S48: the sleep is never longer than the longest allowed sleep', () => {
    const { sched, rt } = setup()
    rt.start()
    expect(Math.max(...sched.pending())).toBeLessThanOrEqual(60_000)
    rt.stop()
  })

  it('S48: heartbeats go out every 30 s from the timer alone', () => {
    const { rig, sched, rt } = setup()
    rt.start()
    const first = rig.beats.length
    sched.advance(95_000)
    expect(rig.beats.length - first).toBeGreaterThanOrEqual(3)
    rt.stop()
  })

  it('S18: a tick that keeps throwing is reported and retried no faster than once a second', () => {
    const { sched, rt, errors } = setup()
    rt.start()
    rt.foreman.tick = () => {
      throw new Error('boom')
    }
    sched.advance(200_000)
    // Without the one-second floor the timer would fire again at once, forever.
    expect(errors.length).toBeGreaterThanOrEqual(3)
    expect(errors.length).toBeLessThan(300)
    rt.stop()
  })
})

describe('restart: the runtime saves and restores', () => {
  it('S17: a change is saved within 200 ms, merged with others, and stop() flushes', () => {
    const { rig, sched, rt, storage } = setup()
    rt.start()
    rt.run((f) => f.publishMenu())
    rt.run((f) => f.intake({ offer: rig.offerEvent('j1'), requester: 'site' }))
    // The menu and the accept were each saved just before they were sent (write-ahead): 2 writes.
    expect(storage.writes).toBe(2)
    sched.advance(200)
    // One more write, merged: the state after both were delivered.
    expect(storage.writes).toBe(3)
    rt.run((f) => f.pause())
    rt.stop()
    expect(storage.writes).toBe(4)
    const saved = JSON.parse(storage.text ?? '{}')
    expect(saved.jobs.map((j: { taskId: string }) => j.taskId)).toEqual(['j1'])
    expect(saved.paused).toBe(true)
  })

  it('S18: a job saved at 0 h and an app reopened at 5 h tells the owner on start, and still hands back at 24 h', () => {
    const a = setup()
    a.rt.start()
    a.rt.run((f) => f.publishMenu())
    a.rt.run((f) => f.intake({ offer: a.rig.offerEvent('j1'), requester: 'site' }))
    a.rt.stop()

    const b = setup(a.storage)
    b.rig.skip(5 * HOUR_MS)
    // 5 h since the last save is a gap: running leases are renewed once (none here).
    expect(b.rt.start()).toEqual({ restored: true, resumed: true })
    expect(b.rig.notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    expect(b.rig.handBacks).toEqual([])
    b.sched.advance(19 * HOUR_MS + MINUTE_MS)
    expect(b.rig.handBacks).toMatchObject([{ taskId: 'j1', op: 'release' }])
    b.rt.stop()
  })

  it('S21: after a restart the same offer is still one job', () => {
    const a = setup()
    a.rt.start()
    a.rt.run((f) => f.publishMenu())
    const offer = a.rig.offerEvent('j1')
    a.rt.run((f) => f.intake({ offer, requester: 'site' }))
    a.rt.stop()
    const b = setup(a.storage)
    b.rt.start()
    expect(b.rt.run((f) => f.intake({ offer, requester: 'site' })).outcome).toBe('duplicate')
    b.rt.stop()
  })

  it('S17: a snapshot that cannot be read is kept aside, reported, and the app starts empty', () => {
    const errors: unknown[] = []
    const { rt, storage } = setup(memoryStorage('{"jobs": nope'), errors)
    expect(rt.start()).toEqual({ restored: false, resumed: false })
    expect(storage.quarantined).toEqual(['{"jobs": nope'])
    expect(errors).toHaveLength(1)
    rt.stop()
  })

  it('S17: a call that throws still re-plans the sleep and saves', () => {
    const { rig, sched, rt, storage } = setup()
    rt.start()
    rt.run((f) => f.publishMenu())
    expect(
      code(() =>
        rt.run((f) =>
          f.intake({ offer: { ...rig.offerEvent('j1'), yard: 'else' }, requester: 'site' })
        )
      )
    ).toBe('wrong_yard')
    sched.advance(200)
    // The publish was saved before it was sent, and once more after it went out; the failed call added nothing.
    expect(storage.writes).toBe(2)
    rt.stop()
  })

  it('S17: starting twice is an error', () => {
    const { rt } = setup()
    rt.start()
    expect(() => rt.start()).toThrow(/already started/)
    rt.stop()
  })
})

describe('file storage', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'hawl-foreman-'))
    dirs.push(d)
    return d
  }

  it('S17: a missing file reads as nothing; a written file reads back exactly; no temp file is left', () => {
    const dir = tmp()
    const st = fileStorage(join(dir, 'sub', 'foreman.json'))
    expect(st.read()).toBeNull()
    st.write('{"a":1}')
    st.write('{"a":2}')
    expect(st.read()).toBe('{"a":2}')
    expect(readdirSync(join(dir, 'sub'))).toEqual(['foreman.json'])
  })

  it('S17: a corrupt file is copied aside, and the original is left for the next save to replace', () => {
    const dir = tmp()
    const path = join(dir, 'foreman.json')
    writeFileSync(path, 'garbage')
    fileStorage(path, () => 42).quarantine?.('garbage')
    expect(readFileSync(`${path}.corrupt-42`, 'utf8')).toBe('garbage')
  })

  it('S17/S18: a real foreman on real timers and a real file: notice, hand-back, save, restart', async () => {
    const dir = tmp()
    const path = join(dir, 'foreman.json')
    const notices: OwnerNotice[] = []
    const backs: HandBack[] = []
    const make = () =>
      new Foreman(
        {
          yard: 'acme-dev',
          owner: 'usr_aaron',
          displayName: 'Yard',
          holdMs: 60,
          releaseMs: 200,
          heartbeatMs: 5000
        },
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
    const rt = new ForemanRuntime({
      foreman: make(),
      clock: { now: Date.now },
      storage: fileStorage(path),
      saveDelayMs: 20
    })
    rt.start()
    rt.run((f) => {
      f.setCapabilities(CAPS)
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
    await new Promise((r) => setTimeout(r, 120))
    expect(notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
    expect(backs).toEqual([])
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.jobs[0]).toMatchObject({ taskId: 'j1', state: 'accepted' })
    await new Promise((r) => setTimeout(r, 160))
    expect(backs).toMatchObject([{ taskId: 'j1', op: 'release', reason: 'yard_offline' }])
    rt.stop()

    const rt2 = new ForemanRuntime({
      foreman: make(),
      clock: { now: Date.now },
      storage: fileStorage(path)
    })
    expect(rt2.start()).toMatchObject({ restored: true })
    expect(rt2.run((f) => f.jobView('j1')).state).toBe('reassigned')
    rt2.stop()
  })
})

describe('IPC for the owner screens', () => {
  function ipcRig() {
    const { rig, rt } = setup()
    rt.start()
    rt.run((f) => f.publishMenu())
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const ipc: IpcLike = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch)
    }
    const off = registerForemanIpc(ipc, rt, { trusted: () => true })
    const call = (ch: string, ...args: unknown[]) => handlers.get(ch)?.({}, ...args)
    return { rig, rt, handlers, off, call }
  }

  it('S11: registers every channel and removes them all again', () => {
    const { handlers, off } = ipcRig()
    expect([...handlers.keys()].sort()).toEqual([...FOREMAN_CHANNELS].sort())
    off()
    expect(handlers.size).toBe(0)
  })

  it('S9: the owner accepts a held job from the screen, and sees the list and the agents', () => {
    const { rig, rt, call } = ipcRig()
    rt.run((f) => f.agentUp('a1', { label: 'Laptop' }))
    rig.send('j1', 'audit')
    expect(call('hawl:foreman:jobs')).toMatchObject([{ taskId: 'j1', exec: 'held' }])
    call('hawl:foreman:owner-decision', 'j1', 'accept')
    expect(call('hawl:foreman:job', 'j1')).toMatchObject({ state: 'accepted', exec: 'offered' })
    expect(call('hawl:foreman:agents')).toMatchObject([{ id: 'a1', label: 'Laptop' }])
    expect(rig.foreman.jobView('j1').history[0]).toMatchObject({ kind: 'approve', by: 'owner' })
  })

  it('S20: decline, reroute with a rule, pause and resume go through to the foreman', () => {
    const { rig, rt, call } = ipcRig()
    rt.run((f) => {
      f.agentUp('a1')
      f.agentUp('a2')
    })
    rig.send('j1')
    rig.claim('j1', 'a1')
    call('hawl:foreman:reroute', 'j1', 'a2', 'better fit', true)
    expect(rig.foreman.rules()).toMatchObject([{ action: { agentId: 'a2' }, source: 'correction' }])
    call('hawl:foreman:pause')
    expect(rig.foreman.paused).toBe(true)
    call('hawl:foreman:resume')
    call('hawl:foreman:decline', 'j1', 'not for us')
    expect(rig.handBacks).toEqual([{ taskId: 'j1', op: 'decline', reason: 'not for us' }])
  })

  it('S12: the menu is edited as a draft and published from the screen', () => {
    const { rig, call } = ipcRig()
    call('hawl:foreman:set-menu', [{ id: 'fix-bug', description: 'Fix a bug' }])
    expect(rig.menus).toHaveLength(1)
    expect(call('hawl:foreman:publish-menu')).toBe(2)
    expect(rig.menus.at(-1)?.menu.capabilities.map((c) => c.id)).toEqual(['fix-bug'])
  })

  it('S9: arguments from the renderer are checked before they reach the foreman', () => {
    const { call } = ipcRig()
    const bad = (ch: string, ...a: unknown[]) => {
      try {
        call(ch, ...a)
        return 'no error'
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    }
    expect(bad('hawl:foreman:owner-decision', 'j1', 'maybe')).toMatch(/accept or decline/)
    expect(bad('hawl:foreman:decline', 'j1')).toMatch(/reason/)
    expect(bad('hawl:foreman:decline', 42, 'x')).toMatch(/taskId/)
    expect(bad('hawl:foreman:reroute', 'j1', 'a2', 'r', 'yes')).toMatch(/makeRule/)
    expect(bad('hawl:foreman:set-menu', 'not a list')).toMatch(/list/)
    expect(bad('hawl:foreman:job', 'nope')).toMatch(/no task/)
  })
})
