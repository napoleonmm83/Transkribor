import { describe, it, expect } from 'vitest'
import { groupIntoTurns, renameSpeaker } from './grouping'
import type { EditDoc, Segment } from './types'

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

const mkDoc = (speakers: string[], segSpeakers: string[]): EditDoc => ({
  base: 'b', project: 'P', audio: 'a.wav', language: 'de', human_edited: false,
  context: '', speakers, segments: segSpeakers.map((s, i) => seg(i, s)), annotations: [],
})

describe('renameSpeaker', () => {
  it('trifft ALLE Segmente des Sprechers und die speakers-Liste', () => {
    const d = renameSpeaker(mkDoc(['Interviewer', 'Befragte'], ['Interviewer', 'Befragte', 'Interviewer']),
      'Interviewer', 'Beni Dürr')
    expect(d.segments.map(s => s.speaker)).toEqual(['Beni Dürr', 'Befragte', 'Beni Dürr'])
    expect(d.speakers).toEqual(['Beni Dürr', 'Befragte'])
  })
  it('laesst unbenannte Segmente in Ruhe', () => {
    const d = renameSpeaker(mkDoc([], ['Interviewer', '', '']), 'Interviewer', 'Beni Dürr')
    expect(d.segments.map(s => s.speaker)).toEqual(['Beni Dürr', '', ''])
  })
  it('benennt NICHT von leer weg — sonst faengt man den halben Interviewer mit ein', () => {
    const doc = mkDoc([], ['', 'A'])
    expect(renameSpeaker(doc, '', 'Beni Dürr')).toBe(doc)
  })
  it('leerer Zielname und No-op lassen das Dokument unveraendert (identisch)', () => {
    const doc = mkDoc(['A'], ['A'])
    expect(renameSpeaker(doc, 'A', '')).toBe(doc)
    expect(renameSpeaker(doc, 'A', 'A')).toBe(doc)
  })
  it('Umbenennen auf einen vorhandenen Namen verschmilzt beide ohne Dublette', () => {
    const d = renameSpeaker(mkDoc(['A', 'B'], ['A', 'B']), 'A', 'B')
    expect(d.speakers).toEqual(['B'])
    expect(d.segments.map(s => s.speaker)).toEqual(['B', 'B'])
  })
})
