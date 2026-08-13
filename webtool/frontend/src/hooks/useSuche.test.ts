import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSuche } from './useSuche'
import type { EditDoc, Segment } from '@/lib/types'

const mkSeg = (id: number, text: string, raw: string = text): Segment => ({
  id, start: 0, end: 1, speaker: 'A', raw_text: raw, text, words: [],
  flags: { hallucination: false, low_conf: false }, note: '',
})

/** Minimales EditDoc; useSuche braucht nur context/summary/segments/annotations. */
function doc(segs: Segment[], extra: Partial<Pick<EditDoc, 'context' | 'summary' | 'annotations'>> = {}): EditDoc {
  return {
    base: 'b', project: 'P', audio: 'a.wav', language: 'de', human_edited: false,
    speakers: [], segments: segs, context: extra.context ?? '', summary: extra.summary ?? '',
    annotations: extra.annotations ?? [],
  }
}

describe('useSuche', () => {
  it('findet Treffer case-insensitive im korrigierten Segmenttext', () => {
    const { result } = renderHook(() => useSuche(doc([mkSeg(1, 'Fuhat Aras kam 2012'), mkSeg(2, 'nichts hier')]), 'aras'))
    expect(result.current.treffer).toEqual([{ kind: 'segment', id: 1 }])
    expect(result.current.segmentTreffer.has(1)).toBe(true)
    expect(result.current.treffer.length).toBe(1)
  })

  it('sucht im raw_text, wenn das Segment unkorrigiert ist (text === raw_text)', () => {
    const a = renderHook(() => useSuche(doc([mkSeg(1, 'Wiesental', 'Wiesenthal')]), 'Wiesenthal'))
    expect(a.result.current.treffer).toEqual([])
    const b = renderHook(() => useSuche(doc([mkSeg(1, 'Wiesenthal')]), 'Wiesenthal'))
    expect(b.result.current.treffer).toEqual([{ kind: 'segment', id: 1 }])
  })

  it('leeres/whitespace-Query -> keine Treffer', () => {
    for (const q of ['', '   ']) {
      const { result } = renderHook(() => useSuche(doc([mkSeg(1, 'x')]), q))
      expect(result.current.treffer).toEqual([])
    }
  })

  it('erhaelt die Dokumentreihenfolge: Kopf, dann Segmente, dann Anmerkungen', () => {
    const d = doc(
      [mkSeg(5, 'Aras'), mkSeg(3, 'Aras'), mkSeg(7, 'Aras')],
      { context: 'Aras im Kontext', summary: 'ohne Treffer', annotations: ['eine Aras-Anmerkung', 'ohne'] },
    )
    const { result } = renderHook(() => useSuche(d, 'aras'))
    // Reihenfolge: Kontext (Kopf) -> Segmente 5,3,7 -> Annotation 0
    expect(result.current.treffer).toEqual([
      { kind: 'kopf', field: 'context' },
      { kind: 'segment', id: 5 },
      { kind: 'segment', id: 3 },
      { kind: 'segment', id: 7 },
      { kind: 'annotation', index: 0 },
    ])
    expect(result.current.segmentTreffer).toEqual(new Set([5, 3, 7]))
  })

  it('durchsucht Zusammenfassung und Kontext', () => {
    const d = doc([mkSeg(1, 'x')], { context: 'David aus dem Torkel', summary: 'Trüffel und Brioche' })
    expect(renderHook(() => useSuche(d, 'torkel')).result.current.treffer)
      .toEqual([{ kind: 'kopf', field: 'context' }])
    expect(renderHook(() => useSuche(d, 'brioche')).result.current.treffer)
      .toEqual([{ kind: 'kopf', field: 'summary' }])
  })

  it('durchsucht Anmerkungen', () => {
    const d = doc([mkSeg(1, 'x')], { annotations: ['uneientlich', 'Trüffel-Hund Jack'] })
    const { result } = renderHook(() => useSuche(d, 'jack'))
    expect(result.current.treffer).toEqual([{ kind: 'annotation', index: 1 }])
  })

  // Issue #127: CH-Transkripte wechseln die Schreibweise („Bühler"/„Buehler"); wer das eine
  // tippt, meint das andere.
  it('findet über die Umlaut-Schreibweise hinweg, in beide Richtungen', () => {
    const mitUmlaut = doc([mkSeg(1, 'Beat Bühler aus Grüsch')])
    expect(renderHook(() => useSuche(mitUmlaut, 'buehler')).result.current.treffer)
      .toEqual([{ kind: 'segment', id: 1 }])
    const mitDigraph = doc([mkSeg(1, 'Beat Buehler aus Gruesch')])
    expect(renderHook(() => useSuche(mitDigraph, 'Bühler')).result.current.treffer)
      .toEqual([{ kind: 'segment', id: 1 }])
  })

  it('faltet auch ß und fremde Akzente — gemischtsprachige Projekte', () => {
    const d = doc([mkSeg(1, 'Über die Straße nach Genève')], { annotations: ['Café am Öhrli'] })
    for (const [q, ort] of [['strasse', { kind: 'segment', id: 1 }], ['geneve', { kind: 'segment', id: 1 }],
                            ['ueber', { kind: 'segment', id: 1 }], ['cafe', { kind: 'annotation', index: 0 }],
                            ['oehrli', { kind: 'annotation', index: 0 }]] as const) {
      expect(renderHook(() => useSuche(d, q as string)).result.current.treffer).toEqual([ort])
    }
  })

  it('zerlegt angeliefertes u+Trema wird wie ü behandelt (NFC vor der Faltung)', () => {
    // ZERLEGT gebaut (u + U+0308), nicht als Umlaut-Literal: sonst pruefte der Test
    // dasselbe wie der vorige, und das fuehrende normalize('NFC') liesse sich spurlos
    // entfernen. Ohne NFC zerfaellt das Zeichen erst im NFD-Schritt zu blossem u — die
    // Digraphen-Ersetzung liefe daran vorbei, und 'buehler' faende es nicht.
    const zerlegt = 'Beat Bühler'
    expect(zerlegt).not.toBe('Beat Bühler')   // Positivkontrolle: wirklich zwei Formen
    const d = doc([mkSeg(1, zerlegt)])
    expect(renderHook(() => useSuche(d, 'buehler')).result.current.treffer)
      .toEqual([{ kind: 'segment', id: 1 }])
  })

  it('findet die Notiz am Segment — als Treffer des Segments, nicht als eigener Ort', () => {
    // Seit #112 steht die Notiz sichtbar unter dem Segment. Sichtbarer Text, den die Suche
    // nicht findet, ist genau die Luecke, die #128 fuer die Kopffelder geschlossen hat.
    const d = doc([{ ...mkSeg(1, 'harmlos'), note: 'Zahl gegen die Aufnahme pruefen' }, mkSeg(2, 'nichts')])
    const { result } = renderHook(() => useSuche(d, 'aufnahme'))
    expect(result.current.treffer).toEqual([{ kind: 'segment', id: 1 }])
    expect(result.current.segmentTreffer).toEqual(new Set([1]))
  })

  it('ein Feld/Segment/Annotation = ein Treffer, auch bei mehrfachem Vorkommen', () => {
    const d = doc([mkSeg(1, 'aras aras aras')], { summary: 'aras aras' })
    const { result } = renderHook(() => useSuche(d, 'aras'))
    expect(result.current.treffer.length).toBe(2) // summary + segment, nicht 5
  })

  it('doc null/undefined -> leer', () => {
    expect(renderHook(() => useSuche(null, 'x')).result.current.treffer).toEqual([])
    expect(renderHook(() => useSuche(undefined, 'x')).result.current.treffer).toEqual([])
  })
})
