import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Huly light: on hover, the glow on a lit object shifts toward the cursor. One delegated listener for
 * the whole window (installed once, throttled to a frame); it only writes two CSS variables on the
 * lit object under the pointer. The look itself is in d4-shell.css (`--hx`, `--hy`).
 */
const LIT = '.hawl-btn-lit, .hawl-nav-row, .hawl-nav-row[aria-current="page"], .hawl-invite, .hawl-review'

let installed = false

function install(): void {
  if (installed || typeof document === 'undefined') {
    return
  }
  installed = true
  let frame = 0
  let lastEvent: PointerEvent | null = null
  document.addEventListener(
    'pointermove',
    (event) => {
      lastEvent = event
      if (frame) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        const e = lastEvent
        if (!e || !(e.target instanceof Element)) {
          return
        }
        const node = e.target.closest<HTMLElement>(LIT)
        if (!node) {
          return
        }
        const rect = node.getBoundingClientRect()
        node.style.setProperty('--hx', `${Math.round(e.clientX - rect.left)}px`)
        node.style.setProperty('--hy', `${Math.round(e.clientY - rect.top)}px`)
      })
    },
    { passive: true }
  )
}

export function useHawlLight(_ref?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    install()
  }, [])
}
