import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import { Huelle } from '@/lib/testHuelle'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

// Beta ist juenger als Alpha, steht aber im Array HINTER ihm -- ein Test, der nur die
// hereingegebene Reihenfolge durchreicht (statt wirklich zu sortieren), faellt so durch.
const PROJEKTE = [
  { name: 'Alpha', dateien: 2, geaendert: 100 },
  { name: 'Beta', dateien: 1, geaendert: 200 },
]
const DATEIEN = [
  { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false },
  { base: 'b', has_audio: true, has_raw: false, has_edit: false, has_md: false },
]

function zeigen(extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    projekte: PROJEKTE, offen: null, dateien: [], onWaehlen: vi.fn(), onAngelegt: vi.fn(),
    active: null, onOpen: vi.fn(), onUpload: vi.fn(), onTranscribe: vi.fn(),
    onCorrect: vi.fn(), onGeloescht: vi.fn(), onUmbenannt: vi.fn(), ...extra,
  }
  const { container } = render(<Huelle><Sidebar {...props} /></Huelle>)
  return { ...props, container }
}

// Die Huelle bringt den echten ProjektDatenProvider mit — der pollt beim Aufsetzen, und ein
// automock-`undefined` statt eines Promise reisst jeden Test um.
beforeEach(() => {
  vi.mocked(api.listProjects).mockResolvedValue([])
  vi.mocked(api.getProjectFiles).mockResolvedValue({ name: '', files: [] })
})

