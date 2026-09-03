import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { VersionPage } from './VersionPage'
import type { UpdateZustand } from '@/lib/types'
import type { Release } from '@/lib/releases'
import { toast } from 'sonner'

vi.mock('@/hooks/useUpdate', () => ({
  useUpdate: vi.fn(() => ({ zustand: null, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(), protokollOeffnen: vi.fn(), fehlerbericht: vi.fn(() => Promise.resolve(BERICHT)) })),
}))
vi.mock('@/lib/releases', () => ({ holeReleases: vi.fn() }))
// Der Opt-in-Schalter (#530): ohne Bruecke liefert der Hook `null`, und so bleibt es fuer die
// bestehenden Tests — nur der eigene Block unten setzt ihn.
vi.mock('@/hooks/useFehlerberichte', () => ({ useFehlerberichte: vi.fn(() => null) }))
// Ohne die Attrappe ist `toast.error` in jsdom kein Beobachtungspunkt — dieselbe Falle wie
// bei `toast.info` in #174.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

import { useUpdate } from '@/hooks/useUpdate'
import { useFehlerberichte } from '@/hooks/useFehlerberichte'
import { holeReleases } from '@/lib/releases'

/** Rueckgabe des Fehlerbericht-Kanals — die Attrappe muss die VOLLE Form liefern, sonst
 *  behauptet der Test einen Vertrag, den es nicht gibt (dieselbe Falle wie `as Settings`). */
const BERICHT = { pfad: 'C:\\log.txt', verwendet: 13, gekuerzt: true }

const RELEASE: Release = {
  version: '0.29.0', tag: 'v0.29.0', datum: '2026-08-21',
  notizen: '## Der Abspieler bleibt\n\nIm zweiten Schritt.', url: 'https://github.com/x/y/releases/tag/v0.29.0',
}

