import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'

const projects = [{ name: 'P', files: [{ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }] }]

describe('Sidebar', () => {
  it('öffnet Datei bei Klick', () => {
    const onOpen = vi.fn()
    render(<Sidebar projects={projects} active={null} onOpen={onOpen} onUpload={vi.fn()}
      onTranscribe={vi.fn()} onCorrect={vi.fn()} onCorrectFile={vi.fn()} />)
    fireEvent.click(screen.getByText(/^a/))
    expect(onOpen).toHaveBeenCalledWith({ project: 'P', base: 'a' })
  })

  it('zeigt "Keine Projekte" nicht während des ersten Ladens', () => {
    render(<Sidebar projects={[]} loading active={null} onOpen={vi.fn()} onUpload={vi.fn()}
      onTranscribe={vi.fn()} onCorrect={vi.fn()} onCorrectFile={vi.fn()} />)
    expect(screen.queryByText(/Keine Projekte/)).not.toBeInTheDocument()
  })

  it('sperrt Korrigieren ohne KI-Anbieter und nennt den Grund', () => {
    // Ohne Gate liefe der Job an, überspränge jede Datei und endete grün — ein
    // schlechterer erster Eindruck als ein Fehler.
    const grund = 'Claude Code ist nicht installiert. Unter „Einstellungen" einrichten.'
    render(<Sidebar projects={projects} active={null} onOpen={vi.fn()} onUpload={vi.fn()}
      onTranscribe={vi.fn()} onCorrect={vi.fn()} onCorrectFile={vi.fn()} aiReason={grund} />)
    expect(screen.getByLabelText('Korrigieren + Sprecher')).toBeDisabled()
    // Der Name traegt den Dateinamen: in einer Liste ist "Nur diese Datei" vorgelesen wertlos.
    expect(screen.getByLabelText('Nur „a" korrigieren')).toBeDisabled()
    expect(screen.getAllByTitle(grund)).toHaveLength(2)           // Grund als Tooltip an beiden
    expect(screen.getByLabelText('Transkribieren')).not.toBeDisabled()  // nur die Korrektur
  })

  it('lässt Korrigieren zu, wenn ein Anbieter eingerichtet ist', () => {
    const onCorrect = vi.fn()
    render(<Sidebar projects={projects} active={null} onOpen={vi.fn()} onUpload={vi.fn()}
      onTranscribe={vi.fn()} onCorrect={onCorrect} onCorrectFile={vi.fn()} aiReason="" />)
    const knopf = screen.getByLabelText('Korrigieren + Sprecher')
    expect(knopf).not.toBeDisabled()
    fireEvent.click(knopf)
    expect(onCorrect).toHaveBeenCalledWith('P')
  })
})
