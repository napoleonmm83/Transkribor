import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UrlFetch } from './UrlFetch'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('UrlFetch', () => {
  it('schickt mehrere Zeilen als URL-Liste und meldet den Start', async () => {
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    const onStart = vi.fn()
    render(<UrlFetch project="Demo" onStart={onStart} />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), {
      target: { value: 'https://youtu.be/a\n\n  https://www.instagram.com/reel/b/  \n' },
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', ['https://youtu.be/a', 'https://www.instagram.com/reel/b/']))  // Leerzeilen raus, getrimmt
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ job_id: 'j1', started: true }))
  })

  it('zeigt die Serverbegruendung und ruft onStart nicht', async () => {
    vi.mocked(api.fetchUrls).mockRejectedValue(new Error('nicht unterstützte Plattform: vimeo.com'))
    const onStart = vi.fn()
    render(<UrlFetch project="Demo" onStart={onStart} />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), { target: { value: 'https://vimeo.com/1' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    await waitFor(() => expect(screen.getByText(/nicht unterstützte Plattform/)).toBeInTheDocument())
    expect(onStart).not.toHaveBeenCalled()
  })

  it('behaelt die URLs, wenn schon ein Job laeuft', async () => {
    // started:false heisst "nicht gestartet" -> die Eingabe darf nicht verloren gehen,
    // sonst muss Marcus alle URLs neu eintippen, nur um es gleich noch mal zu versuchen.
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j9', started: false })
    render(<UrlFetch project="Demo" onStart={vi.fn()} />)
    const feld = screen.getByLabelText('Video-URLs')
    fireEvent.change(feld, { target: { value: 'https://youtu.be/a' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    expect(feld).toHaveValue('https://youtu.be/a')
  })

  it('bleibt ohne Eingabe untaetig', () => {
    render(<UrlFetch project="Demo" onStart={vi.fn()} />)
    expect(screen.getByRole('button', { name: /holen/i })).toBeDisabled()
  })
})
