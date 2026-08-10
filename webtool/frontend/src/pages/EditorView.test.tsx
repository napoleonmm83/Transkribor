import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { EditorView } from './EditorView'
import { JobProvider } from '@/hooks/useActiveJob'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as api from '@/lib/api'
import type { Settings, EditDoc } from '@/lib/types'

vi.mock('@/lib/api')
// Wavesurfer braucht Audio-Decoding, das jsdom nicht kann — fuer diese Tests reicht die
// Datenverdrahtung, nicht die Wellenform selbst.
vi.mock('@/components/Waveform', () => ({ Waveform: () => null }))

const einstellungen = (s: Partial<Settings>) =>
  vi.mocked(api.getSettings).mockResolvedValue({ ai_ready: true, ai_reason: '', ...s } as Settings)

const doc: EditDoc = {
  base: 'S1', project: 'Demo', audio: 'a.wav', language: 'de',
  human_edited: false, context: '', speakers: [], segments: [], annotations: [],
}

describe('EditorView (Stub)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    einstellungen({})
    vi.mocked(api.getDoc).mockResolvedValue(doc)
  })

  it('holt die Dateien ueber GET /api/projects/{project}, nicht aus projects[].files', async () => {
    // Project fuehrt seit Task 3 gar kein files mehr -- wuerde die Seite noch p.files lesen,
    // bliebe die Sidebar leer und der Test faende 'S1' nicht.
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [] }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
      files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }] })
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={['/p/Demo/S1']}>
          <JobProvider>
            <Routes><Route path="/p/:project/:base" element={<EditorView />} /></Routes>
          </JobProvider>
        </MemoryRouter>
      </TooltipProvider>,
    )
    expect(await screen.findByText('S1')).toBeInTheDocument()
    expect(api.getProjectFiles).toHaveBeenCalledWith('Demo')
  })

  it('holt die Dateien neu, wenn ein FREMD gestarteter Job fertig wird', async () => {
    // Der Job kommt ueber active_jobs (Discovery), nicht ueber einen Editor-Knopf -- genau der
    // Fall, den EditorViews eigene onDone-Callbacks (useJob) nicht abdecken.
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', dateien: 0, fertig: 0, geaendert: 0, active_jobs: [{ id: 'j1', kind: 'correct' }] },
    ])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo',
      files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }] })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [] })
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={['/p/Demo/S1']}>
          <JobProvider intervalMs={5}>
            <Routes><Route path="/p/:project/:base" element={<EditorView />} /></Routes>
          </JobProvider>
        </MemoryRouter>
      </TooltipProvider>,
    )
    await waitFor(() => expect(api.getProjectFiles).toHaveBeenCalledTimes(1))
    // j1 wird adoptiert, JobProvider pollt getJob -> 'done' -> onSettled muss refreshFiles() ausloesen.
    await waitFor(() => expect(api.getProjectFiles.mock.calls.length).toBeGreaterThan(1))
  })
})
