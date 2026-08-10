import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProjektPalette } from './ProjektPalette'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'
import type { Project } from '@/lib/types'

vi.mock('@/lib/api')

const demoProjects: Project[] = [
  { name: 'Alpha', dateien: 1, fertig: 1, geaendert: 2, active_jobs: [] },
  { name: 'Beta', dateien: 1, fertig: 0, geaendert: 1, active_jobs: [{ id: 'j1', kind: 'transcribe' }] },
]

function renderPalette(projects = demoProjects) {
  vi.mocked(api.listProjects).mockResolvedValue(projects)
  // Seit Task 3 sitzt der ProjektDatenProvider ueber den Routen: navigiert ein Test nach
  // /p/:project, ruft schon der Provider getProjectFiles -- unabhaengig davon, ob die
  // Zielseite (hier ein Stub-<div>) die Dateien je liest.
  vi.mocked(api.getProjectFiles).mockResolvedValue({ name: '', files: [] })
  // Der Provider adoptiert laufende Jobs aus `active_jobs` und fragt sie ab -- ungemockt
  // liefert das Automock undefined, und `.then` darauf ist eine unbehandelte Ablehnung.
  vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: [] })
  // Seit Task 5 haengt ProjektDatenProvider selbst an useActiveJob (onSettled fuer die
  // Zusammenlegung) -- ohne JobProvider drumherum wirft er "ausserhalb JobProvider".
  return render(
    <MemoryRouter initialEntries={['/']}>
      <JobProvider>
        <ProjektDatenProvider>
          <ProjektPalette />
          <Routes>
            <Route path="/" element={<div>Galerie</div>} />
            <Route path="/p/:project" element={<div>Projekt-Seite</div>} />
          </Routes>
        </ProjektDatenProvider>
      </JobProvider>
    </MemoryRouter>,
  )
}

describe('ProjektPalette', () => {
  it('öffnet mit Ctrl+K, schliesst mit Escape', async () => {
    renderPalette()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('filtert beim Tippen, Enter auf einem Treffer navigiert', async () => {
    renderPalette()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await waitFor(() => screen.getByPlaceholderText('Projekt suchen…'))
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    fireEvent.change(input, { target: { value: 'Beta' } })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('Projekt-Seite')).toBeInTheDocument())
  })

  // Alle drei Faelle aus dem Guard (ProjektPalette.tsx) einzeln -- ein Test, der nur
  // <input> prueft, liesse eine geloeschte textarea- oder contenteditable-Abfrage durch.
  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    // jsdom berechnet isContentEditable nicht (bekannte Luecke, jsdom/jsdom#1670) -- die
    // Eigenschaft wird darum direkt gesetzt. Das prueft den Codepfad in ProjektPalette.tsx,
    // nicht jsdoms contentEditable-Verhalten (das gibt es dort schlicht nicht).
    ['contenteditable', () => {
      const d = document.createElement('div')
      Object.defineProperty(d, 'isContentEditable', { value: true, configurable: true })
      d.tabIndex = 0
      return d
    }],
  ] as const)('greift nicht, waehrend in %s getippt wird', async (_art, bauen) => {
    renderPalette()
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())
    const feld = bauen()
    document.body.appendChild(feld)
    feld.focus()
    fireEvent.keyDown(feld, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    document.body.removeChild(feld)
  })

  // Das W2-Kuerzel ("pollt nur, waehrend die Palette offen ist") ist mit Task 3 hinfaellig:
  // die Palette hat gar keinen eigenen Poll-Schalter mehr, sie liest aus der geteilten Liste
  // im ProjektDatenProvider, die ohnehin fuer die Seitenleiste laeuft (unabhaengig vom
  // Offen-Zustand der Palette). Das Poll-Intervall selbst ist in useProjektDaten.test.tsx
  // geprueft, nicht mehr hier.
})
