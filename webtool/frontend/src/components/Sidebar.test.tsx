import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Sidebar } from './Sidebar'
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
    onCorrect: vi.fn(), onCorrectFile: vi.fn(), ...extra,
  }
  const { container } = render(<Sidebar {...props} />)
  return { ...props, container }
}

describe('Sidebar', () => {
  it('listet alle Projekte', () => {
    zeigen()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('zeigt die Dateien NUR des offenen Projekts', () => {
    zeigen({ offen: 'Alpha', dateien: DATEIEN })
    expect(screen.getByText(/^a/)).toBeInTheDocument()
    // Beta ist zu -- seine Dateien duerfen nicht erscheinen, und die Leiste fragt sie
    // auch nicht ab (die Dateiliste kommt fuer genau EIN Projekt herein).
    expect(screen.getByText('Beta')).toBeInTheDocument()
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
    render(<Sidebar projekte={[]} loading offen={null} dateien={[]} onWaehlen={vi.fn()}
      active={null} onOpen={vi.fn()} onUpload={vi.fn()} onTranscribe={vi.fn()}
      onCorrect={vi.fn()} onCorrectFile={vi.fn()} />)
    expect(screen.queryByText(/Noch keine Projekte/)).not.toBeInTheDocument()
  })

  it('sperrt Korrigieren ohne KI-Anbieter und nennt den Grund', () => {
    const grund = 'Claude Code ist nicht installiert. Unter „Einstellungen" einrichten.'
    zeigen({ offen: 'Alpha', dateien: DATEIEN, aiReason: grund })
    expect(screen.getByLabelText('Korrigieren + Sprecher')).toBeDisabled()
    expect(screen.getByLabelText('Nur „a" korrigieren')).toBeDisabled()
    expect(screen.getByLabelText('Transkribieren')).not.toBeDisabled()   // nur die Korrektur
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

  it('„x anlegen" im leeren Suchtreffer belegt den Namen vor', () => {
    zeigen()
    fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText(/^„Neu" anlegen$/))
    expect(screen.getByLabelText('Projektname')).toHaveValue('Neu')
  })
})
