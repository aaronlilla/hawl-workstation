// Hawl Workstation brand constants and the text rewrite used by the i18n post-processors.
// Built on Orca (https://github.com/stablyai/orca, MIT). The credit text is kept elsewhere
// (About screen, README, LICENSE) and is never passed through rebrandText().

export const HAWL_PRODUCT_NAME = 'Hawl Workstation'
export const HAWL_SHORT_NAME = 'Hawl'
export const HAWL_APP_ID = 'com.hawl.workstation'
export const HAWL_PROTOCOL_SCHEME = 'hawl'
export const HAWL_RELEASE_OWNER = 'aaronlilla'
export const HAWL_RELEASE_REPO = 'hawl-workstation'
export const HAWL_REPO_URL = `https://github.com/${HAWL_RELEASE_OWNER}/${HAWL_RELEASE_REPO}`
export const HAWL_SITE_URL = 'https://hawl.ai'
/** Profile folders under %APPDATA% (Windows) or the platform equivalent. Never `orca`/`orca-dev`, which stock Orca owns. */
export const HAWL_USER_DATA_DIR = 'hawl-workstation'
export const HAWL_DEV_USER_DATA_DIR = 'hawl-workstation-dev'
export const ORCA_UPSTREAM_URL = 'https://github.com/stablyai/orca'
export const ORCA_UPSTREAM_LICENSE = 'MIT'

/** Orca's hosted services (login, relay, push, sharing, feedback, changelog, kill list) are off in the fork. */
// Only the unit-test config (config/vitest.config.ts) flips it on, so Orca's own tests of those
// services keep running; packaged and dev builds always get false.
export const HAWL_VENDOR_SERVICES_ENABLED =
  typeof process !== 'undefined' &&
  process.env?.VITEST === 'true' &&
  process.env?.HAWL_VENDOR_SERVICES_FOR_TESTS === '1'

/**
 * Our release repo (aaronlilla/hawl-workstation) is not published yet, so every request to it would be a 404.
 * While false the updater, the update menu check and the agent-rule downloads make no request. Flip to true
 * in the same commit that publishes the repo and its first release.
 */
export const HAWL_RELEASE_FEED_LIVE = HAWL_VENDOR_SERVICES_ENABLED

/** The star-on-GitHub prompt is off in the fork. */
export const HAWL_STAR_NAG_ENABLED = false

/** Whole-word "Orca" in UI copy becomes "Hawl". A backticked `orca` command becomes `hws` (`hawl` is the Hawl platform CLI, so the workstation command is `hws`). */
export function rebrandText(text: string): string {
  return text
    .replace(/\bOrca\b/g, HAWL_SHORT_NAME)
    .replace(/\bORCA\b/g, 'HAWL')
    .replace(/\bORCA_(BITBUCKET|AZURE_DEVOPS|GITEA)_/g, 'HAWL_$1_')
    .replace(/`orca(?=[ `])/g, '`hws')
}

/** The CLI command shown to users. Windows ships `hws` beside the internal `orca` compatibility name. */
export function displayCommandName(commandName: string): string {
  return commandName === 'orca' ? 'hws' : commandName
}

/** Windows launcher names shown to users: `orca.exe` / `orca.cmd` (internal compatibility names) display as `hws.*`, which sits in the same folder. */
export function displayCliText(text: string): string {
  return text.replace(/orca(\.(?:exe|cmd))/gi, 'hws$1')
}

/** i18next post-processor module: runs on every translated or default-value string. */
export const hawlBrandPostProcessor = {
  type: 'postProcessor' as const,
  name: 'hawl-brand',
  process(value: unknown): unknown {
    // Why: under vitest the upstream English strings stay untouched, so Orca's own UI tests (hundreds
    // that assert "Orca ..." copy) keep passing unchanged across upstream merges. rebrandText has its own tests.
    if (typeof process !== 'undefined' && process.env?.VITEST) {
      return value
    }
    return typeof value === 'string' ? rebrandText(value) : value
  }
}
