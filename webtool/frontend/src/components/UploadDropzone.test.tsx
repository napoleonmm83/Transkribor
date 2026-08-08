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
    render(<UploadDropzone project="Demo" onDone={onDone} />)
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
    render(<UploadDropzone project="Demo" onDone={vi.fn()} />)
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
    render(<UploadDropzone project="Demo" onDone={onDone} />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    const files = [new File(['x'], 'a.mp3'), new File(['z'], 'c.wav')]
    await act(async () => { fireEvent.change(input, { target: { files } }) })
    // zuletzt gemeldeter Stand gewinnt: der zweite Upload lief in denselben, schon laufenden Job
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ job_id: 'j7', started: false }))
  })
})
