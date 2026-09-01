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
  it('Terminal-Status zeigt konsistenten Dateizustand auch bei laufendem Job im Scope', () => {
    render(<FileStatusPill file={f({ has_edit: true })} state="done" jobRunning inScope mitText />)
    expect(screen.getByText('Fertig')).toBeInTheDocument()
    expect(screen.queryByText(/Warteschlange/)).toBeNull()
  })
  it('Terminal-Status done sticht noch vorhandene active-Phase aus', () => {
    render(<FileStatusPill file={f({ has_edit: true })} active="correct" state="done" jobRunning inScope mitText />)
    expect(screen.getByText('Fertig')).toBeInTheDocument()
    expect(screen.queryByText(/Korrigieren/)).toBeNull()
  })
  it('skipped heisst „Handarbeit behalten", nicht „Uebersprungen" (#368)', () => {
    // Das Wort war bis hierher UNBEWACHT: kein Test der Suite nannte es, ein Rueckdrehen
    // waere lautlos durchgegangen (gemessen — die Zeichenkette kam ausserhalb der Komponente
    // in keiner Datei vor). Der Zustand entsteht nur noch aus den zwei Handarbeits-Schutz-
    // pfaden der Korrektur; „Uebersprungen" verschwieg dort den Grund.
    render(<FileStatusPill file={f({ has_edit: true })} state="skipped" jobRunning inScope mitText />)
    expect(screen.getByText('Handarbeit behalten')).toBeInTheDocument()
    expect(screen.queryByText(/Übersprungen/)).toBeNull()
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
    expect(screen.getByText('Fertig')).toBeInTheDocument()
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
    expect(screen.getByLabelText('Fertig')).toBeInTheDocument()
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

  // Der gemeldete Fall: „manchmal, aber nicht immer, wechselt ein fertig korrigiertes File
  // erst auf ‚Audio …' und danach auf ‚Fertig'". Beim Endurteil faellt die Pille auf `ruhe()`
  // durch, und `file` ist dort der aeltere Stand — die Dateiliste wird nicht gepollt, und ein
  // geschriebenes Roh-`.json` aendert die Zaehler der Zusammenfassung nicht, stoesst also auch
  // den Summenpoll-Waechter nicht an. `erreicht` ist die Untergrenze aus dem laufenden Job.
  it('done + Beleg edit: „Fertig", auch wenn die Dateiliste noch nichts weiss', () => {
    render(<FileStatusPill file={f({ has_raw: false, has_edit: false })}
      state="done" erreicht="edit" jobRunning inScope mitText />)
    expect(screen.getByText('Fertig')).toBeInTheDocument()
    expect(screen.queryByText(/Nur Audio/)).toBeNull()
  })

  it('done + Beleg raw: „Transkribiert", nicht „Nur Audio"', () => {
    render(<FileStatusPill file={f({ has_raw: false, has_edit: false })}
      state="done" erreicht="raw" jobRunning inScope mitText />)
    expect(screen.getByText(/Transkribiert — noch nicht korrigiert/)).toBeInTheDocument()
    expect(screen.queryByText(/Nur Audio/)).toBeNull()
  })

  // Negativkontrolle: die Untergrenze wirkt nur nach OBEN. Ein `raw`-Beleg darf eine Datei,
  // die laut Liste schon eine edit.json hat, nicht auf „Transkribiert" zurueckstufen — sonst
  // waere der Fix derselbe Ruecksprung, nur in die andere Richtung.
  it('der Beleg stuft nie ZURUECK', () => {
    render(<FileStatusPill file={f({ has_edit: true })} state="done" erreicht="raw" jobRunning inScope mitText />)
    expect(screen.getByText('Fertig')).toBeInTheDocument()
  })

  // Und ohne Beleg bleibt alles wie vorher — sonst haenge das richtige Etikett am Zufall,
  // dass irgendein Job gerade laeuft.
  it('ohne Beleg entscheidet weiterhin allein die Dateiliste', () => {
    render(<FileStatusPill file={f({ has_raw: false, has_edit: false })}
      state="done" jobRunning inScope mitText />)
    expect(screen.getByText(/Nur Audio/)).toBeInTheDocument()
  })
})
