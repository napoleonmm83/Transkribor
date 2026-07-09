import { describe, it, expect } from 'vitest'
import { isCorrected, tokenizeUncertain } from './uncertainty'
import type { Segment } from './types'

const w = (word: string, probability: number) => ({ word, start: null, end: null, probability })
const base = (over: Partial<Segment>): Segment => ({
  id: 1, start: 0, end: 1, speaker: '', raw_text: 'a b c', text: 'a b c',
  words: [w('a', 0.9), w(' b', 0.3), w(' c', 0.5)],
  flags: { hallucination: false, silence: false, low_conf: false }, note: '', ...over,
})
const thr = { yellow: 0.6, red: 0.4 }

describe('uncertainty', () => {
  it('isCorrected erkennt geänderten Text', () => {
    expect(isCorrected(base({}))).toBe(false)
    expect(isCorrected(base({ text: 'a B c' }))).toBe(true)
  })
  it('färbt mittleres Wort nach Konfidenz', () => {
    const t = tokenizeUncertain(base({}), thr)
    expect(t.map(x => x.cls)).toEqual(['', 'u-red', 'u-yellow'])
    expect(t.map(x => x.text)).toEqual(['a', ' b', ' c'])
  })
  it('Randwort nur ab rot', () => {
    const seg = base({ words: [w('a', 0.5), w(' b', 0.9), w(' c', 0.9)] })
    expect(tokenizeUncertain(seg, thr)[0].cls).toBe('') // 0.5<yellow, aber Randwort -> nicht gelb
    const seg2 = base({ words: [w('a', 0.3), w(' b', 0.9), w(' c', 0.9)] })
    expect(tokenizeUncertain(seg2, thr)[0].cls).toBe('u-red') // Randwort ab rot schon
  })
})
