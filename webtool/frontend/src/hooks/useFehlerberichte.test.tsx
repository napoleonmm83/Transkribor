import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useFehlerberichte, type FehlerberichteZustand } from './useFehlerberichte'

const AUS: FehlerberichteZustand = { automatisch: false, gefragt: '2026-09-03T00:00:00Z' }
const AN: FehlerberichteZustand = { automatisch: true, gefragt: '2026-09-03T00:00:00Z' }

/** Muster wie in useUpdate.test.tsx — es gibt keinen geteilten Helfer fuer die Bruecke. */
function bruecke(start: FehlerberichteZustand, mitSchalter = true) {
  const api = {
    update: { status: vi.fn() },
    ...(mitSchalter ? {
      fehlerberichte: {
        status: vi.fn().mockResolvedValue(start),
        setzen: vi.fn((an: boolean) => Promise.resolve({ ...start, automatisch: an })),
      },
    } : {}),
  }
  ;(window as unknown as { transkribor: unknown }).transkribor = api
  return api
}

describe('useFehlerberichte', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('ohne Bruecke (Browser) gibt es keinen Schalter', () => {
    const { result } = renderHook(() => useFehlerberichte())
    expect(result.current).toBeNull()
  })

  it('eine Huelle MIT update, aber OHNE fehlerberichte, hat auch keinen Schalter', () => {
    bruecke(AUS, false)
    const { result } = renderHook(() => useFehlerberichte())
    expect(result.current).toBeNull()
  })

  it('holt den Zustand aus dem Hauptprozess; bis dahin ist er null', async () => {
    bruecke(AUS)
    const { result } = renderHook(() => useFehlerberichte())
    expect(result.current?.zustand).toBeNull()
    await waitFor(() => expect(result.current?.zustand).toEqual(AUS))
  })

  it('setzen reicht den Wert durch und uebernimmt die Antwort des Hauptprozesses', async () => {
    const api = bruecke(AUS)
    const { result } = renderHook(() => useFehlerberichte())
    await waitFor(() => expect(result.current?.zustand).toEqual(AUS))
    await act(async () => { await result.current!.setzen(true) })
    expect(api.fehlerberichte!.setzen).toHaveBeenCalledWith(true)
    expect(result.current?.zustand).toEqual(AN)
  })

  it('setzen reicht einen Fehlschlag DURCH statt ihn zu schlucken', async () => {
    const api = bruecke(AUS)
    api.fehlerberichte!.setzen.mockRejectedValueOnce(new Error('Platte voll'))
    const { result } = renderHook(() => useFehlerberichte())
    await waitFor(() => expect(result.current?.zustand).toEqual(AUS))
    await expect(result.current!.setzen(true)).rejects.toThrow('Platte voll')
    expect(result.current?.zustand).toEqual(AUS)
  })
})
