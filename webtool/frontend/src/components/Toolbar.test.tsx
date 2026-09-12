import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toolbar } from './Toolbar'

// Tooltip braucht einen Provider im Test-Kontext (wie in main.tsx); ohne ihn
// wuerden beide Tests schon am Toolbar-Rendern scheitern statt an der Suche.
describe('Toolbar Suche', () => {
  it('rendert das Suchfeld nur, wenn Such-Props übergeben werden', () => {
    const { rerender } = render(<TooltipProvider><Toolbar stand="gespeichert" bereit onExport={vi.fn()} /></TooltipProvider>)
    expect(screen.queryByPlaceholderText('Im Transkript suchen …')).toBeNull()
    rerender(<TooltipProvider><Toolbar stand="gespeichert" bereit onExport={vi.fn()}
      suchQuery="" onSuchChange={vi.fn()} suchCount={0} suchIndex={0} onSuchPrev={vi.fn()} onSuchNext={vi.fn()} /></TooltipProvider>)
    expect(screen.getByPlaceholderText('Im Transkript suchen …')).toBeInTheDocument()
  })

  it('gibt Eingaben weiter und zeigt Zähler', () => {
    const onChange = vi.fn()
    render(<TooltipProvider><Toolbar stand="gespeichert" bereit onExport={vi.fn()}
      suchQuery="aras" onSuchChange={onChange} suchCount={5} suchIndex={2} onSuchPrev={vi.fn()} onSuchNext={vi.fn()} /></TooltipProvider>)
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'Wiesental' } })
    expect(onChange).toHaveBeenCalledWith('Wiesental')
    expect(screen.getByText('3 / 5')).toBeInTheDocument()
  })
})

describe('Toolbar Rueckweg', () => {
  it('fuehrt mit dem Projektnamen auf die Projektseite', () => {
    // Der Editor ist die einzige Seite ohne PageHeader — ohne diesen Link gibt es aus einer
    // geoeffneten Aufnahme keinen Weg zurueck zum Projekt ausser ueber die Startseite.
    render(<MemoryRouter><TooltipProvider>
      <Toolbar projekt="Demo Projekt" stand="ruhig" bereit onExport={vi.fn()} />
    </TooltipProvider></MemoryRouter>)
    // Der Name steht im Linktext UND im aria-label (WCAG 2.5.3): der Name allein sagt nicht,
    // wohin es geht, das Label allein verliert den sichtbaren Text.
    const zurueck = screen.getByRole('link', { name: /Demo Projekt/ })
    // encodeURIComponent MUSS greifen: ein Leerzeichen im Projektnamen ist Alltag hier.
    expect(zurueck).toHaveAttribute('href', '/p/Demo%20Projekt')
  })

  it('ohne Projekt kein Link — der Kopf laeuft auch ausserhalb eines Routers', () => {
    // Bewusst OHNE MemoryRouter: ein unbedingter <Link> wuerde hier werfen. Die Bedingung ist
    // damit keine Kosmetik, sondern das, was diesen Test ueberhaupt rendern laesst.
    render(<TooltipProvider><Toolbar stand="ruhig" bereit onExport={vi.fn()} /></TooltipProvider>)
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('Toolbar Rueckweg — modifizierte Klicks', () => {
  /** Beide Richtungen in EINEM Test: „wurde nicht gefragt" allein waere auch dann wahr, wenn
   *  die Verdrahtung ganz fehlte. Der schlichte Klick darunter ist die Positivkontrolle. */
  it('fragt beim schlichten Linksklick, laesst einen Strg-Klick aber durch', () => {
    // Ein Strg-/Cmd-/Shift-/Mittelklick oeffnet einen neuen Tab — die Seite bleibt stehen, es
    // geht nichts verloren. Ein `preventDefault` machte daraus einen toten Link, samt
    // Rueckfrage fuer eine Bewegung, die gar keine ist (CodeRabbit-Bot, minor, PR #617).
    const erlaubt = vi.fn(() => false)
    render(<MemoryRouter><TooltipProvider>
      <Toolbar projekt="Demo" zurueckErlaubt={erlaubt} stand="fehler" bereit onExport={vi.fn()} />
    </TooltipProvider></MemoryRouter>)
    const link = screen.getByRole('link', { name: /Demo/ })

    fireEvent.click(link)
    expect(erlaubt).toHaveBeenCalledTimes(1)

    fireEvent.click(link, { ctrlKey: true })
    fireEvent.click(link, { metaKey: true })
    fireEvent.click(link, { shiftKey: true })
    fireEvent.click(link, { altKey: true })
    fireEvent.click(link, { button: 1 })
    expect(erlaubt).toHaveBeenCalledTimes(1)
  })
})
