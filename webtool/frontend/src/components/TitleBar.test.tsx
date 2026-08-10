import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TitleBar } from './TitleBar'

function bruecke(plattform: string) {
  ;(window as unknown as { transkribor: unknown }).transkribor = { plattform, titelleisteFarbe: async () => {} }
}

describe('TitleBar', () => {
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('erscheint im normalen Browser GAR NICHT', () => {
    // Dieselbe Oberflaeche laeuft unter webtool.ps1 (:8000) und Vite (:5173). Dort gibt es
    // kein rahmenloses Fenster -- eine Zeile mit Fensterknoepfen waere dort schlicht falsch.
    const { container } = render(<TitleBar titel="Alpha" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('zeigt den Titel unter Electron', () => {
    bruecke('win32')
    render(<TitleBar titel="Alpha · audio_02" />)
    expect(screen.getByText('Alpha · audio_02')).toBeInTheDocument()
  })

  it('haelt links Platz fuer die Ampelknoepfe auf macOS', () => {
    bruecke('darwin')
    render(<TitleBar titel="Alpha" />)
    expect(screen.getByRole('banner')).toHaveClass('pl-[78px]')
  })
})
