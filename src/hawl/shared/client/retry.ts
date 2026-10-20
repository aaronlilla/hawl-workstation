// One retry rule for the token calls (agent token exchange, web token mint): a relay blip, a rate
// limit or a dropped connection must not fail every call that needs a token.
import { HawlApiError, realSleep, type Sleep } from './core'

export type RetryOptions = {
  sleep?: Sleep
  /** Extra tries after the first. Default 2. */
  maxRetries?: number
  /** Cap on one wait, ms. Default 5000. */
  maxBackoffMs?: number
}

const TRANSIENT_STATUS = new Set([429, 502, 503, 504])
const TRANSIENT_CODE = new Set(['network_error', 'timeout'])

export function isTransient(e: unknown): boolean {
  return e instanceof HawlApiError && (TRANSIENT_STATUS.has(e.status) || TRANSIENT_CODE.has(e.code))
}

/** Run `op` again after a transient failure. `op` builds everything fresh (a new signed assertion each time). */
export async function withRetry<T>(op: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const max = o.maxRetries ?? 2
  const cap = o.maxBackoffMs ?? 5000
  const sleep = o.sleep ?? realSleep
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (e) {
      if (attempt >= max || !isTransient(e)) {
        throw e
      }
      const ra = e instanceof HawlApiError && e.retryAfter ? e.retryAfter * 1000 : 0
      await sleep(Math.min(ra > 0 ? ra : 250 * 2 ** attempt, cap))
    }
  }
}
