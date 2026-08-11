import { describe, it, expect } from 'vitest'
import { groupIntoTurns, renameSpeaker } from './grouping'
import type { EditDoc, Segment } from './types'

const seg = (id: number, speaker: string): Segment => ({
  id, start: id, end: id + 1, speaker, raw_text: '', text: '', words: [],
  flags: { hallucination: false, low_conf: false }, note: '',
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

  // Der Befund aus dem Export "01394435.md": Sprecherzeilen trugen den neuen Namen, Kontext
  // und Zusammenfassung den alten — beide stehen im Markdown ganz oben. Der Knopf verspricht
  // "im ganzen Transkript", also muss der Name ueberall fallen, wo das Dokument ihn NENNT.
  it('zieht den Namen auch durch Kontext, Zusammenfassung, Anmerkungen und Segment-Notizen', () => {
    const doc: EditDoc = {
      ...mkDoc(['Buad Aras'], ['Buad Aras', 'Buad Aras']),
      context: 'Kurzinterview mit Buad Aras, Lackierer.',
      summary: 'Buad Aras stellt seinen Dodge vor.',
      annotations: ['Segment 5: Buad Aras nennt sich selbst anders.'],
    }
    doc.segments[1] = { ...doc.segments[1], note: 'Buad Aras undeutlich' }

    const d = renameSpeaker(doc, 'Buad Aras', 'Fuhat Aras')

    expect(d.context).toBe('Kurzinterview mit Fuhat Aras, Lackierer.')
    expect(d.summary).toBe('Fuhat Aras stellt seinen Dodge vor.')
    expect(d.annotations).toEqual(['Segment 5: Fuhat Aras nennt sich selbst anders.'])
    expect(d.segments[1].note).toBe('Fuhat Aras undeutlich')
  })

  it('laesst den gesprochenen Text in Ruhe', () => {
    // Das Transkript ist das Protokoll des Gesagten, kein Namensfeld. Wer die Sprecherspalte
    // umbenennt, will nicht, dass sich still fuenfzig Saetze aendern.
    const doc = mkDoc(['A'], ['A'])
    doc.segments[0] = { ...doc.segments[0], text: 'Mein Name ist A.', raw_text: 'Mein Name ist A.' }
    const d = renameSpeaker(doc, 'A', 'B')
    expect(d.segments[0].text).toBe('Mein Name ist A.')
    expect(d.segments[0].raw_text).toBe('Mein Name ist A.')
  })

  it('ersetzt nur GANZE Woerter — auch bei Umlaut am Rand und Sonderzeichen im Namen', () => {
    // `\b` waere hier falsch: es ist in JS ASCII-basiert, ein Name mit Umlaut am Rand faellt
    // durch. Und "Anna" darf "Annahme" nicht anfassen.
    const doc: EditDoc = {
      ...mkDoc(['Anna'], ['Anna']),
      summary: 'Anna trifft eine Annahme. Ohne Anna keine Annalen.',
    }
    expect(renameSpeaker(doc, 'Anna', 'Ürsli').summary)
      .toBe('Ürsli trifft eine Annahme. Ohne Ürsli keine Annalen.')

    const doc2: EditDoc = { ...mkDoc(['Ürsli'], ['Ürsli']), summary: 'Ürsli und Ürslis Hut.' }
    expect(renameSpeaker(doc2, 'Ürsli', 'Anna').summary).toBe('Anna und Ürslis Hut.')

    const doc3: EditDoc = { ...mkDoc(['Dr. Meier'], ['Dr. Meier']), summary: 'Dr. Meier (Dr. Meier) spricht.' }
    expect(renameSpeaker(doc3, 'Dr. Meier', 'Meier').summary).toBe('Meier (Meier) spricht.')
  })

  it('haelt unveraenderte Segmente identisch (kein unnoetiges Neu-Rendern)', () => {
    const doc = mkDoc(['A', 'B'], ['A', 'B'])
    const d = renameSpeaker(doc, 'A', 'C')
    expect(d.segments[1]).toBe(doc.segments[1])
  })
})
