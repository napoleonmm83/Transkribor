import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SegmentEditor } from './SegmentEditor'

describe('SegmentEditor', () => {
  it('committet den geänderten Text bei Blur', () => {
    const onCommit = vi.fn()
    render(<SegmentEditor initial="hallo" onCommit={onCommit} onCancel={vi.fn()} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: 'hallo welt' } })
    fireEvent.blur(ta)
    expect(onCommit).toHaveBeenCalledWith('hallo welt')
  })
})
