import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProjectWorkspace } from './ProjectWorkspace'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'
import type { Settings } from '@/lib/types'

vi.mock('@/lib/api')

const einstellungen = (s: Partial<Settings>) =>
  vi.mocked(api.getSettings).mockResolvedValue({ ai_ready: true, ai_reason: '', ...s } as Settings)

describe('ProjectWorkspace (Stub)', () => {
  beforeEach(() => einstellungen({}))          // Korrektur-Gate: eingerichtet, sofern nicht anders gesagt

  const nurDemo = () => vi.mocked(api.listProjects).mockResolvedValue([
    { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }], active_jobs: [] },
  ])

  it('sperrt Korrigieren, solange kein KI-Anbieter eingerichtet ist', async () => {
    // Sonst startet der Job, überspringt jede Datei und endet grün — sieht aus wie Erfolg.
    nurDemo()
    einstellungen({ ai_ready: false, ai_reason: 'Kein API-Key hinterlegt.' })
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Korrigieren' })).toBeDisabled())
    expect(screen.getAllByTitle(/Kein API-Key hinterlegt/)).toHaveLength(2)   // Projekt + Datei
    expect(screen.getByRole('button', { name: 'Transkribieren' })).not.toBeDisabled()
  })

  it('lässt Korrigieren zu, wenn ein Anbieter eingerichtet ist', async () => {
    nurDemo()
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'Korrigieren' })).not.toBeDisabled()
  })

  it('listet Dateien des Projekts mit Links', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }], active_jobs: [] },
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
        active_jobs: [{ id: 'j1', kind: 'correct' }] },
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
    // Job-Leiste (mit Abbrechen) UND Pille an der Datei
    expect(await screen.findByText('Verifizieren S1…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Abbrechen/ })).toBeInTheDocument()
  })

  it('verfolgt Transkription und Korrektur desselben Projekts nebeneinander', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [
        { base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false },
        { base: 'S2', has_audio: true, has_raw: false, has_edit: false, has_md: false }],
        active_jobs: [{ id: 'j1', kind: 'correct' }, { id: 'j2', kind: 'transcribe' }] },
    ])
    vi.mocked(api.getJob).mockImplementation(async (id: string) => id === 'j1'
      ? { status: 'running', lines: ['→ Korrigiere S1 …'] }
      : { status: 'running', lines: ['[Demo] -> transkribiere S2 …', ' 40%|##| 40/100'] })
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider intervalMs={5}>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Korrigieren S1…')).toBeInTheDocument()
    expect(await screen.findByText('Transkribieren S2 · 40%')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Abbrechen/ })).toHaveLength(2)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  })

  it('zeigt NICHT den Status einer gleichnamigen Datei aus einem anderen Projekt', async () => {
    // 'Timeline 1' liegt real in mehreren Projekten — ohne Projekt-Filter wuerde die Pille
    // den Fortschritt des fremden Jobs anzeigen.
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'Timeline 1', has_audio: true, has_raw: true, has_edit: false, has_md: false }],
        active_jobs: [] },
      { name: 'Anderes', files: [{ base: 'Timeline 1', has_audio: true, has_raw: true, has_edit: false, has_md: false }],
        active_jobs: [{ id: 'fremd', kind: 'correct' }] },
    ])
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: ['→ Korrigiere Timeline 1 …'] })
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider intervalMs={5}>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: 'Timeline 1' })).toBeInTheDocument()
    expect(screen.queryByText('Korrigieren Timeline 1…')).not.toBeInTheDocument()   // keine Job-Leiste
    expect(screen.queryByRole('button', { name: /Abbrechen/ })).not.toBeInTheDocument()
  })
})
