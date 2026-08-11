import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSuche } from './useSuche'
import type { Segment } from '@/lib/types'

const mkSeg = (id: number, text: string, raw: string = text): Segment => ({
  id, start: 0, end: 1, speaker: 'A', raw_text: raw, text, words: [],
  flags: { hallucination: false, low_conf: false }, note: '',
})

describe('useSuche', () => {
  it('findet Treffer case-insensitive im korrigierten Text', () => {
    const segs = [mkSeg(1, 'Fuhat Aras kam 2012'), mkSeg(2, 'nichts hier')]
    const { result } = renderHook(() => useSuche(segs, 'aras'))
    expect(result.current.ids).toEqual([1])
    expect(result.current.count).toBe(1)
  })

  it('sucht im raw_text, wenn das Segment unkorrigiert ist (text === raw_text)', () => {
    // korrigiert (text != raw) -> sucht text, nicht raw:
    const a = renderHook(() => useSuche([mkSeg(1, 'Wiesental', 'Wiesenthal')], 'Wiesenthal'))
    expect(a.result.current.ids).toEqual([])
    // unkorrigiert (text === raw) -> sucht raw:
    const b = renderHook(() => useSuche([mkSeg(1, 'Wiesenthal')], 'Wiesenthal'))
    expect(b.result.current.ids).toEqual([1])
  })

  it('leeres Query -> keine Treffer', () => {
    const { result } = renderHook(() => useSuche([mkSeg(1, 'x')], ''))
    expect(result.current.ids).toEqual([])
    expect(result.current.count).toBe(0)
  })

  it('whitespace-Query -> keine Treffer', () => {
    const { result } = renderHook(() => useSuche([mkSeg(1, 'x')], '   '))
    expect(result.current.count).toBe(0)
  })

  it('erhaelt die Dokumentreihenfolge', () => {
    const segs = [mkSeg(5, 'Aras'), mkSeg(3, 'Aras'), mkSeg(7, 'Aras')]
    const { result } = renderHook(() => useSuche(segs, 'aras'))
    expect(result.current.ids).toEqual([5, 3, 7])
  })

  it('segments undefined -> leer', () => {
    const { result } = renderHook(() => useSuche(undefined, 'x'))
    expect(result.current.ids).toEqual([])
  })
})
