import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UploadDropzone } from './UploadDropzone'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

// Ohne das teilen sich die Tests die Aufrufliste der Attrappe, und jede Zusicherung der Form
// `not.toHaveBeenCalled()` zaehlt die Aufrufe der Tests DAVOR mit — sie ist dann keine
// Zusicherung mehr, sondern eine Aussage ueber die Reihenfolge in der Datei.
beforeEach(() => { vi.clearAllMocks() })

/** Dateien waehlen UND starten.
 *
 *  Die Auswahl laedt seit dem Vorschau-Umbau nicht mehr selbst hoch: dazwischen steht die
 *  Zeile je Aufnahme mit ihrer Sprecherzahl. Der Grund ist ein Rennen — der Upload startet
 *  serverseitig die Pipeline, wer die Zahl danach eintraegt, kommt zu spaet. Die
 *  Zusicherungen der Tests darunter sind unveraendert; nur der Ausloeser wandert von der
 *  Dateiwahl auf „Hinzufügen & starten".
 */
async function waehlenUndStarten(files: File[]) {
  const input = screen.getByTestId('upload-input') as HTMLInputElement
  await act(async () => { fireEvent.change(input, { target: { files } }) })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
  })
}

describe('UploadDropzone', () => {
  it('laedt nur Audio hoch und meldet Duplikate', async () => {
    vi.mocked(api.uploadAudio)
      .mockResolvedValueOnce({ base: 'a', file: 'a.mp3' })
      .mockRejectedValueOnce(new Error('Datei existiert bereits'))
    const onDone = vi.fn()
    render(<UploadDropzone project="Demo" onDone={onDone} sprache="de" />)
    await waitFor(() => {})
    await waehlenUndStarten([new File(['x'], 'a.mp3'), new File(['y'], 'b.txt'),
                            new File(['z'], 'c.wav')])
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledTimes(2)) // b.txt gefiltert
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(screen.getByText(/existiert bereits/)).toBeInTheDocument()
  })

  it('nennt einen Grund, auch wenn der Fehler keine Meldung traegt', async () => {
    // `?? 'Fehler'` griff hier nicht: eine leere message ist nicht null. Uebrig blieb ein
    // Warndreieck ohne Text — der Nutzer sieht, dass etwas schieflief, aber nicht was.
    vi.mocked(api.uploadAudio).mockRejectedValueOnce(new Error(''))
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    await waehlenUndStarten([new File(['x'], 'a.mp3')])
    expect(await screen.findByText('Fehler')).toBeInTheDocument()
  })

  it('reicht den vom Upload gestarteten Transkriptions-Job nach oben', async () => {
    // Ohne das muesste der Workspace bis zum naechsten Poll warten, bis der Balken erscheint.
    vi.mocked(api.uploadAudio)
      .mockResolvedValueOnce({ base: 'a', file: 'a.mp3', job_id: 'j7', started: true })
      .mockResolvedValueOnce({ base: 'c', file: 'c.wav', job_id: 'j7', started: false })
    const onDone = vi.fn()
    render(<UploadDropzone project="Demo" onDone={onDone} sprache="de" />)
    await waehlenUndStarten([new File(['x'], 'a.mp3'), new File(['z'], 'c.wav')])
    // zuletzt gemeldeter Stand gewinnt: der zweite Upload lief in denselben, schon laufenden Job
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ job_id: 'j7', started: false }))
  })

  it('bringt KEINE eigene Sprachauswahl mit', () => {
    /* Die Auswahl steht genau einmal im Bereich „Material hinzufügen" (ProjectWorkspace).
       ZWEI Einschraenkungen, damit dieser Test nicht mehr verspricht, als er haelt: er faengt
       nur einen BEDINGUNGSLOSEN Wiedereinbau (ein Waehler hinter einer neuen Requisite, die
       hier niemand setzt, kaeme durch), und seine Positivkontrolle liegt im Integrationstest
       (`getAllByRole('combobox')).toHaveLength(1)` in ProjectWorkspace.test.tsx) — der haelt
       die Zahl, dieser hier die Zustaendigkeit. */
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Enthält weitere Sprachen/)).not.toBeInTheDocument()
  })

  it('reicht Sprache und Mehrsprachig-Haken ans uploadAudio weiter', async () => {
    /* VOR dem Upload, nicht danach: der Transkriptions-Job startet serverseitig sofort mit
       dem Upload. Nachtraeglich gesetzt kostet beides einen kompletten zweiten Lauf. */
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="en" mehrsprachig />)
    await waehlenUndStarten([new File(['x'], 'a.mp3')])
    // `undefined` als fuenftes Argument: leeres Feld heisst „automatisch" -> nicht mitschicken.
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith(
      'Demo', expect.any(File), 'en', true, undefined))
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
    await waehlenUndStarten([new File(['x'], 'a.mp3')])
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith(
      'Demo', expect.any(File), '', undefined, undefined))
  })
})

