import type React from 'react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bot,
  CalendarClock,
  CircleAlert,
  ClipboardCheck,
  Folder,
  MapPin,
  MessageSquare,
  Smartphone
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAppStore } from '@/store'
import { SetupGuideSidebarEntry } from '@/components/sidebar/SetupGuideSidebarEntry'
import { useAgentBucketCounts } from '@/components/dashboard/useAgentBucketCounts'
import { useHawlLight } from './hawl-light'
import { useHawlSession } from './hawl-session'

type NavItem = {
  id: string
  label: string
  icon: LucideIcon
  active: boolean
  onSelect?: () => void
  /** Arrives with a later piece: shown, dimmed, not clickable. */
  soon?: string
  badge?: number
}

/**
 * Hawl sidebar navigation (H01). Seven rows: Needs you, Work, Activity, Chat, Map, Agents, Files.
 * Each is wired to the workstation page that does that job today (Work is the task list, Activity is
 * the agent activity page, Agents is the agent list, Files is shared files). Chat and Map wait for
 * sites and the yard map. Automations and Phone, which Orca keeps in this column, sit below as quiet rows.
 */
export function HawlNav(): React.JSX.Element {
  useHawlLight()
  const session = useHawlSession()
  const attention = useAgentBucketCounts().attention
  const needsCount = session.needsItems.filter((item) => item.lane === 'now').length + attention
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'workspaces')
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const openArtifactsPage = useAppStore((s) => s.openArtifactsPage)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openMobilePage = useAppStore((s) => s.openMobilePage)

  const navRef = useRef<HTMLElement | null>(null)
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null)
  const items = useMemo<NavItem[]>(() => {
    const home = activeView === 'terminal' && activeWorktreeId === null
    return [
      {
        id: 'needs-you',
        label: 'Needs you',
        icon: CircleAlert,
        active: home,
        badge: needsCount,
        onSelect: () => {
          setActiveView('terminal')
          setActiveWorktree(null)
        }
      },
      {
        id: 'work',
        label: 'Work',
        icon: ClipboardCheck,
        active: activeView === 'tasks',
        onSelect: () => openTaskPage()
      },
      {
        id: 'activity',
        label: 'Activity',
        icon: Activity,
        active: activeView === 'activity',
        onSelect: () => openActivityPage()
      },
      {
        id: 'chat',
        label: 'Chat',
        icon: MessageSquare,
        active: false,
        soon: 'Chat arrives with Hawl sites'
      },
      {
        id: 'map',
        label: 'Map',
        icon: MapPin,
        active: false,
        soon: 'The yard map arrives with Hawl sites'
      },
      {
        id: 'agents',
        label: 'Agents',
        icon: Bot,
        active: activeView === 'terminal' && sidebarBody === 'agents',
        onSelect: () => {
          if (activeView !== 'terminal') {
            setActiveView('terminal')
          }
          setSidebarBody(sidebarBody === 'agents' ? 'workspaces' : 'agents')
        }
      },
      {
        id: 'files',
        label: 'Files',
        icon: Folder,
        active: activeView === 'artifacts',
        onSelect: () => openArtifactsPage()
      }
    ]
  }, [
    activeView,
    activeWorktreeId,
    sidebarBody,
    needsCount,
    setActiveView,
    setActiveWorktree,
    setSidebarBody,
    openTaskPage,
    openActivityPage,
    openArtifactsPage
  ])

  const quiet: NavItem[] = [
    {
      id: 'automations',
      label: 'Automations',
      icon: CalendarClock,
      active: activeView === 'automations',
      onSelect: () => openAutomationsPage()
    },
    {
      id: 'phone',
      label: 'Phone',
      icon: Smartphone,
      active: activeView === 'mobile',
      onSelect: () => openMobilePage()
    }
  ]

  // The lit pill is one object that slides to the open page (H01 .is-sel), not a background per row.
  const activeId = [...items, ...quiet].find((item) => item.active)?.id ?? null
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) {
      return
    }
    const measure = (): void => {
      const node = nav.querySelector<HTMLElement>('[aria-current="page"]')
      setPill(node ? { top: node.offsetTop, height: node.offsetHeight } : null)
    }
    measure()
    // Row heights change with the window height (denser sidebar in short windows).
    const observer = new ResizeObserver(measure)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [activeId])

  const row = (item: NavItem, quietRow = false): React.JSX.Element => {
    const Icon = item.icon
    const lamp = session.lamps[item.id]
    return (
      <button
        key={item.id}
        type="button"
        className={`hawl-nav-row${quietRow ? ' hawl-nav-row-quiet' : ''}${item.soon ? ' hawl-nav-row-soon' : ''}`}
        data-nav={item.id}
        aria-current={item.active ? 'page' : undefined}
        aria-disabled={item.soon ? true : undefined}
        title={item.soon}
        onClick={item.soon ? undefined : item.onSelect}
      >
        <Icon className="hawl-nav-ic" aria-hidden />
        <span className="hawl-nav-label">{item.label}</span>
        {item.badge ? <span className="hawl-nav-badge">{item.badge}</span> : null}
        {lamp ? <span className={`hawl-nav-lamp hawl-nav-lamp-${lamp}`} aria-hidden /> : null}
      </button>
    )
  }

  return (
    <nav
      ref={navRef}
      className="hawl-nav"
      aria-label="Hawl"
      data-contextual-tour-target="sidebar-navigation"
    >
      <span
        className="hawl-nav-pill"
        aria-hidden
        data-on={pill ? 'true' : 'false'}
        style={pill ? { transform: `translateY(${pill.top}px)`, height: pill.height } : undefined}
      />
      {items.map((item) => row(item))}
      <div className="hawl-nav-sep" aria-hidden />
      {quiet.map((item) => row(item, true))}
    </nav>
  )
}

/** "Get set up  2 of 4" above Settings and Help (H01 bottom group). Hides itself once set up. */
export function HawlGetSetUp(): React.JSX.Element {
  return (
    <div className="hawl-setup-entry">
      <SetupGuideSidebarEntry />
    </div>
  )
}
