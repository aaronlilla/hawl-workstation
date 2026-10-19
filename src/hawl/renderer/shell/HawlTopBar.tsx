import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Home,
  Lock,
  LogIn,
  Plus,
  Search,
  Settings as SettingsIcon,
  Users
} from 'lucide-react'
import { useAppStore } from '@/store'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { HawlSlot } from './HawlSlots'
import { HawlSidebarBrand } from './HawlSidebarTop'
import { HawlSheet } from './HawlSheet'
import { HawlAboutHost } from './HawlAbout'
import { useHawlLight } from './hawl-light'
import { setHawlSession, useHawlSession, type HawlSite } from './hawl-session'

function siteInitial(site: HawlSite): string {
  return (site.initial ?? site.name.trim().charAt(0) ?? '?').toUpperCase()
}

function SiteTile({ site, small }: { site: HawlSite | null; small?: boolean }): React.JSX.Element {
  return (
    <span
      className={`hawl-site-tile hawl-tone-${site?.tone ?? 'orange'}${small ? ' hawl-site-tile-sm' : ''}`}
      aria-hidden
    >
      {site ? siteInitial(site) : 'H'}
    </span>
  )
}

/** Site switcher (H02): the current site, and a glass menu of every site. Filled by sign-in (M1). */
function SiteSwitcher(): React.JSX.Element {
  const session = useHawlSession()
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const active = session.sites.find((s) => s.id === session.activeSiteId) ?? null
  const signedIn = session.signedIn
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="hawl-site-switcher"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-open={open ? 'true' : 'false'}
        onClick={() => setOpen((v) => !v)}
      >
        <SiteTile site={active} />
        <span className="hawl-site-name">{active ? active.name : 'No site yet'}</span>
        <ChevronDown className="hawl-site-chev" aria-hidden />
      </button>
      <HawlSheet
        anchor={anchor}
        open={open}
        onClose={close}
        label="Sites"
        className="hawl-sites-sheet"
      >
        <div className="hawl-sheet-title">Sites</div>
        {session.sites.length === 0 ? (
          <p className="hawl-sheet-empty">
            {signedIn
              ? 'You are not on a site yet. Start one, or ask a teammate to invite you.'
              : 'Sign in to Hawl to see your sites. Until then this workstation runs on your own machine only.'}
          </p>
        ) : (
          <ul className="hawl-site-list" role="listbox" aria-label="Sites">
            {session.sites.map((site) => {
              const current = site.id === session.activeSiteId
              return (
                <li key={site.id} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={current}
                    data-hawl-item
                    data-current={current ? 'true' : 'false'}
                    className="hawl-site-row"
                    onClick={() => {
                      setHawlSession({ activeSiteId: site.id })
                      close()
                    }}
                  >
                    <SiteTile site={site} small />
                    <span className="hawl-site-row-name">{site.name}</span>
                    <span className="hawl-site-row-meta">
                      {site.frozen ? (
                        <>
                          <Lock aria-hidden /> Frozen
                        </>
                      ) : site.role && site.role !== 'owner' ? (
                        <span className="hawl-site-role">
                          {site.role === 'admin' ? 'Admin' : 'Member'}
                        </span>
                      ) : null}
                      {site.needsYou ? (
                        <span className="hawl-site-count">{site.needsYou}</span>
                      ) : null}
                      {current ? <Check className="hawl-site-check" aria-hidden /> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <button
          type="button"
          className="hawl-btn hawl-btn-lit hawl-sheet-primary"
          data-hawl-item
          disabled={!signedIn}
          title={signedIn ? undefined : 'Sign in to start a site'}
        >
          <Plus aria-hidden />
          New site
        </button>
        <div className="hawl-sheet-rows">
          <button type="button" className="hawl-sheet-row" data-hawl-item disabled={!signedIn}>
            <Home aria-hidden />
            <span>My setups</span>
            <ChevronRight className="hawl-sheet-row-go" aria-hidden />
          </button>
          <button type="button" className="hawl-sheet-row" data-hawl-item disabled={!signedIn}>
            <Users aria-hidden />
            <span>All my sites and leave...</span>
            <ChevronRight className="hawl-sheet-row-go" aria-hidden />
          </button>
        </div>
        <div className="hawl-sheet-keys" aria-hidden>
          <span className="hawl-kcap">↑</span>
          <span className="hawl-kcap">↓</span>
          <span>move</span>
          <span className="hawl-kcap hawl-kcap-wide">Enter</span>
          <span>switch</span>
          <span className="hawl-kcap hawl-kcap-wide">Esc</span>
          <span>close</span>
        </div>
      </HawlSheet>
    </>
  )
}

/** Live lamp (S-156): a glass lens in a bezel. Lit green when the relay connection is up. */
function LiveLamp(): React.JSX.Element {
  const { live, signedIn } = useHawlSession()
  return (
    <span
      className={`hawl-live ${live ? 'hawl-live-on' : 'hawl-live-off'}`}
      title={
        live ? 'Connected to Hawl' : signedIn ? 'Reconnecting to Hawl' : 'Not signed in to Hawl'
      }
      data-state={live ? 'live' : 'offline'}
    >
      <span className="hawl-lamp" aria-hidden />
      <span className="hawl-live-text">{live ? 'Live' : 'Offline'}</span>
    </span>
  )
}

/** Invite button and the account disc (H02). Both wait for sign-in. */
function TopbarActions(): React.JSX.Element {
  const session = useHawlSession()
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const canInvite = session.signedIn && session.activeSiteId !== null
  return (
    <>
      <button
        type="button"
        className="hawl-invite"
        disabled={!canInvite}
        title={
          canInvite ? 'Invite someone to this site' : 'Sign in and pick a site to invite people'
        }
        onClick={() => window.dispatchEvent(new CustomEvent('hawl:invite'))}
      >
        <Plus aria-hidden />
        <span className="hawl-invite-label">Invite</span>
      </button>
      <button
        ref={setAnchor}
        type="button"
        className="hawl-avatar"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Account"
        onClick={() => setOpen((v) => !v)}
      >
        {session.user ? (session.user.initial ?? session.user.name.charAt(0)).toUpperCase() : null}
      </button>
      <HawlSheet
        anchor={anchor}
        open={open}
        onClose={close}
        align="end"
        width={288}
        label="Account"
        className="hawl-account-sheet"
      >
        <div className="hawl-account-head">
          <span className="hawl-avatar hawl-avatar-lg" aria-hidden>
            {session.user
              ? (session.user.initial ?? session.user.name.charAt(0)).toUpperCase()
              : null}
          </span>
          <div>
            <div className="hawl-account-name">{session.user?.name ?? 'Not signed in'}</div>
            <div className="hawl-account-sub">
              {session.signedIn ? 'Signed in to Hawl' : 'Working on this machine only'}
            </div>
          </div>
        </div>
        {session.signedIn ? null : (
          <button
            type="button"
            className="hawl-btn hawl-btn-lit hawl-sheet-primary"
            data-hawl-item
            disabled
            title="Hawl sign-in arrives in the next build"
          >
            <LogIn aria-hidden />
            Sign in to Hawl
          </button>
        )}
        <div className="hawl-sheet-rows">
          <button
            type="button"
            className="hawl-sheet-row"
            data-hawl-item
            onClick={() => {
              close()
              openSettingsPage()
            }}
          >
            <SettingsIcon aria-hidden />
            <span>Settings</span>
          </button>
          {session.signedIn ? (
            <button
              type="button"
              className="hawl-sheet-row"
              data-hawl-item
              onClick={() => {
                close()
                setHawlSession({
                  signedIn: false,
                  live: false,
                  user: null,
                  sites: [],
                  activeSiteId: null
                })
              }}
            >
              <LogIn aria-hidden />
              <span>Sign out</span>
            </button>
          ) : null}
        </div>
      </HawlSheet>
    </>
  )
}

/** Hawl top bar (H01): Site switcher, search well, Live lamp, Invite and account. Sits above the page area. */
export function HawlTopBar(): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const combos = useShortcutKeyComboDetails('worktree.palette')
  const activeView = useAppStore((s) => s.activeView)
  // Settings is a full page without the sidebar, so the wordmark moves into the bar.
  const sidebarHidden = activeView === 'settings' || activeView === 'space'
  const barRef = useRef<HTMLDivElement | null>(null)
  useHawlLight(barRef)
  useEffect(() => {
    document.documentElement.dataset.hawlShell = 'on'
  }, [])
  return (
    <div className="hawl-topbar" data-hawl-topbar ref={barRef}>
      {sidebarHidden ? <HawlSidebarBrand /> : null}
      <HawlSlot name="site-switcher" fallback={<SiteSwitcher />} />
      <button
        type="button"
        className="hawl-search"
        onClick={() => openModal('worktree-palette')}
        aria-label="Search or jump to"
      >
        <Search className="hawl-search-ic" aria-hidden />
        <span className="hawl-search-text">Search or jump to...</span>
        <span className="hawl-search-keys" aria-hidden>
          {combos.slice(0, 1).map((combo) => (
            <ShortcutKeyCombo
              key={combo.keys.join('-')}
              keys={combo.keys}
              doubleTap={combo.doubleTap}
              className="inline-flex gap-1"
              keyCapClassName="hawl-kcap"
              separatorClassName="hidden"
            />
          ))}
        </span>
      </button>
      <div className="hawl-topbar-right">
        <HawlSlot name="topbar-live" fallback={<LiveLamp />} />
        <HawlSlot name="topbar-actions" fallback={<TopbarActions />} />
      </div>
      <HawlAboutHost />
    </div>
  )
}
