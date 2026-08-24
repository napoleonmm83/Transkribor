import { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ProjektDatenProvider } from './useProjektDaten'
import { JobProvider, useActiveJob } from './useActiveJob'
import { fensterTitel, useDokumentTitel } from './useDokumentTitel'
import * as api from '@/lib/api'

vi.mock('@/lib/api')
function Probe() { useDokumentTitel(); return null }
function zeigen(pfad: string) {
  render(
    <MemoryRouter initialEntries={[pfad]}>
      <JobProvider><ProjektDatenProvider><Probe /></ProjektDatenProvider></JobProvider>
    </MemoryRouter>,
  )
}

describe('useDokumentTitel', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: [] })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: [] })
  })

  it('nennt nur die App auf der Startseite', async () => {
    zeigen('/')
    await waitFor(() => expect(document.title).toBe('Transkribor'))
  })

  it('nennt das Projekt', async () => {
    zeigen('/p/Alpha')
    await waitFor(() => expect(document.title).toBe('Alpha — Transkribor'))
  })

  it('nennt Projekt und Datei im Editor', async () => {
    zeigen('/p/Alpha/audio_02')
    await waitFor(() => expect(document.title).toBe('Alpha · audio_02 — Transkribor'))
  })

  it('zeigt KIND_LABEL-Fallback, wenn Job läuft aber Phasen noch leer sind', async () => {
    function JobProbe() {
      const { adopt } = useActiveJob()
      useEffect(() => { adopt('job-1', 'Alpha', 'transcribe') }, [adopt])
      useDokumentTitel()
      return null
    }
    render(
      <MemoryRouter initialEntries={['/p/Alpha']}>
        <JobProvider><ProjektDatenProvider><JobProbe /></ProjektDatenProvider></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(document.title).toBe('Transkribieren… — Alpha — Transkribor'))
  })
})

describe('fensterTitel', () => {
  it('stellt den Laufzustand VOR den Ort', () => {
    // Taskleiste und Alt-Tab zeigen nur die ersten Zeichen -- "laeuft es noch?" muss
    // dort stehen, nicht der Projektname.
    expect(fensterTitel('Alpha · audio_02', 'Korrigiere audio_02 · 38%'))
      .toBe('Korrigiere audio_02 · 38% — Alpha · audio_02 — Transkribor')
  })
  it('laesst leere Teile weg statt Trennzeichen zu haeufen', () => {
    expect(fensterTitel('Alpha', '')).toBe('Alpha — Transkribor')
    expect(fensterTitel('', '')).toBe('Transkribor')
  })
})
