import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, X } from 'lucide-react'
import {
  HAWL_PRODUCT_NAME,
  HAWL_REPO_URL,
  HAWL_SITE_URL,
  ORCA_UPSTREAM_LICENSE,
  ORCA_UPSTREAM_URL
} from '../../shared/brand'
import wordmark from '../art/hawl-wordmark.webp'
import restingHelper from '../art/empty-quiet.webp'
import { applyLens } from './hawl-lens'

const OPEN_EVENT = 'hawl:open-about'

/** Opens the About screen from anywhere (Help menu, Settings). */
export function openHawlAbout(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

/**
 * The About screen (M09): a sheet of glass over the app with the helper resting on it, the version,
 * the credit to Orca and the lit links. Plain text for the credit on purpose: it must say "Orca" and
 * must not pass through the i18n brand rewrite.
 */
export function HawlAboutHost(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const onOpen = (): void => setOpen(true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }
    void window.api.updater.getVersion().then(setVersion)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', onKey, true)
    let cleanup = (): void => {}
    const frame = requestAnimationFrame(() => {
      if (sheetRef.current) {
        cleanup = applyLens(sheetRef.current, { scale: 64 })
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      cleanup()
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  if (!open) {
    return null
  }
  const go = (url: string): void => {
    void window.api.shell.openUrl(url)
  }
  return createPortal(
    <div className="hawl-about-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={sheetRef}
        className="hawl-about-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`About ${HAWL_PRODUCT_NAME}`}
        data-testid="hawl-about"
      >
        <i className="hawl-sheet-sheen" aria-hidden />
        <button type="button" className="hawl-about-close" aria-label="Close" onClick={close}>
          <X aria-hidden />
        </button>
        <img className="hawl-about-art" src={restingHelper} alt="" aria-hidden draggable={false} />
        <div className="hawl-about-copy">
          <img className="hawl-about-mark" src={wordmark} alt="Hawl" draggable={false} />
          <h2 className="hawl-about-title">About {HAWL_PRODUCT_NAME}</h2>
          {version ? <span className="hawl-about-version">Version {version}</span> : null}
          <p className="hawl-about-lede">
            The free desktop workstation for Hawl. Start and run whole projects with your agents,
            hand work to teammates, and see every approval and proof in one place.
          </p>
          <p className="hawl-about-credit">
            Built on Orca ({ORCA_UPSTREAM_LICENSE}), openly credited. Orca is copyright (c) 2026
            Lovecast Inc., used under the MIT License, which this app keeps in its LICENSE file.
          </p>
          <div className="hawl-about-links">
            <button
              type="button"
              className="hawl-btn hawl-btn-lit"
              onClick={() => go(HAWL_SITE_URL)}
            >
              <ExternalLink aria-hidden />
              hawl.ai
            </button>
            <button
              type="button"
              className="hawl-btn hawl-btn-acrylic"
              onClick={() => go(HAWL_REPO_URL)}
            >
              <ExternalLink aria-hidden />
              {HAWL_PRODUCT_NAME} on GitHub
            </button>
            <button
              type="button"
              className="hawl-btn hawl-btn-acrylic"
              onClick={() => go(ORCA_UPSTREAM_URL)}
            >
              <ExternalLink aria-hidden />
              Orca on GitHub
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Settings > General row: a one-line pointer to the About screen. */
export function HawlAboutRow(): React.JSX.Element {
  return (
    <section data-testid="hawl-about-row" className="hawl-about-row">
      <div>
        <h3 className="hawl-about-row-title">About {HAWL_PRODUCT_NAME}</h3>
        <p className="hawl-about-row-sub">Version, credits and links.</p>
      </div>
      <button type="button" className="hawl-btn hawl-btn-acrylic" onClick={openHawlAbout}>
        Open About
      </button>
    </section>
  )
}
