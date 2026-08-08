import { describe, it, expect } from 'vitest'
import { isCorrected, tokenizeUncertain } from './uncertainty'
import type { Segment } from './types'

const w = (word: string, probability: number) => ({ word, start: null, end: null, probability })
const base = (over: Partial<Segment>): Segment => ({
  id: 1, start: 0, end: 1, speaker: '', raw_text: 'a b c', text: 'a b c',
  words: [w('a', 0.9), w(' b', 0.3), w(' c', 0.5)],
  flags: { hallucination: false, low_conf: false }, note: '', ...over,
})

describe('uncertainty', () => {
  it('isCorrected erkennt geänderten Text', () => {
    expect(isCorrected(base({}))).toBe(false)
    expect(isCorrected(base({ text: 'a B c' }))).toBe(true)
  })
  it('färbt mittleres Wort nach Konfidenz, Ränder geschützt', () => {
    const y = base({ words: [w('a', 0.9), w(' b', 0.5), w(' c', 0.9)] })
    expect(tokenizeUncertain(y).map(x => x.cls)).toEqual(['', 'u-yellow', ''])
    const r = base({ words: [w('a', 0.9), w(' b', 0.3), w(' c', 0.9)] })
    expect(tokenizeUncertain(r).map(x => x.cls)).toEqual(['', 'u-red', ''])
  })
  it('Randwörter (erstes UND letztes) nur ab rot', () => {
    const f = base({ words: [w('a', 0.5), w(' b', 0.9), w(' c', 0.9)] })
    expect(tokenizeUncertain(f)[0].cls).toBe('')            // erstes, gelb-Bereich -> geschützt
    const fr = base({ words: [w('a', 0.3), w(' b', 0.9), w(' c', 0.9)] })
    expect(tokenizeUncertain(fr)[0].cls).toBe('u-red')      // erstes, rot -> gefärbt
    const l = base({ words: [w('a', 0.9), w(' b', 0.9), w(' c', 0.5)] })
    expect(tokenizeUncertain(l)[2].cls).toBe('')            // letztes, gelb-Bereich -> geschützt
    const lr = base({ words: [w('a', 0.9), w(' b', 0.9), w(' c', 0.3)] })
    expect(tokenizeUncertain(lr)[2].cls).toBe('u-red')      // letztes, rot -> gefärbt
  })
  it('behält Token-Text inkl. führender Leerzeichen', () => {
    expect(tokenizeUncertain(base({})).map(x => x.text)).toEqual(['a', ' b', ' c'])
  })
})
