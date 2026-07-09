import { describe, it, expect } from 'vitest'
import { playWindow } from './playback'

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

describe('playWindow', () => {
  it.each([
    [{ start: 18.36, end: 20.06 }, 60, 18.21, 20.41],
    [{ start: 31.98, end: 42.76 }, 60, 31.83, 43.11],
    [{ start: 0.05, end: 2.0 }, 60, 0.0, 2.35],   // Pre-Roll auf 0 geklemmt
    [{ start: 50.0, end: 59.9 }, 60, 49.85, 60.0], // Post-Roll auf Dauer geklemmt
    [{ start: 5.0, end: 6.0 }, NaN, 4.85, 6.35],   // Dauer unbekannt -> kein oberes Clamp
  ])('bracketet Segment mit Lead-in/out', (seg, dur, ef, et) => {
    const { from, to } = playWindow(seg as any, dur as number)
    expect(near(from, ef)).toBe(true)
    expect(near(to, et)).toBe(true)
  })
})
