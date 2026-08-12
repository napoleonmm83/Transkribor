import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EditorView } from './EditorView'
import type { EditDoc } from '@/lib/types'

// Eigener Test fuer die Such-Verdrahtung. Das uebrige EditorView.test.tsx nutzt reale Hooks
// (useDoc ueber api.getDoc), hier wird useDoc direkt gemockt, um Dokumentzustand und -wechsel
// deterministisch zu halten. vi.mock ist dateiscoped, darum eine eigene Datei.
const doc: EditDoc = {
  base: 'b', project: 'P', audio: 'a.wav', language: 'de',
  human_edited: false, context: '', speakers: [], annotations: [],
  segments: [
    { id: 1, start: 0, end: 1, speaker: 'A', raw_text: 'Aras kam', text: 'Aras kam', words: [],
      flags: { hallucination: false, low_conf: false }, note: '' },
    { id: 2, start: 1, end: 2, speaker: 'A', raw_text: 'sonstiges', text: 'sonstiges', words: [],
      flags: { hallucination: false, low_conf: false }, note: '' },
  ],
}

vi.mock('@/hooks/useDoc', () => ({
  useDoc: () => ({ doc, dirty: false, stand: 'gespeichert' as const, loading: false,
    updateSegment: vi.fn(), updateDoc: vi.fn(), renameSpeaker: vi.fn(),
    exportDownload: vi.fn(), reload: vi.fn(), vergiss: vi.fn() }),
}))
vi.mock('@/hooks/useEditorBruecke', () => ({ useEditorMelden: () => {} }))
vi.mock('@/hooks/useActiveJob', () => ({ useActiveJob: () => ({ onSettled: () => () => {} }) }))
vi.mock('@/components/PlayerDock', () => ({ PlayerDock: () => null }))

function view() {
  return render(<TooltipProvider>
    <MemoryRouter initialEntries={['/p/P/b']}>
      <Routes><Route path="/p/:project/:base" element={<EditorView />} /></Routes>
    </MemoryRouter>
  </TooltipProvider>)
}

describe('EditorView Suche', () => {
  it('Tippen graut Nicht-Treffer aus, aktiver Treffer mit Ring, Zähler "1 / 1"', () => {
    view()
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'aras' } })
    expect(document.querySelector('[data-seg-id="2"]')).toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('ring-yellow-400')
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
  })

  it('▲ springt zum nächsten Treffer, ✕ leert die Suche', () => {
    view()
    // 's' kommt in 'Aras' (seg 1) und 'sonstiges' (seg 2) vor -> 2 Treffer
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 's' } })
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Nächster Treffer'))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Suche leeren'))
    expect(document.querySelector('[data-seg-id="2"]')).not.toHaveClass('opacity-40')
    expect(screen.queryByLabelText('Nächster Treffer')).not.toBeInTheDocument()
  })

  it('Such-Sprung berührt die Wiedergabe-Position nicht', () => {
    // Regression: der Such-Automat darf activeId (Playback) nicht anstasten — eigene Spur.
    view()
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 's' } })
    // aktiver Treffer = seg 1 (erster Treffer in Dokumentreihenfolge): gelber Such-Ring, nicht Playback.
    const aktiver = document.querySelector('[data-seg-id="1"]')!
    expect(aktiver).toHaveClass('ring-yellow-400')
    expect(aktiver).not.toHaveClass('ring-primary/60')
    // Navigation bewegt nur den gelben Ring; kein Segment kommt in den Playback-Zustand:
    fireEvent.click(screen.getByLabelText('Nächster Treffer'))
    for (const id of [1, 2]) {
      const el = document.querySelector(`[data-seg-id="${id}"]`)!
      expect(el).not.toHaveClass('bg-primary/15')
      expect(el).not.toHaveClass('ring-primary/60')
    }
    expect(document.querySelector('[data-seg-id="2"]')).toHaveClass('ring-yellow-400')
  })
})
