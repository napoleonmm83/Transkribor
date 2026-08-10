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

  it('meldet einen beendeten Lauf genau einmal, auch wenn ein zweiter weiterlaeuft', async () => {
    // A wird terminal, B laeuft weiter -- onSettled feuert bei JEDEM weiteren Tick erneut,
    // solange B noch laeuft. A darf dabei trotzdem nur EINMAL gemeldet werden: useActiveJob.tsx
    // gibt bei jedem Tick nur die JUST beendeten Jobs weiter (beendet-Kommentar dort), A faellt
    // nach seinem eigenen Tick aus `ids` und kann in einem spaeteren `neu` nicht mehr auftauchen.
    let bTicks = 0
    vi.mocked(api.getJob).mockImplementation(async (id: string) =>
      id === 'j1'
        ? { status: 'done', lines: [], kind: 'correct' }
        : { status: (bTicks += 1) < 4 ? 'running' : 'done', lines: [], kind: 'transcribe' })
    zeigen()
    const adopt = (globalThis as unknown as { __adopt: (i: string, p: string, k: string) => void }).__adopt
    await act(async () => { adopt('j1', 'Alpha', 'correct'); adopt('j2', 'Beta', 'transcribe') })
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })
    expect(meldungen).toHaveLength(2)               // A einmal, B einmal -- nie doppelt
    expect(meldungen.filter(m => m.includes('Alpha'))).toHaveLength(1)
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
