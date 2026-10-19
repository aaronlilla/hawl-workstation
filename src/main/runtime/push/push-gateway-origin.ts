import { HAWL_VENDOR_SERVICES_ENABLED } from '../../../hawl/shared/brand'
import { cleanCloudServiceOrigin } from '../../../shared/cloud-service-url'

export function resolvePushGatewayOrigin(env: NodeJS.ProcessEnv, packaged: boolean): string {
  return (
    cleanCloudServiceOrigin(env.ORCA_PUSH_GATEWAY_URL, !packaged) ??
    (HAWL_VENDOR_SERVICES_ENABLED ? 'https://push.onorca.dev' : '')
  )
}
