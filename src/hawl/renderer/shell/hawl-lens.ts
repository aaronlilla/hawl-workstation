/**
 * F06 glass: a real lens for sheets of glass that sit over live content (menus, the About sheet).
 * Built on demand when a sheet opens, never at startup. The sheet's own rounded-rectangle shape is
 * turned into a displacement map (the bevel pushes what is behind it sideways, hard at the rim, not
 * at all in the middle, with a slight magnification), and used as
 * `backdrop-filter: url(#filter)`. Red is bent most and blue least, so the rim shows a colour fringe.
 * Same idea as _work/2026-10-12-cd-full/system/F05.js, applied to the live page instead of a picture.
 * Where the browser cannot do url() in backdrop-filter, the plain blur from the CSS stays.
 */
const NS = 'http://www.w3.org/2000/svg'
const XL = 'http://www.w3.org/1999/xlink'

let defs: SVGDefsElement | null = null
let uid = 0
const maps = new Map<string, string>()

function ensureDefs(): SVGDefsElement {
  if (defs?.isConnected) {
    return defs
  }
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('style', 'position:absolute;width:0;height:0;pointer-events:none')
  defs = document.createElementNS(NS, 'defs')
  svg.appendChild(defs)
  document.body.appendChild(svg)
  return defs
}

export function canUseLens(): boolean {
  try {
    const probe = document.createElement('div')
    probe.style.backdropFilter = 'url(#x)'
    return Boolean(probe.style.backdropFilter)
  } catch {
    return false
  }
}

function field(
  i: number,
  j: number,
  w: number,
  h: number,
  r: number
): { d: number; nx: number; ny: number } {
  const dx = i + 0.5 - w / 2
  const dy = j + 0.5 - h / 2
  const qx = Math.abs(dx) - (w / 2 - r)
  const qy = Math.abs(dy) - (h / 2 - r)
  const sx = dx < 0 ? -1 : 1
  const sy = dy < 0 ? -1 : 1
  const dl = i + 0.5
  const dr = w - dl
  const dt = j + 0.5
  const db = h - dt
  const m = Math.min(dl, dr, dt, db)
  const K = 0.16
  const wl = Math.exp(-K * (dl - m))
  const wr = Math.exp(-K * (dr - m))
  const wt = Math.exp(-K * (dt - m))
  const wb = Math.exp(-K * (db - m))
  let nx = wr - wl
  let ny = wb - wt
  const n = Math.hypot(nx, ny) || 1
  nx /= n
  ny /= n
  let sd: number
  if (qx > 0 && qy > 0) {
    const l = Math.hypot(qx, qy)
    sd = l - r
    const u = Math.min(1, l / (r * 0.85))
    const om = u * u * (3 - 2 * u)
    nx = nx * (1 - om) + ((sx * qx) / l) * om
    ny = ny * (1 - om) + ((sy * qy) / l) * om
    const n2 = Math.hypot(nx, ny) || 1
    nx /= n2
    ny /= n2
  } else {
    sd = Math.max(qx, qy) - r
  }
  return { d: -sd, nx, ny }
}

function displacementMap(w: number, h: number, r: number, bw: number): string {
  const key = [w, h, r, bw].join(',')
  const cached = maps.get(key)
  if (cached) {
    return cached
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return ''
  }
  const img = ctx.createImageData(w, h)
  const D = img.data
  const G = 0.1
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4
      const f = field(i, j, w, h, r)
      const t = f.d >= bw ? 0 : Math.max(0, 1 - f.d / bw)
      let k = Math.pow(t, 1.7) + Math.pow(Math.max(0, 1 - f.d / (bw * 0.4)), 2) * 0.16
      k = Math.min(1.25, k)
      const mx = (-(i + 0.5 - w / 2) / (w / 2)) * G
      const my = (-(j + 0.5 - h / 2) / (h / 2)) * G
      const vx = Math.max(-1, Math.min(1, f.nx * k + mx))
      const vy = Math.max(-1, Math.min(1, f.ny * k + my))
      D[o] = Math.round(127.5 + vx * 127)
      D[o + 1] = Math.round(127.5 + vy * 127)
      D[o + 2] = 128
      D[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const url = canvas.toDataURL()
  maps.set(key, url)
  return url
}

function el(name: string, attrs: Record<string, string>): SVGElement {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v)
  }
  return e
}

/**
 * Turns `node` into a lens. Returns a cleanup that removes the filter. `blur` is the frost in px
 * (Aaron 2026-10-13: much more blur behind glass, shapes and colours only).
 */
export function applyLens(node: HTMLElement, opts: { blur?: number; scale?: number } = {}): () => void {
  if (!canUseLens()) {
    return () => {}
  }
  const w = Math.round(node.offsetWidth)
  const h = Math.round(node.offsetHeight)
  if (w < 24 || h < 24) {
    return () => {}
  }
  const radius = Math.min(
    parseFloat(getComputedStyle(node).borderTopLeftRadius) || 20,
    w / 2,
    h / 2
  )
  const bw = Math.max(14, Math.min(46, Math.min(w, h) * 0.2))
  const map = displacementMap(w, h, radius, bw)
  if (!map) {
    return () => {}
  }
  const id = `hawl-lens-${uid++}`
  const scale = opts.scale ?? 54
  const blur = opts.blur ?? 5
  const f = el('filter', {
    id,
    x: '0',
    y: '0',
    width: String(w),
    height: String(h),
    filterUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB'
  })
  const image = el('feImage', {
    x: '0',
    y: '0',
    width: String(w),
    height: String(h),
    preserveAspectRatio: 'none',
    result: 'm'
  })
  image.setAttribute('href', map)
  image.setAttributeNS(XL, 'xlink:href', map)
  f.appendChild(image)
  f.appendChild(el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: String(blur), result: 'src' }))
  const channels: [string, number, string][] = [
    ['r', 1, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
    ['g', 0.94, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
    ['b', 0.88, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0']
  ]
  for (const [c, k, matrix] of channels) {
    f.appendChild(
      el('feDisplacementMap', {
        in: 'src',
        in2: 'm',
        scale: (scale * k).toFixed(1),
        xChannelSelector: 'R',
        yChannelSelector: 'G',
        result: `d${c}`
      })
    )
    f.appendChild(el('feColorMatrix', { in: `d${c}`, type: 'matrix', values: matrix, result: `c${c}` }))
  }
  f.appendChild(el('feBlend', { in: 'cr', in2: 'cg', mode: 'screen', result: 'rg' }))
  f.appendChild(el('feBlend', { in: 'rg', in2: 'cb', mode: 'screen' }))
  ensureDefs().appendChild(f)
  const value = `url(#${id}) saturate(1.5) brightness(1.04)`
  node.style.backdropFilter = value
  node.style.setProperty('-webkit-backdrop-filter', value)
  node.dataset.hawlLens = 'on'
  return () => {
    f.remove()
    node.style.backdropFilter = ''
    node.style.removeProperty('-webkit-backdrop-filter')
    delete node.dataset.hawlLens
  }
}
