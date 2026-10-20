import { describe, expect, it } from 'vitest'
import {
  HAWL_RELEASE_FEED_LIVE,
  HAWL_VENDOR_SERVICES_ENABLED,
  displayCliText,
  rebrandText
} from './brand'
import { isBlockedHost, isBlockedUrl } from './blocked-hosts'
import { HAWL_TERMINAL_THEMES } from './terminal-themes'
import { applyHawlEnvAliases } from '../main/env-aliases'

describe('rebrandText', () => {
  it('rewrites whole-word Orca in UI copy and leaves commands and identifiers alone', () => {
    expect(rebrandText('Restart Orca to update')).toBe('Restart Hawl to update')
    expect(rebrandText('ORCA')).toBe('HAWL')
    expect(rebrandText('run `orca status`')).toBe('run `hws status`')
    expect(rebrandText('orca-ide in ~/.local/bin')).toBe('orca-ide in ~/.local/bin')
    expect(rebrandText('OrcaRuntime')).toBe('OrcaRuntime')
  })
})

describe('env var names', () => {
  it('shows HAWL_* for the Bitbucket, Azure DevOps and Gitea variables only', () => {
    expect(rebrandText('set ORCA_BITBUCKET_* or ORCA_GITEA_TOKEN or ORCA_AZURE_DEVOPS_TOKEN')).toBe(
      'set HAWL_BITBUCKET_* or HAWL_GITEA_TOKEN or HAWL_AZURE_DEVOPS_TOKEN'
    )
    expect(rebrandText('ORCA_PROFILE_ID')).toBe('ORCA_PROFILE_ID')
  })
  it('mirrors HAWL_* to ORCA_* without overriding an explicit ORCA_*', () => {
    const env: NodeJS.ProcessEnv = {
      HAWL_GITEA_TOKEN: 'a',
      HAWL_BITBUCKET_EMAIL: 'b',
      ORCA_BITBUCKET_EMAIL: 'keep',
      HAWL_OTHER: 'x'
    }
    applyHawlEnvAliases(env)
    expect(env.ORCA_GITEA_TOKEN).toBe('a')
    expect(env.ORCA_BITBUCKET_EMAIL).toBe('keep')
    expect(env.ORCA_OTHER).toBeUndefined()
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
  it('the release feed follows the vendor switch (off in builds until our repo is published)', () => {
    expect(HAWL_RELEASE_FEED_LIVE).toBe(HAWL_VENDOR_SERVICES_ENABLED)
  })
  it('shows hws launcher names instead of orca ones', () => {
    expect(displayCliText('Register C:/app/bin/orca.exe to use Hawl')).toBe(
      'Register C:/app/bin/hws.exe to use Hawl'
    )
    expect(displayCliText('orca.cmd claude-teams')).toBe('hws.cmd claude-teams')
  })
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
