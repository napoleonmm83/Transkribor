import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileRow } from './FileRow'

const file = { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }

describe('FileRow', () => {
  it('öffnet bei Enter-Taste (a11y)', () => {
    const onOpen = vi.fn()
    render(<FileRow file={file} active={false} onOpen={onOpen} onCorrectFile={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('button', { name: /^a/ }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalled()
  })
})
