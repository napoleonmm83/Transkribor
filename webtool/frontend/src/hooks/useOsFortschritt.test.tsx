import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { JobProvider, useActiveJob } from './useActiveJob'
import { ProjektDatenProvider } from './useProjektDaten'
import { useOsFortschritt } from './useOsFortschritt'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

const meldungen: string[] = []
class MeldungAttrappe {
  static permission = 'granted'
  constructor(titel: string) { meldungen.push(titel) }
  static requestPermission = vi.fn().mockResolvedValue('granted')
}

function Probe() {
  useOsFortschritt()
  const { adopt } = useActiveJob()
  ;(globalThis as unknown as { __adopt: typeof adopt }).__adopt = adopt
  return null
}

function zeigen() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <JobProvider intervalMs={10}><ProjektDatenProvider><Probe /></ProjektDatenProvider></JobProvider>
    </MemoryRouter>,
  )
}

describe('useOsFortschritt', () => {
  const fortschritt = vi.fn()
  beforeEach(() => {
    meldungen.length = 0
    vi.resetAllMocks()
    vi.mocked(api.listProjects).mockResolvedValue([])
    ;(globalThis as unknown as { Notification: unknown }).Notification = MeldungAttrappe
    ;(window as unknown as { transkribor: unknown }).transkribor = { fortschritt }
  })
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('meldet einen fertigen Lauf GENAU EINMAL', async () => {
    // onSettled feuert bei JEDEM Poll-Tick, in dem irgendein Job terminal ist -- nicht
    // einmal je Lauf. Ohne Riegel meldet die App im Sekundentakt dasselbe.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [], kind: 'correct' })
    zeigen()
    const adopt = (globalThis as unknown as { __adopt: (i: string, p: string, k: string) => void }).__adopt
    await act(async () => { adopt('j1', 'Alpha', 'correct') })
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    expect(meldungen).toHaveLength(1)
    expect(meldungen[0]).toContain('Alpha')
  })

  it('raeumt den Taskleisten-Balken ab, wenn nichts mehr laeuft', async () => {
    zeigen()
    await act(async () => { await Promise.resolve() })
    // -1 heisst bei Electron "Balken weg". Ohne das bliebe er fuer immer stehen.
    expect(fortschritt).toHaveBeenLastCalledWith(-1)
  })

  it('faellt im Browser ohne Bruecke nicht um', async () => {
    delete (window as unknown as { transkribor?: unknown }).transkribor
    zeigen()
    await act(async () => { await Promise.resolve() })
    expect(true).toBe(true)     // kein Wurf ist die Zusicherung
  })
})
