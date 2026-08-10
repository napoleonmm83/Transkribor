import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useJob } from './useJob'
import { Sidebar } from '@/components/Sidebar'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

const projekte = [{ name: 'P', dateien: 1 }]
const dateien = [{ base: 'a', has_audio: true, has_raw: true, has_edit: true, has_md: true }]

function Harness() {
  const { start } = useJob()
  const onCorrectFile = (project: string, base: string, force: boolean) =>
    start(() => api.startCorrectFile(project, base, force), `Korrigieren ${base}`)
  return <Sidebar projekte={projekte} offen="P" dateien={dateien} onWaehlen={vi.fn()}
    active={null} onOpen={vi.fn()} onUpload={vi.fn()}
    onTranscribe={vi.fn()} onCorrect={vi.fn()} onCorrectFile={onCorrectFile} />
}

describe('Force-Bestätigung bei has_edit', () => {
  it('zeigt AlertDialog und ruft startCorrectFile mit force=true nach Bestätigung', async () => {
    vi.mocked(api.startCorrectFile).mockResolvedValue({ job_id: '1', started: true })
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [] })
    render(<Harness />)

    fireEvent.click(screen.getByTitle('Nur diese Datei korrigieren'))
    expect(await screen.findByText(/neu korrigieren\?/)).toBeInTheDocument()
    expect(api.startCorrectFile).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Neu korrigieren'))
    await waitFor(() => expect(api.startCorrectFile).toHaveBeenCalledWith('P', 'a', true))
  })
})
