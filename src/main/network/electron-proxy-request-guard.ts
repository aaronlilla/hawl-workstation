import type { Session } from 'electron'
import { getProxySessionApplicationReadiness } from './proxy-settings'
import { isBlockedUrl } from '../../hawl/shared/blocked-hosts'

/** Hold default-session requests until the newest app-wide proxy transition settles. */
export function installElectronProxyRequestGuard(proxySession: Session): void {
  proxySession.webRequest.onBeforeRequest((_details, callback) => {
    // Hawl fork: never reach vendor or analytics hosts (FORK-HOOKS.md).
    if (isBlockedUrl(_details.url)) {
      callback({ cancel: true })
      return
    }
    const readiness = getProxySessionApplicationReadiness(proxySession)
    const answer = (ready: boolean): void => callback(ready ? {} : { cancel: true })
    if (typeof readiness === 'boolean') {
      answer(readiness)
    } else {
      void readiness.then(answer)
    }
  })
}
