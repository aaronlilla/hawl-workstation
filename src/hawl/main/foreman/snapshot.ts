// The saved form of a foreman, and the one place that reads it back.
//
// parseSnapshot checks the whole file and returns a clean copy; it never touches a foreman. Foreman.restore
// calls it first and only then swaps state in, so a damaged file leaves the foreman exactly as it was (empty,
// at start-up) instead of half loaded. Old files (no version) are upgraded here, in one function, not with
// scattered defaults.
import type { CardBook } from './cards'
import { ForemanError } from './types'
import type {
  AgentInfo,
  CapabilityConfig,
  DeadEffect,
  ForemanRule,
  ForemanTask,
  Job,
  OutboxItem,
  Tombstone
} from './types'

/** Bump when the shape changes, and add the step to upgrade() below. */
export const SNAPSHOT_VERSION = 2

export type SnapshotSettings = { holdMs: number; releaseMs: number }

export type ForemanSnapshot = {
  version: number
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
  /** Known inner agents. They restore as offline: a restarted app must hear from each terminal again. */
  agents: AgentInfo[]
  tombs: Tombstone[]
  lastBeatAt: number | null
  lastBeatSig: string
  /** Effects not yet delivered (S21: a restart sends them again, the other side ignores repeats). */
  outbox: OutboxItem[]
  outSeq: number
  dead: DeadEffect[]
  /** Times the owner changed from the console. Absent: the configured ones stand. */
  settings: SnapshotSettings | null
  /** When this snapshot was taken (ms). A long gap before the next start means the app was closed or asleep. */
  savedAt: number
}

const bad = (m: string): ForemanError => new ForemanError('bad_snapshot', m)

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function list(o: Obj, key: string, optional = false): unknown[] {
  const v = o[key]
  if (v === undefined && optional) {
    return []
  }
  if (!Array.isArray(v)) {
    throw bad(`"${key}" is missing or not a list`)
  }
  return v
}

function num(o: Obj, key: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw bad(`"${key}" is missing or not a number`)
  }
  return v
}

function numOrNull(o: Obj, key: string): number | null {
  const v = o[key]
  if (v === undefined || v === null) {
    return null
  }
  return num(o, key)
}

function flag(o: Obj, key: string): boolean {
  const v = o[key]
  if (typeof v !== 'boolean') {
    throw bad(`"${key}" is missing or not true/false`)
  }
  return v
}

const STATES = new Set([
  'asked',
  'accepted',
  'declined',
  'done',
  'verified',
  'cancelled',
  'expired',
  'reassigned'
])

function checkJob(j: unknown, i: number): Job {
  if (!isObj(j)) {
    throw bad(`job ${i} is not an object`)
  }
  if (typeof j.taskId !== 'string' || j.taskId === '') {
    throw bad(`job ${i} has no taskId`)
  }
  if (typeof j.state !== 'string' || !STATES.has(j.state)) {
    throw bad(`job ${j.taskId} has an unknown state`)
  }
  for (const k of ['claims', 'tried', 'history', 'acceptance']) {
    if (!Array.isArray(j[k])) {
      throw bad(`job ${j.taskId}: "${k}" is missing or not a list`)
    }
  }
  for (const k of ['receivedAt', 'seq', 'claimEpoch', 'reroutes', 'sendBacks']) {
    num(j, k)
  }
  return j as unknown as Job
}

/** Bring a saved file from any older version to the current shape. Throws on a newer or unreadable one. */
function upgrade(raw: Obj): Obj {
  const v = raw.version
  if (v !== undefined && typeof v !== 'number') {
    throw bad('"version" is not a number')
  }
  if ((v ?? 1) > SNAPSHOT_VERSION) {
    throw bad(`this file is from a newer foreman (version ${String(v)}); this one reads up to ${SNAPSHOT_VERSION}`)
  }
  const o: Obj = { ...raw }
  if ((v ?? 1) < 2) {
    // v1 -> v2: jobs gained pinAgent, routing, offerAt, transferred; the snapshot gained agents, tombs, beat,
    // the outbox, settings and savedAt. Their absence is the only difference, so the defaults are the upgrade.
    o.jobs = list(o, 'jobs').map((j) => {
      if (!isObj(j)) {
        return j
      }
      return {
        ...j,
        pinAgent: j.pinAgent ?? null,
        routing: j.routing ?? [],
        offerAt: j.offerAt ?? j.receivedAt,
        transferred: j.transferred ?? false
      }
    })
    o.agents ??= []
    o.tombs ??= []
    o.lastBeatAt ??= null
    o.lastBeatSig ??= ''
    o.outbox ??= []
    o.outSeq ??= 0
    o.dead ??= []
    o.settings ??= null
    o.savedAt ??= 0
  }
  o.version = SNAPSHOT_VERSION
  return o
}

