// The yard's menu (S11, S12, S48): edit a draft, publish it as a gateway-contract menu.
import { checkContract, type Capability, type Menu } from '../../shared/gateway-contract/contract'
import type { ForemanCtx } from './state'
import { ForemanError, type CapabilityConfig } from './types'

/** Edit the draft. Nothing routes on a draft until publishMenu (S12). */
export function setCapabilities(c: ForemanCtx, caps: CapabilityConfig[]): void {
  c.draft = caps.map((cap) => ({ ...cap }))
}

/** Publish the draft: validated against the gateway contract, then sent. */
export function publishMenu(c: ForemanCtx): { menu: Menu; revision: number } {
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
  c.published = c.draft.map((cap) => ({ ...cap }))
  c.menuRevision++
  c.deps.transport.sendMenu(menu, c.menuRevision)
  return { menu, revision: c.menuRevision }
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
