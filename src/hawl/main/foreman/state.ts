// Shared state of one foreman and the small helpers every part uses. The other files in
// this folder are plain functions over a ForemanCtx; foreman.ts is the public face.
import {
  checkContract,
  nextTaskState,
  type LifecycleEvent,
  type LifecycleEventName
} from '../../shared/gateway-contract/contract'
import { CardBook } from './cards'
import { deliver, Outbox } from './outbox'
import { checkHandBack } from './m2-schemas'
import type { ExtendedMenu } from './menu'
import {
  ForemanError,
  HOUR_MS,
  MINUTE_MS,
  type AgentInfo,
  type CapabilityConfig,
  type AgentOffer,
  type AgentRevoke,
  type Claim,
  type Effect,
  type ForemanConfig,
  type ForemanDeps,
  type ForemanHooks,
  type ForemanRule,
  type ForemanTask,
  type FullTaskKind,
  type HistoryKind,
  type Job,
  type OwnerNotice,
  type RequesterNotice,
  type Tombstone
} from './types'
import type { Menu } from '../../shared/gateway-contract/contract'

export const DEFAULTS = {
  holdMs: 4 * HOUR_MS,
  releaseMs: 24 * HOUR_MS,
  leaseMs: 30 * MINUTE_MS,
  offerMs: 10 * MINUTE_MS,
  maxAgentsPerJob: 3,
  maxReroutes: 3,
  maxSendBacks: 3,
  heartbeatMs: 30_000,
  downGraceMs: 2 * MINUTE_MS,
  outboxMaxAgeMs: 24 * HOUR_MS,
  retentionMs: 30 * 24 * HOUR_MS,
  timeZone: 'UTC'
}

export type ResolvedConfig = ForemanConfig & typeof DEFAULTS


export const iso = (ms: number): string => new Date(ms).toISOString()

export function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

export class ForemanCtx {
  readonly cfg: ResolvedConfig
  readonly deps: ForemanDeps
  readonly cards: CardBook
  readonly jobs = new Map<string, Job>()
  readonly agents = new Map<string, AgentInfo>()
  readonly tasks = new Map<string, ForemanTask>()
  readonly rules: ForemanRule[] = []
  readonly spent = new Map<string, number>()
  /** Ended jobs that were forgotten: a redelivery of their offer is still a duplicate (S21), whatever the retention. */
  readonly tombs = new Map<string, Tombstone>()
  readonly box: Outbox
  /** Times the owner set from the console; they outlive a restart and beat the configured ones. */
  ownerTimes: { holdMs: number; releaseMs: number } | null = null
  hooks: ForemanHooks = {}
  published: CapabilityConfig[] = []
  draft: CapabilityConfig[] = []
  menuRevision = 0
  seq = 0
  ids = 0
  paused = false
  autoAccept: boolean
  lastContactAt: number | null = null
  lastBeatAt: number | null = null
  lastBeatSig = ''
  running = false

  constructor(cfg: ForemanConfig, deps: ForemanDeps) {
    this.cfg = {
      ...DEFAULTS,
      ...stripUndefined(cfg),
      visibility: cfg.visibility ?? 'summary'
    } as ResolvedConfig
    this.deps = deps
    this.autoAccept = cfg.autoAccept ?? true
    this.cards = new CardBook(deps.clock, deps.newId ?? (() => `crd_${++this.ids}`))
    this.box = new Outbox({
      now: () => this.now(),
      maxAgeMs: () => this.cfg.outboxMaxAgeMs,
      hooks: () => this.hooks,
      deliver: (e) => deliver(this.deps.transport, e)
    })
  }

  now(): number {
    return this.deps.clock.now()
  }

  need(taskId: string): Job {
    const job = this.jobs.get(taskId)
    if (!job) {
      throw new ForemanError('unknown_task', `no task ${taskId}`)
    }
    return job
  }

  /** Like need(), but refuses a job that was handed to the answering service and not adopted back. */
  needLocal(taskId: string): Job {
    const job = this.need(taskId)
    if (job.transferred) {
      throw new ForemanError('bad_state', 'this job is with the answering service')
    }
    return job
  }

  /** The owner's calendar day (YYYY-MM-DD) in the configured zone, for the daily budget. */
  dayKey(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.cfg.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(this.now())
  }

  /** A sign of life from an agent. */
  touch(agentId: string): void {
    const now = this.now()
    const a = this.agents.get(agentId)
    if (a) {
      a.lastSeenAt = now
    }
    this.lastContactAt = now
  }

  /** The capability the job named, as published (a draft never counts). */
  cap(job: Job): CapabilityConfig | undefined {
    return job.capability ? this.published.find((c) => c.id === job.capability) : undefined
  }

  anyOnline(): boolean {
    for (const a of this.agents.values()) {
      if (a.online && !a.away) {
        return true
      }
    }
    return false
  }

  history(
    job: Job,
    kind: HistoryKind,
    by: string,
    reason: string | null,
    agentId: string | null = null,
    toAgentId: string | null = null
  ): void {
    job.history.push({ at: this.now(), kind, by, reason, agentId, toAgentId })
  }

  /**
   * Validate an event against the contract and the task state machine, then move the job and queue
   * the event. Nothing is changed when the check fails. The send itself happens later from the outbox,
   * so a relay that is down never leaves the job half-moved.
   */
  emit(job: Job, event: LifecycleEventName, extra: Partial<LifecycleEvent>): void {
    const ev: LifecycleEvent = {
      yard: this.cfg.yard,
      task_id: job.taskId,
      event,
      at: iso(this.now()),
      ...extra
    }
    const err = checkContract('lifecycle', ev)
    if (err) {
      throw new ForemanError('bad_event', err)
    }
    const next = nextTaskState(job.state, event, ev.result)
    if (!next) {
      throw new ForemanError('bad_state', `${event} not allowed from ${job.state}`)
    }
    job.state = next
    this.queue({ kind: 'lifecycle', ev })
  }

