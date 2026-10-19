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

/** The star-on-GitHub prompt is off in the fork. */
export const HAWL_STAR_NAG_ENABLED = false

/** Whole-word "Orca" in UI copy becomes "Hawl". Lowercase command names (`orca ...`) are untouched. */
export function rebrandText(text: string): string {
  return text.replace(/\bOrca\b/g, HAWL_SHORT_NAME).replace(/\bORCA\b/g, 'HAWL')
}

/** i18next post-processor module: runs on every translated or default-value string. */
export const hawlBrandPostProcessor = {
  type: 'postProcessor' as const,
  name: 'hawl-brand',
  process(value: unknown): unknown {
    return typeof value === 'string' ? rebrandText(value) : value
  }
}
