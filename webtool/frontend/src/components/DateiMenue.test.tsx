import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DateiMenue } from './DateiMenue'
import { Huelle } from '@/lib/testHuelle'
import * as api from '@/lib/api'
import type { ProjectFile } from '@/lib/types'

vi.mock('@/lib/api')

const datei = (p: Partial<ProjectFile> = {}): ProjectFile =>
  ({ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...p })

/** Radix oeffnet das Menue nur auf einen echten Zeigerklick — `click` allein reicht nicht. */
const menueOeffnen = async () => {
  fireEvent.pointerDown(screen.getByRole('button', { name: /Aktionen für/ }),
    { button: 0, ctrlKey: false, pointerType: 'mouse' })
  return screen.findByRole('menu')
}

const zeigen = (file: ProjectFile, pfad?: string) =>
  render(<Huelle pfad={pfad}><DateiMenue project="P" file={file} /></Huelle>)

beforeEach(() => {
  // Ohne clearAllMocks zaehlt der Abbrechen-Test die Aufrufe des Tests davor mit und
  // ist gruen, egal was er tut — die Aufrufzahl ist hier die ganze Aussage.
  vi.clearAllMocks()
  // Die Huelle bringt den echten ProjektDatenProvider mit: der pollt beim Aufsetzen,
  // und ein automock-`undefined` statt eines Promise reisst jeden Test um.
  vi.mocked(api.listProjects).mockResolvedValue([])
  vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'P', files: [] })
  vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [] })
  vi.mocked(api.startCorrectFile).mockResolvedValue({ job_id: '1', started: true })
  vi.mocked(api.startRetranscribeFile).mockResolvedValue({ job_id: '2', started: true })
  vi.mocked(api.deleteFile).mockResolvedValue(undefined)
})

describe('Korrigieren', () => {
  it('fragt bei vorhandener Fassung nach und schickt dann force=true', async () => {
    // Der eigentliche Auslöser dieser Zusammenlegung: die Arbeitsfläche schickte immer
    // force=false, womit der Server eine handbearbeitete Datei still übersprang.
    zeigen(datei({ has_edit: true }))
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Neu korrigieren'))
    expect(await screen.findByText(/neu korrigieren\?/)).toBeInTheDocument()
    expect(api.startCorrectFile).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Neu korrigieren' }))
    await waitFor(() => expect(api.startCorrectFile).toHaveBeenCalledWith('P', 'a', true))
  })

  it('startet ohne Rückfrage, wenn es noch keine Fassung gibt', async () => {
    zeigen(datei({ has_edit: false }))
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Korrigieren'))
    await waitFor(() => expect(api.startCorrectFile).toHaveBeenCalledWith('P', 'a', false))
  })

  it('ist ohne KI-Anbieter gesperrt', async () => {
    render(<Huelle><DateiMenue project="P" file={datei()} aiReason="Kein API-Key hinterlegt." /></Huelle>)
    await menueOeffnen()
    expect(await screen.findByText('Korrigieren')).toHaveAttribute('data-disabled')
  })
})

describe('Neu transkribieren', () => {
  it('fragt nach und startet dann den Lauf', async () => {
    zeigen(datei({ has_raw: true }))
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Neu transkribieren'))
    expect(await screen.findByText(/Verwirft Transkript/)).toBeInTheDocument()
    expect(api.startRetranscribeFile).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Neu transkribieren' }))
    await waitFor(() => expect(api.startRetranscribeFile).toHaveBeenCalledWith('P', 'a'))
  })

  it('ist ohne Audio gesperrt — es gäbe keine Quelle, aus der neu gelesen werden könnte', async () => {
    zeigen(datei({ has_audio: false }))
    await menueOeffnen()
    expect(await screen.findByText('Neu transkribieren')).toHaveAttribute('data-disabled')
  })
})

describe('Löschen', () => {
  it('löscht erst nach Bestätigung', async () => {
    zeigen(datei())
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Löschen'))
    expect(await screen.findByText(/unwiderruflich/)).toBeInTheDocument()
    expect(api.deleteFile).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }))
    await waitFor(() => expect(api.deleteFile).toHaveBeenCalledWith('P', 'a'))
  })

  it('macht bei Abbrechen nichts', async () => {
    zeigen(datei())
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Löschen'))
    fireEvent.click(await screen.findByRole('button', { name: 'Abbrechen' }))
    await waitFor(() => expect(screen.queryByText(/unwiderruflich/)).not.toBeInTheDocument())
    expect(api.deleteFile).not.toHaveBeenCalled()
  })
})
