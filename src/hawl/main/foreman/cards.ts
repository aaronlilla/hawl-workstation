// Work cards (S23, S24, S25). Pure: injected clock, no I/O.
import type { Clock } from './types'
import { ForemanError } from './types'

export type CardState = 'working' | 'paused' | 'done' | 'dropped'
export type PublishField = 'state' | 'capability' | 'title' | 'repo'
export const PUBLISH_FIELDS: readonly PublishField[] = ['state', 'capability', 'title', 'repo']

export const CARD_TITLE_MAX = 80
/** S25: cards are deleted 30 days after they end. */
export const CARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type Card = {
  id: string
  agentId: string
  title: string
  capability: string | null
  repo: string | null
  jobId: string | null
  state: CardState
  startedAt: number
  updatedAt: number
  endedAt: number | null
}

/** One row of the owner's own yard view. */
export type YardCardRow = {
  agentId: string
  cardId: string | null
  /** null when the agent is busy and filed no card. */
  title: string | null
  state: CardState | 'busy'
  /** "busy, untitled" for a busy agent with no card (S24), else the title. */
  label: string
}

/** One row of what a site may see. null means unknown or not published. */
export type SiteCardRow = {
  state: CardState | 'unknown' | null
  capability: string | null
  title: string | null
  repo: string | null
}

const isActive = (c: Card): boolean => c.state === 'working' || c.state === 'paused'

export class CardBook {
  readonly #clock: Clock
  readonly #newId: () => string
  readonly #cards = new Map<string, Card>()
  readonly #publish = new Map<string, PublishField[]>()

  constructor(clock: Clock, newId: () => string) {
    this.#clock = clock
    this.#newId = newId
  }

  /** The agent files a one-line title it wrote itself. Starting new work ends its previous open card. */
  start(
    agentId: string,
    input: { title: string; capability?: string; repo?: string; jobId?: string }
  ): Card {
    const title = validateTitle(input.title)
    const now = this.#clock.now()
    for (const c of this.#cards.values()) {
      if (c.agentId === agentId && isActive(c)) {
        c.state = 'done'
        c.updatedAt = now
        c.endedAt = now
      }
    }
    const card: Card = {
      id: this.#newId(),
      agentId,
      title,
      capability: input.capability ?? null,
      repo: input.repo ?? null,
      jobId: input.jobId ?? null,
      state: 'working',
      startedAt: now,
      updatedAt: now,
      endedAt: null
    }
    this.#cards.set(card.id, card)
    return card
  }

  update(cardId: string, patch: { state?: CardState; title?: string }): Card {
    const card = this.#cards.get(cardId)
    if (!card) {
      throw new ForemanError('unknown_card', `no card ${cardId}`)
    }
    const now = this.#clock.now()
    if (patch.title !== undefined) {
      card.title = validateTitle(patch.title)
    }
    if (patch.state !== undefined) {
      if (!isActive(card) && (patch.state === 'working' || patch.state === 'paused')) {
        throw new ForemanError('bad_card', 'an ended card cannot restart')
      }
      card.state = patch.state
      if (!isActive(card)) {
        card.endedAt = now
      }
    }
    card.updatedAt = now
    return card
  }

  /** The job the card belongs to closed: end its cards. */
  endForJob(jobId: string): void {
    const now = this.#clock.now()
    for (const c of this.#cards.values()) {
      if (c.jobId === jobId && isActive(c)) {
        c.state = 'done'
        c.updatedAt = now
        c.endedAt = now
      }
    }
  }

  get(cardId: string): Card | undefined {
    return this.#cards.get(cardId)
  }

  /** The owner sees every card, plus a "busy, untitled" row for each busy agent without one (S24). */
  yardView(busyAgents: readonly string[]): YardCardRow[] {
    const rows: YardCardRow[] = []
    const withCard = new Set<string>()
    for (const c of this.#cards.values()) {
      if (!isActive(c)) {
        continue
      }
      withCard.add(c.agentId)
      rows.push({
        agentId: c.agentId,
        cardId: c.id,
        title: c.title,
        state: c.state,
        label: c.title
      })
    }
    for (const id of busyAgents) {
      if (withCard.has(id)) {
        continue
      }
      rows.push({ agentId: id, cardId: null, title: null, state: 'busy', label: 'busy, untitled' })
    }
    return rows
  }

  /** Owner chooses which fields a site sees. An empty list keeps cards yard-private. */
  publish(siteId: string, fields: readonly PublishField[]): void {
    for (const f of fields) {
      if (!PUBLISH_FIELDS.includes(f)) {
        throw new ForemanError('bad_card', `unknown field ${f}`)
      }
    }
    this.#publish.set(siteId, [...new Set(fields)])
  }

  publishedFields(siteId: string): PublishField[] {
    return [...(this.#publish.get(siteId) ?? [])]
  }

  /** S25: the yard left the site. Its card summaries vanish at once and re-plugging starts private. */
  leaveSite(siteId: string): void {
    this.#publish.delete(siteId)
  }

  /**
   * What a site sees: only published fields, null for the rest. A busy agent with no
   * card shows as "unknown", never a guessed title (S24).
   */
  siteView(siteId: string, busyAgents: readonly string[]): SiteCardRow[] {
    const fields = this.#publish.get(siteId)
    if (!fields || fields.length === 0) {
      return []
    }
    const has = (f: PublishField): boolean => fields.includes(f)
    const rows: SiteCardRow[] = []
    const withCard = new Set<string>()
    for (const c of this.#cards.values()) {
      if (!isActive(c)) {
        continue
      }
      withCard.add(c.agentId)
      rows.push({
        state: has('state') ? c.state : null,
        capability: has('capability') ? c.capability : null,
        title: has('title') ? c.title : null,
        repo: has('repo') ? c.repo : null
      })
    }
    for (const id of busyAgents) {
      if (withCard.has(id)) {
        continue
      }
      rows.push({
        state: has('state') ? 'unknown' : null,
        capability: null,
        title: null,
        repo: null
      })
    }
    return rows
  }

  /** S25: delete cards that ended more than 30 days ago. Returns how many went. */
  sweep(): number {
    const cutoff = this.#clock.now() - CARD_RETENTION_MS
    let n = 0
    for (const [id, c] of this.#cards) {
      if (c.endedAt !== null && c.endedAt <= cutoff) {
        this.#cards.delete(id)
        n++
      }
    }
    return n
  }

  count(): number {
    return this.#cards.size
  }

  snapshot(): { cards: Card[]; publish: [string, PublishField[]][] } {
    return {
      cards: [...this.#cards.values()].map((c) => ({ ...c })),
      publish: [...this.#publish].map(([k, v]) => [k, [...v]])
    }
  }

  restore(s: { cards: Card[]; publish: [string, PublishField[]][] }): void {
    this.#cards.clear()
    this.#publish.clear()
    for (const c of s.cards) {
      this.#cards.set(c.id, { ...c })
    }
    for (const [k, v] of s.publish) {
      this.#publish.set(k, [...v])
    }
  }
}

function validateTitle(raw: string): string {
  const title = typeof raw === 'string' ? raw.trim() : ''
  if (title.length < 1 || title.length > CARD_TITLE_MAX) {
    throw new ForemanError('bad_card', `title must be 1 to ${CARD_TITLE_MAX} characters`)
  }
  // A card is a one-line title the agent writes, never the prompt.
  if (/[\r\n]/.test(title)) {
    throw new ForemanError('bad_card', 'title must be one line')
  }
  return title
}
