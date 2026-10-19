import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The control theme is CSS-only and reaches Orca's shared controls through their data-slot hooks.
// If an upstream merge renames a slot, the theme would silently stop applying: this pins every slot
// the theme styles to the component source that renders it.
const root = join(__dirname, '..', '..', '..', '..')
const css = readFileSync(join(__dirname, 'd2-controls.css'), 'utf8')
const uiDir = join(root, 'src', 'renderer', 'src', 'components', 'ui')

const SLOT_SOURCES: Record<string, string> = {
  button: 'button.tsx',
  switch: 'switch.tsx',
  'switch-thumb': 'switch.tsx',
  'switch-indicator': 'switch.tsx',
  checkbox: 'checkbox.tsx',
  slider: 'slider.tsx',
  'slider-track': 'slider.tsx',
  'slider-range': 'slider.tsx',
  'slider-thumb': 'slider.tsx',
  input: 'input.tsx',
  textarea: 'textarea.tsx',
  'select-trigger': 'select.tsx',
  badge: 'badge.tsx',
  progress: 'progress.tsx',
  'progress-indicator': 'progress.tsx',
  'tooltip-content': 'tooltip.tsx',
  'toggle-group': 'toggle-group.tsx',
  'toggle-group-item': 'toggle-group.tsx',
  'tabs-list': 'tabs.tsx',
  'tabs-trigger': 'tabs.tsx',
  toggle: 'toggle.tsx',
  'command-input': 'command.tsx'
}

describe('d2-controls theme', () => {
  const used = new Set([...css.matchAll(/data-slot='([a-z-]+)'/g)].map((m) => m[1]))

  it('only styles slots that a shared component renders', () => {
    for (const slot of used) {
      const file = SLOT_SOURCES[slot]
      expect(file, `slot ${slot} has no source mapping`).toBeTruthy()
      const src = readFileSync(join(uiDir, file as string), 'utf8')
      expect(src, `${file} no longer renders data-slot="${slot}"`).toContain(`data-slot="${slot}"`)
    }
  })

  it('styles every mapped control', () => {
    for (const slot of Object.keys(SLOT_SOURCES)) {
      expect(used.has(slot), `theme does not style ${slot}`).toBe(true)
    }
  })

  it('covers every button variant', () => {
    const src = readFileSync(join(uiDir, 'button.tsx'), 'utf8')
    for (const variant of ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']) {
      expect(src).toContain(variant)
      expect(css).toContain(`[data-slot='button'][data-variant='${variant}']`)
    }
  })

  it('defines the focus, pressed and disabled states for lit buttons', () => {
    expect(css).toContain("[data-slot='button']:focus-visible")
    expect(css).toContain("[data-slot='button'][data-variant='default']:active")
    expect(css).toContain("[data-slot='button']:disabled")
  })

  it('has a dark counterpart for the surfaces it paints', () => {
    expect(css).toContain('html.dark {')
    expect(css).toContain("html.dark [data-slot='tooltip-content']")
  })
})
