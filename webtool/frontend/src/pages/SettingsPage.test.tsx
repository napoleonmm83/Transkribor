import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'
import * as api from '@/lib/api'
import type { Hardware, Settings } from '@/lib/types'

vi.mock('@/lib/api')

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

  it('zeigt keine CPU-Warnung, wenn eine GPU rechnet', async () => {
    zeige({ whisper_model: 'large-v3' })
    await screen.findByText(/NVIDIA RTX 5080/)
    expect(screen.queryByText(/auf der CPU sehr lange/i)).not.toBeInTheDocument()
  })
})
