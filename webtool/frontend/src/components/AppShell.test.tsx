import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from './AppShell'
import { JobProvider } from '@/hooks/useActiveJob'
import { useEditorMelden } from '@/hooks/useEditorBruecke'
import * as api from '@/lib/api'
import type { Settings } from '@/lib/types'

vi.mock('@/lib/api')

/** Ersatz-Editor: meldet der Huelle ein offenes Dokument, ohne useDoc und ohne Server.
 *  Geprueft wird die Huelle — dass EditorView selbst meldet, sichert EditorView.test.tsx. */
function Schreibtisch({ dirty = true, reload = () => {} }: { dirty?: boolean; reload?: () => void }) {
  useEditorMelden({ project: 'Alpha', base: 'a', dirty, reload })
  const { pathname } = useLocation()
  return <span data-testid="ort">{pathname}</span>
}

const ZWEI = [
  { name: 'Alpha', dateien: 2, fertig: 0, geaendert: 100 },
  { name: 'Beta', dateien: 1, fertig: 0, geaendert: 50 },
]
/** Der Einzeldatei-Start sitzt seit der Zusammenlegung im ⋯-Menue (DateiMenue), nicht mehr
 *  als eigener Knopf in der Zeile. Radix oeffnet es nur auf einen echten Zeigerklick. */
async function korrigierenAusDemMenue() {
  fireEvent.pointerDown(screen.getByLabelText('Aktionen für „a“'),
    { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Korrigieren' }))
}

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

  describe('ungespeicherte Aenderungen', () => {
    beforeEach(() => {
      vi.mocked(api.listProjects).mockResolvedValue(ZWEI)
      vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: DATEIEN })
    })
    const zeigen = () => render(
      <MemoryRouter initialEntries={['/p/Alpha/a']}>
        <JobProvider><AppShell><Schreibtisch /></AppShell></JobProvider>
      </MemoryRouter>,
    )

    it('navigiert NICHT, wenn die Rueckfrage abgelehnt wird', async () => {
      // Der Kern: die Leiste ist seit dem Umbau immer sichtbar, ein Fehlklick darf die
      // ungespeicherte Arbeit im Editor nicht stillschweigend verwerfen.
      const frage = vi.spyOn(window, 'confirm').mockReturnValue(false)
      zeigen()
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
      zeigen()
      await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
      fireEvent.click(screen.getByText('Beta'))
      expect(screen.getByTestId('ort')).toHaveTextContent('/p/Beta')
      frage.mockRestore()
    })

    it('fragt nicht ohne ungespeicherte Aenderungen', async () => {
      const frage = vi.spyOn(window, 'confirm').mockReturnValue(true)
      render(
        <MemoryRouter initialEntries={['/p/Alpha/a']}>
          <JobProvider><AppShell><Schreibtisch dirty={false} /></AppShell></JobProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
      fireEvent.click(screen.getByText('Beta'))
      expect(frage).not.toHaveBeenCalled()
      frage.mockRestore()
    })
  })

  it('laedt das offene Dokument neu, wenn seine Einzeldatei-Korrektur fertig ist', async () => {
    // Ohne das haelt der Editor den Stand VOR der Korrektur -- und "Speichern" schreibt ihn
    // ueber die frisch erzeugte edit.json.
    vi.mocked(api.listProjects).mockResolvedValue(ZWEI)
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: DATEIEN })
    vi.mocked(api.startCorrectFile).mockResolvedValue({ started: true, job_id: 'j1' })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [] })
    const reload = vi.fn()
    render(
      <MemoryRouter initialEntries={['/p/Alpha/a']}>
        <JobProvider><AppShell><Schreibtisch dirty={false} reload={reload} /></AppShell></JobProvider>
      </MemoryRouter>,
    )
    const frage = vi.spyOn(window, 'confirm')
    await waitFor(() => expect(screen.getByLabelText('Aktionen für „a“')).toBeInTheDocument())
    await korrigierenAusDemMenue()
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect(frage).not.toHaveBeenCalled()      // ohne Ungespeichertes keine Rueckfrage
    frage.mockRestore()
  })

  it('laedt NICHT nach, wenn Ungespeichertes offen ist und die Rueckfrage abgelehnt wird', async () => {
    // Sonst verwirft ausgerechnet der Nachlade-Fix die Arbeit, die K1 schuetzt: man startet
    // die Korrektur einer Datei und tippt weiter, waehrend sie laeuft.
    vi.mocked(api.listProjects).mockResolvedValue(ZWEI)
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: DATEIEN })
    vi.mocked(api.startCorrectFile).mockResolvedValue({ started: true, job_id: 'j1' })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [] })
    const frage = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const reload = vi.fn()
    render(
      <MemoryRouter initialEntries={['/p/Alpha/a']}>
        <JobProvider><AppShell><Schreibtisch reload={reload} /></AppShell></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByLabelText('Aktionen für „a“')).toBeInTheDocument())
    await korrigierenAusDemMenue()
    await waitFor(() => expect(frage).toHaveBeenCalled())
    expect(reload).not.toHaveBeenCalled()
    frage.mockRestore()
  })
})
