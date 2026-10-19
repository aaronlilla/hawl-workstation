// Runtime for the foreman: the part that owns real time and the disk.
//
// The core never sets a timer. This wrapper sleeps until the core says something is due
// (nextDueAt), ticks it, and saves a snapshot after every change, so a restart picks the
// jobs, leases, rules and clocks up where they were. Time and storage are injected, so the
// same code runs under fake timers in tests and under Electron in the app.
//
// Three promises that live here:
//  - Write-ahead: before the core sends anything to the Dispatcher it asks this runtime to save, so a
//    crash right after a send never forgets what was sent (S21: one job, one execution, across restarts).
//  - A snapshot that cannot be read is set aside and the foreman starts empty, never half loaded.
//  - The foreman's own downtime is not the agents' fault: after a sleep or a restart the running leases
//    are renewed once (resumeAfterGap) instead of being revoked on wake.
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
  /**
   * A timer that fires this much later than planned, or a snapshot this much older than now at start,
   * means the app was asleep or closed. Default 2 minutes.
   */
  gapMs?: number
  /** An unchanged snapshot is rewritten after this long, so "saved at" stays close to now. Default 5 min. */
  refreshMs?: number
  onError?: (err: unknown, where?: string) => void
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
  #expectedAt = 0
  #started = false
  #stopped = false
  /** The saved text without its "saved at" stamp, to see whether anything changed. */
  #lastSig = ''
  #lastWriteAt = 0

  constructor(opts: RuntimeOptions) {
    this.foreman = opts.foreman
    this.#o = {
      ...opts,
      scheduler: opts.scheduler ?? realScheduler,
      maxSleepMs: opts.maxSleepMs ?? 60_000,
      saveDelayMs: opts.saveDelayMs ?? 200,
      gapMs: opts.gapMs ?? 120_000,
      refreshMs: opts.refreshMs ?? 5 * 60_000
    }
    this.foreman.attach({
      // Throws when the disk refuses: the core then sends nothing and tries again shortly.
      persist: () => this.#save(true),
      onError: (err, where) => this.#o.onError?.(err, where),
      onChange: () => this.#afterChange()
    })
  }

  /** Load the saved snapshot (if any), catch up on what came due while the app was closed, and start sleeping. */
  start(): { restored: boolean; resumed: boolean } {
    if (this.#started) {
      throw new Error('foreman runtime already started')
    }
    this.#started = true
    let restored = false
    let resumed = false
    let text: string | null = null
    try {
      text = this.#o.storage.read()
    } catch (err) {
      // A file we cannot even read: start empty, but do not write over it until the next real change.
      this.#o.onError?.(err, 'read snapshot')
    }
    if (text) {
      try {
        const { savedAt } = this.foreman.restore(JSON.parse(text))
        this.#lastSig = ''
        this.#lastWriteAt = this.#o.clock.now()
        restored = true
        // Terminals died with the old process and the machine may have slept: renew what was running once.
        if (savedAt === 0 || this.#o.clock.now() - savedAt > this.#o.gapMs) {
          this.foreman.resumeAfterGap()
          resumed = true
        }
      } catch (err) {
        // A snapshot we cannot read must not stop the app starting, and must not be overwritten silently.
        // restore() checks the whole file first, so the foreman is still empty here.
        try {
          this.#o.storage.quarantine?.(text)
        } catch (qErr) {
          this.#o.onError?.(qErr, 'quarantine snapshot')
        }
        this.#o.onError?.(err, 'restore snapshot')
      }
    }
    this.foreman.tick()
    this.#afterChange()
    return { restored, resumed }
  }

  /**
   * Run a call on the foreman. Whatever it changes is saved, and the sleep is re-planned.
   * A call that throws still re-plans and saves: the core changes nothing before a check fails.
   */
  run<T>(fn: (f: Foreman) => T): T {
    try {
      this.#checkGap()
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
    this.#save(false)
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
        this.#save(false)
      }, this.#o.saveDelayMs)
    }
  }

  #arm(minWaitMs = 0): void {
    this.#clear('#timer')
    const now = this.#o.clock.now()
    const due = this.foreman.nextDueAt() - now
    const wait = Math.min(Math.max(minWaitMs, due), this.#o.maxSleepMs)
    this.#expectedAt = now + wait
    this.#timer = this.#o.scheduler.set(() => {
      this.#timer = null
      let failed = false
      try {
        this.#checkGap()
        this.foreman.tick()
      } catch (err) {
        failed = true
        this.#o.onError?.(err, 'tick')
      }
      // A tick that keeps failing must not spin the CPU: wait a second before the next try.
      this.#afterChange(failed ? 1000 : 0)
    }, wait)
  }

  /**
   * The timer is long overdue: the machine slept (or the process was frozen). The agents slept with it,
   * so renew what they hold once before anything else runs. Checked on every call as well as in the timer,
   * because a message from an agent can arrive before the late timer does.
   */
  #checkGap(): void {
    const now = this.#o.clock.now()
    if (this.#started && this.#expectedAt !== 0 && now - this.#expectedAt > this.#o.gapMs) {
      this.#expectedAt = now
      this.foreman.resumeAfterGap()
    }
  }

  /** Write the snapshot if it changed (or is old). With `throwing`, a failed write is the caller's to handle. */
  #save(throwing: boolean): void {
    try {
      const snap = this.foreman.snapshot()
      const now = this.#o.clock.now()
      const text = JSON.stringify(snap)
      const sig = sigOf(snap)
      if (sig !== this.#lastSig || now - this.#lastWriteAt >= this.#o.refreshMs) {
        this.#o.storage.write(text)
        this.#lastSig = sig
        this.#lastWriteAt = now
      }
    } catch (err) {
      if (throwing) {
        throw err
      }
      this.#o.onError?.(err, 'save')
    }
  }
}

/**
 * What makes two snapshots different. The save time and the time of the last heartbeat move on their own every
 * half minute and must not cause a write (and an fsync) each time; everything else does.
 */
function sigOf(snap: ForemanSnapshot): string {
  const { savedAt: _savedAt, lastBeatAt: _lastBeatAt, ...rest } = snap
  return JSON.stringify(rest)
}