/** Seite mit einem Update-Zustand zeigen. `null` = kein Electron (reiner Browser). */
function zeigeMit(zustand: UpdateZustand | null, releases: Release[] = []) {
  const spies = { pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(), protokollOeffnen: vi.fn(), fehlerbericht: vi.fn(() => Promise.resolve(BERICHT)) }
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

  it('zu altes macOS: erklaert die Anforderung und bietet KEINEN Download an (#536)', async () => {
    // Der fehlende Knopf ist der Fix. Die Fassung liesse sich laden und installieren — sie
    // startet danach nur nicht mehr, und wer die alte App ersetzt hat, steht ohne da.
    const { spies } = zeigeMit({ version: '0.52.0', art: 'zu_altes_os', neue: '0.53.0', braucht: 13, hat: 12 })
    expect(await screen.findByText(/braucht macOS 13 oder neuer/)).toBeTruthy()
    expect(screen.getByText(/läuft macOS 12/)).toBeTruthy()
    // Der Satz sagt nur, was der Zustand hergibt: die installierte Fassung laeuft. Eine
    // Aussage ueber die LETZTE startfaehige Fassung waere unbelegbar — Zwischenfassungen
    // kennt der Zustand nicht (CodeRabbit am PR).
    expect(screen.getByText(/Die installierte Fassung 0\.52\.0 startet weiterhin/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /herunterladen/i })).toBeNull()
    expect(spies.laden).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /Alle Fassungen/ })).toBeTruthy()
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

  it('sagt bei kaputtem Updater die Wahrheit UND bietet den Weg an, den sie nennt', async () => {
    // #319: konnte `erstellen` gar nicht laufen, lieferte der IPC-Kanal `null` —
    // ununterscheidbar vom Browser-Fall. Die Seite schickte den Nutzer damit in die App, in
    // der er schon sass. Jetzt traegt der Zustand seinen eigenen Grund.
    // Die zweite Zusicherung misst den KNOPF, nicht die Abwesenheit des alten Satzes: der
    // stand allein im `!upd`-Zweig und waere fuer JEDEN Nicht-null-Zustand trivial weg
    // (Reviewbefund — die Zusicherung konnte nicht fehlschlagen). Das Menue ist
    // ausgeblendet, ohne diesen Knopf gibt es keinen Weg ins Protokoll.
    const { spies } = zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'kein-updater' })
    expect(await screen.findByText(/konnte nicht gestartet werden/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Protokoll' }))
    expect(spies.protokollOeffnen).toHaveBeenCalled()
  })

  it('bietet den Protokoll-Knopf NUR bei kein-updater an', async () => {
    // Gegenprobe: bei „Entwicklungsmodus" gibt es nichts nachzusehen — ein Knopf, der
    // ueberall steht, ist derselbe Schaden von der anderen Seite.
    //
    // Gemeint ist der Knopf IM Satz („Einzelheiten stehen im Protokoll"), Name genau
    // `Protokoll`. Seit #372 steht darunter ein DAUERHAFTER Abschnitt mit „Protokoll
    // anzeigen" — das ist kein Rueckschritt, sondern der Punkt jenes Issues: der Weg zum
    // Protokoll darf nicht nur ueber einen Fehlerzustand fuehren. `/Protokoll/` traefe
    // beide, deshalb der genaue Name.
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'entwicklung' })
    await screen.findByText(/Entwicklungsmodus/)
    expect(screen.queryByRole('button', { name: 'Protokoll' })).toBeNull()
    expect(screen.getByRole('button', { name: /Protokoll anzeigen/ })).toBeInTheDocument()
  })

  it('schreibt einen Fehlerbericht (#372)', async () => {
    const { spies } = zeigeMit({ version: '0.2.1', art: 'aktuell' })
    fireEvent.click(await screen.findByRole('button', { name: /Fehlerbericht schreiben/ }))
    expect(spies.fehlerbericht).toHaveBeenCalled()
  })

  it('scheitert das Oeffnen der Mail, sagt es die Seite (Reviewbefund B1)', async () => {
    // `openExternal` lehnt ohne registriertes Mailprogramm ab — auf einer frischen
    // Windows-Installation der Normalfall. Ohne diesen Zweig taete der Knopf sichtbar
    // nichts, waehrend die Zeile darueber eine vorbereitete Mail verspricht.
    const { spies } = zeigeMit({ version: '0.2.1', art: 'aktuell' })
    spies.fehlerbericht.mockRejectedValue(new Error('Kein Programm fuer mailto'))
    fireEvent.click(await screen.findByRole('button', { name: /Fehlerbericht schreiben/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it('bei Erfolg gibt es KEINE Fehlermeldung', async () => {
    // Gegenrichtung: ein Toast, der immer kommt, ist derselbe Schaden von der anderen Seite.
    const { spies } = zeigeMit({ version: '0.2.1', art: 'aktuell' })
    fireEvent.click(await screen.findByRole('button', { name: /Fehlerbericht schreiben/ }))
    // Auf das VERSPRECHEN der Attrappe warten, nicht auf einen Knopf, der schon vor dem Klick
    // dasteht: sonst kehrt `waitFor` beim ersten Versuch zurueck, die Promise-Kette aus
    // `berichtSchreiben` ist noch gar nicht gelaufen, und ein irrtuemlicher Toast entstuende
    // erst danach — der Test bliebe gruen (CodeRabbit-Bot).
    await spies.fehlerbericht.mock.results[0].value
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('sagt VOR dem Klick, was mitgeht — das ist die Antwort auf „was darf mit?"', async () => {
    // Der Kern von #372: gezeigt statt gefiltert. Ein Knopf, der wortlos eine Mail mit
    // Protokollzeilen aufmacht, waere genau das, was die README-Zusage verletzt.
    zeigeMit({ version: '0.2.1', art: 'aktuell' })
    expect(await screen.findByText(/letzten aussagekräftigen Zeilen des Protokolls/)).toBeTruthy()
    expect(screen.getByText(/bevor du sendest/)).toBeTruthy()
  })

  it('im reinen Browser gibt es den Abschnitt NICHT', async () => {
    // Gegenprobe: ohne Bruecke gibt es kein Protokoll — ein Knopf, der dort nichts tut,
    // waere ein Versprechen ohne Deckung (dieselbe Regel wie beim Update-Teil darueber).
    zeigeMit(null)
    await screen.findByText(__APP_VERSION__)
    expect(screen.queryByRole('button', { name: /Fehlerbericht/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Protokoll anzeigen/ })).toBeNull()
  })

  it('zeigt einen Fehler samt Weg zum Protokoll', async () => {
    zeigeMit({ version: '0.2.1', art: 'fehler', text: '404 releases.atom' })
    expect(await screen.findByText(/404 releases\.atom/)).toBeTruthy()
  })

  it('im Fehlerzustand: erneut pruefen bleibt moeglich, und es gibt einen Weg ins Protokoll', async () => {
    const { spies } = zeigeMit({ version: '0.2.1', art: 'fehler', text: '404 releases.atom' })
    await screen.findByText(/404 releases\.atom/)
    expect(screen.getByRole('button', { name: /Nach Updates suchen/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Protokoll' }))
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

  it('jede Fassung traegt ein Aufklapp-Symbol', async () => {
    // Der Browser zeichnet keines: `display: flex` am <summary> unterdrueckt den Marker
    // (gemessen — `::marker` leer, kein Dreieck), und eine zugeklappte Fassung sah damit
    // nach einer toten Zeile aus. Die DREHUNG beim Oeffnen kann jsdom nicht zeigen (kein
    // CSS); sie ist im Browser belegt (rotate: 90deg offen, none zu).
    zeigeMit(null, [RELEASE, { ...RELEASE, version: '0.28.0', tag: 'v0.28.0' }])
    await screen.findByRole('heading', { name: '0.29.0' })
    expect(document.querySelectorAll('details > summary svg')).toHaveLength(2)
  })

  it('sagt es, wenn der Verlauf nicht ladbar ist — samt Grund und Weg zu GitHub', async () => {
    // Kein Netz ist der Normalfall auf einem Rechner ohne Verbindung; eine leere Flaeche
    // liesse den Leser raten, ob es keine Fassungen gibt oder die Abfrage scheiterte.
    vi.mocked(useUpdate).mockReturnValue({ zustand: null, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(), protokollOeffnen: vi.fn(), fehlerbericht: vi.fn(() => Promise.resolve(BERICHT)) })
    vi.mocked(holeReleases).mockRejectedValue(new Error('GitHub antwortet 403'))
    render(<MemoryRouter><VersionPage /></MemoryRouter>)
    expect(await screen.findByText(/GitHub antwortet 403/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Auf GitHub ansehen/ })).toBeTruthy()
  })

  it('auch die leere Liste bietet den Weg zu GitHub an', async () => {
    // Sonst steht der Ausweg in zwei von drei Zweigen (Fehler, Nicht-leer) und ausgerechnet
    // dort nicht, wo die Seite gar nichts zu zeigen hat.
    zeigeMit(null, [])
    expect(await screen.findByText(/Noch keine veröffentlichten Fassungen/)).toBeTruthy()
    expect(screen.getAllByRole('link', { name: /Auf GitHub ansehen|Alle Fassungen ansehen/ }).length)
      .toBeGreaterThan(1)
  })

  it('eine Fassung ohne Notizen bleibt kein leerer Block', async () => {
    zeigeMit(null, [{ ...RELEASE, notizen: '   ' }])
    expect(await screen.findByText('Keine Beschreibung.')).toBeTruthy()
  })

  it('meldet den Abbruch des StrictMode-Doppelmounts NICHT als Fehler', async () => {
    // Der Waechter `if (!ab.signal.aborted)` hatte NULL Abdeckung (Reviewbefund): der
    // Abbruchtest unten mockt mit `mockResolvedValue`, der Mock lehnt also nie ab.
    // Nach einem UNMOUNT zu pruefen waere ebenfalls vacuous — dort ist das DOM leer, egal
    // was der catch tut. Scharf wird es nur im StrictMode: mount→unmount→mount auf
    // DERSELBEN Fiber, der erste Abruf lehnt ab, die Seite steht danach aber da.
    let n = 0
    vi.mocked(useUpdate).mockReturnValue({ zustand: null, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(), protokollOeffnen: vi.fn(), fehlerbericht: vi.fn(() => Promise.resolve(BERICHT)) })
    vi.mocked(holeReleases).mockImplementation((signal?: AbortSignal) => {
      n += 1
      if (n === 1) {
        return new Promise((_, ab) => {
          signal?.addEventListener('abort', () => ab(new Error('The user aborted a request.')))
        })
      }
      return Promise.resolve([RELEASE])
    })
    render(<StrictMode><MemoryRouter><VersionPage /></MemoryRouter></StrictMode>)
    expect(await screen.findByRole('heading', { name: '0.29.0' })).toBeTruthy()
    expect(screen.queryByText(/lässt sich gerade nicht laden/)).toBeNull()
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

describe('VersionPage — automatische Fehlerberichte (#530)', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)
  const STAND: UpdateZustand = { version: '0.2.1', art: 'aktuell' }
  const HAKEN = /Fehler automatisch an uns senden/

  it('ohne Schalter in der App-Huelle gibt es keinen Haken', () => {
    vi.mocked(useFehlerberichte).mockReturnValue(null)
    zeigeMit(STAND)
    expect(screen.queryByLabelText(HAKEN)).toBeNull()
  })

  it('mit Schalter: der Haken zeigt den Zustand, ein Klick ruft setzen mit dem NEUEN Wert', () => {
    const setzen = vi.fn(() => Promise.resolve({ automatisch: true, gefragt: 'x' }))
    vi.mocked(useFehlerberichte).mockReturnValue({ zustand: { automatisch: false, gefragt: 'x' }, setzen })
    zeigeMit(STAND)
    const haken = screen.getByLabelText(HAKEN) as HTMLInputElement
    expect(haken.checked).toBe(false)
    expect(haken.disabled).toBe(false)
    fireEvent.click(haken)
    expect(setzen).toHaveBeenCalledWith(true)
  })

  it('bis der Hauptprozess geantwortet hat, ist der Haken gesperrt', () => {
    vi.mocked(useFehlerberichte).mockReturnValue({ zustand: null, setzen: vi.fn() })
    zeigeMit(STAND)
    expect((screen.getByLabelText(HAKEN) as HTMLInputElement).disabled).toBe(true)
  })

  it('ein Fehlschlag beim Speichern wird gemeldet statt geschluckt', async () => {
    const setzen = vi.fn(() => Promise.reject(new Error('Platte voll')))
    vi.mocked(useFehlerberichte).mockReturnValue({ zustand: { automatisch: false, gefragt: 'x' }, setzen })
    zeigeMit(STAND)
    fireEvent.click(screen.getByLabelText(HAKEN))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/nicht speichern/)))
  })
})
