import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { ProjectWorkspace } from './ProjectWorkspace'
import { JobProvider } from '@/hooks/useActiveJob'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'
import { EditorBrueckeProvider } from '@/hooks/useEditorBruecke'
import * as api from '@/lib/api'
import type { Settings, ProjectFile } from '@/lib/types'

vi.mock('@/lib/api')

const einstellungen = (s: Partial<Settings>) =>
  vi.mocked(api.getSettings).mockResolvedValue({ ai_ready: true, ai_reason: '', ...s } as Settings)

describe('ProjectWorkspace (Stub)', () => {
  beforeEach(() => {
    einstellungen({})
    // Projekt-Einstellungen default: leer — bestehende Tests sehen keine Sprach-Selects.
    vi.mocked(api.getProjektEinstellungen).mockResolvedValue(
      { sprache: 'de', korrektur: 'auto', mehrsprachig: false, sprach_choices: [], tiefen: [] })
  })

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
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
        </JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Korrigieren' })).toBeDisabled())
    expect(screen.getAllByTitle(/Kein API-Key hinterlegt/)).toHaveLength(1)   // Projektknopf
    expect(screen.getByRole('button', { name: 'Transkribieren' })).not.toBeDisabled()
    // Die Datei-Seite steckt seit der Zusammenlegung im ⋯-Menue und muss dort ebenso gesperrt
    // sein — sonst startet ein Klick dort den Job, den der Projektknopf gerade verweigert.
    // Seit Task 5 gibt es ZWEI ⋯-Menues im Workspace (das Projekt-Menue im Kopf + das Datei-Menue
    // je Zeile) — die Datei-spezifische Ansprache trennt sie.
    fireEvent.pointerDown(screen.getByRole('button', { name: /Aktionen für „S1/ }),
      { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(await screen.findByRole('menuitem', { name: 'Korrigieren' })).toHaveAttribute('data-disabled')
  })

  it('lässt Korrigieren zu, wenn ein Anbieter eingerichtet ist', async () => {
    nurDemo()
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
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
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
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
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
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
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
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
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
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
            <ProjektDatenProvider>
            <EditorBrueckeProvider>
              <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
              </EditorBrueckeProvider>
          </ProjektDatenProvider>
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
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
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
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
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

  const mitSprachen = () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [] })
    vi.mocked(api.getProjektEinstellungen).mockResolvedValue({
      sprache: 'ch', korrektur: 'auto', mehrsprachig: false,
      sprach_choices: [{ id: 'ch', label: 'Schweizerdeutsch', hint: '' },
                       { id: 'en', label: 'Englisch', hint: '' }],
      tiefen: [{ id: 'auto', label: 'Auto' }],
    })
  }

  const zeigen = () => render(
    <MemoryRouter initialEntries={['/p/Demo']}>
      <JobProvider>
        <ProjektDatenProvider>
          <EditorBrueckeProvider>
            <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
          </EditorBrueckeProvider>
        </ProjektDatenProvider>
      </JobProvider>
    </MemoryRouter>,
  )

  it('zeigt Sprach-Badge und GENAU EINE Sprachauswahl, die Upload UND URL-Import steuert', async () => {
    /* Vorher trugen Upload und URL-Import je einen eigenen Waehler — beide an derselben
       State, also zwei Ansichten desselben Werts. Der Test haelt beides fest: dass es nur
       noch EINEN gibt (Anzahl), und dass er trotzdem BEIDE Wege erreicht (die Umstellung
       auf Englisch kommt bei uploadAudio und bei fetchUrls an). Nur die Anzahl zu pruefen
       liesse einen Waehler durchgehen, der nichts mehr bewirkt. */
    mitSprachen()
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    zeigen()
    // Gezaehlt wird das Bedienelement selbst, nicht sein Beschriftungstext: eine Textzaehlung
    // braeche auch, wenn das Sprachlabel woanders auftaucht (Pille, Dateizeile) — rot aus dem
    // falschen Grund. Zwei Waehler wuerden hier 2 und 2 ergeben.
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(1))
    expect(screen.getAllByText(/Enthält weitere Sprachen/)).toHaveLength(1)
    // Der Geltungsbereich haengt am Waehler, nicht bloss daneben — jsdom sieht die Bindung,
    // NICHT ihre Wirkung auf den vorgelesenen Namen; die steht im Browser-Gegencheck.
    expect(screen.getByRole('combobox'))
      .toHaveAttribute('aria-describedby', 'lbl-neu-sprache-hinweis')

    // shadcn Select portalt nach document.body → container-Query greift nicht, body schon.
    fireEvent.click(document.body.querySelector('[role="combobox"]')!)
    fireEvent.click(await screen.findByText('Englisch'))
    // Das Badge zeigt weiter den PROJEKT-Standard: die Auswahl hier ist ein Override fuer die
    // naechsten Aufnahmen und schreibt nicht ins Projekt zurueck.
    expect(screen.getByText('Schweizerdeutsch')).toBeInTheDocument()

    // `undefined`, NICHT `false` (#166): der Haken steht unveraendert auf dem Projektwert, also
    // geht kein Datei-Override mit — sonst traege jede hochgeladene Datei einen eigenen Eintrag
    // und zoege bei einer spaeteren Aenderung des Projekt-Standards nicht mehr mit.
    await act(async () => {
      fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith('Demo', expect.any(File), 'en', undefined))

    fireEvent.change(screen.getByLabelText('Video-URLs'), { target: { value: 'https://youtu.be/a' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith('Demo', ['https://youtu.be/a'], 'en', undefined))
  })

  it('ein vom Projekt ABWEICHENDER Haken geht sehr wohl mit (#166)', async () => {
    /* Die Gegenprobe zum Test darueber — ohne sie waere „schickt nichts mit" auch dann gruen,
       wenn der Haken ueberhaupt nie ankommt. Genau dann waere die Mehrsprachigkeit pro Datei
       unbedienbar geworden. */
    mitSprachen()
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    zeigen()
    await screen.findByRole('combobox')
    fireEvent.click(screen.getByLabelText(/Enthält weitere Sprachen/))   // false -> true
    await act(async () => {
      fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith(
      'Demo', expect.any(File), 'ch', true))
  })

  it('schickt ohne geladene Einstellungen KEIN mehrsprachig mit', async () => {
    /* Schlaegt der GET fehl, wird die Auswahl gar nicht gerendert. Ein hartes `false` wuerde
       dann einen auf true stehenden Projekt-Standard ueberschreiben, ohne dass der Nutzer je
       ein Kaestchen gesehen haette — undefined heisst „kein Datei-Override". Die Entscheidung
       lag frueher in beiden Kindern; sie ist mit dem Waehler hierher gewandert. */
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [] })
    vi.mocked(api.getProjektEinstellungen).mockRejectedValue(new Error('kaputt'))
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    zeigen()
    await waitFor(() => expect(screen.queryAllByRole('combobox')).toHaveLength(0))
    await act(async () => {
      fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith('Demo', expect.any(File), '', undefined))
  })

  it('traegt die Sprache eines Projekts nicht ins naechste', async () => {
    /* React Router baut dieses Element bei einem Parameterwechsel NICHT neu auf — der State
       ueberlebt den Projektwechsel. Die Ablageflaeche ist dabei durchgehend scharf: ein Drop
       zwischen Wechsel und Antwort des GET schickte sonst die Sprache des vorigen Projekts
       als Override an die neue Datei, und eine falsche Sprache kostet eine komplette
       Neu-Transkription. Deshalb haengt der zweite GET hier absichtlich. */
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'A', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] },
      { name: 'B', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'A', files: [] })
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    vi.mocked(api.getProjektEinstellungen)
      .mockResolvedValueOnce({
        sprache: 'en', korrektur: 'auto', mehrsprachig: true,
        sprach_choices: [{ id: 'en', label: 'Englisch', hint: '' }],
        tiefen: [{ id: 'auto', label: 'Auto' }],
      })
      .mockReturnValueOnce(new Promise(() => {}))   // Projekt B: Antwort steht noch aus
    const ZuB = () => {
      const nav = useNavigate()
      return <button onClick={() => nav('/p/B')}>zu B</button>
    }
    render(
      <MemoryRouter initialEntries={['/p/A']}>
        <JobProvider>
          <ProjektDatenProvider>
            <EditorBrueckeProvider>
              <Routes>
                <Route path="/p/:project" element={<><ZuB /><ProjectWorkspace /></>} />
              </Routes>
            </EditorBrueckeProvider>
          </ProjektDatenProvider>
        </JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(1))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'zu B' })) })
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)   // Einstellungen von B unterwegs
    await act(async () => {
      fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith('B', expect.any(File), '', undefined))
  })
})
