import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

function zeigen() {
  return render(<JobProvider><StatusBar /></JobProvider>)
}

describe('StatusBar', () => {
  beforeEach(() => vi.resetAllMocks())

  it('sagt "Bereit", wenn nichts laeuft', async () => {
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cuda', name: 'RTX 5080', torch_ok: true, asr: 'cuda' })
    zeigen()
    expect(screen.getByText('Bereit')).toBeInTheDocument()
  })

  it('nennt das Rechenwerk aus /api/hardware', async () => {
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cuda', name: 'RTX 5080', torch_ok: true, asr: 'cuda' })
    zeigen()
    await waitFor(() => expect(screen.getByText('cuda')).toBeInTheDocument())
  })

  it('bleibt stehen, wenn /api/hardware nicht antwortet', async () => {
    // Eine Statuszeile, die bei einer fehlenden Nebeninformation die App abschiesst, ist
    // schlimmer als eine, die das Feld leer laesst.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    zeigen()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Bereit')).toBeInTheDocument()
  })
})
