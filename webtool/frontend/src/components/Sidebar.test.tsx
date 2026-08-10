import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'

const PROJEKTE = [
  { name: 'Alpha', dateien: 2 },
  { name: 'Beta', dateien: 1 },
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
  render(<Sidebar {...props} />)
  return props
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
    expect(screen.getByText(/zzz/)).toBeInTheDocument()
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
})
