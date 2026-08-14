import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from './AppShell'
import { JobProvider } from '@/hooks/useActiveJob'
import { useEditorMelden } from '@/hooks/useEditorBruecke'
import type { SpeicherStand } from '@/hooks/useDoc'
import * as api from '@/lib/api'
import type { Settings } from '@/lib/types'

vi.mock('@/lib/api')

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
const DATEIEN = [
  { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false },
  { base: 'b', has_audio: true, has_raw: true, has_edit: false, has_md: false },
]

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

  it('macht den Inhaltsbereich zum Bezugsrahmen — sonst waechst das DOKUMENT', () => {
    // `overflow-auto` klemmt absolut positionierte Nachfahren NUR, wenn der Behaelter selbst ein
    // Bezugsrahmen ist. Ohne `relative` sucht sich ein `position:absolute`-Kind den Viewport,
    // sitzt an seiner Flussposition weit unten im Inhalt — und macht damit das DOKUMENT
    // scrollbar. Ausgeloest hat es das `sr-only` (das IST absolut positioniert) im
    // Modell-Neuladen-Knopf der Einstellungen; sichtbar wurde es als wandernde Titel- UND
    // Statuszeile beim Scrollen ueber der Leiste, die bei vier Projekten selbst nichts zu
    // scrollen hat und das Mausrad deshalb an das Dokument weiterreicht.
    // jsdom rechnet kein Layout — wie bei den Rasterzeilen oben ist die gesetzte Klasse die
    // pruefbare Aussage. Im echten Browser gemessen (Einstellungsseite, 858 px Fenster): ohne
    // `relative` documentElement.scrollHeight 926 gegen clientHeight 858, mit `relative` beide
    // 858, waehrend `main` weiter selbst scrollt (1242 gegen 834) — der Inhalt geht also nicht
    // verloren, er wird nur wieder IM Inhaltsbereich gescrollt.
    render(
      <MemoryRouter><JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider></MemoryRouter>,
    )
    const main = document.getElementById('inhalt')!
    expect(main.className).toContain('overflow-auto')
    expect(main.className).toContain('relative')
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
