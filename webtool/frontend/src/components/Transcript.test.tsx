import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
      words: mkWords([1, 0.2, 1]), flags: { hallucination: false, low_conf: false }, note: '' },
    { id: 2, start: 2, end: 4, speaker: 'Befragte Person', raw_text: 'hallo', text: 'hallo',
      words: mkWords([1]), flags: { hallucination: false, low_conf: false }, note: '' },
  ],
  annotations: [],
}

describe('Transcript', () => {
  it('rendert Sprecher-Labels und markiert unkorrigierte unsichere Wörter', () => {
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} /></TooltipProvider>)
    // Sprecher-Name erscheint sowohl im Block-Kopf als auch in der Per-Segment-Combobox.
    expect(screen.getAllByText(/Interviewer/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Befragte Person/).length).toBeGreaterThan(0)
    expect(screen.getByText('w1')).toHaveClass('u-red')
  })

  it('Name im Block-Kopf benennt global um, nicht nur das Segment', () => {
    const renameSpeaker = vi.fn(), updateSegment = vi.fn()
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={updateSegment} renameSpeaker={renameSpeaker} /></TooltipProvider>)
    fireEvent.click(screen.getAllByTitle('Sprecher im ganzen Transkript umbenennen')[0])
    const input = screen.getByPlaceholderText('Sprecher…')
    fireEvent.change(input, { target: { value: 'Beni Dürr' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSpeaker).toHaveBeenCalledWith('Interviewer', 'Beni Dürr')
    expect(updateSegment).not.toHaveBeenCalled()
  })

  it('zeigt die Zusammenfassung vor dem Gespräch', () => {
    render(<TooltipProvider><Transcript doc={{ ...doc, summary: 'Es geht um Brot.' }}
      activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} /></TooltipProvider>)
    const zus = screen.getByText('Es geht um Brot.')
    expect(zus).toBeInTheDocument()
    // Vor dem ersten Segment: die Frage "worum geht es hier" stellt man beim Oeffnen.
    // Anker ist das Segment selbst, nicht sein Text — der wird wortweise gerendert
    // (Konfidenz-Faerbung), ein zusammenhaengender Textknoten existiert nicht.
    const erstesSegment = document.querySelector('[data-seg-id="1"]')!
    // compareDocumentPosition liefert eine Bitmaske — maskieren, nicht gleichsetzen.
    expect(zus.compareDocumentPosition(erstesSegment)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('ohne Zusammenfassung keine leere Rubrik', () => {
    // Vor diesem Feature geschriebene edit.json haben den Schluessel gar nicht.
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} /></TooltipProvider>)
    expect(screen.queryByText('Zusammenfassung')).not.toBeInTheDocument()
  })

  it('zeigt "Keine Datei geöffnet" nicht während des Ladens', () => {
    render(<Transcript doc={null} loading activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} />)
    expect(screen.queryByText(/Keine Datei geöffnet/)).not.toBeInTheDocument()
  })
})
