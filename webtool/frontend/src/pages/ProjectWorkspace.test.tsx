import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProjectWorkspace } from './ProjectWorkspace'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('ProjectWorkspace (Stub)', () => {
  it('listet Dateien des Projekts mit Links', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }], active_job: null },
    ])
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'S1' })).toBeInTheDocument()
  })

  it('zeigt Live-Phase, wenn ein Job fuer das Projekt laeuft', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }],
        active_job: { id: 'j1', kind: 'correct' } },
    ])
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: ['→ Verifiziere S1 (Treue gegen Roh) …'] })
    const { JobProvider } = await import('@/hooks/useActiveJob')
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider intervalMs={5}>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/Verifizieren/)).toBeInTheDocument()
  })
})
