// Small clean-ups the foreman does as it goes: forgetting old jobs, and giving agents a second chance.
import type { ForemanCtx } from './state'

const MAX_TOMBSTONES = 100_000

/** Forget jobs that ended longer ago than the retention time, leaving a small tombstone (S21). */
export function prune(c: ForemanCtx): void {
  const cutoff = c.now() - c.cfg.retentionMs
  for (const [id, j] of c.jobs) {
    if (j.closedAt !== null && j.exec === null && !j.transferred && j.closedAt <= cutoff) {
      c.jobs.delete(id)
      c.tombs.set(id, { taskId: id, state: j.state, closedAt: j.closedAt, offerAt: j.offerAt })
    }
  }
  // A tombstone is a few bytes; the cap only stops a runaway file. Oldest go first.
  while (c.tombs.size > MAX_TOMBSTONES) {
    const first = c.tombs.keys().next().value
    if (first === undefined) {
      break
    }
    c.tombs.delete(first)
  }
}

/**
 * An agent showed up again (restart, back from away). Agents that lapsed or let an offer expire
 * get another chance on queued jobs; an agent that said "no" to a job stays out of that job.
 */
export function forgetTried(c: ForemanCtx, agentId: string): void {
  for (const j of c.jobs.values()) {
    if (j.state !== 'accepted' || j.exec !== 'queued' || !j.tried.includes(agentId)) {
      continue
    }
    const last = j.claims.findLast((cl) => cl.agentId === agentId)
    if (last?.endReason === 'declined') {
      continue
    }
    j.tried = j.tried.filter((id) => id !== agentId)
    j.exhaustedNotified = false
  }
}
