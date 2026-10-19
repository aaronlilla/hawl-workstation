// The outbox: every effect that must reach the Dispatcher or the owner waits here, in order, until the
// other side has it.
//
// A state change and its effect are one step: the change is made, the effect is queued, and only then is
// it sent, after the snapshot holding both has been saved (write-ahead). So a relay that is down, a thrown
// error or a crash leaves the foreman in a state it can explain: the job moved, and the effect is waiting.
// Delivery is at-least-once; the receiving side ignores a repeat (S21).
import type { DeadEffect, Effect, ForemanHooks, ForemanTransport, OutboxItem } from './types'

const MAX_DEAD = 100
const MAX_RETRY_WAIT_MS = 60_000

const isThenable = (v: unknown): v is Promise<void> =>
  typeof (v as { then?: unknown } | null | undefined)?.then === 'function'

/** Hand one effect to the matching transport method. */
export function deliver(t: ForemanTransport, e: Effect): void | Promise<void> {
  switch (e.kind) {
    case 'menu':
      return t.sendMenu(e.menu, e.revision, e.extended)
    case 'lifecycle':
      return t.sendLifecycle(e.ev)
    case 'owner':
      return t.notifyOwner(e.notice)
    case 'requester':
      return t.notifyRequester(e.notice)
    case 'handBack':
      return t.handBack(e.back)
  }
}

export type OutboxEnv = {
  now(): number
  maxAgeMs(): number
  hooks(): ForemanHooks
  deliver(e: Effect): void | Promise<void>
}

export class Outbox {
  readonly items: OutboxItem[] = []
  /** Effects that were dropped, newest last. */
  readonly dead: DeadEffect[] = []
  seq = 0
  /** Highest item id that is known to be in the saved snapshot. */
  savedUpTo = 0
  inflightId: number | null = null
  #flushing = false
  readonly #env: OutboxEnv

  constructor(env: OutboxEnv) {
    this.#env = env
  }

  /** Record an effect. It is sent by flush(), after the state change that caused it is saved. */
  queue(effect: Effect): void {
    if (effect.kind === 'menu') {
      // A newer menu replaces an older one that has not gone out yet.
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i]
        if (it.effect.kind === 'menu' && it.id !== this.inflightId) {
          this.items.splice(i, 1)
        }
      }
    }
    const at = this.#env.now()
    this.items.push({ id: ++this.seq, effect, at, attempts: 0, retryAt: at, lastError: null })
  }

  /** The earliest time the outbox wants another go, or Infinity. */
  dueAt(): number {
    const head = this.items[0]
    return head && this.inflightId !== head.id ? head.retryAt : Infinity
  }

  /** Put back what a snapshot held. Everything restored is already on disk; the first try is at once. */
  load(items: OutboxItem[], seq: number, dead: DeadEffect[]): void {
    const now = this.#env.now()
    this.items.length = 0
    for (const it of items) {
      this.items.push({ ...it, retryAt: Math.min(it.retryAt, now) })
    }
    this.seq = Math.max(seq, ...items.map((it) => it.id), 0)
    this.savedUpTo = this.seq
    this.inflightId = null
    this.dead.length = 0
    this.dead.push(...dead)
  }

  #drop(item: OutboxItem, reason: string): void {
    const at = this.items.findIndex((x) => x.id === item.id)
    if (at !== -1) {
      this.items.splice(at, 1)
    }
    const e = item.effect
    const ref =
      e.kind === 'lifecycle'
        ? e.ev.task_id
        : e.kind === 'handBack'
          ? e.back.taskId
          : e.kind === 'menu'
            ? `menu ${e.revision}`
            : e.notice.taskId
    this.dead.push({ at: this.#env.now(), kind: e.kind, ref, reason })
    while (this.dead.length > MAX_DEAD) {
      this.dead.shift()
    }
  }

  #fail(item: OutboxItem, err: unknown): void {
    item.attempts++
    item.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200)
    this.#env.hooks().onError?.(err, `deliver ${item.effect.kind}`)
    if ((err as { permanent?: boolean } | null)?.permanent === true) {
      this.#drop(item, item.lastError)
      return
    }
    const wait = Math.min(MAX_RETRY_WAIT_MS, 1000 * 2 ** Math.min(item.attempts - 1, 10))
    item.retryAt = this.#env.now() + wait
  }

  /**
   * Send queued effects in order. The snapshot is saved first (write-ahead), so a crash after a send still
   * knows what was sent; a failed try waits and goes again, and nothing behind it passes.
   */
  flush(): void {
    if (this.#flushing) {
      return
    }
    this.#flushing = true
    try {
      for (;;) {
        const head = this.items[0]
        if (!head || this.inflightId === head.id) {
          return
        }
        const now = this.#env.now()
        if (head.retryAt > now) {
          return
        }
        if (now - head.at > this.#env.maxAgeMs()) {
          this.#drop(head, 'too old to deliver')
          continue
        }
        if (head.id > this.savedUpTo) {
          try {
            this.#env.hooks().persist?.()
          } catch (err) {
            // Never send what is not written down. Try again shortly.
            this.#env.hooks().onError?.(err, 'save before send')
            head.retryAt = now + 1000
            return
          }
          this.savedUpTo = this.seq
        }
        let r: void | Promise<void>
        try {
          r = this.#env.deliver(head.effect)
        } catch (err) {
          const before = this.items.length
          this.#fail(head, err)
          if (this.items.length < before) {
            continue
          }
          return
        }
        if (isThenable(r)) {
          this.#await(head, r)
          return
        }
        this.items.shift()
      }
    } finally {
      this.#flushing = false
    }
  }

  #await(head: OutboxItem, r: Promise<void>): void {
    this.inflightId = head.id
    r.then(
      () => {
        this.inflightId = null
        const at = this.items.findIndex((x) => x.id === head.id)
        if (at !== -1) {
          this.items.splice(at, 1)
        }
        this.flush()
        this.#env.hooks().onChange?.()
      },
      (err: unknown) => {
        this.inflightId = null
        this.#fail(head, err)
        // A refused-for-good effect is gone: whatever waited behind it goes now.
        this.flush()
        this.#env.hooks().onChange?.()
      }
    )
  }
}
