import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SegmentView } from './SegmentView'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Segment } from '@/lib/types'

const mkSeg = (overrides: Partial<Segment>): Segment => ({
  id: 1, start: 0, end: 2, speaker: 'Interviewer',
  raw_text: 'w0 w1 w2', text: 'w0 w1 w2',
  words: [
    { word: 'w0', start: 0, end: 1, probability: 1 },
    { word: 'w1', start: 1, end: 1.5, probability: 0.2 },
    { word: 'w2', start: 1.5, end: 2, probability: 1 },
  ],
  flags: { hallucination: false, silence: false, low_conf: false }, note: '',
  ...overrides,
})

const thr = { yellow: 0.6, red: 0.4 }

describe('SegmentView', () => {
  it('rendert ein korrigiertes Segment als reinen Text ohne Unsicherheits-Markup', () => {
    const seg = mkSeg({ text: 'korrigierter Text' }) // != raw_text -> isCorrected
    render(<TooltipProvider><SegmentView seg={seg} thr={thr} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(screen.getByText('korrigierter Text')).toBeInTheDocument()
    expect(document.querySelector('.u-red')).toBeNull()
    expect(document.querySelector('.u-yellow')).toBeNull()
  })

  it('zeigt bei korrigierten Segmenten den 🔍-Reveal-Toggle, der die Roh-Wörter einblendet', () => {
    const seg = mkSeg({ text: 'korrigierter Text' })
    render(<TooltipProvider><SegmentView seg={seg} thr={thr} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(screen.queryByText('w1')).toBeNull()
    fireEvent.click(screen.getByTitle('Roh-Wörter anzeigen'))
    expect(screen.getByText('w1')).toHaveClass('u-red')
  })

  it('zeigt bei unkorrigierten Segmenten keinen Reveal-Toggle', () => {
    const seg = mkSeg({}) // text === raw_text -> nicht korrigiert
    render(<TooltipProvider><SegmentView seg={seg} thr={thr} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(screen.queryByTitle('Roh-Wörter anzeigen')).toBeNull()
  })
})
