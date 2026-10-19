// Read-only views of a foreman's jobs (S15 status text, S16 holder, S19/S20 history).
import { iso, type ForemanCtx } from './state'
import type { Claim, JobView, Tombstone } from './types'

export function jobView(c: ForemanCtx, taskId: string): JobView {
  const job = c.need(taskId)
  const live = c.liveClaim(job)
  const queuedNotRunning =
    job.state === 'accepted' && (job.exec === 'queued' || job.exec === 'offered')
  const contact = c.lastContactAt === null ? 'never' : iso(c.lastContactAt)
  let statusText: string
  if (queuedNotRunning && job.exec === 'offered') {
    statusText = `offered, not running (last contact ${contact})`
  } else if (queuedNotRunning) {
    statusText = `queued, not running (last contact ${contact})`
  } else if (job.exec === 'running') {
    statusText = 'running'
  } else if (job.exec === 'held') {
    statusText = 'waiting for the owner'
  } else {
    statusText = job.closedReason ? `${job.state}: ${job.closedReason}` : job.state
  }
  return {
    taskId: job.taskId,
    capability: job.capability,
    requester: job.requester,
    state: job.state,
    exec: job.exec,
    holder: live?.state === 'active' ? live.agentId : 'foreman',
    claim: live
      ? {
          agentId: live.agentId,
          epoch: live.epoch,
          state: live.state,
          leaseExpiresAt: live.leaseExpiresAt
        }
      : null,
    eta: job.eta,
    statusText,
    queuedNotRunning,
    lastContactAt: c.lastContactAt,
    needsHuman: job.needsHuman,
    history: job.history.map((h) => ({ ...h })),
    routing: job.routing.map((r) => ({ ...r, skipped: r.skipped.map((x) => ({ ...x })) })),
    line: job.line ? { ...job.line } : null
  }
}

/** Every claim ever made on a job, oldest first. */
export function claimsOf(c: ForemanCtx, taskId: string): Claim[] {
  return c.need(taskId).claims.map((cl) => ({ ...cl }))
}

/** Agents with an active claim: used for "busy, untitled" cards (S24) and the heartbeat. */
export function busyAgentIds(c: ForemanCtx): string[] {
  const ids = new Set<string>()
  for (const j of c.jobs.values()) {
    const live = c.liveClaim(j)
    if (live?.state === 'active') {
      ids.add(live.agentId)
    }
  }
  return [...ids]
}

/** What is left of a job that ended and was forgotten: enough to answer a redelivered offer. */
export function tombView(t: Tombstone): JobView {
  return {
    taskId: t.taskId,
    capability: null,
    requester: '',
    state: t.state,
    exec: null,
    holder: 'foreman',
    claim: null,
    eta: null,
    statusText: `${t.state} (details forgotten after the retention time)`,
    queuedNotRunning: false,
    lastContactAt: null,
    needsHuman: false,
    history: [],
    routing: [],
    line: null
  }
}
