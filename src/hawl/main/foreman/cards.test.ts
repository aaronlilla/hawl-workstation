// Work cards: S23 (a card is a one-line title the agent writes, private unless published),
// S24 (busy with no card is "busy, untitled" at home and "unknown" on the site),
// S25 (30 day retention, gone from a site the moment the yard leaves it).
import { describe, expect, it } from 'vitest'
import { CARD_RETENTION_MS, CardBook, type PublishField } from './cards'
import { ForemanError } from './types'

const DAY = 24 * 60 * 60 * 1000

function book() {
  let t = Date.parse('2026-10-19T08:00:00Z')
  let n = 0
  const b = new CardBook({ now: () => t }, () => `crd_${++n}`)
  return { b, adv: (ms: number) => void (t += ms), now: () => t }
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof ForemanError ? e.code : `other:${String(e)}`
  }
  return undefined
}

describe('S23 work cards', () => {
  it('S23: an agent files a one-line title; the card starts as working', () => {
    const { b } = book()
    const c = b.start('a1', {
      title: '  Fix login redirect  ',
      capability: 'fix-bug',
      repo: 'acme/web'
    })
    expect(c).toMatchObject({
      id: 'crd_1',
      title: 'Fix login redirect',
      state: 'working',
      capability: 'fix-bug',
      repo: 'acme/web'
    })
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['81 characters', 'x'.repeat(81)],
    ['two lines (a prompt, not a title)', 'Fix the bug\nthen do the rest of this long prompt'],
    ['carriage return', 'a\rb']
  ])('S23: refuses a title that is %s', (_n, title) => {
    const { b } = book()
    expect(code(() => b.start('a1', { title }))).toBe('bad_card')
    expect(b.count()).toBe(0)
  })

  it('S23: exactly 80 characters is fine', () => {
    const { b } = book()
    expect(b.start('a1', { title: 'x'.repeat(80) }).title).toHaveLength(80)
  })

  it("S23: starting new work ends the agent's previous open card, other agents are untouched", () => {
    const { b } = book()
    const a = b.start('a1', { title: 'first' })
    const o = b.start('a2', { title: 'other' })
    b.start('a1', { title: 'second' })
    expect(b.get(a.id)).toMatchObject({ state: 'done' })
    expect(b.get(a.id)?.endedAt).not.toBeNull()
    expect(b.get(o.id)?.state).toBe('working')
  })

  it('S23: update changes state and title; an ended card cannot restart; unknown card is an error', () => {
    const { b } = book()
    const c = b.start('a1', { title: 'first' })
    b.update(c.id, { state: 'paused' })
    b.update(c.id, { title: 'renamed' })
    expect(b.get(c.id)).toMatchObject({ state: 'paused', title: 'renamed' })
    b.update(c.id, { state: 'done' })
    expect(code(() => b.update(c.id, { state: 'working' }))).toBe('bad_card')
    expect(code(() => b.update('crd_nope', { state: 'done' }))).toBe('unknown_card')
    expect(code(() => b.update(c.id, { title: 'a\nb' }))).toBe('bad_card')
  })

  it('S23: cards are private to the yard until the owner publishes chosen fields', () => {
    const { b } = book()
    b.start('a1', { title: 'Secret plan', capability: 'fix-bug', repo: 'acme/web' })
    expect(b.siteView('site-1', ['a1'])).toEqual([])
    expect(b.yardView([])).toMatchObject([{ title: 'Secret plan' }])
  })

  it.each<[PublishField[], object]>([
    [['capability'], { state: null, capability: 'fix-bug', title: null, repo: null }],
    [['state', 'capability'], { state: 'working', capability: 'fix-bug', title: null, repo: null }],
    [['title'], { state: null, capability: null, title: 'Secret plan', repo: null }],
    [
      ['state', 'capability', 'title', 'repo'],
      { state: 'working', capability: 'fix-bug', title: 'Secret plan', repo: 'acme/web' }
    ]
  ])('S23: publishing %j shows only those fields, the rest are null', (fields, row) => {
    const { b } = book()
    b.start('a1', { title: 'Secret plan', capability: 'fix-bug', repo: 'acme/web' })
    b.publish('site-1', fields)
    expect(b.siteView('site-1', ['a1'])).toEqual([row])
  })

  it('S23: each site has its own published fields', () => {
    const { b } = book()
    b.start('a1', { title: 'Plan', capability: 'fix-bug' })
    b.publish('site-1', ['title'])
    b.publish('site-2', ['capability'])
    expect(b.siteView('site-1', [])[0]).toMatchObject({ title: 'Plan', capability: null })
    expect(b.siteView('site-2', [])[0]).toMatchObject({ title: null, capability: 'fix-bug' })
    expect(b.siteView('site-3', [])).toEqual([])
  })

  it('S23: an unknown field is refused', () => {
    const { b } = book()
    expect(code(() => b.publish('s', ['prompt' as PublishField]))).toBe('bad_card')
  })

  it('S23: ended cards are not on the site view', () => {
    const { b } = book()
    const c = b.start('a1', { title: 'Plan' })
    b.publish('site-1', ['title'])
    b.update(c.id, { state: 'done' })
    expect(b.siteView('site-1', [])).toEqual([])
  })
})

