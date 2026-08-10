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
      { name: 'Demo', dateien: 1, fertig: 1, geaendert: 0, active_jobs: [] },
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

  it('Suche filtert sofort, ohne Enter', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alpha', dateien: 1, fertig: 1, geaendert: 100, active_jobs: [] },
      { name: 'Beta', dateien: 1, fertig: 1, geaendert: 200, active_jobs: [] },
    ])
    renderHome()
    await screen.findByText('Alpha')
    fireEvent.change(screen.getByLabelText(/suche/i), { target: { value: 'Beta' } })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('leere Trefferliste nennt den Suchbegriff und bietet einen Weg zurueck', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alpha', dateien: 1, fertig: 1, geaendert: 100, active_jobs: [] },
    ])
    renderHome()
    await screen.findByText('Alpha')
    fireEvent.change(screen.getByLabelText(/suche/i), { target: { value: 'Zzz' } })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText(/Kein Projekt passt zu.*Zzz/)).toBeInTheDocument()
    expect(screen.getByText('Suche leeren')).toBeInTheDocument()
  })

  it('laufende Projekte stehen oben und nicht zusaetzlich in der Zeilenliste', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Ruhig', dateien: 2, fertig: 2, geaendert: 100, active_jobs: [] },
      { name: 'Laeuft', dateien: 3, fertig: 1, geaendert: 50, active_jobs: [{ id: '1', kind: 'correct' }] },
    ])
    renderHome()
    await screen.findByText('Laeuft')
    expect(screen.getAllByText('Laeuft')).toHaveLength(1)
  })

  it('Standardsortierung ist zuletzt geaendert', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alt', dateien: 1, fertig: 1, geaendert: 100, active_jobs: [] },
      { name: 'Neu', dateien: 1, fertig: 1, geaendert: 300, active_jobs: [] },
      { name: 'Mittel', dateien: 1, fertig: 1, geaendert: 200, active_jobs: [] },
    ])
    const { container } = renderHome()
    await screen.findByText('Neu')
    const text = container.textContent!
    expect(text.indexOf('Neu')).toBeLessThan(text.indexOf('Mittel'))
    expect(text.indexOf('Mittel')).toBeLessThan(text.indexOf('Alt'))
  })

  it('Suchfeld hat ein zugaengliches Label', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alpha', dateien: 1, fertig: 1, geaendert: 100, active_jobs: [] },
    ])
    renderHome()
    await screen.findByText('Alpha')
    expect(screen.getByLabelText(/suche/i)).toBeInTheDocument()
  })
})
