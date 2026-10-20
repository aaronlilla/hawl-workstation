// Taking a snapshot of a foreman and swapping a checked one back in.
import { SNAPSHOT_VERSION } from './snapshot'
import type { ForemanSnapshot } from './snapshot'
import type { ForemanCtx } from './state'

/** Everything a restart needs, as plain data. */
export function takeSnapshot(c: ForemanCtx): ForemanSnapshot {
  return structuredClone({
    version: SNAPSHOT_VERSION,
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
    cards: c.cards.snapshot(),
    agents: [...c.agents.values()],
    tombs: [...c.tombs.values()],
    lastBeatAt: c.lastBeatAt,
    lastBeatSig: c.lastBeatSig,
    outbox: c.box.items,
    outSeq: c.box.seq,
    dead: c.box.dead,
    settings: c.ownerTimes,
    savedAt: c.now()
  })
}

/** Swap a checked snapshot in. Nothing here can throw: parseSnapshot has already vouched for the file. */
export function applySnapshot(c: ForemanCtx, snap: ForemanSnapshot): void {
  c.jobs.clear()
  c.tasks.clear()
  c.rules.length = 0
  c.spent.clear()
  c.agents.clear()
  c.tombs.clear()
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
  for (const a of snap.agents) {
    // The terminals died with the old process: known, but offline until they announce themselves.
    c.agents.set(a.id, { ...a, online: false, away: false })
  }
  for (const t of snap.tombs) {
    c.tombs.set(t.taskId, t)
  }
  c.lastBeatAt = snap.lastBeatAt
  c.lastBeatSig = snap.lastBeatSig
  // What was not delivered before the stop is delivered now, first, in the order it was queued.
  c.box.load(snap.outbox, snap.outSeq, snap.dead)
  c.ownerTimes = snap.settings
  if (snap.settings) {
    c.cfg.holdMs = snap.settings.holdMs
    c.cfg.releaseMs = snap.settings.releaseMs
  }
}
