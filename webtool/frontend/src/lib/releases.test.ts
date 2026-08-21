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

  it('wirft, wenn die Antwort keine Liste ist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => antwort({ message: 'rate limit' })))
    await expect(holeReleases()).rejects.toThrow()
  })

  it('reicht das Abbruchsignal durch — die Seite kann verlassen werden, während geladen wird', async () => {
    // Signatur ausgeschrieben: `vi.fn(async () => …)` ergibt Aufrufe vom Tupeltyp `[]`, und
    // `calls[0][1]` waere dann TS2493 — sichtbar erst in `tsc -b`, nicht im vitest-Lauf.
    const f = vi.fn(async (_url: string, _opt?: RequestInit) => antwort([]))
    vi.stubGlobal('fetch', f)
    const signal = new AbortController().signal
    await holeReleases(signal)
    expect(f.mock.calls[0][1]).toMatchObject({ signal })
  })
})
