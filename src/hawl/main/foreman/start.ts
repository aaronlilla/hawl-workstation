// Put the foreman together and bring it up. No Electron imports: the app's main process passes in what it
// has (the user-data folder, ipcMain, a way to reach its windows), so all of this runs in tests too.
//
// What it starts, in order: the saved state and the runtime (runtime.ts), the door for agents (agent-bridge.ts),
// the owner's IPC (ipc.ts), and the link to the relay (relay-transport.ts). Until the owner has an identity file
// (identity.ts) nothing but the status channel exists, and the screen says the foreman is not set up.
import { join } from 'node:path'
import type { LifecycleEvent } from '../../shared/gateway-contract/contract'
import { AgentBridge } from './agent-bridge'
import { AgentHub } from './agent-hub'
import type { AgentEvent } from './agent-hub'
import { fileStorage } from './file-storage'
import { Foreman } from './foreman'
import { readIdentity } from './identity'
import type { HawlIdentity } from './identity'
import { registerForemanIpc } from './ipc'
import type { IpcLike } from './ipc'
import { createRelayTransport } from './relay-transport'
import type { RelayHttpLike } from './relay-transport'
import { ForemanRuntime } from './runtime'
import type { OwnerNotice } from './types'

export const STATUS_CHANNEL = 'hawl:foreman:status'
export const CHANGED_CHANNEL = 'hawl:foreman:changed'
export const NOTICE_CHANNEL = 'hawl:foreman:notice'
export const AGENT_EVENT_CHANNEL = 'hawl:foreman:agent-event'
export const DEV_OFFER_CHANNEL = 'hawl:foreman:dev-offer'

export type ForemanStatus =
  | { configured: false; reason: string | null }
  | { configured: true; yard: string; displayName: string; bridgeUrl: string }

export type StartOptions = {
  userDataDir: string
  ipc: IpcLike
  /** Is this event from the app's own top frame (ipc.ts topFrameOf)? */
  trusted: (event: unknown) => boolean
  /** Push to the app's windows. */
  emit: (channel: string, payload?: unknown) => void
  /** Show an owner notice outside the window (an OS notification). */
  osNotify?: (n: OwnerNotice) => void
  /** The signed-in relay connection, or null while signed out: effects then wait in the outbox. */
  relay?: () => RelayHttpLike | null
  clock?: { now(): number }
  /** Tests: skip reading the identity file. */
  identity?: HawlIdentity | null
  /**
   * Adds the `hawl:foreman:dev-offer` channel that stands in for the Dispatcher until the relay link lands.
   * Off in the app unless HAWL_FOREMAN_DEV=1.
   */
  dev?: boolean
  bridgePort?: number
  presenceMs?: number
}

export type ForemanHandle = {
  /** null while the foreman is not set up. */
  runtime: ForemanRuntime | null
  status: ForemanStatus
  /** What a terminal needs in its environment to be an agent of this yard. */
  terminalEnv(agentId: string): Record<string, string>
  /** The Dispatcher sent a lifecycle event: an offer, or a verify, cancel or expire. */
  fromDispatcher(ev: LifecycleEvent, ctx?: { requester?: string; preferAgent?: string }): void
  stop(): Promise<void>
}

