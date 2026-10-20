// What the foreman tells its inner agents, kept until each agent fetches it. This is the foreman's AgentPort:
// nothing is typed into a terminal. The HTTP door that agents fetch from is agent-bridge.ts.
import type { AgentOffer, AgentPort, AgentRevoke } from './types'

export type AgentEvent =
  | ({ type: 'offer'; seq: number; agentId: string } & AgentOffer)
  | ({ type: 'revoke'; seq: number; agentId: string } & AgentRevoke)

type Waiter = (events: AgentEvent[]) => void

export class AgentHub {
  readonly #events = new Map<string, AgentEvent[]>()
  readonly #seq = new Map<string, number>()
  readonly #waiters = new Map<string, Set<Waiter>>()
  readonly #keep: number
  readonly #onEvent?: (e: AgentEvent) => void

  /** `keep` events are held per agent for a late poll; `onEvent` sees every event (the app's terminal strip). */
  constructor(opts: { keep?: number; onEvent?: (e: AgentEvent) => void } = {}) {
    this.#keep = opts.keep ?? 200
    this.#onEvent = opts.onEvent
  }

  /** Hand this to the Foreman as `deps.agents`. */
  readonly port: AgentPort = {
    offer: (agentId, offer) => this.#push({ type: 'offer', agentId, seq: 0, ...offer }),
    revoke: (agentId, revoke) => this.#push({ type: 'revoke', agentId, seq: 0, ...revoke })
  }

  #push(e: AgentEvent): void {
    const seq = (this.#seq.get(e.agentId) ?? 0) + 1
    this.#seq.set(e.agentId, seq)
    const ev = { ...e, seq } as AgentEvent
    const list = this.#events.get(e.agentId) ?? []
    list.push(ev)
    while (list.length > this.#keep) {
      list.shift()
    }
    this.#events.set(e.agentId, list)
    for (const w of this.#waiters.get(e.agentId) ?? []) {
      w([ev])
    }
    this.#onEvent?.(ev)
  }

  seq(agentId: string): number {
    return this.#seq.get(agentId) ?? 0
  }

  /** Events after `after`; with `waitMs` it waits for one. */
  async fetch(agentId: string, after: number, waitMs: number): Promise<AgentEvent[]> {
    const now = (): AgentEvent[] => (this.#events.get(agentId) ?? []).filter((e) => e.seq > after)
    const have = now()
    if (have.length > 0 || waitMs <= 0) {
      return have
    }
    return new Promise<AgentEvent[]>((ok) => {
      const set = this.#waiters.get(agentId) ?? new Set<Waiter>()
      this.#waiters.set(agentId, set)
      const done: Waiter = (evs) => {
        clearTimeout(timer)
        set.delete(done)
        ok(evs)
      }
      const timer = setTimeout(() => done([]), waitMs)
      set.add(done)
    })
  }

  /** Release everyone waiting (the app is closing). */
  closeAll(): void {
    for (const set of this.#waiters.values()) {
      for (const w of set) {
        w([])
      }
    }
  }
}
