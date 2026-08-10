import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useDoc } from './useDoc'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import type { EditDoc } from '@/lib/types'

vi.mock('@/lib/api')
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const doc: EditDoc = {
  base: 'b', project: 'P', audio: 'a.wav', language: 'de',
  human_edited: false, context: '', speakers: [], segments: [], annotations: [],
}

describe('useDoc Speichern/Export-Fehler', () => {
  it('zeigt einen Toast statt einen unhandled rejection bei fehlgeschlagenem save()', async () => {
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    vi.mocked(api.saveDoc).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useDoc('P', 'b'))
    await waitFor(() => expect(result.current.doc).toEqual(doc))

    await act(async () => { await result.current.save() })

    expect(toast.error).toHaveBeenCalledWith('Speichern fehlgeschlagen: boom')
  })

  it('zeigt einen Toast statt einen unhandled rejection bei fehlgeschlagenem exportDownload()', async () => {
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    vi.mocked(api.exportText).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useDoc('P', 'b'))
    await waitFor(() => expect(result.current.doc).toEqual(doc))

    await act(async () => { await result.current.exportDownload('srt') })

    expect(toast.error).toHaveBeenCalledWith('Export fehlgeschlagen: boom')
  })
})
