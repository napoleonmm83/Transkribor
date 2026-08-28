import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SpeakerTurn } from './SpeakerTurn'
import type { Segment, Turn } from '@/lib/types'

const mkSeg = (id: number, text: string): Segment => ({
  id, start: 0, end: 1, speaker: 'A', raw_text: text, text, words: [],
  flags: { hallucination: false, low_conf: false }, note: '',
})

describe('SpeakerTurn Suche', () => {
  it('graut Nicht-Treffer aus und hebt den aktiven Treffer mit gelbem Ring hervor', () => {
    const turn: Turn = { key: 'k', speaker: 'A', segments: [
      mkSeg(1, 'Aras'), mkSeg(2, 'nix'), mkSeg(3, 'Aras'),
    ] }
    render(<TooltipProvider><SpeakerTurn turn={turn} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} speakerOptions={['A']}
      sucheAktiv trefferIds={new Set([1, 3])} suchAktivId={3} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="2"]')).toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="3"]')).toHaveClass('ring-yellow-400')
    expect(document.querySelector('[data-seg-id="1"]')).not.toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="1"]')).not.toHaveClass('ring-yellow-400')
  })

  it('ohne Such-Props wird nichts ausgraut (Default)', () => {
    const turn: Turn = { key: 'k', speaker: 'A', segments: [mkSeg(1, 'Aras')] }
    render(<TooltipProvider><SpeakerTurn turn={turn} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} speakerOptions={['A']} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="1"]')).not.toHaveClass('opacity-40')
  })
})

describe('SpeakerTurn Sprecherwahl', () => {
  it('bleibt ohne Zeigegeraet sichtbar (#428)', () => {
    // Hier ist ohne Zeiger nicht ein Aktionsmenue unerreichbar, sondern die SPRECHERWAHL
    // selbst — die Kernfunktion des Editors. Im Issue-Text fehlte diese Fundstelle; sie
    // kam beim Nachmessen dazu.
    //
    // Geprueft wird die KLASSE, nicht die Sichtbarkeit: jsdom rechnet keine Media Queries,
    // `toBeVisible()` waere blind fuer genau die Regel, um die es geht.
    //
    // Angefasst wird ueber `data-seg-id` statt ueber den Text: der Sprechername 'A' steht
    // auch in der Kopfzeile des Redebeitrags, `getByText('A')` waere mehrdeutig. Die
    // Sprecherwahl ist das Geschwister VOR der Segmentzeile.
    const turn: Turn = { key: 'k', speaker: 'A', segments: [mkSeg(1, 'Aras')] }
    render(<TooltipProvider><SpeakerTurn turn={turn} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} speakerOptions={['A']} /></TooltipProvider>)
    const wahl = document.querySelector('[data-seg-id="1"]')?.previousElementSibling
    expect(wahl).not.toBeNull()
    expect(wahl?.classList.contains('any-pointer-coarse:opacity-100')).toBe(true)
  })
})
