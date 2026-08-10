import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useProjectFiles } from './useProjectFiles'
import * as api from '@/lib/api'
import type { ProjectFile } from '@/lib/types'

vi.mock('@/lib/api')

const datei: ProjectFile = { base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }

describe('useProjectFiles', () => {
  beforeEach(() => vi.clearAllMocks())

  it('laedt die Dateien ueber GET /api/projects/{project}', async () => {
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [datei] })
    const { result } = renderHook(() => useProjectFiles('Demo'))
    await waitFor(() => expect(result.current.files).toEqual([datei]))
    expect(api.getProjectFiles).toHaveBeenCalledWith('Demo')
  })

  it('laesst files leer und setzt fehler, wenn die Abfrage scheitert, statt zu werfen', async () => {
    vi.mocked(api.getProjectFiles).mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useProjectFiles('Demo'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.files).toEqual([])
    expect(result.current.fehler).toBe(true)
  })

  it('setzt fehler bei einem erneuten erfolgreichen Laden zurueck', async () => {
    vi.mocked(api.getProjectFiles).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ name: 'Demo', files: [datei] })
    const { result } = renderHook(() => useProjectFiles('Demo'))
    await waitFor(() => expect(result.current.fehler).toBe(true))
    await act(async () => { result.current.refresh() })
    await waitFor(() => expect(result.current.fehler).toBe(false))
    expect(result.current.files).toEqual([datei])
  })

  it('refresh() ruft den Endpunkt erneut', async () => {
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [datei] })
    const { result } = renderHook(() => useProjectFiles('Demo'))
    await waitFor(() => expect(api.getProjectFiles).toHaveBeenCalledTimes(1))
    await act(async () => { result.current.refresh() })
    await waitFor(() => expect(api.getProjectFiles).toHaveBeenCalledTimes(2))
  })

  it('verwirft eine verspaetete Antwort eines verlassenen Projekts', async () => {
    // 'Alt' bleibt haengen (loest nie auf), waehrend 'Neu' sofort antwortet -- simuliert eine
    // langsame Antwort, die erst NACH dem Projektwechsel eintrifft.
    let loeseAlt: ((v: { name: string; files: ProjectFile[] }) => void) | null = null
    const altPromise = new Promise<{ name: string; files: ProjectFile[] }>(r => { loeseAlt = r })
    const neuDatei: ProjectFile = { ...datei, base: 'S2' }
    vi.mocked(api.getProjectFiles).mockImplementation((p: string) =>
      p === 'Alt' ? altPromise : Promise.resolve({ name: 'Neu', files: [neuDatei] }))

    const { result, rerender } = renderHook(({ project }) => useProjectFiles(project),
      { initialProps: { project: 'Alt' } })
    rerender({ project: 'Neu' })
    await waitFor(() => expect(result.current.files).toEqual([neuDatei]))

    // Die alte Anfrage loest jetzt verspaetet auf -- darf 'Neu's Dateien nicht mehr ueberschreiben.
    await act(async () => { loeseAlt!({ name: 'Alt', files: [datei] }) })
    expect(result.current.files).toEqual([neuDatei])
  })

  it('verwirft eine aeltere Antwort, wenn zwei Anfragen fuers SELBE Projekt ueberlappen', async () => {
    // Seit W1 koennen der Summenpoll-Waechter und onSettled im selben Zyklus feuern -- beide
    // rufen refresh() fuers gleiche Projekt auf. Kommt die aeltere Antwort zuletzt an, darf sie
    // die juengere nicht mehr ueberschreiben (angefragt allein schuetzt das NICHT, das prueft nur
    // den Projektwechsel).
    let loeseErste: ((v: { name: string; files: ProjectFile[] }) => void) | null = null
    const erstePromise = new Promise<{ name: string; files: ProjectFile[] }>(r => { loeseErste = r })
    const neuDatei: ProjectFile = { ...datei, base: 'S2' }
    vi.mocked(api.getProjectFiles)
      .mockImplementationOnce(() => erstePromise)              // die erste (Mount-)Anfrage haengt
      .mockResolvedValueOnce({ name: 'Demo', files: [neuDatei] })   // die zweite antwortet zuerst

    const { result } = renderHook(() => useProjectFiles('Demo'))
    await act(async () => { result.current.refresh() })            // ueberlappende zweite Anfrage
    await waitFor(() => expect(result.current.files).toEqual([neuDatei]))

    // Die aeltere Anfrage loest jetzt verspaetet auf -- darf die juengeren Dateien nicht mehr ueberschreiben.
    await act(async () => { loeseErste!({ name: 'Demo', files: [datei] }) })
    expect(result.current.files).toEqual([neuDatei])
  })

  it('ein Fehler des verlassenen Projekts darf den fehler-Zustand des neuen nicht setzen', async () => {
    let verwirfAlt: ((e: Error) => void) | null = null
    const altPromise = new Promise<{ name: string; files: ProjectFile[] }>((_, reject) => { verwirfAlt = reject })
    vi.mocked(api.getProjectFiles).mockImplementation((p: string) =>
      p === 'Alt' ? altPromise : Promise.resolve({ name: 'Neu', files: [datei] }))

    const { result, rerender } = renderHook(({ project }) => useProjectFiles(project),
      { initialProps: { project: 'Alt' } })
    rerender({ project: 'Neu' })
    await waitFor(() => expect(result.current.files).toEqual([datei]))

    // 'Alt' scheitert jetzt verspaetet -- darf 'Neu's fehler-Zustand nicht setzen.
    await act(async () => { verwirfAlt!(new Error('offline')) })
    expect(result.current.fehler).toBe(false)
  })
})
