import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UploadDropzone } from './UploadDropzone'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('UploadDropzone', () => {
  it('laedt nur Audio hoch und meldet Duplikate', async () => {
    vi.mocked(api.uploadAudio)
      .mockResolvedValueOnce({ base: 'a', file: 'a.mp3' })
      .mockRejectedValueOnce(new Error('Datei existiert bereits'))
    const onDone = vi.fn()
    render(<UploadDropzone project="Demo" onDone={onDone} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    const files = [new File(['x'], 'a.mp3'), new File(['y'], 'b.txt'), new File(['z'], 'c.wav')]
    await act(async () => { fireEvent.change(input, { target: { files } }) })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledTimes(2)) // b.txt gefiltert
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(screen.getByText(/existiert bereits/)).toBeInTheDocument()
  })

  it('nennt einen Grund, auch wenn der Fehler keine Meldung traegt', async () => {
    // `?? 'Fehler'` griff hier nicht: eine leere message ist nicht null. Uebrig blieb ein
    // Warndreieck ohne Text — der Nutzer sieht, dass etwas schieflief, aber nicht was.
    vi.mocked(api.uploadAudio).mockRejectedValueOnce(new Error(''))
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } }) })
    expect(await screen.findByText('Fehler')).toBeInTheDocument()
  })

  it('reicht den vom Upload gestarteten Transkriptions-Job nach oben', async () => {
    // Ohne das muesste der Workspace bis zum naechsten Poll warten, bis der Balken erscheint.
    vi.mocked(api.uploadAudio)
      .mockResolvedValueOnce({ base: 'a', file: 'a.mp3', job_id: 'j7', started: true })
      .mockResolvedValueOnce({ base: 'c', file: 'c.wav', job_id: 'j7', started: false })
    const onDone = vi.fn()
    render(<UploadDropzone project="Demo" onDone={onDone} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    const files = [new File(['x'], 'a.mp3'), new File(['z'], 'c.wav')]
    await act(async () => { fireEvent.change(input, { target: { files } }) })
    // zuletzt gemeldeter Stand gewinnt: der zweite Upload lief in denselben, schon laufenden Job
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ job_id: 'j7', started: false }))
  })

  it('bringt KEINE eigene Sprachauswahl mit', () => {
    /* Die Auswahl steht genau einmal im Bereich „Material hinzufügen" (ProjectWorkspace).
       Ein zweiter Waehler hier zeigte denselben Wert ein zweites Mal an — genau der Zustand,
       den diese Aenderung abgeschafft hat. */
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    expect(document.body.querySelector('[role="combobox"]')).toBeNull()
    expect(screen.queryByText(/Enthält weitere Sprachen/)).not.toBeInTheDocument()
  })

  it('reicht Sprache und Mehrsprachig-Haken ans uploadAudio weiter', async () => {
    /* VOR dem Upload, nicht danach: der Transkriptions-Job startet serverseitig sofort mit
       dem Upload. Nachtraeglich gesetzt kostet beides einen kompletten zweiten Lauf. */
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="en" mehrsprachig />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith(
      'Demo', expect.any(File), 'en', true))
  })
})

describe('UploadDropzone — Degradierung ohne geladene Einstellungen', () => {
  it('schickt ohne mehrsprachig-Requisite KEIN mehrsprachig mit', async () => {
    /* Der GET auf die Projekt-Einstellungen kann fehlschlagen (ProjectWorkspace schluckt den
       Fehler). Dann wird die Auswahl gar nicht gerendert, und der Aufrufer reicht `undefined`
       durch — ein hartes `false` wuerde einen auf true stehenden Projekt-Standard
       ueberschreiben, ohne dass der Nutzer je ein Kaestchen gesehen haette. Hier wird nur
       gehalten, dass nichts erfunden wird; die Entscheidung selbst prueft ProjectWorkspace. */
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    render(<UploadDropzone project="Demo" onDone={vi.fn()} />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith(
      'Demo', expect.any(File), '', undefined))
  })
})
