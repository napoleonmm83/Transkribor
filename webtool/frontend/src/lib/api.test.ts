import { describe, it, expect, vi, afterEach } from 'vitest'
import * as api from './api'

afterEach(() => { vi.unstubAllGlobals() })

describe('audioUrl', () => {
  it('encodiert Projekt und base', () => {
    expect(api.audioUrl('Food Festival', 'C0687/x')).toBe(
      '/api/projects/Food%20Festival/audio/C0687%2Fx')
  })
})

describe('createProject / deleteProject', () => {
  it('createProject POSTet JSON und liefert die Antwort', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, name: 'Neu' }) })
    vi.stubGlobal('fetch', fetchMock)
    expect(await api.createProject('Neu')).toEqual({ ok: true, name: 'Neu' })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ method: 'POST' }))
  })
  it('deleteProject schickt DELETE mit encodiertem Namen', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    await api.deleteProject('Food Festival')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/Food%20Festival', expect.objectContaining({ method: 'DELETE' }))
  })
})

describe('ProjektEinstellungen', () => {
  it('getProjektEinstellungen GETt den codierten Pfad', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'ch', korrektur: 'auto', sprach_choices: [], tiefen: [] }) })
    vi.stubGlobal('fetch', fm)
    await api.getProjektEinstellungen('Food Festival')
    expect(fm).toHaveBeenCalledWith('/api/projects/Food%20Festival/einstellungen')
  })

  it('saveProjektEinstellungen PUTt JSON und gibt die Antwort zurück', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'en', korrektur: 'auto' }) })
    vi.stubGlobal('fetch', fm)
    const r = await api.saveProjektEinstellungen('p', { sprache: 'en' })
    expect(fm).toHaveBeenCalledWith('/api/projects/p/einstellungen',
      expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/json' } }))
    expect(r.sprache).toBe('en')
  })

  it('uploadAudio hängt sprache an, wenn gesetzt', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ base: 'x', file: 'x.mp3' }) })
    vi.stubGlobal('fetch', fm)
    await api.uploadAudio('p', new File(['a'], 'x.mp3'), 'en')
    const body = fm.mock.calls[0][1].body as FormData
    expect(body.get('sprache')).toBe('en')
  })

  it('uploadAudio ohne sprache setzt kein sprache-Feld', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ base: 'x', file: 'x.mp3' }) })
    vi.stubGlobal('fetch', fm)
    await api.uploadAudio('p', new File(['a'], 'x.mp3'))
    const body = fm.mock.calls[0][1].body as FormData
    expect(body.get('sprache')).toBeNull()
  })

  it('fetchUrls nimmt sprache in den Body auf', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job_id: 'j', started: true }) })
    vi.stubGlobal('fetch', fm)
    await api.fetchUrls('p', ['https://youtu.be/x'], 'en')
    const body = JSON.parse(fm.mock.calls[0][1].body)
    expect(body).toEqual({ urls: ['https://youtu.be/x'], sprache: 'en' })
  })
})

describe('DateiEinstellungen', () => {
  it('getFileEinstellungen GETt den codierten Datei-Pfad', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'ch', korrektur: 'auto', sprach_choices: [], tiefen: [] }) })
    vi.stubGlobal('fetch', fm)
    await api.getFileEinstellungen('Food Festival', 'A B')
    expect(fm).toHaveBeenCalledWith('/api/projects/Food%20Festival/files/A%20B/einstellungen')
  })

  it('saveFileEinstellungen PUTt JSON und gibt die Antwort zurück', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'en', korrektur: 'auto' }) })
    vi.stubGlobal('fetch', fm)
    const r = await api.saveFileEinstellungen('p', 'a', { sprache: 'en' })
    expect(fm).toHaveBeenCalledWith('/api/projects/p/files/a/einstellungen',
      expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/json' } }))
    expect(r.sprache).toBe('en')
  })
})

/** #299: `uploadAudio`/`fetchUrls` liefen ohne Zeitlimit — ein haengender Request (uvicorn
 *  mitten im Neustart, abgerissene Strecke) wurde nie abgeraeumt. Der Dialog kam ueber
 *  „Schliessen" zwar heraus, aber der Nutzer musste den Fehlschlag selbst bemerken. */
describe('Zeitlimit beim Senden (#299)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  /** Eine echte 500-MB-Datei wuerde der Testlauf allokieren. `size` ist das einzige Feld,
   *  das die Frist bestimmt. */
  function dateiMit(bytes: number): File {
    const f = new File(['x'], 'aufnahme.mp3')
    Object.defineProperty(f, 'size', { value: bytes })
    return f
  }
  const okFetch = () => vi.fn().mockResolvedValue(
    { ok: true, json: async () => ({ base: 'a', file: 'a.mp3' }) })

  it('bemisst die Upload-Frist an der Dateigroesse', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', okFetch())
    await api.uploadAudio('P', dateiMit(1_000_000))
    const klein = spy.mock.calls.at(-1)![0] as number
    await api.uploadAudio('P', dateiMit(500_000_000))
    const gross = spy.mock.calls.at(-1)![0] as number
    // Die Frist eines JSON-GET (30 s) wuerde einen echten Upload abschneiden — genau davor
    // warnt das Issue. Sie muss mit der uebertragenen Menge wachsen, nicht fest sein.
    expect(gross).toBeGreaterThan(klein)
    expect(klein).toBeGreaterThanOrEqual(30_000)
  })

  it('uebersetzt ein gerissenes Zeitlimit in „vielleicht doch angekommen"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
    // „fehlgeschlagen" waere falsch: der Server kann die Datei schon geschrieben und den
    // Transkriptions-Job gestartet haben. Wer daraufhin erneut hochlaedt, bekommt einen 409.
    await expect(api.uploadAudio('P', dateiMit(1_000))).rejects.toThrow(/möglicherweise/)
  })

  it('laesst einen HttpFehler unveraendert durch — die 409-Erkennung haengt daran', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      { ok: false, status: 409, json: async () => ({ detail: 'existiert bereits' }) }))
    // `MaterialDialog` unterscheidet „schon da" von „fehlgeschlagen" an `e instanceof
    // HttpFehler && e.status === 409`. Eine Uebersetzung, die den Typ verschluckt, liesse
    // jede Dublette als echten Fehlschlag in der Liste stehenbleiben.
    await expect(api.uploadAudio('P', dateiMit(1_000))).rejects.toBeInstanceOf(api.HttpFehler)
  })

  it('gibt auch fetchUrls ein Zeitlimit mit', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job_id: 'j', started: true }) })
    vi.stubGlobal('fetch', fm)
    await api.fetchUrls('P', ['https://youtu.be/x'])
    // Der Handler validiert nur und startet einen Job — der Download laeuft im Subprozess.
    // Hier reicht die Frist eines JSON-Endpunkts.
    expect(spy).toHaveBeenCalled()
    expect(fm.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
})
