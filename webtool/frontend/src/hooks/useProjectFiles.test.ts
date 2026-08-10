import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useProjectFiles } from './useProjectFiles'
import * as api from '@/lib/api'
import type { ProjectFile } from '@/lib/types'

vi.mock('@/lib/api')

const datei: ProjectFile = { base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }

describe('useProjectFiles', () => {
  beforeEach(() => vi.clearAllMocks())

  it('laedt die Dateien ueber GET /api/projects/{project}', async () => {
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [datei] })
    const { result } = renderHook(() => useProjectFiles('Demo'))
    await waitFor(() => expect(result.current.files).toEqual([datei]))
    expect(api.getProjectFiles).toHaveBeenCalledWith('Demo')
  })

  it('laesst files leer, wenn die Abfrage scheitert, statt zu werfen', async () => {
    vi.mocked(api.getProjectFiles).mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useProjectFiles('Demo'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.files).toEqual([])
  })

  it('refresh() ruft den Endpunkt erneut', async () => {
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [datei] })
    const { result } = renderHook(() => useProjectFiles('Demo'))
    await waitFor(() => expect(api.getProjectFiles).toHaveBeenCalledTimes(1))
    await act(async () => { result.current.refresh() })
    await waitFor(() => expect(api.getProjectFiles).toHaveBeenCalledTimes(2))
  })
})
