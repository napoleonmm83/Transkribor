import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HomeGallery } from './HomeGallery'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

const renderHome = () =>
  render(<MemoryRouter><HomeGallery /></MemoryRouter>)

describe('HomeGallery', () => {
  it('zeigt Karten mit Dateizahl', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: true, has_md: true }], active_job: null },
    ])
    renderHome()
    expect(await screen.findByText('Demo')).toBeInTheDocument()
    expect(screen.getByText(/1 Datei/)).toBeInTheDocument()
  })

  it('legt ein Projekt an und navigiert (createProject aufgerufen)', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.createProject).mockResolvedValue({ ok: true, name: 'Neu' })
    renderHome()
    fireEvent.click(await screen.findByText('+ Projekt'))
    fireEvent.change(screen.getByLabelText('Projektname'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText('Anlegen'))
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('Neu'))
  })
})
