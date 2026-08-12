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
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'en', korrektur: 'auto', sprach_choices: [], tiefen: [] }) })
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
