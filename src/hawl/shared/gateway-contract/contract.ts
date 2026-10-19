// Gateway-contract types and checks for the Hawl foreman. Schemas are vendored from
// hawl-platform packages/gateway-contract (see ./schemas). Imported as JSON so the
// bundled main process needs no file reads.
import { checkSchema, type Schema } from './schema-check'
import menuSchema from './schemas/menu.schema.json'
import heartbeatSchema from './schemas/heartbeat.schema.json'
import lifecycleSchema from './schemas/lifecycle.schema.json'

export type Visibility = 'private' | 'summary' | 'full'

export type Capability = {
  id: string
  description: string
  inputs?: string[]
  outputs?: string[]
  quality_bar?: string[]
  typical_minutes?: number
  accepts_files?: string[]
}

export type Menu = {
  yard: string
  owner: string
  display_name: string
  visibility: Visibility
  capabilities: Capability[]
  routing_policy?: {
    accept_from?: string[]
    auto_accept?: boolean
    daily_budget_usd?: number
  }
}

export type Heartbeat = {
  yard: string
  state: 'online' | 'busy' | 'degraded' | 'paused' | 'offline'
  load: { active_tasks: number; queued: number }
  workers: { busy: number; idle: number }
  needs_human: number
  as_of: string
  agents?: { id: string; status: 'busy' | 'idle' | 'blocked' | 'needs_human' }[]
}

export type LifecycleEventName =
  | 'offer'
  | 'accept'
  | 'decline'
  | 'progress'
  | 'done'
  | 'verify'
  | 'cancel'
  | 'expire'
  | 'reassign'
  | 'direct_line_open'
  | 'direct_line_approve'
  | 'direct_line_reject'

export type LifecycleEvent = {
  yard: string
  task_id: string
  event: LifecycleEventName
  at: string
  capability?: string
  acceptance?: string[]
  quality_bar?: string
  deadline?: string
  note?: string
  reason?: string
  to?: string
  revision_sha?: string
  evidence?: { kind: 'sha' | 'ci' | 'pr' | 'artifact'; ref: string }[]
  result?: 'pass' | 'reject'
  from_inner?: string
  to_village?: string
  purpose?: string
  ttl_minutes?: number
}

/** Task states as the gateway contract sees them (reference-gateway.ts). */
export type TaskState =
  | 'asked'
  | 'accepted'
  | 'declined'
  | 'done'
  | 'verified'
  | 'cancelled'
  | 'expired'
  | 'reassigned'

export type ContractKind = 'menu' | 'heartbeat' | 'lifecycle'

const SCHEMAS: Record<ContractKind, Schema> = {
  menu: menuSchema as Schema,
  heartbeat: heartbeatSchema as Schema,
  lifecycle: lifecycleSchema as Schema
}

/** Returns null when the value matches the schema, else a one-line error. */
export function checkContract(kind: ContractKind, value: unknown): string | null {
  const errs = checkSchema(SCHEMAS[kind], value)
  return errs.length === 0 ? null : errs.join('; ')
}

/**
 * Legal moves per current state, copied from the reference gateway so the foreman
 * can never emit an event the contract forbids. A rejected verify returns to accepted.
 */
const MOVES: Record<TaskState | 'none', Partial<Record<string, TaskState>>> = {
  none: { offer: 'asked' },
  asked: {
    accept: 'accepted',
    decline: 'declined',
    cancel: 'cancelled',
    expire: 'expired',
    reassign: 'reassigned'
  },
  accepted: { progress: 'accepted', done: 'done', cancel: 'cancelled', expire: 'expired' },
  done: { verify: 'verified', cancel: 'cancelled', expire: 'expired' },
  reassigned: { offer: 'asked' },
  declined: {},
  verified: {},
  cancelled: {},
  expired: {}
}

/** Next task state for an event, or undefined when the contract forbids the move. */
export function nextTaskState(
  cur: TaskState | undefined,
  event: LifecycleEventName,
  result?: 'pass' | 'reject'
): TaskState | undefined {
  if (event.startsWith('direct_line_')) {
    return cur
  }
  if (event === 'verify' && result === 'reject') {
    return cur === 'done' ? 'accepted' : undefined
  }
  return MOVES[cur ?? 'none'][event]
}
