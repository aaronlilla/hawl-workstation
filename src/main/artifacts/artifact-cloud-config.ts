import { app } from 'electron'
import { HAWL_VENDOR_SERVICES_ENABLED } from '../../hawl/shared/brand'

const PRODUCTION_ARTIFACTS_API_URL = ''

function isPackaged(): boolean {
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

export function resolveArtifactCloudApiUrl(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackaged()
): string {
  const candidate = override?.trim() || env.ORCA_ARTIFACTS_API_URL?.trim()
  if (!candidate && (!HAWL_VENDOR_SERVICES_ENABLED || !PRODUCTION_ARTIFACTS_API_URL)) {
    throw new Error('Artifact sharing is not available in Hawl Workstation yet.')
  }
  const url = new URL(candidate || PRODUCTION_ARTIFACTS_API_URL)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !packaged)) {
    throw new Error('Artifact API URLs must use HTTPS; local development may use loopback HTTP.')
  }
  if (!loopback) {
    throw new Error('Artifact API URLs must use a loopback host in Hawl Workstation.')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Artifact API URL must be an origin without credentials, paths, or parameters.')
  }
  return url.origin
}

export function allowsArtifactCloudAuthOverride(
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackaged()
): boolean {
  return env.NODE_ENV !== 'production' && !packaged
}
