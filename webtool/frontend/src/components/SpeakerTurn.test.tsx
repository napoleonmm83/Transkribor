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
