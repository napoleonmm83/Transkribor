import { describe, it, expect } from 'vitest'
import { groupIntoTurns } from './grouping'
import type { Segment } from './types'

const seg = (id: number, speaker: string): Segment => ({
  id, start: id, end: id + 1, speaker, raw_text: '', text: '', words: [],
  flags: { hallucination: false, silence: false, low_conf: false }, note: '',
})

describe('groupIntoTurns', () => {
  it('bündelt aufeinanderfolgende gleiche Sprecher', () => {
    const t = groupIntoTurns([seg(0, 'A'), seg(1, 'A'), seg(2, 'B'), seg(3, 'A')])
    expect(t.map(x => x.speaker)).toEqual(['A', 'B', 'A'])
    expect(t[0].segments.map(s => s.id)).toEqual([0, 1])
    expect(t.map(x => x.key)).toHaveLength(3)
    expect(new Set(t.map(x => x.key)).size).toBe(3) // Keys eindeutig
  })
  it('leerer Sprecher bleibt eigener Block', () => {
    const t = groupIntoTurns([seg(0, ''), seg(1, 'A')])
    expect(t).toHaveLength(2)
    expect(t[0].speaker).toBe('')
  })
  it('leere Eingabe -> leeres Array', () => {
    expect(groupIntoTurns([])).toEqual([])
  })
})
