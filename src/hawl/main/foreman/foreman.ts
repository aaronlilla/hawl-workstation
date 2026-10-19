// The self-hosted foreman: a gateway-contract yard that runs on the owner's side.
//
// Pure core. Time comes from an injected clock, effects go out through an injected
// transport (to the Dispatcher) and agent port (to inner agents). Nothing here sets a
// timer: due work waits in a task queue and runs on tick(), which every call does first
// and last, so a lease that lapsed is always revoked before any later "done" is read.
//
// Contract mapping (m2-contract.md sections 1 and 4): S9 hop through the foreman, S10
// direct lines (lines.ts), S11 menu (menu.ts), S15 accept while agents are offline
// (intake.ts), S16/S17 claims and leases (claims.ts, timers.ts), S18 hold and release
// (timers.ts), S20 decline and reroute history (lifecycle.ts), S21 idempotency,
// S23-S25 work cards (cards.ts), S48 menu and heartbeat as a gateway yard (heartbeat.ts).
import type { Heartbeat, LifecycleEvent, Menu } from '../../shared/gateway-contract/contract'
import { agentAccept, agentDecline, agentDone, agentProgress, agentRenew } from './claims'
import type { DoneReport } from './claims'
import type { CardBook } from './cards'
import { buildBeat } from './heartbeat'
import { adoptQueue, exportQueue, intake, ownerDecision } from './intake'
import { addRule, decline, onLifecycle, reroute, resolveNeedsHuman } from './lifecycle'
import { decideLine, lineAllows, openLine, remoteLineDecision } from './lines'
import type { LineRequest } from './lines'
import { publishMenu, setCapabilities } from './menu'
import type { ExtendedMenu } from './menu'
import { ForemanCtx } from './state'
import { due, nextDueAt } from './timers'
import { busyAgentIds, claimsOf, jobView } from './views'
import type {
  AgentInfo,
  CapabilityConfig,
  Claim,
  ForemanConfig,
  ForemanDeps,
  ForemanRule,
  ForemanTask,
  IntakeInput,
  IntakeResult,
  Job,
  JobView,
  QueueEntry
} from './types'

export type ForemanSnapshot = {
  jobs: Job[]
  tasks: ForemanTask[]
  rules: ForemanRule[]
  menuRevision: number
  published: CapabilityConfig[]
  draft: CapabilityConfig[]
  spent: [string, number][]
  seq: number
  ids: number
  lastContactAt: number | null
  paused: boolean
  autoAccept: boolean
  cards: ReturnType<CardBook['snapshot']>
}

export class Foreman {
  readonly #c: ForemanCtx

  constructor(cfg: ForemanConfig, deps: ForemanDeps) {
    this.#c = new ForemanCtx(cfg, deps)
  }

  /** Work cards (S23-S25) for this yard's agents. */
  get cards(): CardBook {
    return this.#c.cards
  }

