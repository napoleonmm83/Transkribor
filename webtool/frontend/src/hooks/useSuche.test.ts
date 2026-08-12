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