describe('UploadDropzone — Vorschau vor dem Start', () => {
  it('die Auswahl laedt NICHTS hoch, sie zeigt erst die Vorschau', async () => {
    /* Der Kern des Umbaus. Vorher startete die Dateiwahl den Upload und damit serverseitig
       die Pipeline — die Sprecherzahl war ab da ein Rennen gegen die eigene Korrektur. */
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'interview_01.mp3')] } })
    })
    expect(screen.getByRole('textbox', { name: /interview_01\.mp3/ })).toBeInTheDocument()
    expect(api.uploadAudio).not.toHaveBeenCalled()
  })

  it('schickt die Zahl der jeweiligen Zeile mit — nicht die der ersten', async () => {
    /* Die eigentliche Zusicherung des Features: „meist gemischt" heisst, dass Zeile 2 eine
       ANDERE Zahl traegt als Zeile 1. Eine Verwechslung hier ist still — falsche Cluster,
       keine Fehlermeldung. */
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'interview_01.mp3'),
                                                  new File(['y'], 'team.mp3')] } })
    })
    fireEvent.change(screen.getByRole('textbox', { name: /interview_01/ }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('textbox', { name: /team/ }), { target: { value: '5' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledTimes(2))
    expect(api.uploadAudio).toHaveBeenNthCalledWith(1, 'Demo', expect.any(File), 'de', undefined, 2)
    expect(api.uploadAudio).toHaveBeenNthCalledWith(2, 'Demo', expect.any(File), 'de', undefined, 5)
  })

  it('eine zweite Auswahl ERGAENZT und laesst getippte Zahlen stehen', async () => {
    /* Ohne diese Zusicherung waere „ich habe eine Aufnahme vergessen" ein Datenverlust:
       Ersetzen wuerfe die schon eingetippten Zahlen weg, Duplizieren erzeugte zwei Zeilen
       fuer dieselbe Datei. (Fund des gegnerischen Plan-Reviews.) */
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    fireEvent.change(screen.getByRole('textbox', { name: /a\.mp3/ }), { target: { value: '2' } })
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3'),
                                                  new File(['y'], 'b.mp3')] } })
    })
    expect(screen.getByRole('textbox', { name: /a\.mp3/ })).toHaveValue('2')     // bleibt
    expect(screen.getAllByRole('textbox', { name: /a\.mp3/ })).toHaveLength(1)   // keine Dublette
    expect(screen.getByRole('textbox', { name: /b\.mp3/ })).toBeInTheDocument()
  })

  it('der Projektwechsel verwirft die Auswahl — sonst landet Projekt As Datei in B', async () => {
    /* BLOCKER-Fund des gegnerischen Plan-Reviews. React Router baut die Seite bei einem
       Wechsel des Routenparameters NICHT neu auf; ohne den Reset bliebe die Auswahl stehen
       und der naechste Klick auf „Hinzufügen & starten" laedt sie ins FALSCHE Projekt —
       still, mit Erfolgsmeldung. Dasselbe Muster wie beim `sprache`-Reset (frontend/CLAUDE.md),
       nur wiegt es hier schwerer, weil ganze Dateien mitwandern. */
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    const { rerender } = render(<UploadDropzone project="A" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    expect(screen.getByRole('textbox', { name: /a\.mp3/ })).toBeInTheDocument()
    await act(async () => { rerender(<UploadDropzone project="B" onDone={vi.fn()} sprache="de" />) })
    expect(screen.queryByRole('textbox', { name: /a\.mp3/ })).not.toBeInTheDocument()
    expect(api.uploadAudio).not.toHaveBeenCalled()
  })

  it('Abbrechen verwirft die Auswahl, ohne etwas hochzuladen', async () => {
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Abbrechen/ })) })
    expect(screen.queryByRole('textbox', { name: /a\.mp3/ })).not.toBeInTheDocument()
    expect(api.uploadAudio).not.toHaveBeenCalled()
  })
})

