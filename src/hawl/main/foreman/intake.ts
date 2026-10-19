// Job intake (S9, S15, S21) and the offline queue handover (plan decision, S18).
import { checkContract, type LifecycleEvent } from '../../shared/gateway-contract/contract'
import { iso, type ForemanCtx } from './state'
import { ForemanError, MINUTE_MS } from './types'
import { jobView } from './views'
import type { IntakeInput, IntakeResult, Job, QueueEntry } from './types'

function blankJob(c: ForemanCtx, ev: LifecycleEvent, requester: string): Job {
  return {
    taskId: ev.task_id,
    capability: ev.capability ?? null,
    acceptance: ev.acceptance ? [...ev.acceptance] : [],
    qualityBar: ev.quality_bar ?? null,
    deadline: ev.deadline ?? null,
    requester,
    preferAgent: null,
    state: 'asked',
    exec: null,
    receivedAt: c.now(),
    acceptedAt: null,
    eta: null,
    claimEpoch: 0,
    claims: [],
    tried: [],
    history: [],
    reroutes: 0,
    sendBacks: 0,
    needsHuman: false,
    holdNotified: false,
    exhaustedNotified: false,
    line: null,
    closedReason: null,
    closedAt: null,
    waitingSince: null,
    seq: ++c.seq
  }
}

/** Why a new job cannot be taken, or null. */
function refusal(c: ForemanCtx, job: Job): string | null {
  if (c.paused) {
    return 'paused'
  }
  const cap = c.cap(job)
  if (!cap || cap.open === false) {
    return 'no_such_capability'
  }
  const allowed = cap.acceptFrom ?? c.cfg.acceptFrom
  if (
    allowed &&
    allowed.length > 0 &&
    !allowed.includes('site') &&
    !allowed.includes(job.requester)
  ) {
    return 'not_accepted_from'
  }
  if (cap.acceptWhenOffline === false && !c.anyOnline()) {
    return 'offline'
  }
  return null
}

function needsOwner(c: ForemanCtx, job: Job): boolean {
  if (!c.autoAccept || c.cap(job)?.approval === 'ask_owner') {
    return true
  }
  const budget = c.cfg.dailyBudgetUsd
  return budget !== undefined && (c.spent.get(c.dayKey()) ?? 0) >= budget
}

export function declineAsked(c: ForemanCtx, job: Job, reason: string, by: string): void {
  c.history(job, 'decline', by, reason)
  c.emit(job, 'decline', { reason: reason.slice(0, 500) })
  job.exec = null
  job.closedReason = reason
  job.closedAt = c.now()
}

/** Accept now, whether or not any agent is online (S15), and start the hold and release clocks. */
export function acceptJob(c: ForemanCtx, job: Job): void {
  const now = c.now()
  c.emit(job, 'accept', {})
  job.acceptedAt = now
  job.waitingSince = now
  job.exec = 'queued'
  const minutes = c.cap(job)?.typical_minutes
  job.eta = minutes !== undefined && c.anyOnline() ? now + minutes * MINUTE_MS : null
  c.scheduleTimers(job)
  c.schedule('delegate', job.taskId, '', now)
}

/**
 * A job arrives from the Dispatcher. The same task id twice is one job (S21).
 * Auto-accept capabilities are accepted at once (S15).
 */
