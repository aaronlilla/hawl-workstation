// Job intake (S9, S15, S21) and the offline queue handover (plan decision, S18).
import {
  checkContract,
  nextTaskState,
  type LifecycleEvent
} from '../../shared/gateway-contract/contract'
import { iso, type ForemanCtx } from './state'
import { ForemanError, MINUTE_MS } from './types'
import { jobView, tombView } from './views'
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
    pinAgent: null,
    offerAt: Date.parse(ev.at),
    transferred: false,
    state: 'asked',
    exec: null,
    receivedAt: c.now(),
    acceptedAt: null,
    eta: null,
    claimEpoch: 0,
    claims: [],
    tried: [],
    history: [],
    routing: [],
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
  // The capability is optional in the contract: a free-form offer is judged on the yard-wide rules.
  const cap = job.capability === null ? undefined : c.cap(job)
  if (job.capability !== null && (!cap || cap.open === false)) {
    return 'no_such_capability'
  }
  const allowed = cap?.acceptFrom ?? c.cfg.acceptFrom
  if (
    allowed &&
    allowed.length > 0 &&
    !allowed.includes('site') &&
    !allowed.includes(job.requester)
  ) {
    return 'not_accepted_from'
  }
  if (cap?.acceptWhenOffline === false && !c.anyOnline()) {
    return 'offline'
  }
  return null
}