describe('UploadDropzone — was der Umbau NEU erlaubt', () => {
  it('ein Serverfehler behaelt die Zeile SAMT eingetippter Zahl', async () => {
    /* Vorher konnte hier keine getippte Arbeit verlorengehen, weil es keine gab. Seit der
       Vorschau steht in jeder Zeile eine von Hand eingetragene Sprecherzahl — ein
       bedingungsloses Leeren warf sie bei einem Serverfehler weg, und der Nutzer haette
       Dateien UND Zahlen neu eintragen muessen. */
    vi.mocked(api.uploadAudio).mockRejectedValue(new Error('Server nicht erreichbar'))
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    fireEvent.change(screen.getByRole('textbox', { name: /a\.mp3/ }), { target: { value: '3' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    expect(screen.getByRole('textbox', { name: /a\.mp3/ })).toHaveValue('3')
  })

  it('„existiert bereits" bleibt NICHT stehen — ein zweiter Versuch endete wieder mit 409', async () => {
    /* Gegenrichtung: ohne sie waere „behaelt die Zeile" auch dann gruen, wenn die Vorschau
       nach jedem Ausgang stehenbliebe — ein Dauerzustand, aus dem nur „Abbrechen" hilft. */
    vi.mocked(api.uploadAudio).mockRejectedValue(new Error('Datei existiert bereits'))
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    expect(screen.queryByRole('textbox', { name: /a\.mp3/ })).not.toBeInTheDocument()
    expect(screen.getByText(/existiert bereits/)).toBeInTheDocument()
  })

  it('nach Erfolg ist die Vorschau weg', async () => {
    vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3' })
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    expect(screen.queryByRole('textbox', { name: /a\.mp3/ })).not.toBeInTheDocument()
  })
})

describe('UploadDropzone — Reviewbefunde PR #297', () => {
  it('zwei gleichnamige Dateien in EINEM Aufruf ergeben EINE Zeile', () => {
    /* Der Dubletten-Schutz deckte nur gegen FRUEHERE Zeilen, nicht innerhalb derselben
       Auswahl (`bekannt` wuchs beim Filtern nicht mit). Zwei `a.mp3` aus verschiedenen
       Ordnern ergaben zwei Zeilen mit demselben Schluessel: React-`key`-Kollision,
       `onAendern` traf beide gleichzeitig, und beim Start kollidierte die zweite
       serverseitig mit 409 — eine der Aufnahmen war faktisch verloren. Gemessen: 2 Zeilen. */
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3'),
                                                new File(['y'], 'a.mp3')] } })
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
  })

  it('Abbrechen bleibt erreichbar, auch wenn der Upload haengt', async () => {
    /* BLOCKER des Reviews: `uploadAudio` hat KEIN Zeitlimit (nur `getDoc` hat eines, mit
       genau dieser Begruendung daneben). Haengt die Verbindung, bleibt `laeuft` fuer immer
       true — mit gesperrtem Abbrechen waeren alle Bedienelemente tot, und der einzige
       Ausweg waere ein Neuladen samt Verlust aller getippten Zahlen. */
    vi.mocked(api.uploadAudio).mockImplementation(() => new Promise(() => {}))
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    const abbrechen = screen.getByRole('button', { name: /Abbrechen/ }) as HTMLButtonElement
    expect(abbrechen.disabled).toBe(false)
    fireEvent.click(abbrechen)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)   // Oberflaeche ist zurueck
  })

  it('ein abgebrochener Lauf holt die Vorschau NICHT zurueck', async () => {
    /* Was der Abbrechen-Fix NEU erlaubte, an der eigenen Reparatur gemessen: der Klick raeumt
       die Vorschau, die laufenden Anfragen laufen aber weiter — und ihr Ende setzte danach
       `setAuswahl(gescheitert)`, womit die verworfene Auswahl wiederkam (gemessen: nach
       Abbrechen 0 Zeilen, nach dem Fehlschlag wieder 1). Die Laufnummer schneidet das ab,
       dasselbe Muster wie `fassung` in `useDoc`. */
    let ablehnen: (e: Error) => void = () => {}
    vi.mocked(api.uploadAudio).mockImplementation(() => new Promise((_, rej) => { ablehnen = rej }))
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Abbrechen/ })) })
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    await act(async () => { ablehnen(new Error('Server weg')); await Promise.resolve() })
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)   // bleibt weg
  })

  it('ein Projektwechsel waehrend des Uploads bringt As Datei NICHT in Bs Vorschau', async () => {
    /* CodeRabbit-Bot, Major — und dieselbe Klasse wie der BLOCKER aus dem Plan-Review, zurueck
       durch die Tuer der eigenen Reparatur: der Wechsel leerte die Auswahl, invalidierte den
       LAUFENDEN Upload aus Projekt A aber nicht. Dessen Ende setzte danach
       `setAuswahl(gescheitert)` — in die Vorschau von B. Ein erneuter Start haette As Dateien
       nach B geladen. Gemessen: 0 Zeilen nach dem Wechsel, wieder 1 nach dem Fehlschlag. */
    let ablehnen: (e: Error) => void = () => {}
    vi.mocked(api.uploadAudio).mockImplementation(() => new Promise((_, rej) => { ablehnen = rej }))
    const { rerender } = render(<UploadDropzone project="A" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    await act(async () => { rerender(<UploadDropzone project="B" onDone={vi.fn()} sprache="de" />) })
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    await act(async () => { ablehnen(new Error('Server weg')); await Promise.resolve() })
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)   // bleibt weg, auch in B
  })

  it('waehrend eines Laufs oeffnet auch die TASTATUR keinen Dateidialog', async () => {
    /* CodeRabbit-Bot, Nachlauf: `onClick` und `onDragOver` waren gegen `laeuft` geschuetzt,
       `onKeyDown` nicht. Enter/Leertaste oeffnete also den Dialog, der Nutzer waehlte aus —
       und `waehlen()` verwarf es still. Ein toter Weg, und einer, der ausgerechnet die
       Tastaturbedienung trifft: mit der Maus passiert sichtbar nichts, per Tastatur
       scheinbar etwas und dann doch nicht. */
    vi.mocked(api.uploadAudio).mockImplementation(() => new Promise(() => {}))
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    const klicks = vi.spyOn(input, 'click')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    klicks.mockClear()
    const flaeche = screen.getByRole('button', { name: 'Audio hochladen' })
    fireEvent.keyDown(flaeche, { key: 'Enter' })
    fireEvent.keyDown(flaeche, { key: ' ' })
    expect(klicks).not.toHaveBeenCalled()
    expect(flaeche).toHaveAttribute('aria-disabled', 'true')
  })

  it('waehrend eines Laufs nimmt die Zone keine neue Auswahl an', async () => {
    /* Sonst landeten neue Zeilen in der Vorschau, der Nutzer traegt eine Zahl ein — und
       `setAuswahl(gescheitert)` am Ende des laufenden Uploads wirft sie ersatzlos weg. */
    vi.mocked(api.uploadAudio).mockImplementation(() => new Promise(() => {}))
    render(<UploadDropzone project="Demo" onDone={vi.fn()} sprache="de" />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp3')] } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hinzufügen & starten/ }))
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['y'], 'b.mp3')] } })
    })
    expect(screen.queryByRole('textbox', { name: /b\.mp3/ })).not.toBeInTheDocument()
  })
})
