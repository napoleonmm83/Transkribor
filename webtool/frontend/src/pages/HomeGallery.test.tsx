import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HomeGallery } from './HomeGallery'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

// Seit Task 5 haengt ProjektDatenProvider selbst an useActiveJob (onSettled fuer die
// Zusammenlegung) -- ohne JobProvider drumherum wirft er "ausserhalb JobProvider".
const zeigen = () =>
  render(<MemoryRouter><JobProvider><ProjektDatenProvider><HomeGallery /></ProjektDatenProvider></JobProvider></MemoryRouter>)

describe('HomeGallery', () => {
  it('zeigt Karten mit Dateizahl', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 1, fertig: 1, geaendert: 0, active_jobs: [] },
    ])
    zeigen()
    expect(await screen.findByText('Demo')).toBeInTheDocument()
    expect(screen.getByText(/1 Datei/)).toBeInTheDocument()
  })

  it('legt ein Projekt an und navigiert (createProject aufgerufen)', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.createProject).mockResolvedValue({ ok: true, name: 'Neu' })
    zeigen()
    fireEvent.click(await screen.findByText('+ Neues Projekt'))
    fireEvent.change(screen.getByLabelText('Projektname'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText('Anlegen'))
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('Neu'))
  })

  it('zeigt laufende Projekte als Karten', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alpha', dateien: 8, fertig: 3, geaendert: 0, active_jobs: [{ id: '1', kind: 'correct' }] },
    ])
    zeigen()
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')
  })

  it('listet die Projekte NICHT nochmal als Zeilen — die stehen in der Seitenleiste', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Ruhig', dateien: 2, fertig: 2, geaendert: 0 },
    ])
    zeigen()
    await waitFor(() => expect(screen.getByText(/Zuletzt geändert/)).toBeInTheDocument())
    expect(screen.queryByLabelText('Projekte durchsuchen')).not.toBeInTheDocument()
  })

  it('laesst sich aus der Zeilenliste loeschen', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alt', dateien: 1, fertig: 1, geaendert: 100, active_jobs: [] },
    ])
    vi.mocked(api.deleteProject).mockResolvedValue(undefined)
    zeigen()
    await screen.findByText('Alt')
    fireEvent.click(screen.getByLabelText(/Projekt Alt l/))
    fireEvent.change(screen.getByLabelText(/Projektname best/), { target: { value: 'Alt' } })
    fireEvent.click(screen.getByRole('button', { name: /^L/ }))
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('Alt'))
  })

  it('zeigt einen Ladezustand statt "Noch keine Projekte", solange die Liste unterwegs ist', async () => {
    let loese: ((p: []) => void) | null = null
    vi.mocked(api.listProjects).mockReturnValue(new Promise(r => { loese = r }))
    zeigen()
    expect(await screen.findByText(/werden geladen/)).toBeInTheDocument()
    expect(screen.queryByText('Noch keine Projekte')).not.toBeInTheDocument()
    await act(async () => { loese!([]) })
    expect(await screen.findByText('Noch keine Projekte')).toBeInTheDocument()
  })

  it('zeigt einen Fehlerzustand statt "Noch keine Projekte", wenn das Laden scheitert', async () => {
    vi.mocked(api.listProjects).mockRejectedValue(new Error('offline'))
    zeigen()
    expect(await screen.findByText(/konnten nicht geladen werden/)).toBeInTheDocument()
    expect(screen.queryByText('Noch keine Projekte')).not.toBeInTheDocument()
    // Erneut versuchen ruft den Endpunkt noch einmal.
    const versuche = vi.mocked(api.listProjects).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
    await waitFor(() => expect(vi.mocked(api.listProjects).mock.calls.length).toBeGreaterThan(versuche))
  })
})
