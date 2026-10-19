import type React from 'react'
import { useAppStore } from '@/store'

const HEADS: Record<string, { title: string; sub: string }> = {
  tasks: {
    title: 'Work',
    sub: 'Issues, pull requests and projects your agents can pick up.'
  },
  activity: {
    title: 'Activity',
    sub: 'What your agents did, and what they are waiting on you for.'
  },
  mobile: {
    title: 'Phone',
    sub: 'Pair your phone to answer approvals and watch agents away from the desk.'
  }
}

/**
 * The page heading (H01 "Needs you" heading style) for the pages Orca ships without one: Work, Activity
 * and Phone. Files, Automations and Settings already carry their own heading, which the theme restyles.
 */
export function HawlPageHead(): React.JSX.Element | null {
  const activeView = useAppStore((s) => s.activeView)
  const head = HEADS[activeView]
  if (!head) {
    return null
  }
  return (
    <header className="hawl-page-head" data-hawl-page-head={activeView}>
      <h1 className="hawl-page-title">{head.title}</h1>
      <p className="hawl-page-sub">{head.sub}</p>
    </header>
  )
}
