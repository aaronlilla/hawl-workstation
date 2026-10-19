import { ShieldCheck } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TelemetryConsentState } from '../../../../shared/telemetry-consent-types'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

export type EnvBlockedReason = 'do_not_track' | 'orca_disabled' | 'ci'
export type BlockedReason = { kind: 'env'; reason: EnvBlockedReason }

type PrivacyPaneProps = {
  settings: GlobalSettings
}

export function isEnvBlocked(consent: TelemetryConsentState | null): consent is {
  effective: 'disabled'
  reason: EnvBlockedReason
} {
  return (
    consent?.effective === 'disabled' &&
    (consent.reason === 'do_not_track' ||
      consent.reason === 'orca_disabled' ||
      consent.reason === 'ci')
  )
}

export function envVarNameForReason(reason: EnvBlockedReason): string {
  if (reason === 'do_not_track') {
    return 'DO_NOT_TRACK'
  }
  if (reason === 'orca_disabled') {
    return 'ORCA_TELEMETRY_DISABLED'
  }
  return 'CI'
}

export function computeBlockedReason(consent: TelemetryConsentState | null): BlockedReason | null {
  if (isEnvBlocked(consent)) {
    return { kind: 'env', reason: consent.reason }
  }
  return null
}

export function PrivacyPane(_props: PrivacyPaneProps): React.JSX.Element {
  // Hawl: telemetry is removed from this app. This page only states what is true.
  return (
    <div className="space-y-4">
      <div className="space-y-1 py-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          <Label>{translate('hawl.settings.privacy.title', 'No usage data is collected')}</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'hawl.settings.privacy.body',
            'Hawl Workstation has no analytics and no crash reporting. It sends nothing about how you use it. It only talks to the services you connect: your Git host, your agents, and Hawl when you sign in.'
          )}
        </p>
      </div>
    </div>
  )
}
