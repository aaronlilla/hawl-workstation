// Hawl Workstation: telemetry is removed. Orca's PostHog transport lived here; this module keeps the
// same exports so the many producers (`track(...)`) stay untouched, but nothing is ever sent, no
// third-party SDK is imported and no host is contacted. The consent flags are still persisted so the
// Settings > Privacy switches keep working as local preferences.

import type { EventName, EventProps, OptInVia } from '../../shared/telemetry-events'
import type { Store } from '../persistence'
import type { ConsentState } from './consent'

let storeRef: Store | null = null

export function initTelemetry(store: Store): void {
  storeRef = store
}

export function shouldOptOutSdkAtInit(consent: ConsentState): boolean {
  return consent.effective === 'disabled'
}

/** Always false: producers skip preparing usage payloads. */
export function isTelemetryEnabled(): boolean {
  return false
}

/** Drops every event. */
export function track<N extends EventName>(_name: N, _props: EventProps<N>): boolean {
  return false
}

export async function setOptIn(_via: OptInVia, optedIn: boolean): Promise<void> {
  if (!storeRef) {
    return
  }
  const settings = storeRef.getSettings()
  storeRef.updateSettings({
    telemetry: {
      ...(settings.telemetry ?? { installId: '', existedBeforeTelemetryRelease: true }),
      optedIn
    }
  })
}

export async function persistBannerAcknowledgeWithoutEmitting(): Promise<void> {
  if (!storeRef) {
    return
  }
  const settings = storeRef.getSettings()
  storeRef.updateSettings({
    telemetry: {
      ...(settings.telemetry ?? { installId: '', existedBeforeTelemetryRelease: true }),
      optedIn: true
    }
  })
}

export function trackAppOpenedOnce(): void {
  // Nothing to send.
}

export async function shutdownTelemetry(): Promise<void> {
  // Nothing to flush.
}