describe('S24 busy with no card', () => {
  it('S24: the yard sees "busy, untitled" and never a guessed title', () => {
    const { b } = book()
    const rows = b.yardView(['a1'])
    expect(rows).toEqual([
      { agentId: 'a1', cardId: null, title: null, state: 'busy', label: 'busy, untitled' }
    ])
  })

  it('S24: the site sees "unknown" (when state is published), with every other field null', () => {
    const { b } = book()
    b.publish('site-1', ['state', 'title'])
    expect(b.siteView('site-1', ['a1'])).toEqual([
      { state: 'unknown', capability: null, title: null, repo: null }
    ])
  })

  it('S24: with state not published the site gets nulls only; with nothing published, nothing', () => {
    const { b } = book()
    b.publish('site-1', ['title'])
    expect(b.siteView('site-1', ['a1'])).toEqual([
      { state: null, capability: null, title: null, repo: null }
    ])
    b.publish('site-2', [])
    expect(b.siteView('site-2', ['a1'])).toEqual([])
  })

  it('S24: an agent with a card is not also listed as untitled', () => {
    const { b } = book()
    b.start('a1', { title: 'Plan' })
    b.publish('site-1', ['state'])
    expect(b.yardView(['a1', 'a2']).map((r) => r.label)).toEqual(['Plan', 'busy, untitled'])
    expect(b.siteView('site-1', ['a1', 'a2'])).toHaveLength(2)
  })
})

describe('S25 retention and leaving a site', () => {
  it('S25: a card is deleted 30 days after it ends, not before', () => {
    const { b, adv } = book()
    const c = b.start('a1', { title: 'Plan' })
    b.update(c.id, { state: 'done' })
    adv(CARD_RETENTION_MS - 1)
    expect(b.sweep()).toBe(0)
    adv(1)
    expect(b.sweep()).toBe(1)
    expect(b.get(c.id)).toBeUndefined()
  })

  it('S25: 30 days is a fact of the constant, and a card still in progress is never swept', () => {
    expect(CARD_RETENTION_MS).toBe(30 * DAY)
    const { b, adv } = book()
    b.start('a1', { title: 'Long job' })
    adv(90 * DAY)
    expect(b.sweep()).toBe(0)
    expect(b.count()).toBe(1)
  })

  it('S25: dropped cards age out the same way', () => {
    const { b, adv } = book()
    const c = b.start('a1', { title: 'Plan' })
    b.update(c.id, { state: 'dropped' })
    adv(31 * DAY)
    expect(b.sweep()).toBe(1)
  })

  it('S25: the moment the yard leaves a site, that site sees no card summary at all', () => {
    const { b } = book()
    b.start('a1', { title: 'Plan', capability: 'fix-bug' })
    b.publish('site-1', ['state', 'title', 'capability', 'repo'])
    b.publish('site-2', ['title'])
    expect(b.siteView('site-1', ['a2'])).toHaveLength(2)
    b.leaveSite('site-1')
    expect(b.siteView('site-1', ['a2'])).toEqual([])
    expect(b.publishedFields('site-1')).toEqual([])
    expect(b.siteView('site-2', [])).toHaveLength(1) // other sites unaffected
  })

  it('S25: joining the site again starts private, nothing is published until the owner chooses', () => {
    const { b } = book()
    b.start('a1', { title: 'Plan' })
    b.publish('site-1', ['title'])
    b.leaveSite('site-1')
    expect(b.siteView('site-1', ['a1'])).toEqual([])
  })

  it('S25: the owner still sees their own cards after leaving a site', () => {
    const { b } = book()
    b.start('a1', { title: 'Plan' })
    b.publish('site-1', ['title'])
    b.leaveSite('site-1')
    expect(b.yardView([])).toMatchObject([{ title: 'Plan' }])
  })

  it('S25: snapshot and restore keep cards and what is published', () => {
    const { b } = book()
    b.start('a1', { title: 'Plan' })
    b.publish('site-1', ['title'])
    const { b: b2 } = book()
    b2.restore(JSON.parse(JSON.stringify(b.snapshot())))
    expect(b2.siteView('site-1', [])).toEqual([
      { state: null, capability: null, title: 'Plan', repo: null }
    ])
  })
})
