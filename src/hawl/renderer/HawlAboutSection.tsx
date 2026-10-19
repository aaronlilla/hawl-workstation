import type React from 'react'
import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SettingsSubsectionHeader } from '@/components/settings/SettingsFormControls'
import logo from '../../../resources/logo.svg'
import {
  HAWL_PRODUCT_NAME,
  HAWL_REPO_URL,
  HAWL_SITE_URL,
  ORCA_UPSTREAM_LICENSE,
  ORCA_UPSTREAM_URL
} from '../shared/brand'

// Plain text on purpose: the credit must say "Orca" and must not pass through the
// i18n brand rewrite that turns UI copy from "Orca" into "Hawl".
export function HawlAboutSection({
  hasPrecedingSections
}: {
  hasPrecedingSections: boolean
}): React.JSX.Element {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    void window.api.updater.getVersion().then(setVersion)
  }, [])
  const open = (url: string): void => {
    void window.api.shell.openUrl(url)
  }
  return (
    <section data-testid="hawl-about" className="space-y-8">
      {hasPrecedingSections ? <Separator /> : null}
      <div className="space-y-4">
        <SettingsSubsectionHeader title={`About ${HAWL_PRODUCT_NAME}`} />
        <div className="flex items-center gap-4">
          <img src={logo} alt="Hawl" className="h-14 w-auto" />
          <div className="space-y-1">
            <div className="text-sm font-semibold">
              {HAWL_PRODUCT_NAME}
              {version ? (
                <span className="ml-2 font-normal text-muted-foreground">{version}</span>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">
              Built on Orca ({ORCA_UPSTREAM_LICENSE}), openly credited. Orca is copyright (c) 2026
              Lovecast Inc., used under the MIT License, which this app keeps in its LICENSE file.
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => open(HAWL_SITE_URL)}>
            <ExternalLink className="size-3.5" />
            hawl.ai
          </Button>
          <Button variant="outline" size="sm" onClick={() => open(HAWL_REPO_URL)}>
            <ExternalLink className="size-3.5" />
            {HAWL_PRODUCT_NAME} on GitHub
          </Button>
          <Button variant="outline" size="sm" onClick={() => open(ORCA_UPSTREAM_URL)}>
            <ExternalLink className="size-3.5" />
            Orca on GitHub
          </Button>
        </div>
      </div>
    </section>
  )
}
