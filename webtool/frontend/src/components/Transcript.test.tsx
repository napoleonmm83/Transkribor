import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Transcript } from './Transcript'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { EditDoc, Word } from '@/lib/types'

const mkWords = (probs: number[]): Word[] =>
  probs.map((p, i) => ({ word: `w${i}`, start: i, end: i + 1, probability: p }))

const doc: EditDoc = {
  base: 'b', project: 'P', audio: 'a.wav', language: 'de',
  human_edited: false, context: '', speakers: ['Interviewer', 'Befragte Person'],
  segments: [
    { id: 1, start: 0, end: 2, speaker: 'Interviewer', raw_text: 'w0 w1 w2', text: 'w0 w1 w2',
      words: mkWords([1, 0.2, 1]), flags: { hallucination: false, low_conf: false }, note: '' },
    { id: 2, start: 2, end: 4, speaker: 'Befragte Person', raw_text: 'hallo', text: 'hallo',
      words: mkWords([1]), flags: { hallucination: false, low_conf: false }, note: '' },
  ],
  annotations: [],
}

describe('Transcript', () => {
  it('rendert Sprecher-Labels und markiert unkorrigierte unsichere Wörter', () => {
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()} /></TooltipProvider>)
    // Sprecher-Name erscheint sowohl im Block-Kopf als auch in der Per-Segment-Combobox.
    expect(screen.getAllByText(/Interviewer/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Befragte Person/).length).toBeGreaterThan(0)
    expect(screen.getByText('w1')).toHaveClass('u-red')
  })

  it('sagt an, wenn die gespeicherte Fassung nicht lesbar war — und schweigt sonst', () => {
    // #197: die Selbstheilung ist richtig (sonst waere die Aufnahme nicht mehr zu oeffnen),
    // aber ohne Hinweis haelt der Nutzer das Rohtranskript fuer seine korrigierte Fassung.
    // Die Gegenprobe gehoert dazu: ein Kasten, der immer steht, waere derselbe Schaden.
    const zeige = (d: EditDoc) => render(<TooltipProvider><Transcript doc={d} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()} /></TooltipProvider>)
    const { unmount } = zeige(doc)
    expect(screen.queryByText(/nicht lesbar/)).toBeNull()
    unmount()
    zeige({ ...doc, selbstgeheilt: 'UnicodeDecodeError' })
    expect(screen.getByText(/Deine gespeicherte Fassung war nicht lesbar/)).toBeInTheDocument()
    expect(screen.getByText('b.edit.json.kaputt')).toBeInTheDocument()   // wo sie liegt
  })

  it('meldet Abschnitte ohne Transkript — und schweigt, wenn es keine gibt', () => {
    // #83: ein uebersprungenes Whisper-Fenster hinterlaesst KEIN schlechtes Segment, sondern
    // gar keines. Im belegten Fall (#82) stand der Verlust wochenlang in 17 von 37 Aufnahmen,
    // weil ihn nichts anzeigte. Die Gegenprobe zaehlt genauso: ein Kasten, der immer steht,
    // wird weggesehen — und eine leere Liste ist der Normalfall.
    const zeige = (d: EditDoc) => render(<TooltipProvider><Transcript doc={d} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()} /></TooltipProvider>)
    const leer = zeige({ ...doc, luecken: [] })
    expect(screen.queryByText(/ohne Transkript/)).toBeNull()
    leer.unmount()
    // Und ohne den Schluessel ueberhaupt (edit.json von vor diesem Feature).
    const alt = zeige(doc)
    expect(screen.queryByText(/ohne Transkript/)).toBeNull()
    alt.unmount()
    zeige({ ...doc, luecken: [{ start: 252, end: 270, dauer: 18 }, { start: 717, end: 751, dauer: 34 }] })
    expect(screen.getByText(/2 Abschnitte ohne Transkript/)).toBeInTheDocument()
    // Die Zeitmarken sind der ganze Zweck: ohne sie weiss niemand, WO er gegenhoeren soll.
    expect(screen.getByText('4:12–4:30')).toBeInTheDocument()
    expect(screen.getByText('11:57–12:31')).toBeInTheDocument()
  })

  it('zaehlt eine einzelne Luecke im Singular', () => {
    // „1 Abschnitte" liest sich wie ein Fehler des Programms — und ein Hinweis, dem man die
    // Sorgfalt nicht abnimmt, wird als Rauschen behandelt. Genau das darf er nicht werden.
    render(<TooltipProvider><Transcript doc={{ ...doc, luecken: [{ start: 0, end: 20, dauer: 20 }] }}
      activeId={null} onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()}
      renameSpeaker={vi.fn()} updateDoc={vi.fn()} /></TooltipProvider>)
    expect(screen.getByText(/Ein Abschnitt ohne Transkript/)).toBeInTheDocument()
  })

  it('Name im Block-Kopf benennt global um, nicht nur das Segment', () => {
    const renameSpeaker = vi.fn(), updateSegment = vi.fn()
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={updateSegment} renameSpeaker={renameSpeaker}
      updateDoc={vi.fn()} /></TooltipProvider>)
    fireEvent.click(screen.getAllByTitle('Sprecher im ganzen Transkript umbenennen')[0])
    const input = screen.getByPlaceholderText('Sprecher…')
    fireEvent.change(input, { target: { value: 'Beni Dürr' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSpeaker).toHaveBeenCalledWith('Interviewer', 'Beni Dürr')
    expect(updateSegment).not.toHaveBeenCalled()
  })

  it('zeigt die Zusammenfassung vor dem Gespräch', () => {
    render(<TooltipProvider><Transcript doc={{ ...doc, summary: 'Es geht um Brot.' }}
      activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()} /></TooltipProvider>)
    const zus = screen.getByText('Es geht um Brot.')
    expect(zus).toBeInTheDocument()
    // Vor dem ersten Segment: die Frage "worum geht es hier" stellt man beim Oeffnen.
    // Anker ist das Segment selbst, nicht sein Text — der wird wortweise gerendert
    // (Konfidenz-Faerbung), ein zusammenhaengender Textknoten existiert nicht.
    const erstesSegment = document.querySelector('[data-seg-id="1"]')!
    // compareDocumentPosition liefert eine Bitmaske — maskieren, nicht gleichsetzen.
    expect(zus.compareDocumentPosition(erstesSegment)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('zeigt beide Rubriken auch leer — sonst gibt es keinen Weg, sie zu fuellen', () => {
    // Frisch transkribiert und noch nicht korrigiert sind beide Felder leer. Blieben sie
    // dann unsichtbar, koennte man einem Dokument nie einen Kontext geben.
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()} /></TooltipProvider>)
    expect(screen.getByText('Kontext')).toBeInTheDocument()
    expect(screen.getByText('Zusammenfassung')).toBeInTheDocument()
    expect(screen.getByText('Kontext hinzufügen …')).toBeInTheDocument()
  })

  it('Klick auf den Kontext oeffnet ein Feld, das ins Dokument zurueckschreibt', () => {
    const updateDoc = vi.fn()
    render(<TooltipProvider><Transcript doc={{ ...doc, context: 'Interview am Deuce Day.' }}
      activeId={null} onPlaySeg={vi.fn()} onPlayTurn={vi.fn()}
      updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={updateDoc} /></TooltipProvider>)
    fireEvent.click(screen.getByText('Interview am Deuce Day.'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'Interview am Deuce Day mit Fuhat Aras.' } })
    fireEvent.keyDown(feld, { key: 'Enter', ctrlKey: true })
    expect(updateDoc).toHaveBeenCalledWith({ context: 'Interview am Deuce Day mit Fuhat Aras.' })
  })

  it('ein leeres Feld laesst sich ueber den Platzhalter anlegen', () => {
    const updateDoc = vi.fn()
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()}
      updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={updateDoc} /></TooltipProvider>)
    fireEvent.click(screen.getByText('Zusammenfassung hinzufügen …'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'Es geht um Brot.' } })
    fireEvent.blur(feld)
    expect(updateDoc).toHaveBeenCalledWith({ summary: 'Es geht um Brot.' })
  })

  it('unveraendert wieder zugeklickt schreibt gar nichts', () => {
    // Sonst macht ein Fehlklick das Dokument schmutzig, der Autosave laeuft, und der Server
    // setzt human_edited=true — womit `correct.py` die Datei aus der AUTOMATISCHEN Korrektur
    // nimmt; zurueck nur ueber „Neu korrigieren“ (force) mit Rueckfrage. Der Guard selbst
    // sitzt in `TextEditor`, hier wird nur die Verdrahtung geprueft.
    const updateDoc = vi.fn()
    render(<TooltipProvider><Transcript doc={{ ...doc, context: 'Interview am Deuce Day.' }}
      activeId={null} onPlaySeg={vi.fn()} onPlayTurn={vi.fn()}
      updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={updateDoc} /></TooltipProvider>)
    fireEvent.click(screen.getByText('Interview am Deuce Day.'))
    fireEvent.blur(screen.getByRole('textbox'))
    expect(updateDoc).not.toHaveBeenCalled()
  })

  it('Escape verwirft, statt zu schreiben', () => {
    const updateDoc = vi.fn()
    render(<TooltipProvider><Transcript doc={{ ...doc, summary: 'Es geht um Brot.' }}
      activeId={null} onPlaySeg={vi.fn()} onPlayTurn={vi.fn()}
      updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={updateDoc} /></TooltipProvider>)
    fireEvent.click(screen.getByText('Es geht um Brot.'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'Unsinn' } })
    fireEvent.keyDown(feld, { key: 'Escape' })
    expect(updateDoc).not.toHaveBeenCalled()
    expect(screen.getByText('Es geht um Brot.')).toBeInTheDocument()
  })

  it('zeigt den Kontext — er steht im Export, also muss er auch im Editor stehen', () => {
    // Solange er nur im Markdown auftauchte, konnte ein alter Sprechername unbemerkt
    // mit hinausgehen: im Editor war das Feld unsichtbar.
    render(<TooltipProvider><Transcript doc={{ ...doc, context: 'Interview am Deuce Day.' }}
      activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()} /></TooltipProvider>)
    expect(screen.getByText('Interview am Deuce Day.')).toBeInTheDocument()
  })

  it('zeigt "Keine Datei geöffnet" nicht während des Ladens', () => {
    render(<Transcript doc={null} loading activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()} />)
    expect(screen.queryByText(/Keine Datei geöffnet/)).not.toBeInTheDocument()
  })

  it('Suche: graut Nicht-Treffer aus, aktiver Treffer mit Ring — wird durchgereicht', () => {
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()}
      sucheAktiv trefferIds={new Set([2])} suchAktivId={2} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="2"]')).toHaveClass('ring-yellow-400')
  })
})
