// D2-controls: the light inside a lit control follows the cursor (F01 / F02 "hover light").
// One delegated pointermove listener, one rAF write per frame, only on the control under the pointer.
// Sets --mx / --my (0-100%) and --dx (-1..1) on the nearest [data-slot="button"]; the CSS reads them.
// Nothing runs until the first pointer move, and nothing is written when the pointer is off a button.

const SELECTOR = '[data-slot="button"]:not(:disabled)'

let pending: { el: HTMLElement; x: number; y: number } | null = null
let frame = 0
let last: HTMLElement | null = null

function flush(): void {
  frame = 0
  if (!pending) {
    return
  }
  const { el, x, y } = pending
  pending = null
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) {
    return
  }
  const px = Math.min(1, Math.max(0, (x - r.left) / r.width))
  const py = Math.min(1, Math.max(0, (y - r.top) / r.height))
  el.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`)
  el.style.setProperty('--my', `${(py * 100).toFixed(1)}%`)
  el.style.setProperty('--dx', (px * 2 - 1).toFixed(2))
}

function onMove(e: PointerEvent): void {
  const target = e.target
  if (!(target instanceof Element)) {
    return
  }
  const el = target.closest<HTMLElement>(SELECTOR)
  if (!el) {
    if (last) {
      // Rest position: the light sits at the top left, where the sun is.
      last.style.removeProperty('--mx')
      last.style.removeProperty('--my')
      last.style.removeProperty('--dx')
      last = null
    }
    return
  }
  if (last && last !== el) {
    last.style.removeProperty('--mx')
    last.style.removeProperty('--my')
    last.style.removeProperty('--dx')
  }
  last = el
  pending = { el, x: e.clientX, y: e.clientY }
  if (!frame) {
    frame = requestAnimationFrame(flush)
  }
}

if (typeof document !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches) {
  document.addEventListener('pointermove', onMove, { passive: true })
}
