import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { applyLens } from './hawl-lens'

/**
 * A sheet of glass that opens under an anchor (H02 menus). It is the page's own surface: it closes on
 * Escape, on a click outside, and when the window loses focus; arrow keys move between its
 * [data-hawl-item] rows. The lens (F06) is built once, after the sheet has its final size.
 */
export function HawlSheet({
  anchor,
  open,
  onClose,
  align = 'start',
  width = 372,
  className,
  label,
  children
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  align?: 'start' | 'end'
  width?: number
  className?: string
  label: string
  children: React.ReactNode
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null)
      return
    }
    const rect = anchor.getBoundingClientRect()
    const left =
      align === 'start'
        ? Math.max(8, Math.min(rect.left - 2, window.innerWidth - width - 8))
        : Math.max(8, Math.min(rect.right - width + 2, window.innerWidth - width - 8))
    setPos({ left, top: rect.bottom + 8 })
  }, [open, anchor, align, width])

  useEffect(() => {
    if (!open || !pos) {
      return
    }
    const node = ref.current
    let cleanup = (): void => {}
    // After layout so the lens map matches the final size.
    const frame = requestAnimationFrame(() => {
      if (node) {
        cleanup = applyLens(node)
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      cleanup()
    }
  }, [open, pos])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        anchor?.focus()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[data-hawl-item]:not([disabled])') ?? [])]
        if (items.length === 0) {
          return
        }
        event.preventDefault()
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next =
          event.key === 'ArrowDown'
            ? items[(at + 1) % items.length]
            : items[(at - 1 + items.length) % items.length]
        next?.focus()
      }
    }
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target) || anchor?.contains(target)) {
        return
      }
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
    }
  }, [open, anchor, onClose])

  useEffect(() => {
    if (!open || !pos) {
      return
    }
    const first = ref.current?.querySelector<HTMLElement>('[data-hawl-item][data-current="true"]:not([disabled]), [data-hawl-item]:not([disabled])')
    first?.focus({ preventScroll: true })
  }, [open, pos])

  if (!open || !pos) {
    return null
  }
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`hawl-sheet ${className ?? ''}`}
      style={{ left: pos.left, top: pos.top, width }}
    >
      <i className="hawl-sheet-sheen" aria-hidden />
      {children}
    </div>,
    document.body
  )
}
