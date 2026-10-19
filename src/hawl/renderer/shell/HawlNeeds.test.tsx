import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HawlNeedsRow, formatNeedsTime } from './HawlNeeds'

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)

describe('formatNeedsTime', () => {
  it('reads like the design: minutes, hours, Yesterday, then a date', () => {
    expect(formatNeedsTime(NOW - 20_000, NOW)).toBe('Just now')
    expect(formatNeedsTime(NOW - 4 * 60_000, NOW)).toBe('4 min ago')
    expect(formatNeedsTime(NOW - 2 * 3_600_000, NOW)).toBe('2 h ago')
    expect(formatNeedsTime(NOW - 30 * 3_600_000, NOW)).toBe('Yesterday')
    expect(formatNeedsTime(0, NOW)).toBe('')
  })
})

describe('HawlNeedsRow', () => {
  it('shows the why, the work order id, the worker, the time and the lit action', () => {
    const html = renderToStaticMarkup(
      <HawlNeedsRow
        item={{
          id: 'x',
          lane: 'now',
          tone: 'orange',
          title: 'Approve sending the invoice PDF to Dana',
          ref: 'WO-241',
          sub: 'Waiting for your OK.',
          worker: { name: "Maya's Claude Code", tone: 'orange' },
          at: Date.now() - 12 * 60_000,
          action: 'Review'
        }}
      />
    )
    expect(html).toContain('Approve sending the invoice PDF to Dana')
    expect(html).toContain('WO-241')
    expect(html).toContain('Maya&#x27;s Claude Code')
    expect(html).toContain('12 min ago')
    expect(html).toContain('hawl-review')
    expect(html).toContain('data-lane="now"')
  })

  it('has no lit action when the item has none', () => {
    const html = renderToStaticMarkup(
      <HawlNeedsRow
        item={{
          id: 'y',
          lane: 'fyi',
          tone: 'lime',
          title: 'Done',
          worker: { name: 'Codex' },
          at: 1
        }}
      />
    )
    expect(html).not.toContain('hawl-review')
  })
})
