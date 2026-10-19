import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HawlSlot, registerHawlSlot } from './HawlSlots'

describe('HawlSlot', () => {
  it('renders an empty marked container when nothing is registered', () => {
    const html = renderToStaticMarkup(<HawlSlot name="yard-tree" />)
    expect(html).toContain('data-hawl-slot="yard-tree"')
    expect(html).toContain('data-hawl-slot-filled="false"')
  })

  it('renders the fallback while unfilled', () => {
    const html = renderToStaticMarkup(<HawlSlot name="topbar-actions" fallback={<b>fallback</b>} />)
    expect(html).toContain('<b>fallback</b>')
  })

  it('renders a registered component in place of the fallback', () => {
    registerHawlSlot('foreman-strip', () => <i>foreman</i>)
    const html = renderToStaticMarkup(<HawlSlot name="foreman-strip" fallback={<b>x</b>} />)
    expect(html).toContain('data-hawl-slot-filled="true"')
    expect(html).toContain('<i>foreman</i>')
    expect(html).not.toContain('<b>x</b>')
  })
})