describe('Sidebar', () => {
  it('listet alle Projekte', () => {
    zeigen()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('zeigt die Dateien NUR des offenen Projekts', () => {
    zeigen({ offen: 'Alpha', dateien: DATEIEN })
    // Beide Projektzeilen mitsamt allem, was darunter haengt: unter Alpha muessen die
    // Dateien stehen, unter dem zugeklappten Beta darf nichts davon auftauchen. Die
    // Dateiliste kommt fuer genau EIN Projekt herein -- an jede Zeile gehaengt zeigte sie
    // unter Beta die Dateien von Alpha.
    const zeile = (name: string) => screen.getByText(name).closest('button')!.parentElement!
    expect(within(zeile('Alpha')).getByText('a')).toBeInTheDocument()
    expect(within(zeile('Beta')).queryByText('a')).not.toBeInTheDocument()
    expect(within(zeile('Beta')).queryByLabelText(/^Datei /)).not.toBeInTheDocument()
  })

  it('waehlt bei Klick auf eine geschlossene Zeile das Projekt', () => {
    const { onWaehlen } = zeigen({ offen: 'Alpha', dateien: DATEIEN })
    fireEvent.click(screen.getByText('Beta'))
    expect(onWaehlen).toHaveBeenCalledWith('Beta')
  })

  it('klappt das offene Projekt bei erneutem Klick zu', () => {
    const { onWaehlen } = zeigen({ offen: 'Alpha', dateien: DATEIEN })
    fireEvent.click(screen.getByText('Alpha'))
    expect(onWaehlen).toHaveBeenCalledWith(null)
  })

  it('filtert nach dem Suchbegriff', () => {
    zeigen()
    fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'bet' } })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('nennt einen leeren Suchtreffer beim Namen statt leer zu bleiben', () => {
    zeigen()
    fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'zzz' } })
    // Nicht /zzz/ (matcht seit dem "anlegen"-Knopf zweimal) -- der Hinweistext im Speziellen.
    expect(screen.getByText(/^Kein Projekt passt zu/)).toBeInTheDocument()
  })

  it('unterscheidet "laedt" von "keine Projekte"', () => {
    // Dieselbe Regel wie in der Galerie: eine leere Liste hat drei Gruende und darf nicht
    // waehrend des Ladens behaupten, es gaebe nichts.
    render(<Huelle><Sidebar projekte={[]} loading offen={null} dateien={[]} onWaehlen={vi.fn()} onAngelegt={vi.fn()}
      active={null} onOpen={vi.fn()} onUpload={vi.fn()} onTranscribe={vi.fn()}
      onCorrect={vi.fn()} onGeloescht={vi.fn()} onUmbenannt={vi.fn()} /></Huelle>)
    expect(screen.queryByText(/Noch keine Projekte/)).not.toBeInTheDocument()
  })

  it('sperrt Korrigieren ohne KI-Anbieter und nennt den Grund', async () => {
    const grund = 'Claude Code ist nicht installiert. Unter „Einstellungen“ einrichten.'
    zeigen({ offen: 'Alpha', dateien: DATEIEN, aiReason: grund })
    expect(screen.getByLabelText('Korrigieren + Sprecher')).toBeDisabled()
    expect(screen.getByLabelText('Transkribieren')).not.toBeDisabled()   // nur die Korrektur
    // Die Datei-Seite steckt im ⋯-Menue (DateiMenue) und muss dort ebenso gesperrt sein.
    fireEvent.pointerDown(screen.getByLabelText('Aktionen für „a“'),
      { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(await screen.findByRole('menuitem', { name: 'Korrigieren' })).toHaveAttribute('data-disabled')
  })

  it('öffnet eine Datei bei Klick', () => {
    const { onOpen } = zeigen({ offen: 'Alpha', dateien: DATEIEN })
    fireEvent.click(screen.getByText(/^a/))
    expect(onOpen).toHaveBeenCalledWith({ project: 'Alpha', base: 'a' })
  })

  it('sortiert nach zuletzt geaendert, nicht nach Einreihung', () => {
    const { container } = zeigen()
    const text = container.textContent!
    expect(text.indexOf('Beta')).toBeLessThan(text.indexOf('Alpha'))
  })

  it('legt über "+ Neues Projekt" ein Projekt an', async () => {
    vi.mocked(api.createProject).mockResolvedValue({ ok: true, name: 'Neu' })
    const { onAngelegt, onWaehlen } = zeigen()
    fireEvent.click(screen.getByText('+ Neues Projekt'))
    fireEvent.change(screen.getByLabelText('Projektname'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText('Anlegen'))
    await waitFor(() => expect(onAngelegt).toHaveBeenCalledWith('Neu'))
    // #74: NICHT ueber onWaehlen — dort heisst `null` „zuklappen", ein Anlegen
    // kennt das nicht. Beide Bedeutungen auf einem Rueckruf war nur zufaellig richtig.
    expect(onWaehlen).not.toHaveBeenCalled()
  })

  it('loescht das aufgeklappte Projekt', async () => {
    // Die Uebersicht zeigt nur die fuenf juengsten -- ohne diesen Weg waere ein aelteres
    // Projekt ueber die Oberflaeche gar nicht mehr loeschbar.
    vi.mocked(api.deleteProject).mockResolvedValue(undefined)
    const { onGeloescht } = zeigen({ offen: 'Alpha', dateien: DATEIEN })
    // Nur am offenen Projekt, nicht an jeder Zeile: sonst ist die Liste eine Werkzeugleiste.
    expect(screen.queryByLabelText('Projekt Beta löschen')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Projekt Alpha löschen'))
    fireEvent.change(await screen.findByLabelText(/Projektname best/), { target: { value: 'Alpha' } })
    fireEvent.click(screen.getByRole('button', { name: /^Löschen$/ }))
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('Alpha'))
    await waitFor(() => expect(onGeloescht).toHaveBeenCalledWith('Alpha'))
  })

  it('„x anlegen“ im leeren Suchtreffer belegt den Namen vor', () => {
    zeigen()
    fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText(/^„Neu“ anlegen$/))
    expect(screen.getByLabelText('Projektname')).toHaveValue('Neu')
  })

  it('der Spendenknopf zeigt auf GitHub Sponsors und oeffnet ein neues Fenster', () => {
    zeigen()
    const knopf = screen.getByRole('link', { name: /Projekt unterstützen/ })
    expect(knopf).toHaveAttribute('href', 'https://github.com/sponsors/napoleonmm83')
    // Pflicht, nicht Hoeflichkeit: das Electron-Fenster hat keine Adresszeile und keinen
    // Zurueck-Knopf -- im selben Fenster geoeffnet waere GitHub eine Einbahnstrasse aus
    // dem Programm heraus. `setWindowOpenHandler` in electron/main.js faengt `_blank` ab.
    expect(knopf).toHaveAttribute('target', '_blank')
    expect(knopf).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
  })

  it('der Spendenblock steht NACH der rollenden Projektliste, nicht darin', () => {
    // Das ist die eigentliche Zusicherung hinter „unten festgenagelt": die Leiste ist eine
    // Flex-Spalte, in der nur das <nav> waechst -- ein Geschwister DAHINTER steht damit
    // immer am unteren Rand. jsdom rechnet kein Layout; die STRUKTUR ist der Teil, der hier
    // pruefbar ist, das Aussehen kommt aus der Browser-Gegenprobe.
    //
    // Gemessen wird die REIHENFOLGE, nicht das Enthaltensein: `not.toContainElement` ist
    // `Node.contains` und damit reihenfolgeblind -- der Block VOR das Suchfeld geschoben
    // (der wahrscheinlichste naechste Diff, wenn jemand ihn optisch hochziehen will) steckt
    // ebenfalls nicht im <nav>, stuende aber oben links statt unten links. Beide
    // Verschiebungen sehen von aussen gleich aus und haetten entgegengesetzte Abdeckung.
    //
    // Es braucht BEIDE Haelften, und das ist gemessen, nicht gefolgert: fuer einen NACHFAHREN
    // setzt `compareDocumentPosition` `CONTAINED_BY` UND `FOLLOWING` (ein Kind steht in
    // Dokumentreihenfolge ja auch danach). Die Reihenfolge-Zeile allein liess Mutation A also
    // gruen durch — der Fix fuer die eine Blindstelle riss die andere wieder auf.
    const { container } = zeigen()
    const nav = container.querySelector('nav')
    const knopf = screen.getByRole('link', { name: /Projekt unterstützen/ })
    expect(nav).not.toBeNull()
    expect(nav).toContainElement(screen.getByText('Alpha'))   // Positivkontrolle
    expect(nav).not.toContainElement(knopf)                                  // nicht DARIN
    expect(nav!.compareDocumentPosition(knopf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()  // sondern DANACH
  })

  it('der Spendenblock verschwindet, wenn die Leiste ihren Klemmzustand meldet (#328)', () => {
    // BEIDE Richtungen, und das ist die Auflage aus dem Issue: ein Waechter, der nur die
    // ABWESENHEIT prueft, bleibt gruen, wenn der Block ganz aus dem Bauteil faellt. Der
    // Normalfall ist deshalb Teil derselben Zusicherung.
    // Zwei Renders nebeneinander, je auf ihren `container` eingegrenzt: `zeigen` gibt kein
    // `unmount` heraus, und ein globales `screen` faende in beiden Baeumen gleichzeitig.
    const normal = within(zeigen().container)
    expect(normal.queryByRole('link', { name: /Projekt unterstützen/ })).not.toBeNull()

    const klemmt = within(zeigen({ projekte: [], fehler: true }).container)
    expect(klemmt.getByText('Projekte konnten nicht geladen werden.')).toBeInTheDocument()
    expect(klemmt.queryByRole('link', { name: /Projekt unterstützen/ })).toBeNull()
    // Die Hinweiszeile geht MIT weg, nicht nur der Knopf -- „wenn es dir Arbeit abnimmt"
    // ist genau im Klemmzustand am falschesten.
    expect(klemmt.queryByText(/kostenlos und bleibt es/)).toBeNull()
  })

  it('das LEERE, gesunde Projektverzeichnis ist kein Klemmzustand (#328)', () => {
    // Die Gegenrichtung, und sie war die Luecke: die drei ersten Mutationen VERBREITERN die
    // Bedingung alle, „zu eng" blieb ungeprueft. `geklemmt` ohne `!!fehler` liess 17/17 Tests
    // gruen (gemessener Reviewbefund) — und das Schadensbild ist der Zustand JEDER
    // Neuinstallation: Zeile 95 prueft `!fehler`, also stuenden „Noch keine Projekte." und
    // „Projekte konnten nicht geladen werden." gleichzeitig da, und die gesunde App verstecke
    // ihren Spendenblock. Kein anderes Testfile rendert die Leiste; die Mutation ueberlebte
    // die ganze Suite.
    const leer = within(zeigen({ projekte: [] }).container)
    expect(leer.getByText('Noch keine Projekte.')).toBeInTheDocument()
    expect(leer.queryByText('Projekte konnten nicht geladen werden.')).toBeNull()
    expect(leer.queryByRole('link', { name: /Projekt unterstützen/ })).not.toBeNull()
  })

  it('waehrend des Ladens gilt nichts als geklemmt, auch nach einem Fehler (#328)', () => {
    // Bewacht das dritte Glied (`!loading`), das ebenfalls null Abdeckung hatte. Die
    // Produktionswirkung ist klein (`useProjects` haelt fehler UND loading hoechstens einen
    // Zwischenrender lang) — aber der Kommentar an `geklemmt` behauptet das Glied, und was
    // behauptet wird, wird bewacht.
    const laedt = within(zeigen({ projekte: [], loading: true, fehler: true }).container)
    expect(laedt.getByText('lädt…')).toBeInTheDocument()
    expect(laedt.queryByText('Projekte konnten nicht geladen werden.')).toBeNull()
    expect(laedt.queryByRole('link', { name: /Projekt unterstützen/ })).not.toBeNull()
  })

  it('ein fehlgeschlagener Poll bei STEHENDER Liste blendet nichts aus (#328)', () => {
    // Die Bedingung ist bewusst NICHT `fehler` allein: schlaegt ein Poll fehl, waehrend die
    // Liste steht, sieht der Nutzer eine funktionierende App -- dort waere das Ausblenden ein
    // Flackern ohne Anlass. Ohne diesen Test bliebe die Verkuerzung auf `!!fehler` gruen.
    const b = within(zeigen({ fehler: true }).container)
    expect(b.queryByText('Projekte konnten nicht geladen werden.')).toBeNull()
    expect(b.queryByRole('link', { name: /Projekt unterstützen/ })).not.toBeNull()
  })
})

describe('Sidebar - Zulassung fuer eine mitten im Lauf dazugekommene Aufnahme (#431)', () => {
  // ZWEITER Ort desselben Filters. Der Parser laesst das Urteil seit dem Fix durch; ohne die
  // gleiche Erweiterung hier warf `inScope` es sofort wieder weg.
  //
  // Wo die Behauptung "der Parser-Fix allein aenderte an der Anzeige NICHTS" herkommt, damit
  // sie nicht als unbelegt dasteht (CodeRabbit hat sie an PR #476 genau so beanstandet):
  // GEMESSEN im BROWSER waehrend PR #476 - Wegwerf-Projekt, uvicorn, zweiter Upload waehrend
  // eines laufenden Laufs, Seitenleiste vorher nur Wellen-Symbol / nachher Spinner. DIESER
  // TEST beweist das nicht: er baut `phasen` von Hand und fasst den Parser gar nicht an. Die
  // Beleg-Screenshots liegen nicht im Repo - Belege werden hier grundsaetzlich nicht
  // committet (`git ls-files` zeigt ausser Doku- und Marken-Bildern keine).
  const phasen = (gesehen?: string[]) => ({
    global: null, active: {}, perBase: { b: 'failed' as const },
    scope: new Set(['a']), ...(gesehen ? { gesehen: new Set(gesehen) } : {}),
  })

  it('zeigt den Zustand einer Aufnahme, die nur ueber `gesehen` zugelassen ist', () => {
    zeigen({ offen: 'Alpha', dateien: DATEIEN, jobRunning: true, phases: phasen(['b']) })
    expect(screen.getByText('Fehler')).toBeInTheDocument()
  })

  // Gegenrichtung: ohne die Zulassung bleibt es beim alten Verhalten. Ohne diesen Test waere
  // der obige auch dann gruen, wenn `inScope` gar nicht mehr filterte.
  it('zeigt ihn NICHT, solange sie weder im Bereich steht noch angefasst wurde', () => {
    zeigen({ offen: 'Alpha', dateien: DATEIEN, jobRunning: true, phases: phasen() })
    expect(screen.queryByText('Fehler')).not.toBeInTheDocument()
  })
})

describe('Sidebar - Beobachtung stellt keine Warte-Prognose (#431, Review-Befund A2)', () => {
  it('zeigt die Warteschlange nur fuer Dateien AUS DEM BEREICH', () => {
    // `a` steht im Bereich und hat keinen Zustand -> Warteschlange. `b` ist nur beobachtet
    // (Glossar meldet seit #450 korpusweit) -> KEINE Prognose. Gemessen war es vorher 3 statt 1.
    zeigen({ offen: 'Alpha', dateien: DATEIEN, jobRunning: true,
      phases: { global: null, active: {}, perBase: {},
                scope: new Set(['a']), gesehen: new Set(['a', 'b']) } })
    expect(screen.getAllByText('In Warteschlange…')).toHaveLength(1)
  })
})
