import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Transcript } from './Transcript'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { EditDoc, Word } from '@/lib/types'

const mkWords = (probs: number[]): Word[] =>
  probs.map((p, i) => ({ word: `w${i}`, start: i, end: i + 1, probability: p }))

const doc: EditDoc = {
  base: 'b', project: 'P', audio: 'a.wav', language: 'de',
  human_edited: false, context: '', speakers: ['Interviewer', 'Befragte Person'],
  segments: [
    { id: 1, start: 0, end: 2, speaker: 'Interviewer', raw_text: 'w0 w1 w2', text: 'w0 w1 w2',
      words: mkWords([1, 0.2, 1]), flags: { hallucination: false, silence: false, low_conf: false }, note: '' },
    { id: 2, start: 2, end: 4, speaker: 'Befragte Person', raw_text: 'hallo', text: 'hallo',
      words: mkWords([1]), flags: { hallucination: false, silence: false, low_conf: false }, note: '' },
  ],
  annotations: [],
}

describe('Transcript', () => {
  it('rendert Sprecher-Labels und markiert unkorrigierte unsichere Wörter', () => {
    render(<TooltipProvider><Transcript doc={doc} thr={{ yellow: 0.6, red: 0.4 }} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    // Sprecher-Name erscheint sowohl im Block-Kopf als auch in der Per-Segment-Combobox.
    expect(screen.getAllByText(/Interviewer/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Befragte Person/).length).toBeGreaterThan(0)
    expect(screen.getByText('w1')).toHaveClass('u-red')
  })

  it('zeigt "Keine Datei geöffnet" nicht während des Ladens', () => {
    render(<Transcript doc={null} loading thr={{ yellow: 0.6, red: 0.4 }} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} />)
    expect(screen.queryByText(/Keine Datei geöffnet/)).not.toBeInTheDocument()
  })
})
