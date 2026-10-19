// Once-per-run bookkeeping for deliveries. Unacked rows come again after a reconnect; each is handed
// over once. Key: the inbox seq, or (no seq) the relay's signature, which is unique per delivery.
import { seqOf } from './agent-socket-types'

type Env = Record<string, unknown> | undefined

function keyOf(env: Env): number | string | null {
  const seq = seqOf(env)
  if (seq !== null) {
    return seq
  }
  const s = ((env?.relay_sig ?? {}) as { sig?: unknown }).sig
  return typeof s === 'string' ? `sig:${s}` : null
}

/** Drops that say "not yet", not "never": the delivery is asked for again. */
export const RETRYABLE = new Set(['manifest_unusable', 'relay_key_unknown', 'sender_key_unavailable'])

export class DeliverySeen {
  readonly #keys = new Set<number | string>()

  /** False when this delivery was already handed over in this run. */
  take(env: Env): boolean {
    const k = keyOf(env)
    if (k === null) {
      return true
    }
    if (this.#keys.has(k)) {
      return false
    }
    this.#keys.add(k)
    if (this.#keys.size > 5000) {
      this.#keys.delete(this.#keys.values().next().value as number | string)
    }
    return true
  }

  /** Let a later push of the same delivery through again. */
  release(env: Env): void {
    const k = keyOf(env)
    if (k !== null) {
      this.#keys.delete(k)
    }
  }
}

/** Asks again for a delivery whose check hit a passing failure: a few tries, a growing wait. */
export class DeliveryRetry {
  readonly #tries = new Map<number, number>()
  readonly #timers = new Set<NodeJS.Timeout>()

  schedule(seq: number, baseMs: number, again: () => void): void {
    const n = this.#tries.get(seq) ?? 0
    if (n >= 5) {
      this.#tries.delete(seq)
      return
    }
    this.#tries.set(seq, n + 1)
    const t = setTimeout(() => {
      this.#timers.delete(t)
      again()
    }, Math.min(baseMs * 2 ** n, 30_000))
    t.unref?.()
    this.#timers.add(t)
  }

  done(seq: number): void {
    this.#tries.delete(seq)
  }

  clear(): void {
    for (const t of this.#timers) {
      clearTimeout(t)
    }
    this.#timers.clear()
  }
}
