import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { VersionPage } from './VersionPage'
import type { UpdateZustand } from '@/lib/types'
import type { Release } from '@/lib/releases'

vi.mock('@/hooks/useUpdate', () => ({
  useUpdate: vi.fn(() => ({ zustand: null, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(), protokollOeffnen: vi.fn() })),
}))
vi.mock('@/lib/releases', () => ({ holeReleases: vi.fn() }))

import { useUpdate } from '@/hooks/useUpdate'
import { holeReleases } from '@/lib/releases'

const RELEASE: Release = {
  version: '0.29.0', tag: 'v0.29.0', datum: '2026-08-21',
  notizen: '## Der Abspieler bleibt\n\nIm zweiten Schritt.', url: 'https://github.com/x/y/releases/tag/v0.29.0',
}

/** Seite mit einem Update-Zustand zeigen. `null` = kein Electron (reiner Browser). */
function zeigeMit(zustand: UpdateZustand | null, releases: Release[] = []) {
  const spies = { pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(), protokollOeffnen: vi.fn() }
  vi.mocked(useUpdate).mockReturnValue({ zustand, ...spies })
  vi.mocked(holeReleases).mockResolvedValue(releases)
  return { ...render(<MemoryRouter><VersionPage /></MemoryRouter>), spies }
}

describe('VersionPage — diese Fassung', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('zeigt ohne Electron die Bauzeit-Version und verspricht kein Update', async () => {
    // Im Browser gibt es die Bruecke nicht — die Seite muss trotzdem etwas sagen, statt
    // (wie der alte Abschnitt in den Einstellungen) einfach zu verschwinden.
    zeigeMit(null)
    // Gegen `__APP_VERSION__` selbst, nicht gegen eine Zahl: vitest setzt dort die echte
    // Version aus der Wurzel-package.json ein, ein Literal waere bei jedem Release rot.
    expect(await screen.findByText(__APP_VERSION__)).toBeTruthy()
    expect(screen.getByText(/Updates gibt es in der installierten App/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Nach Updates suchen/ })).toBeNull()
  })

  it('zeigt die laufende Version', async () => {
    zeigeMit({ version: '0.2.1', art: 'aktuell' })
    expect(await screen.findByText('0.2.1')).toBeTruthy()
    expect(screen.getByText(/neueste Fassung/)).toBeTruthy()
  })

  it('vor der ersten Pruefung nur Version und Knopf, keine Aussage ueber den Stand', async () => {
    zeigeMit({ version: '0.2.1', art: 'unbekannt' })
    expect(await screen.findByRole('button', { name: /Nach Updates suchen/ })).toBeTruthy()
    // sonst behauptet die Seite Wissen, das sie nicht hat
    expect(screen.queryByText(/neueste Fassung/)).toBeNull()
  })

  it('bietet den Download mit Groesse an', async () => {
    zeigeMit({ version: '0.2.1', art: 'verfuegbar', neue: '0.3.0', groesse: 98566144 })
    expect(await screen.findByText(/0\.3\.0 verfügbar/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Herunterladen \(94 MB\)/ })).toBeTruthy()
  })

  it('bietet den Download ohne Groesse an, statt "0 MB" zu erfinden', async () => {
    zeigeMit({ version: '0.2.1', art: 'verfuegbar', neue: '0.3.0', groesse: null })
    const btn = await screen.findByRole('button', { name: 'Herunterladen' })
    expect(btn.textContent).not.toMatch(/MB/)
  })

  it('zeigt beim Laden Prozent, MB und Tempo', async () => {
    zeigeMit({ version: '0.2.1', art: 'laedt', prozent: 43.2, geladen: 41 * 1048576, gesamt: 94 * 1048576, tempo: 6.2 * 1048576 })
    expect(await screen.findByText(/43 %/)).toBeTruthy()
    expect(screen.getByText(/41 von 94 MB/)).toBeTruthy()
    expect(screen.getByText(/6,2 MB\/s/)).toBeTruthy()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43')
  })

  it('bietet nach dem Laden den Neustart an', async () => {
    zeigeMit({ version: '0.2.1', art: 'bereit', neue: '0.3.0' })
    expect(await screen.findByRole('button', { name: /Neu starten und installieren/ })).toBeTruthy()
  })

  it('Mac (verfuegbar_manuell): Manuelldownload-Knopf statt Auto-Download', async () => {
    // Mac kann nicht auto-aktualisieren (Squirrel.Mac ohne Notarisierung), prueft aber manuell.
    // Der Knopf geht ueber den laden-IPC, der auf Mac die Release-Seite oeffnet.
    const { spies } = zeigeMit({ version: '0.16.0', art: 'verfuegbar_manuell', neue: '0.17.0', groesse: 149843177 })
    expect(await screen.findByText(/0\.17\.0/)).toBeTruthy()
    expect(screen.getByText(/Auto-Update.*nicht möglich/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Manuell herunterladen/ }))
    expect(spies.laden).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Herunterladen/ })).toBeNull()   // kein Auto-Knopf
  })

  it('kennt alle drei Gruende, warum Updates nicht moeglich sind', async () => {
    // `keine-quelle` ist der Zustand aus dem macOS-Fehler: beide Quellen fuer die Feed-URL
    // leer. Ohne eigenen Satz staende dort der Sammeltext ohne Ausweg.
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'entwicklung' })
    expect(await screen.findByText(/Entwicklungsmodus/)).toBeTruthy()
    cleanup()
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'kein-appimage' })
    expect(await screen.findByText(/AppImage/)).toBeTruthy()
    cleanup()
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'keine-quelle' })
    expect(await screen.findByText(/lade sie neu herunter/)).toBeTruthy()
  })

  it('zeigt einen Fehler samt Weg zum Protokoll', async () => {
    zeigeMit({ version: '0.2.1', art: 'fehler', text: '404 releases.atom' })
    expect(await screen.findByText(/404 releases\.atom/)).toBeTruthy()
  })

  it('im Fehlerzustand: erneut pruefen bleibt moeglich, und es gibt einen Weg ins Protokoll', async () => {
    const { spies } = zeigeMit({ version: '0.2.1', art: 'fehler', text: '404 releases.atom' })
    await screen.findByText(/404 releases\.atom/)
    expect(screen.getByRole('button', { name: /Nach Updates suchen/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Protokoll/ }))
    expect(spies.protokollOeffnen).toHaveBeenCalled()
  })

  it('sperrt den Knopf waehrend der Pruefung', async () => {
    zeigeMit({ version: '0.2.1', art: 'prueft' })
    expect((await screen.findByRole('button', { name: /Wird geprüft/ })).hasAttribute('disabled')).toBe(true)
  })
})

