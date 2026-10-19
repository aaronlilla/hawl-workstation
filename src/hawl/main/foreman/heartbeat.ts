// Gateway-contract heartbeat (S48): counts only, agents listed only at visibility full.
import type { Heartbeat } from '../../shared/gateway-contract/contract'
import { checkContract } from '../../shared/gateway-contract/contract'
import { iso, type ForemanCtx } from './state'
import { ForemanError } from './types'
import { busyAgentIds } from './views'

export function buildBeat(c: ForemanCtx): Heartbeat {
  const jobs = [...c.jobs.values()]
  const busyIds = new Set(busyAgentIds(c))
  const online = [...c.agents.values()].filter((a) => a.online && !a.away)
  const busy = online.filter((a) => busyIds.has(a.id)).length
  const idle = online.length - busy
  const queued = jobs.filter(
    (j) => j.state === 'accepted' && (j.exec === 'queued' || j.exec === 'offered')
  ).length
  const waitingLines = jobs.filter((j) => j.line?.state === 'requested' && j.line.localOk === null)
  // A job nobody in the yard would take also waits for the owner.
  const unclaimed = (j: (typeof jobs)[number]): boolean =>
    j.state === 'accepted' && j.exec === 'queued' && j.exhaustedNotified
  const needsHuman =
    jobs.filter((j) => j.exec === 'held' || j.needsHuman || unclaimed(j)).length +
    waitingLines.length
  let state: Heartbeat['state'] = 'online'
  if (c.paused) {
    state = 'paused'
  } else if (online.length === 0) {
    // The foreman is up but nothing can run: the yard is offline for work.
    state = 'offline'
  } else if (idle === 0) {
    state = 'busy'
  }
  const hb: Heartbeat = {
    yard: c.cfg.yard,
    state,
    load: { active_tasks: jobs.filter((j) => j.exec === 'running').length, queued },
    workers: { busy, idle },
    needs_human: needsHuman,
    as_of: iso(c.now())
  }
  if (c.cfg.visibility === 'full') {
    hb.agents = [...c.agents.values()]
      .filter((a) => a.online)
      .map((a) => ({ id: a.id, status: busyIds.has(a.id) ? ('busy' as const) : ('idle' as const) }))
  }
  return hb
}

/** Send a heartbeat when the picture changed or 30 s passed since the last one. */
export function beatIfDue(c: ForemanCtx): void {
  const now = c.now()
  const hb = buildBeat(c)
  const { as_of: _asOf, ...rest } = hb
  const sig = JSON.stringify(rest)
  if (c.lastBeatAt !== null && sig === c.lastBeatSig && now - c.lastBeatAt < c.cfg.heartbeatMs) {
    return
  }
  const err = checkContract('heartbeat', hb)
  if (err) {
    throw new ForemanError('bad_event', `heartbeat: ${err}`)
  }
  c.lastBeatAt = now
  c.lastBeatSig = sig
  c.deps.transport.sendHeartbeat(hb)
}