function needsOwner(c: ForemanCtx, job: Job): boolean {
  if (!c.autoAccept || c.cap(job)?.approval === 'ask_owner') {
    return true
  }
  if (job.capability === null && (c.cfg.freeformApproval ?? 'ask_owner') === 'ask_owner') {
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
  const known = c.jobs.get(ev.task_id)
  const tomb = c.tombs.get(ev.task_id)
  const at = Date.parse(ev.at)
  let job: Job
  if (known) {
    if (known.state !== 'reassigned' || at <= known.offerAt) {
      // S21: a second delivery of the same offer changes nothing and sends nothing.
      return { outcome: 'duplicate', reason: null, view: jobView(c, ev.task_id) }
    }
    // The contract lets a handed-back task be offered again (reassigned -> offer -> asked). A newer
    // offer on such a task is a new offer; the history and the claim epochs carry over.
    job = reoffer(c, known, ev, input)
  } else if (tomb && (tomb.state !== 'reassigned' || at <= tomb.offerAt)) {
    return { outcome: 'duplicate', reason: null, view: tombView(tomb) }
  } else {
    c.tombs.delete(ev.task_id)
    job = blankJob(c, ev, input.requester)
    job.preferAgent = input.preferAgent ?? null
    c.jobs.set(job.taskId, job)
  }
  return admit(c, job)
}

/** A handed-back job comes back to this yard: reset the parts of it that belong to one stay. */
function reoffer(c: ForemanCtx, job: Job, ev: LifecycleEvent, input: IntakeInput): Job {
  if (nextTaskState(job.state, 'offer') !== 'asked') {
    throw new ForemanError('bad_state', `offer not allowed from ${job.state}`)
  }
  job.state = 'asked'
  job.capability = ev.capability ?? null
  job.acceptance = ev.acceptance ? [...ev.acceptance] : []
  job.qualityBar = ev.quality_bar ?? null
  job.deadline = ev.deadline ?? null
  job.requester = input.requester
  job.preferAgent = input.preferAgent ?? null
  job.pinAgent = null
  job.offerAt = Date.parse(ev.at)
  job.receivedAt = c.now()
  job.acceptedAt = null
  job.waitingSince = null
  job.eta = null
  job.exec = null
  job.tried = []
  job.reroutes = 0
  job.sendBacks = 0
  job.needsHuman = false
  job.holdNotified = false
  job.exhaustedNotified = false
  job.closedReason = null
  job.closedAt = null
  job.transferred = false
  job.line = null
  c.history(job, 'reoffer', 'dispatcher', null)
  return job
}

/** Decide a new (or re-offered) job: refuse, hold for the owner, or accept now. */
function admit(c: ForemanCtx, job: Job): IntakeResult {
  const why = refusal(c, job)
  if (why) {
    declineAsked(c, job, why, 'foreman')
    return { outcome: 'declined', reason: why, view: jobView(c, job.taskId) }
  }
  if (needsOwner(c, job)) {
    hold(c, job)
    return { outcome: 'held', reason: null, view: jobView(c, job.taskId) }
  }
  acceptJob(c, job)
  return { outcome: 'accepted', reason: null, view: jobView(c, job.taskId) }
}

function hold(c: ForemanCtx, job: Job): void {
  job.exec = 'held'
  c.schedule('held_expire', job.taskId, '', job.receivedAt + c.cfg.releaseMs)
  c.deps.transport.notifyOwner({ kind: 'job_needs_approval', taskId: job.taskId })
}

/** The owner answers a held job. */
export function ownerDecision(
  c: ForemanCtx,
  taskId: string,
  decision: 'accept' | 'decline',
  by: string,
  reason?: string
): void {
  const job = c.needLocal(taskId)
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

function offerEventOf(c: ForemanCtx, j: Job): LifecycleEvent {
  return {
    yard: c.cfg.yard,
    task_id: j.taskId,
    event: 'offer' as const,
    at: iso(j.offerAt),
    ...(j.capability ? { capability: j.capability } : {}),
    ...(j.acceptance.length > 0 ? { acceptance: [...j.acceptance] } : {}),
    ...(j.qualityBar ? { quality_bar: j.qualityBar } : {}),
    ...(j.deadline ? { deadline: j.deadline } : {})
  }
}

/**
 * Hand over everything waiting: jobs accepted but not running, and jobs held for the owner,
 * in queue order, for the answering service to keep while this foreman is away (S15).
 * Each exported job is marked as handed off: this foreman stops running its clocks and offers
 * until adoptQueue takes it back, so the foreman and the service never both act on one job.
 * An unanswered offer to an agent is withdrawn first.
 */
export function exportQueue(c: ForemanCtx): QueueEntry[] {
  const out = [...c.jobs.values()]
    .filter(
      (j) =>
        (j.state === 'accepted' && (j.exec === 'queued' || j.exec === 'offered')) ||
        (j.state === 'asked' && j.exec === 'held')
    )
    .sort(
      (a, b) => (a.acceptedAt ?? a.receivedAt) - (b.acceptedAt ?? b.receivedAt) || a.seq - b.seq
    )
  return out.map((j) => {
    const live = c.liveClaim(j)
    if (live?.state === 'offered') {
      live.state = 'released'
      live.endedAt = c.now()
      live.endReason = 'handed_over'
      c.deps.agents.revoke(live.agentId, {
        taskId: j.taskId,
        epoch: live.epoch,
        reason: 'handed_over'
      })
      j.exec = 'queued'
    }
    j.transferred = true
    const held = j.state === 'asked'
    return {
      offer: offerEventOf(c, j),
      requester: j.requester,
      acceptedAt: j.acceptedAt ?? j.receivedAt,
      receivedAt: j.receivedAt,
      ...(held ? { held: true } : {}),
      ...(j.preferAgent ? { preferAgent: j.preferAgent } : {}),
      ownerNotified: held ? true : j.holdNotified
    }
  })
}

/**
 * The answering service hands over what it accepted (or is holding for the owner) while this
 * foreman was offline. Queue order is kept, hold and release times count from the service's
 * accept time, jobs we already run are skipped (S21), and no second "accept" is sent.
 * A job this foreman exported earlier simply comes back under its control.
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
    const known = c.jobs.get(e.offer.task_id)
    if (known?.transferred) {
      known.transferred = false
      known.holdNotified = known.holdNotified || (e.ownerNotified ?? false)
      if (known.state === 'accepted') {
        known.waitingSince = e.acceptedAt
        c.scheduleTimers(known)
        c.schedule('delegate', known.taskId, '', c.now())
      } else if (known.exec === 'held') {
        c.schedule('held_expire', known.taskId, '', known.receivedAt + c.cfg.releaseMs)
      }
      adopted.push(known.taskId)
      continue
    }
    if (known || c.tombs.has(e.offer.task_id)) {
      skipped.push(e.offer.task_id)
      continue
    }
    const job = blankJob(c, e.offer, e.requester)
    job.preferAgent = e.preferAgent ?? null
    if (e.held) {
      job.receivedAt = e.receivedAt ?? e.acceptedAt
      job.exec = 'held'
      c.jobs.set(job.taskId, job)
      c.schedule('held_expire', job.taskId, '', job.receivedAt + c.cfg.releaseMs)
      if (!e.ownerNotified) {
        c.deps.transport.notifyOwner({ kind: 'job_needs_approval', taskId: job.taskId })
      }
      adopted.push(job.taskId)
      continue
    }
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
