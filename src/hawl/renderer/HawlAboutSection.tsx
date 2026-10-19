import type React from 'react'
import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import {
  HAWL_PRODUCT_NAME,
  HAWL_REPO_URL,
  HAWL_SITE_URL,
  ORCA_UPSTREAM_LICENSE,
  ORCA_UPSTREAM_URL
} from '../shared/brand'
import wordmark from './art/hawl-wordmark.webp'
import restingHelper from './art/empty-quiet.webp'

// Plain text on purpose: the credit must say "Orca" and must not pass through the
// i18n brand rewrite that turns UI copy from "Orca" into "Hawl".
// Layout (M09 About): the wordmark and the resting helper sit straight on the page, the credit is
// plain text, links are lit keys. No card around any of it (object test).
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
    <section data-testid="hawl-about" className="hawl-about space-y-8">
      {hasPrecedingSections ? <Separator /> : null}
      <div className="hawl-about-body">
        <img className="hawl-about-art" src={restingHelper} alt="" aria-hidden draggable={false} />
        <div className="hawl-about-copy">
          <img className="hawl-about-mark" src={wordmark} alt="Hawl" draggable={false} />
          <h2 className="hawl-about-title">About {HAWL_PRODUCT_NAME}</h2>
          {version ? <span className="hawl-about-version">Version {version}</span> : null}
          <p className="hawl-about-credit">
            Built on Orca ({ORCA_UPSTREAM_LICENSE}), openly credited. Orca is copyright (c) 2026
            Lovecast Inc., used under the MIT License, which this app keeps in its LICENSE file.
          </p>
          <div className="hawl-about-links">
            <button
              type="button"
              className="hawl-btn hawl-btn-lit"
              onClick={() => open(HAWL_SITE_URL)}
            >
              <ExternalLink aria-hidden />
              hawl.ai
            </button>
            <button
              type="button"
              className="hawl-btn hawl-btn-acrylic"
              onClick={() => open(HAWL_REPO_URL)}
            >
              <ExternalLink aria-hidden />
              {HAWL_PRODUCT_NAME} on GitHub
            </button>
            <button
              type="button"
              className="hawl-btn hawl-btn-acrylic"
              onClick={() => open(ORCA_UPSTREAM_URL)}
            >
              <ExternalLink aria-hidden />
              Orca on GitHub
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
