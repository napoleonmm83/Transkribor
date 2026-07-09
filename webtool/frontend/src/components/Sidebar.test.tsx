import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'

const projects = [{ name: 'P', files: [{ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }] }]

describe('Sidebar', () => {
  it('öffnet Datei bei Klick', () => {
    const onOpen = vi.fn()
    render(<Sidebar projects={projects} active={null} onOpen={onOpen} onUpload={vi.fn()}
      onTranscribe={vi.fn()} onCorrect={vi.fn()} onCorrectFile={vi.fn()} />)
    fireEvent.click(screen.getByText(/^a/))
    expect(onOpen).toHaveBeenCalledWith({ project: 'P', base: 'a' })
  })

  it('zeigt "Keine Projekte" nicht während des ersten Ladens', () => {
    render(<Sidebar projects={[]} loading active={null} onOpen={vi.fn()} onUpload={vi.fn()}
      onTranscribe={vi.fn()} onCorrect={vi.fn()} onCorrectFile={vi.fn()} />)
    expect(screen.queryByText(/Keine Projekte/)).not.toBeInTheDocument()
  })
})
