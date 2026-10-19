import type React from 'react'
import { useState } from 'react'
import { FolderPlus, GitBranchPlus } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import restingHelper from '../art/empty-quiet.webp'
import { useHawlLight } from './hawl-light'
import { useHawlSession } from './hawl-session'

export type HawlLandingShortcut = {
  id: string
  shortcut: ShortcutKeyComboDetails
  action: string
}

type Lane = 'now' | 'fyi' | 'later' | 'done'

const LANES: { id: Lane; label: string }[] = [
  { id: 'now', label: 'Do now' },
  { id: 'fyi', label: 'FYI' },
  { id: 'later', label: 'Later' },
  { id: 'done', label: 'Done' }
]

const GROUPS: { id: Exclude<Lane, 'done'>; label: string; tone: 'orange' | 'lime' | 'stone'; sort: string }[] = [
  { id: 'now', label: 'Do now', tone: 'orange', sort: 'Oldest first' },
  { id: 'fyi', label: 'FYI', tone: 'lime', sort: 'Newest first' },
  { id: 'later', label: 'Later', tone: 'stone', sort: 'Snoozed items return here' }
]

/**
 * Home, the Needs you page (H01): the page is the ground. Heading, the Do now / FYI / Later / Done
 * segmented control, then the three groups. With no site or agent asking for anything the groups are
 * empty, the resting helper sits on the page and the two lit actions start work. Items arrive from
 * the relay (M1) and from agents that wait on you (M3).
 */
export function HawlLanding({
  hasProjects,
  createTargetLabel,
  shortcuts,
  banner,
  onAddProject,
  onCreate
}: {
  hasProjects: boolean
  createTargetLabel: string
  shortcuts: HawlLandingShortcut[]
  banner: React.ReactNode
  onAddProject: () => void
  onCreate: () => void
}): React.JSX.Element {
  useHawlLight()
  const session = useHawlSession()
  const [lane, setLane] = useState<Lane>('now')
  const counts: Record<Lane, number> = { now: session.needsYou, fyi: 0, later: 0, done: 0 }
  const visible = lane === 'done' ? [] : GROUPS.filter((g) => g.id === lane || lane === 'now')
  return (
    <div className="hawl-home" data-hawl-home>
      <img className="hawl-home-art" src={restingHelper} alt="" aria-hidden draggable={false} />
      <header className="hawl-home-head">
        <div className="hawl-home-titles">
          <h1 className="hawl-home-title">Needs you</h1>
          <p className="hawl-home-sub">
            {session.needsYou > 0
              ? `${session.needsYou} things only you can do. Agents are waiting on them.`
              : hasProjects
                ? 'Nothing needs you right now. Pick a workspace to keep working.'
                : 'Nothing needs you yet. Add a project to start your first agent.'}
          </p>
        </div>
        <div className="hawl-seg" role="tablist" aria-label="Show">
          {LANES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={lane === item.id}
              className="hawl-seg-item"
              onClick={() => setLane(item.id)}
            >
              {item.label}
              {item.id === 'done' ? null : <span className="hawl-seg-count">{counts[item.id]}</span>}
            </button>
          ))}
        </div>
      </header>
      {banner}
      <div className="hawl-home-body">
        {lane === 'done' ? (
          <p className="hawl-home-empty">Nothing is marked done yet. Items you finish show up here.</p>
        ) : (
          visible.map((group) => (
            <section key={group.id} className="hawl-group" aria-label={group.label}>
              <div className="hawl-group-head">
                <span className={`hawl-orb hawl-orb-${group.tone}`} aria-hidden />
                <span className="hawl-group-label">{group.label}</span>
                <span className="hawl-group-count">{counts[group.id]}</span>
                <span className="hawl-group-sort">{group.sort}</span>
              </div>
              <p className="hawl-home-empty">
                {group.id === 'now'
                  ? 'Approvals, join requests and stuck work land here.'
                  : group.id === 'fyi'
                    ? 'Finished and passed work you may want to read.'
                    : 'Anything you snooze waits here until it is due.'}
              </p>
            </section>
          ))
        )}
        <div className="hawl-home-actions">
          <button type="button" className="hawl-btn hawl-btn-lit" onClick={onAddProject}>
            <FolderPlus aria-hidden />
            Add project
          </button>
          <button type="button" className="hawl-btn hawl-btn-acrylic" onClick={onCreate}>
            <GitBranchPlus aria-hidden />
            Create {createTargetLabel.toLowerCase()}
          </button>
        </div>
      </div>
      <footer className="hawl-home-keys" aria-label="Keyboard shortcuts">
        {shortcuts.map((item) => (
          <span key={item.id} className="hawl-home-key">
            <ShortcutKeyCombo
              keys={item.shortcut.keys}
              doubleTap={item.shortcut.doubleTap}
              className="inline-flex gap-1"
              keyCapClassName="hawl-kcap"
              separatorClassName="hidden"
            />
            <span>{item.action}</span>
          </span>
        ))}
      </footer>
    </div>
  )
}
