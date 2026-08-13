import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAiReady } from './useAiReady'
import * as api from '@/lib/api'
import type { Settings } from '@/lib/types'

vi.mock('@/lib/api')

const BASIS = {
  provider: 'claude-cli', model: '', base_url: '', has_key: false,
  env_key: '', whisper_model: 'large-v3', whisper_lang: 'de', whisper_choices: [],
  providers: [], ai_ready: true, ai_reason: '',
  ytdlp_auto: '1', ytdlp: { version: '2026.8.12', geprueft: '', auto: true, env: false },
} as Settings

describe('useAiReady', () => {
  beforeEach(() => vi.clearAllMocks())

  it('meldet den Grund mit Verweis auf die Einstellungen', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(
      { ...BASIS, ai_ready: false, ai_reason: 'Kein API-Key hinterlegt.' })
    const { result } = renderHook(() => useAiReady())
    await waitFor(() => expect(result.current).toMatch(/Kein API-Key/))
    expect(result.current).toMatch(/Einstellungen/)
  })

  it('sperrt nichts, wenn ein Anbieter da ist', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(BASIS)
    const { result } = renderHook(() => useAiReady())
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled())
    expect(result.current).toBe('')
  })

  it('sperrt auch nichts, wenn die Abfrage scheitert', async () => {
    // Eine Oberflaeche, die sich wegen eines Netzwerkfehlers selbst abschaltet, waere
    // schlimmer als ein Job, der etwas sagt.
    vi.mocked(api.getSettings).mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useAiReady())
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled())
    expect(result.current).toBe('')
  })
})
