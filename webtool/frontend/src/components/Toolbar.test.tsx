import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
