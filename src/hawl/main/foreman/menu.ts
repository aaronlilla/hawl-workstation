// The yard's menu (S11, S12, S48): edit a draft, publish it as a gateway-contract menu.
import { checkContract, type Capability, type Menu } from '../../shared/gateway-contract/contract'
import { checkExtendedMenu } from './m2-schemas'
import type { ForemanCtx } from './state'
import { ForemanError, MINUTE_MS, type CapabilityConfig, type DirectLinePolicy } from './types'

/**
 * The m2 menu: the gateway-contract menu plus the policy the ledger shows (m2-contract 3.1).
 * The strict gateway schema allows no extras, so this travels beside the strict menu, never in it.
 * `open` is carried so the ledger can show closed capabilities; it is not in the m2 field list.
 */
export type ExtendedCapability = Capability & {
  open: boolean
  approval: 'auto' | 'ask_owner'
  accept_when_offline: boolean
  accept_from?: string[]
  keywords?: string[]
  stations?: string[]
  next?: string[]
}

export type ExtendedMenu = Omit<Menu, 'capabilities'> & {
  capabilities: ExtendedCapability[]
  hold_minutes: number
  release_minutes: number
  direct_lines: DirectLinePolicy
}

/** Edit the draft. Nothing routes on a draft until publishMenu (S12). */
export function setCapabilities(c: ForemanCtx, caps: CapabilityConfig[]): void {
  c.draft = caps.map((cap) => ({ ...cap }))
}

/** Publish the draft: validated against the gateway contract, then sent. */
export function publishMenu(c: ForemanCtx): {
  menu: Menu
  extended: ExtendedMenu
  revision: number
} {
  const open = c.draft.filter((cap) => cap.open !== false)
  const policy: NonNullable<Menu['routing_policy']> = {}
  if (c.cfg.acceptFrom) {
    policy.accept_from = [...c.cfg.acceptFrom]
  }
  policy.auto_accept = c.autoAccept && open.every((cap) => cap.approval !== 'ask_owner')
  if (c.cfg.dailyBudgetUsd !== undefined) {
    policy.daily_budget_usd = c.cfg.dailyBudgetUsd
  }
  const menu: Menu = {
    yard: c.cfg.yard,
    owner: c.cfg.owner,
    display_name: c.cfg.displayName,
    visibility: c.cfg.visibility ?? 'summary',
    capabilities: open.map(toContractCapability),
    routing_policy: policy
  }
  const err = checkContract('menu', menu)
  if (err) {
    throw new ForemanError('bad_menu', err)
  }
  const extended: ExtendedMenu = {
    ...menu,
    capabilities: c.draft.map(toExtendedCapability),
    // The menu counts whole minutes; a shorter time (only used in tests) shows as 1.
    hold_minutes: Math.max(1, Math.ceil(c.cfg.holdMs / MINUTE_MS)),
    release_minutes: Math.max(1, Math.ceil(c.cfg.releaseMs / MINUTE_MS)),
    direct_lines: c.cfg.directLines ?? 'ask_owner'
  }
  const extErr = checkExtendedMenu(extended)
  if (extErr) {
    throw new ForemanError('bad_menu', extErr)
  }
  c.published = c.draft.map((cap) => ({ ...cap }))
  c.menuRevision++
  c.sendMenu(menu, c.menuRevision, extended)
  return { menu, extended, revision: c.menuRevision }
}

function toExtendedCapability(cap: CapabilityConfig): ExtendedCapability {
  const out: ExtendedCapability = {
    ...toContractCapability(cap),
    open: cap.open !== false,
    approval: cap.approval ?? 'auto',
    accept_when_offline: cap.acceptWhenOffline !== false
  }
  if (cap.acceptFrom) {
    out.accept_from = [...cap.acceptFrom]
  }
  if (cap.keywords) {
    out.keywords = [...cap.keywords]
  }
  if (cap.stations) {
    out.stations = [...cap.stations]
  }
  if (cap.next) {
    out.next = [...cap.next]
  }
  return out
}

/** Drop the foreman-only policy fields: the contract schema allows no extras. */
function toContractCapability(cap: CapabilityConfig): Capability {
  const out: Capability = { id: cap.id, description: cap.description }
  if (cap.inputs) {
    out.inputs = cap.inputs
  }
  if (cap.outputs) {
    out.outputs = cap.outputs
  }
  if (cap.quality_bar) {
    out.quality_bar = cap.quality_bar
  }
  if (cap.typical_minutes !== undefined) {
    out.typical_minutes = cap.typical_minutes
  }
  if (cap.accepts_files) {
    out.accepts_files = cap.accepts_files
  }
  return out
}
