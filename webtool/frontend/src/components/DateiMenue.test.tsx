import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { DateiMenue } from './DateiMenue'
import { Huelle } from '@/lib/testHuelle'
import { useEditorMelden } from '@/hooks/useEditorBruecke'
import * as api from '@/lib/api'
import type { ProjectFile } from '@/lib/types'

vi.mock('@/lib/api')

const datei = (p: Partial<ProjectFile> = {}): ProjectFile =>
  ({ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...p })

/** Setzt editor.current auf „Datei a ist offen" — mit einem vergiss-Spy. Spielt den Editor, ohne
 *  useDoc und Server (die Huelle bringt den EditorBrueckeProvider mit). */
function OffeneDatei({ vergiss }: { vergiss: () => void }) {
  useEditorMelden({ project: 'P', base: 'a', dirty: true, stand: 'offen', reload: () => {}, vergiss })
  return null
}

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
  vi.mocked(api.getFileEinstellungen).mockResolvedValue({
    sprache: 'ch', korrektur: 'auto', mehrsprachig: false,
    sprache_eigen: null, sprache_projekt: 'ch',       // erbt beides (#234)
    mehrsprachig_eigen: null, mehrsprachig_projekt: false,
    sprecher: null, sprecher_max: 20,
    sprach_choices: [{ id: 'ch', label: 'Schweizerdeutsch', hint: '' }, { id: 'en', label: 'Englisch', hint: '' }],
    tiefen: [{ id: 'auto', label: 'Automatisch (aus Sprache)' }, { id: 'voll_dialekt', label: 'Voll' }, { id: 'leicht', label: 'Leicht' }],
  })
  vi.mocked(api.saveFileEinstellungen).mockResolvedValue({
    sprache: 'ch', korrektur: 'auto', mehrsprachig: false,
  })
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

  it('hängt den Grund der Sperre an ein hoverbares Element, nicht an den gesperrten Eintrag', async () => {
    // Ein gesperrter Eintrag traegt pointer-events:none und zeigt seinen eigenen Tooltip nie
    // an — der Hinweis waere unsichtbar. Der Test faellt, sobald jemand den title zurueck an
    // den Eintrag schiebt.
    zeigen(datei({ has_audio: false }))
    await menueOeffnen()
    const hinweis = await screen.findByTitle('Kein Audio vorhanden')
    expect(hinweis).not.toHaveAttribute('data-disabled')
    expect(hinweis).toContainElement(screen.getByRole('menuitem', { name: 'Neu transkribieren' }))
  })

  it('verlässt den Editor nicht, wenn der Start abgelehnt wird', async () => {
    // 409 heisst: es wurde nichts verworfen. Wer trotzdem aus dem Editor fliegt, verliert
    // seinen Platz im Transkript fuer nichts.
    vi.mocked(api.startRetranscribeFile).mockRejectedValue(new Error('Job läuft — erst abbrechen'))
    render(<Huelle pfad="/p/P/a"><DateiMenue project="P" file={datei()} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Neu transkribieren'))
    fireEvent.click(screen.getByRole('button', { name: 'Neu transkribieren' }))
    await waitFor(() => expect(api.startRetranscribeFile).toHaveBeenCalled())
    expect(screen.getByTestId('ort')).toHaveTextContent('/p/P/a')
  })

  it('verlässt den Editor, wenn der Lauf angenommen wurde', async () => {
    // Gegenprobe zum Test darueber: hier IST das Transkript verworfen, der Editor haelt ein
    // Dokument, das es nicht mehr gibt — und "Speichern" schriebe es zurueck.
    render(<Huelle pfad="/p/P/a"><DateiMenue project="P" file={datei()} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Neu transkribieren'))
    fireEvent.click(screen.getByRole('button', { name: 'Neu transkribieren' }))
    await waitFor(() => expect(screen.getByTestId('ort')).toHaveTextContent('/p/P'))
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

  it('verwirft die offene Fassung VOR dem Löschen — sonst spült der Verlassens-Flush sie zurück (#106)', async () => {
    // C1: ist DIESE Datei im Editor offen, muss vergiss laufen, BEVOR der Editor sie verlaesst.
    // Sonst legt der Backend-Save die geloeschte Datei neu an. Eine ANDERE offene Datei darf
    // nicht angestastet werden (dafür sitzt die `offen`-Pruefung in editorVergessen).
    const vergiss = vi.fn()
    render(<Huelle pfad="/p/P/a"><OffeneDatei vergiss={vergiss} /><DateiMenue project="P" file={datei()} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Löschen'))
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }))
    await waitFor(() => expect(api.deleteFile).toHaveBeenCalledWith('P', 'a'))
    expect(vergiss).toHaveBeenCalledTimes(1)
  })
})

