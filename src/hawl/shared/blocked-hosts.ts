// Hosts the fork must never contact: Stably / Orca vendor services and PostHog.
// Used as defense in depth by src/hawl/main/network-guard.ts; the source-level calls are
// also disabled at their call sites (see FORK-HOOKS.md).

const BLOCKED_SUFFIXES = [
  'onorca.dev',
  'orca.dev',
  'stably.ai',
  'stably.io',
  'posthog.com',
  'posthog.dev',
  'i.posthog.com',
  'sentry.io'
]

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return BLOCKED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

export function isBlockedUrl(url: string): boolean {
  try {
    return isBlockedHost(new URL(url).hostname)
  } catch {
    return false
  }
}
