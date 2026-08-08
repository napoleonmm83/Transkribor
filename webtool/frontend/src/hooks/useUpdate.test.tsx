import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useUpdate } from './useUpdate'
import type { UpdateZustand } from '@/lib/types'

const AKTUELL: UpdateZustand = { version: '0.2.1', art: 'aktuell' }

function bruecke(start: UpdateZustand) {
  let melden: ((z: UpdateZustand) => void) | null = null
  const api = {
    update: {
      status: vi.fn().mockResolvedValue(start),
      pruefen: vi.fn().mockResolvedValue(undefined),
      laden: vi.fn().mockResolvedValue(undefined),
      installieren: vi.fn().mockResolvedValue(undefined),
    },
    on: (kanal: string, fn: (z: UpdateZustand) => void) => { if (kanal === 'update') melden = fn },
  }
  ;(window as unknown as { transkribor: unknown }).transkribor = api
  return { api, schieben: (z: UpdateZustand) => act(() => melden?.(z)) }
}

describe('useUpdate', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('holt den Anfangszustand aus Electron', async () => {
    bruecke(AKTUELL)
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toEqual(AKTUELL))
  })

  it('uebernimmt geschobene Aenderungen ohne erneutes Abfragen', async () => {
    const { api, schieben } = bruecke(AKTUELL)
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toEqual(AKTUELL))

    schieben({ version: '0.2.1', art: 'laedt', prozent: 43, geladen: 41, gesamt: 94, tempo: 6200000 })
    await waitFor(() => expect(result.current.zustand?.art).toBe('laedt'))
    expect(api.update.status).toHaveBeenCalledTimes(1)
  })

  it('ohne Electron bleibt der Zustand null — der Abschnitt erscheint dann gar nicht', async () => {
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toBeNull())
  })

  it('reicht die Knopfdruecke durch', async () => {
    const { api } = bruecke({ version: '0.2.1', art: 'verfuegbar', neue: '0.3.0', groesse: 99 })
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand?.art).toBe('verfuegbar'))
    act(() => result.current.laden())
    expect(api.update.laden).toHaveBeenCalled()
  })
})
