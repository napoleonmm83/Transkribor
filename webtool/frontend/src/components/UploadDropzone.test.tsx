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
})
