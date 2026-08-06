import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { JobProvider, useActiveJob } from './useActiveJob'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

function Probe() {
  const { job, phases, adopt } = useActiveJob()
  return (
    <div>
      <button onClick={() => adopt('j1', 'Demo', 'correct')}>go</button>
      <span data-testid="active">
        {Object.entries(phases.active).map(([b, a]) => `${b}:${a.phase}`).join(',') || '-'}
      </span>
      <span data-testid="status">{job?.status ?? 'none'}</span>
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
})
