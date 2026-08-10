import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProjectWorkspace } from './ProjectWorkspace'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'
import type { Settings, ProjectFile } from '@/lib/types'

vi.mock('@/lib/api')

const einstellungen = (s: Partial<Settings>) =>
  vi.mocked(api.getSettings).mockResolvedValue({ ai_ready: true, ai_reason: '', ...s } as Settings)

describe('ProjectWorkspace (Stub)', () => {
  beforeEach(() => einstellungen({}))          // Korrektur-Gate: eingerichtet, sofern nicht anders gesagt

  const nurDemo = () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
      files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }] })
  }

  it('sperrt Korrigieren, solange kein KI-Anbieter eingerichtet ist', async () => {
    // Sonst startet der Job, überspringt jede Datei und endet grün — sieht aus wie Erfolg.
    nurDemo()
    einstellungen({ ai_ready: false, ai_reason: 'Kein API-Key hinterlegt.' })
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Korrigieren' })).toBeDisabled())
    expect(screen.getAllByTitle(/Kein API-Key hinterlegt/)).toHaveLength(2)   // Projekt + Datei
    expect(screen.getByRole('button', { name: 'Transkribieren' })).not.toBeDisabled()
  })

  it('lässt Korrigieren zu, wenn ein Anbieter eingerichtet ist', async () => {
    nurDemo()
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'Korrigieren' })).not.toBeDisabled()
  })

  it('listet Dateien des Projekts mit Links', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
      files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }] })
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'S1' })).toBeInTheDocument()
  })

  it('zeigt Live-Phase, wenn ein Job fuer das Projekt laeuft', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [{ id: 'j1', kind: 'correct' }] },
    ])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
      files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }] })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: ['→ Verifiziere S1 (Treue gegen Roh) …'] })
    const { JobProvider } = await import('@/hooks/useActiveJob')
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider intervalMs={5}>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    // Job-Leiste (mit Abbrechen) UND Pille an der Datei
    expect(await screen.findByText('Verifizieren S1…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Abbrechen/ })).toBeInTheDocument()
  })

  it('verfolgt Transkription und Korrektur desselben Projekts nebeneinander', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 0, fertig: 0, geaendert: 0,
        active_jobs: [{ id: 'j1', kind: 'correct' }, { id: 'j2', kind: 'transcribe' }] },
    ])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [
      { base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false },
      { base: 'S2', has_audio: true, has_raw: false, has_edit: false, has_md: false }] })
    vi.mocked(api.getJob).mockImplementation(async (id: string) => id === 'j1'
      ? { status: 'running', lines: ['→ Korrigiere S1 …'] }
      : { status: 'running', lines: ['[Demo] -> transkribiere S2 …', ' 40%|##| 40/100'] })
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider intervalMs={5}>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Korrigieren S1…')).toBeInTheDocument()
    expect(await screen.findByText('Transkribieren S2 · 40%')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Abbrechen/ })).toHaveLength(2)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  })

  it('zeigt NICHT den Status einer gleichnamigen Datei aus einem anderen Projekt', async () => {
    // 'Timeline 1' liegt real in mehreren Projekten — ohne Projekt-Filter wuerde die Pille
    // den Fortschritt des fremden Jobs anzeigen.
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] },
      { name: 'Anderes', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [{ id: 'fremd', kind: 'correct' }] },
    ])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
      files: [{ base: 'Timeline 1', has_audio: true, has_raw: true, has_edit: false, has_md: false }] })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: ['→ Korrigiere Timeline 1 …'] })
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider intervalMs={5}>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'Timeline 1' })).toBeInTheDocument()
    expect(screen.queryByText('Korrigieren Timeline 1…')).not.toBeInTheDocument()   // keine Job-Leiste
    expect(screen.queryByRole('button', { name: /Abbrechen/ })).not.toBeInTheDocument()
  })

  it('holt die Dateiliste neu, wenn sich dateien/fertig im Summenpoll aendern -- OHNE dass ein Job terminal wird (W1)', async () => {
    // Vor dem Fix fror die Dateiliste ein, solange ein Job lief: refreshFiles() kam nur ueber
    // onSettled (Lauf-ENDE). Zehn Aufnahmen zu je ~18s waeren damit erst nach dem GANZEN Lauf
    // oeffenbar, statt Datei fuer Datei. Hier steht kein Job -- nur der Summenpoll aendert sich.
    // Fake Timer MUESSEN vor dem render() aktiv sein, sonst legt useProjects sein setInterval
    // schon auf den echten Timer, und advanceTimersByTimeAsync bewegt ihn nie. RTL-eigenes
    // waitFor kennt vitest-Fake-Timer nicht (nur `jest`) -- es wuerde mit dem eingefrorenen
    // globalen setTimeout selbst haengen bleiben. Darum hier advanceTimersByTimeAsync statt
    // waitFor: das dreht die Uhr UND wartet die dabei ausgeloesten Promise-Ketten ab.
    vi.useFakeTimers()
    try {
      vi.mocked(api.listProjects)
        .mockResolvedValueOnce([{ name: 'Demo', dateien: 1, fertig: 0, geaendert: 0, active_jobs: [] }])
        .mockResolvedValue([{ name: 'Demo', dateien: 2, fertig: 0, geaendert: 0, active_jobs: [] }])
      vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
        files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }] })
      render(
        <MemoryRouter initialEntries={['/p/Demo']}>
          <JobProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
          </JobProvider>
        </MemoryRouter>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })    // Mount + Anfangsfetches abwarten
      // Ab hier die Basis nehmen statt eine absolute Zahl anzunehmen: der Uebergang von "p noch
      // unbekannt" zu "p geladen" loest den neuen Effekt (dessen Deps sich dabei aendern) selbst
      // schon einmal aus -- das ist Teil des Fixes, nicht Rauschen, das die Zaehlung verfaelschen soll.
      const basis = vi.mocked(api.getProjectFiles).mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(4000) })  // useProjects pollt alle 4s
      // dateien 1 -> 2 im Summenpoll muss OHNE terminalen Job eine weitere Dateiliste-Anfrage ausloesen.
      expect(vi.mocked(api.getProjectFiles).mock.calls.length).toBeGreaterThan(basis)
    } finally {
      vi.useRealTimers()
    }
  })

  it('zeigt "Noch keine Dateien" nicht, solange die Dateiliste noch unterwegs ist (M2)', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    let loese: ((v: { name: string; files: ProjectFile[] }) => void) | null = null
    vi.mocked(api.getProjectFiles).mockReturnValue(new Promise(r => { loese = r }))
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    // Zusammenfassung ist da (Projektname im Titel), die Dateiliste haengt noch.
    expect(await screen.findByRole('heading', { name: 'Demo' })).toBeInTheDocument()
    expect(screen.queryByText(/Noch keine Dateien/)).not.toBeInTheDocument()
    await act(async () => { loese!({ name: 'Demo', files: [] }) })
    expect(await screen.findByText(/Noch keine Dateien/)).toBeInTheDocument()
  })

  it('zeigt einen Fehlerzustand statt "Noch keine Dateien", wenn die Dateiliste nicht laedt (M2)', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockRejectedValue(new Error('offline'))
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/nicht geladen werden/)).toBeInTheDocument()
    expect(screen.queryByText(/Noch keine Dateien/)).not.toBeInTheDocument()
    // Erneut versuchen ruft den Endpunkt noch einmal.
    const versuche = vi.mocked(api.getProjectFiles).mock.calls.length
    screen.getByRole('button', { name: 'Erneut versuchen' }).click()
    await waitFor(() => expect(vi.mocked(api.getProjectFiles).mock.calls.length).toBeGreaterThan(versuche))
  })
})
