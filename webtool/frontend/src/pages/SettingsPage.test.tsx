import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'
import * as api from '@/lib/api'
import type { Settings } from '@/lib/types'

vi.mock('@/lib/api')

const BASIS: Settings = {
  provider: 'claude-cli', model: '', base_url: '', has_key: false, env_key: '',
  providers: [
    { id: 'claude-cli', label: 'Claude Code Abo (kein Key)', needs_key: false, base: '', default_model: '', keys_url: '', hint: 'Nutzt das Abo.' },
    { id: 'anthropic', label: 'Anthropic (Claude)', needs_key: true, base: 'https://api.anthropic.com/v1', default_model: 'claude-opus-5', keys_url: 'https://x', hint: '' },
  ],
}

const zeige = (s: Partial<Settings> = {}) => {
  vi.mocked(api.getSettings).mockResolvedValue({ ...BASIS, ...s })
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Speichern/ })) })
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
})
