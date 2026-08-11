import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TextEditor } from './TextEditor'

describe('TextEditor', () => {
  it('committet den geänderten Text bei Blur', () => {
    const onCommit = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={vi.fn()} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: 'hallo welt' } })
    fireEvent.blur(ta)
    expect(onCommit).toHaveBeenCalledWith('hallo welt')
  })

  it('committet bei ⌘Enter/Ctrl+Enter', () => {
    const onCommit = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={vi.fn()} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: 'hallo welt' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledWith('hallo welt')
  })

  it('bricht bei Escape ab, ohne zu committen', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByDisplayValue('hallo'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('unveraendert wieder verlassen ist ein Abbruch, kein Commit', () => {
    // Der Guard gehoert HIERHIN und nicht zu den Aufrufern: `SegmentView` und `DokumentFeld`
    // haetten ihn sonst je einzeln — und einer haette ihn nicht (genau so war es).
    const onCommit = vi.fn(), onCancel = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.blur(screen.getByDisplayValue('hallo'))
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it('reiner Leerraum ist keine Aenderung', () => {
    // `render_md` strippt ohnehin — im Export waere nichts anders, ein Schreibvorgang aber
    // setzt human_edited=true. Ein ungetrimmter Vergleich liesse genau das durch.
    const onCommit = vi.fn(), onCancel = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={onCancel} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: '  hallo\n' } })
    fireEvent.blur(ta)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it('aber ein leergeraeumtes Feld IST eine Aenderung', () => {
    // Streichen muss moeglich bleiben: ein leerer Kontext ist eine Entscheidung, kein No-op.
    const onCommit = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={vi.fn()} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: '' } })
    fireEvent.blur(ta)
    expect(onCommit).toHaveBeenCalledWith('')
  })
})
