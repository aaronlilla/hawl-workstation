// Shapes the relay returns and accepts, as the client sees them.
export type HandoffState = string
export type HandoffOp = 'accept' | 'decline' | 'done' | 'verify' | 'reject' | 'cancel' | 'reassign'

export type HandoffEvidence = {
  pr_url?: string
  sha?: string
  files?: string[]
  ci_url?: string
  note?: string
  criteria?: { id: string; result: 'pass' | 'fail' | 'n/a'; reason?: string }[]
}

export type HandoffCreate = {
  to?: string
  task_type: string
  title: string
  spec: string
  criteria: { id: string; text: string; check: 'manual' | 'ci' | 'file' }[]
  verifier?: string
  deadline?: string
  quality_bar?: string
  links?: { kind: 'github_pr' | 'github_issue' | 'url'; url: string }[]
  files?: string[]
}

export type Me = {
  resident_id: string
  town_id: string
  town_slug: string
  handle: string
  display_name: string
  platform: string
  status: string
  limits: { send_per_min: number; max_body_bytes: number }
  unread: number
  needs_action: number
}

export type WorkerRow = {
  resident_id: string
  handle: string
  display_name: string
  platform: string
  profile: Record<string, unknown>
  online: boolean
  can_message: boolean
}

export type Channel = {
  channel_id: string
  kind: 'room' | 'square'
  name: string
  topic: string | null
  member?: boolean
  wake_on?: unknown
}

export type FileMeta = {
  file_id: string
  name: string
  mime: string
  bytes: number
  sha256: string
  state: string
  scan: unknown
  release_state: string
}

// ---- user plane and handoffs. Field names are what the relay returned on the local stack
// (2026-10-19) and what its route code builds; `[k: string]: unknown` keeps room for new fields. ----

export type PartyRef = { handle: string; resident_id: string }

export type ApprovalCard = {
  to: PartyRef
  from: PartyRef
  intent: string
  body_bytes: number
  message_id: string
  scan_verdict: string
  requested_capabilities: string[]
  [k: string]: unknown
}

export type ApprovalItem = {
  approval_id: string
  state: 'pending' | 'approved' | 'denied' | 'expired'
  approver_scope: string
  card: ApprovalCard
  reason: { rules: string[]; [k: string]: unknown }
  expires_at: string
  decided_by: string | null
  decided_at: string | null
  [k: string]: unknown
}

export type NeedsItem = {
  kind: 'approval' | 'flagged_message' | (string & {})
  at: string
  item_id: string
  lane: string
  approval_id?: string
  message_id?: string
  held?: Record<string, unknown>
  [k: string]: unknown
}

export type NeedsList = {
  tab: 'needs' | 'later' | 'done'
  items: NeedsItem[]
  counts: Record<string, number>
  later_count: number
  done_count: number
}

export type BoardPin = {
  pin_id: string
  message_id: string
  title: string
  pinned_by: string
  created_at: string
  readable: boolean
  preview?: string
  files: Record<string, unknown>[]
}

export type HandoffRow = {
  handoff_id: string
  state: string
  title: string
  task_type: string
  quality_bar: string
  number: number
  sender: string
  assignee: string | null
  verifier: string | null
  deadline: string | null
  updated_at: string
}

export type HandoffEventRow = {
  op: string
  actor: string | null
  from_state: string | null
  to_state: string
  evidence: unknown
  at: string
}

export type Handoff = Omit<HandoffRow, 'updated_at'> & {
  verifier_rule: string | null
  lease_expires_at: string | null
  last_activity_at: string | null
  criteria: unknown
  links: unknown
  revision: { sha: string; repo: string | null; pr: number | null } | null
  evidence: unknown
  self_verified: boolean | null
  current_receipt_id: string | null
  events: HandoffEventRow[]
}

export type WorkerOverview = {
  resident_id: string
  handle: string
  display_name: string
  platform: string
  owner: string
  owner_id: string
  status: string
  presence: string
  working_on: string | null
  label: string | null
  specialties: string[]
  knows: string | null
  paused: boolean
  private: boolean
  last_seen_at: string | null
  trusted_senders: string[]
  machine?: unknown
  machine_name?: string | null
  [k: string]: unknown
}

export type SwitchesState = {
  admins_approve_agents: boolean
  wake_enabled: boolean
  review_new_agents: boolean
  frozen: boolean
  [k: string]: unknown
}

export type SiteSummary = {
  town_id: string
  slug: string
  name: string
  role: string
  do_now: number
}

export type Meter = {
  estimate: boolean
  week: { start: string; end: string }
  metrics: {
    kind: string
    label: string
    direction: 'saved' | 'spent'
    count: number
    minutes: number
  }[]
  saved_minutes: number
  spent_minutes: number
  net_minutes: number
  assumptions: string[]
}

/** A row of `GET /v1/towns/:twn/events`. Console socket frames add `stream`. */
export type EventRow = {
  seq: number
  town_id: string
  at: string
  event: string
  [k: string]: unknown
}

/** One row of the `who` tool. Handles carry a leading "@" here, unlike the directory list. */
export type WhoWorker = {
  handle: string
  resident_id: string
  owner_display: string
  platform: string
  status: string
  status_age_s: number
  working_on: string | null
  yard: string | null
  can_message: boolean
  specialties: string[]
  knows: string | null
  [k: string]: unknown
}
