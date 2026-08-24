import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileRow } from './FileRow'
import { Huelle } from '@/lib/testHuelle'
import * as api from '@/lib/api'
import type { ProjectFile } from '@/lib/types'

vi.mock('@/lib/api')

const file = { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }

// Die Huelle bringt den echten ProjektDatenProvider mit — der pollt beim Aufsetzen.
beforeEach(() => {
  vi.mocked(api.listProjects).mockResolvedValue([])
  vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'P', files: [] })
})

describe('FileRow', () => {
  it('öffnet bei Enter-Taste (a11y)', () => {
    const onOpen = vi.fn()
    render(<Huelle><FileRow project="P" file={file} active={false} onOpen={onOpen} /></Huelle>)
    fireEvent.keyDown(screen.getByRole('button', { name: /Datei a öffnen/ }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalled()
  })

  it('bubblet Enter vom verschachtelten Aktionsknopf NICHT zur Zeile', () => {
    const onOpen = vi.fn()
    render(<Huelle><FileRow project="P" file={file} active={false} onOpen={onOpen} /></Huelle>)
    fireEvent.keyDown(screen.getByRole('button', { name: /Aktionen für/ }), { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('FileRow Live-Status', () => {
  const live: ProjectFile = { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }
  it('zeigt aktive Phase statt statischem Badge', () => {
    render(<Huelle><FileRow project="P" file={live} active={false} onOpen={vi.fn()} phase="correct" jobRunning /></Huelle>)
    expect(screen.getByText(/Korrigieren/)).toBeInTheDocument()
  })

  it('zeigt Glossar-Status bei wartender Datei im Scope', () => {
    render(<Huelle><FileRow project="P" file={live} active={false} onOpen={vi.fn()} jobRunning inScope globalPhase="glossary" /></Huelle>)
    expect(screen.getByText('Glossar wird erstellt…')).toBeInTheDocument()
  })

  it('zeigt Warteschlange bei wartender Datei im Scope', () => {
    render(<Huelle><FileRow project="P" file={live} active={false} onOpen={vi.fn()} jobRunning inScope /></Huelle>)
    expect(screen.getByText('In Warteschlange…')).toBeInTheDocument()
  })

  it('zeigt Ruhezustand wenn Datei nicht im Scope ist', () => {
    render(<Huelle><FileRow project="P" file={{ ...live, has_edit: true }} active={false} onOpen={vi.fn()} jobRunning inScope={false} /></Huelle>)
    expect(screen.getByLabelText('Fertig')).toBeInTheDocument()
  })
})
