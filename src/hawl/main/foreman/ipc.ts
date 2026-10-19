// IPC surface of the foreman for the renderer (the owner's screens). Electron's ipcMain is
// injected, so nothing here imports electron. Arguments from the renderer are checked here:
// the core trusts its callers, the renderer is not one of them.
import type { ForemanRuntime } from './runtime'
import { ForemanError } from './types'
import type { CapabilityConfig } from './types'

export type IpcLike = {
  handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export const FOREMAN_CHANNELS = [
  'hawl:foreman:jobs',
  'hawl:foreman:job',
  'hawl:foreman:agents',
  'hawl:foreman:owner-decision',
  'hawl:foreman:decline',
  'hawl:foreman:reroute',
  'hawl:foreman:resume-job',
  'hawl:foreman:decide-line',
  'hawl:foreman:pause',
  'hawl:foreman:resume',
  'hawl:foreman:set-menu',
  'hawl:foreman:publish-menu'
] as const

const OWNER = 'owner'

function str(v: unknown, name: string, max = 500): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new ForemanError(
      'bad_offer',
      `${name} must be a non-empty string up to ${max} characters`
    )
  }
  return v
}

function optStr(v: unknown, name: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, name)
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') {
    throw new ForemanError('bad_offer', `${name} must be true or false`)
  }
  return v
}

/** Register every channel. Returns a function that removes them again. */
export function registerForemanIpc(ipc: IpcLike, rt: ForemanRuntime): () => void {
  const on = (channel: (typeof FOREMAN_CHANNELS)[number], fn: (...a: unknown[]) => unknown): void =>
    ipc.handle(channel, (_e, ...args) => fn(...args))

  on('hawl:foreman:jobs', () => rt.run((f) => f.jobIds().map((id) => f.jobView(id))))
  on('hawl:foreman:job', (id) => rt.run((f) => f.jobView(str(id, 'taskId', 200))))
  on('hawl:foreman:agents', () => rt.run((f) => f.agents()))
  on('hawl:foreman:owner-decision', (id, decision, reason) => {
    if (decision !== 'accept' && decision !== 'decline') {
      throw new ForemanError('bad_offer', 'decision must be accept or decline')
    }
    rt.run((f) =>
      f.ownerDecision(str(id, 'taskId', 200), decision, OWNER, optStr(reason, 'reason'))
    )
  })
  on('hawl:foreman:decline', (id, reason) => {
    rt.run((f) => f.decline(str(id, 'taskId', 200), OWNER, str(reason, 'reason')))
  })
  on('hawl:foreman:reroute', (id, toAgent, reason, makeRule) => {
    rt.run((f) =>
      f.reroute(str(id, 'taskId', 200), {
        toAgent: str(toAgent, 'toAgent', 200),
        by: OWNER,
        reason: optStr(reason, 'reason'),
        makeRule: makeRule === undefined ? false : bool(makeRule, 'makeRule')
      })
    )
  })
  on('hawl:foreman:resume-job', (id, reason) => {
    rt.run((f) => f.resolveNeedsHuman(str(id, 'taskId', 200), OWNER, optStr(reason, 'reason')))
  })
  on('hawl:foreman:decide-line', (id, approve, reason) => {
    rt.run((f) =>
      f.decideLine(str(id, 'taskId', 200), bool(approve, 'approve'), optStr(reason, 'reason'))
    )
  })
  on('hawl:foreman:pause', () => rt.run((f) => f.pause()))
  on('hawl:foreman:resume', () => rt.run((f) => f.resume()))
  on('hawl:foreman:set-menu', (caps) => {
    if (!Array.isArray(caps)) {
      throw new ForemanError('bad_menu', 'capabilities must be a list')
    }
    rt.run((f) => f.setCapabilities(caps as CapabilityConfig[]))
  })
  on('hawl:foreman:publish-menu', () => rt.run((f) => f.publishMenu().revision))

  return () => {
    for (const ch of FOREMAN_CHANNELS) {
      ipc.removeHandler(ch)
    }
  }
}
