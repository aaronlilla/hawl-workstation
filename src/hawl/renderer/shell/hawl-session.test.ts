import { afterEach, describe, expect, it, vi } from 'vitest'
import { getHawlSession, setHawlSession } from './hawl-session'

const signedOut = {
  signedIn: false,
  live: false,
  user: null,
  sites: [],
  activeSiteId: null,
  needsItems: [],
  lamps: {}
}

describe('hawl session (what the shell shows about the person and the relay)', () => {
  afterEach(() => {
    setHawlSession(signedOut)
  })

  it('starts as the honest signed-out state: no site, not live, nothing waiting', () => {
    const session = getHawlSession()
    expect(session.signedIn).toBe(false)
    expect(session.live).toBe(false)
    expect(session.sites).toEqual([])
    expect(session.needsItems).toEqual([])
  })

  it('merges a patch and keeps the other fields', () => {
    setHawlSession({ signedIn: true, user: { name: 'Aaron Lilla' } })
    setHawlSession({ live: true })
    const session = getHawlSession()
    expect(session.signedIn).toBe(true)
    expect(session.live).toBe(true)
    expect(session.user?.name).toBe('Aaron Lilla')
  })

  it('hands every change to a subscriber through a new object', () => {
    const before = getHawlSession()
    setHawlSession({ activeSiteId: 'a' })
    expect(getHawlSession()).not.toBe(before)
    expect(getHawlSession().activeSiteId).toBe('a')
  })

  it('opens the fill point for sign-in on window.__hawlSession when a window exists', async () => {
    const fakeWindow = {} as Record<string, unknown>
    vi.stubGlobal('window', fakeWindow)
    vi.resetModules()
    const fresh = await import('./hawl-session')
    const hook = fakeWindow.__hawlSession as { get: () => unknown; set: (p: object) => void }
    expect(typeof hook.get).toBe('function')
    hook.set({ live: true })
    expect(fresh.getHawlSession().live).toBe(true)
    vi.unstubAllGlobals()
  })
})
