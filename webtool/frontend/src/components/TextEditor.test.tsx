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
})
