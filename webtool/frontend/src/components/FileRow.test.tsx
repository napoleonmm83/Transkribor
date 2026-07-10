import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileRow } from './FileRow'
import type { ProjectFile } from '@/lib/types'

const file = { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }

describe('FileRow', () => {
  it('öffnet bei Enter-Taste (a11y)', () => {
    const onOpen = vi.fn()
    render(<FileRow file={file} active={false} onOpen={onOpen} onCorrectFile={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('button', { name: /Datei a öffnen/ }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalled()
  })

  it('bubblet Enter vom verschachtelten ✎-Button NICHT zur Zeile', () => {
    const onOpen = vi.fn()
    render(<FileRow file={file} active={false} onOpen={onOpen} onCorrectFile={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('button', { name: /korrigieren/i }), { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('FileRow Live-Status', () => {
  const live: ProjectFile = { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }
  it('zeigt aktive Phase statt statischem Badge', () => {
    render(<FileRow file={live} active={false} onOpen={vi.fn()} onCorrectFile={vi.fn()} phase="correct" jobRunning />)
    expect(screen.getByText(/Korrigieren/)).toBeInTheDocument()
  })
})
