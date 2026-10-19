import { describe, expect, it } from 'vitest'
import { HAWL_VENDOR_SERVICES_ENABLED, rebrandText } from './brand'
import { isBlockedHost, isBlockedUrl } from './blocked-hosts'
import { HAWL_TERMINAL_THEMES } from './terminal-themes'

describe('rebrandText', () => {
  it('rewrites whole-word Orca in UI copy and leaves commands and identifiers alone', () => {
    expect(rebrandText('Restart Orca to update')).toBe('Restart Hawl to update')
    expect(rebrandText('ORCA')).toBe('HAWL')
    expect(rebrandText('run `orca status`')).toBe('run `orca status`')
    expect(rebrandText('OrcaRuntime')).toBe('OrcaRuntime')
  })
})

describe('blocked hosts', () => {
  it.each([
    'https://us.i.posthog.com/e',
    'https://www.onorca.dev/v1/feedback',
    'https://relay-c1.onorca.dev',
    'https://app.stably.ai/x'
  ])('blocks %s', (url) => {
    expect(isBlockedUrl(url)).toBe(true)
  })
  it('allows Hawl, GitHub and provider hosts', () => {
    expect(isBlockedHost('relay.hawl.ai')).toBe(false)
    expect(isBlockedHost('api.github.com')).toBe(false)
    expect(isBlockedHost('api.anthropic.com')).toBe(false)
    expect(isBlockedHost('notposthog.com.example.org')).toBe(false)
  })
})

describe('fork switches', () => {
  it('vendor services are on only inside the unit-test config', () => {
    expect(HAWL_VENDOR_SERVICES_ENABLED).toBe(true)
  })
  it('defines both Hawl terminal themes with full ANSI palettes', () => {
    for (const theme of Object.values(HAWL_TERMINAL_THEMES)) {
      expect(theme.background).toMatch(/^#[0-9a-f]{6}$/)
      expect(theme.brightWhite).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(Object.keys(HAWL_TERMINAL_THEMES)).toEqual(['Hawl Ember', 'Hawl Daylight'])
  })
})
