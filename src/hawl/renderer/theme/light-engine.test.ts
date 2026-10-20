import { describe, expect, it } from 'vitest'
import { awayVector, distanceBetweenRects, distanceToRect, lightFalloff, LIGHT_RANGE } from './light-engine'

describe('light engine maths', () => {
  it('falls off from 1 at the edge to 0 at range, faster than linear', () => {
    expect(lightFalloff(0)).toBe(1)
    expect(lightFalloff(LIGHT_RANGE)).toBe(0)
    expect(lightFalloff(LIGHT_RANGE * 2)).toBe(0)
    expect(lightFalloff(LIGHT_RANGE / 2)).toBeCloseTo(0.25)
    expect(lightFalloff(-5)).toBe(0)
    expect(lightFalloff(Number.NaN)).toBe(0)
  })

  it('points away from the lamp', () => {
    expect(awayVector(0, 0, 10, 0)).toEqual({ x: 1, y: 0 })
    expect(awayVector(0, 0, 0, -4)).toEqual({ x: 0, y: -1 })
    expect(awayVector(5, 5, 5, 5)).toEqual({ x: 0, y: 0 })
    const v = awayVector(0, 0, 3, 4)
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1)
  })

  it('measures distance to the nearest edge of a rect', () => {
    const r = { left: 10, top: 10, width: 20, height: 10 }
    expect(distanceToRect(15, 15, r)).toBe(0)
    expect(distanceToRect(0, 15, r)).toBe(10)
    expect(distanceToRect(33, 24, r)).toBe(Math.hypot(3, 4))
  })

  it('measures the gap between two rects edge to edge', () => {
    const a = { left: 0, top: 0, width: 100, height: 40 }
    expect(distanceBetweenRects(a, { left: 108, top: 0, width: 100, height: 40 })).toBe(8)
    expect(distanceBetweenRects(a, { left: 50, top: 10, width: 10, height: 10 })).toBe(0)
    expect(distanceBetweenRects(a, { left: 103, top: 44, width: 5, height: 5 })).toBe(5)
  })
})
