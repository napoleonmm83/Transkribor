import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useUpdate } from './useUpdate'
import type { UpdateZustand } from '@/lib/types'

const AKTUELL: UpdateZustand = { version: '0.2.1', art: 'aktuell' }

function bruecke(start: UpdateZustand | null) {
  let melden: ((z: UpdateZustand) => void) | null = null
  const abmelden = vi.fn()
  const api = {
    update: {
      status: vi.fn().mockResolvedValue(start),
      pruefen: vi.fn().mockResolvedValue(undefined),
      laden: vi.fn().mockResolvedValue(undefined),
      installieren: vi.fn().mockResolvedValue(undefined),
    },
    protokollOeffnen: vi.fn().mockResolvedValue('C:\\log.txt'),
    fehlerbericht: vi.fn().mockResolvedValue({ pfad: 'C:\\log.txt', verwendet: 12, gekuerzt: false }),
    on: (kanal: string, fn: (z: UpdateZustand) => void) => {
      if (kanal === 'update') melden = fn
      return abmelden
    },
  }
  ;(window as unknown as { transkribor: unknown }).transkribor = api
  return { api, abmelden, schieben: (z: UpdateZustand) => act(() => melden?.(z)) }
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

  it('reicht fehlerbericht durch (#372)', async () => {
    const { api } = bruecke(AKTUELL)
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toEqual(AKTUELL))
    // Geschweifte Klammern, NICHT `act(() => result.current.fehlerbericht())`: seit der Hook
    // sein Versprechen durchreicht (Reviewbefund B1), gaebe der Pfeil ein Promise zurueck —
    // und `act` haelt einen zurueckgegebenen Thenable fuer einen ASYNC act, den niemand
    // abwartet. Gemessen: die drei FOLGENDEN Tests dieser Datei fielen daraufhin mit
    // „Cannot read properties of null (reading 'zustand')" um, nicht dieser hier.
    act(() => { result.current.fehlerbericht() })
    expect(api.fehlerbericht).toHaveBeenCalled()
  })

  it('reicht die ABLEHNUNG durch — daran haengt der Toast der Seite', async () => {
    // Der Test darueber misst nur, DASS gerufen wird. Ein `.catch(() => {})` im Hook bliebe
    // damit gruen, und der Toast in VersionPage waere tot, ohne dass ein Test faellt
    // (CodeRabbit-Bot). Die Zusage ist das durchgereichte Versprechen, nicht der Aufruf.
    const { api } = bruecke(AKTUELL)
    api.fehlerbericht.mockRejectedValue(new Error('Kein Programm fuer mailto'))
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toEqual(AKTUELL))
    await expect(result.current.fehlerbericht()).rejects.toThrow(/mailto/)
  })

  it('reicht protokollOeffnen durch — der Weg aus dem Fehlerzustand', async () => {
    const { api } = bruecke(AKTUELL)
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toEqual(AKTUELL))
    act(() => result.current.protokollOeffnen())
    expect(api.protokollOeffnen).toHaveBeenCalled()
  })

  it('wenn der Automat in Electron nicht gebaut werden konnte, bleibt der Zustand null', async () => {
    bruecke(null)
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toBeNull())
  })

  it('meldet den Listener beim Unmount ab — sonst haeufen sich Hoerer bei jedem Seitenwechsel', async () => {
    const { abmelden } = bruecke(AKTUELL)
    const { result, unmount } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toEqual(AKTUELL))
    unmount()
    expect(abmelden).toHaveBeenCalledTimes(1)
  })
})
