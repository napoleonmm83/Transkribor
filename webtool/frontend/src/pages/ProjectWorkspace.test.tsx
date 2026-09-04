import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { ProjectWorkspace } from './ProjectWorkspace'
import { JobProvider } from '@/hooks/useActiveJob'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'
import { EditorBrueckeProvider } from '@/hooks/useEditorBruecke'
import * as api from '@/lib/api'
import type { Settings, ProjectFile } from '@/lib/types'

vi.mock('@/lib/api')
// `info` und `warning` gehoeren in den Mock, auch wenn gerade nur `info` geprueft wird:
// fehlt eine Variante, WIRFT der Aufruf im Handler (nicht „gilt als nicht gerufen"), und
// jede `not.toHaveBeenCalled`-Zusicherung darueber waere ohnehin keine (Frontend-CLAUDE.md).
const toastMock = vi.hoisted(() => Object.assign(vi.fn(),
  { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const einstellungen = (s: Partial<Settings>) =>
  vi.mocked(api.getSettings).mockResolvedValue({ ai_ready: true, ai_reason: '', ...s } as Settings)

/** Material ueber den DIALOG hinzufuegen — Auswahl, beide Weiter, „Los geht's".
 *
 *  Die Zusicherungen dieser Tests gelten der ARBEITSFLAECHE (Job-Adoption, Toasts,
 *  Nachladen der Listen) und sind unveraendert; nur der Weg dorthin fuehrt seit dem
 *  Material-Dialog nicht mehr ueber einen Bereich auf der Seite. Was IM Dialog passiert,
 *  prueft `MaterialDialog.test.tsx`.
 */
async function oeffneDialog() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Material$/ })) })
}

async function holeUrl(url = 'https://youtu.be/a') {
  await oeffneDialog()
  fireEvent.click(screen.getByRole('tab', { name: /Links/ }))
  fireEvent.change(screen.getByLabelText('Video-URLs'), { target: { value: url } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Holen$/i })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Weiter/ })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Los geht/ })) })
}

async function ladeHoch(datei = new File(['x'], 'a.mp3')) {
  await oeffneDialog()
  await act(async () => {
    fireEvent.change(screen.getByTestId('ablage-input'), { target: { files: [datei] } })
  })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Weiter/ })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Weiter/ })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Los geht/ })) })
}

