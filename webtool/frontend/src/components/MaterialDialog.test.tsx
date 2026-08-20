import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MaterialDialog } from './MaterialDialog'
import * as api from '@/lib/api'

vi.mock('@/lib/api')
vi.mock('@/components/HoerBalken', () => ({ HoerBalken: () => null }))

const basis = {
  project: 'Demo', offen: true,
  sprachChoices: [{ id: 'ch', label: 'Schweizerdeutsch' }, { id: 'en', label: 'Englisch' }],
  projektSprache: 'ch', sprecherMax: 20,
  onSchliessen: () => {}, onFertig: () => {},
}
const datei = (n: string) => new File(['x'], n, { type: 'audio/mpeg' })

beforeEach(() => {
  vi.clearAllMocks()   // OHNE das zaehlt jede not.toHaveBeenCalled-Zusicherung fremde Aufrufe
  vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3', job_id: 'j', started: true })
  vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j', started: true })
})

describe('MaterialDialog', () => {
  it('schickt je Datei ihre EIGENE Sprache und Sprecherzahl', async () => {
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher für a\.mp3/ }),
                     { target: { value: '2' } })
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für b\.mp3/ }),
                     { target: { value: 'en' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledTimes(2))
    expect(api.uploadAudio).toHaveBeenNthCalledWith(1, 'Demo', expect.any(File), '', undefined, 2)
    expect(api.uploadAudio).toHaveBeenNthCalledWith(2, 'Demo', expect.any(File), 'en', undefined, undefined)
  })

  it('ein Schrittwechsel verliert NICHTS', async () => {
    /* Die Bedingung, unter der der waagrechte Ablauf ueberhaupt vertretbar ist. */
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher/ }),
                     { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Zurück/ }))
    expect(screen.getByRole('textbox', { name: /Anzahl Sprecher/ })).toHaveValue('7')
  })

  it('sperrt Weiter, solange EINE Zeile ungueltig ist', () => {
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher für a/ }),
                     { target: { value: '99' } })
    expect(screen.getByRole('button', { name: /Weiter/ })).toBeDisabled()
  })

  it('traegt die Auswahl eines Projekts NICHT ins naechste', () => {
    /* React Router baut die Seite beim Parameterwechsel nicht neu auf — ohne Reset landeten
       Projekt As Dateien samt Zahl in Projekt B, still und mit Erfolgsmeldung. */
    const { rerender } = render(
      <MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    rerender(<MaterialDialog {...basis} project="Anderes" />)
    expect(screen.queryByText('a.mp3')).not.toBeInTheDocument()
  })

  it('schickt beim URL-Import eine index-parallele Sprachliste', async () => {
    render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: /Links/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Video-URLs/ }),
                     { target: { value: 'https://youtu.be/a\nhttps://youtu.be/b' } })
    fireEvent.click(screen.getByRole('button', { name: /Holen/ }))
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für https:\/\/youtu\.be\/b/ }),
                     { target: { value: 'en' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalled())
    // Index 2 = `sprache`. Sie behaelt ihren Platz in der Signatur und wird nur im TYP
    // breiter — ein Umsortieren der Parameter waere eine stille Bruchstelle fuer jeden
    // bestehenden Aufrufer.
    expect(vi.mocked(api.fetchUrls).mock.calls[0][2]).toEqual(['ch', 'en'])
  })

  it('behaelt nach einem Teil-Fehlschlag NUR die gescheiterten Zeilen', async () => {
    vi.mocked(api.uploadAudio)
      .mockResolvedValueOnce({ base: 'a', file: 'a.mp3' })
      .mockRejectedValueOnce(new Error('Netz weg'))
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(screen.queryByText('a.mp3')).not.toBeInTheDocument())
    expect(screen.getByText('b.mp3')).toBeInTheDocument()
  })

  it('nennt in Schritt 3 den Projekt-Standard, wenn „Automatisch" dabei ist', () => {
    /* Spec 10.1 — die alte Fassung dieses Tests erwartete eine WARNUNG („du verlierst die
       Dialekt-Glaettung"). Sie ist widerlegt: `auto` liefert Schweizerdeutsch nicht von sich
       aus, aber der Projekt-Standard tut es. Die Warnung stuende also genau fuer die
       Konstellation da, die 10.1 repariert. */
    render(<MaterialDialog {...basis} projektSprache="ch"
      sprachChoices={[...basis.sprachChoices, { id: 'auto', label: 'Automatisch' }]}
      vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.queryByText(/Projekt-Standard/i)).not.toBeInTheDocument()  // nicht gewaehlt
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für a\.mp3/ }),
                     { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.getByText(/Projekt-Standard/i)).toBeInTheDocument()
    expect(screen.queryByText(/verlier|ohne Dialekt/i)).not.toBeInTheDocument()
  })

  it('nennt den Standard NICHT, wenn er selbst „Automatisch" ist', () => {
    /* Die BEDINGUNG aus 10.1: der zweite Satz nur, wenn der Standard ueberhaupt einen
       Whisper-Code hat. Bei `projektSprache='auto'` gibt es nichts, was gewinnen koennte —
       der Satz waere eine Zusage ohne Gegenstand. Ohne diesen Test ist die Bedingung
       Dekoration: der Test darueber bliebe auch gruen, wenn der Satz IMMER erschiene. */
    render(<MaterialDialog {...basis} projektSprache="auto"
      sprachChoices={[...basis.sprachChoices, { id: 'auto', label: 'Automatisch' }]}
      vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für a\.mp3/ }),
                     { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.queryByText(/Projekt-Standard/i)).not.toBeInTheDocument()
  })

  it('gibt eine aufbewahrte Auswahl nur im SELBEN Projekt zurueck', () => {
    /* Annahme 3 der Spec — und sie widerspraeche 6.1, waere sie nicht projektgebunden:
       getippte Zahlen sind Arbeit, aber As Dateien duerfen nie in B auftauchen. */
    const { rerender } = render(
      <MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher/ }),
                     { target: { value: '4' } })
    rerender(<MaterialDialog {...basis} offen={false} />)          // geschlossen
    rerender(<MaterialDialog {...basis} offen />)                  // wieder auf: alles da
    expect(screen.getByRole('textbox', { name: /Anzahl Sprecher/ })).toHaveValue('4')
    rerender(<MaterialDialog {...basis} project="Anderes" offen />) // anderes Projekt: leer
    expect(screen.queryByText('a.mp3')).not.toBeInTheDocument()
  })
})
