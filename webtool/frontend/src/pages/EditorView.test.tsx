import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
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