/** Check and upgrade a saved snapshot. Throws a ForemanError('bad_snapshot') and changes nothing else. */
export function parseSnapshot(raw: unknown, checkCards: (cards: ForemanSnapshot['cards']) => void): ForemanSnapshot {
  if (!isObj(raw)) {
    throw bad('the file is not an object')
  }
  const o = upgrade(raw)
  const jobs = list(o, 'jobs').map(checkJob)
  const ids = new Set<string>()
  for (const j of jobs) {
    if (ids.has(j.taskId)) {
      throw bad(`job ${j.taskId} appears twice`)
    }
    ids.add(j.taskId)
  }
  const tasks = list(o, 'tasks').map((t, i) => {
    if (!isObj(t) || typeof t.key !== 'string' || typeof t.kind !== 'string') {
      throw bad(`task ${i} is damaged`)
    }
    num(t, 'runAfter')
    num(t, 'seq')
    return t as unknown as ForemanTask
  })
  const rules = list(o, 'rules').map((r, i) => {
    if (!isObj(r) || typeof r.id !== 'string' || !isObj(r.match) || !isObj(r.action)) {
      throw bad(`rule ${i} is damaged`)
    }
    return r as unknown as ForemanRule
  })
  const spent = list(o, 'spent').map((e, i) => {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'number') {
      throw bad(`spent entry ${i} is damaged`)
    }
    return [e[0], e[1]] as [string, number]
  })
  const agents = list(o, 'agents').map((a, i) => {
    if (!isObj(a) || typeof a.id !== 'string') {
      throw bad(`agent ${i} is damaged`)
    }
    return a as unknown as AgentInfo
  })
  const tombs = list(o, 'tombs').map((t, i) => {
    if (!isObj(t) || typeof t.taskId !== 'string') {
      throw bad(`tombstone ${i} is damaged`)
    }
    return t as unknown as Tombstone
  })
  const outbox = list(o, 'outbox').map((it, i) => {
    if (!isObj(it) || !isObj(it.effect) || typeof it.effect.kind !== 'string') {
      throw bad(`outbox item ${i} is damaged`)
    }
    num(it, 'id')
    num(it, 'at')
    num(it, 'attempts')
    num(it, 'retryAt')
    return it as unknown as OutboxItem
  })
  const dead = list(o, 'dead').map((d, i) => {
    if (!isObj(d) || typeof d.kind !== 'string') {
      throw bad(`dead effect ${i} is damaged`)
    }
    return d as unknown as DeadEffect
  })
  const published = list(o, 'published') as CapabilityConfig[]
  const draft = list(o, 'draft') as CapabilityConfig[]
  const cards = o.cards
  if (!isObj(cards) || !Array.isArray(cards.cards) || !Array.isArray(cards.publish)) {
    throw bad('"cards" is missing or damaged')
  }
  const settingsRaw = o.settings
  let settings: SnapshotSettings | null = null
  if (settingsRaw !== null && settingsRaw !== undefined) {
    if (!isObj(settingsRaw)) {
      throw bad('"settings" is damaged')
    }
    settings = { holdMs: num(settingsRaw, 'holdMs'), releaseMs: num(settingsRaw, 'releaseMs') }
  }
  const out: ForemanSnapshot = {
    version: SNAPSHOT_VERSION,
    jobs,
    tasks,
    rules,
    menuRevision: num(o, 'menuRevision'),
    published,
    draft,
    spent,
    seq: num(o, 'seq'),
    ids: num(o, 'ids'),
    lastContactAt: numOrNull(o, 'lastContactAt'),
    paused: flag(o, 'paused'),
    autoAccept: flag(o, 'autoAccept'),
    cards: cards as ForemanSnapshot['cards'],
    agents,
    tombs,
    lastBeatAt: numOrNull(o, 'lastBeatAt'),
    lastBeatSig: typeof o.lastBeatSig === 'string' ? o.lastBeatSig : '',
    outbox,
    outSeq: num(o, 'outSeq'),
    dead,
    settings,
    savedAt: num(o, 'savedAt')
  }
  checkCards(out.cards)
  return structuredClone(out)
}
