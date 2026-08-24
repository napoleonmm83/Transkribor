import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProjektMenue } from './ProjektMenue'
import { Huelle } from '@/lib/testHuelle'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

const BASIS = {
  sprache: 'ch', korrektur: 'auto', mehrsprachig: false, sprecher_max: 20,
  sprach_choices: [
    { id: 'ch', label: 'Schweizerdeutsch', hint: '' , dialekt: true },
    { id: 'en', label: 'Englisch', hint: '' , dialekt: false },
  ],
  tiefen: [{ id: 'voll_dialekt', label: 'Voll' }, { id: 'leicht', label: 'Leicht' , dialekt: false }],
}

/** Radix oeffnet das Menue nur auf einen echten Zeigerklick — `click` allein reicht nicht
 *  (gleicher Grund wie in DateiMenue.test). */
const menueOeffnen = async () => {
  fireEvent.pointerDown(screen.getByRole('button', { name: /Aktionen für/ }),
    { button: 0, ctrlKey: false, pointerType: 'mouse' })
  return screen.findByRole('menu')
}

beforeEach(() => {
  vi.clearAllMocks()
  // Huelle bringt den echten ProjektDatenProvider mit: der pollt beim Aufsetzen.
  vi.mocked(api.listProjects).mockResolvedValue([])
  vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Demo', files: [] })
  vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [] })
  vi.mocked(api.getProjektEinstellungen).mockResolvedValue(BASIS)
})

describe('ProjektMenue', () => {
  it('öffnet „Sprache & Korrektur" aus dem ⋯-Menü und lädt die Einstellungen', async () => {
    render(<Huelle><ProjektMenue project="Demo" onUmbenannt={() => {}} onGeloescht={() => {}} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sprache & Korrektur/ }))
    await waitFor(() => expect(screen.getByText('Projekt-Einstellungen')).toBeInTheDocument())
    expect(api.getProjektEinstellungen).toHaveBeenCalledWith('Demo')
  })

  it('öffnet Umbenennen weiterhin (keine Regression durch den neuen Eintrag)', async () => {
    render(<Huelle><ProjektMenue project="Demo" onUmbenannt={() => {}} onGeloescht={() => {}} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Umbenennen/ }))
    await waitFor(() => expect(screen.getByText('Projekt umbenennen')).toBeInTheDocument())
  })

  it('öffnet Löschen weiterhin (keine Regression durch den neuen Eintrag)', async () => {
    render(<Huelle><ProjektMenue project="Demo" onUmbenannt={() => {}} onGeloescht={() => {}} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Löschen/ }))
    await waitFor(() => expect(screen.getByText(/unwiderruflich/)).toBeInTheDocument())
  })

  it('führt „Markdown in Downloads ablegen" aus', async () => {
    vi.mocked(api.exportProjectMarkdownToDownloads).mockResolvedValue({
      ok: true, ziel: '/Users/test/Downloads/Demo', anzahl: 3, dateien: ['a.md', 'b.md', 'c.md'],
    })
    render(<Huelle><ProjektMenue project="Demo" onUmbenannt={() => {}} onGeloescht={() => {}} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Markdown in Downloads ablegen/ }))
    await waitFor(() => expect(api.exportProjectMarkdownToDownloads).toHaveBeenCalledWith('Demo'))
  })

  it('führt „Markdown als ZIP herunterladen" aus', async () => {
    vi.mocked(api.projectMarkdownZipUrl).mockReturnValue('/api/projects/Demo/export/zip')
    render(<Huelle><ProjektMenue project="Demo" onUmbenannt={() => {}} onGeloescht={() => {}} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Markdown als ZIP herunterladen/ }))
    expect(api.projectMarkdownZipUrl).toHaveBeenCalledWith('Demo')
    expect(api.triggerDownload).toHaveBeenCalledWith('/api/projects/Demo/export/zip', 'Demo_markdown.zip')
  })
})

