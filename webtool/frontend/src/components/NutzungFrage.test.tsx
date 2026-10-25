import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { NutzungFrage } from './NutzungFrage'
import { _zuruecksetzen, type NutzungZustand } from '@/hooks/useNutzung'
import { _zuruecksetzen as fbZuruecksetzen } from '@/hooks/useFehlerberichte'

const toastMock = vi.hoisted(() => Object.assign(vi.fn(),
  { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const FRAGE = 'Darf Transkribor mitzählen, dass es benutzt wird?'
const LAST = { geraet: 'a'.repeat(64), version: '0.61.0', plattform: 'win32-x64' }
const NIE: NutzungZustand = { an: false, gefragt: null, zuletzt: null, nutzlast: LAST }

function bruecke(nu: NutzungZustand, fbGefragt: string | null | 'ohne') {
  const nutzung = {
    status: vi.fn().mockResolvedValue(nu),
    setzen: vi.fn((an: boolean) => Promise.resolve({ ...nu, an, gefragt: 'jetzt' })),
  }
  const t: Record<string, unknown> = { nutzung }
  if (fbGefragt !== 'ohne') {
    t.fehlerberichte = { status: vi.fn().mockResolvedValue({ automatisch: false, gefragt: fbGefragt }), setzen: vi.fn() }
  }
  ;(window as unknown as { transkribor: unknown }).transkribor = t
  return nutzung
}

async function zeigen(nu: NutzungZustand, fbGefragt: string | null | 'ohne' = '2026-10-01') {
  const api = bruecke(nu, fbGefragt)
  await act(async () => { render(<NutzungFrage />) })
  return api
}

describe('NutzungFrage', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    delete (window as unknown as { transkribor?: unknown }).transkribor
    _zuruecksetzen()
    fbZuruecksetzen()
  })

  it('fragt beim ersten Mal und nennt Zweck und was nie mitgeht', async () => {
    await zeigen(NIE)
    expect(screen.getByText(FRAGE)).toBeTruthy()
    expect(screen.getByText(/Wofür:/)).toBeTruthy()
    expect(screen.getByText(/Nie dabei:/)).toBeTruthy()
  })

  it('wartet, solange die Fehlerberichte-Frage noch offen ist', async () => {
    await zeigen(NIE, null)
    expect(screen.queryByText(FRAGE)).toBeNull()
  })

  it('fragt direkt, wenn die Hülle keinen Fehlerberichte-Schalter hat', async () => {
    await zeigen(NIE, 'ohne')
    expect(screen.getByText(FRAGE)).toBeTruthy()
  })

  it('fragt nicht noch einmal', async () => {
    await zeigen({ ...NIE, gefragt: '2026-10-01' })
    expect(screen.queryByText(FRAGE)).toBeNull()
  })

  it('Schliessen heisst Nein', async () => {
    const api = await zeigen(NIE)
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }) })
    expect(api.setzen).toHaveBeenCalledWith(false)
  })

  it('Ja schaltet ein', async () => {
    const api = await zeigen(NIE)
    await act(async () => { fireEvent.click(screen.getByText('Ja, mitzählen')) })
    expect(api.setzen).toHaveBeenCalledWith(true)
    expect(api.setzen).toHaveBeenCalledTimes(1)
  })
})
