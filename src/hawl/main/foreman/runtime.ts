// Runtime for the foreman: the part that owns real time and the disk.
//
// The core never sets a timer. This wrapper sleeps until the core says something is due
// (nextDueAt), ticks it, and saves a snapshot after every change, so a restart picks the
// jobs, leases, rules and clocks up where they were. Time and storage are injected, so the
// same code runs under fake timers in tests and under Electron in the app.
import type { Foreman, ForemanSnapshot } from './foreman'

export type Scheduler = {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** One saved snapshot. write must be all-or-nothing (the file version writes a temp file and renames). */
export type SnapshotStorage = {
  read(): string | null
  write(text: string): void
  /** The saved text could not be read as a snapshot: keep it aside, start empty. */
  quarantine?(text: string): void
}

export type RuntimeOptions = {
  foreman: Foreman
  clock: { now(): number }
  storage: SnapshotStorage
  scheduler?: Scheduler
  /** Longest sleep. setTimeout cannot take more than about 24 days, and a clock jump should be noticed. Default 60 s. */
  maxSleepMs?: number
  /** Saves are merged within this window. Default 200 ms. */
  saveDelayMs?: number
  onError?: (err: unknown) => void
}

const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class ForemanRuntime {
  readonly foreman: Foreman
  readonly #o: Required<Omit<RuntimeOptions, 'onError'>> & Pick<RuntimeOptions, 'onError'>
  #timer: unknown = null
  #saveTimer: unknown = null
  #started = false
  #stopped = false
  #lastSaved = ''

  constructor(opts: RuntimeOptions) {
    this.foreman = opts.foreman
    this.#o = {
      ...opts,
      scheduler: opts.scheduler ?? realScheduler,
      maxSleepMs: opts.maxSleepMs ?? 60_000,
      saveDelayMs: opts.saveDelayMs ?? 200
    }
  }

  /** Load the saved snapshot (if any), catch up on what came due while the app was closed, and start sleeping. */
  start(): { restored: boolean } {
    if (this.#started) {
      throw new Error('foreman runtime already started')
    }
    this.#started = true
    let restored = false
    const text = this.#o.storage.read()
    if (text) {
      try {
        this.foreman.restore(JSON.parse(text) as ForemanSnapshot)
        this.#lastSaved = text
        restored = true
      } catch (err) {
        // A snapshot we cannot read must not stop the app starting, and must not be overwritten silently.
        this.#o.storage.quarantine?.(text)
        this.#o.onError?.(err)
      }
    }
    this.foreman.tick()
    this.#afterChange()
    return { restored }
  }

  /**
   * Run a call on the foreman. Whatever it changes is saved, and the sleep is re-planned.
   * A call that throws still re-plans and saves: the core leaves its state consistent on error.
   */
  run<T>(fn: (f: Foreman) => T): T {
    try {
      return fn(this.foreman)
    } finally {
      this.#afterChange()
    }
  }

  /** Save now and stop sleeping. Safe to call twice. */
  stop(): void {
    if (this.#stopped) {
      return
    }
    this.#stopped = true
    this.#clear('#timer')
    this.#clear('#saveTimer')
    this.#save()
  }

  #clear(which: '#timer' | '#saveTimer'): void {
    const h = which === '#timer' ? this.#timer : this.#saveTimer
    if (h !== null) {
      this.#o.scheduler.clear(h)
    }
    if (which === '#timer') {
      this.#timer = null
    } else {
      this.#saveTimer = null
    }
  }

  #afterChange(minWaitMs = 0): void {
    if (this.#stopped || !this.#started) {
      return
    }
    this.#arm(minWaitMs)
    if (this.#saveTimer === null) {
      this.#saveTimer = this.#o.scheduler.set(() => {
        this.#saveTimer = null
        this.#save()
      }, this.#o.saveDelayMs)
    }
  }

  #arm(minWaitMs = 0): void {
    this.#clear('#timer')
    const due = this.foreman.nextDueAt() - this.#o.clock.now()
    const wait = Math.min(Math.max(minWaitMs, due), this.#o.maxSleepMs)
    this.#timer = this.#o.scheduler.set(() => {
      this.#timer = null
      let failed = false
      try {
        this.foreman.tick()
      } catch (err) {
        failed = true
        this.#o.onError?.(err)
      }
      // A tick that keeps failing must not spin the CPU: wait a second before the next try.
      this.#afterChange(failed ? 1000 : 0)
    }, wait)
  }

  #save(): void {
    try {
      const text = JSON.stringify(this.foreman.snapshot())
      if (text !== this.#lastSaved) {
        this.#o.storage.write(text)
        this.#lastSaved = text
      }
    } catch (err) {
      this.#o.onError?.(err)
    }
  }
}
