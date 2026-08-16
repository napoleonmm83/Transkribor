import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { EditorView } from './EditorView'
import { JobProvider } from '@/hooks/useActiveJob'
import { EditorBrueckeProvider, useEditorBruecke } from '@/hooks/useEditorBruecke'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as api from '@/lib/api'
import type { Settings, EditDoc } from '@/lib/types'

vi.mock('@/lib/api')
// Wavesurfer braucht Audio-Decoding, das jsdom nicht kann — fuer diese Tests reicht die
// Datenverdrahtung, nicht die Wellenform selbst.
vi.mock('@/components/Waveform', () => ({ Waveform: () => null }))

const einstellungen = (s: Partial<Settings>) =>
  vi.mocked(api.getSettings).mockResolvedValue({ ai_ready: true, ai_reason: '', ...s } as Settings)

const doc: EditDoc = {
  base: 'S1', project: 'Demo', audio: 'a.wav', language: 'de',
  human_edited: false, context: '', speakers: [], segments: [], annotations: [],
}

/** Liest die Bruecke von aussen — so wie es die Leiste in der Huelle tut. */
let bruecke: ReturnType<typeof useEditorBruecke>
function Leser() { bruecke = useEditorBruecke(); return null }

describe('EditorView (Stub)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    einstellungen({})
    vi.mocked(api.getDoc).mockResolvedValue(doc)
  })

  it('bringt KEIN eigenes main mit — das traegt die Huelle (#72)', () => {
    // Zwei `<main>` ineinander sind ungueltig. Seit `AppShell` das Sprungziel `#inhalt` als
    // `main` fuehrt, ist der Scroll-Behaelter hier ein schlichtes `div`. Dieser Test ist die
    // zweite Haelfte des Paars in AppShell.test.tsx: wer eines der beiden zurueckdreht,
    // bekommt hier oder dort ein rotes Signal.
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [] })
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={['/p/Demo/S1']}>
          <JobProvider><ProjektDatenProvider><EditorBrueckeProvider>
            <Routes><Route path="/p/:project/:base" element={<EditorView />} /></Routes>
          </EditorBrueckeProvider></ProjektDatenProvider></JobProvider>
        </MemoryRouter>
      </TooltipProvider>,
    )
    expect(document.querySelectorAll('main')).toHaveLength(0)
  })

  it('meldet das offene Dokument samt reload an die Huelle', async () => {
    // Die Huelle kann `dirty` nur abfragen und nur nachladen, wenn der Editor sich meldet --
    // ohne diese Verdrahtung sind K1 und K2 in der AppShell wirkungslos.
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [] })
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={['/p/Demo/S1']}>
          <JobProvider>
            <ProjektDatenProvider>
              <EditorBrueckeProvider>
                <Leser />
                <Routes><Route path="/p/:project/:base" element={<EditorView />} /></Routes>
              </EditorBrueckeProvider>
            </ProjektDatenProvider>
          </JobProvider>
        </MemoryRouter>
      </TooltipProvider>,
    )
    await act(async () => { await Promise.resolve() })
    expect(bruecke.current).toMatchObject({ project: 'Demo', base: 'S1', dirty: false })
    // reload muss das echte useDoc.reload sein, kein Platzhalter: der Beweis ist ein
    // zweiter getDoc-Aufruf.
    const vorher = vi.mocked(api.getDoc).mock.calls.length
    await act(async () => { bruecke.current!.reload() })
    expect(vi.mocked(api.getDoc).mock.calls.length).toBe(vorher + 1)
  })

  it('holt die Dateiliste neu, wenn sich dateien/fertig im Summenpoll aendern -- OHNE dass ein Job terminal wird (W1)', async () => {
    // Derselbe Fund wie bei ProjectWorkspace.test.tsx: onSettled feuert erst am Lauf-ENDE, eine
    // Korrektur (CLAUDE.md: 25 Minuten) haette den Editor bis dahin auf dem alten Stand gehalten.
    // Fake Timer vor render(): sonst legt useProjects sein setInterval auf den echten Timer,
    // und RTLs eigenes waitFor kennt vitest-Fake-Timer nicht -- advanceTimersByTimeAsync dreht
    // die Uhr UND wartet die dabei ausgeloesten Promise-Ketten ab.
    vi.useFakeTimers()
    try {
      vi.mocked(api.listProjects)
        .mockResolvedValueOnce([{ name: 'Demo', dateien: 1, fertig: 0, geaendert: 0, active_jobs: [] }])
        .mockResolvedValue([{ name: 'Demo', dateien: 1, fertig: 1, geaendert: 0, active_jobs: [] }])
      vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
        files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }] })
      render(
        <TooltipProvider>
          <MemoryRouter initialEntries={['/p/Demo/S1']}>
            <JobProvider>
              <ProjektDatenProvider>
                <EditorBrueckeProvider>
                  <Routes><Route path="/p/:project/:base" element={<EditorView />} /></Routes>
                </EditorBrueckeProvider>
              </ProjektDatenProvider>
            </JobProvider>
          </MemoryRouter>
        </TooltipProvider>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })    // Mount + Anfangsfetches abwarten
      // Basis statt absoluter Zahl: der Uebergang "p unbekannt" -> "p geladen" loest den neuen
      // Effekt (dessen Deps sich dabei aendern) selbst schon einmal aus -- Teil des Fixes.
      const basis = vi.mocked(api.getProjectFiles).mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(4000) })  // useProjects pollt alle 4s
      // fertig 0 -> 1 im Summenpoll muss OHNE terminalen Job eine weitere Dateiliste-Anfrage ausloesen.
      expect(vi.mocked(api.getProjectFiles).mock.calls.length).toBeGreaterThan(basis)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('#123 — Editor lädt nach ferngestarteter Korrektur neu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    einstellungen({})
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
      files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: true, has_md: false }] })
  })

  /** Job laeuft erst und wird dann terminal — so laesst sich der Reload-getDoc sauber vom Mount-
   *  getDoc trennen, und der dirty-Fall kann das Feld anpassen, BEVOR die Korrektur fertig wird. */
  const richten = (lines: string[]) => {
    let done = false
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 1, fertig: 0, geaendert: 0, active_jobs: [{ id: 'j1', kind: 'correct' }] },
    ])
    vi.mocked(api.getJob).mockImplementation(() =>
      Promise.resolve(done ? { status: 'done', lines } : { status: 'running', lines: [] }))
    const r = render(
      <TooltipProvider>
        <MemoryRouter initialEntries={['/p/Demo/S1']}>
          <JobProvider intervalMs={10}>
            <ProjektDatenProvider>
              <EditorBrueckeProvider>
                <Routes><Route path="/p/:project/:base" element={<EditorView />} /></Routes>
              </EditorBrueckeProvider>
            </ProjektDatenProvider>
          </JobProvider>
        </MemoryRouter>
      </TooltipProvider>,
    )
    return { container: r.container, fertig: () => { done = true } }
  }

  it('lädt das offene Dokument nach, wenn die Korrektur fertig wird (auch ferngestartet)', async () => {
    // perBase['S1']==='done' via 'apply: S1 -> edit.json' — der Wirkungsbereich dieses Laufs.
    const { fertig } = richten(['apply: S1 -> edit.json'])
    await waitFor(() => expect(api.getDoc).toHaveBeenCalledTimes(1))   // Mount
    fertig()
    await waitFor(() => expect(api.getDoc).toHaveBeenCalledTimes(2), { timeout: 3000 })
  })

  it('lädt NICHT nach, wenn die Datei übersprungen wurde (perBase skipped ändert nichts)', async () => {
    const { fertig } = richten(['apply: SKIP S1 (human_edited=true)'])  // perBase['S1']='skipped'
    await waitFor(() => expect(api.getDoc).toHaveBeenCalledTimes(1))
    const basis = vi.mocked(api.getProjectFiles).mock.calls.length
    fertig()
    // onSettled ist gelaufen (Dateiliste aktualisiert) -> der Editor-Listener hatte seinen Tick,
    // entschied aber 'skipped' und lud nicht nach.
    await waitFor(() => expect(vi.mocked(api.getProjectFiles).mock.calls.length).toBeGreaterThan(basis), { timeout: 3000 })
    expect(api.getDoc).toHaveBeenCalledTimes(1)
  })

  it('fragt bei ungespeicherten Änderungen nach und behält ohne Bestätigung die eigene Fassung', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      const { container, fertig } = richten(['apply: S1 -> edit.json'])
      await waitFor(() => expect(api.getDoc).toHaveBeenCalledTimes(1))
      // Dirty machen: Kontextfeld öffnen, ändern, übernehmen (updateDoc -> beruehrt -> dirty).
      await act(async () => { fireEvent.click(screen.getByTitle(/^Kontext bearbeiten/)) })
      const feld = container.querySelector('textarea')!
      await act(async () => {
        fireEvent.change(feld, { target: { value: 'meine Notiz' } })
        fireEvent.blur(feld)
      })
      fertig()
      await waitFor(() => expect(confirm).toHaveBeenCalled(), { timeout: 3000 })
      // Abbrechen -> eigene Fassung behalten: kein Reload (weiterhin nur der Mount-getDoc).
      expect(api.getDoc).toHaveBeenCalledTimes(1)
    } finally {
      confirm.mockRestore()
    }
  })
})
