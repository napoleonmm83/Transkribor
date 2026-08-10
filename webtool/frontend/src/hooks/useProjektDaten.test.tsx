import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ProjektDatenProvider, useProjekte, useDateien } from './useProjektDaten'
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

describe('ProjektDatenProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'P', dateien: 2, fertig: 1, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({
      name: 'P', files: [{ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }],
    })
  })
  afterEach(() => vi.useRealTimers())

  it('ruft /api/projects EINMAL, egal wie viele Verbraucher lesen', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <ProjektDatenProvider><Verbraucher name="a" /><Verbraucher name="b" /></ProjektDatenProvider>
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
        <ProjektDatenProvider><Dateien /></ProjektDatenProvider>
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
        <ProjektDatenProvider><Dateien /></ProjektDatenProvider>
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
        <ProjektDatenProvider><Dateien /></ProjektDatenProvider>
      </MemoryRouter>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(api.getProjectFiles).toHaveBeenCalledTimes(1)
  })
})
