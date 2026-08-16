import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EditorView } from './EditorView'
import type { EditDoc } from '@/lib/types'

// Issue #128: Suche findet Begriffe in Kontext/Zusammenfassung/Anmerkungen, nicht nur in
// Segmenten. Eigene Datei, weil vi.mock dateiscoped ist und hier ein Dokument mit gefuellten
// Kopffeldern gebraucht wird (die segment-only-Tests in EditorView.suche.test.tsx haben leer).
const doc: EditDoc = {
  base: 'b', project: 'P', audio: 'a.wav', language: 'de', human_edited: false,
  context: 'Interview am Foodfestival.', summary: 'Es geht um Trüffel und Brioche.',
  speakers: [], annotations: ['Ein eigener Trüffelhund namens Jack.'],
  segments: [
    { id: 1, start: 0, end: 1, speaker: 'A', raw_text: 'David erzählt', text: 'David erzählt', words: [],
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

describe('EditorView Suche in Kopf/Anmerkungen (#128)', () => {
  it('Treffer in der Zusammenfassung: Ring aufs Feld, Segmente ausgegraut, Zähler 1/1', () => {
    view()
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'brioche' } })
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
    const summary = document.querySelector('[title^="Zusammenfassung bearbeiten"]')!
    expect(summary).toHaveClass('ring-yellow-400')
    // Kontext trifft nicht -> ausgegraut; Segment ebenfalls.
    expect(document.querySelector('[title^="Kontext bearbeiten"]')).toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('opacity-40')
  })

  it('Treffer in den Anmerkungen springt und durchsucht diese', () => {
    view()
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'jack' } })
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
    expect(document.querySelector('[data-annot="0"]')).toHaveClass('ring-yellow-400')
  })

  it('ein Begriff in Kontext + Segment + Anmerkung zaehlt drei Treffer in Dokumentreihenfolge', () => {
    view()
    // 'Trüffel' steht in summary UND annotation — Kontext und Segment nicht. Beide separat:
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'Trüffel' } })
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    // ▲ zur nächsten: Anmerkung bekommt den Ring.
    fireEvent.click(screen.getByLabelText('Nächster Treffer'))
    expect(document.querySelector('[data-annot="0"]')).toHaveClass('ring-yellow-400')
  })
})
