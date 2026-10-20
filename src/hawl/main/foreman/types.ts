// Types for the self-hosted foreman. The core is pure: time, ids and every outside
// effect come in through the interfaces below.
import type { ExtendedMenu } from './menu'
import type {
  Capability,
  Heartbeat,
  LifecycleEvent,
  Menu,
  TaskState,
  Visibility
} from '../../shared/gateway-contract/contract'

export type Clock = { now(): number }

export type ForemanErrorCode =
  | 'bad_offer'
  | 'bad_menu'
  | 'bad_event'
  | 'wrong_yard'
  | 'unknown_task'
  | 'bad_state'
  | 'claim_revoked'
  | 'claim_taken'
  | 'unknown_card'
  | 'bad_card'
  | 'bad_line'
  | 'bad_rule'
  | 'bad_snapshot'
  | 'bad_setting'
  | 'untrusted_sender'

export class ForemanError extends Error {
  readonly code: ForemanErrorCode
  constructor(code: ForemanErrorCode, message: string) {
    super(message)
    this.name = 'ForemanError'
    this.code = code
  }
}

/**
 * Where the foreman speaks to the Dispatcher (relay).
 *
 * Every method may return a promise. Everything except the heartbeat goes through the outbox
 * (outbox.ts): a call that throws or rejects is tried again with a growing wait, in order, and
 * the effect is already in the saved snapshot before the first try. So a method may be called
 * more than once for the same effect (at-least-once): the receiving side treats a repeat as a
 * no-op (S21). A thrown error with `permanent: true` drops the effect instead of retrying.
 */
export type ForemanTransport = {
  /** `menu` is the strict gateway-contract menu; `extended` adds the m2 policy fields for the ledger. */
  sendMenu(menu: Menu, revision: number, extended: ExtendedMenu): void | Promise<void>
  /** Heartbeats are not queued: a stale one is useless. A failed one is simply sent again soon. */
  sendHeartbeat(hb: Heartbeat): void | Promise<void>
  sendLifecycle(ev: LifecycleEvent): void | Promise<void>
  /** Structured only: a kind and a reference, never free text. */
  notifyOwner(notice: OwnerNotice): void | Promise<void>
  /** Structured only: tells the requester a job stopped on their side (S35). */
  notifyRequester(notice: RequesterNotice): void | Promise<void>
  /**
   * A job leaves this yard and goes back to the Dispatcher to be routed again (S18, S20).
   * Not a gateway lifecycle event: the gateway state machine has no accepted -> reassigned move,
   * so this is the m2 route `POST /v1/handoffs/:id/foreman {op, reason?}` (m2-contract.md 3.4,
   * ops decline and release) and the job is not cancelled. The body is checked against
   * HAND_BACK_SCHEMA (m2-schemas.ts). The relay handler is another piece and is NOT exercised here.
   */
  handBack(back: HandBack): void | Promise<void>
}

export type HandBack = { taskId: string; op: 'decline' | 'release'; reason: string }
export type RequesterNotice = { kind: 'send_back_limit'; taskId: string; requester: string }

export type OwnerNoticeKind =
  | 'job_held_offline' // S18: nobody came online within the hold time
  | 'job_needs_approval' // ask-owner capability, paused auto-accept or budget reached
  | 'job_unclaimed' // three agents tried, none took it
  | 'job_released' // S18: release time passed, job went back to the Dispatcher
  | 'line_request' // S10: a direct line waits for the owner
  | 'needs_human' // reroute or send-back limit reached

export type OwnerNotice = { kind: OwnerNoticeKind; taskId: string }

/** Where the foreman speaks to inner agents (Orca terminals). */
export type AgentPort = {
  offer(agentId: string, offer: AgentOffer): void
  /** The claim is revoked: the agent must stop. */
  revoke(agentId: string, revoke: AgentRevoke): void
}

export type AgentOffer = {
  taskId: string
  epoch: number
  /** S19: why this agent got the job (rule, pin, requester preference or least loaded). */
  why: string
  capability: string | null
  acceptance: string[]
  deadline: string | null
  offerExpiresAt: number
}

export type AgentRevoke = { taskId: string; epoch: number; reason: string }

/**
 * An effect that must reach the Dispatcher or the owner. It is recorded in the state change that
 * caused it and delivered afterwards, so the state is the same whether delivery works or not.
 */
export type Effect =
  | { kind: 'menu'; menu: Menu; revision: number; extended: ExtendedMenu }
  | { kind: 'lifecycle'; ev: LifecycleEvent }
  | { kind: 'owner'; notice: OwnerNotice }
  | { kind: 'requester'; notice: RequesterNotice }
  | { kind: 'handBack'; back: HandBack }

