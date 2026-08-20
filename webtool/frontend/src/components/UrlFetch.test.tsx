import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UrlFetch } from './UrlFetch'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

// Ohne das teilen sich die Tests die Aufrufliste der Attrappe, und jede
// `not.toHaveBeenCalled`-Zusicherung zaehlt die Aufrufe der Tests davor mit.
beforeEach(() => { vi.clearAllMocks() })

/** „Holen" druecken UND starten.
 *
 *  „Holen" oeffnet seit dem Vorschau-Umbau erst die Zeile je Link mit ihrer Sprecherzahl —
 *  beim URL-Import ist das zwingender als beim Upload, denn die Aufnahme entsteht erst
 *  waehrend des Downloads und kann ihre Zahl unmoeglich vorher tragen. Die Zusicherungen der
 *  Tests darunter sind unveraendert; nur der Ausloeser wandert auf „Holen & starten".
 */
async function holenUndStarten() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^holen$/i })) })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Holen & starten/ }))
  })
}

describe('UrlFetch', () => {
  it('schickt mehrere Zeilen als URL-Liste und meldet den Start', async () => {
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    const onStart = vi.fn()
    render(<UrlFetch project="Demo" onStart={onStart} sprache="de" />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), {
      target: { value: 'https://youtu.be/a\n\n  https://www.instagram.com/reel/b/  \n' },
    })
    await holenUndStarten()
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', ['https://youtu.be/a', 'https://www.instagram.com/reel/b/'], 'de', undefined,
      undefined))  // Leerzeilen raus, getrimmt; ohne Zahl reist keine Liste mit
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ job_id: 'j1', started: true }))
  })

  it('zeigt die Serverbegruendung und ruft onStart nicht', async () => {
    vi.mocked(api.fetchUrls).mockRejectedValue(new Error('nicht unterstützte Plattform: vimeo.com'))
    const onStart = vi.fn()
    render(<UrlFetch project="Demo" onStart={onStart} sprache="de" />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), { target: { value: 'https://vimeo.com/1' } })
    await holenUndStarten()
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
    await holenUndStarten()
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
    await holenUndStarten()
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', ['https://youtu.be/a'], 'en', true, undefined))
  })
})

describe('UrlFetch — Vorschau vor dem Start', () => {
  const zweiUrls = ['https://youtu.be/aaa', 'https://youtu.be/bbb'].join('\n')

  async function holen(wert = zweiUrls) {
    fireEvent.change(screen.getByLabelText('Video-URLs'), { target: { value: wert } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^holen$/i })) })
  }

  it('„Holen" zeigt erst die Vorschau, eine Zeile je URL — und holt NICHTS', async () => {
    /* Beim URL-Import ist die Vorschau zwingender als beim Upload: die Aufnahme entsteht erst
       waehrend des Downloads, ihre Sprecherzahl kann also unmoeglich vorher an ihr stehen. */
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="de" />)
    await holen()
    expect(screen.getByRole('textbox', { name: /youtu\.be\/aaa/ })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /youtu\.be\/bbb/ })).toBeInTheDocument()
    expect(api.fetchUrls).not.toHaveBeenCalled()
  })

  it('schickt die Liste index-parallel zu den URLs', async () => {
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="de" />)
    await holen()
    fireEvent.change(screen.getByRole('textbox', { name: /aaa/ }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('textbox', { name: /bbb/ }), { target: { value: '5' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Holen & starten/ }))
    })
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', ['https://youtu.be/aaa', 'https://youtu.be/bbb'], 'de', undefined, [2, 5]))
  })

  it('leere Felder reisen als null mit — die Zuordnung darf nicht verrutschen', async () => {
    /* `?? null`, nicht `?? undefined`: mit `undefined` faellt der Eintrag in JSON.stringify
       weg, und jede folgende Zahl rutscht eine Aufnahme nach vorn. Genau derselbe Fehler,
       den der Server serverseitig ein zweites Mal abfaengt (paarweise Filterung). */
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="de" />)
    await holen()
    fireEvent.change(screen.getByRole('textbox', { name: /bbb/ }), { target: { value: '5' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Holen & starten/ }))
    })
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', expect.any(Array), 'de', undefined, [null, 5]))
  })

  it('ohne jede Zahl reist gar keine Liste mit (Legacy-Aufruf unveraendert)', async () => {
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="de" />)
    await holen('https://youtu.be/aaa')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Holen & starten/ }))
    })
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', ['https://youtu.be/aaa'], 'de', undefined, undefined))
  })

  it('der Projektwechsel verwirft die Vorschau', async () => {
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    const { rerender } = render(<UrlFetch project="A" onStart={vi.fn()} sprache="de" />)
    await holen('https://youtu.be/aaa')
    expect(screen.getByRole('textbox', { name: /aaa/ })).toBeInTheDocument()
    await act(async () => { rerender(<UrlFetch project="B" onStart={vi.fn()} sprache="de" />) })
    expect(screen.queryByRole('textbox', { name: /aaa/ })).not.toBeInTheDocument()
    expect(api.fetchUrls).not.toHaveBeenCalled()
  })
})

describe('UrlFetch — Reviewbefund PR #297', () => {
  it('dieselbe URL zweimal im Feld ergibt EINE Zeile', () => {
    /* Dieselbe Falle wie beim Upload: `bekannt` wuchs beim Filtern nicht mit, zwei gleiche
       URLs ergaben zwei Zeilen mit demselben Schluessel — nicht einzeln bearbeitbar, und
       beim Start ein doppelter Download. */
    render(<UrlFetch project="Demo" onStart={vi.fn()} sprache="de" />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), {
      target: { value: ['https://youtu.be/aaa', 'https://youtu.be/aaa'].join('\n') },
    })
    fireEvent.click(screen.getByRole('button', { name: /^holen$/i }))
    expect(screen.getAllByRole('textbox', { name: /Anzahl Sprecher/ })).toHaveLength(1)
  })
})
