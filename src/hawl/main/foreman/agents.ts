// Inner agents coming and going (S16, S17), and the foreman's own downtime.
import { forgetTried } from './housekeeping'
import { due } from './timers'
import type { ForemanCtx } from './state'

export function agentUp(
  c: ForemanCtx,
  id: string,
  opts: { label?: string; capacity?: number }
): void {
  const prev = c.agents.get(id)
  const now = c.now()
  c.agents.set(id, {
    id,
    label: opts.label ?? prev?.label ?? id,
    online: true,
    away: false,
    capacity: opts.capacity ?? prev?.capacity ?? 1,
    lastSeenAt: now
  })
  c.lastContactAt = now
  // Back in time: the running claims it had get their full lease again.
  for (const job of c.jobs.values()) {
    const claim = c.liveClaim(job)
    if (claim?.agentId === id && claim.state === 'active' && claim.graceFrom != null) {
      claim.graceFrom = null
      claim.leaseExpiresAt = now + c.cfg.leaseMs
      c.schedule('lease_check', job.taskId, String(claim.leaseExpiresAt), claim.leaseExpiresAt)
    }
  }
  // Back after a lapse or a missed offer: queued jobs may be offered to it again.
  forgetTried(c, id)
  c.delegateAll()
}

/**
 * The agent's terminal is gone. An offer it had not answered is withdrawn at once and the job goes
 * to the next agent. A job it was running keeps its claim for the down grace (default 2 min, so a
 * terminal that reconnects loses nothing); after that the lease counts as lapsed and the job moves on (S17).
 */
export function agentDown(c: ForemanCtx, id: string): void {
  const a = c.agents.get(id)
  if (!a) {
    return
  }
  a.online = false
  const now = c.now()
  a.lastSeenAt = now
  c.lastContactAt = now
  for (const job of c.jobs.values()) {
    const claim = c.liveClaim(job)
    if (!claim || claim.agentId !== id || job.transferred) {
      continue
    }
    if (claim.state === 'offered') {
      // Not its fault, so it is not marked as tried: it can be offered the job again when it returns.
      claim.state = 'released'
      claim.endedAt = now
      claim.endReason = 'agent_down'
      c.history(job, 'timeout', 'foreman', 'agent went offline', id)
      c.agentRevoke(id, { taskId: job.taskId, epoch: claim.epoch, reason: 'agent_down' })
      job.exec = 'queued'
      c.schedule('delegate', job.taskId, '', now)
    } else if (claim.state === 'active') {
      const lease = claim.leaseExpiresAt ?? now
      claim.graceFrom ??= lease
      claim.leaseExpiresAt = Math.min(lease, now + c.cfg.downGraceMs)
      c.schedule('lease_check', job.taskId, String(claim.leaseExpiresAt), claim.leaseExpiresAt)
    }
  }
}

/**
 * The foreman itself was not running for a while (laptop asleep, app closed or crashed). The agents
 * were suspended with it, so their leases and open offers must not run out because of that time:
 * each gets a fresh full lease or offer window from now, and must renew or answer as usual.
 * Hold and release clocks keep counting: the sender is still waiting. Returns how many were extended.
 *
 * No catch-up runs first: due work would revoke the very leases this is about to renew.
 */
export function resumeAfterGap(c: ForemanCtx): number {
  const now = c.now()
  let n = 0
  for (const job of c.jobs.values()) {
    if (job.transferred) {
      continue
    }
    for (const claim of job.claims) {
      if (claim.state === 'active') {
        const want = now + (claim.graceFrom != null ? c.cfg.downGraceMs : c.cfg.leaseMs)
        if ((claim.leaseExpiresAt ?? 0) < want) {
          claim.leaseExpiresAt = want
          c.schedule('lease_check', job.taskId, String(want), want)
          n++
        }
      } else if (claim.state === 'offered') {
        const want = now + c.cfg.offerMs
        if ((claim.offerExpiresAt ?? 0) < want) {
          claim.offerExpiresAt = want
          c.schedule('claim_timeout', job.taskId, String(claim.epoch), want)
          n++
        }
      }
    }
  }
  due(c)
  return n
}