describe('Sprache, Korrektur & Sprecher', () => {
  const spracheAendern = async () => {
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Sprache, Korrektur & Sprecher'))
    // Der Dialog portalt nach document.body; der sprache-Select ist der erste combobox darin.
    // Gewartet wird auf die ROLLE, nicht auf einen Sprachnamen: seit #234 zeigt der Trigger
    // „Folgt dem Projekt (…)", solange die Datei keinen eigenen Wert hat.
    await screen.findByRole('combobox', { name: 'Sprache' })
    fireEvent.click(document.body.querySelector('[role="combobox"]')!)
    fireEvent.click(await within(await screen.findByRole('listbox')).findByText('Englisch'))
  }

  it('änderte Sprache stößt Neu-Transkription an (und verlässt den Editor)', async () => {
    render(<Huelle pfad="/p/P/a"><DateiMenue project="P" file={datei()} /></Huelle>)
    await spracheAendern()
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(api.saveFileEinstellungen).toHaveBeenCalledWith('P', 'a', expect.objectContaining({ sprache: 'en' })))
    await waitFor(() => expect(api.startRetranscribeFile).toHaveBeenCalledWith('P', 'a'))
    expect(screen.getByTestId('ort')).toHaveTextContent('/p/P')   // Editor verlassen
  })

  it('nur geänderte Tiefe stößt Neu-Korrektur mit force=true an (Editor bleibt)', async () => {
    render(<Huelle pfad="/p/P/a"><DateiMenue project="P" file={datei()} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Sprache, Korrektur & Sprecher'))
    // Readiness über den Sprache-Trigger; der Tiefe-Trigger zeigt bei korrektur='auto' das
    // Auto-Label (seit #141 in TIEFEN enthalten — dasselbe wie beim Projekt-Dialog). Ueber die
    // ROLLE statt ueber den Sprachnamen, siehe `spracheAendern` (#234).
    await screen.findByRole('combobox', { name: 'Sprache' })
    // Ueber den Namen, NICHT ueber "letzter combobox": seit #166 steht die Mehrsprachig-Auswahl
    // dahinter, und der Index zeigte dann still auf das falsche Bedienelement.
    fireEvent.click(screen.getByRole('combobox', { name: /korrektur-tiefe/i }))
    fireEvent.click(await screen.findByText('Leicht'))
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu korrigieren' }))
    await waitFor(() => expect(api.startCorrectFile).toHaveBeenCalledWith('P', 'a', true))
    expect(screen.getByTestId('ort')).toHaveTextContent('/p/P/a')  // Editor bleibt (Korrektur)
  })

  it('ohne has_raw wird nur gespeichert (kein Trigger)', async () => {
    render(<Huelle><DateiMenue project="P" file={datei({ has_raw: false })} /></Huelle>)
    await spracheAendern()
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(api.saveFileEinstellungen).toHaveBeenCalled())
    expect(api.startRetranscribeFile).not.toHaveBeenCalled()
    expect(api.startCorrectFile).not.toHaveBeenCalled()
  })
})
