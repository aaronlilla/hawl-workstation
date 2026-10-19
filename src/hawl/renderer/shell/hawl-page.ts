import { useSyncExternalStore } from 'react'

/**
 * Which page the Hawl home column shows while no workspace is open: the Needs you page or the Agents
 * page. Both live in the same column as the empty home, so the sidebar can switch between them
 * without touching Orca's view state.
 */
export type HawlHomePage = 'needs' | 'agents'

let page: HawlHomePage = 'needs'
const listeners = new Set<() => void>()

export function getHawlHomePage(): HawlHomePage {
  return page
}

export function setHawlHomePage(next: HawlHomePage): void {
  if (next === page) {
    return
  }
  page = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useHawlHomePage(): HawlHomePage {
  return useSyncExternalStore(subscribe, getHawlHomePage, getHawlHomePage)
}
