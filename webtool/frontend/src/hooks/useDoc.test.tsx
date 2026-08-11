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

    // Mehr prueft dieser Test bewusst NICHT: die Reihenfolge beim Server ist von hier aus nicht
    // sichtbar, und die Warteschlange arbeitet er selbst in der Reihenfolge A->B ab — jede
    // Zusicherung darueber waere auch ohne die Verkettung gruen. Den Inhalt sichert der Test
    // „der zuletzt getippte Stand geht nicht verloren“ weiter unten.
  })

  it('eine Ablehnung ohne Error-Objekt legt den Autosave nicht lahm', async () => {
    // Der catch-Block dereferenzierte `e` (`(e as Error).message`) und konnte damit SELBST
    // werfen. Dann lehnt `kette.current` ab, jedes weitere `.then()` reicht die Ablehnung
    // durch — und ALLE folgenden Speicherlaeufe der Sitzung fallen still aus.
    vi.mocked(api.saveDoc).mockRejectedValueOnce(null as never)
    vi.mocked(api.saveDoc).mockResolvedValue(undefined as never)
    const { result } = await geladen()

    await act(async () => { result.current.updateSegment(0, { text: 'eins' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(result.current.stand).toBe('fehler')

    await act(async () => { result.current.updateSegment(0, { text: 'zwei' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(api.saveDoc).toHaveBeenCalledTimes(2)     // der zweite Lauf kommt ueberhaupt dran
    expect(result.current.stand).toBe('gespeichert')
  })

  it('nach einem Dateiwechsel OHNE Tastendruck meldet B nicht "gespeichert"', async () => {
    // Was `meins()` allein traegt: ohne Tastendruck in B passt `fassung` weiterhin, der
    // Zaehler-Waechter greift also nicht. Ohne den Guard meldete die Leiste „gespeichert“ fuer
    // ein Dokument, das nie geschrieben wurde.
    const docB: EditDoc = { ...doc, base: 'b2' }
    let fertigA: () => void = () => {}
    vi.mocked(api.saveDoc).mockReturnValueOnce(new Promise<void>(r => { fertigA = r }) as never)
    vi.useFakeTimers()
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    const h = renderHook(({ b }) => useDoc('P', b), { initialProps: { b: 'b' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { h.result.current.updateSegment(0, { text: 'A-Text' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })   // Lauf fuer A haengt

    vi.mocked(api.getDoc).mockResolvedValue(docB)
    h.rerender({ b: 'b2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { fertigA(); await vi.advanceTimersByTimeAsync(0) })

    expect(h.result.current.stand).toBe('ruhig')     // ohne `meins()`: 'gespeichert'
  })

  it('der Dokumentschluessel verwechselt „A B“/„C“ nicht mit „A“/„B C“', async () => {
    // Projektnamen enthalten Leerzeichen („US Car Treff Rthi“). Mit einem Leerzeichen als
    // Trenner ergaeben beide Paare denselben Schluessel — `meins()` haelte den Lauf der einen
    // Datei fuer den der anderen und meldete „gespeichert“ fuer ein ungeschriebenes Dokument.
    const docB: EditDoc = { ...doc, project: 'A', base: 'B C' }
    let fertigA: () => void = () => {}
    vi.mocked(api.saveDoc).mockReturnValueOnce(new Promise<void>(r => { fertigA = r }) as never)
    vi.useFakeTimers()
    vi.mocked(api.getDoc).mockResolvedValue({ ...doc, project: 'A B', base: 'C' })
    const h = renderHook(({ p, b }) => useDoc(p, b), { initialProps: { p: 'A B', b: 'C' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { h.result.current.updateSegment(0, { text: 'A-Text' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })   // Lauf haengt

    vi.mocked(api.getDoc).mockResolvedValue(docB)
    h.rerender({ p: 'A', b: 'B C' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { fertigA(); await vi.advanceTimersByTimeAsync(0) })

    expect(h.result.current.stand).toBe('ruhig')     // mit Leerzeichen-Trenner: 'gespeichert'
  })
})

describe('useDoc: Dateiwechsel mitten im Speichern', () => {
  it('ein Lauf fuer Datei A darf die Aenderung an Datei B nicht als gesichert melden', async () => {
    // `fassung` und `kette` sind Refs — sie ueberleben den Dateiwechsel, `doc`/`dirty` nicht.
    // Laeuft A noch, waehrend der Nutzer laengst in B tippt, meldet As Rueckkehr `dirty=false`
    // fuer B. Bs Tastendruck gilt dann als gesichert, ist aber nie geschrieben worden.
    const docB: EditDoc = { ...doc, base: 'b2' }
    let fertigA: () => void = () => {}
    vi.mocked(api.saveDoc).mockReturnValueOnce(new Promise<void>(r => { fertigA = r }) as never)
    vi.mocked(api.saveDoc).mockResolvedValue(undefined as never)

    vi.useFakeTimers()
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    const h = renderHook(({ b }) => useDoc('P', b), { initialProps: { b: 'b' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => { h.result.current.updateSegment(0, { text: 'A-Text' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })   // Lauf A startet, haengt

    // Nutzer wechselt die Datei
    vi.mocked(api.getDoc).mockResolvedValue(docB)
    h.rerender({ b: 'b2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(h.result.current.doc?.base).toBe('b2')

    // ... und tippt dort
    await act(async () => { h.result.current.updateSegment(0, { text: 'B-Text' }) })
    expect(h.result.current.dirty).toBe(true)

    // Jetzt kehrt der Lauf fuer die ALTE Datei zurueck
    await act(async () => { fertigA(); await vi.advanceTimersByTimeAsync(0) })

    expect(h.result.current.dirty).toBe(true)   // Bs Tastendruck ist NICHT gesichert
  })

  it('auch ein Lauf, der ERST NACH dem Wechsel startet, darf das nicht', async () => {
    // Die Verkettung erlaubt, was es vorher nicht gab: ein zweiter Lauf fuer Datei A wartet,
    // waehrend der Nutzer schon in B tippt — und startet danach. Er liest `fassung` erst beim
    // Start, sieht Bs Tastendruck also als "seinen" Stand und meldet ihn als gesichert.
    const docB: EditDoc = { ...doc, base: 'b2' }
    let fertigA1: () => void = () => {}
    vi.mocked(api.saveDoc)
      .mockReturnValueOnce(new Promise<void>(r => { fertigA1 = r }) as never)
      .mockResolvedValue(undefined as never)

    vi.useFakeTimers()
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    const h = renderHook(({ b }) => useDoc('P', b), { initialProps: { b: 'b' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => { h.result.current.updateSegment(0, { text: 'A-eins' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })    // A1 startet, haengt
    await act(async () => { h.result.current.updateSegment(0, { text: 'A-zwei' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })    // A2 haengt in der Kette

    vi.mocked(api.getDoc).mockResolvedValue(docB)
    h.rerender({ b: 'b2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => { h.result.current.updateSegment(0, { text: 'B-Text' }) })
    expect(h.result.current.dirty).toBe(true)

    // A1 kehrt zurueck -> A2 startet JETZT, nach Bs Tastendruck
    await act(async () => { fertigA1(); await vi.advanceTimersByTimeAsync(0) })

    expect(h.result.current.dirty).toBe(true)   // Bs Tastendruck ist NICHT gesichert
  })
})

describe('useDoc: wartender Lauf liest den falschen Zaehlerstand', () => {
  it('der zuletzt getippte Stand geht nicht verloren — auch ohne Dateiwechsel', async () => {
    // Befund aus dem Review von PR #116. `doc` wird beim ANHAENGEN eingefangen, `fassung` aber
    // erst beim START gelesen. Ein wartender Lauf sieht damit Tastendruecke, die nach seinem
    // Anhaengen kamen, als seinen eigenen Stand — und meldet sie als gesichert.
    const dauern = [1400, 300, 300, 300, 300]
    let i = 0
    vi.mocked(api.saveDoc).mockImplementation((() =>
      new Promise<void>(r => { setTimeout(r, dauern[i++] ?? 300) })) as never)

    const { result } = await geladen()
    await act(async () => { result.current.updateSegment(0, { text: 'eins' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(850) })
    await act(async () => { result.current.updateSegment(0, { text: 'zwei' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1050) })
    await act(async () => { result.current.updateSegment(0, { text: 'drei' }) })
    // In kleinen Schritten: ein Vorlauf am Stueck fuehrte die Effekt-Bereinigung erst nach
    // allen Timern aus und definierte den Fall weg.
    for (let t = 0; t < 560; t++) await act(async () => { await vi.advanceTimersByTimeAsync(50) })

    const rufe = vi.mocked(api.saveDoc).mock.calls
    expect(rufe[rufe.length - 1][2].segments[0].text).toBe('drei')
    expect(result.current.dirty).toBe(false)
    expect(result.current.stand).toBe('gespeichert')
  })
})

describe('useDoc: Dokument A darf nie in Datei B landen', () => {
  it('nach einem Dateiwechsel schreibt die Entprellung nicht das alte Dokument unter den neuen Pfad', async () => {
    // Befund aus Review-Runde 2, VORBESTEHEND (auch ohne die Verkettung). `reload()` ersetzt das
    // Dokument erst, wenn `getDoc` zurueckkommt. Bis dahin gilt: doc = A, project/base = B,
    // dirty = true (aus A). Der Entprellungs-Timer wird durch den base-Wechsel neu gesetzt und
    // feuert mit saveDoc(B-Pfad, A-Dokument). `meins()` greift nicht: der Lauf traegt Bs Pfad,
    // die Ungleichheit liegt INNERHALB der Closure.
    // Auf der Platte: b2.edit.json wird durch A ersetzt, b2.md neu gerendert, human_edited=true.
    const docB: EditDoc = { ...doc, base: 'b2' }
    vi.mocked(api.saveDoc).mockResolvedValue(undefined as never)
    vi.useFakeTimers()
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    const h = renderHook(({ b }) => useDoc('P', b), { initialProps: { b: 'b' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => { h.result.current.updateSegment(0, { text: 'A-Text' }) })

    // Wechsel, waehrend getDoc(B) noch haengt
    let fertigB: (d: EditDoc) => void = () => {}
    vi.mocked(api.getDoc).mockReturnValue(new Promise<EditDoc>(r => { fertigB = r }))
    h.rerender({ b: 'b2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })   // Entprellung feuert hier

    const falsch = vi.mocked(api.saveDoc).mock.calls
      .filter(c => c[1] !== c[2].base)
      .map(c => `${c[1]} <- ${c[2].base}`)
    expect(falsch).toEqual([])

    await act(async () => { fertigB(docB); await vi.advanceTimersByTimeAsync(0) })
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
