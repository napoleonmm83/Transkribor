import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HomeGallery } from './HomeGallery'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'
import { JobProvider } from '@/hooks/useActiveJob'
import { EditorBrueckeProvider } from '@/hooks/useEditorBruecke'
import * as api from '@/lib/api'
import type { Project } from '@/lib/types'

vi.mock('@/lib/api')

// Seit Task 5 haengt ProjektDatenProvider selbst an useActiveJob (onSettled fuer die
// Zusammenlegung) -- ohne JobProvider drumherum wirft er "ausserhalb JobProvider".
const zeigen = () =>
  render(<MemoryRouter><JobProvider><ProjektDatenProvider><EditorBrueckeProvider>
    <HomeGallery />
  </EditorBrueckeProvider></ProjektDatenProvider></JobProvider></MemoryRouter>)

describe('HomeGallery', () => {
  // Der ProjektDatenProvider adoptiert laufende Jobs aus `active_jobs` und fragt sie ab --
  // ungemockt liefert das Automock undefined, und `.then` darauf ist eine unbehandelte
  // Ablehnung. 'running' laesst die Abfrage nach einem Durchgang stehen (kein onSettled,
  // also keine zusaetzlichen Listenabrufe); das Aufraeumen des Effekts beendet sie.
  beforeEach(() => vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: [] }))

  it('zeigt Karten mit Dateizahl', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 1, fertig: 1, geaendert: 0, active_jobs: [] },
    ])
    zeigen()
    expect(await screen.findByText('Demo')).toBeInTheDocument()
    expect(screen.getByText(/1 Datei/)).toBeInTheDocument()
  })

  it('legt aus dem Leerzustand ein Projekt an (createProject aufgerufen)', async () => {
    // #69: „+ Neues Projekt" steht nicht mehr im Seitenkopf — der Knopf der Seitenleiste
    // ist auf JEDER Route sichtbar. Im Leerzustand bleibt ein eigener Knopf: der
    // beantwortet „hier ist noch nichts", nicht „lege noch eines an".
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.createProject).mockResolvedValue({ ok: true, name: 'Neu' })
    zeigen()
    fireEvent.click(await screen.findByText('Erstes Projekt anlegen'))
    fireEvent.change(screen.getByLabelText('Projektname'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText('Anlegen'))
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('Neu'))
  })

  it('zeigt den Anlege-Knopf im Kopf NUR, wo die Seitenleiste fehlt (#69)', async () => {
    // #69 galt dem Doppel auf EINEM Schirm: ab `md` traegt den Knopf die Leiste (auf jeder
    // Route), hier waere er der zweite wortgleiche. UNTER `md` blendet die Huelle die Leiste
    // aus — dann ist dieser hier der einzige Weg, denn der Leerzustands-Knopf erscheint nur
    // ohne Projekte und die Palette kann Projekte nur oeffnen, nicht anlegen.
    //
    // Geprueft wird die KLASSE, nicht die Sichtbarkeit: jsdom rechnet keine Media Queries,
    // `toBeVisible()` waere hier blind fuer genau die Regel, um die es geht (dieselbe Falle
    // wie bei den ARIA-Landmarken in AppShell.test.tsx).
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Alpha', dateien: 1, fertig: 1, geaendert: 0 }])
    zeigen()
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    // Aufsteigend nach der Klasse suchen statt per CSS-Selektor: der Doppelpunkt in
    // `md:hidden` muesste dort maskiert werden, und ein falsch maskierter Selektor
    // findet schlicht nichts — ein Test, der aus dem falschen Grund rot wird.
    let el: HTMLElement | null = screen.getByText('+ Neues Projekt')
    let nurSchmal = false
    while (el && !nurSchmal) { nurSchmal = el.classList.contains('md:hidden'); el = el.parentElement }
    expect(nurSchmal).toBe(true)
  })

  it('zeigt laufende Projekte als Karten', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alpha', dateien: 8, fertig: 3, geaendert: 0, active_jobs: [{ id: '1', kind: 'correct' }] },
    ])
    zeigen()
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')
  })

  it('listet die Projekte NICHT nochmal als Zeilen — die stehen in der Seitenleiste', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Ruhig', dateien: 2, fertig: 2, geaendert: 0 },
    ])
    zeigen()
    await waitFor(() => expect(screen.getByText(/Zuletzt geändert/)).toBeInTheDocument())
    expect(screen.queryByLabelText('Projekte durchsuchen')).not.toBeInTheDocument()
  })

  it('laesst sich aus der Zeilenliste loeschen', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alt', dateien: 1, fertig: 1, geaendert: 100, active_jobs: [] },
    ])
    vi.mocked(api.deleteProject).mockResolvedValue(undefined)
    zeigen()
    await screen.findByText('Alt')
    // Seit dem ProjektMenue liegt Loeschen hinter dem ⋯ — pointerDown, weil Radix darauf
    // oeffnet und nicht auf click (dasselbe Muster wie in Sidebar.test/AppShell.test).
    fireEvent.pointerDown(screen.getByLabelText('Aktionen für „Alt“'),
      new PointerEvent('pointerdown', { bubbles: true, ctrlKey: false, button: 0 }))
    fireEvent.click(await screen.findByText('Löschen'))
    fireEvent.change(await screen.findByLabelText(/Projektname best/), { target: { value: 'Alt' } })
    fireEvent.click(screen.getByRole('button', { name: /^L/ }))
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('Alt'))
  })

  it('laesst sich aus der Zeilenliste umbenennen', async () => {
    // Der Punkt des ProjektMenues: vorher gab es in der Uebersicht NUR den Papierkorb —
    // umbenennen konnte man ein Projekt ausschliesslich in der Seitenleiste.
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alt', dateien: 1, fertig: 1, geaendert: 100, active_jobs: [] },
    ])
    vi.mocked(api.renameProject).mockResolvedValue({ name: 'Neu' })
    zeigen()
    await screen.findByText('Alt')
    fireEvent.pointerDown(screen.getByLabelText('Aktionen für „Alt“'),
      new PointerEvent('pointerdown', { bubbles: true, ctrlKey: false, button: 0 }))
    fireEvent.click(await screen.findByText('Umbenennen'))
    fireEvent.change(await screen.findByLabelText('Neuer Name'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }))
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith('Alt', 'Neu'))
  })

  it('zeigt einen Ladezustand statt "Noch keine Projekte", solange die Liste unterwegs ist', async () => {
    let loese: ((p: []) => void) | null = null
    vi.mocked(api.listProjects).mockReturnValue(new Promise(r => { loese = r }))
    zeigen()
    expect(await screen.findByText(/werden geladen/)).toBeInTheDocument()
    expect(screen.queryByText('Noch keine Projekte')).not.toBeInTheDocument()
    await act(async () => { loese!([]) })
    expect(await screen.findByText('Noch keine Projekte')).toBeInTheDocument()
  })

  it('zeigt einen Fehlerzustand statt "Noch keine Projekte", wenn das Laden scheitert', async () => {
    vi.mocked(api.listProjects).mockRejectedValue(new Error('offline'))
    zeigen()
    expect(await screen.findByText(/konnten nicht geladen werden/)).toBeInTheDocument()
    expect(screen.queryByText('Noch keine Projekte')).not.toBeInTheDocument()
    // Erneut versuchen ruft den Endpunkt noch einmal.
    const versuche = vi.mocked(api.listProjects).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
    await waitFor(() => expect(vi.mocked(api.listProjects).mock.calls.length).toBeGreaterThan(versuche))
  })
  // ── #70: bei wenigen Projekten Karten statt der dichten Zeilenliste ───────────
  // `Project[]`, nicht abgeleitet: ohne die Annotation faellt `active_jobs: []` auf `never[]`,
  // und der Test, der EINEN Job einsetzt, scheitert erst an `tsc -b` — nicht in vitest.
  const ruhig = (n: number): Project[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `P${i + 1}`, dateien: 4, fertig: 2, geaendert: 1000 - i, active_jobs: [],
    }))

  it('zeigt bei wenigen Projekten KARTEN — sonst stehen dort fuenf Zeilen und ~450 px Leere', async () => {
    // Erkennungsmerkmal ist der Fortschrittsbalken: die dichte Zeile hat keinen. An der
    // Ueberschrift waere nichts zu messen, die ist in beiden Faellen dieselbe.
    vi.mocked(api.listProjects).mockResolvedValue(ruhig(3))
    zeigen()
    await screen.findByText('P1')
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
    // Und die Karte sagt WANN — sonst stuende "Zuletzt geaendert" ueber Kacheln, an denen
    // die Sortierung die einzige Auskunft darueber waere (Reviewbefund B6).
    expect(document.querySelectorAll('time')).toHaveLength(3)
  })

  it('an der Schwelle (8) noch Karten, darueber wieder Zeilen — und dann hoechstens fuenf', async () => {
    // Beide Haelften in einem Test, weil die Grenze die Aussage IST: `<=` gegen `<` faellt
    // sonst durch (bei 8 gaebe es dann Zeilen, und der Kartentest oben mit 3 bliebe gruen).
    vi.mocked(api.listProjects).mockResolvedValue(ruhig(8))
    const acht = zeigen()
    await screen.findByText('P1')
    expect(screen.getAllByRole('progressbar')).toHaveLength(8)
    acht.unmount()

    vi.mocked(api.listProjects).mockResolvedValue(ruhig(9))
    zeigen()
    await screen.findByText('P1')
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
    expect(screen.queryByText('P6')).not.toBeInTheDocument()
  })

  it('ein FREMDER Job kippt den Aufbau der Seite nicht (#70, Reviewbefund B3)', async () => {
    // Gezaehlt werden alle Projekte, nicht die ruhenden. Sonst entscheidet "wie viele rechnen
    // gerade nicht" ueber die Darstellung — und das aendert sich ohne Zutun (Auto-Trigger,
    // 4-s-Poll). Bei genau neun Projekten kippte die untere Haelfte bei jedem Jobstart von
    // fuenf Zeilen auf acht Karten und zurueck; React wirft dabei den Teilbaum weg und
    // mountet ProjektMenue neu, samt offenem Umbenennen-Dialog.
    const neun = ruhig(9)
    neun[0] = { ...neun[0], active_jobs: [{ id: '1', kind: 'transcribe' }] }
    vi.mocked(api.listProjects).mockResolvedValue(neun)
    zeigen()
    await screen.findByText('P1')
    // Genau EIN Fortschrittsbalken: der des laufenden Projekts oben. Mit `ruhende.length`
    // waeren es neun (acht Karten unten plus die eine oben).
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  })

  it('ein laufendes Projekt steht oben als Karte und NICHT noch einmal darunter', async () => {
    // Der Ausschluss galt schon fuer die Zeilenliste; seit beide Abschnitte dasselbe
    // Bauteil rendern, saehe eine Dublette identisch aus und fiele niemandem auf.
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Laeuft', dateien: 4, fertig: 1, geaendert: 5, active_jobs: [{ id: '1', kind: 'transcribe' }] },
      { name: 'Ruht', dateien: 2, fertig: 2, geaendert: 4, active_jobs: [] },
    ])
    zeigen()
    await screen.findByText('Laeuft')
    expect(screen.getAllByText('Laeuft')).toHaveLength(1)
    expect(screen.getByText(/Läuft gerade · 1/)).toBeInTheDocument()
  })

  // ── #428: ohne Zeigegeraet gibt es kein Hover ────────────────────────────────
  // ZWEI Tests statt eines, weil Karte und Zeile auf demselben Schirm stehen und sich
  // gleich verhalten muessen: eine Regel, die nur an einer der beiden Flaechen haengt,
  // faellt niemandem auf — man sieht immer nur eine davon.
  //
  // Geprueft wird die KLASSE, nicht die Sichtbarkeit: jsdom rechnet keine Media Queries,
  // `toBeVisible()` waere blind fuer genau die Regel, um die es geht (dieselbe Falle wie
  // beim md:hidden-Test oben). Ob die Klasse ueberhaupt ins CSS kompiliert wird, kann
  // dieser Test ebenfalls nicht sehen — das beantwortet der Build-Grep, nicht vitest.
  const zeigerlosSichtbar = (start: HTMLElement) => {
    // Aufsteigend gesucht wird das Element, das die Flaeche VERSTECKT (`opacity-0`) — und
    // die Override-Klasse muss GENAU DORT sitzen. Die erste Fassung liess sie an jedem
    // Vorfahren gelten und deckte damit nur ihre Anwesenheit, nicht ihren Ort: im Review
    // gegengemessen blieb sie gruen, als die Klasse testweise aufs <li> wanderte, wo sie
    // wirkungslos ist (15 passed im kaputten Zustand). So deckt der Waechter BEIDE
    // Mutationen — Klasse entfernt UND Klasse verschoben.
    //
    // Kein CSS-Selektor: die Doppelpunkte in `any-pointer-coarse:opacity-100` muessten
    // dort maskiert werden, und ein falsch maskierter Selektor findet schlicht nichts —
    // ein Test, der aus dem falschen Grund rot wird.
    let el: HTMLElement | null = start
    while (el && !el.classList.contains('opacity-0')) el = el.parentElement
    return !!el && el.classList.contains('any-pointer-coarse:opacity-100')
  }

  it('haelt den ⋯-Knopf der KARTE ohne Zeigegeraet sichtbar (#428)', async () => {
    // Ohne Hover ist der Knopf hier unsichtbar. Nicht unerreichbar — Umbenennen und
    // Loeschen gibt es auch in der geoeffneten Projektseite und ab `md` in der
    // Seitenleiste; der Fix stellt ihn dort her, wo man ihn sucht.
    vi.mocked(api.listProjects).mockResolvedValue(ruhig(3))
    zeigen()
    await screen.findByText('P1')
    // Erst belegen, dass wir wirklich in der Kartenansicht sind: der Fortschrittsbalken
    // ist das Erkennungsmerkmal (die dichte Zeile hat keinen). Ohne diese Zeile koennte
    // der Test die Zeilenliste messen und trotzdem gruen sein.
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
    expect(zeigerlosSichtbar(screen.getByLabelText('Aktionen für „P1“'))).toBe(true)
  })

  it('haelt den ⋯-Knopf der ZEILE ohne Zeigegeraet sichtbar (#428)', async () => {
    // Ab neun Projekten kippt die Uebersicht auf die dichte Zeilenliste (#70).
    vi.mocked(api.listProjects).mockResolvedValue(ruhig(9))
    zeigen()
    await screen.findByText('P1')
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
    expect(zeigerlosSichtbar(screen.getByLabelText('Aktionen für „P1“'))).toBe(true)
  })
})
