import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { ProjektDatenProvider, useProjekte, useDateien } from './useProjektDaten'
import { JobProvider, useActiveJob } from './useActiveJob'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

function Verbraucher({ name }: { name: string }) {
  const { projects } = useProjekte()
  return <span>{name}:{projects.length}</span>
}
function Dateien() {
  const { projekt, files } = useDateien()
  return <span>dateien:{projekt ?? '-'}:{files.length}</span>
}
function Wechsler({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(to)}>wechsle</button>
}
/** Simuliert die Discovery aus EditorView/Leiste: ein Job wird adoptiert, der NICHT ueber
 *  diesen Provider gestartet wurde (z.B. "Korrigieren" in der Arbeitsflaeche, waehrend hier
 *  eine andere Seite haengt). Der Provider selbst adoptiert nichts -- das bleibt Sache der
 *  Seiten -- aber sein onSettled-Effekt muss trotzdem feuern. */
function Adoptieren() {
  const { adopt } = useActiveJob()
  return <button onClick={() => adopt('j1', 'P', 'correct')}>adopt</button>
}

describe('ProjektDatenProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'P', dateien: 2, fertig: 1, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({
      name: 'P', files: [{ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }],
    })
  })
  afterEach(() => vi.useRealTimers())

  it('holt Projekte und Dateien neu, wenn ein FREMD gestarteter Job fertig wird', async () => {
    // Verschoben aus EditorView.test.tsx (Task 5): der Effekt stand vorher wortgleich in
    // EditorView UND ProjectWorkspace und zieht jetzt hier in den Provider -- der Job kommt
    // ueber adopt() herein (Discovery einer Seite), nicht ueber einen hier gestarteten Aufruf.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [] })
    render(
      <MemoryRouter initialEntries={['/p/P']}>
        <JobProvider intervalMs={5}>
          <ProjektDatenProvider><Dateien /><Adoptieren /></ProjektDatenProvider>
        </JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(api.getProjectFiles).toHaveBeenCalledTimes(1))
    expect(api.listProjects).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('adopt'))
    // JobProvider pollt getJob -> 'done' -> onSettled im Provider muss beide neu laden.
    await waitFor(() => expect(vi.mocked(api.getProjectFiles).mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(vi.mocked(api.listProjects).mock.calls.length).toBeGreaterThan(1))
  })

  it('ruft /api/projects EINMAL, egal wie viele Verbraucher lesen', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><ProjektDatenProvider><Verbraucher name="a" /><Verbraucher name="b" /></ProjektDatenProvider></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('a:1')).toBeInTheDocument())
    expect(screen.getByText('b:1')).toBeInTheDocument()
    // Der Kern der Aufgabe: zwei Leser, ein Abruf. Vorher waeren es zwei gewesen.
    expect(api.listProjects).toHaveBeenCalledTimes(1)
  })

  it('laedt die Dateien des Projekts aus der URL', async () => {
    render(
      <MemoryRouter initialEntries={['/p/P/a']}>
        <JobProvider><ProjektDatenProvider><Dateien /></ProjektDatenProvider></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('dateien:P:1')).toBeInTheDocument())
    expect(api.getProjectFiles).toHaveBeenCalledWith('P')
  })

  it('laedt die Dateiliste nach, wenn der Summenpoll eine Aenderung meldet', async () => {
    // Der Waechter aus EditorView/ProjectWorkspace, jetzt an EINER Stelle: aendert sich
    // dateien/fertig, hat sich auf der Platte etwas getan -- dann und nur dann neu laden.
    vi.useFakeTimers()
    render(
      <MemoryRouter initialEntries={['/p/P']}>
        <JobProvider><ProjektDatenProvider><Dateien /></ProjektDatenProvider></JobProvider>
      </MemoryRouter>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.getProjectFiles).toHaveBeenCalledTimes(1)

    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'P', dateien: 3, fertig: 1, geaendert: 0 }])
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(api.getProjectFiles).toHaveBeenCalledTimes(2)
  })

  it('laedt NICHT nach, wenn die Zahlen gleich bleiben', async () => {
    vi.useFakeTimers()
    render(
      <MemoryRouter initialEntries={['/p/P']}>
        <JobProvider><ProjektDatenProvider><Dateien /></ProjektDatenProvider></JobProvider>
      </MemoryRouter>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(api.getProjectFiles).toHaveBeenCalledTimes(1)
  })

  it('Projektwechsel loest keinen zusaetzlichen Aufruf aus ausser dem, den useProjectFiles selbst beim Wechsel macht', async () => {
    // A und B mit UNTERSCHIEDLICHEN Zahlen: das deckt genau den Wechsel-Schutz auf
    // (vorher.projekt === projekt in useProjektDaten.tsx). Mit gleichen Zahlen waere die
    // Zahlen-Bedingung fuer sich allein schon falsch, und die Gegenprobe koennte nie rot werden.
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'A', dateien: 2, fertig: 1, geaendert: 0 },
      { name: 'B', dateien: 5, fertig: 3, geaendert: 0 },
    ])
    render(
      <MemoryRouter initialEntries={['/p/A']}>
        <JobProvider><ProjektDatenProvider><Dateien /><Wechsler to="/p/B" /></ProjektDatenProvider></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('dateien:A:1')).toBeInTheDocument())
    const basis = vi.mocked(api.getProjectFiles).mock.calls.length

    fireEvent.click(screen.getByText('wechsle'))
    await waitFor(() => expect(screen.getByText('dateien:B:1')).toBeInTheDocument())
    // useProjectFiles ruft wegen des project-Wechsels (eigene Dependency) selbst neu -- das ist
    // der EINE erlaubte zusaetzliche Aufruf. Der Waechter im Provider darf keinen zweiten
    // draufsetzen, nur weil B andere Zahlen hat als A.
    expect(vi.mocked(api.getProjectFiles).mock.calls.length).toBe(basis + 1)
  })
})