describe('ProjectWorkspace (Stub)', () => {
  beforeEach(() => {
    // Ohne das teilen sich die Tests die Aufrufliste der Attrappen. Aufgefallen ist es an
    // einer Zusicherung ueber `mock.calls` — die sah Aufrufe der Tests DAVOR und war damit
    // eine Aussage ueber die Reihenfolge in der Datei, nicht ueber das Verhalten.
    vi.clearAllMocks()
    einstellungen({})
    // Projekt-Einstellungen default: leer — bestehende Tests sehen keine Sprach-Selects.
    vi.mocked(api.getProjektEinstellungen).mockResolvedValue(
      { sprache: 'de', korrektur: 'auto', mehrsprachig: false, sprach_choices: [], tiefen: [],
        sprecher_max: 20 })
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

  // Die VERDRAHTUNG des Belegs (#erreicht), nicht seine Regel — die steht in
  // `jobPhases.test.ts` und `FileStatusPill.test.tsx`. Ohne diesen Test liesse sich das Prop
  // hier ersatzlos streichen: es ist optional, also typkonform weglassbar, und kein
  // Pillen-Test sieht die Aufrufstelle. Genau das ist die Stelle, an der der ganze Fix
  // rueckstandslos abklemmbar waere.
  it('reicht den Beleg aus dem Job an die Dateizeile durch', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [{ id: 'j1', kind: 'transcribe' }] },
    ])
    // Die Dateiliste ist ALT — genau der Zustand, um den es geht: sie kennt das Transkript
    // noch nicht, obwohl der Lauf es laengst geschrieben hat.
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
      files: [{ base: 'S1', has_audio: true, has_raw: false, has_edit: false, has_md: false }] })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running',
      lines: ['[scope] S1', '[Demo] fertig S1: 12s, 30 Segmente, 1.2x'] })
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
    expect(await screen.findByText(/Transkribiert — noch nicht korrigiert/)).toBeInTheDocument()
    expect(screen.queryByText(/Nur Audio/)).toBeNull()
  })

  // Der Zwilling des Tests darueber, fuer die Warteauskunft (#370/#442) — und er ist an
  // genau derselben Luecke gemessen: der gegnerische Pruefer entfernte `warten={…}` aus
  // dieser Datei und ALLE 854 Tests blieben gruen. Das ist die EINZIGE Stelle, die die
  // Wartezeile je rendert (die Seitenleiste bekommt sie bewusst nicht), das ganze Feature
  // war also rueckstandslos abklemmbar. Dieselbe #488-Lehre, zum zweiten Mal an derselben
  // Komponente: ein optionales Prop faellt lautlos weg.
  it('reicht die Warteauskunft aus dem Job an die Dateizeile durch', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [{ id: 'j1', kind: 'transcribe' }] },
    ])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [
      { base: 'S1', has_audio: true, has_raw: false, has_edit: false, has_md: false },
      { base: 'S2', has_audio: true, has_raw: false, has_edit: false, has_md: false },
    ] })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running',
      lines: ['[scope] S1\tS2', '[active] S1', '[Demo] -> transkribiere S1 …'] })
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
    // S1 laeuft, S2 wartet — mit der Zahl, nicht mit dem alten blanken Text.
    expect(await screen.findByText('Wartet auf Transkription · noch 1 vor dieser')).toBeInTheDocument()
    expect(screen.queryByText(/In Warteschlange/)).toBeNull()
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
      sprache: 'ch', korrektur: 'auto', mehrsprachig: false, sprecher_max: 20,
      sprach_choices: [{ id: 'ch', label: 'Schweizerdeutsch', hint: '' , dialekt: true },
                       { id: 'en', label: 'Englisch', hint: '' , dialekt: false }],
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

  it('zeigt das Sprach-Badge, aber KEINEN Bereich „Material hinzufügen" mehr', async () => {
    /* B2 der Spec: bei zehn Aufnahmen ist Hinzufuegen ein Randfall und belegte trotzdem den
       ganzen ersten Bildschirm. Die Sprachauswahl ist damit hier ganz weg — sie steht als
       Projekt-Standard im Punkte-Menue und je Aufnahme im Dialog (B1: eine Bedeutung, ein
       Ort). Das BADGE bleibt: es zeigt weiter den Projekt-Standard.

       Was der Waehler frueher hier bewirkte (Sprache erreicht Upload UND URL-Import), prueft
       jetzt `MaterialDialog.test.tsx` je Aufnahme — mit Mutationsprobe. */
    mitSprachen()
    zeigen()
    await screen.findByRole('button', { name: /^Material$/ })
    expect(screen.getByText('Schweizerdeutsch')).toBeInTheDocument()   // Badge
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryByLabelText('Video-URLs')).not.toBeInTheDocument()
    expect(screen.queryByText(/Enthält weitere Sprachen/)).not.toBeInTheDocument()
  })

  it('meldet den Start eines URL-Imports nach oben — mit eigener Meldung', async () => {
    /* Der URL-Weg hatte seine Zusicherung bisher im geloeschten Test darueber. Sie gilt der
       ARBEITSFLAECHE: sie adoptiert den Job sofort (der Balken soll stehen, ohne auf den
       naechsten Poll zu warten) und sagt dazu, dass die Transkription von selbst folgt —
       eine andere Aussage als beim Upload. */
    nurDemo()
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j-fetch', started: true })
    zeigen()
    await screen.findByRole('button', { name: /^Material$/ })
    await holeUrl()
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', ['https://youtu.be/a'], [null], undefined, [null]))
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringMatching(/Transkription folgt/))
  })

  it('sagt das Drop-Ziel AN, nicht nur farbig (#304/Kl9)', async () => {
    /* Die Ansage „Zum Hinzufügen loslassen" war rein visuell. Als `role="status"` ist sie
       eine Live-Region und wird vorgelesen — und der Test haengt damit an dem, was der
       Nutzer WAHRNIMMT, statt an einer `testid`, die nur fuer ihn selbst existiert.
       Mit Gegenprobe: ohne Zug darf die Rolle NICHT im Baum stehen, sonst waere die
       Live-Region eine Dauermeldung. */
    nurDemo()
    zeigen()
    const flaeche = await screen.findByTestId('drop-overlay-ziel')
    // Die Region steht DAUERHAFT da (sonst saehe ein Screenreader die Einfuegung, nicht die
    // Aenderung, und sagte nichts) — geprueft wird deshalb ihr INHALT, nicht ihre Existenz.
    //
    // `toBeEmptyDOMElement()`, nicht `toHaveTextContent('')`. Beides ist hier korrekt —
    // nachgemessen: an einem Element MIT Text wird auch die zweite Form rot, der leere
    // String ist in jest-dom seit 4.1.1 ein Sonderfall statt eines Substring-Vergleichs
    // (der Verdacht kam als Befund von CLI und Bot, die Messung widerlegt ihn). Die
    // Bibliothek empfiehlt fuer „ist leer" trotzdem diese Form, und sie sagt, was gemeint
    // ist, statt eine Ausnahme auszunutzen.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    fireEvent.dragOver(flaeche, { dataTransfer: { files: [] } })
    expect(screen.getByRole('status')).toHaveTextContent(/loslassen/i)
  })

  it('raeumt das Overlay auch bei einem ABGEBROCHENEN Zug weg (#304/Kl2)', async () => {
    /* Im Browser gemessen: bricht man den Zug per Escape ab, ohne den Container zu
       verlassen, feuert NUR `dragend` — kein `dragleave`. Da `zieht` bisher allein an
       `dragleave` hing, blieb das Overlay ueber der ganzen Seite stehen.
       Der Test prueft die Verdrahtung; die MESSUNG steht als Kommentar am Handler, weil
       jsdom die Ereignisfolge des Browsers nicht nachbildet. */
    nurDemo()
    zeigen()
    const flaeche = await screen.findByTestId('drop-overlay-ziel')
    fireEvent.dragOver(flaeche, { dataTransfer: { files: [] } })
    expect(screen.getByRole('status')).toHaveTextContent(/loslassen/i)
    fireEvent.dragEnd(flaeche)
    await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement())
  })

  it('sagt es, wenn beim Ablegen keine Audiodatei dabei war', async () => {
    /* Neu durch das seitenweite Overlay: der alte Weg filterte per AUDIO_RE und kehrte bei
       leerer Menge STILL zurueck — was in Ordnung war, solange man die Ablageflaeche
       absichtlich treffen musste. Jetzt faengt die ganze Seite den Drop. */
    nurDemo()
    zeigen()
    const flaeche = await screen.findByTestId('drop-overlay-ziel')
    fireEvent.drop(flaeche, { dataTransfer: { files: [new File(['x'], 'brief.pdf')] } })
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledWith(
      expect.stringMatching(/[Kk]eine Audiodatei/)))
  })

  /* HIER STAND: „ein vom Projekt ABWEICHENDER Haken geht sehr wohl mit — die Sprache
     daneben NICHT (#166/#234)". Die Sprach-Haelfte hat einen Nachfolger: `MaterialDialog`
     schickt `''`, solange die Zeile dem Projektwert entspricht (mutationsgeprueft, M21).
     Die HAKEN-Haelfte hat KEINEN — der Dialog schickt `mehrsprachig` gar nicht mehr, weil
     das Kaestchen eine Eigenschaft der einzelnen AUFNAHME ist und ins Punkte-Menue gehoert
     (Spec 9). Das ist eine bewusste Verkleinerung, keine vergessene Zusicherung: „Enthaelt
     weitere Sprachen" laesst sich beim Hinzufuegen nicht mehr setzen, sondern erst danach. */

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
    await screen.findByRole('button', { name: /^Material$/ })
    await ladeHoch()
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith('Demo', expect.any(File), '', undefined, undefined))
  })

  it('verfolgt die Vormerkung, wenn der Upload auf einen belegten Slot trifft (#381)', async () => {
    /* Das letzte Glied der Kette: `MaterialDialog` reicht die Nummer durch (dort geprueft),
       und HIER muss sie beim Provider ankommen. Ohne diesen Test war der `verfolge`-Aufruf
       ersatzlos entfernbar — alle 897 Tests blieben gruen (gegnerischer Pruefer, T1).
       Dieselbe Lehre wie #488: eine Regel zu bauen reicht nicht, jedes Glied braucht seinen
       eigenen Test.
       Der Beleg ist die ABFRAGE der Nummer — die passiert nur, wenn `verfolge` lief.
       `nurDemo()` ist Pflicht, nicht Zierde: `vi.clearAllMocks()` in der Fixture loescht nur
       die Aufruflisten, NICHT die Implementierungen — ohne den Aufruf erbte dieser Test die
       Dateiliste des vorigen und haenge damit an der Reihenfolge. */
    nurDemo()
    vi.mocked(api.uploadAudio).mockResolvedValue(
      { base: 'a', file: 'a.mp3', job_id: 'fremder_blocker', started: false, vorgang: 'vg1' })
    vi.mocked(api.getVorgang).mockResolvedValue({ vorgang: 'vg1', status: 'vorgemerkt',
      job_id: null, project: 'Demo', kind: 'transcribe', base: null })
    zeigen()
    await screen.findByRole('button', { name: /^Material$/ })
    await ladeHoch()
    await waitFor(() => expect(api.getVorgang).toHaveBeenCalledWith('vg1'))
  })

  it('meldet einen fehlgeschlagenen Einstellungs-GET, statt ihn zu verschlucken (#215)', async () => {
    /* Ohne Auswahl gilt stillschweigend der Projektstandard — die richtige Voreinstellung,
       aber ein FEHLENDES Bedienelement ist von „gibt es hier nicht" nicht zu unterscheiden.
       Der Upload startet die Transkription sofort, eine falsche Sprache kostet einen ganzen
       Lauf. Der Toast ist die einzige Stelle, an der das ueberhaupt auftaucht — ohne diesen
       Test ist er Dekoration (die Mutationsprobe hat ihn genau so ueberlebt). */
    toastMock.error.mockClear()
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [] })
    vi.mocked(api.getProjektEinstellungen).mockRejectedValue(new Error('kaputt'))
    zeigen()
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining('kaputt')))
    // Der Grund gehoert dazu: „Fehler" allein sagt niemandem, was zu tun ist.
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Einstellungen'))
  })

  it('meldet auch den NACHLADE-Fehler nach dem Einstellungs-Dialog (#215)', async () => {
    /* Der zweite `.catch` — `reloadEinstellungen`, ausgeloest vom Projekt-Dialog. Beide Zweige
       haengen jetzt an EINER Meldefunktion; ohne diesen Test waere trotzdem nur der Mount-Pfad
       belegt, und ein `() => {}` an dieser Stelle faende kein Test. Der GET gelingt beim Laden
       und scheitert beim Nachladen — genau der Fall, den der Nutzer sonst gar nicht bemerkt. */
    toastMock.error.mockClear()
    mitSprachen()
    vi.mocked(api.saveProjektEinstellungen).mockResolvedValue(
      { sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    zeigen()
    // Warteanker ist der Projekt-Knopf: eine `combobox` gibt es auf der Seite nicht mehr.
    await screen.findByRole('button', { name: /Aktionen für/ })
    // Radix oeffnet das Menue nur auf einen echten Zeigerklick — `click` allein reicht nicht.
    fireEvent.pointerDown(screen.getByRole('button', { name: /Aktionen für/ }),
      { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sprache & Korrektur/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Sprache' }))
    fireEvent.click(await screen.findByText(/Englisch/))
    // Erst JETZT faellt der GET aus: der Dialog hat seinen Stand, der Nachlade-Pfad nicht.
    vi.mocked(api.getProjektEinstellungen).mockRejectedValue(new Error('weg'))
    fireEvent.click(within(dialog).getByRole('button', { name: /^Speichern/ }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining('weg')))
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
        sprache: 'en', korrektur: 'auto', mehrsprachig: true, sprecher_max: 20,
        sprach_choices: [{ id: 'en', label: 'Englisch', hint: '' , dialekt: false }],
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
    // Das Badge traegt den Projekt-Standard und ist damit der Anker, seit der Waehler weg ist.
    await waitFor(() => expect(screen.getByText('Englisch')).toBeInTheDocument())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'zu B' })) })
    expect(screen.queryByText('Englisch')).not.toBeInTheDocument()  // Einstellungen von B unterwegs
    await ladeHoch()
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith('B', expect.any(File), '', undefined, undefined))
  })

  it('nimmt nach dem Wechsel den Standard von B — nicht die Auswahl aus A (#234)', async () => {
    /* Die andere Haelfte des Tests darueber: dort haengt Bs GET, hier ANTWORTET er. Beide
       Fenster brauchen einen eigenen Fall, weil sie an verschiedenen Zeilen haengen.

       Solange Bs Antwort aussteht, traegt `zeigeSprachwahl === false` den Schutz — der
       `setSprache('')`-Reset im Effekt ist dafuer inzwischen Redundanz (nachgerechnet: bei
       `einstellungen === null` ist `sprachChoices` leer, `sprachWert` kuerzt schon am ersten
       Konjunkt ab). Ist Bs Antwort DA, haengt alles an `setSprache(d.sprache)`: bliebe die
       Auswahl auf As `en` stehen, waeche sie von Bs `fr` ab und ginge als Datei-Override mit —
       eine falsche Sprache kostet eine komplette Neu-Transkription. Genau diese Zeile hatte
       keinen roten Lauf. */
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'A', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] },
      { name: 'B', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'A', files: [] })
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    const wahl = [{ id: 'en', label: 'Englisch', hint: '' , dialekt: false }, { id: 'fr', label: 'Französisch', hint: '' , dialekt: false }]
    vi.mocked(api.getProjektEinstellungen)
      .mockResolvedValueOnce({ sprache: 'en', korrektur: 'auto', mehrsprachig: false, sprecher_max: 20,
                               sprach_choices: wahl, tiefen: [{ id: 'auto', label: 'Auto' }] })
      .mockResolvedValueOnce({ sprache: 'fr', korrektur: 'auto', mehrsprachig: false, sprecher_max: 20,
                               sprach_choices: wahl, tiefen: [{ id: 'auto', label: 'Auto' }] })
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
    await waitFor(() => expect(screen.getByText('Englisch')).toBeInTheDocument())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'zu B' })) })
    // Warten, bis Bs Standard wirklich steht — sonst prueft der Test nur das Fenster oben.
    await waitFor(() => expect(screen.getByText('Französisch')).toBeInTheDocument())
    await ladeHoch()
    // `''` heisst „kein Override" — die Datei folgt Bs Standard. Ein mitgereistes `en` waere
    // der Fehler, den dieser Test fangen soll.
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith('B', expect.any(File), '', undefined, undefined))
    // Ueber die ARGUMENTLISTE, nicht ueber `toHaveBeenCalledWith`: `expect.anything()` matcht
    // ausdruecklich KEIN `undefined` und kein `null` — und genau die stehen hier an Position 4
    // und 5 (kein Mehrsprachig-Override, keine Sprecherzahl). Die Zusicherung haette also nie
    // gematcht und waere immer gruen gewesen, egal was passiert: ein vacuous gewordener
    // Waechter ist schlimmer als keiner. So geprueft haelt sie ausserdem, wenn ein sechstes
    // Argument dazukommt. (CodeRabbit-Bot an PR #297.)
    expect(vi.mocked(api.uploadAudio).mock.calls.every(c => c[2] !== 'en')).toBe(true)
  })
})
