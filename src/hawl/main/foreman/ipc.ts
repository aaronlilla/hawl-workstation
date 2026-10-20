// IPC surface of the foreman for the renderer (the owner's screens). Electron's ipcMain is
// injected, so nothing here imports electron. Two checks sit in front of every channel:
//  - the sender: only the app's own top frame may call (an embedded frame, a plugin panel iframe or a
//    page loaded by mistake is refused, because these calls approve jobs and change who gets work);
//  - the arguments: the core trusts its callers, the renderer is not one of them.
import { PUBLISH_FIELDS } from './cards'
import type { PublishField } from './cards'
import type { ForemanRuntime } from './runtime'
import { ForemanError } from './types'
import type { CapabilityConfig, QueueEntry } from './types'

export type IpcLike = {
  handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export const FOREMAN_CHANNELS = [
  // reads
  'hawl:foreman:jobs',
  'hawl:foreman:job',
  'hawl:foreman:agents',
  'hawl:foreman:settings',
  'hawl:foreman:menu',
  'hawl:foreman:rules',
  'hawl:foreman:cards',
  'hawl:foreman:heartbeat',
  'hawl:foreman:outbox',
  // jobs
  'hawl:foreman:owner-decision',
  'hawl:foreman:decline',
  'hawl:foreman:reroute',
  'hawl:foreman:resume-job',
  'hawl:foreman:decide-line',
  // switches and times
  'hawl:foreman:pause',
  'hawl:foreman:resume',
  'hawl:foreman:set-auto-accept',
  'hawl:foreman:set-times',
  // menu and rules
  'hawl:foreman:set-menu',
  'hawl:foreman:publish-menu',
  'hawl:foreman:add-rule',
  'hawl:foreman:remove-rule',
  // cards
  'hawl:foreman:publish-cards',
  // offline queue handover
  'hawl:foreman:export-queue',
  'hawl:foreman:adopt-queue'
] as const

export type ForemanChannel = (typeof FOREMAN_CHANNELS)[number]

const OWNER = 'owner'

export type IpcOptions = {
  /** Is this event from the app's own top frame? Required: there is no default that lets everything in. */
  trusted: (event: unknown) => boolean
}

/**
 * The usual check for Electron: the event came from the window's top frame (not an iframe) and the
 * frame's address is one of the app's own. `isAppUrl` decides which addresses count.
 */
export function topFrameOf(isAppUrl: (url: string) => boolean): (event: unknown) => boolean {
  return (event) => {
    const e = event as {
      senderFrame?: { url?: string; parent?: unknown } | null
      sender?: { mainFrame?: unknown }
    } | null
    const frame = e?.senderFrame
    if (!frame || frame !== e?.sender?.mainFrame || frame.parent) {
      return false
    }
    return typeof frame.url === 'string' && isAppUrl(frame.url)
  }
}

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

function ms(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) {
    return undefined
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ForemanError('bad_setting', `${name} must be a whole number of milliseconds`)
  }
  return v
}

function obj(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ForemanError('bad_offer', `${name} must be an object`)
  }
  return v as Record<string, unknown>
}

function caps(v: unknown): CapabilityConfig[] {
  if (!Array.isArray(v) || v.length > 200) {
    throw new ForemanError('bad_menu', 'capabilities must be a list of up to 200')
  }
  for (const c of v) {
    const o = obj(c, 'capability')
    str(o.id, 'capability id', 64)
    str(o.description, 'capability description', 280)
  }
  return v as CapabilityConfig[]
}

function queue(v: unknown): QueueEntry[] {
  if (!Array.isArray(v) || v.length > 1000) {
    throw new ForemanError('bad_offer', 'entries must be a list of up to 1000')
  }
  for (const e of v) {
    const o = obj(e, 'entry')
    obj(o.offer, 'entry offer')
    str(o.requester, 'entry requester', 200)
    if (typeof o.acceptedAt !== 'number' || !Number.isFinite(o.acceptedAt)) {
      throw new ForemanError('bad_offer', 'entry acceptedAt must be a number')
    }
  }
  return v as QueueEntry[]
}

/** Register every channel. Returns a function that removes them again. */
export function registerForemanIpc(ipc: IpcLike, rt: ForemanRuntime, opts: IpcOptions): () => void {
  const on = (channel: ForemanChannel, fn: (...a: unknown[]) => unknown): void =>
    ipc.handle(channel, (event, ...args) => {
      if (!opts.trusted(event)) {
        throw new ForemanError('untrusted_sender', `${channel} is for the app window only`)
      }
      return fn(...args)
    })

  // ---- reads
  on('hawl:foreman:jobs', () => rt.run((f) => f.jobIds().map((id) => f.jobView(id))))
  on('hawl:foreman:job', (id) => rt.run((f) => f.jobView(str(id, 'taskId', 200))))
  on('hawl:foreman:agents', () => rt.run((f) => f.agents()))
  on('hawl:foreman:settings', () => rt.run((f) => f.settings()))
  on('hawl:foreman:menu', () => rt.run((f) => f.menuState()))
  on('hawl:foreman:rules', () => rt.run((f) => f.rules()))
  on('hawl:foreman:cards', () => rt.run((f) => f.cards.yardView(f.busyAgentIds())))
  on('hawl:foreman:heartbeat', () => rt.run((f) => f.heartbeat()))
  on('hawl:foreman:outbox', () =>
    rt.run((f) => ({ waiting: f.outbox(), dead: f.deadEffects() }))
  )

  // ---- jobs
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

  // ---- switches and times
  on('hawl:foreman:pause', () => rt.run((f) => f.pause()))
  on('hawl:foreman:resume', () => rt.run((f) => f.resume()))
  on('hawl:foreman:set-auto-accept', (on_) => rt.run((f) => f.setAutoAccept(bool(on_, 'on'))))
  on('hawl:foreman:set-times', (holdMs, releaseMs) =>
    rt.run((f) => f.setTimes({ holdMs: ms(holdMs, 'holdMs'), releaseMs: ms(releaseMs, 'releaseMs') }))
  )

  // ---- menu and rules
  on('hawl:foreman:set-menu', (list) => {
    const checked = caps(list)
    rt.run((f) => f.setCapabilities(checked))
  })
  on('hawl:foreman:publish-menu', () => rt.run((f) => f.publishMenu().revision))
  on('hawl:foreman:add-rule', (match, agentId) => {
    const m = obj(match, 'match')
    rt.run((f) =>
      f.addRule(
        { capability: optStr(m.capability, 'capability'), fromYard: optStr(m.fromYard, 'fromYard') },
        { agentId: str(agentId, 'agentId', 200) },
        'owner'
      )
    )
  })
  on('hawl:foreman:remove-rule', (id) => rt.run((f) => f.removeRule(str(id, 'id', 200))))

  // ---- cards
  on('hawl:foreman:publish-cards', (siteId, fields) => {
    if (!Array.isArray(fields) || fields.some((x) => !PUBLISH_FIELDS.includes(x as PublishField))) {
      throw new ForemanError('bad_card', 'fields must be a list of state, capability, title, repo')
    }
    rt.run((f) => f.cards.publish(str(siteId, 'siteId', 200), fields as PublishField[]))
  })

  // ---- offline queue handover
  on('hawl:foreman:export-queue', () => rt.run((f) => f.exportQueue()))
  on('hawl:foreman:adopt-queue', (entries) => {
    const checked = queue(entries)
    return rt.run((f) => f.adoptQueue(checked))
  })

  return () => {
    for (const ch of FOREMAN_CHANNELS) {
      ipc.removeHandler(ch)
    }
  }
}
