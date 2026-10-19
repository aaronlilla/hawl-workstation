import type React from 'react'
import { useMemo } from 'react'
import { useLiveDashboardSnapshot } from '@/components/dashboard/useLiveDashboardSnapshot'
import { revealDashboardAgent } from '@/components/dashboard/reveal-dashboard-agent'
import type { DashboardCard } from '../../../shared/dashboard-snapshot'
import restingHelper from '../art/empty-quiet.webp'
import { HawlNeedsRow } from './HawlNeeds'
import type { HawlNeedsItem } from './hawl-session'
import { useHawlLight } from './hawl-light'

const STATE_LABEL: Record<string, string> = {
  working: 'Working',
  blocked: 'Blocked',
  waiting: 'Waiting for you',
  done: 'Finished',
  idle: 'Idle'
}

function agentName(agentType: string): string {
  if (!agentType || agentType === 'unknown') {
    return 'Agent'
  }
  return agentType.charAt(0).toUpperCase() + agentType.slice(1)
}

function toItem(card: DashboardCard): HawlNeedsItem {
  const tone =
    card.dotState === 'blocked' || card.dotState === 'waiting'
      ? 'orange'
      : card.dotState === 'working' || card.dotState === 'done'
        ? 'lime'
        : 'stone'
  return {
    id: `agent:${card.paneKey}`,
    lane: 'now',
    tone,
    title: card.task || `${agentName(String(card.agentType))} in ${card.worktreeName}`,
    sub: `${STATE_LABEL[card.dotState] ?? 'Idle'}  ·  ${card.repoName} / ${card.worktreeName}`,
    worker: { name: agentName(String(card.agentType)) },
    at: card.stateChangedAt || card.startedAt || 0,
    action: 'Open',
    onOpen: () =>
      revealDashboardAgent({
        repoId: card.repoId,
        worktreeId: card.worktreeId,
        tabId: card.tabId,
        leafId: card.leafId,
        executionHostId: card.executionHostId
      })
  }
}

/**
 * The Agents page: every agent running on this machine, one row each, newest change first. It reads the
 * same live snapshot as Needs you. Agents from other machines join when sites arrive (M2).
 */
export function HawlAgents(): React.JSX.Element {
  useHawlLight()
  const snapshot = useLiveDashboardSnapshot()
  const items = useMemo(
    () =>
      [...snapshot.cards]
        .sort((a, b) => (b.stateChangedAt || 0) - (a.stateChangedAt || 0))
        .map(toItem),
    [snapshot.cards]
  )
  const working = snapshot.cards.filter((card) => card.dotState === 'working').length
  return (
    <div className="hawl-home hawl-agents" data-hawl-home data-has-items={items.length > 0}>
      {items.length === 0 ? (
        <img className="hawl-home-art" src={restingHelper} alt="" aria-hidden draggable={false} />
      ) : null}
      <header className="hawl-home-head">
        <div className="hawl-home-titles">
          <h1 className="hawl-home-title">Agents</h1>
          <p className="hawl-home-sub">
            {items.length === 0
              ? 'No agent is running on this machine. Open a workspace and start one.'
              : `${items.length} on this machine, ${working} working right now.`}
          </p>
        </div>
      </header>
      <div className="hawl-home-body">
        {items.length > 0 ? (
          <ul className="hawl-needs">
            {items.map((item, index) => (
              <HawlNeedsRow key={item.id} item={item} index={index} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
