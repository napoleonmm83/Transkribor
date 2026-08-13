import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HomeGallery } from './HomeGallery'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'
import { JobProvider } from '@/hooks/useActiveJob'
import { EditorBrueckeProvider } from '@/hooks/useEditorBruecke'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

// Seit Task 5 haengt ProjektDatenProvider selbst an useActiveJob (onSettled fuer die
// Zusammenlegung) -- ohne JobProvider drumherum wirft er "ausserhalb JobProvider".
const zeigen = () =>
  render(<MemoryRouter><JobProvider><ProjektDatenProvider><EditorBrueckeProvider>
    <HomeGallery />
  </EditorBrueckeProvider></ProjektDatenProvider></JobProvider></MemoryRouter>)

describe('HomeGallery', () => {
  // Der ProjektDatenProvider adoptiert laufende Jobs aus `active_jobs` und fragt sie ab --
  // ungemockt liefert das Automock undefined, und `.then` darauf ist eine unbehandelte
  // Ablehnung. 'running' laesst die Abfrage nach einem Durchgang stehen (kein onSettled,
  // also keine zusaetzlichen Listenabrufe); das Aufraeumen des Effekts beendet sie.
  beforeEach(() => vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: [] }))

  it('zeigt Karten mit Dateizahl', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 1, fertig: 1, geaendert: 0, active_jobs: [] },
    ])
    zeigen()
    expect(await screen.findByText('Demo')).toBeInTheDocument()
    expect(screen.getByText(/1 Datei/)).toBeInTheDocument()
  })

  it('legt aus dem Leerzustand ein Projekt an (createProject aufgerufen)', async () => {
    // #69: „+ Neues Projekt" steht nicht mehr im Seitenkopf — der Knopf der Seitenleiste
    // ist auf JEDER Route sichtbar. Im Leerzustand bleibt ein eigener Knopf: der
    // beantwortet „hier ist noch nichts", nicht „lege noch eines an".
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.createProject).mockResolvedValue({ ok: true, name: 'Neu' })
    zeigen()
    fireEvent.click(await screen.findByText('Erstes Projekt anlegen'))
    fireEvent.change(screen.getByLabelText('Projektname'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText('Anlegen'))
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('Neu'))
  })

  it('traegt den Anlege-Knopf NICHT ein zweites Mal, sobald es Projekte gibt (#69)', async () => {
    // Der Knopf steht seit PR #68 in der Seitenleiste — auf JEDER Route. Wortgleich noch
    // einmal im Seitenkopf ist kein zweiter Weg, sondern die Frage, ob beide dasselbe tun.
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Alpha', dateien: 1, fertig: 1, geaendert: 0 }])
    zeigen()
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('+ Neues Projekt')).toBeNull()
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
    // Seit dem ProjektMenue liegt Loeschen hinter dem ⋯ — pointerDown, weil Radix darauf
    // oeffnet und nicht auf click (dasselbe Muster wie in Sidebar.test/AppShell.test).
    fireEvent.pointerDown(screen.getByLabelText('Aktionen für „Alt“'),
      new PointerEvent('pointerdown', { bubbles: true, ctrlKey: false, button: 0 }))
    fireEvent.click(await screen.findByText('Löschen'))
    fireEvent.change(await screen.findByLabelText(/Projektname best/), { target: { value: 'Alt' } })
    fireEvent.click(screen.getByRole('button', { name: /^L/ }))
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('Alt'))
  })

  it('laesst sich aus der Zeilenliste umbenennen', async () => {
    // Der Punkt des ProjektMenues: vorher gab es in der Uebersicht NUR den Papierkorb —
    // umbenennen konnte man ein Projekt ausschliesslich in der Seitenleiste.
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alt', dateien: 1, fertig: 1, geaendert: 100, active_jobs: [] },
    ])
    vi.mocked(api.renameProject).mockResolvedValue({ name: 'Neu' })
    zeigen()
    await screen.findByText('Alt')
    fireEvent.pointerDown(screen.getByLabelText('Aktionen für „Alt“'),
      new PointerEvent('pointerdown', { bubbles: true, ctrlKey: false, button: 0 }))
    fireEvent.click(await screen.findByText('Umbenennen'))
    fireEvent.change(await screen.findByLabelText('Neuer Name'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }))
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith('Alt', 'Neu'))
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
