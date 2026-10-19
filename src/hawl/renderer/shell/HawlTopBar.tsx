import type React from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useAppStore } from '@/store'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { HawlSlot } from './HawlSlots'

// Fallbacks show the honest state before sign-in exists (M1): no site, not connected.
function SiteSwitcherFallback(): React.JSX.Element {
  return (
    <button
      type="button"
      className="hawl-site-switcher"
      disabled
      title="Sites arrive with Hawl sign-in"
    >
      <span className="hawl-site-tile" aria-hidden>
        H
      </span>
      <span className="hawl-site-name">No site yet</span>
      <ChevronDown className="hawl-site-chev" aria-hidden />
    </button>
  )
}

function LiveLampFallback(): React.JSX.Element {
  return (
    <span className="hawl-live hawl-live-off" title="Not signed in to Hawl">
      <span className="hawl-lamp" aria-hidden />
      Offline
    </span>
  )
}

/** Hawl top bar (H01): Site switcher, search well, Live lamp, actions. Sits above the page area. */
export function HawlTopBar(): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const combos = useShortcutKeyComboDetails('worktree.palette')
  return (
    <div className="hawl-topbar" data-hawl-topbar>
      <HawlSlot name="site-switcher" fallback={<SiteSwitcherFallback />} />
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
        <HawlSlot name="topbar-live" fallback={<LiveLampFallback />} />
        <HawlSlot name="topbar-actions" />
      </div>
    </div>
  )
}
