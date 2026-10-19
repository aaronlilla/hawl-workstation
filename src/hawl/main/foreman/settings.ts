// What the owner changes from the console: the switches and the hold and release times (S15, S18).
import type { ForemanCtx } from './state'
import { ForemanError, HOUR_MS, MINUTE_MS } from './types'
import type { SnapshotSettings } from './snapshot'

export type SettingsView = {
  paused: boolean
  autoAccept: boolean
  holdMs: number
  releaseMs: number
  leaseMs: number
  offerMs: number
}

export function settingsOf(c: ForemanCtx): SettingsView {
  const { holdMs, releaseMs, leaseMs, offerMs } = c.cfg
  return { paused: c.paused, autoAccept: c.autoAccept, holdMs, releaseMs, leaseMs, offerMs }
}

/**
 * Hold is 1 minute to 7 days, release from the hold time to 30 days. Nothing changes when a value is refused.
 * Jobs already waiting get the new clocks; the menu shows them after the next publish.
 */
export function setTimes(
  c: ForemanCtx,
  t: { holdMs?: number; releaseMs?: number }
): SnapshotSettings {
  const holdMs = t.holdMs ?? c.cfg.holdMs
  const releaseMs = t.releaseMs ?? c.cfg.releaseMs
  const whole = (v: number): boolean => Number.isInteger(v) && v > 0
  if (!whole(holdMs) || !whole(releaseMs)) {
    throw new ForemanError('bad_setting', 'times are whole milliseconds above zero')
  }
  if (holdMs < MINUTE_MS || holdMs > 7 * 24 * HOUR_MS) {
    throw new ForemanError('bad_setting', 'the hold time is 1 minute to 7 days')
  }
  if (releaseMs < holdMs || releaseMs > 30 * 24 * HOUR_MS) {
    throw new ForemanError('bad_setting', 'the release time is from the hold time up to 30 days')
  }
  c.cfg.holdMs = holdMs
  c.cfg.releaseMs = releaseMs
  c.ownerTimes = { holdMs, releaseMs }
  for (const job of c.jobs.values()) {
    if (job.state === 'accepted' && job.exec !== 'running' && !job.transferred) {
      c.drop('hold_check', job.taskId)
      c.drop('release_check', job.taskId)
      c.scheduleTimers(job)
    }
  }
  return { holdMs, releaseMs }
}
