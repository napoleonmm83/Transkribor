import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProjectWorkspace } from './ProjectWorkspace'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('ProjectWorkspace (Stub)', () => {
  it('listet Dateien des Projekts mit Links', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }], active_job: null },
    ])
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: 'S1' })).toBeInTheDocument()
  })
})
