// Routing to inner agents and the claim life cycle (S16, S17, S19, S21).
import type { ForemanCtx } from './state'
import { ForemanError } from './types'
import type { AgentInfo, Claim, Job } from './types'

function load(c: ForemanCtx, agentId: string): number {
  let n = 0
  for (const j of c.jobs.values()) {
    if (c.liveClaim(j)?.agentId === agentId) {
      n++
    }
  }
  return n
}

/** Rule first, then the requester's preference, then the least loaded agent by id. */
function pick(c: ForemanCtx, job: Job): AgentInfo | undefined {
  const allowed = c.cap(job)?.agents
  let candidates = [...c.agents.values()].filter(
    (a) => a.online && !a.away && !job.tried.includes(a.id) && load(c, a.id) < a.capacity
  )
  if (allowed && allowed.length > 0) {
    candidates = candidates.filter((a) => allowed.includes(a.id))
  }
  if (candidates.length === 0) {
    return undefined
  }
  const rule = c.rules.find(
    (r) =>
      (r.match.capability === undefined || r.match.capability === job.capability) &&
      (r.match.fromYard === undefined || r.match.fromYard === job.requester)
  )
  const byRule = rule && candidates.find((a) => a.id === rule.action.agentId)
  if (byRule) {
    return byRule
  }
  const byPref = job.preferAgent ? candidates.find((a) => a.id === job.preferAgent) : undefined
  if (byPref) {
    return byPref
  }
  return candidates.sort((a, b) => load(c, a.id) - load(c, b.id) || (a.id < b.id ? -1 : 1))[0]
}

/** Offer a queued job to one agent. With none free it stays queued: no promise of running. */
export function delegate(c: ForemanCtx, job: Job): void {
  if (job.state !== 'accepted' || job.exec !== 'queued' || job.needsHuman || c.paused) {
    return
  }
  if (job.tried.length >= c.cfg.maxAgentsPerJob) {
    if (!job.exhaustedNotified) {
      job.exhaustedNotified = true
      c.deps.transport.notifyOwner({ kind: 'job_unclaimed', taskId: job.taskId })
    }
    return
  }
  const agent = pick(c, job)
  if (!agent) {
    return
  }
  const epoch = job.claimEpoch + 1
  const offerExpiresAt = c.now() + c.cfg.offerMs
  job.claimEpoch = epoch
  job.claims.push({
    agentId: agent.id,
    epoch,
    state: 'offered',
    offerExpiresAt,
    leaseExpiresAt: null,
    endedAt: null,
    endReason: null
  })
  job.exec = 'offered'
  c.schedule('claim_timeout', job.taskId, String(epoch), offerExpiresAt)
  c.deps.agents.offer(agent.id, {
    taskId: job.taskId,
    epoch,
    capability: job.capability,
    acceptance: [...job.acceptance],
    deadline: job.deadline,
    offerExpiresAt
  })
}

/** An inner agent takes the offered job. Running starts here, not before (S16). */
export function agentAccept(
  c: ForemanCtx,
  taskId: string,
  agentId: string,
  epoch: number
): { duplicate: boolean } {
  c.touch(agentId)
  const job = c.need(taskId)
  const claim = job.claims.find((cl) => cl.epoch === epoch)
  if (!claim) {
    throw new ForemanError('claim_revoked', 'no such claim')
  }
  if (claim.state === 'active') {
    // The same offer accepted twice is a no-op for the same agent, an error for any other.
    if (claim.agentId === agentId) {
      return { duplicate: true }
    }
    throw new ForemanError('claim_taken', 'another agent holds this job')
  }
  if (claim.state !== 'offered' || claim.agentId !== agentId || epoch !== job.claimEpoch) {
    throw new ForemanError('claim_revoked', 'this offer is no longer yours')
  }
  claim.state = 'active'
  claim.offerExpiresAt = null
  claim.leaseExpiresAt = c.now() + c.cfg.leaseMs
  job.exec = 'running'
  job.eta = null
  c.schedule('lease_check', taskId, String(claim.leaseExpiresAt), claim.leaseExpiresAt)
  return { duplicate: false }
}

export function agentDecline(
  c: ForemanCtx,
  taskId: string,
  agentId: string,
  epoch: number,
  reason?: string
): void {
  c.touch(agentId)
  const job = c.need(taskId)
  const claim = job.claims.find((cl) => cl.epoch === epoch)
  if (!claim || claim.agentId !== agentId) {
    throw new ForemanError('claim_revoked', 'no such claim')
  }
  if (claim.state !== 'offered') {
    throw new ForemanError('claim_revoked', 'offer is not open')
  }
  claim.state = 'released'
  claim.endedAt = c.now()
  claim.endReason = 'declined'
  job.tried.push(agentId)
  c.history(job, 'decline', agentId, reason ?? null, agentId)
  job.exec = 'queued'
  c.schedule('delegate', taskId, '', c.now())
}

/** Activity from the working agent renews the lease. A revoked claim cannot renew. */
export function agentRenew(c: ForemanCtx, taskId: string, agentId: string, epoch: number): void {
  c.touch(agentId)
  const claim = c.activeClaim(c.need(taskId), agentId, epoch)
  claim.leaseExpiresAt = c.now() + c.cfg.leaseMs
  c.schedule('lease_check', taskId, String(claim.leaseExpiresAt), claim.leaseExpiresAt)
}

export function agentProgress(
  c: ForemanCtx,
  taskId: string,
  agentId: string,
  epoch: number,
  note?: string
): void {
  agentRenew(c, taskId, agentId, epoch)
  c.emit(c.need(taskId), 'progress', note ? { note: note.slice(0, 500) } : {})
}

export type DoneReport = {
  revisionSha: string
  evidence: { kind: 'sha' | 'ci' | 'pr' | 'artifact'; ref: string }[]
}

/** The agent reports done. Refused when its claim was revoked or is from an older epoch (S17). */
export function agentDone(
  c: ForemanCtx,
  taskId: string,
  agentId: string,
  epoch: number,
  report: DoneReport
): { duplicate: boolean } {
  c.touch(agentId)
  const job = c.need(taskId)
  const prior: Claim | undefined = job.claims.find(
    (cl) => cl.epoch === epoch && cl.agentId === agentId
  )
  if (prior?.state === 'finished' && job.state !== 'accepted') {
    return { duplicate: true }
  }
  const live = c.activeClaim(job, agentId, epoch)
  // Build and check the event before changing anything, so a bad report leaves the claim alone.
  c.emit(job, 'done', { revision_sha: report.revisionSha, evidence: report.evidence })
  live.state = 'finished'
  live.endedAt = c.now()
  live.endReason = 'done'
  job.exec = null
  c.delegateAll()
  return { duplicate: false }
}
