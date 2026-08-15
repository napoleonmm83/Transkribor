import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UrlFetch } from './UrlFetch'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('UrlFetch', () => {
  it('schickt mehrere Zeilen als URL-Liste und meldet den Start', async () => {
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    const onStart = vi.fn()
    render(<UrlFetch project="Demo" onStart={onStart} sprache="de" />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), {
      target: { value: 'https://youtu.be/a\n\n  https://www.instagram.com/reel/b/  \n' },
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', ['https://youtu.be/a', 'https://www.instagram.com/reel/b/'], 'de', undefined))  // Leerzeilen raus, getrimmt
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ job_id: 'j1', started: true }))
  })

  it('zeigt die Serverbegruendung und ruft onStart nicht', async () => {
    vi.mocked(api.fetchUrls).mockRejectedValue(new Error('nicht unterstützte Plattform: vimeo.com'))
    const onStart = vi.fn()
    render(<UrlFetch project="Demo" onStart={onStart} sprache="de" />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), { target: { value: 'https://vimeo.com/1' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    await waitFor(() => expect(screen.getByText(/nicht unterstützte Plattform/)).toBeInTheDocument())
    expect(onStart).not.toHaveBeenCalled()
  })

  it('behaelt die URLs, wenn schon ein Job laeuft', async () => {
    // started:false heisst "nicht gestartet" -> die Eingabe darf nicht verloren gehen,
    // sonst muss Marcus alle URLs neu eintippen, nur um es gleich noch mal zu versuchen.
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j9', started: false })
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="de" />)
    const feld = screen.getByLabelText('Video-URLs')
    fireEvent.change(feld, { target: { value: 'https://youtu.be/a' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    expect(feld).toHaveValue('https://youtu.be/a')
  })

  it('bleibt ohne Eingabe untaetig', () => {
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="de" />)
    expect(screen.getByRole('button', { name: /holen/i })).toBeDisabled()
  })

  it('bringt KEINE eigene Sprachauswahl mit', () => {
    /* Die Auswahl steht genau einmal im Bereich „Material hinzufügen" (ProjectWorkspace) und
       gilt fuer Upload UND URL-Import. ZWEI Einschraenkungen, damit dieser Test nicht mehr
       verspricht, als er haelt: er faengt nur einen BEDINGUNGSLOSEN Wiedereinbau, und seine
       Positivkontrolle liegt im Integrationstest (`getAllByRole('combobox')).toHaveLength(1)`
       in ProjectWorkspace.test.tsx) — der haelt die Zahl, dieser hier die Zustaendigkeit. */
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="de" />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Enthält weitere Sprachen/)).not.toBeInTheDocument()
  })

  it('reicht Sprache und Mehrsprachig-Haken ans fetchUrls weiter', async () => {
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="en" mehrsprachig />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), { target: { value: 'https://youtu.be/a' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith('Demo', ['https://youtu.be/a'], 'en', true))
  })
})
