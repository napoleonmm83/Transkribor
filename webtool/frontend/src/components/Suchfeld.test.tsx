import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Suchfeld } from './Suchfeld'

describe('Suchfeld', () => {
  it('gibt Eingaben ans onChange weiter', () => {
    const onChange = vi.fn()
    render(<Suchfeld value="" onChange={onChange} count={0} index={0} onPrev={vi.fn()} onNext={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'Aras' } })
    expect(onChange).toHaveBeenCalledWith('Aras')
  })

  it('zeigt Zähler und Navigationsknöpfe nur bei aktivem Query', () => {
    const { rerender } = render(<Suchfeld value="" onChange={vi.fn()} count={0} index={0} onPrev={vi.fn()} onNext={vi.fn()} />)
    expect(screen.queryByText(/keine Treffer|\d+ \/ \d+/)).toBeNull()
    expect(screen.queryByLabelText('Nächster Treffer')).toBeNull()
    rerender(<Suchfeld value="aras" onChange={vi.fn()} count={5} index={2} onPrev={vi.fn()} onNext={vi.fn()} />)
    expect(screen.getByText('3 / 5')).toBeInTheDocument()
    expect(screen.getByLabelText('Nächster Treffer')).toBeInTheDocument()
  })

  it('zeigt "keine Treffer" und deaktiviert ▲▽ bei count 0', () => {
    render(<Suchfeld value="xyz" onChange={vi.fn()} count={0} index={0} onPrev={vi.fn()} onNext={vi.fn()} />)
    expect(screen.getByText('keine Treffer')).toBeInTheDocument()
    expect(screen.getByLabelText('Nächster Treffer')).toBeDisabled()
    expect(screen.getByLabelText('Voriger Treffer')).toBeDisabled()
  })

  it('▲ ruft onNext, ▽ ruft onPrev, ✕ leert', () => {
    const onPrev = vi.fn(), onNext = vi.fn(), onChange = vi.fn()
    render(<Suchfeld value="a" onChange={onChange} count={3} index={0} onPrev={onPrev} onNext={onNext} />)
    fireEvent.click(screen.getByLabelText('Nächster Treffer'))
    expect(onNext).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Voriger Treffer'))
    expect(onPrev).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Suche leeren'))
    expect(onChange).toHaveBeenCalledWith('')
  })
})