describe('VersionPage — Versionsverlauf', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('zeigt die Fassungen mit deutschem Datum und ihren Notizen', async () => {
    zeigeMit(null, [RELEASE])
    expect(await screen.findByRole('heading', { name: '0.29.0' })).toBeTruthy()
    expect(screen.getByText('21.08.2026')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Der Abspieler bleibt' })).toBeTruthy()
  })

  it('markiert die laufende Fassung — und nur sie', async () => {
    zeigeMit({ version: '0.28.0', art: 'aktuell' }, [
      RELEASE,
      { ...RELEASE, version: '0.28.0', tag: 'v0.28.0', notizen: 'Aelter.' },
    ])
    const marken = await screen.findAllByText('installiert')
    expect(marken).toHaveLength(1)
    // Die Marke steht am 0.28.0-Eintrag, nicht am neuesten.
    expect(marken[0].closest('summary')?.textContent).toMatch(/0\.28\.0/)
  })

  it('klappt die neueste Fassung auf und die aelteren zu', async () => {
    // Wer die Seite oeffnet, will fast immer wissen, was zuletzt kam.
    zeigeMit(null, [RELEASE, { ...RELEASE, version: '0.28.0', tag: 'v0.28.0' }])
    await screen.findByRole('heading', { name: '0.29.0' })
    const bloecke = document.querySelectorAll('details')
    expect(bloecke[0].open).toBe(true)
    expect(bloecke[1].open).toBe(false)
  })

  it('sagt es, wenn der Verlauf nicht ladbar ist — samt Grund und Weg zu GitHub', async () => {
    // Kein Netz ist der Normalfall auf einem Rechner ohne Verbindung; eine leere Flaeche
    // liesse den Leser raten, ob es keine Fassungen gibt oder die Abfrage scheiterte.
    vi.mocked(useUpdate).mockReturnValue({ zustand: null, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(), protokollOeffnen: vi.fn() })
    vi.mocked(holeReleases).mockRejectedValue(new Error('GitHub antwortet 403'))
    render(<MemoryRouter><VersionPage /></MemoryRouter>)
    expect(await screen.findByText(/GitHub antwortet 403/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Auf GitHub ansehen/ })).toBeTruthy()
  })

  it('eine Fassung ohne Notizen bleibt kein leerer Block', async () => {
    zeigeMit(null, [{ ...RELEASE, notizen: '   ' }])
    expect(await screen.findByText('Keine Beschreibung.')).toBeTruthy()
  })

  it('bricht die Abfrage ab, wenn die Seite verlassen wird', async () => {
    // Sonst setzt eine spaet eintreffende Antwort den Zustand einer Seite, die es nicht mehr
    // gibt — und beim schnellen Hin und Her das Ergebnis des naechsten Ladelaufs.
    const { unmount } = zeigeMit(null, [RELEASE])
    await waitFor(() => expect(holeReleases).toHaveBeenCalled())
    const signal = vi.mocked(holeReleases).mock.calls[0][0] as AbortSignal
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
  })
})
