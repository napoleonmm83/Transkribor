import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useDoc } from './useDoc'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import type { EditDoc, Segment } from '@/lib/types'

vi.mock('@/lib/api')
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const seg: Segment = {
  id: 0, start: 0, end: 1, speaker: 'A', raw_text: 'roh', text: 'roh',
  words: [], flags: { hallucination: false, low_conf: false }, note: '',
}
const doc: EditDoc = {
  base: 'b', project: 'P', audio: 'a.wav', language: 'de',
  human_edited: false, context: '', speakers: [], segments: [seg], annotations: [],
}

/** Laedt das Dokument und gibt den Hook zurueck — mit laufenden Fake-Timern. */
async function geladen() {
  vi.useFakeTimers()
  vi.mocked(api.getDoc).mockResolvedValue(doc)
  const h = renderHook(() => useDoc('P', 'b'))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(h.result.current.doc).toEqual(doc)
  return h
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('useDoc Autosave', () => {
  it('speichert erst nach der Tipppause — und mehrere Aenderungen nur EINMAL', async () => {
    vi.mocked(api.saveDoc).mockResolvedValue(undefined as never)
    const { result } = await geladen()

    await act(async () => {
      result.current.updateSegment(0, { text: 'eins' })
      await vi.advanceTimersByTimeAsync(500)     // Pause kuerzer als AUTOSAVE_MS
      result.current.updateSegment(0, { text: 'zwei' })
      await vi.advanceTimersByTimeAsync(500)
    })
    // Haette der Timer nicht neu angesetzt, laege hier schon ein Aufruf mit dem Zwischenstand.
    expect(api.saveDoc).not.toHaveBeenCalled()
    expect(result.current.stand).toBe('offen')

    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(api.saveDoc).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.saveDoc).mock.calls[0][2].segments[0].text).toBe('zwei')
    expect(result.current.stand).toBe('gespeichert')
    expect(result.current.dirty).toBe(false)
  })

  it('haelt dirty oben, wenn waehrend des Speicherns weitergetippt wird', async () => {
    // Sonst gilt das Dokument als gesichert, obwohl der letzte Tastendruck nie geschrieben
    // wurde — ein stiller Verlust, den keine Rueckfrage beim Verlassen mehr auffaengt.
    let fertig: () => void = () => {}
    vi.mocked(api.saveDoc).mockReturnValue(new Promise<void>(r => { fertig = r }))
    const { result } = await geladen()

    // Zwei getrennte act(): der Effekt setzt den Timer erst nach dem Render, im selben Block
    // waere die Uhr schon vorgedreht, bevor es ihn gibt.
    await act(async () => { result.current.updateSegment(0, { text: 'eins' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })   // Speichern laeuft los
    expect(api.saveDoc).toHaveBeenCalledTimes(1)

    await act(async () => { result.current.updateSegment(0, { text: 'zwei' }) })  // waehrend des Laufs getippt
    await act(async () => { fertig(); await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.dirty).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(vi.mocked(api.saveDoc).mock.calls[1][2].segments[0].text).toBe('zwei')
  })

  it('zeigt Fehler an, statt ihn zu verschlucken — und laesst dirty stehen', async () => {
    vi.mocked(api.saveDoc).mockRejectedValue(new Error('boom'))
    const { result } = await geladen()

    await act(async () => { result.current.updateSegment(0, { text: 'eins' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })

    expect(toast.error).toHaveBeenCalledWith('Speichern fehlgeschlagen: boom')
    expect(result.current.stand).toBe('fehler')
    expect(result.current.dirty).toBe(true)

    // Kein Nachtreten in Schleife: ohne neue Eingabe bleibt es bei dem einen Versuch.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.saveDoc).toHaveBeenCalledTimes(1)
  })
})

describe('useDoc updateDoc', () => {
  it('schreibt das Kopffeld und laeuft ueber dieselbe Entprellung wie ein Segment', async () => {
    // Kontext und Zusammenfassung duerfen keinen zweiten Speicherweg bekommen: sonst gibt es
    // zwei Wahrheiten darueber, wann ein Dokument als gesichert gilt.
    vi.mocked(api.saveDoc).mockResolvedValue(undefined as never)
    const { result } = await geladen()

    await act(async () => { result.current.updateDoc({ context: 'Interview am Deuce Day.' }) })
    expect(result.current.dirty).toBe(true)
    expect(api.saveDoc).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(api.saveDoc).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.saveDoc).mock.calls[0][2].context).toBe('Interview am Deuce Day.')
    // Das Uebrige bleibt unangetastet — ein Patch ist kein Ersatz des Dokuments.
    expect(vi.mocked(api.saveDoc).mock.calls[0][2].segments[0].text).toBe('roh')
  })
})

describe('useDoc: gleichzeitige Speicherlaeufe', () => {
  it('laeuft nie zweimal gleichzeitig — sonst kann der aeltere Stand gewinnen', async () => {
    // #115: nichts serialisierte die Laeufe. Lauf A unterwegs, 800 ms spaeter startet Lauf B
    // mit dem neueren Dokument — trifft A DANACH beim Server ein, steht der aeltere Stand auf
    // der Platte. Schlimmer als der Verlust ist der Zustand danach: B setzt `dirty` auf false
    // ("gespeichert"), A meldet anschliessend "offen" — und der Autosave-Effekt kehrt bei
    // !dirty sofort zurueck. Es fasst also nie wieder etwas nach.
    let laufend = 0, gleichzeitig = 0
    const warteschlange: Array<() => void> = []
    vi.mocked(api.saveDoc).mockImplementation((() => {
      laufend++
      gleichzeitig = Math.max(gleichzeitig, laufend)
      return new Promise<void>(r => warteschlange.push(() => { laufend--; r() }))
    }) as never)
    const { result } = await geladen()

    await act(async () => { result.current.updateSegment(0, { text: 'eins' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })     // Lauf A startet
    await act(async () => { result.current.updateSegment(0, { text: 'zwei' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })     // Lauf B will starten

    expect(gleichzeitig).toBe(1)

    // Beide abarbeiten (A zuerst, dann darf B ueberhaupt erst losgehen)
    await act(async () => { warteschlange.shift()?.(); await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { warteschlange.shift()?.(); await vi.advanceTimersByTimeAsync(0) })

    const rufe = vi.mocked(api.saveDoc).mock.calls
    expect(rufe[rufe.length - 1][2].segments[0].text).toBe('zwei')   // der neuere Stand zuletzt
    expect(result.current.dirty).toBe(false)
    expect(result.current.stand).toBe('gespeichert')                 // nicht "offen" ohne Nachfassen
  })
})

describe('useDoc Export-Fehler', () => {
  it('zeigt einen Toast statt einen unhandled rejection bei fehlgeschlagenem exportDownload()', async () => {
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    vi.mocked(api.exportText).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useDoc('P', 'b'))
    await waitFor(() => expect(result.current.doc).toEqual(doc))

    await act(async () => { await result.current.exportDownload('srt') })

    expect(toast.error).toHaveBeenCalledWith('Export fehlgeschlagen: boom')
  })
})
