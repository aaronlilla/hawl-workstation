// Direct lines between agents of two yards (S10). A line opens only when both foremen
// approve, lasts for the job (or its time limit), and then later messages are refused.
import type { ForemanCtx } from './state'
import { ForemanError, MINUTE_MS } from './types'
import type { DirectLine, Job } from './types'

export type LineRequest = {
  fromInner: string
  toVillage: string
  purpose: string
  ttlMinutes: number
  /** "remote" means the other foreman asked and already approved. */
  origin?: 'local' | 'remote'
}

function settle(c: ForemanCtx, job: Job): void {
  const line = job.line
  if (!line || line.state !== 'requested') {
    return
  }
  if (line.localOk === false || line.remoteOk === false) {
    line.state = 'rejected'
  } else if (line.localOk && line.remoteOk) {
    line.state = 'open'
    // The time limit runs from the moment the line opens, not from the request.
    line.expiresAt = c.now() + line.ttlMs
    c.schedule('line_expire', job.taskId, String(line.expiresAt), line.expiresAt)
  }
}

function decideLocal(c: ForemanCtx, job: Job, approve: boolean, reason?: string): void {
  if (!job.line) {
    return
  }
  c.emit(job, approve ? 'direct_line_approve' : 'direct_line_reject', reason ? { reason } : {})
  job.line.localOk = approve
  settle(c, job)
}

export function openLine(c: ForemanCtx, taskId: string, req: LineRequest): void {
  const job = c.need(taskId)
  if (job.state !== 'accepted') {
    throw new ForemanError('bad_line', 'a line needs an accepted job')
  }
  if (job.line && (job.line.state === 'requested' || job.line.state === 'open')) {
    throw new ForemanError('bad_line', 'this job already has a line')
  }
  const origin = req.origin ?? 'local'
  if (origin === 'local') {
    c.emit(job, 'direct_line_open', {
      from_inner: req.fromInner,
      to_village: req.toVillage,
      purpose: req.purpose,
      ttl_minutes: req.ttlMinutes
    })
  } else if (
    req.ttlMinutes < 1 ||
    req.ttlMinutes > 1440 ||
    !req.purpose ||
    req.purpose.length > 280
  ) {
    throw new ForemanError('bad_line', 'purpose or ttl out of range')
  }
  const line: DirectLine = {
    state: 'requested',
    fromInner: req.fromInner,
    toVillage: req.toVillage,
    purpose: req.purpose,
    ttlMs: req.ttlMinutes * MINUTE_MS,
    localOk: null,
    remoteOk: origin === 'remote' ? true : null,
    expiresAt: null,
    closeReason: null
  }
  job.line = line
  const policy = c.cfg.directLines ?? 'ask_owner'
  if (policy === 'never') {
    decideLocal(c, job, false, 'foreman policy: never')
  } else if (policy === 'job_parties') {
    decideLocal(c, job, true)
  } else {
    c.notifyOwner({ kind: 'line_request', taskId })
  }
}

/** The yard owner answers a pending line request. */
export function decideLine(c: ForemanCtx, taskId: string, approve: boolean, reason?: string): void {
  const job = c.need(taskId)
  if (job.line?.state !== 'requested' || job.line.localOk !== null) {
    throw new ForemanError('bad_line', 'no line waiting for this yard')
  }
  decideLocal(c, job, approve, reason)
}

/** The other yard's foreman answered. */
export function remoteLineDecision(c: ForemanCtx, taskId: string, approve: boolean): void {
  const job = c.need(taskId)
  const line = job.line
  if (line?.state !== 'requested' || line.remoteOk !== null) {
    throw new ForemanError('bad_line', 'no line waiting for the other yard')
  }
  line.remoteOk = approve
  settle(c, job)
}

/** May this inner agent talk to that yard about this job right now? */
export function lineAllows(
  c: ForemanCtx,
  taskId: string,
  fromInner: string,
  toVillage: string
): boolean {
  const line = c.jobs.get(taskId)?.line
  if (!line || line.state !== 'open') {
    return false
  }
  if (line.expiresAt !== null && c.now() >= line.expiresAt) {
    return false
  }
  return line.fromInner === fromInner && line.toVillage === toVillage
}