  /** Catch up on due work, run the call, catch up again. A call that throws skips the second. */
  #do<T>(fn: (c: ForemanCtx) => T): T {
    due(this.#c)
    const result = fn(this.#c)
    due(this.#c)
    return result
  }

  // ---- menu (S11, S12, S48)

  setCapabilities(caps: CapabilityConfig[]): void {
    setCapabilities(this.#c, caps)
  }

  publishMenu(): { menu: Menu; extended: ExtendedMenu; revision: number } {
    return publishMenu(this.#c)
  }

  get menuRevision(): number {
    return this.#c.menuRevision
  }

  // ---- switches

  /** Paused: new jobs are declined, nothing is offered, running claims keep their leases. */
  pause(): void {
    this.#c.paused = true
  }

  resume(): void {
    this.#do((c) => {
      c.paused = false
      c.delegateAll()
    })
  }

  get paused(): boolean {
    return this.#c.paused
  }

  /** false makes every job wait for the owner. */
  setAutoAccept(on: boolean): void {
    this.#c.autoAccept = on
  }

  /** Cost reported by agents; the daily budget in the menu policy holds new jobs once reached. */
  recordCost(usd: number): void {
    const day = this.#c.dayKey()
    const total = (this.#c.spent.get(day) ?? 0) + usd
    // Only today's spend matters to the budget; older days are dropped.
    this.#c.spent.clear()
    this.#c.spent.set(day, total)
  }

  // ---- agents

  agentUp(id: string, opts: { label?: string; capacity?: number } = {}): void {
    this.#do((c) => {
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
      c.delegateAll()
    })
  }

  /** The claim is not touched: its lease lapses on its own and is then revoked (S17). */
  agentDown(id: string): void {
    this.#do((c) => {
      const a = c.agents.get(id)
      if (a) {
        a.online = false
        a.lastSeenAt = c.now()
        c.lastContactAt = a.lastSeenAt
      }
    })
  }

  agentAway(id: string, away: boolean): void {
    this.#do((c) => {
      const a = c.agents.get(id)
      if (a) {
        a.away = away
        if (!away) {
          c.delegateAll()
        }
      }
    })
  }

  agentSeen(id: string): void {
    this.#do((c) => c.touch(id))
  }

  agents(): AgentInfo[] {
    return [...this.#c.agents.values()].map((a) => ({ ...a }))
  }

  // ---- intake (S9, S15, S21)

  intake(input: IntakeInput): IntakeResult {
    return this.#do((c) => intake(c, input))
  }

  ownerDecision(taskId: string, decision: 'accept' | 'decline', by: string, reason?: string): void {
    this.#do((c) => ownerDecision(c, taskId, decision, by, reason))
  }

  // ---- claims (S16, S17)

  agentAccept(taskId: string, agentId: string, epoch: number): { duplicate: boolean } {
    return this.#do((c) => agentAccept(c, taskId, agentId, epoch))
  }

  agentDecline(taskId: string, agentId: string, epoch: number, reason?: string): void {
    this.#do((c) => agentDecline(c, taskId, agentId, epoch, reason))
  }

  agentRenew(taskId: string, agentId: string, epoch: number): void {
    this.#do((c) => agentRenew(c, taskId, agentId, epoch))
  }

  agentProgress(taskId: string, agentId: string, epoch: number, note?: string): void {
    this.#do((c) => agentProgress(c, taskId, agentId, epoch, note))
  }

  agentDone(
    taskId: string,
    agentId: string,
    epoch: number,
    report: DoneReport
  ): { duplicate: boolean } {
    return this.#do((c) => agentDone(c, taskId, agentId, epoch, report))
  }

  // ---- from the Dispatcher, and decline / reroute (S20)

  onLifecycle(ev: LifecycleEvent): void {
    this.#do((c) => onLifecycle(c, ev))
  }

  decline(taskId: string, by: string, reason: string): void {
    this.#do((c) => decline(c, taskId, by, reason))
  }

  reroute(
    taskId: string,
    opts: { toAgent: string; by: string; reason?: string; makeRule?: boolean }
  ): void {
    this.#do((c) => reroute(c, taskId, opts))
  }

  /** A person looked at a job that stopped (3 reroutes or 3 send-backs) and wants it tried again. */
  resolveNeedsHuman(taskId: string, by: string, reason?: string): void {
    this.#do((c) => resolveNeedsHuman(c, taskId, by, reason))
  }

  addRule(
    match: ForemanRule['match'],
    action: ForemanRule['action'],
    source: ForemanRule['source'] = 'owner'
  ): string {
    return addRule(this.#c, match, action, source)
  }

  rules(): ForemanRule[] {
    return this.#c.rules.map((r) => ({ ...r, match: { ...r.match }, action: { ...r.action } }))
  }

  // ---- direct lines (S10)

  openLine(taskId: string, req: LineRequest): void {
    this.#do((c) => openLine(c, taskId, req))
  }

  decideLine(taskId: string, approve: boolean, reason?: string): void {
    this.#do((c) => decideLine(c, taskId, approve, reason))
  }

  remoteLineDecision(taskId: string, approve: boolean): void {
    this.#do((c) => remoteLineDecision(c, taskId, approve))
  }

  lineAllows(taskId: string, fromInner: string, toVillage: string): boolean {
    return this.#do((c) => lineAllows(c, taskId, fromInner, toVillage))
  }

  // ---- offline queue handover (S15, S18, S21)

  exportQueue(): QueueEntry[] {
    return this.#do((c) => exportQueue(c))
  }

  adoptQueue(entries: QueueEntry[]): { adopted: string[]; skipped: string[] } {
    return this.#do((c) => adoptQueue(c, entries))
  }

  // ---- views

  jobView(taskId: string): JobView {
    return jobView(this.#c, taskId)
  }

  claimsOf(taskId: string): Claim[] {
    return claimsOf(this.#c, taskId)
  }

  jobIds(): string[] {
    return [...this.#c.jobs.values()].sort((a, b) => a.seq - b.seq).map((j) => j.taskId)
  }

  busyAgentIds(): string[] {
    return busyAgentIds(this.#c)
  }

  /** Gateway-contract heartbeat for this yard (S48). */
  heartbeat(): Heartbeat {
    return this.#do((c) => buildBeat(c))
  }

  /** The time something is next due (a task, or the next heartbeat), for an adapter to sleep until. */
  nextDueAt(): number {
    return nextDueAt(this.#c)
  }

  /** Run everything that is due and send a heartbeat if one is due. */
  tick(): void {
    due(this.#c)
  }

  // ---- persistence

  snapshot(): ForemanSnapshot {
    const c = this.#c
    return structuredClone({
      jobs: [...c.jobs.values()],
      tasks: [...c.tasks.values()].filter((t) => !t.done),
      rules: c.rules,
      menuRevision: c.menuRevision,
      published: c.published,
      draft: c.draft,
      spent: [...c.spent],
      seq: c.seq,
      ids: c.ids,
      lastContactAt: c.lastContactAt,
      paused: c.paused,
      autoAccept: c.autoAccept,
      cards: c.cards.snapshot()
    })
  }

  restore(s: ForemanSnapshot): void {
    const c = this.#c
    const snap = structuredClone(s)
    c.jobs.clear()
    c.tasks.clear()
    c.rules.length = 0
    c.spent.clear()
    for (const j of snap.jobs) {
      c.jobs.set(j.taskId, j)
    }
    for (const t of snap.tasks) {
      c.tasks.set(t.key, t)
    }
    c.rules.push(...snap.rules)
    c.menuRevision = snap.menuRevision
    c.published = snap.published
    c.draft = snap.draft
    for (const [k, v] of snap.spent) {
      c.spent.set(k, v)
    }
    c.seq = snap.seq
    c.ids = snap.ids
    c.lastContactAt = snap.lastContactAt
    c.paused = snap.paused
    c.autoAccept = snap.autoAccept
    c.cards.restore(snap.cards)
  }
}
