import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'
import * as api from '@/lib/api'
import type { Hardware, Settings } from '@/lib/types'

vi.mock('@/lib/api')
// Default: kein Electron -> Abschnitt bleibt aus, wie es SettingsPage ausserhalb dieses
// Tests auch fuer alle SettingsPage-Tests erwartet, die zeigeMit gar nicht aufrufen.
vi.mock('@/hooks/useUpdate', () => ({
  useUpdate: vi.fn(() => ({ zustand: null, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn() })),
}))

import { useUpdate } from '@/hooks/useUpdate'
import type { UpdateZustand } from '@/lib/types'

const BASIS: Settings = {
  provider: 'claude-cli', model: '', base_url: '', has_key: false, has_hf_token: false, env_key: '',
  whisper_model: 'large-v3', whisper_lang: 'de',
  whisper_choices: [
    { id: 'turbo', label: 'Schnell und gut', hint: 'nahe large-Qualität' },
    { id: 'large-v3', label: 'Beste Qualität', hint: 'bester Dialekt' },
  ],
  ai_ready: true, ai_reason: '',
  providers: [
    { id: 'claude-cli', label: 'Claude Code Abo (kein Key)', needs_key: false, base: '', default_model: '', keys_url: '', hint: 'Nutzt das Abo.' },
    { id: 'anthropic', label: 'Anthropic (Claude)', needs_key: true, base: 'https://api.anthropic.com/v1', default_model: 'claude-opus-5', keys_url: 'https://x', hint: '' },
  ],
}

const zeige = (s: Partial<Settings> = {}, hw: Hardware = { device: 'cuda', name: 'NVIDIA RTX 5080', torch_ok: true }) => {
  vi.mocked(api.getSettings).mockResolvedValue({ ...BASIS, ...s })
  vi.mocked(api.getHardware).mockResolvedValue(hw)
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>)
}

describe('SettingsPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('zeigt im Abo-Modus weder Key- noch Modellfeld', async () => {
    zeige()
    expect(await screen.findByText(/Nutzt das Abo/)).toBeInTheDocument()
    expect(screen.queryByText('API-Key')).not.toBeInTheDocument()
  })

  it('zeigt einen gespeicherten Key nie im Klartext', async () => {
    // has_key=true ist alles, was das Frontend erfaehrt — der Key selbst kommt nie ueber die API.
    const { container } = zeige({ provider: 'anthropic', model: 'claude-opus-5', has_key: true })
    const feld = await screen.findByPlaceholderText(/gespeichert/)
    expect(feld).toHaveAttribute('type', 'password')
    expect((feld as HTMLInputElement).value).toBe('')
    expect(container.textContent).not.toMatch(/sk-/)
  })

  it('speichert einen neuen Key und leert danach das Feld', async () => {
    vi.mocked(api.saveSettings).mockResolvedValue({ ...BASIS, provider: 'anthropic', has_key: true })
    zeige({ provider: 'anthropic' })
    const feld = await screen.findByPlaceholderText('sk-…')
    await act(async () => { fireEvent.change(feld, { target: { value: 'sk-neu' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Key speichern/ })) })
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ api_key: 'sk-neu' }))
    expect((feld as HTMLInputElement).value).toBe('')
  })

  it('holt die Modellliste erst auf Klick beim Anbieter', async () => {
    vi.mocked(api.listModels).mockResolvedValue([{ id: 'claude-opus-5', label: 'Claude Opus 5' }])
    zeige({ provider: 'anthropic', has_key: true })
    await screen.findByText('Modell')
    expect(api.listModels).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByTitle(/Modelle vom Anbieter laden/)) })
    await waitFor(() => expect(api.listModels).toHaveBeenCalled())
  })

  it('zeigt die Whisper-Qualitätsstufe und das aktive Gerät', async () => {
    zeige()
    expect(await screen.findByText(/Qualität der Transkription/i)).toBeInTheDocument()
    expect(await screen.findByText(/NVIDIA RTX 5080/)).toBeInTheDocument()
  })

  it('warnt, wenn kein KI-Anbieter nutzbar ist', async () => {
    zeige({ ai_ready: false, ai_reason: 'Claude Code ist auf diesem Rechner nicht installiert.' })
    expect(await screen.findByText(/nicht installiert/)).toBeInTheDocument()
  })

  it('warnt bei large-v3 auf der CPU', async () => {
    zeige({ whisper_model: 'large-v3' }, { device: 'cpu', name: 'CPU', torch_ok: true })
    expect(await screen.findByText(/auf der CPU sehr lange/i)).toBeInTheDocument()
  })

  it('nennt bei fehlendem PyTorch die Umgebung statt CUDA', async () => {
    // "Rechnet auf: PyTorch nicht installiert" plus CUDA-Hinweis war die falsche Fährte.
    zeige({}, { device: 'cpu', name: 'PyTorch nicht installiert', torch_ok: false })
    expect(await screen.findByText(/Umgebung ist unvollständig/)).toBeInTheDocument()
    expect(screen.queryByText(/NVIDIA-Grafikkarte/)).not.toBeInTheDocument()
  })

  it('zeigt keine CPU-Warnung, wenn eine GPU rechnet', async () => {
    zeige({ whisper_model: 'large-v3' })
    await screen.findByText(/NVIDIA RTX 5080/)
    expect(screen.queryByText(/auf der CPU sehr lange/i)).not.toBeInTheDocument()
  })
})