export async function startHawlForeman(o: StartOptions): Promise<ForemanHandle> {
  const clock = o.clock ?? { now: Date.now }
  const identityPath = join(o.userDataDir, 'hawl', 'foreman-identity.json')
  const found = o.identity !== undefined ? o.identity : readIdentity(identityPath)
  const offHandlers: (() => void)[] = []
  const handle = (channel: string, fn: (...a: unknown[]) => unknown): void => {
    o.ipc.handle(channel, (event, ...args) => {
      if (!o.trusted(event)) {
        throw new Error(`${channel} is for the app window only`)
      }
      return fn(...args)
    })
    offHandlers.push(() => o.ipc.removeHandler(channel))
  }

  if (found === null || typeof found === 'string') {
    const status: ForemanStatus = { configured: false, reason: found }
    handle(STATUS_CHANNEL, () => status)
    return {
      runtime: null,
      status,
      terminalEnv: () => ({}),
      fromDispatcher: () => undefined,
      stop: async () => {
        offHandlers.forEach((off) => off())
      }
    }
  }

  const id = found
  const lastLogged = new Map<string, number>()
  let changedTimer: ReturnType<typeof setTimeout> | null = null
  const changed = (): void => {
    // Many changes in one breath make one refresh.
    changedTimer ??= setTimeout(() => {
      changedTimer = null
      o.emit(CHANGED_CHANNEL)
    }, 50)
  }
  const hub = new AgentHub({ onEvent: (e: AgentEvent) => o.emit(AGENT_EVENT_CHANNEL, e) })
  const signedOut = (): never => {
    throw new Error('not signed in to Hawl yet')
  }
  const foreman = new Foreman(
    {
      yard: id.yard,
      owner: id.owner,
      displayName: id.displayName,
      visibility: id.visibility,
      directLines: id.directLines,
      timeZone: id.timeZone
    },
    {
      clock,
      agents: hub.port,
      transport: createRelayTransport(
        { request: async (m, p, op) => (o.relay?.() ?? signedOut()).request(m, p, op) },
        { yardId: id.yardId, siteId: id.siteId },
        {
          owner: (n) => {
            o.emit(NOTICE_CHANNEL, n)
            o.osNotify?.(n)
          }
        }
      )
    }
  )
  const runtime = new ForemanRuntime({
    foreman,
    clock,
    storage: fileStorage(join(o.userDataDir, 'hawl', 'foreman.json')),
    onChanged: changed,
    onError: (err, where) => {
      // A relay that is down fails every second; say so once a minute, not every time.
      const key = where ?? 'error'
      const at = clock.now()
      if (at - (lastLogged.get(key) ?? 0) > 60_000) {
        lastLogged.set(key, at)
        console.warn(`[hawl-foreman] ${key}:`, err instanceof Error ? err.message : err)
      }
    }
  })
  runtime.start()
  const bridge = new AgentBridge({ rt: runtime, hub, presenceMs: o.presenceMs })
  const port = await bridge.listen(o.bridgePort ?? 0)
  const bridgeUrl = `http://127.0.0.1:${port}`
  const status: ForemanStatus = {
    configured: true,
    yard: id.yard,
    displayName: id.displayName,
    bridgeUrl
  }
  handle(STATUS_CHANNEL, () => status)
  offHandlers.push(registerForemanIpc(o.ipc, runtime, { trusted: o.trusted }))

  const fromDispatcher: ForemanHandle['fromDispatcher'] = (ev, ctx = {}) => {
    runtime.run((f) =>
      ev.event === 'offer'
        ? f.intake({ offer: ev, requester: ctx.requester ?? 'site', preferAgent: ctx.preferAgent })
        : f.onLifecycle(ev)
    )
  }
  if (o.dev) {
    handle(DEV_OFFER_CHANNEL, (taskId, capability, requester) => {
      fromDispatcher(
        {
          yard: id.yard,
          task_id: String(taskId),
          event: 'offer',
          at: new Date(clock.now()).toISOString(),
          ...(capability ? { capability: String(capability) } : {}),
          acceptance: ['The change is tested', 'The change is described in one line']
        },
        { requester: typeof requester === 'string' ? requester : 'site' }
      )
    })
  }

  return {
    runtime,
    status,
    terminalEnv: (agentId) => ({
      HAWL_FOREMAN_URL: bridgeUrl,
      HAWL_FOREMAN_TOKEN: bridge.token,
      HAWL_AGENT_ID: agentId
    }),
    fromDispatcher,
    stop: async () => {
      if (changedTimer) {
        clearTimeout(changedTimer)
      }
      await bridge.close()
      runtime.stop()
      offHandlers.forEach((off) => off())
    }
  }
}
