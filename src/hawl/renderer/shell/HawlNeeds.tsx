import type React from 'react'
import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { useLiveDashboardSnapshot } from '@/components/dashboard/useLiveDashboardSnapshot'
import { revealDashboardAgent } from '@/components/dashboard/reveal-dashboard-agent'
import type { DashboardCard } from '../../../shared/dashboard-snapshot'
import { useHawlSession, type HawlNeedsItem } from './hawl-session'

const BEAD_TONES = ['orange', 'sky', 'lime', 'violet', 'teal'] as const

function toneFor(name: string): (typeof BEAD_TONES)[number] {
  let sum = 0
  for (const ch of name) {
    sum = (sum + ch.charCodeAt(0)) % 997
  }
  return BEAD_TONES[sum % BEAD_TONES.length]
}

function agentLabel(agentType: string): string {
  if (!agentType || agentType === 'unknown') {
    return 'Agent'
  }
  return agentType.charAt(0).toUpperCase() + agentType.slice(1)
}

/** "4 min ago", "2 h ago", "Yesterday", or a short date. */
export function formatNeedsTime(at: number, now: number = Date.now()): string {
  if (!at) {
    return ''
  }
  const diff = Math.max(0, now - at)
  const min = Math.floor(diff / 60000)
  if (min < 1) {
    return 'Just now'
  }
  if (min < 60) {
    return `${min} min ago`
  }
  const hours = Math.floor(min / 60)
  if (hours < 24) {
    return `${hours} h ago`
  }
  const days = Math.floor(hours / 24)
  if (days === 1) {
    return 'Yesterday'
  }
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fromCard(card: DashboardCard): HawlNeedsItem | null {
  const open = (): void => {
    revealDashboardAgent({
      repoId: card.repoId,
      worktreeId: card.worktreeId,
      tabId: card.tabId,
      leafId: card.leafId,
      executionHostId: card.executionHostId
    })
  }
  const where = `${card.repoName} / ${card.worktreeName}`
  const worker = { name: agentLabel(String(card.agentType)), tone: toneFor(String(card.agentType)) }
  if (card.bucket === 'attention') {
    return {
      id: `agent:${card.paneKey}`,
      lane: 'now',
      tone: 'orange',
      title: card.askSummary || card.task || `${worker.name} is waiting for you`,
      sub: where,
      worker,
      at: card.stateChangedAt || card.startedAt,
      action: 'Open',
      onOpen: open
    }
  }
  if (card.bucket === 'done' && card.unseen) {
    return {
      id: `agent:${card.paneKey}`,
      lane: 'fyi',
      tone: 'lime',
      title: `${worker.name} finished: ${card.task || card.worktreeName}`,
      sub: where,
      worker,
      at: card.finishedAt ?? card.stateChangedAt,
      onOpen: open
    }
  }
  return null
}

/**
 * Everything that needs the person: items from the relay (set by sign-in, M1) and the local agents that
 * are waiting on an answer or have just finished work nobody has looked at. Do now is oldest first, FYI
 * newest first, as in H01.
 */
export function useHawlNeeds(): HawlNeedsItem[] {
  const session = useHawlSession()
  const snapshot = useLiveDashboardSnapshot()
  return useMemo(() => {
    const local = snapshot.cards
      .map(fromCard)
      .filter((item): item is HawlNeedsItem => item !== null)
    const all = [...session.needsItems, ...local]
    return all.sort((a, b) => (a.lane === 'fyi' ? b.at - a.at : a.at - b.at))
  }, [session.needsItems, snapshot.cards])
}

/** One row of the Needs you list (H01 .nr): lamp, why, who, when, and a lit action on hover. */
export function HawlNeedsRow({
  item,
  index = 0
}: {
  item: HawlNeedsItem
  index?: number
}): React.JSX.Element {
  return (
    <li className="hawl-nr" data-lane={item.lane} style={{ '--i': index } as React.CSSProperties}>
      <button type="button" className="hawl-nr-main" onClick={item.onOpen}>
        <span className={`hawl-orb hawl-orb-${item.tone}`} aria-hidden />
        <span className="hawl-nr-text">
          <span className="hawl-nr-why">{item.title}</span>
          {item.sub || item.ref ? (
            <span className="hawl-nr-sub">
              {item.ref ? <i>{item.ref}</i> : null}
              {item.sub}
            </span>
          ) : null}
        </span>
        <span className="hawl-wk">
          <i
            className={`hawl-bead hawl-bead-${item.worker.tone ?? toneFor(item.worker.name)}`}
            aria-hidden
          >
            {item.worker.name.charAt(0).toUpperCase()}
          </i>
          {item.worker.name}
        </span>
        <time className="hawl-nr-time">{formatNeedsTime(item.at)}</time>
        <span className="hawl-nr-go">
          {item.action ? <span className="hawl-review">{item.action}</span> : null}
          <i className="hawl-chev" aria-hidden>
            <ChevronRight />
          </i>
        </span>
      </button>
    </li>
  )
}
