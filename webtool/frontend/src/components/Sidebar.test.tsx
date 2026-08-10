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
    projekte: PROJEKTE, offen: null, dateien: [], onWaehlen: vi.fn(),
    active: null, onOpen: vi.fn(), onUpload: vi.fn(), onTranscribe: vi.fn(),
    onCorrect: vi.fn(), onGeloescht: vi.fn(), ...extra,
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
    render(<Huelle><Sidebar projekte={[]} loading offen={null} dateien={[]} onWaehlen={vi.fn()}
      active={null} onOpen={vi.fn()} onUpload={vi.fn()} onTranscribe={vi.fn()}
      onCorrect={vi.fn()} onGeloescht={vi.fn()} /></Huelle>)
    expect(screen.queryByText(/Noch keine Projekte/)).not.toBeInTheDocument()
  })

  it('sperrt Korrigieren ohne KI-Anbieter und nennt den Grund', async () => {
    const grund = 'Claude Code ist nicht installiert. Unter „Einstellungen" einrichten.'
    zeigen({ offen: 'Alpha', dateien: DATEIEN, aiReason: grund })
    expect(screen.getByLabelText('Korrigieren + Sprecher')).toBeDisabled()
    expect(screen.getByLabelText('Transkribieren')).not.toBeDisabled()   // nur die Korrektur
    // Die Datei-Seite steckt im ⋯-Menue (DateiMenue) und muss dort ebenso gesperrt sein.
    fireEvent.pointerDown(screen.getByLabelText('Aktionen für „a"'),
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
    const { onWaehlen } = zeigen()
    fireEvent.click(screen.getByText('+ Neues Projekt'))
    fireEvent.change(screen.getByLabelText('Projektname'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText('Anlegen'))
    await waitFor(() => expect(onWaehlen).toHaveBeenCalledWith('Neu'))
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

  it('„x anlegen" im leeren Suchtreffer belegt den Namen vor', () => {
    zeigen()
    fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText(/^„Neu" anlegen$/))
    expect(screen.getByLabelText('Projektname')).toHaveValue('Neu')
  })
})
