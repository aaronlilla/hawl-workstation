// Test rig: fake clock, recording transport and agent port. Test support only.
import type { Heartbeat, LifecycleEvent, Menu } from '../../shared/gateway-contract/contract'
import { Foreman } from './foreman'
import type { ExtendedMenu } from './menu'
import { ForemanError, HOUR_MS, MINUTE_MS } from './types'
import type {
  AgentOffer,
  AgentRevoke,
  CapabilityConfig,
  ForemanConfig,
  HandBack,
  IntakeResult,
  OwnerNotice,
  RequesterNotice
} from './types'
import { ReferenceGateway } from './reference-gateway.test-support'

export const T0 = Date.parse('2026-10-19T08:00:00.000Z')
export const SHA = 'a'.repeat(40)
export { HOUR_MS, MINUTE_MS }

export const CAPS: CapabilityConfig[] = [
  { id: 'fix-bug', description: 'Fix a bug with a test', typical_minutes: 30 },
  { id: 'review-pr', description: 'Review a pull request', typical_minutes: 15 },
  { id: 'audit', description: 'Security audit', approval: 'ask_owner' },
  { id: 'night-shift', description: 'Only when someone is online', acceptWhenOffline: false },
  { id: 'closed-cap', description: 'Not taking this', open: false }
]

type Wire = { dir: 'in' | 'out'; ev: LifecycleEvent } | { dir: 'handback'; taskId: string }

export type Rig = ReturnType<typeof makeRig>