export function intake(c: ForemanCtx, input: IntakeInput): IntakeResult {
  const ev = input.offer
  const err = checkContract('lifecycle', ev)
  if (err) {
    throw new ForemanError('bad_offer', err)
  }
  if (ev.event !== 'offer') {
    throw new ForemanError('bad_offer', `expected offer, got ${ev.event}`)
  }
  if (ev.yard !== c.cfg.yard) {
    throw new ForemanError('wrong_yard', `not ${c.cfg.yard}`)
  }
  if (c.jobs.has(ev.task_id)) {
    // S21: a second delivery of the same offer changes nothing and sends nothing.
    return { outcome: 'duplicate', reason: null, view: jobView(c, ev.task_id) }
  }
  const job = blankJob(c, ev, input.requester)
  job.preferAgent = input.preferAgent ?? null
  c.jobs.set(job.taskId, job)

  const why = refusal(c, job)
  if (why) {
    declineAsked(c, job, why, 'foreman')
    return { outcome: 'declined', reason: why, view: jobView(c, job.taskId) }
  }
  if (needsOwner(c, job)) {
    job.exec = 'held'
    c.schedule('held_expire', job.taskId, '', job.receivedAt + c.cfg.releaseMs)
    c.deps.transport.notifyOwner({ kind: 'job_needs_approval', taskId: job.taskId })
    return { outcome: 'held', reason: null, view: jobView(c, job.taskId) }
  }
  acceptJob(c, job)
  return { outcome: 'accepted', reason: null, view: jobView(c, job.taskId) }
}

/** The owner answers a held job. */
export function ownerDecision(
  c: ForemanCtx,
  taskId: string,
  decision: 'accept' | 'decline',
  by: string,
  reason?: string
): void {
  const job = c.need(taskId)
  if (job.exec !== 'held' || job.state !== 'asked') {
    throw new ForemanError('bad_state', 'job is not waiting for the owner')
  }
  c.drop('held_expire', taskId)
  if (decision === 'accept') {
    c.history(job, 'approve', by, reason ?? null)
    acceptJob(c, job)
  } else {
    declineAsked(c, job, reason ?? 'declined by owner', by)
  }
}

/** Jobs accepted but not running, in queue order, for the answering service to keep. */
export function exportQueue(c: ForemanCtx): QueueEntry[] {
  return [...c.jobs.values()]
    .filter((j) => j.state === 'accepted' && (j.exec === 'queued' || j.exec === 'offered'))
    .sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0) || a.seq - b.seq)
    .map((j) => ({
      offer: {
        yard: c.cfg.yard,
        task_id: j.taskId,
        event: 'offer' as const,
        at: iso(j.receivedAt),
        ...(j.capability ? { capability: j.capability } : {}),
        ...(j.acceptance.length > 0 ? { acceptance: [...j.acceptance] } : {}),
        ...(j.qualityBar ? { quality_bar: j.qualityBar } : {}),
        ...(j.deadline ? { deadline: j.deadline } : {})
      },
      requester: j.requester,
      acceptedAt: j.acceptedAt ?? j.receivedAt,
      ...(j.preferAgent ? { preferAgent: j.preferAgent } : {}),
      ownerNotified: j.holdNotified
    }))
}

/**
 * The answering service hands over what it accepted while this foreman was offline.
 * Queue order is kept, hold and release times count from the service's accept time,
 * jobs we already know are skipped (S21), and no second "accept" is sent.
 */
export function adoptQueue(
  c: ForemanCtx,
  entries: QueueEntry[]
): { adopted: string[]; skipped: string[] } {
  const adopted: string[] = []
  const skipped: string[] = []
  const sorted = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.acceptedAt - b.e.acceptedAt || a.i - b.i)
  for (const { e } of sorted) {
    const err = checkContract('lifecycle', e.offer)
    if (err || e.offer.event !== 'offer' || e.offer.yard !== c.cfg.yard) {
      throw new ForemanError('bad_offer', err ?? 'queue entry is not an offer for this yard')
    }
    if (c.jobs.has(e.offer.task_id)) {
      skipped.push(e.offer.task_id)
      continue
    }
    const job = blankJob(c, e.offer, e.requester)
    job.preferAgent = e.preferAgent ?? null
    job.state = 'accepted'
    job.exec = 'queued'
    job.receivedAt = e.acceptedAt
    job.acceptedAt = e.acceptedAt
    job.waitingSince = e.acceptedAt
    job.holdNotified = e.ownerNotified ?? false
    c.jobs.set(job.taskId, job)
    c.scheduleTimers(job)
    c.schedule('delegate', job.taskId, '', c.now())
    adopted.push(job.taskId)
  }
  return { adopted, skipped }
}