export type OutboxItem = {
  id: number
  effect: Effect
  /** When it was queued (ms). */
  at: number
  attempts: number
  /** Earliest time of the next try (ms). */
  retryAt: number
  lastError: string | null
}

/** An effect that was dropped: a permanent refusal, or too old to matter. Kept for the owner to see. */
export type DeadEffect = { at: number; kind: Effect['kind']; ref: string; reason: string }

/** Wired by the runtime (or a test): saving, errors and "something changed, re-plan". */
export type ForemanHooks = {
  /** Save the snapshot now. Called before the first try of any queued effect (write-ahead). May throw. */
  persist?: () => void
  /** Something went wrong that the foreman handled (a failed delivery, a refused local call). */
  onError?: (err: unknown, where: string) => void
  /** An async delivery finished: the runtime saves and re-plans its sleep. */
  onChange?: () => void
}

export type ForemanDeps = {
  clock: Clock
  transport: ForemanTransport
  agents: AgentPort
  /** Ids for cards. Default is a counter. */
  newId?: () => string
}

export type DirectLinePolicy = 'job_parties' | 'ask_owner' | 'never'

export const HOUR_MS = 60 * 60 * 1000
export const MINUTE_MS = 60 * 1000

export type ForemanConfig = {
  /** Yard slug, as in the menu. */
  yard: string
  owner: string
  displayName: string
  visibility?: Visibility
  /** S18 defaults: 4 h and 24 h. */
  holdMs?: number
  releaseMs?: number
  /** Claim lease, renewed by activity. Default 30 min (handoffs/leases.ts:7). */
  leaseMs?: number
  /** How long an agent has to answer an offer. Default 10 min. */
  offerMs?: number
  /** Agents tried per job before the owner is told. Default 3. */
  maxAgentsPerJob?: number
  /**
   * An agent that went down (not away) keeps its running claim this long, then the lease is
   * treated as lapsed so the job can move on. Coming back in time restores the full lease. Default 2 min.
   */
  downGraceMs?: number
  /** An effect that could not be delivered for this long is dropped and listed as dead. Default 24 h. */
  outboxMaxAgeMs?: number
  /** Reroutes before a job goes to a person (S20). Default 3. */
  maxReroutes?: number
  /** Send-backs before a job goes to the requester (S35). Default 3. */
  maxSendBacks?: number
  heartbeatMs?: number
  /** Who may send us work: yard slugs, or "site". Empty or missing means anyone. */
  acceptFrom?: string[]
  /**
   * What happens to an offer that names no capability (the contract makes it optional).
   * Default "ask_owner": the owner sees the acceptance lines and decides. "auto" accepts it.
   */
  freeformApproval?: 'auto' | 'ask_owner'
  /** Global switch: false makes every job ask the owner. Default true. */
  autoAccept?: boolean
  dailyBudgetUsd?: number
  directLines?: DirectLinePolicy
  /** IANA zone the daily budget resets in (the owner's day). Default UTC. */
  timeZone?: string
  /** How long a finished job is kept for duplicate detection and history. Default 30 days. */
  retentionMs?: number
}

/** A capability plus the foreman-only policy that the gateway menu cannot carry. */
export type CapabilityConfig = Capability & {
  /** "auto" accepts at once; "ask_owner" holds the job for the owner. Default auto. */
  approval?: 'auto' | 'ask_owner'
  /** false hides the capability from the published menu. Default true. */
  open?: boolean
  /** Per-capability sender allow list; overrides the menu-wide one. */
  acceptFrom?: string[]
  /** false declines when no agent is online. Default true. */
  acceptWhenOffline?: boolean
  /** If set, only these agents may take this capability. */
  agents?: string[]
  /** Shown in the ledger and used by the Dispatcher to match free text. */
  keywords?: string[]
  /** Station ids (vil_...) that take this capability. */
  stations?: string[]
  /** Capability ids that usually follow this one. */
  next?: string[]
}

export type AgentInfo = {
  id: string
  label: string
  online: boolean
  away: boolean
  /** Jobs it may run at once. Default 1. */
  capacity: number
  lastSeenAt: number | null
}

export type ExecState = 'queued' | 'offered' | 'running' | 'held'

export type ClaimState = 'offered' | 'active' | 'released' | 'revoked' | 'finished'

export type Claim = {
  agentId: string
  epoch: number
  state: ClaimState
  offerExpiresAt: number | null
  leaseExpiresAt: number | null
  endedAt: number | null
  endReason: string | null
  /** Set while the agent is down: the lease it had before it was cut short to the down grace. */
  graceFrom?: number | null
}

