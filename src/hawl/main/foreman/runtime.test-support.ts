// Test support for the runtime: virtual timers on the rig's clock, an in-memory snapshot file, a ready runtime.
import { ForemanRuntime } from './runtime'
import type { Scheduler, SnapshotStorage } from './runtime'
import { makeRig } from './rig.test-support'

/** Timers on the rig's fake clock: advance() moves time and runs what came due, in order. */
export function virtualScheduler(rig: ReturnType<typeof makeRig>) {
  type T = { id: number; at: number; fn: () => void }
  let next = 1
  const timers: T[] = []
  const scheduler: Scheduler = {
    set(fn, ms) {
      const t = { id: next++, at: rig.now() + ms, fn }
      timers.push(t)
      return t.id
    },
    clear(h) {
      const i = timers.findIndex((t) => t.id === h)
      if (i !== -1) {
        timers.splice(i, 1)
      }
    }
  }
  return {
    scheduler,
    pending: () => timers.map((t) => t.at - rig.now()).sort((a, b) => a - b),
    /** Move time forward in steps, firing timers as they come due. */
    advance(ms: number): void {
      const end = rig.now() + ms
      for (let guard = 0; guard < 100_000; guard++) {
        const first = timers.toSorted((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!first || first.at > end) {
          break
        }
        rig.skip(Math.max(0, first.at - rig.now()))
        timers.splice(timers.indexOf(first), 1)
        first.fn()
      }
      rig.skip(Math.max(0, end - rig.now()))
    }
  }
}

export type Memory = {
  text: string | null
  writes: number
  /** Every text ever written, oldest first. */
  all: string[]
  quarantined: string[]
  api: SnapshotStorage
}

export function memoryStorage(initial: string | null = null): Memory {
  const s: Memory = {
    text: initial,
    writes: 0,
    all: [] as string[],
    quarantined: [] as string[],
    api: {
      read: () => s.text,
      write: (t: string) => {
        s.text = t
        s.writes++
        s.all.push(t)
      },
      quarantine: (t: string) => {
        s.quarantined.push(t)
      }
    }
  }
  return s
}

export function setup(storage = memoryStorage(), errors: unknown[] = []) {
  const rig = makeRig()
  const sched = virtualScheduler(rig)
  const rt = new ForemanRuntime({
    foreman: rig.foreman,
    clock: { now: rig.now },
    storage: storage.api,
    scheduler: sched.scheduler,
    onError: (e) => errors.push(e)
  })
  return { rig, sched, rt, storage, errors }
}

