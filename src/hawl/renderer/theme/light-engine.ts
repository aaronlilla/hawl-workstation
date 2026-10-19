// Hawl real-light engine (design piece F17, lean port). It only writes CSS custom properties; foundations.css draws.
//
// Lit control (.hawl-lit or [data-hawl-light]): while the cursor is on it, --mx/--my follow the cursor inside its
// face and --hot goes to 1 (animated by an @property transition in CSS). On leave it rests at the upper left.
// Receivers (.hawl-catch or [data-hawl-catch]) within RANGE px of the lit control get --la (amount, falls off with
// distance), --ox/--oy (unit vector away from the lamp) and --lrgb (the lamp colour), so they take a lit rim on the
// side that faces it and throw a coloured shadow away from it.
//
// Cost: one passive pointermove listener, work is frame-paced by the browser, one rect read per receiver when a lit
// control is entered (never per move). Nothing runs until the cursor is over a lit control.

export const LIGHT_RANGE = 280
const SOURCE = '.hawl-lit,[data-hawl-light]'
const RECEIVER = '.hawl-catch,[data-hawl-catch]'
const MAX_RECEIVERS = 60

/** 1 at the source edge, 0 at `range`; a lamp falls off faster than linear. */
export function lightFalloff(distance: number, range: number = LIGHT_RANGE): number {
  if (!(distance >= 0) || distance >= range) {
    return 0
  }
  const t = 1 - distance / range
  return t * t
}

/** Unit vector pointing from the lamp toward the receiver (the way its shadow is thrown). */
export function awayVector(
  lampX: number,
  lampY: number,
  rx: number,
  ry: number
): { x: number; y: number } {
  const dx = rx - lampX
  const dy = ry - lampY
  const len = Math.hypot(dx, dy)
  if (len < 0.001) {
    return { x: 0, y: 0 }
  }
  return { x: dx / len, y: dy / len }
}

type Rect = { left: number; top: number; width: number; height: number }

/** Distance from a point to the nearest edge of a rect (0 when inside). */
export function distanceToRect(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.left - px, 0, px - (r.left + r.width))
  const dy = Math.max(r.top - py, 0, py - (r.top + r.height))
  return Math.hypot(dx, dy)
}

function lampColour(el: HTMLElement): string | null {
  const v = getComputedStyle(el).getPropertyValue('--lrgb').trim()
  return v || null
}

export function installHawlLight(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {}
  }
  let reduce = false
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // matchMedia can be missing in odd hosts; the lamp then moves normally.
  }

  let current: HTMLElement | null = null
  let rect: DOMRect | null = null
  let touched: HTMLElement[] = []
  let px = 0
  let py = 0

  const clearReceivers = (): void => {
    for (const el of touched) {
      el.style.removeProperty('--la')
      el.style.removeProperty('--ox')
      el.style.removeProperty('--oy')
      el.style.removeProperty('--lrgb')
    }
    touched = []
  }

  const leave = (): void => {
    if (current) {
      current.style.removeProperty('--hot')
      current.style.removeProperty('--mx')
      current.style.removeProperty('--my')
    }
    clearReceivers()
    current = null
    rect = null
  }

  const enter = (el: HTMLElement): void => {
    current = el
    rect = el.getBoundingClientRect()
    el.style.setProperty('--hot', '1')
    const rgb = lampColour(el)
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const list = document.querySelectorAll<HTMLElement>(RECEIVER)
    let n = 0
    for (const r of list) {
      if (r === el || el.contains(r) || n >= MAX_RECEIVERS) {
        continue
      }
      const rr = r.getBoundingClientRect()
      const d = distanceToRect(cx, cy, rr)
      const amount = lightFalloff(d)
      if (amount <= 0) {
        continue
      }
      const v = awayVector(cx, cy, rr.left + rr.width / 2, rr.top + rr.height / 2)
      r.style.setProperty('--la', amount.toFixed(3))
      r.style.setProperty('--ox', v.x.toFixed(3))
      r.style.setProperty('--oy', v.y.toFixed(3))
      if (rgb) {
        r.style.setProperty('--lrgb', rgb)
      }
      touched.push(r)
      n++
    }
  }

  const frame = (): void => {
    if (!current || !rect) {
      return
    }
    const mx = Math.min(100, Math.max(0, ((px - rect.left) / Math.max(rect.width, 1)) * 100))
    const my = Math.min(100, Math.max(0, ((py - rect.top) / Math.max(rect.height, 1)) * 100))
    current.style.setProperty('--mx', `${mx.toFixed(1)}%`)
    current.style.setProperty('--my', `${my.toFixed(1)}%`)
  }

  const onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      return
    }
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>(SOURCE) : null
    if (target !== current) {
      leave()
      if (target) {
        enter(target)
      }
    }
    if (current && !reduce) {
      // Chromium delivers at most one pointermove per frame, so this is already frame-paced.
      px = e.clientX
      py = e.clientY
      frame()
    }
  }
  const onLeaveWindow = (): void => leave()

  document.addEventListener('pointermove', onMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onLeaveWindow)
  window.addEventListener('blur', onLeaveWindow)
  return () => {
    document.removeEventListener('pointermove', onMove)
    document.documentElement.removeEventListener('pointerleave', onLeaveWindow)
    window.removeEventListener('blur', onLeaveWindow)
    leave()
  }
}
