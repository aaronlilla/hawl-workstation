// The task queue runner. Nothing here sets a timer: due work waits in ctx.tasks and runs
// when due() is called, so a lapsed lease is always revoked before any later call is read.
import { delegate } from './claims'
import { beatIfDue } from './heartbeat'
import { declineAsked } from './intake'
import type { ForemanCtx } from './state'
import type { ForemanTask } from './types'

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
    beatIfDue(c)
  } finally {
    c.running = false
  }
}

/** The earliest time something is due, so an adapter can sleep until then. */
export function nextDueAt(c: ForemanCtx): number {
  let min = (c.lastBeatAt ?? c.now()) + c.cfg.heartbeatMs
  for (const t of c.tasks.values()) {
    if (!t.done && t.runAfter < min) {
      min = t.runAfter
    }
  }
  return min
}

function run(c: ForemanCtx, task: ForemanTask): void {
  const job = c.jobs.get(task.ref)
  if (!job) {
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
      c.deps.agents.revoke(claim.agentId, {
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
      delegate(c, job)
      return
    }
    case 'hold_check':
      if (job.state === 'accepted' && job.exec !== 'running' && !job.holdNotified) {
        job.holdNotified = true
        c.deps.transport.notifyOwner({ kind: 'job_held_offline', taskId: job.taskId })
      }
      return
    case 'release_check':
      if (job.state === 'accepted' && job.exec !== 'running') {
        c.history(job, 'release', 'foreman', 'release time passed')
        c.revokeLive(job, 'job_closed')
        c.emit(job, 'cancel', { reason: 'released: yard_offline' })
        c.finish(job, 'released: yard_offline')
        c.deps.transport.notifyOwner({ kind: 'job_released', taskId: job.taskId })
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
