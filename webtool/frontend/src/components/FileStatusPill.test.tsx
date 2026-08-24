import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileStatusPill } from './FileStatusPill'
import type { ProjectFile } from '@/lib/types'

const f = (over: Partial<ProjectFile> = {}): ProjectFile => ({
  base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...over,
})

describe('FileStatusPill', () => {
  it('aktive Phase mit Label', () => {
    render(<FileStatusPill file={f()} active="verify" jobRunning />)
    expect(screen.getByText(/Verifizieren/)).toBeInTheDocument()
  })
  it('Prozent statt Ellipse, wenn der Job welche liefert', () => {
    render(<FileStatusPill file={f()} active="transcribe" pct={45} jobRunning />)
    expect(screen.getByText(/Transkribieren 45%/)).toBeInTheDocument()
  })
  it('Detail schlaegt Prozent (Blockzaehler ist aussagekraeftiger)', () => {
    render(<FileStatusPill file={f()} active="correct" pct={25} detail="Block 2/4" jobRunning />)
    expect(screen.getByText(/Korrigieren Block 2\/4/)).toBeInTheDocument()
  })
  it('Terminal-Status', () => {
    render(<FileStatusPill file={f()} state="done" />)
    expect(screen.getByText(/Fertig/)).toBeInTheDocument()
  })
  it('In Warteschlange, wenn Job laeuft und Datei im Scope ist', () => {
    render(<FileStatusPill file={f()} jobRunning inScope mitText />)
    expect(screen.getByText(/In Warteschlange…/)).toBeInTheDocument()
  })
  it('Glossar-Phase wird bei wartender Datei im Scope angezeigt', () => {
    render(<FileStatusPill file={f()} jobRunning inScope globalPhase="glossary" mitText />)
    expect(screen.getByText(/Glossar wird erstellt…/)).toBeInTheDocument()
  })
  it('Vorbereiten-Phase wird angezeigt', () => {
    render(<FileStatusPill file={f()} jobRunning inScope globalPhase="prep" mitText />)
    expect(screen.getByText(/Vorbereiten…/)).toBeInTheDocument()
  })
  it('Datei ausserhalb des Job-Scopes behaelt ihren Ruhezustand', () => {
    render(<FileStatusPill file={f({ has_edit: true })} jobRunning inScope={false} mitText />)
    expect(screen.getByText('Korrigiert')).toBeInTheDocument()
    expect(screen.queryByText(/Warteschlange/)).toBeNull()
    expect(screen.queryByText(/Wartet/)).toBeNull()
  })
  it('Glossar-Phase wird auch ohne explizites mitText angezeigt', () => {
    render(<FileStatusPill file={f()} jobRunning inScope globalPhase="glossary" />)
    expect(screen.getByText('Glossar wird erstellt…')).toBeInTheDocument()
  })
  // Frueher stand hier ein Emoji ('✎'). Der Test prueft jetzt den zugaenglichen Namen statt
  // des Glyphs — genau das, was das Emoji nicht hatte.
  it('statisches Badge ohne Job traegt einen Namen', () => {
    render(<FileStatusPill file={f({ has_edit: true })} />)
    expect(screen.getByLabelText('Korrigiert')).toBeInTheDocument()
  })
  it('Audio ohne Transkript ist als solches erkennbar', () => {
    render(<FileStatusPill file={f({ has_raw: false })} />)
    expect(screen.getByLabelText(/Nur Audio/)).toBeInTheDocument()
  })
  // Regression: die Kette fiel frueher von has_raw direkt auf has_audio durch und behauptete
  // damit "noch nicht transkribiert" ueber eine fertig transkribierte Datei.
  it('transkribiert, aber unkorrigiert wird NICHT als reines Audio ausgegeben', () => {
    render(<FileStatusPill file={f({ has_raw: true })} />)
    expect(screen.getByLabelText(/Transkribiert/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Nur Audio/)).toBeNull()
  })
})
