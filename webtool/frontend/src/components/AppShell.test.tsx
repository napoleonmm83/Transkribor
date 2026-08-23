import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from './AppShell'
import { JobProvider, useActiveJob } from '@/hooks/useActiveJob'
import { useEditorMelden } from '@/hooks/useEditorBruecke'
import type { SpeicherStand } from '@/hooks/useDoc'
import * as api from '@/lib/api'
import type { Settings } from '@/lib/types'

vi.mock('@/lib/api')
// `loading` gehoert dazu, und sein Fehlen war nicht folgenlos: `useJob.start` ruft es als
// ERSTES, ohne es stirbt der Aufruf an `undefined(...)` — der ganze Job-Weg der Seitenleiste
// lief in diesen Tests also gar nicht, still. Aufgefallen erst an einer Mutationsprobe, die
// dadurch gruen blieb (der Waechter konnte nicht anschlagen, weil der Pfad nie lief).
const toastMock = vi.hoisted(() => Object.assign(vi.fn(),
  { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn(), loading: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }))

/** Ersatz-Editor: meldet der Huelle ein offenes Dokument, ohne useDoc und ohne Server.
 *  Geprueft wird die Huelle — dass EditorView selbst meldet, sichert EditorView.test.tsx.
 *  `stand` (Default 'ruhig'): seit #106 fragt die Leiste vor dem Verlassen nur bei 'fehler'. */
function Schreibtisch({ dirty = true, stand = 'ruhig', reload = () => {}, vergiss = () => {} }: {
  dirty?: boolean; stand?: SpeicherStand; reload?: () => void; vergiss?: () => void
}) {
  useEditorMelden({ project: 'Alpha', base: 'a', dirty, stand, reload, vergiss })
  const { pathname } = useLocation()
  return <span data-testid="ort">{pathname}</span>
}

const ZWEI = [
  { name: 'Alpha', dateien: 2, fertig: 0, geaendert: 100 },
  { name: 'Beta', dateien: 1, fertig: 0, geaendert: 50 },
]
/** Was einen Behaelter zum Bezugsrahmen fuer absolut positionierte Nachfahren macht. */
const ANKER = ['relative', 'absolute', 'fixed', 'sticky']
const DATEIEN = [
  { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false },
  { base: 'b', has_audio: true, has_raw: true, has_edit: false, has_md: false },
]

/** Spiegelt die adoptierten Jobs des Providers nach aussen — die einzige Stelle, an der sich
 *  „adoptiert" beobachten laesst, ohne auf `api.getJob` zu schauen (das ruft `useJob` selbst). */
function Jobspiegel() {
  const { jobs } = useActiveJob()
  return <span data-testid="jobspiegel">{jobs.map(j => `${j.id}:${j.kind}`).join(' ')}</span>
}