  // ---- outbox (outbox.ts)

  queue(effect: Effect): void {
    this.box.queue(effect)
  }

  flush(): void {
    this.box.flush()
  }

  notifyOwner(notice: OwnerNotice): void {
    this.queue({ kind: 'owner', notice })
  }

  notifyRequester(notice: RequesterNotice): void {
    this.queue({ kind: 'requester', notice })
  }

  sendMenu(menu: Menu, revision: number, extended: ExtendedMenu): void {
    this.queue({ kind: 'menu', menu, revision, extended })
  }

  // ---- agent port (local; a terminal that is gone must not break the foreman)

  agentOffer(agentId: string, offer: AgentOffer): void {
    try {
      this.deps.agents.offer(agentId, offer)
    } catch (err) {
      // The offer times out on its own (claim_timeout) and goes to the next agent.
      this.hooks.onError?.(err, 'offer to agent')
    }
  }

  agentRevoke(agentId: string, revoke: AgentRevoke): void {
    try {
      this.deps.agents.revoke(agentId, revoke)
    } catch (err) {
      // The claim is already revoked here (epoch moved on): a late "done" from it is refused.
      this.hooks.onError?.(err, 'revoke to agent')
    }
  }

  // ---- claims

  liveClaim(job: Job): Claim | undefined {
    const c = job.claims.at(-1)
    return c && (c.state === 'offered' || c.state === 'active') ? c : undefined
  }

  activeClaim(job: Job, agentId: string, epoch: number): Claim {
    const claim = job.claims.find((c) => c.epoch === epoch && c.agentId === agentId)
    if (!claim || claim.state !== 'active' || epoch !== job.claimEpoch) {
      throw new ForemanError('claim_revoked', 'this claim was revoked or replaced')
    }
    return claim
  }

  /** Revoke first: the claim ends, the epoch moves on, and the agent is told to stop. */
  revokeClaim(job: Job, claim: Claim, reason: string): void {
    claim.state = 'revoked'
    claim.endedAt = this.now()
    claim.endReason = reason
    job.claimEpoch = Math.max(job.claimEpoch, claim.epoch) + 1
    job.tried.push(claim.agentId)
    // S10: a line belongs to the agent that asked for it; a new holder needs its own.
    const line = job.line
    if (
      line &&
      (line.state === 'open' || line.state === 'requested') &&
      line.fromInner === claim.agentId
    ) {
      line.state = 'closed'
      line.closeReason = 'claim_revoked'
    }
    this.agentRevoke(claim.agentId, { taskId: job.taskId, epoch: claim.epoch, reason })
  }

  revokeLive(job: Job, reason: string): void {
    const live = this.liveClaim(job)
    if (live) {
      this.revokeClaim(job, live, reason)
    }
  }

  /** The job is over (verified, cancelled, expired, released): drop claims, close the line, end cards. */
  finish(job: Job, reason: string): void {
    this.revokeLive(job, 'job_closed')
    job.exec = null
    job.closedReason = reason
    job.closedAt = this.now()
    if (job.line && (job.line.state === 'open' || job.line.state === 'requested')) {
      job.line.state = 'closed'
      job.line.closeReason = 'job_closed'
    }
    this.cards.endForJob(job.taskId)
    for (const t of this.tasks.values()) {
      if (t.ref === job.taskId) {
        t.done = true
      }
    }
  }

  // ---- task queue

  schedule(kind: FullTaskKind, ref: string, idem: string, runAfter: number): void {
    const key = `${kind}|${ref}|${idem}`
    const have = this.tasks.get(key)
    if (have && !have.done) {
      return
    }
    this.tasks.set(key, { key, kind, ref, idem, runAfter, seq: ++this.seq, done: false })
  }

  drop(kind: FullTaskKind, ref: string): void {
    for (const t of this.tasks.values()) {
      if (t.kind === kind && t.ref === ref) {
        t.done = true
      }
    }
  }

  /** Hold and release clocks (S18). The idem is the start time, so a restarted clock never meets a stale check. */
  scheduleTimers(job: Job): void {
    const at = job.waitingSince ?? job.acceptedAt ?? job.receivedAt
    this.schedule('hold_check', job.taskId, String(at), at + this.cfg.holdMs)
    this.schedule('release_check', job.taskId, String(at), at + this.cfg.releaseMs)
  }

  /** A job that was running is waiting again (lease lapsed, rerouted, sent back): the S18 clocks start over. */
  restartWait(job: Job): void {
    job.waitingSince = this.now()
    job.holdNotified = false
    this.scheduleTimers(job)
  }

  /** The job goes back to the Dispatcher to be routed again (S18 release, S20 decline). It is not cancelled. */
  handBack(job: Job, op: 'decline' | 'release', reason: string): void {
    const body = reason.slice(0, 500) || op
    const err = checkHandBack(op, body)
    if (err) {
      throw new ForemanError('bad_event', `hand back: ${err}`)
    }
    this.revokeLive(job, 'job_closed')
    job.state = 'reassigned'
    this.queue({ kind: 'handBack', back: { taskId: job.taskId, op, reason: body } })
    this.finish(job, reason)
  }

  /** Ask every waiting job to look for an agent, oldest first. */
  delegateAll(): void {
    const now = this.now()
    const queued = [...this.jobs.values()]
      .filter((j) => j.state === 'accepted' && j.exec === 'queued' && !j.needsHuman)
      .sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0) || a.seq - b.seq)
    for (const j of queued) {
      this.schedule('delegate', j.taskId, '', now)
    }
  }
}
