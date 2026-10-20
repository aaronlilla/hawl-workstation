// Events that close or return a job, owner decline and reroute with history (S18, S20, S35).
import {
  checkContract,
  nextTaskState,
  type LifecycleEvent
} from '../../shared/gateway-contract/contract'
import { declineAsked } from './intake'
import type { ForemanCtx } from './state'
import { ForemanError } from './types'
import type { ForemanRule, Job } from './types'

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
    job.exhaustedNotified = false
    c.restartWait(job)
    const last = job.claims.findLast((cl) => cl.state === 'finished')
    if (last) {
      job.pinAgent = last.agentId
    }
    c.history(job, 'send_back', 'dispatcher', ev.reason ?? null)
    if (job.sendBacks >= c.cfg.maxSendBacks) {
      // S35: the third send-back stops the job and goes to the requester, not the yard owner.
      job.needsHuman = true
      c.notifyRequester({
        kind: 'send_back_limit',
        taskId: job.taskId,
        requester: job.requester
      })
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
  const job = c.needLocal(taskId)
  if (job.state === 'asked') {
    c.drop('held_expire', taskId)
    declineAsked(c, job, reason, by)
  } else if (job.state === 'accepted') {
    c.history(job, 'decline', by, reason)
    // S20: the job goes back to the Dispatcher to be routed again; it is not cancelled.
    c.handBack(job, 'decline', reason)
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
  const clean = Object.fromEntries(
    Object.entries(match).filter(([, v]) => v !== undefined)
  ) as ForemanRule['match']
  if (Object.keys(clean).length === 0) {
    throw new ForemanError('bad_rule', 'a rule needs a capability or a requester to match')
  }
  // One rule per match: saving a second correction replaces the first.
  const same = (r: ForemanRule): boolean =>
    r.match.capability === clean.capability && r.match.fromYard === clean.fromYard
  const at = c.rules.findIndex(same)
  if (at !== -1) {
    c.rules.splice(at, 1)
  }
  const id = `rule_${++c.ids}`
  c.rules.push({ id, match: clean, action: { ...action }, source })
  return id
}

/** Delete a rule. The jobs it routed keep their history. */
export function removeRule(c: ForemanCtx, id: string): void {
  const at = c.rules.findIndex((r) => r.id === id)
  if (at === -1) {
    throw new ForemanError('bad_rule', `no rule ${id}`)
  }
  c.rules.splice(at, 1)
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
  const job = c.needLocal(taskId)
  if (job.state !== 'accepted' || job.exec === null || job.exec === 'held') {
    throw new ForemanError('bad_state', 'only an accepted job can be rerouted')
  }
  if (opts.makeRule && !job.capability) {
    throw new ForemanError('bad_rule', 'a job with no capability cannot become a rule')
  }
  if (job.needsHuman) {
    // A person is acting on a stopped job: that is the answer it was waiting for.
    clearStop(job)
  }
  const old = c.liveClaim(job)
  if (old) {
    c.revokeClaim(job, old, 'rerouted')
    if (old.state === 'revoked' && old.leaseExpiresAt !== null) {
      c.restartWait(job)
    }
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
    c.notifyOwner({ kind: 'needs_human', taskId: job.taskId })
  } else {
    job.pinAgent = opts.toAgent
    job.tried = job.tried.filter((id) => id !== opts.toAgent)
    if (job.tried.length >= c.cfg.maxAgentsPerJob) {
      // The owner picked an agent on purpose: give the job a fresh round of tries.
      job.tried = []
      job.exhaustedNotified = false
    }
    c.schedule('delegate', job.taskId, '', c.now())
  }
}

/** Forget what stopped the job: counters, tried agents and the "nobody took it" notice. */
function clearStop(job: Job): void {
  job.needsHuman = false
  job.reroutes = 0
  job.sendBacks = 0
  job.tried = []
  job.exhaustedNotified = false
}

/** A person looked at a stopped job (needs a person, or nobody in the yard took it) and wants it tried again as it is. */
export function resolveNeedsHuman(
  c: ForemanCtx,
  taskId: string,
  by: string,
  reason?: string
): void {
  const job = c.need(taskId)
  if ((!job.needsHuman && !job.exhaustedNotified) || job.state !== 'accepted') {
    throw new ForemanError('bad_state', 'job is not waiting for a person')
  }
  clearStop(job)
  c.history(job, 'resume', by, reason ?? null)
  c.schedule('delegate', taskId, '', c.now())
}