export type HistoryKind =
  | 'decline'
  | 'reroute'
  | 'revoke'
  | 'timeout'
  | 'release'
  | 'send_back'
  | 'approve'
  | 'resume'
  | 'reoffer'

export type HistoryEntry = {
  at: number
  kind: HistoryKind
  by: string
  reason: string | null
  agentId: string | null
  toAgentId: string | null
}

/** S19: one routing decision to an inner agent, with the agents that were passed over. */
export type RouteDecision = {
  at: number
  epoch: number
  agentId: string
  /** "rule rule_3", "pinned (sent back to the agent that did it)", "requester preference", "least loaded". */
  via: string
  skipped: { agentId: string; why: string }[]
}

export type LineState = 'requested' | 'open' | 'rejected' | 'closed'

export type DirectLine = {
  state: LineState
  fromInner: string
  toVillage: string
  purpose: string
  ttlMs: number
  localOk: boolean | null
  remoteOk: boolean | null
  expiresAt: number | null
  closeReason: string | null
}

export type Job = {
  taskId: string
  capability: string | null
  acceptance: string[]
  qualityBar: string | null
  deadline: string | null
  requester: string
  /** The requester's wish. A preference, not an order. */
  preferAgent: string | null
  /** An explicit pick for this job: the agent that did the work (send-back) or the owner's reroute target. Beats rules. */
  pinAgent: string | null
  /** When the Dispatcher sent the current offer (ms). A later offer on a handed-back job is a new offer, not a duplicate. */
  offerAt: number
  /** The job was exported to the answering service; this foreman runs no timers on it until it is adopted back. */
  transferred: boolean
  state: TaskState
  exec: ExecState | null
  receivedAt: number
  acceptedAt: number | null
  eta: number | null
  claimEpoch: number
  claims: Claim[]
  tried: string[]
  history: HistoryEntry[]
  routing: RouteDecision[]
  reroutes: number
  sendBacks: number
  needsHuman: boolean
  holdNotified: boolean
  exhaustedNotified: boolean
  line: DirectLine | null
  closedReason: string | null
  closedAt: number | null
  /** When the S18 hold and release clocks started: accept time, or the last time it stopped running. */
  waitingSince: number | null
  seq: number
}

export type IntakeInput = {
  /** The lifecycle "offer" event from the Dispatcher. */
  offer: LifecycleEvent
  /** Slug of the requesting yard, or "site" for a person on the site. */
  requester: string
  /** Handle of the agent the requester would like (a preference, not an order). */
  preferAgent?: string
}

export type IntakeOutcome = 'accepted' | 'held' | 'declined' | 'duplicate'

export type IntakeResult = {
  outcome: IntakeOutcome
  reason: string | null
  view: JobView
}

export type JobView = {
  taskId: string
  capability: string | null
  requester: string
  state: TaskState
  exec: ExecState | null
  /** 'foreman' or the agent id holding the job. */
  holder: string
  claim: { agentId: string; epoch: number; state: ClaimState; leaseExpiresAt: number | null } | null
  eta: number | null
  /** S15: "queued, not running (last contact ...)" while no agent holds the job. */
  statusText: string
  queuedNotRunning: boolean
  lastContactAt: number | null
  needsHuman: boolean
  history: HistoryEntry[]
  routing: RouteDecision[]
  line: DirectLine | null
}

/** A job the offline answering service accepted and queued, handed over on reconnect. */
export type QueueEntry = {
  offer: LifecycleEvent
  requester: string
  /** When the answering service accepted it; hold and release times count from here. */
  acceptedAt: number
  preferAgent?: string
  /** True when the service already told the owner (S18), so we do not repeat it. */
  ownerNotified?: boolean
  /** The job is not accepted yet: it waits for the owner's answer (ask-owner capability). */
  held?: boolean
  /** When the job first arrived, for a held job's expiry. */
  receivedAt?: number
}

/** Compact record of a job that ended and was forgotten, so a late redelivery still reads as a duplicate (S21). */
export type Tombstone = { taskId: string; state: TaskState; closedAt: number; offerAt: number }

export type ForemanRule = {
  id: string
  match: { capability?: string; fromYard?: string }
  action: { agentId: string }
  source: 'owner' | 'correction'
}

export type FullTaskKind =
  | 'delegate'
  | 'claim_timeout'
  | 'lease_check'
  | 'hold_check'
  | 'release_check'
  | 'held_expire'
  | 'line_expire'

export type ForemanTask = {
  key: string
  kind: FullTaskKind
  ref: string
  idem: string
  runAfter: number
  seq: number
  done: boolean
}