describe('AppShell', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cpu', name: 'CPU', torch_ok: false, asr: 'cpu' })
    // Seit Task 3 traegt AppShell den ProjektDatenProvider -- der ruft beim Mounten selbst.
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: '', files: [] })
    // Seit Task 5 traegt AppShell die Leiste -- die fragt useAiReady (getSettings) fuer den
    // Korrigieren-Knopf. Ungemockt liefert das Automock von '@/lib/api' undefined zurueck,
    // und `.then` darauf wirft in useAiReady.
    vi.mocked(api.getSettings).mockResolvedValue({ ai_ready: true, ai_reason: '' } as Settings)
  })

  it('zeigt den Inhalt und GENAU eine Statuszeile', () => {
    render(
      <MemoryRouter>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    expect(screen.getByText('Inhalt')).toBeInTheDocument()
    // contentinfo = <footer>. Zwei davon hiesse: eine Seite bringt ihre eigene mit.
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1)
  })

  it('setzt den Bildlauf beim Routenwechsel zurueck', () => {
    // jsdom implementiert Element.scrollTo nicht — die Attrappe am Prototyp ist der einzige
    // Weg, den Aufruf hier zu sehen. Gemessen wird der Aufruf, nicht die Wirkung.
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: scrollTo, configurable: true, writable: true })
    function Springen() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/einstellungen')}>weiter</button>
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><Springen /></AppShell></JobProvider>
      </MemoryRouter>,
    )
    scrollTo.mockClear()                  // der erste Lauf des Effekts zaehlt nicht
    fireEvent.click(screen.getByText('weiter'))
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
  })

  it('zeigt die Seitenleiste mit den Projekten', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Alpha', dateien: 1, fertig: 0, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: [] })
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Projekte' })).toBeInTheDocument())
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('meldet einen gescheiterten Upload aus der Leiste (#299)', async () => {
    /* Der ZWEITE Upload-Weg — der einzige, der nicht durch den MaterialDialog laeuft.
       `uploadAudio(p, f).then(nachladen)` hatte keinen `.catch`, und einen globalen
       `unhandledrejection`-Handler gibt es in dieser App nicht: der Fehlschlag war
       unsichtbar. Vor #299 hing ein toter Request wenigstens noch erkennbar („es tut sich
       nichts"); seit er nach der Frist ABLEHNT, landet ausgerechnet die Meldung, die #299
       eigens dafuer gebaut hat, auf diesem Pfad nirgends. (Fund des Reviewers.) */
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Alpha', dateien: 1, fertig: 0, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: [] })
    vi.mocked(api.uploadAudio).mockRejectedValue(
      new Error('Zeitlimit überschritten — die Aufnahme ist möglicherweise trotzdem angekommen.'))
    const { container } = render(
      <MemoryRouter initialEntries={['/p/Alpha']}>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    const feld = container.querySelector('input[type=file]') as HTMLInputElement
    fireEvent.change(feld, { target: { files: [new File(['x'], 'a.mp3', { type: 'audio/mpeg' })] } })
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    // Der Grund muss MITKOMMEN: „Hochladen fehlgeschlagen" ohne den Text schickt den Nutzer
    // in einen zweiten Versuch, der mit 409 endet.
    expect(String(toastMock.error.mock.calls[0][0])).toMatch(/möglicherweise trotzdem angekommen/)
  })

  it('die Leisten-Knoepfe ADOPTIEREN ihren Job — sonst faellt die Ausgangsmeldung aus (#376)', async () => {
    /* Seit #376 meldet `useJobAusgang` den Ausgang JEDES Laufs, ueber den JobProvider — der
       sieht aber nur ADOPTIERTE Jobs. `useJob` adoptiert nicht selbst (es kennt Projekt und
       Art nicht), also muss es der Aufrufer tun; hier stand nur `start(() => startTranscribe(p), …)`.
       Ohne den Griff haengt die Meldung am Summenpoll (bis 4 s), und ein Lauf, der frueher
       stirbt (Modell-Ladefehler), waere wieder unsichtbar — genau der Fall, den #376 schliesst.

       Gemessen wird am Provider, NICHT an `api.getJob`: `useJob` pollt selbst, ein Aufruf dort
       belegt gar nichts. */
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Alpha', dateien: 1, fertig: 0, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: [] })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running', kind: 'transcribe', lines: [] })
    vi.mocked(api.startTranscribe).mockResolvedValue({ started: true, job_id: 'j9' })
    render(
      <MemoryRouter initialEntries={['/p/Alpha']}>
        <JobProvider intervalMs={10000}><AppShell><Jobspiegel /></AppShell></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Transkribieren' }))
    await waitFor(() => expect(screen.getByTestId('jobspiegel')).toHaveTextContent('j9:transcribe'))
  })

  it('der Ausgang wird GENAU EINMAL gemeldet — die Huelle montiert useJobAusgang (#376)', async () => {
    /* Zwei Wachposten in einem, und beide fehlten sonst:
       (1) Faellt `useJobAusgang()` aus dem Rahmen, bleibt jeder Ausgang stumm — die eigenen
           Tests des Hooks montieren ihn selbst und wuerden das nie merken.
       (2) Meldete `useJob` seinen Ausgang wieder mit (dort stand er frueher), gaebe es ZWEI
           Toasts fuer dasselbe Ende. Genau deshalb ist er dort entfallen. */
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Alpha', dateien: 1, fertig: 0, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: [] })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', kind: 'transcribe', lines: [] })
    vi.mocked(api.startTranscribe).mockResolvedValue({ started: true, job_id: 'j9' })
    render(
      <MemoryRouter initialEntries={['/p/Alpha']}>
        <JobProvider intervalMs={10}><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Transkribieren' }))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining('Alpha'), expect.anything()))
    // ABWARTEN, bevor gezaehlt wird: `waitFor` loest beim ERSTEN Toast auf, ein zweiter aus
    // `useJob`s eigenem Poll kaeme Mikrosekunden spaeter. Ohne diese Pause ist der Zaehler
    // blind (gemessen).
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    expect(toastMock.success).toHaveBeenCalledTimes(1)
  })

  it('bietet einen Sprunglink VOR der Leiste', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    const sprung = screen.getByRole('link', { name: 'Zum Inhalt' })
    expect(sprung).toHaveAttribute('href', '#inhalt')
    // Reihenfolge im DOM ist hier die ganze Aussage: hinter der Leiste waere der Link
    // wertlos, weil man ihn erst nach dreihundert Knoepfen erreicht.
    const leiste = screen.getByRole('navigation', { name: 'Projekte' })
    expect(sprung.compareDocumentPosition(leiste) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('macht das Sprungziel zur main-Landmarke — und laesst GENAU eine banner uebrig (#72)', () => {
    // Zwei Haelften desselben Befunds: `#inhalt` war ein `div` (Sprungziel ohne Landmarke),
    // und weil `PageHeader`/`Toolbar` damit in keinem `main` steckten, galten ihre `<header>`
    // als `banner` — unter Electron also zwei auf einem Schirm. Beides haengt an DIESEM
    // Element, darum ein Test.
    ;(window as unknown as { transkribor: unknown }).transkribor = { plattform: 'win32' }
    try {
      render(
        <MemoryRouter initialEntries={['/']}>
          <JobProvider><AppShell><header>Seitenkopf</header><p>Inhalt</p></AppShell></JobProvider>
        </MemoryRouter>,
      )
      const main = document.getElementById('inhalt')!
      expect(main.tagName).toBe('MAIN')
      expect(screen.getAllByRole('main')).toHaveLength(1)
      // Geprueft wird die STRUKTUR, nicht die berechnete Rolle: jsdom (dom-accessibility-api)
      // bildet jedes `<header>` auf `banner` ab und kennt die Vorfahren-Regel aus HTML-AAM
      // nicht — `getAllByRole('banner')` zaehlt hier also auch den Seitenkopf IM main und
      // waere gruen wie rot aus dem falschen Grund. Die pruefbare Aussage ist: ausserhalb des
      // `main` steht genau EIN `<header>`, die Titelzeile. Im Browser gegengeprueft (die
      // Rollenberechnung dort ist die echte).
      const ausserhalb = [...document.querySelectorAll('header')].filter(h => !main.contains(h))
      expect(ausserhalb).toHaveLength(1)
      expect(ausserhalb[0]).toHaveAttribute('role', 'banner')
    } finally {
      delete (window as unknown as { transkribor?: unknown }).transkribor
    }
  })

  describe('Rasterzeilen', () => {
    // Ohne Bruecke rendert TitleBar `null` und steuert KEIN Rasterelement bei. Bleibt die
    // Zeilenangabe trotzdem dreizeilig, rutscht alles eine Zeile hoch: der Inhalt landet in
    // `auto`, die Statuszeile in `1fr` -- gemessen 374 px Leerraum unter ihr. jsdom rechnet
    // kein Layout, darum ist die gesetzte Klasse die pruefbare Aussage.
    const raster = () => document.getElementById('inhalt')!.parentElement!
    const zeigen = () => render(
      <MemoryRouter><JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider></MemoryRouter>,
    )

    it('hat im Browser eine Zeile weniger', () => {
      zeigen()
      expect(raster().className).toContain('grid-rows-[1fr_auto]')
    })

    it('macht unter Electron Platz fuer die Titelzeile', () => {
      ;(window as unknown as { transkribor: unknown }).transkribor = { plattform: 'win32' }
      try {
        zeigen()
        expect(raster().className).toContain('grid-rows-[auto_1fr_auto]')
      } finally {
        delete (window as unknown as { transkribor?: unknown }).transkribor
      }
    })
  })

  it('gibt JEDEM Bildlaufbehaelter der Huelle einen Bezugsrahmen', () => {
    // Die Regel, nicht der Einzelfall: `overflow-auto` klemmt absolut positionierte Nachfahren
    // NUR, wenn der Behaelter selbst ihr Bezugsrahmen ist. Sonst haengen sie am Viewport, sitzen
    // an ihrer Flussposition weit unten im Inhalt und machen das DOKUMENT scrollbar — und wer
    // dann ueber der Leiste scrollt (die bei vier Projekten selbst nichts zu scrollen hat und
    // das Mausrad ans Dokument weiterreicht), schiebt die ganze Huelle samt Titel- und
    // Statuszeile. Ausgeloest hat es ein `sr-only` (das IST absolut positioniert).
    //
    // jsdom rechnet kein Layout — wie bei den Rasterzeilen oben ist die gesetzte Klasse die
    // pruefbare Aussage; die Wirkung ist im Browser gemessen (Einstellungsseite, 858 px Fenster:
    // ohne `relative` documentElement.scrollHeight 926 gegen clientHeight 858, mit `relative`
    // beide 858, waehrend `main` weiter selbst scrollt — der Inhalt geht also nicht verloren).
    // Belastbar ist dabei die Bisektion: NUR dieses eine Element auszublenden brachte 926 → 858.
    //
    // Zwei Grenzen, damit der Test nicht mehr verspricht, als er sieht: er kennt nur, was die
    // HUELLE rendert (`main` ist hier leer) — also `main` und die Leiste, nicht die Bildlauf-
    // behaelter einzelner Seiten. Und er sieht nur `auto`/`scroll`: `overflow-hidden` hat
    // dieselbe Luecke, steht aber ueberall als Zierrat und waere hier nur Rauschen.
    render(
      <MemoryRouter><JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider></MemoryRouter>,
    )
    const scroller = [...document.querySelectorAll<HTMLElement>('*')]
      .filter(el => [...el.classList].some(c => /^overflow-(x-|y-)?(auto|scroll)$/.test(c)))
    // Positivkontrolle: benennt Tailwind die Utility um, liefe die Schleife sonst still leer.
    expect(scroller.length).toBeGreaterThan(1)
    // Erst sammeln, dann pruefen — eine Zusicherung in der Schleife nennt den Fundort nicht.
    const ohneAnker = scroller
      .filter(el => ![...el.classList].some(c => ANKER.includes(c)))
      .map(el => `${el.tagName}.${el.className}`)
    expect(ohneAnker).toEqual([])
  })

  describe('ungespeicherte Aenderungen', () => {
    beforeEach(() => {
      vi.mocked(api.listProjects).mockResolvedValue(ZWEI)
      vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: DATEIEN })
    })
    const zeigen = (stand?: Parameters<typeof Schreibtisch>[0]['stand']) => render(
      <MemoryRouter initialEntries={['/p/Alpha/a']}>
        <JobProvider><AppShell><Schreibtisch stand={stand} /></AppShell></JobProvider>
      </MemoryRouter>,
    )

    it('navigiert NICHT, wenn die Rueckfrage abgelehnt wird', async () => {
      // Seit #106 fragt die Leiste nur noch bei stand='fehler' (in der Tipppause spült useDoc
      // selbst). Der Kern bleibt: ein Fehlklick darf ungespeicherte Arbeit nicht still verwerfen.
      const frage = vi.spyOn(window, 'confirm').mockReturnValue(false)
      zeigen('fehler')
      await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())

      fireEvent.click(screen.getByText('Beta'))                       // Projektwechsel
      expect(frage).toHaveBeenCalled()
      expect(screen.getByTestId('ort')).toHaveTextContent('/p/Alpha/a')

      frage.mockClear()
      fireEvent.click(screen.getByText('b'))                          // Dateiwechsel
      expect(frage).toHaveBeenCalled()
      expect(screen.getByTestId('ort')).toHaveTextContent('/p/Alpha/a')
      frage.mockRestore()
    })

    it('navigiert nach zugestimmter Rueckfrage', async () => {
      const frage = vi.spyOn(window, 'confirm').mockReturnValue(true)
      zeigen('fehler')
      await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
      fireEvent.click(screen.getByText('Beta'))
      expect(screen.getByTestId('ort')).toHaveTextContent('/p/Beta')
      frage.mockRestore()
    })

    it('fragt nicht ohne ungespeicherte Aenderungen', async () => {
      const frage = vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(
        <MemoryRouter initialEntries={['/p/Alpha/a']}>
          <JobProvider><AppShell><Schreibtisch dirty={false} stand="ruhig" /></AppShell></JobProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
      fireEvent.click(screen.getByText('Beta'))
      expect(frage).not.toHaveBeenCalled()
      frage.mockRestore()
    })

    it('navigiert in der Tipppause (stand="offen") ohne Rueckfrage (#106)', async () => {
      // Kern von #106: die Oberflaeche hatte "wird gespeichert" versprochen — in der Pause darf
      // die Leiste nicht widersprechen. useDoc spült den neuesten Stand beim Verlassen selbst.
      const frage = vi.spyOn(window, 'confirm').mockReturnValue(false)   // duerfte nie gefragt werden
      zeigen('offen')
      await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
      fireEvent.click(screen.getByText('Beta'))
      await waitFor(() => expect(screen.getByTestId('ort')).toHaveTextContent('/p/Beta'))
      expect(frage).not.toHaveBeenCalled()
      frage.mockRestore()
    })
  })

})
