import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileStatusPill } from './FileStatusPill'
import type { ProjectFile } from '@/lib/types'

const f = (over: Partial<ProjectFile> = {}): ProjectFile => ({
  base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...over,
})

describe('FileStatusPill', () => {
  it('aktive Phase mit Label', () => {
    render(<FileStatusPill file={f()} active="verify" jobRunning />)
    expect(screen.getByText(/Verifizieren/)).toBeInTheDocument()
  })
  it('Terminal-Status', () => {
    render(<FileStatusPill file={f()} state="done" />)
    expect(screen.getByText(/Fertig/)).toBeInTheDocument()
  })
  it('Wartet, wenn Job laeuft aber Datei noch nicht dran', () => {
    render(<FileStatusPill file={f()} jobRunning />)
    expect(screen.getByText(/Wartet/)).toBeInTheDocument()
  })
  it('statisches Badge ohne Job', () => {
    render(<FileStatusPill file={f({ has_edit: true })} />)
    expect(screen.getByText('✎')).toBeInTheDocument()
  })
})
