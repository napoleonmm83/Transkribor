import { describe, it, expect, vi, afterEach } from 'vitest'
import { holeReleases } from './releases'

function antwort(daten: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => daten } as Response
}

afterEach(() => { vi.unstubAllGlobals() })

describe('holeReleases', () => {
  it('macht aus der GitHub-Antwort die Felder der Seite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => antwort([{
      tag_name: 'v0.29.0', published_at: '2026-08-21T12:17:28Z', draft: false, prerelease: false,
      body: '## Neu', html_url: 'https://github.com/x/y/releases/tag/v0.29.0',
    }])))
    expect(await holeReleases()).toEqual([{
      version: '0.29.0', tag: 'v0.29.0', datum: '2026-08-21', notizen: '## Neu',
      url: 'https://github.com/x/y/releases/tag/v0.29.0',
    }])
  })

  it('lässt Vorabfassungen und Entwürfe weg', async () => {
    // `modelle-v1` (die GGML-Dateien) ist ein Prerelease und keine Fassung der App —
    // im Versionsverlauf wäre es eine Zeile, zu der es nichts zu lesen gibt.
    vi.stubGlobal('fetch', vi.fn(async () => antwort([
      { tag_name: 'modelle-v1', published_at: '2026-08-01T00:00:00Z', prerelease: true, draft: false, body: '' },
      { tag_name: 'v0.1.0', published_at: '2026-07-01T00:00:00Z', prerelease: false, draft: true, body: '' },
      { tag_name: 'v0.29.0', published_at: '2026-08-21T12:17:28Z', prerelease: false, draft: false, body: '' },
    ])))
    expect((await holeReleases()).map(r => r.tag)).toEqual(['v0.29.0'])
  })

  it('wirft bei HTTP-Fehler mit dem Status darin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => antwort(null, false, 403)))
    await expect(holeReleases()).rejects.toThrow(/403/)
  })

  it('wirft mit eigener Meldung, wenn die Antwort keine Liste ist', async () => {
    // Bei ueberschrittenem Kontingent antwortet GitHub mit einem Objekt. Die Meldung MUSS
    // geprueft werden: ohne die Wache wirft `roh.filter` von selbst einen TypeError, ein
    // blosses `rejects.toThrow()` bliebe also auch ohne sie gruen (gemessen).
    vi.stubGlobal('fetch', vi.fn(async () => antwort({ message: 'rate limit' })))
    await expect(holeReleases()).rejects.toThrow(/keine Liste|nicht mit einer Liste/)
  })

  it('reicht das Abbruchsignal durch — die Seite kann verlassen werden, während geladen wird', async () => {
    // Gemessen wird die WIRKUNG, nicht die Identitaet: seit dem Zeitlimit geht ein
    // zusammengesetztes Signal an fetch, ein Vergleich auf Gleichheit waere also rot,
    // obwohl der Abbruch funktioniert.
    // Signatur ausgeschrieben: `vi.fn(async () => …)` ergibt Aufrufe vom Tupeltyp `[]`, und
    // `calls[0][1]` waere dann TS2493 — sichtbar erst in `tsc -b`, nicht im vitest-Lauf.
    const f = vi.fn(async (_url: string, _opt?: RequestInit) => antwort([]))
    vi.stubGlobal('fetch', f)
    const ac = new AbortController()
    await holeReleases(ac.signal)
    const uebergeben = f.mock.calls[0][1]?.signal as AbortSignal
    expect(uebergeben.aborted).toBe(false)
    ac.abort()
    expect(uebergeben.aborted).toBe(true)
  })

  it('bricht auch ohne aeusseres Signal nach einer Frist WIRKLICH ab', async () => {
    // Ohne Frist dreht der Spinner bei einer haengenden Verbindung bis zum Verlassen der
    // Seite — und der Weg zu GitHub steht nur im Fehlerzweig.
    // Gemessen wird der Abbruch, nicht nur die Anwesenheit eines Signals: die Frist kommt
    // als Parameter herein (5 ms), weil `AbortSignal.timeout` an vitests Fake-Timers
    // vorbeilaeuft — mit `advanceTimersByTime(10001)` bleibt `aborted` auf `false`.
    const f = vi.fn(async (_url: string, _opt?: RequestInit) => antwort([]))
    vi.stubGlobal('fetch', f)
    await holeReleases(undefined, 5)
    const uebergeben = f.mock.calls[0][1]?.signal as AbortSignal
    expect(uebergeben.aborted).toBe(false)
    await new Promise(r => setTimeout(r, 25))
    expect(uebergeben.aborted).toBe(true)
  })
})
