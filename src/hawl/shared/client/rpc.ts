// Request and answer matching for frames that carry an `id` (tool.call and its tool.result).
import { HawlApiError } from './core'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class Rpc {
  #seq = 0
  readonly #pending = new Map<string, Pending>()

  /** Send via `send(id)`; resolves with the answer, rejects on error, timeout or a dead socket. */
  call(send: (id: string) => boolean, timeoutMs: number): Promise<unknown> {
    const id = `r${++this.#seq}`
    return new Promise((resolve, reject) => {
      if (!send(id)) {
        reject(new HawlApiError(0, 'not_connected', 'The relay socket is not connected.'))
        return
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new HawlApiError(0, 'timeout', 'The relay did not answer in time.'))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
    })
  }

  /** Reject everything waiting (socket closed or stopped). */
  failAll(why: string): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(new HawlApiError(0, 'not_connected', why))
      this.#pending.delete(id)
    }
  }

  /** Match a `tool.result` or `error` frame to its call. False when no call is waiting for it. */
  answer(f: Record<string, unknown>): boolean {
    const id = typeof f.id === 'string' ? f.id : typeof f.ref === 'string' ? f.ref : undefined
    const p = id ? this.#pending.get(id) : undefined
    if (!id || !p) {
      return false
    }
    this.#pending.delete(id)
    clearTimeout(p.timer)
    const err = f.error as
      | { code?: string; message?: string; retry_after?: number | null }
      | undefined
    if (err) {
      p.reject(
        new HawlApiError(0, err.code ?? 'relay_error', err.message ?? 'Relay error.', {
          retryAfter: err.retry_after ?? null
        })
      )
    } else {
      p.resolve(f.result)
    }
    return true
  }
}
