// Who this foreman is: the yard it runs for and the site it is plugged into. Written by the sign-in and
// "register your foreman" pieces (P2, P5); until they exist it is a small JSON file the owner can write.
// <userData>/hawl/foreman-identity.json
import { readFileSync } from 'node:fs'
import type { Visibility } from '../../shared/gateway-contract/contract'
import type { DirectLinePolicy } from './types'

export type HawlIdentity = {
  /** Yard slug as in the menu. */
  yard: string
  /** Owning user id. */
  owner: string
  displayName: string
  /** `vil_...` and `twn_...`, for the relay routes. */
  yardId: string
  siteId: string
  visibility?: Visibility
  directLines?: DirectLinePolicy
  /** IANA zone for the daily budget. */
  timeZone?: string
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The identity in `raw`, or the reason it is not usable. */
export function parseIdentity(raw: unknown): HawlIdentity | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'the file is not an object'
  }
  const o = raw as Record<string, unknown>
  const s = (k: string, max: number): string | null =>
    typeof o[k] === 'string' && o[k] !== '' && (o[k] as string).length <= max ? (o[k] as string) : null
  const yard = s('yard', 63)
  if (!yard || !SLUG.test(yard)) {
    return '"yard" must be a lowercase slug (letters, digits, dashes)'
  }
  const owner = s('owner', 128)
  const displayName = s('displayName', 80)
  const yardId = s('yardId', 80)
  const siteId = s('siteId', 80)
  if (!owner || !displayName || !yardId || !siteId) {
    return '"owner", "displayName", "yardId" and "siteId" are required'
  }
  if (!yardId.startsWith('vil_') || !siteId.startsWith('twn_')) {
    return '"yardId" starts with vil_ and "siteId" with twn_'
  }
  const visibility = o.visibility
  if (visibility !== undefined && !['private', 'summary', 'full'].includes(String(visibility))) {
    return '"visibility" is private, summary or full'
  }
  const lines = o.directLines
  if (lines !== undefined && !['job_parties', 'ask_owner', 'never'].includes(String(lines))) {
    return '"directLines" is job_parties, ask_owner or never'
  }
  return {
    yard,
    owner,
    displayName,
    yardId,
    siteId,
    ...(visibility ? { visibility: visibility as Visibility } : {}),
    ...(lines ? { directLines: lines as DirectLinePolicy } : {}),
    ...(typeof o.timeZone === 'string' ? { timeZone: o.timeZone } : {})
  }
}

/** Read the identity file: null when there is none, a string when it is there but unusable. */
export function readIdentity(path: string): HawlIdentity | string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    return `cannot read ${path}: ${(err as Error).message}`
  }
  try {
    return parseIdentity(JSON.parse(text))
  } catch {
    return 'the file is not JSON'
  }
}
