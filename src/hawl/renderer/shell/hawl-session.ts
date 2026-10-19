import { useSyncExternalStore } from 'react'

/**
 * What the Hawl shell shows about the person and the relay: signed in or not, the Live lamp, the
 * sites for the Site switcher (H02) and the small badges and lamps on the sidebar rows (H01).
 * Empty until Hawl sign-in (M1) fills it: the default is the honest "signed out, nothing yet".
 * M1 calls setHawlSession() from its own file; nothing else in the shell needs to change.
 */
export type HawlSiteRole = 'owner' | 'member' | 'admin'

export type HawlSite = {
  id: string
  name: string
  /** Single letter on the site tile; defaults to the first letter of the name. */
  initial?: string
  /** Tile colour key: orange, lime, sky, violet, stone. Defaults to orange. */
  tone?: 'orange' | 'lime' | 'sky' | 'violet' | 'stone'
  role?: HawlSiteRole
  frozen?: boolean
  /** Items that need you on this site; 0 or missing shows nothing. */
  needsYou?: number
}

export type HawlLampTone = 'green' | 'amber' | 'red'

export type HawlSession = {
  signedIn: boolean
  /** The relay connection is up: the Live lamp is lit green. */
  live: boolean
  user: { name: string; initial?: string } | null
  sites: HawlSite[]
  activeSiteId: string | null
  /** Count on the Needs you row. */
  needsYou: number
  /** Small lamps on sidebar rows, by nav id (chat, agents). */
  lamps: Partial<Record<string, HawlLampTone>>
}

const initial: HawlSession = {
  signedIn: false,
  live: false,
  user: null,
  sites: [],
  activeSiteId: null,
  needsYou: 0,
  lamps: {}
}

let state: HawlSession = initial
const listeners = new Set<() => void>()

export function getHawlSession(): HawlSession {
  return state
}

export function setHawlSession(patch: Partial<HawlSession>): void {
  state = { ...state, ...patch }
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

export function useHawlSession(): HawlSession {
  return useSyncExternalStore(subscribe, getHawlSession, getHawlSession)
}

// The fill point for sign-in (M1) and for driving the shell by hand while it is built.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __hawlSession?: unknown }).__hawlSession = {
    get: getHawlSession,
    set: setHawlSession
  }
}