function zeigeMit(zustand: UpdateZustand | null) {
  vi.mocked(useUpdate).mockReturnValue({
    zustand, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(),
  })
  // SettingsPage zeigt bis zum Laden von getSettings nur "Lädt…" und braucht wegen <Link> einen Router —
  // beides gibt der Brief nicht her, ohne das wuerde jeder Test hier auf "Lädt…" haengen bleiben.
  vi.mocked(api.getSettings).mockResolvedValue(BASIS)
  vi.mocked(api.getHardware).mockResolvedValue({ device: 'cuda', name: 'NVIDIA RTX 5080', torch_ok: true })
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>)
}

describe('Abschnitt Version und Updates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ohne Electron erscheint der Abschnitt gar nicht', async () => {
    zeigeMit(null)
    await screen.findByText(/Qualität der Transkription/i)
    expect(screen.queryByText(/Version und Updates/)).toBeNull()
  })

  it('zeigt die laufende Version', async () => {
    zeigeMit({ version: '0.2.1', art: 'aktuell' })
    expect(await screen.findByText(/0\.2\.1/)).toBeTruthy()
    expect(screen.getByText(/aktuell/)).toBeTruthy()
  })

  it('vor der ersten Pruefung nur Version und Knopf, kein "aktuell"', async () => {
    zeigeMit({ version: '0.2.1', art: 'unbekannt' })
    expect(await screen.findByRole('button', { name: /Nach Updates suchen/ })).toBeTruthy()
    expect(screen.queryByText(/aktuell/)).toBeNull()   // sonst behauptet die Seite Wissen, das sie nicht hat
  })

  it('bietet den Download mit Groesse an', async () => {
    zeigeMit({ version: '0.2.1', art: 'verfuegbar', neue: '0.3.0', groesse: 98566144 })
    expect(await screen.findByText(/0\.3\.0 verfügbar/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Herunterladen \(94 MB\)/ })).toBeTruthy()
  })

  it('zeigt beim Laden Prozent, MB und Tempo', async () => {
    zeigeMit({ version: '0.2.1', art: 'laedt', prozent: 43.2, geladen: 41 * 1048576, gesamt: 94 * 1048576, tempo: 6.2 * 1048576 })
    expect(await screen.findByText(/43 %/)).toBeTruthy()
    expect(screen.getByText(/41 von 94 MB/)).toBeTruthy()
    expect(screen.getByText(/6,2 MB\/s/)).toBeTruthy()
  })

  it('bietet nach dem Laden den Neustart an', async () => {
    zeigeMit({ version: '0.2.1', art: 'bereit', neue: '0.3.0' })
    expect(await screen.findByRole('button', { name: /Neu starten und installieren/ })).toBeTruthy()
  })

  it('macht aus dem Code einen deutschen Satz, samt Link', async () => {
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'darwin' })
    expect(await screen.findByText(/nicht notarisiert/)).toBeTruthy()
    expect(screen.getByText(/möglich/)).toBeTruthy()          // mit Umlaut, nicht "moeglich"
    expect(screen.getByRole('link', { name: /Versionen/ })).toBeTruthy()
  })

  it('kennt auch die beiden anderen Gruende', async () => {
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'entwicklung' })
    expect(await screen.findByText(/Entwicklungsmodus/)).toBeTruthy()
    cleanup()
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'kein-appimage' })
    expect(await screen.findByText(/AppImage/)).toBeTruthy()
  })

  it('zeigt einen Fehler samt Weg zum Protokoll', async () => {
    zeigeMit({ version: '0.2.1', art: 'fehler', text: '404 releases.atom' })
    expect(await screen.findByText(/404 releases\.atom/)).toBeTruthy()
  })

  it('sperrt den Knopf waehrend der Pruefung', async () => {
    zeigeMit({ version: '0.2.1', art: 'prueft' })
    expect((await screen.findByRole('button', { name: /Wird geprüft/ })).hasAttribute('disabled')).toBe(true)
  })
})
