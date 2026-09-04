import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { JobProvider } from './useActiveJob'
import { useJob } from './useJob'
import type { StartJob } from '@/lib/types'

vi.mock('@/lib/api')
const toastMock = vi.hoisted(() => Object.assign(vi.fn(),
  { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn(), loading: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }))

/**
 * ZWEI der drei Startwege gehen durch `useJob` (`AppShell`, `DateiMenue`) — hier sitzt der
 * `started: false`-Zweig, und damit die Weiche von #381.
 *
 * Diese Datei gibt es, weil die Verdrahtung ohne sie ABKLEMMBAR war: `verfolge` aus
 * `useJob.ts` zu entfernen liess alle 897 Tests gruen (gegnerischer Pruefer, Befund T1).
 * Dieselbe Lehre wie #488 — eine Regel zu bauen reicht nicht, jedes Glied braucht seinen
 * eigenen Test.
 */
function Probe({ antwort }: { antwort: StartJob }) {
  const { start } = useJob()
  ;(globalThis as unknown as { __start: () => Promise<void> }).__start =
    () => start(async () => antwort, 'Transkribieren')
  return null
}

async function starten(antwort: StartJob) {
  render(<JobProvider intervalMs={5}><Probe antwort={antwort} /></JobProvider>)
  await act(async () => {
    await (globalThis as unknown as { __start: () => Promise<void> }).__start()
  })
}

describe('useJob (#381)', () => {
  it('verfolgt die Vormerkung, wenn der Slot belegt war', async () => {
    // Die Job-Kennung ist hier die des BLOCKERS und damit wertlos — sie kann ueber die
    // Einzel-GPU-Sperre einem fremden Projekt gehoeren. Ohne das Verfolgen erfaehrt die
    // Oberflaeche nie, was aus dem Nachlauf wurde.
    const { getVorgang } = await import('@/lib/api')
    vi.mocked(getVorgang).mockResolvedValue({
      vorgang: 'vg1', status: 'vorgemerkt', job_id: null,
      project: 'Demo', kind: 'transcribe', base: null,
    })
    await starten({ job_id: 'fremder_blocker', started: false, vorgang: 'vg1' })
    // Der Provider fragt die Nummer ab — das tut er nur, wenn `verfolge` gerufen wurde.
    await vi.waitFor(() => expect(vi.mocked(getVorgang)).toHaveBeenCalledWith('vg1'))
    expect(toastMock.info).toHaveBeenCalled()
  })

  it('ohne Nummer bleibt es bei der alten Warnung', async () => {
    // Vier der sechs Startwege gehen ueber `jobs.start` und koennen gar keine Vormerkung
    // erzeugen. Die Gegenrichtung gehoert in den Test: sonst waere „ruft verfolge" auch dann
    // wahr, wenn es bedingungslos passierte.
    const { getVorgang } = await import('@/lib/api')
    vi.mocked(getVorgang).mockClear()
    await starten({ job_id: 'laeuft_schon', started: false })
    expect(toastMock.warning).toHaveBeenCalled()
    expect(vi.mocked(getVorgang)).not.toHaveBeenCalled()
  })
})
