import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { JobProvider, mergePhases, useActiveJob, type Job } from './useActiveJob'
import type { JobPhases } from '@/lib/types'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

function Probe() {
  const { jobs, adopt } = useActiveJob()
  const phases = mergePhases(jobs.filter(j => j.status === 'running'))
  return (
    <div>
      <button onClick={() => adopt('j1', 'Demo', 'correct')}>go</button>
      <button onClick={() => adopt('j2', 'Demo', 'transcribe')}>go2</button>
      <span data-testid="active">
        {Object.entries(phases.active).map(([b, a]) => `${b}:${a.phase}`).sort().join(',') || '-'}
      </span>
      <span data-testid="status">{jobs.map(j => j.status).join(',') || 'none'}</span>
    </div>
  )
}

describe('useActiveJob', () => {
  it('adoptiert, pollt und parst bis Terminal', async () => {
    vi.mocked(api.getJob)
      .mockResolvedValueOnce({ status: 'running', lines: ['→ Korrigiere A …'] })
      .mockResolvedValueOnce({ status: 'done', lines: ['apply: A -> edit.json + md (2 Segmente)'] })
    render(<JobProvider intervalMs={5}><Probe /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('A:correct'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'))
  })

  it('uebersteht einen transienten getJob-Fehler und laeuft weiter', async () => {
    vi.mocked(api.getJob)
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce({ status: 'running', lines: ['→ Korrigiere A …'] })
      .mockResolvedValueOnce({ status: 'done', lines: ['apply: A -> edit.json + md (2 Segmente)'] })
    render(<JobProvider intervalMs={5}><Probe /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'))
  })

  it('verfolgt Transkription und Korrektur gleichzeitig und mergt ihre Phasen', async () => {
    vi.mocked(api.getJob).mockImplementation(async (id: string) =>
      id === 'j1'
        ? { status: 'running', lines: ['→ Korrigiere A …'] }
        : { status: 'running', lines: ['[Demo] -> transkribiere B …'] })
    render(<JobProvider intervalMs={5}><Probe /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    fireEvent.click(screen.getByText('go2'))
    await waitFor(() =>
      expect(screen.getByTestId('active').textContent).toBe('A:correct,B:transcribe'))
  })
})

describe('mergePhases', () => {
  const job = (id: string, kind: string, phases: JobPhases): Job =>
    ({ id, kind, project: 'P', status: 'running', phases })

  it('ein laufender Job verdraengt den Terminal-Status desselben Files aus einem anderen Job', () => {
    // Sonst maskiert das 'done' der Transkription die laufende Korrektur — FileStatusPill
    // prueft state VOR active und wuerde 'Fertig' zeigen, waehrend gerade korrigiert wird.
    const m = mergePhases([
      job('j1', 'transcribe', { global: null, active: {}, perBase: { A: 'done', B: 'done' } }),
      job('j2', 'correct', { global: null, active: { A: { phase: 'correct' } }, perBase: {} }),
    ])
    expect(m.active).toEqual({ A: { phase: 'correct' } })
    expect(m.perBase).toEqual({ B: 'done' })
    expect(m.global).toBeNull()
  })

  it('bei gleicher Datei in zwei Jobs gewinnt transcribe — unabhaengig von der Reihenfolge', () => {
    // Das Transkript wird gerade ersetzt, die Korrektur arbeitet auf gleich veralteten Daten.
    const t = job('j1', 'transcribe', { global: null, active: { A: { phase: 'transcribe', pct: 20 } }, perBase: {} })
    const c = job('j2', 'correct', { global: null, active: { A: { phase: 'correct' } }, perBase: {} })
    expect(mergePhases([t, c]).active.A).toEqual({ phase: 'transcribe', pct: 20 })
    expect(mergePhases([c, t]).active.A).toEqual({ phase: 'transcribe', pct: 20 })
  })

  it('global gilt nur, solange keine Datei laeuft', () => {
    expect(mergePhases([job('j1', 'correct', { global: 'glossary', active: {}, perBase: {} })]).global)
      .toBe('glossary')
  })
})
