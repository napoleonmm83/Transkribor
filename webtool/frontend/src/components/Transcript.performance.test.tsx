import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Transcript } from './Transcript'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as uncertainty from '@/lib/uncertainty'
import type { EditDoc, Segment } from '@/lib/types'

const tokenize = vi.spyOn(uncertainty, 'tokenizeUncertain')
const segment = (id: number): Segment => ({
  id, start: id, end: id + 1, speaker: 'A', raw_text: `roh ${id}`, text: `roh ${id}`,
  words: [{ word: `roh ${id}`, start: id, end: id + 1, probability: 1 }],
  flags: { hallucination: false, low_conf: false }, note: '',
})
const doc: EditDoc = {
  base: 'lang', project: 'P', audio: 'lang.mp3', language: 'de', human_edited: false,
  context: '', summary: '', speakers: ['A'], annotations: [],
  segments: Array.from({ length: 100 }, (_, i) => segment(i)),
}
const actions = {
  onPlaySeg: vi.fn(), onPlayTurn: vi.fn(), updateSegment: vi.fn(),
  updateDoc: vi.fn(), renameSpeaker: vi.fn(),
}
const view = (d: EditDoc, activeId: number | null) => (
  <TooltipProvider><Transcript doc={d} activeId={activeId} {...actions} /></TooltipProvider>
)

describe('Transcript — lange Dokumente', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rendert bei Wiedergabe nur das neue und bisher aktive Segment erneut', () => {
    const { rerender } = render(view(doc, null))
    tokenize.mockClear()
    rerender(view(doc, 50))
    expect(tokenize.mock.calls.map(([s]) => s.id)).toEqual([50])
    tokenize.mockClear()
    rerender(view(doc, 51))
    expect(tokenize.mock.calls.map(([s]) => s.id)).toEqual([50, 51])
    expect(document.querySelectorAll('[data-seg-id]')).toHaveLength(100)
  })

  it('bearbeitet ein Segment ohne Wortansichten anderer Segmente neu aufzubauen', () => {
    const { rerender } = render(view(doc, null))
    tokenize.mockClear()
    const changed = { ...doc, segments: doc.segments.map(s => s.id === 50 ? { ...s, note: 'Notiz' } : s) }
    rerender(view(changed, null))
    expect(tokenize.mock.calls.map(([s]) => s.id)).toEqual([50])
    expect(screen.getByText('Notiz')).toBeInTheDocument()
    fireEvent.click(screen.getAllByLabelText('Segment abspielen')[50])
    expect(actions.onPlaySeg).toHaveBeenCalledWith(changed.segments[50])
  })

  it('erzeugt Roh-Wörter einer korrigierten Fassung erst beim Öffnen', () => {
    const corrected = { ...doc, segments: [{ ...segment(0), text: 'korrigiert' }] }
    render(view(corrected, null))
    expect(tokenize).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('Roh-Wörter anzeigen'))
    expect(tokenize).toHaveBeenCalledTimes(1)
    expect(screen.getByText('roh 0')).toBeInTheDocument()
  })
})
