// Events that close or return a job, owner decline and reroute with history (S18, S20, S35).
import {
  checkContract,
  nextTaskState,
  type LifecycleEvent
} from '../../shared/gateway-contract/contract'
import { declineAsked } from './intake'
import type { ForemanCtx } from './state'
import { ForemanError } from './types'
import type { ForemanRule } from './types'

/** Verify, cancel and expire events from the Dispatcher. */
export function onLifecycle(c: ForemanCtx, ev: LifecycleEvent): void {
  const err = checkContract('lifecycle', ev)
  if (err) {
    throw new ForemanError('bad_event', err)
  }
  if (ev.yard !== c.cfg.yard) {
    throw new ForemanError('wrong_yard', `not ${c.cfg.yard}`)
  }
  const job = c.need(ev.task_id)
  const next = nextTaskState(job.state, ev.event, ev.result)
  if (!next) {
    throw new ForemanError('bad_state', `${ev.event} not allowed from ${job.state}`)
  }
  if (ev.event === 'verify' && ev.result === 'reject') {
    // Back to the agent that did it; the third send-back goes to a person.
    job.state = next
    job.sendBacks++
    job.exec = 'queued'
    job.tried = []
    const last = job.claims.findLast((cl) => cl.state === 'finished')
    if (last) {
      job.preferAgent = last.agentId
    }
    c.history(job, 'send_back', 'dispatcher', ev.reason ?? null)
    if (job.sendBacks >= c.cfg.maxSendBacks) {
      job.needsHuman = true
      c.deps.transport.notifyOwner({ kind: 'needs_human', taskId: job.taskId })
    } else {
      c.schedule('delegate', job.taskId, '', c.now())
    }
  } else if (ev.event === 'verify' || ev.event === 'cancel' || ev.event === 'expire') {
    job.state = next
    c.finish(job, ev.event === 'verify' ? 'verified' : (ev.reason ?? ev.event))
  } else {
    throw new ForemanError('bad_event', `${ev.event} is not an inbound event`)
  }
}

/** The yard owner gives a job back. History is kept. */
export function decline(c: ForemanCtx, taskId: string, by: string, reason: string): void {
  const job = c.need(taskId)
  if (job.state === 'asked') {
    c.drop('held_expire', taskId)
    declineAsked(c, job, reason, by)
  } else if (job.state === 'accepted') {
    c.history(job, 'decline', by, reason)
    c.revokeLive(job, 'job_closed')
    // The contract has no "accepted back to asked" move, so the job leaves as a cancel
    // whose reason says why; the Dispatcher reads the prefix and reroutes.
    c.emit(job, 'cancel', { reason: `declined: ${reason}`.slice(0, 500) })
    c.finish(job, `declined: ${reason}`)
  } else {
    throw new ForemanError('bad_state', `cannot decline from ${job.state}`)
  }
}

export function addRule(
  c: ForemanCtx,
  match: ForemanRule['match'],
  action: ForemanRule['action'],
  source: ForemanRule['source'] = 'owner'
): string {
  const id = `rule_${++c.ids}`
  const clean = Object.fromEntries(Object.entries(match).filter(([, v]) => v !== undefined))
  c.rules.push({ id, match: clean, action: { ...action }, source })
  return id
}

/**
 * Move a job to another inner agent. The old claim is revoked first. A job rerouted
 * maxReroutes times goes to a person and is no longer offered. With makeRule the next
 * matching job goes to that agent.
 */
export function reroute(
  c: ForemanCtx,
  taskId: string,
  opts: { toAgent: string; by: string; reason?: string; makeRule?: boolean }
): void {
  const job = c.need(taskId)
  if (job.state !== 'accepted' || job.exec === null || job.exec === 'held') {
    throw new ForemanError('bad_state', 'only an accepted job can be rerouted')
  }
  const old = c.liveClaim(job)
  if (old) {
    c.revokeClaim(job, old, 'rerouted')
  }
  job.reroutes++
  job.exec = 'queued'
  c.history(job, 'reroute', opts.by, opts.reason ?? null, old?.agentId ?? null, opts.toAgent)
  if (opts.makeRule) {
    addRule(
      c,
      { capability: job.capability ?? undefined, fromYard: job.requester },
      { agentId: opts.toAgent },
      'correction'
    )
  }
  if (job.reroutes >= c.cfg.maxReroutes) {
    job.needsHuman = true
    c.deps.transport.notifyOwner({ kind: 'needs_human', taskId: job.taskId })
  } else {
    job.preferAgent = opts.toAgent
    job.tried = job.tried.filter((id) => id !== opts.toAgent)
    c.schedule('delegate', job.taskId, '', c.now())
  }
}
