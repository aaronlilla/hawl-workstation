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
