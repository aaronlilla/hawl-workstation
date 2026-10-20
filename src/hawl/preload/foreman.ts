// What the app window may use of the foreman: one function per IPC channel, plus change events.
// Exposed as `window.hawl.foreman` by the single preload hook line. Imports only Electron's renderer side.
import { ipcRenderer } from 'electron'

const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(`hawl:foreman:${channel}`, ...args)

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => cb(payload)
  ipcRenderer.on(`hawl:foreman:${channel}`, listener)
  return () => {
    ipcRenderer.removeListener(`hawl:foreman:${channel}`, listener)
  }
}

export const hawlForemanApi = {
  status: () => call('status'),
  jobs: () => call('jobs'),
  agents: () => call('agents'),
  settings: () => call('settings'),
  menu: () => call('menu'),
  rules: () => call('rules'),
  cards: () => call('cards'),
  heartbeat: () => call('heartbeat'),
  outbox: () => call('outbox'),
  ownerDecision: (id: string, decision: 'accept' | 'decline', reason?: string) =>
    call('owner-decision', id, decision, reason),
  decline: (id: string, reason: string) => call('decline', id, reason),
  reroute: (id: string, toAgent: string, reason?: string, makeRule?: boolean) =>
    call('reroute', id, toAgent, reason, makeRule),
  resumeJob: (id: string, reason?: string) => call('resume-job', id, reason),
  decideLine: (id: string, approve: boolean, reason?: string) =>
    call('decide-line', id, approve, reason),
  pause: () => call('pause'),
  resume: () => call('resume'),
  setAutoAccept: (value: boolean) => call('set-auto-accept', value),
  setTimes: (holdMs?: number, releaseMs?: number) => call('set-times', holdMs, releaseMs),
  setMenu: (caps: unknown[]) => call('set-menu', caps),
  publishMenu: () => call('publish-menu'),
  addRule: (match: { capability?: string; fromYard?: string }, agentId: string) =>
    call('add-rule', match, agentId),
  removeRule: (id: string) => call('remove-rule', id),
  /** Only present when the app runs with HAWL_FOREMAN_DEV=1. */
  devOffer: (taskId: string, capability?: string, requester?: string) =>
    call('dev-offer', taskId, capability, requester),
  onChanged: (cb: () => void) => on('changed', () => cb()),
  onNotice: (cb: (n: unknown) => void) => on('notice', cb),
  onAgentEvent: (cb: (e: unknown) => void) => on('agent-event', cb)
}

export type HawlForemanApi = typeof hawlForemanApi
