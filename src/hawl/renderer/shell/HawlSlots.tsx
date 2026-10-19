import type React from 'react'
import { createElement } from 'react'
import type { ComponentType, ReactNode } from 'react'

/**
 * Marked slots in the Hawl shell. Later pieces fill a slot by calling registerHawlSlot() once at
 * module load, from their own file under src/hawl/renderer/. An unfilled slot renders its fallback
 * (or nothing) and takes no space.
 *
 *   site-switcher   top bar, left: the Site switcher (H02). Filled by sign-in / sites.
 *   topbar-live     top bar, right: the Live lamp (S-156). Filled by the relay client.
 *   topbar-actions  top bar, far right: Invite button and account menu (H02).
 *   yard-tree       sidebar, under the nav: yard station tree (M2).
 *   foreman-strip   sidebar, above the footer: foreman status strip (P3).
 */
export type HawlSlotName =
  | 'site-switcher'
  | 'topbar-live'
  | 'topbar-actions'
  | 'yard-tree'
  | 'foreman-strip'

const registry = new Map<HawlSlotName, ComponentType>()

export function registerHawlSlot(name: HawlSlotName, component: ComponentType): void {
  registry.set(name, component)
}

export function HawlSlot({
  name,
  fallback
}: {
  name: HawlSlotName
  fallback?: ReactNode
}): React.JSX.Element {
  const Filled = registry.get(name)
  return (
    <div
      data-hawl-slot={name}
      data-hawl-slot-filled={Filled ? 'true' : 'false'}
      className="hawl-slot"
    >
      {Filled ? createElement(Filled) : (fallback ?? null)}
    </div>
  )
}