export function makeRig(cfg: Partial<ForemanConfig> = {}, caps: CapabilityConfig[] = CAPS) {
  let t = T0
  const clock = { now: () => t }
  /** Every effect in the order it happened, for ordering proofs. */
  const calls: string[] = []
  const wire: Wire[] = []
  const menus: { menu: Menu; revision: number; extended: ExtendedMenu }[] = []
  const handBacks: HandBack[] = []
  const requesterNotices: RequesterNotice[] = []
  const beats: Heartbeat[] = []
  const notices: OwnerNotice[] = []
  const offers: { agentId: string; offer: AgentOffer }[] = []
  const revokes: { agentId: string; revoke: AgentRevoke }[] = []
  /** Make the next N calls of a transport method throw, to prove nothing is left half done. */
  const faults = { sendMenu: 0, sendHeartbeat: 0, sendLifecycle: 0, notifyOwner: 0, handBack: 0, offer: 0 }
  let permanent = false
  const boom = (k: keyof typeof faults): void => {
    if (faults[k] > 0) {
      faults[k]--
      throw Object.assign(new Error(`relay down (${k})`), { permanent })
    }
  }

  const foreman = new Foreman(
    { yard: 'acme-dev', owner: 'usr_aaron', displayName: "Aaron's yard", ...cfg },
    {
      clock,
      transport: {
        sendMenu: (menu, revision, extended) => {
          boom('sendMenu')
          calls.push(`menu:${revision}`)
          menus.push({ menu, revision, extended })
        },
        handBack: (back) => {
          boom('handBack')
          calls.push(`handback:${back.op}:${back.taskId}`)
          handBacks.push(back)
          wire.push({ dir: 'handback', taskId: back.taskId })
        },
        notifyRequester: (n) => {
          calls.push(`notify-requester:${n.kind}:${n.taskId}`)
          requesterNotices.push(n)
        },
        sendHeartbeat: (hb) => {
          boom('sendHeartbeat')
          calls.push(`beat:${hb.state}`)
          beats.push(hb)
        },
        sendLifecycle: (ev) => {
          boom('sendLifecycle')
          calls.push(`out:${ev.event}:${ev.task_id}`)
          wire.push({ dir: 'out', ev })
        },
        notifyOwner: (n) => {
          boom('notifyOwner')
          calls.push(`notify:${n.kind}:${n.taskId}`)
          notices.push(n)
        }
      },
      agents: {
        offer: (agentId, offer) => {
          boom('offer')
          calls.push(`offer:${agentId}:${offer.taskId}:e${offer.epoch}`)
          offers.push({ agentId, offer })
        },
        revoke: (agentId, revoke) => {
          calls.push(`revoke:${agentId}:${revoke.taskId}:e${revoke.epoch}`)
          revokes.push({ agentId, revoke })
        }
      }
    }
  )
  foreman.setCapabilities(caps)

  const at = (ms: number): string => new Date(ms).toISOString()

  const rig = {
    foreman,
    faults,
    /** true: the injected faults say "refused for good" instead of "try again". */
    permanent(on: boolean): void {
      permanent = on
    },
    calls,
    wire,
    menus,
    beats,
    notices,
    handBacks,
    requesterNotices,
    offers,
    revokes,
    now: () => t,
    /** Move the fake clock and run what became due. */
    adv(ms: number): void {
      t += ms
      foreman.tick()
    },
    /** Move the clock without running anything, so the next call must catch up on its own. */
    skip(ms: number): void {
      t += ms
    },
    publish() {
      return foreman.publishMenu()
    },
    /** Replace the draft menu (not published until publish()). */
    setCaps(next: CapabilityConfig[]): void {
      foreman.setCapabilities(next)
    },
    offerEvent(
      taskId: string,
      capability: string | null = 'fix-bug',
      extra: Partial<LifecycleEvent> = {}
    ): LifecycleEvent {
      return {
        yard: 'acme-dev',
        task_id: taskId,
        event: 'offer',
        at: at(t),
        ...(capability ? { capability } : {}),
        acceptance: ['tests pass'],
        ...extra
      }
    },
    /** Offer a job as the Dispatcher would. */
    send(
      taskId: string,
      capability: string | null = 'fix-bug',
      requester = 'site',
      opts: { preferAgent?: string; extra?: Partial<LifecycleEvent> } = {}
    ): IntakeResult {
      const offer = rig.offerEvent(taskId, capability, opts.extra)
      wire.push({ dir: 'in', ev: offer })
      return foreman.intake({ offer, requester, preferAgent: opts.preferAgent })
    },
    inbound(ev: Omit<LifecycleEvent, 'yard' | 'at'> & { at?: string }): void {
      const full = { yard: 'acme-dev', at: at(t), ...ev } as LifecycleEvent
      wire.push({ dir: 'in', ev: full })
      foreman.onLifecycle(full)
    },
    verify(taskId: string, result: 'pass' | 'reject' = 'pass'): void {
      rig.inbound({ task_id: taskId, event: 'verify', revision_sha: SHA, result })
    },
    done(taskId: string, agentId: string, epoch: number) {
      return foreman.agentDone(taskId, agentId, epoch, {
        revisionSha: SHA,
        evidence: [{ kind: 'sha', ref: SHA }]
      })
    },
    /** Offer to agent a1, accept it, return the epoch. */
    claim(taskId: string, agentId: string): number {
      const o = offers.toReversed().find((x) => x.agentId === agentId && x.offer.taskId === taskId)
      if (!o) {
        throw new Error(`no offer for ${agentId} on ${taskId}`)
      }
      foreman.agentAccept(taskId, agentId, o.offer.epoch)
      return o.offer.epoch
    },
    events(name?: string): LifecycleEvent[] {
      return wire.flatMap((w) => (w.dir === 'out' && (!name || w.ev.event === name) ? [w.ev] : []))
    },
    /** Replay everything on the wire through the contract's reference gateway. Throws when illegal. */
    conforms(): void {
      const gw = new ReferenceGateway(menus.at(-1)?.menu)
      for (const w of wire) {
        if (w.dir === 'handback') {
          gw.handedBack(w.taskId)
        } else {
          gw.apply(w.ev)
        }
      }
    }
  }
  return rig
}

export const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof ForemanError ? e.code : `other:${String(e)}`
  }
  return undefined
}

export function ready(cfg: Parameters<typeof makeRig>[0] = {}, agents: string[] = []): Rig {
  const rig = makeRig(cfg)
  rig.publish()
  for (const a of agents) {
    rig.foreman.agentUp(a)
  }
  return rig
}
