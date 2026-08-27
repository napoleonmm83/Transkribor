import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { StatusBar } from './StatusBar'
import { JobProvider } from '@/hooks/useActiveJob'
import { ThemeProvider } from './ThemeProvider'
import * as api from '@/lib/api'
import type { UpdateZustand } from '@/lib/types'

vi.mock('@/lib/api')

function zeigen() {
  return render(<MemoryRouter><JobProvider><StatusBar /></JobProvider></MemoryRouter>)
}

/** Electron-Bruecke nachbilden. Im Browser fehlt sie — genau der Unterschied, den die
 *  Version-Anzeige ueberbruecken muss. */
function bruecke(zustand: UpdateZustand) {
  ;(window as unknown as { transkribor: unknown }).transkribor = {
    update: {
      status: () => Promise.resolve(zustand),
      pruefen: () => Promise.resolve(), laden: () => Promise.resolve(), installieren: () => Promise.resolve(),
    },
    protokollOeffnen: () => Promise.resolve(''),
    // Pflichtfeld der Bruecke seit #372 — eine Attrappe, die es weglaesst, behauptet einen
    // Vertrag, den es nicht gibt (dieselbe Regel wie bei `as Settings`).
    fehlerbericht: () => Promise.resolve({ pfad: '', verwendet: 0, gekuerzt: false }),
    on: () => () => {},
  }
}

describe('StatusBar', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('sagt "Bereit", wenn nichts laeuft', async () => {
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cuda', name: 'RTX 5080', torch_ok: true, asr: 'cuda' })
    zeigen()
    expect(screen.getByText('Bereit')).toBeInTheDocument()
  })

  it('nennt das Rechenwerk aus /api/hardware', async () => {
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cuda', name: 'RTX 5080', torch_ok: true, asr: 'cuda' })
    zeigen()
    await waitFor(() => expect(screen.getByText('cuda')).toBeInTheDocument())
  })

  it('bleibt stehen, wenn /api/hardware nicht antwortet', async () => {
    // Eine Statuszeile, die bei einer fehlenden Nebeninformation die App abschiesst, ist
    // schlimmer als eine, die das Feld leer laesst.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    zeigen()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Bereit')).toBeInTheDocument()
  })

  it('fuehrt von jeder Seite in die Einstellungen', async () => {
    // Vorher stand der einzige Weg dorthin auf der Uebersicht — aus dem Editor musste man
    // erst zurueck zur Startseite.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    zeigen()
    expect(screen.getByRole('link', { name: /Einstellungen/ })).toHaveAttribute('href', '/einstellungen')
  })

  it('haelt den Theme-Umschalter auf jeder Seite bereit und schaltet ihn um', async () => {
    // Vorher hing er in der Editor-Werkzeugleiste — auf der Uebersicht kam man nicht heran.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    localStorage.setItem('theme', 'dark')   // sonst fragt der Provider matchMedia, das jsdom nicht hat
    render(<MemoryRouter><ThemeProvider><JobProvider><StatusBar /></JobProvider></ThemeProvider></MemoryRouter>)
    const knopf = screen.getByRole('button', { name: /hellem Design/ })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    await act(async () => { knopf.click() })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(screen.getByRole('button', { name: /dunklem Design/ })).toBeInTheDocument()
  })

  it('zeigt die Version auch ohne Electron-Bruecke', async () => {
    // Im Browser (webtool.ps1) gibt es keine Bruecke; frueher blieb das Feld dort leer.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    zeigen()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(`v${__APP_VERSION__}`)).toBeInTheDocument()
  })

  it('nimmt die Version der laufenden App, wenn Electron sie meldet', async () => {
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    bruecke({ version: '9.9.9', art: 'aktuell' })
    zeigen()
    await waitFor(() => expect(screen.getByText('v9.9.9')).toBeInTheDocument())
  })

  it('macht ein verfuegbares Update anklickbar', async () => {
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    bruecke({ version: '0.10.0', art: 'verfuegbar', neue: '0.11.0', groesse: 96 })
    zeigen()
    const link = await screen.findByRole('link', { name: /Update 0.11.0 verfügbar/ })
    expect(link).toHaveAttribute('href', '/version')
  })

  it('die Versionsnummer fuehrt zur Versionsseite', async () => {
    // Sie steht auf jeder Route, und wer wissen will, welche Fassung laeuft, klickt dort.
    // Vorher war sie ein blosser Text — der Weg fuehrte nur ueber die Einstellungen.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    zeigen()
    const link = await screen.findByRole('link', { name: /^v\d/ })
    expect(link).toHaveAttribute('href', '/version')
  })

  it('sagt eine tote Update-Quelle an — der einzige nicht_moeglich-Grund, der das tut', async () => {
    // Entwicklungsbetrieb und .deb sind Eigenschaften der Installation, die der Nutzer kennt.
    // `keine-quelle` ist ein Defekt, der ihn dauerhaft von Updates abschneidet: stuende er
    // nur auf der Versionsseite, merkte es niemand.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    bruecke({ version: '0.10.0', art: 'nicht_moeglich', grund: 'keine-quelle' })
    zeigen()
    expect(await screen.findByRole('link', { name: /Updates nicht möglich/ })).toBeTruthy()
  })

  it('sagt auch einen nicht gebauten Updater an', async () => {
    // #319 — derselbe Grund wie bei `keine-quelle`: ein Defekt, der still von Updates
    // abschneidet. In der Fusszeile steht er, weil die auf JEDER Seite sichtbar ist.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    bruecke({ version: '0.10.0', art: 'nicht_moeglich', grund: 'kein-updater' })
    zeigen()
    expect(await screen.findByRole('link', { name: /Updates nicht möglich/ })).toBeTruthy()
  })

  it('schweigt bei den anderen Gruenden, warum Updates nicht moeglich sind', async () => {
    // Gegenprobe: ein Daueralarm im Entwicklungsbetrieb waere derselbe Schaden von der
    // anderen Seite.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    bruecke({ version: '0.10.0', art: 'nicht_moeglich', grund: 'entwicklung' })
    zeigen()
    await waitFor(() => expect(screen.getByText('v0.10.0')).toBeInTheDocument())
    expect(screen.queryByText(/nicht möglich/)).toBeNull()
  })

  it('schweigt, solange es nichts zu tun gibt', async () => {
    // "aktuell" und "prueft" in einer Zeile, die man dauernd im Blick hat, sind Rauschen.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    bruecke({ version: '0.10.0', art: 'aktuell' })
    zeigen()
    await waitFor(() => expect(screen.getByText('v0.10.0')).toBeInTheDocument())
    expect(screen.queryByText(/Update/)).not.toBeInTheDocument()
  })
})
