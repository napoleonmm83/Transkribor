import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SegmentView } from './SegmentView'

// `toast` ist zugleich Funktion (Streich-Hinweis aus `lib/streichen`) und Namensraum
// (`toast.info` fuer verworfenen Eingabetext) — die Attrappe muss beides koennen.
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { info: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const rueckgaengig = () =>
  toastMock.mock.calls.at(-1)?.[1]?.action as { label: string; onClick: () => void } | undefined
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Segment } from '@/lib/types'

const mkSeg = (overrides: Partial<Segment>): Segment => ({
  id: 1, start: 0, end: 2, speaker: 'Interviewer',
  raw_text: 'w0 w1 w2', text: 'w0 w1 w2',
  words: [
    { word: 'w0', start: 0, end: 1, probability: 1 },
    { word: 'w1', start: 1, end: 1.5, probability: 0.2 },
    { word: 'w2', start: 1.5, end: 2, probability: 1 },
  ],
  flags: { hallucination: false, low_conf: false }, note: '',
  ...overrides,
})


describe('SegmentView', () => {
  it('rendert ein korrigiertes Segment als reinen Text ohne Unsicherheits-Markup', () => {
    const seg = mkSeg({ text: 'korrigierter Text' }) // != raw_text -> isCorrected
    render(<TooltipProvider><SegmentView seg={seg} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(screen.getByText('korrigierter Text')).toBeInTheDocument()
    expect(document.querySelector('.u-red')).toBeNull()
    expect(document.querySelector('.u-yellow')).toBeNull()
  })

  it('zeigt bei korrigierten Segmenten den 🔍-Reveal-Toggle, der die Roh-Wörter einblendet', () => {
    const seg = mkSeg({ text: 'korrigierter Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(screen.queryByText('w1')).toBeNull()
    fireEvent.click(screen.getByTitle('Roh-Wörter anzeigen'))
    expect(screen.getByText('w1')).toHaveClass('u-red')
  })

  it('zeigt bei unkorrigierten Segmenten keinen Reveal-Toggle', () => {
    const seg = mkSeg({}) // text === raw_text -> nicht korrigiert
    render(<TooltipProvider><SegmentView seg={seg} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(screen.queryByTitle('Roh-Wörter anzeigen')).toBeNull()
  })
  it('unveraendert wieder zugeklickt schreibt gar nichts', () => {
    // Der haeufigere Weg als die Kopffelder: bei 400 Segmenten passiert der Fehlklick staendig.
    // Ein Schreibvorgang setzt serverseitig human_edited=true, und `correct.py` nimmt die Datei
    // damit aus der AUTOMATISCHEN Korrektur (zurueck nur ueber „Neu korrigieren“ mit Rueckfrage).
    const updateSegment = vi.fn()
    const seg = mkSeg({ text: 'korrigierter Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} onPlay={vi.fn()} updateSegment={updateSegment} /></TooltipProvider>)
    fireEvent.click(screen.getByText('korrigierter Text'))
    fireEvent.blur(screen.getByRole('textbox'))
    expect(updateSegment).not.toHaveBeenCalled()
  })

  it('nur Leerraum dazu ist keine Aenderung', () => {
    // Der Vergleich muss trimmen: `"text " !== "text"` waere sonst ein Schreibvorgang, der im
    // Export (render_md strippt) nichts aendert — aber human_edited=true setzt.
    const updateSegment = vi.fn()
    const seg = mkSeg({ text: 'korrigierter Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} onPlay={vi.fn()} updateSegment={updateSegment} /></TooltipProvider>)
    fireEvent.click(screen.getByText('korrigierter Text'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'korrigierter Text  ' } })
    fireEvent.blur(feld)
    expect(updateSegment).not.toHaveBeenCalled()
  })

  it('graut das Segment aus, wenn dimmen gesetzt ist', () => {
    const seg = mkSeg({ text: 'Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} dimmen onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('opacity-40')
  })

  it('setzt einen gelben Rahmen am aktiven Treffer', () => {
    const seg = mkSeg({ text: 'Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} aktiverTreffer onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('ring-yellow-400')
  })

  // Issue #112: `segments[].note` ging seit je in den Export, hatte aber keinen Eingang —
  // die Korrektur schreibt nur die Dokument-Anmerkungen, das Feld war leer und unsichtbar.
  it('legt ueber das Notiz-Symbol eine Notiz am Segment an', () => {
    const updateSegment = vi.fn()
    render(<TooltipProvider><SegmentView seg={mkSeg({})} active={false} onPlay={vi.fn()} updateSegment={updateSegment} /></TooltipProvider>)
    fireEvent.click(screen.getByTitle('Notiz hinzufügen'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'Hier nachfragen.' } })
    fireEvent.blur(feld)
    expect(updateSegment).toHaveBeenCalledWith(1, { note: 'Hier nachfragen.' })
  })

  it('zeigt eine vorhandene Notiz an; das Anlege-Symbol tritt dann ab', () => {
    render(<TooltipProvider><SegmentView seg={mkSeg({ note: 'Name unsicher.' })} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(screen.getByText('Name unsicher.')).toBeInTheDocument()
    expect(screen.queryByTitle('Notiz hinzufügen')).toBeNull()
  })

  it('leeren streicht die Notiz — auch, wenn nur Leerraum stehen bleibt', () => {
    // Nur-Leerraum ungefiltert durchzulassen waere die schlimmere Haelfte: "   " ist truthy,
    // also faellt das Anlege-Symbol weg UND die Notizzeile zeigt nichts — eine unsichtbare
    // Notiz, die `render_md` ohnehin wegstrippt. (CodeRabbit an PR #153.)
    for (const eingabe of ['', '   ']) {
      const updateSegment = vi.fn()
      const { unmount } = render(<TooltipProvider><SegmentView seg={mkSeg({ note: 'erledigt' })} active={false} onPlay={vi.fn()} updateSegment={updateSegment} /></TooltipProvider>)
      fireEvent.click(screen.getByText('erledigt'))
      const feld = screen.getByRole('textbox')
      fireEvent.change(feld, { target: { value: eingabe } })
      fireEvent.blur(feld)
      expect(updateSegment).toHaveBeenCalledWith(1, { note: '' })
      unmount()
    }
  })

  // Issue #154: dieselbe Luecke wie bei den Anmerkungen — die Notiz hat keine Zweitschrift.
  it('bietet nach dem Streichen der Notiz einen Rueckweg an', () => {
    toastMock.mockClear()
    const updateSegment = vi.fn()
    const { rerender } = render(<TooltipProvider><SegmentView seg={mkSeg({ note: 'Name unsicher.' })} active={false} onPlay={vi.fn()} updateSegment={updateSegment} /></TooltipProvider>)
    fireEvent.click(screen.getByText('Name unsicher.'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: '  ' } })
    fireEvent.blur(feld)
    expect(updateSegment).toHaveBeenCalledWith(1, { note: '' })

    // Den Re-Render liefert in der App `updateSegment` -> `setDoc`; hier von Hand.
    rerender(<TooltipProvider><SegmentView seg={mkSeg({ note: '' })} active={false} onPlay={vi.fn()} updateSegment={updateSegment} /></TooltipProvider>)
    const aktion = rueckgaengig()
    expect(aktion?.label).toBe('Rückgängig')
    aktion!.onClick()
    // Nur dieses eine Feld — der Rueckweg geht ueber denselben `updateSegment` wie die Streichung.
    expect(updateSegment).toHaveBeenLastCalledWith(1, { note: 'Name unsicher.' })
  })

  it('der Rueckweg ueberschreibt eine inzwischen NEU geschriebene Notiz nicht', () => {
    // CodeRabbit: der Rueckruf lebt zehn Sekunden. Das Segment hat genau EIN Notizfeld — anders
    // als bei den Anmerkungen laesst sich nichts nebeneinanderlegen. Also gilt der Rueckweg nur,
    // solange das Feld noch so dasteht, wie die Streichung es hinterlassen hat; sonst waere er
    // ein Ueberschreiben, und der Rettungsknopf zerstoerte, was er retten soll.
    toastMock.mockClear()
    const updateSegment = vi.fn()
    const { rerender } = render(<TooltipProvider><SegmentView seg={mkSeg({ note: 'alt' })} active={false} onPlay={vi.fn()} updateSegment={updateSegment} /></TooltipProvider>)
    fireEvent.click(screen.getByText('alt'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: '' } })
    fireEvent.blur(feld)
    expect(updateSegment).toHaveBeenCalledWith(1, { note: '' })
    updateSegment.mockClear()

    rerender(<TooltipProvider><SegmentView seg={mkSeg({ note: 'inzwischen neu' })} active={false} onPlay={vi.fn()} updateSegment={updateSegment} /></TooltipProvider>)
    rueckgaengig()!.onClick()

    expect(updateSegment).not.toHaveBeenCalled()
    expect(toastMock.info).toHaveBeenCalledWith(expect.stringContaining('neue Notiz'))
  })

  it('meldet beim blossen Aendern der Notiz keinen Streich-Toast', () => {
    // Gegenprobe: ein Rueckweg, der IMMER angeboten wird, ist derselbe Schaden von der anderen
    // Seite — Dauerlaerm, bis niemand mehr hinsieht. NICHT herstellbar waere die Variante
    // „leeres Commit auf leerer Notiz“ (`TextEditor` bricht unveraendert-nach-trim ab, es kommt
    // dort nie eines an); das blosse AENDERN ist es sehr wohl, und es haelt denselben Riegel.
    toastMock.mockClear()
    render(<TooltipProvider><SegmentView seg={mkSeg({ note: 'Name unsicher.' })} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    fireEvent.click(screen.getByText('Name unsicher.'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'Name geklaert.' } })
    fireEvent.blur(feld)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('ohne Such-Props weder Ausgrauen noch gelber Ring (Default)', () => {
    const seg = mkSeg({ text: 'Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    const root = document.querySelector('[data-seg-id="1"]')!
    expect(root).not.toHaveClass('opacity-40')
    expect(root).not.toHaveClass('ring-yellow-400')
  })
})
