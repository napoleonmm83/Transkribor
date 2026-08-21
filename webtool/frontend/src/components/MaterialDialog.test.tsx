import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MaterialDialog } from './MaterialDialog'
import * as api from '@/lib/api'

vi.mock('@/lib/api')
vi.mock('@/components/HoerBalken', () => ({ HoerBalken: () => null }))
const toastMock = vi.hoisted(() => Object.assign(vi.fn(),
  { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const basis = {
  project: 'Demo', offen: true,
  // `dialekt` seit #301: ohne das Flag schweigt `autoHinweis` bewusst („unbekannt" statt
  // einer moeglichen Falschaussage) — eine Attrappe ohne es wuerde also den Satz
  // wegtesten, den es zu pruefen gilt.
  sprachChoices: [{ id: 'ch', label: 'Schweizerdeutsch', dialekt: true },
                  { id: 'en', label: 'Englisch', dialekt: false }],
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

  it('erklaert EINMAL, warum die Sprache nicht waehlbar ist (#305)', () => {
    /* Der `title` an der Zeile erreicht nur die Maus, und bei zehn Aufnahmen staende
       zehnmal „Projekt-Standard" ohne Grund daneben. Der Satz gehoert deshalb ueber die
       Liste — einmal, sichtbar, fuer beide Eingabewege.
       Gegenprobe unten: mit Auswahl darf er NICHT erscheinen. Ein Hinweis, der immer da
       ist, ist als Daueralarm derselbe Schaden von der anderen Seite. */
    const { rerender } = render(
      <MaterialDialog {...basis} sprachChoices={[]} projektSprache=""
        vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.getByText(/Sprachauswahl steht gerade nicht zur Verfügung/))
      .toBeInTheDocument()

    rerender(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    expect(screen.queryByText(/Sprachauswahl steht gerade nicht zur Verfügung/)).toBeNull()
  })

  it('bietet Links nach einem gerissenen Zeitlimit NICHT erneut an', async () => {
    /* Was das Zeitlimit aus #299 NEU erlaubt: `fetchUrls` konnte vorher nicht mit einem
       TimeoutError ablehnen. Jetzt kann es — und der `catch` schob alle Links zurueck in
       die Liste, also zurueck auf Schritt 2 mit einem Knopf, der zum zweiten Versuch
       einlaedt. Anders als beim Upload faengt den KEIN 409 ab: `fetch.download_one` legt
       ueber `unique_base` eine ZWEITE Datei an (`Video-2.m4a`), die dann transkribiert und
       korrigiert wird. Der Toast sagte dabei gleichzeitig „moeglicherweise trotzdem
       gestartet" — die Zeilen behaupteten das Gegenteil. (Fund der Selbstreview.)

       Unterschieden wird am TYP, nicht am Meldungstext: eine Umformulierung liesse die
       Erkennung sonst still auf den anderen Zweig fallen (dieselbe Regel wie beim 409). */
    vi.mocked(api.fetchUrls).mockRejectedValue(new api.SendeZeitlimit(
      'Zeitlimit überschritten — der Import ist möglicherweise trotzdem gestartet.'))
    render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Video-URLs' }),
                     { target: { value: 'https://youtu.be/aaaaaaaaaaa' } })
    fireEvent.click(screen.getByRole('button', { name: 'Holen' }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    // Die Zeile darf NICHT wieder dastehen — sonst ist der naechste Klick ein zweiter Download.
    await waitFor(() =>
      expect(screen.queryByText('https://youtu.be/aaaaaaaaaaa')).toBeNull())
  })

  it('bietet Links nach einem GEWOEHNLICHEN Fehlschlag weiter an', async () => {
    /* Gegenprobe: eine nicht unterstuetzte URL (400 aus `check_url`) ist der Alltagsfall,
       und dort ist das Stehenlassen richtig — es ist nichts angekommen, der Nutzer
       korrigiert die URL. Ohne diese Richtung waere der Fix oben ein Datenverlust. */
    vi.mocked(api.fetchUrls).mockRejectedValue(new Error('nicht unterstuetzte URL'))
    render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Video-URLs' }),
                     { target: { value: 'https://youtu.be/bbbbbbbbbbb' } })
    fireEvent.click(screen.getByRole('button', { name: 'Holen' }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(screen.getByText('https://youtu.be/bbbbbbbbbbb')).toBeInTheDocument()
  })

  describe('Reiterleiste nach dem APG-Muster (#304)', () => {
    const reiter = () => screen.getAllByRole('tab')

    it('bindet jeden Reiter an ein Panel, das es wirklich gibt', () => {
      /* Ein `role="tab"` kuendigt ein Panel an. Fehlte es, nannte ein Screenreader eine
         Beziehung, die im Baum nirgends existiert — kein WCAG-Verstoss, aber eine
         Falschaussage der Oberflaeche ueber sich selbst.
         Geprueft wird die AUFLOESBARKEIT, nicht die blosse Anwesenheit des Attributs:
         ein `aria-controls` auf eine tote Id ist stumm (dieselbe Lehre wie #244). */
      render(<MaterialDialog {...basis} />)
      const aktiv = reiter().find(t => t.getAttribute('aria-selected') === 'true')!
      const panelId = aktiv.getAttribute('aria-controls')!
      const panel = document.getElementById(panelId)
      expect(panel).not.toBeNull()
      expect(panel).toHaveAttribute('role', 'tabpanel')
      expect(panel).toHaveAttribute('aria-labelledby', aktiv.id)
      // JEDER Reiter, nicht nur der aktive — und das ist der Punkt, den erst der Browser
      // gezeigt hat: es wird nur EIN Panel gerendert, der inaktive Reiter zeigte damit auf
      // eine tote Id. Das ist derselbe Fehler, den #304 behebt, nur verschoben: ein
      // `aria-controls` ins Leere kuendigt eine Beziehung an, die es nicht gibt.
      for (const t of reiter()) {
        const id = t.getAttribute('aria-controls')
        if (id !== null) expect(document.getElementById(id)).not.toBeNull()
      }
    })

    it('wechselt mit den Pfeiltasten und laeuft dabei um', () => {
      /* Das APG-Muster verlangt Pfeiltasten; heute ging nur Tab. Der Umlauf gehoert dazu —
         ohne ihn steht man am Ende der Leiste und nichts passiert. */
      render(<MaterialDialog {...basis} />)
      const [dateien, links] = reiter()
      dateien.focus()
      fireEvent.keyDown(dateien, { key: 'ArrowRight' })
      expect(links).toHaveAttribute('aria-selected', 'true')
      expect(links).toHaveFocus()
      fireEvent.keyDown(links, { key: 'ArrowRight' })       // Umlauf ans andere Ende
      expect(reiter()[0]).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(reiter()[0], { key: 'ArrowLeft' })  // und zurueck
      expect(reiter()[1]).toHaveAttribute('aria-selected', 'true')
    })

    it('springt mit Home und End an die Enden', () => {
      render(<MaterialDialog {...basis} />)
      const [dateien, links] = reiter()
      dateien.focus()
      fireEvent.keyDown(dateien, { key: 'End' })
      expect(links).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(links, { key: 'Home' })
      expect(dateien).toHaveAttribute('aria-selected', 'true')
    })

    it('ist EIN Tabstopp, nicht zwei (Roving Tabindex)', () => {
      /* Die bewusste Verhaltensaenderung: vorher tabbte man durch beide Knoepfe. Das
         APG-Muster macht die Leiste zu einem einzigen Halt — innerhalb wird mit Pfeilen
         navigiert. Ohne den Roving Tabindex waere die Pfeiltasten-Navigation ein zweiter,
         konkurrierender Weg statt des vorgesehenen. */
      render(<MaterialDialog {...basis} />)
      const [dateien, links] = reiter()
      expect(dateien).toHaveAttribute('tabindex', '0')
      expect(links).toHaveAttribute('tabindex', '-1')
    })

    it('laesst die Maus unveraendert', () => {
      /* Gegenprobe: die Tastaturbedienung darf den vorhandenen Weg nicht ersetzen. */
      render(<MaterialDialog {...basis} />)
      fireEvent.click(reiter()[1])
      expect(reiter()[1]).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('textbox', { name: 'Video-URLs' })).toBeInTheDocument()
    })
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
    // `null` fuer die erste Zeile, nicht `'ch'`: sie entspricht dem Projekt-Standard, und ein
    // mitgeschickter Wert machte daraus einen Datei-Override (#166/#234). Der PLATZ bleibt
    // trotzdem belegt — daran haengt die index-parallele Zuordnung. Der Plan erwartete hier
    // `['ch','en']`; das waere der Override gewesen.
    expect(vi.mocked(api.fetchUrls).mock.calls[0][2]).toEqual([null, 'en'])
  })

  it('ein abgelehnter URL-Import meldet sich und gibt den Dialog wieder frei (K1)', async () => {
    /* Der Nachfolger des geloeschten `zeigt die Serverbegruendung und ruft onStart nicht`.
       OHNE `try` verlaesst die Ausnahme `starten`: `setLaeuft(false)` liefe nie, der Knopf
       staende fuer immer auf „startet…", und weil dieser Dialog seinen Zustand AUFBEWAHRT,
       heilt auch Schliessen und Wiederoeffnen ihn nicht. Ausloeser ist der Alltag — eine
       nicht unterstuetzte URL endet mit 400. */
    vi.mocked(api.fetchUrls).mockRejectedValue(new Error('Nicht unterstuetzte Seite'))
    render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: /Links/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Video-URLs/ }),
                     { target: { value: 'https://boese.example/x' } })
    fireEvent.click(screen.getByRole('button', { name: /Holen/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining('Nicht unterstuetzte Seite')))
    // Der Dialog ist wieder bedienbar und steht in Schritt 2 — dort SIEHT der Nutzer die
    // Zeile, die es nicht geschafft hat, bevor er den zweiten Versuch startet. Ohne den
    // `catch` bliebe stattdessen `laeuft` stehen und beide Knoepfe waeren tot.
    expect(screen.getByText('https://boese.example/x')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Weiter/ })).toBeEnabled()
  })

  it('eine GEMISCHTE Auswahl geht auf beiden Wegen — je Zeile, nicht je Reiter (K2)', async () => {
    /* Der Weg, den dieser Umbau NEU aufgemacht hat: `ergaenzen` haengt an, `quelle` haengt am
       zuletzt geklickten Reiter. Frueher war die Vermischung strukturell unmoeglich (zwei
       Komponenten, zwei Listen). Ohne die Verzweigung je Zeile liefe die URL-Zeile in
       `uploadAudio(…, undefined)` — FormData macht daraus "undefined", der Server 422. */
    render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: /Links/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Video-URLs/ }),
                     { target: { value: 'https://youtu.be/a' } })
    fireEvent.click(screen.getByRole('button', { name: /Holen/ }))       // -> Schritt 2
    fireEvent.click(screen.getByRole('button', { name: /Zurück/ }))      // -> Schritt 1
    fireEvent.click(screen.getByRole('tab', { name: /Dateien/ }))
    fireEvent.change(screen.getByTestId('ablage-input'),
                     { target: { files: [datei('a.mp3')] } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledTimes(1))
    expect(api.fetchUrls).toHaveBeenCalledTimes(1)
    // Jede Zeile auf IHREM Weg: die Datei als File, die URL als URL.
    expect(vi.mocked(api.uploadAudio).mock.calls[0][1]).toBeInstanceOf(File)
    expect(vi.mocked(api.fetchUrls).mock.calls[0][1]).toEqual(['https://youtu.be/a'])
  })

  it('nennt einen Grund, auch wenn der Fehler keinen traegt', async () => {
    /* Aus `UploadDropzone.test.tsx` mitgenommen: `new Error('')` ist nicht `null`, das `||`
       ist also die tragende Zeile — und war ungedeckt. */
    vi.mocked(api.uploadAudio).mockRejectedValue(new Error(''))
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/a\.mp3: .+/)))
  })

  it('leert das URL-Feld nach einem gelungenen Import', async () => {
    /* Der Dialog bewahrt seinen Zustand auf — die eben importierten Links staenden beim
       naechsten Oeffnen wieder im Feld, und ein Klick auf „Holen" liefe in einen ZWEITEN
       Download derselben Videos. `ergaenzen` schuetzt innerhalb der Liste, nicht gegen einen
       bereits erledigten Lauf. */
    const { rerender } = render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: /Links/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Video-URLs/ }),
                     { target: { value: 'https://youtu.be/a' } })
    fireEvent.click(screen.getByRole('button', { name: /Holen/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalled())
    rerender(<MaterialDialog {...basis} offen={false} />)
    rerender(<MaterialDialog {...basis} offen />)
    fireEvent.click(screen.getByRole('tab', { name: /Links/ }))
    expect(screen.getByRole('textbox', { name: /Video-URLs/ })).toHaveValue('')
  })

  it('ein Drop landet nie in der Zusammenfassung', async () => {
    /* Neu durch den Wiedereinstieg ueber das Drop-Overlay: wurde der Dialog auf Schritt 3
       verlassen, saehe der Nutzer Sprache und Sprecherzahl der frisch abgelegten Aufnahmen
       NIE — sie liefen ungefragt mit dem Projekt-Standard los. */
    const { rerender } = render(
      <MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))   // Schritt 3
    expect(screen.getByRole('button', { name: /Los geht/ })).toBeInTheDocument()
    rerender(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    // Zurueck in Schritt 2: die Zeilen sind da UND einstellbar.
    expect(screen.getByRole('textbox', { name: /Anzahl Sprecher für b\.mp3/ })).toBeInTheDocument()
  })

  it('„Holen" mit leerem Feld bleibt untaetig', () => {
    /* Aus `UrlFetch.test.tsx`: ein `if` ohne Test. Ohne die Wache entstuende eine leere
       Zeilenliste und der Dialog spraenge trotzdem in Schritt 2. */
    render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: /Links/ }))
    fireEvent.click(screen.getByRole('button', { name: /Holen/ }))
    expect(screen.getByRole('textbox', { name: /Video-URLs/ })).toBeInTheDocument()  // Schritt 1
    expect(api.fetchUrls).not.toHaveBeenCalled()
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

  it('schliesst sich nach einem vollstaendig gelungenen Start — und NUR dann', async () => {
    /* Im Browser gefunden, von keinem Test: der Dialog blieb mit leerer Liste offen, und der
       einzige Rueckweg hiess „Abbrechen" — ein Knopf, der nach Verwerfen klingt, fuer einen
       Lauf, der gerade geglueckt ist. Die Gegenrichtung gehoert dazu: nach einem
       Teil-Fehlschlag darf er NICHT zugehen, sonst verschwaenden die gescheiterten Zeilen. */
    const onSchliessen = vi.fn()
    const { rerender } = render(
      <MaterialDialog {...basis} onSchliessen={onSchliessen}
        vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(onSchliessen).toHaveBeenCalled())

    onSchliessen.mockClear()
    vi.mocked(api.uploadAudio).mockRejectedValue(new Error('Netz weg'))
    rerender(<MaterialDialog {...basis} project="Zweites" onSchliessen={onSchliessen}
      vorbelegteDateien={[datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(screen.getByText('b.mp3')).toBeInTheDocument())
    expect(onSchliessen).not.toHaveBeenCalled()
  })

  it('„existiert bereits" bleibt NICHT stehen — ein zweiter Versuch endete wieder mit 409', async () => {
    /* Aus `MaterialVorschau.test.tsx` mitgenommen: die Unterscheidung hat sonst keinen Test
       mehr. Alles Stehenlassen liefe beim naechsten Klick in lauter 409er, bedingungsloses
       Leeren waere Datenverlust — deshalb genau diese eine Ausnahme. */
    vi.mocked(api.uploadAudio)
      .mockRejectedValueOnce(new Error('a.mp3 existiert bereits'))
      .mockRejectedValueOnce(new Error('Netz weg'))
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(screen.getByText('b.mp3')).toBeInTheDocument())
    expect(screen.queryByText('a.mp3')).not.toBeInTheDocument()
  })

  it('Abbrechen bleibt erreichbar, auch wenn der Upload haengt (#299)', async () => {
    /* `uploadAudio` hat kein Zeitlimit. Waere Abbrechen mitgesperrt, bliebe der Dialog bei
       einer haengenden Verbindung fuer immer tot, und der einzige Ausweg waere ein Neuladen
       samt Verlust aller Eingaben. */
    vi.mocked(api.uploadAudio).mockReturnValue(new Promise(() => {}))
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Los geht|startet/ })).toBeDisabled())
    // Waehrend des Laufs heisst der Knopf „Schliessen" — er bricht nichts ab, und
    // „Abbrechen" waere dort ein Versprechen, das er nicht einloest. Die Zusicherung ist
    // dieselbe: der Rueckweg bleibt bedienbar.
    expect(screen.getByRole('button', { name: /Schliessen/ })).toBeEnabled()
  })

  it('ein Projektwechsel WAEHREND des Uploads schreibt As Ergebnis nicht in Bs Dialog', async () => {
    /* Die `laufNr`-Wache. Der Plan fuehrte sie als „kein Test — im Browser pruefen"; sie ist
       aber herstellbar: der Upload haengt, das Projekt wechselt (Reset), DANN antwortet er.
       Ohne den Vergleich setzte sein `setZeilen(gescheitert)` Projekt As Zeilen in Bs frisch
       geleerten Dialog zurueck. */
    let ablehnen: (e: Error) => void = () => {}
    vi.mocked(api.uploadAudio).mockReturnValue(new Promise((_, rej) => { ablehnen = rej }))
    const { rerender } = render(
      <MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    rerender(<MaterialDialog {...basis} project="Anderes" />)
    await act(async () => { ablehnen(new Error('Netz weg')) })
    expect(screen.queryByText('a.mp3')).not.toBeInTheDocument()
  })

  it('meldet den Ausgang an den Rueckruf DES PROJEKTS, in dem der Lauf startete', async () => {
    /* Messung zu einem Reviewbefund (CodeRabbit-Bot, kritisch): `onFertig` laeuft ausserhalb
       der `laufNr`-Wache — meldet ein Lauf aus Projekt A seinen Job also an den Rueckruf von
       Projekt B, das inzwischen offen ist? Die Arbeitsflaeche baut daraus `adopt(job, project)`,
       ein falsches Projekt waere ein falsch zugeordneter Job. */
    let aufloesen: (w: unknown) => void = () => {}
    vi.mocked(api.uploadAudio).mockReturnValue(new Promise(r => { aufloesen = r as never }))
    const fertigA = vi.fn(); const fertigB = vi.fn()
    const { rerender } = render(
      <MaterialDialog {...basis} project="A" onFertig={fertigA}
        vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    rerender(<MaterialDialog {...basis} project="B" onFertig={fertigB} />)
    await act(async () => { aufloesen({ base: 'a', file: 'a.mp3', job_id: 'j', started: true }) })
    expect(fertigA).toHaveBeenCalled()
    expect(fertigB).not.toHaveBeenCalled()
  })

  it('nennt in Schritt 3 den Projekt-Standard, wenn „Automatisch" dabei ist', () => {
    /* Spec 10.1 — die alte Fassung dieses Tests erwartete eine WARNUNG („du verlierst die
       Dialekt-Glaettung"). Sie ist widerlegt: `auto` liefert Schweizerdeutsch nicht von sich
       aus, aber der Projekt-Standard tut es. Die Warnung stuende also genau fuer die
       Konstellation da, die 10.1 repariert. */
    render(<MaterialDialog {...basis} projektSprache="ch"
      sprachChoices={[...basis.sprachChoices, { id: 'auto', label: 'Automatisch', dialekt: false }]}
      vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für a\.mp3/ }),
                     { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.getByText(/Projekt-Standard/i)).toBeInTheDocument()
    expect(screen.queryByText(/verlier|ohne Dialekt/i)).not.toBeInTheDocument()
  })

  it('nennt einen NICHT-Dialekt-Standard nicht als Gewinner (#301)', () => {
    /* Die Bedingung war `projektSprache !== 'auto'` und damit zu weit: ein englisches
       Projekt bekam „Wird Deutsch erkannt, gilt der Projekt-Standard Englisch".
       GEMESSEN an `sprachen.von_whisper_code` ist das falsch — dort gilt `de`:

           erkannt  Standard  mit Vorrang  ohne Vorrang
           de       ch        ch           de            <- der EINZIGE Unterschied
           de       en        de           de

       Der Vorrang greift nur, wo sich zwei ids einen Whisper-Code teilen. Ohne diesen Test
       bliebe die Korrektur ungedeckt: der Test darunter prueft nur den `auto`-Standard. */
    render(<MaterialDialog {...basis} projektSprache="en"
      sprachChoices={[...basis.sprachChoices, { id: 'auto', label: 'Automatisch', dialekt: false }]}
      vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für a\.mp3/ }),
                     { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.queryByText(/gilt der Projekt-Standard/)).toBeNull()
    expect(screen.getByText(/ohne Dialekt-Glättung/)).toBeInTheDocument()
  })

  it('zeigt in Schritt 3 NICHTS, solange keine Zeile auf „Automatisch" steht', () => {
    /* Die Gegenprobe stand vorher eine EBENE DANEBEN: sie klickte einmal `Weiter` und
       pruefte die Abwesenheit auf Schritt 2 — der Absatz haengt aber an `schritt === 3`.
       Damit konnte sie nicht rot werden, egal was `autoDabei` sagt. GEMESSEN vom Reviewer:
       `autoDabei = zeilen.length > 0` liess 582/582 gruen.
       Das zaehlt, weil `autoDabei` durch den #301-Umbau tragend geworden ist
       (`const hinweis = autoDabei ? autoHinweis(…) : null`): braeche die Bedingung, staende
       der Erklaersatz in JEDEM Projekt, auch ohne eine einzige `auto`-Aufnahme — genau der
       Daueralarm, gegen den `autoHinweis.test.ts` eine eigene Gegenprobe fuehrt. */
    render(<MaterialDialog {...basis} projektSprache="ch"
      sprachChoices={[...basis.sprachChoices, { id: 'auto', label: 'Automatisch', dialekt: false }]}
      vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))   // Schritt 2
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))   // Schritt 3
    expect(screen.getByText(/1 Aufnahme/)).toBeInTheDocument()        // wirklich auf Schritt 3
    expect(screen.queryByText(/Automatisch“:/)).toBeNull()
    expect(screen.queryByText(/Dialekt-Glättung/)).toBeNull()
  })

  it('nennt den Standard NICHT, wenn er selbst „Automatisch" ist', () => {
    /* Die BEDINGUNG aus 10.1: der zweite Satz nur, wenn der Standard ueberhaupt einen
       Whisper-Code hat. Bei `projektSprache='auto'` gibt es nichts, was gewinnen koennte —
       der Satz waere eine Zusage ohne Gegenstand. Ohne diesen Test ist die Bedingung
       Dekoration: der Test darueber bliebe auch gruen, wenn der Satz IMMER erschiene. */
    render(<MaterialDialog {...basis} projektSprache="auto"
      sprachChoices={[...basis.sprachChoices, { id: 'auto', label: 'Automatisch' , dialekt: false }]}
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
