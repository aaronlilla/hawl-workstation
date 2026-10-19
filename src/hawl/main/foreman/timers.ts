// The task queue runner. Nothing here sets a timer: due work waits in ctx.tasks and runs
// when due() is called, so a lapsed lease is always revoked before any later call is read.
import { agentStatus, delegate } from './claims'
import { beatIfDue } from './heartbeat'
import { prune } from './housekeeping'
import { declineAsked } from './intake'
import type { ForemanCtx } from './state'
import { MINUTE_MS, type ForemanTask, type Job } from './types'

/** How often a hold check looks again while agents are online but busy. */
const RECHECK_MS = 30 * MINUTE_MS

/** Run everything due, oldest first, then send a heartbeat if one is due. Re-entrancy safe. */
export function due(c: ForemanCtx): void {
  if (c.running) {
    return
  }
  c.running = true
  try {
    let guard = 0
    for (;;) {
      const now = c.now()
      let next: ForemanTask | undefined
      for (const t of c.tasks.values()) {
        if (t.done || t.runAfter > now) {
          continue
        }
        if (
          !next ||
          t.runAfter < next.runAfter ||
          (t.runAfter === next.runAfter && t.seq < next.seq)
        ) {
          next = t
        }
      }
      if (!next) {
        break
      }
      next.done = true
      run(c, next)
      if (++guard > 100_000) {
        throw new Error('foreman task loop did not settle')
      }
    }
    for (const [k, t] of c.tasks) {
      if (t.done) {
        c.tasks.delete(k)
      }
    }
    prune(c)
    beatIfDue(c)
  } finally {
    c.running = false
  }
  c.flush()
}

/** The earliest time something is due, so an adapter can sleep until then. */
export function nextDueAt(c: ForemanCtx): number {
  let min = Math.min((c.lastBeatAt ?? c.now()) + c.cfg.heartbeatMs, c.box.dueAt())
  for (const t of c.tasks.values()) {
    if (!t.done && t.runAfter < min) {
      min = t.runAfter
    }
  }
  return min
}

/** A hold or release check belongs to the wait that is current; a restarted wait makes older checks stale. */
function waitStarted(job: Job, task: ForemanTask): boolean {
  return Number(task.idem.split(':')[0]) === job.waitingSince
}

function run(c: ForemanCtx, task: ForemanTask): void {
  const job = c.jobs.get(task.ref)
  if (!job) {
    return
  }
  if (job.transferred) {
    // The answering service owns this job's clocks until it is adopted back (S15).
    return
  }
  const now = c.now()
  switch (task.kind) {
    case 'delegate':
      delegate(c, job)
      return
    case 'claim_timeout': {
      const claim = job.claims.find((cl) => cl.epoch === Number(task.idem))
      if (!claim || claim.state !== 'offered' || (claim.offerExpiresAt ?? 0) > now) {
        return
      }
      claim.state = 'released'
      claim.endedAt = now
      claim.endReason = 'offer_timeout'
      job.tried.push(claim.agentId)
      c.history(job, 'timeout', 'foreman', 'offer not answered', claim.agentId)
      c.agentRevoke(claim.agentId, {
        taskId: job.taskId,
        epoch: claim.epoch,
        reason: 'offer_expired'
      })
      job.exec = 'queued'
      delegate(c, job)
      return
    }
    case 'lease_check': {
      const claim = c.liveClaim(job)
      if (!claim || claim.state !== 'active' || (claim.leaseExpiresAt ?? Infinity) > now) {
        return
      }
      // S17: revoke this claim before the job goes to anyone else.
      c.revokeClaim(job, claim, 'lease_lapsed')
      c.history(job, 'revoke', 'foreman', 'lease lapsed', claim.agentId)
      job.exec = 'queued'
      c.restartWait(job)
      delegate(c, job)
      return
    }
    case 'hold_check': {
      if (!waitStarted(job, task) || job.state !== 'accepted' || job.exec === 'running') {
        return
      }
      const status = agentStatus(c, job)
      if (status === 'available') {
        // Someone is up, just busy: not stuck. Look again later in case they all go.
        c.schedule('hold_check', job.taskId, `${job.waitingSince}:${now}`, now + RECHECK_MS)
      } else if (!job.holdNotified) {
        job.holdNotified = true
        if (status === 'none_online') {
          c.notifyOwner({ kind: 'job_held_offline', taskId: job.taskId })
        } else if (!job.exhaustedNotified) {
          // Agents are up, but every one of them already turned the job down or let it lapse.
          job.exhaustedNotified = true
          c.notifyOwner({ kind: 'job_unclaimed', taskId: job.taskId })
        }
      }
      return
    }
    case 'release_check':
      if (waitStarted(job, task) && job.state === 'accepted' && job.exec !== 'running') {
        const status = agentStatus(c, job)
        const reason =
          status === 'none_online'
            ? 'yard_offline'
            : status === 'all_tried'
              ? 'no_agent_took_it'
              : 'yard_busy'
        c.history(job, 'release', 'foreman', 'release time passed')
        c.handBack(job, 'release', reason)
        c.notifyOwner({ kind: 'job_released', taskId: job.taskId })
      }
      return
    case 'held_expire':
      if (job.state === 'asked' && job.exec === 'held') {
        declineAsked(c, job, 'owner_no_answer', 'foreman')
      }
      return
    case 'line_expire':
      if (job.line?.state === 'open' && (job.line.expiresAt ?? Infinity) <= now) {
        job.line.state = 'closed'
        job.line.closeReason = 'ttl'
      }
  }
}
