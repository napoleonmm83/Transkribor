import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MaterialDialog } from './MaterialDialog'
import * as api from '@/lib/api'

vi.mock('@/lib/api')
/* Die Attrappe rendert ein ELEMENT, sonst liesse sich „liegt ausserhalb der Rollflaeche"
   nicht pruefen — ein `null` hat keinen Platz im Baum. Sie bildet die eine Regel nach, auf
   die es hier ankommt: nichts, solange nichts klingt (`HoerBalken.tsx`, dort getrennt
   festgenagelt in `HoerBalken.test.tsx`). Welle, Transport und Blob-Lebenszyklus gehoeren
   nicht in diesen Test. */
vi.mock('@/components/HoerBalken', () => ({
  HoerBalken: ({ datei, onSchliessen }: { datei: File | null; onSchliessen: () => void }) =>
    datei ? <button data-testid="hoerbalken" onClick={onSchliessen}>zu</button> : null,
}))
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
/* Eine echt allokierte 4-MB-Datei kostet den Testlauf Speicher fuer nichts: `size` ist
 * das einzige Feld, das die Groessenspalte liest (dieselbe Attrappe wie in api.test.ts). */
const mitGroesse = (d: File, bytes: number) => {
  Object.defineProperty(d, 'size', { value: bytes })
  return d
}

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
      // Und die Gegenrichtung: der INAKTIVE Reiter darf gar kein `aria-controls` tragen.
      // Ohne sie bliebe der Test gruen, wenn ALLE Reiter auf das aktive Panel zeigen — der
      // Vertrag lautet aber „nur der aktive verweist auf das gerenderte Panel"
      // (CodeRabbit-Bot).
      for (const t of reiter().filter(x => x.getAttribute('aria-selected') !== 'true')) {
        expect(t).not.toHaveAttribute('aria-controls')
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
      // Der Roving-Tabindex muss MITWANDERN. Bliebe er beim alten Reiter, waere die Leiste
      // nach einem Pfeildruck kein Tabstopp mehr, den man wieder betreten kann — und der
      // Test darunter prueft nur den Ausgangszustand (CodeRabbit-Bot).
      expect(links).toHaveAttribute('tabindex', '0')
      expect(dateien).toHaveAttribute('tabindex', '-1')
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
    // Der Hinweis ERSETZT den generischen Satz, er haengt sich nicht daran: „…Whisper
    // erkennt die Sprache selbst. Es gilt, was Whisper erkennt." waeren zwei Saetze mit
    // derselben Aussage (Reviewbefund n1).
    expect(screen.queryByText(/Sprache selbst/)).toBeNull()
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
  it('zeigt die gewaehlten Aufnahmen mit NAMEN, nicht nur ihre Zahl', () => {
    /* Schritt 1 stand vorher bei „3 Aufnahmen gewählt" — wer mehrere Dateien auf einmal
       waehlte, erfuhr bis Schritt 2 nicht, WELCHE es geworden sind. Geprueft wird deshalb
       ohne einen Klick auf „Weiter". */
    render(<MaterialDialog {...basis}
      vorbelegteDateien={[mitGroesse(datei('a.mp3'), 4_200_000), datei('b.mp3')]} />)
    expect(screen.getByText('2 Aufnahmen gewählt')).toBeInTheDocument()
    expect(screen.getByText('a.mp3')).toBeInTheDocument()
    expect(screen.getByText('b.mp3')).toBeInTheDocument()
    expect(screen.getByText('4,2 MB')).toBeInTheDocument()
  })

  it('entfernt GENAU die angeklickte Aufnahme', () => {
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: 'a.mp3 aus der Auswahl entfernen' }))
    expect(screen.queryByText('a.mp3')).toBeNull()
    /* Die Nachbarzeile MUSS stehenbleiben: aus `!==` ein `===` gemacht, loeschte der Klick
       alles ausser der angeklickten Zeile — und das faellt ohne diese Zusicherung nicht auf,
       weil die erste Zeile in beiden Faellen verschwindet. */
    expect(screen.getByText('b.mp3')).toBeInTheDocument()
    expect(screen.getByText('1 Aufnahme gewählt')).toBeInTheDocument()
  })

  it('sagt den Wegfall an — die Live-Region bleibt DAUERHAFT im Baum (#311)', () => {
    /* Der ✕ entfernt eine Zeile: sichtbar sofort, hoerbar bisher nicht. Fuer Tastaturnutzer
       trug der Fokuswechsel die Ansage; fuer SPRACHSTEUERUNG passierte akustisch nichts.
       Geprueft wird die IDENTITAET des Knotens, nicht bloss sein Vorhandensein: eine
       Live-Region, die mit ihrem Inhalt in den Baum kommt und wieder verschwindet, wird von
       Screenreadern oft nicht mehr beobachtet — genau daran scheiterte das Attribut allein.
       Die letzte Zusicherung ist die tragende: bei NULL Zeilen muss sie stehenbleiben.
       jsdom bildet die Vorlesung nicht nach; dass die Ansage ankommt, gehoert in den
       Browser-Gegencheck. */
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('2 Aufnahmen gewählt')
    fireEvent.click(screen.getByRole('button', { name: 'a.mp3 aus der Auswahl entfernen' }))
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveTextContent('1 Aufnahme gewählt')
    fireEvent.click(screen.getByRole('button', { name: 'b.mp3 aus der Auswahl entfernen' }))
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent?.trim()).toBe('')
  })
  it('vergisst den Abspieler, wenn die klingende Aufnahme aus der Liste faellt', () => {
    /* Sonst bleibt ihr Schluessel im Zustand stehen — und dieselbe Datei, spaeter erneut
       hinzugefuegt, spielt beim Betreten von Schritt 2 ungefragt los. Derselbe Fall wie die
       Zeile, die nach einem Teil-Fehlschlag aus der Liste faellt. */
    const { rerender } = render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Reinhören: a\.mp3/ }))
    expect(screen.getByRole('button', { name: /Reinhören: a\.mp3/ }))
      .toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /Zurück/ }))
    fireEvent.click(screen.getByRole('button', { name: 'a.mp3 aus der Auswahl entfernen' }))
    rerender(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.getByRole('button', { name: /Reinhören: a\.mp3/ }))
      .toHaveAttribute('aria-pressed', 'false')
  })
  it('nimmt die entfernte URL AUS dem Textfeld — sonst holt „Holen" sie zurueck', async () => {
    /* Der Weg, den erst der Entfernen-Knopf aufgemacht hat: das Textfeld behaelt seinen
       Inhalt (bewusst, `starten` leert es erst am Ende), also stand die eben entfernte URL
       weiter da — und ein Klick auf „Holen" legte sie neu an UND sprang auf Schritt 2.
       Dieselbe Regel wie in `starten`, nur fuer den Rueckweg. */
    render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Video-URLs' }),
                     { target: { value: 'https://youtu.be/aaa\nhttps://youtu.be/bbb' } })
    fireEvent.click(screen.getByRole('button', { name: 'Holen' }))
    fireEvent.click(screen.getByRole('button', { name: /Zurück/ }))
    fireEvent.click(screen.getByRole('button',
      { name: 'https://youtu.be/aaa aus der Auswahl entfernen' }))

    /* Gemessen wird am TEXTFELD, und zwar HIER — nach dem naechsten „Holen" steht der
       Dialog auf Schritt 2, wo es kein Textfeld gibt. */
    /* Nicht an der Liste: die Nachbarzeile steht ohnehin in `zeilen`, also blieb die
       Zusicherung „bbb ist noch da" auch unter der Mutation `setUrlText('')` gruen —
       geprueft gehoert, was im FELD uebrig bleibt. Ein pauschales Leeren waere derselbe
       Datenverlust von der anderen Seite: wer zehn Links eingetippt hat, verloere sie
       durch einen Klick auf ein einzelnes ✕. */
    expect(screen.getByRole('textbox', { name: 'Video-URLs' }))
      .toHaveValue('https://youtu.be/bbb')

    // Und die Wirkung: „Holen" legt die entfernte Zeile NICHT wieder an.
    fireEvent.click(screen.getByRole('button', { name: 'Holen' }))
    expect(screen.queryByText('https://youtu.be/aaa')).toBeNull()
    expect(screen.getByText('https://youtu.be/bbb')).toBeInTheDocument()
  })

  it('laesst den Fokus nicht auf <body> fallen, wenn eine Zeile verschwindet', () => {
    /* Der Knopf entfernt das Element, auf dem der Fokus steht. Ohne Griff landet er auf
       <body>, Radix zieht ihn an den Dialoganfang, und wer drei Fehlgriffe herausnehmen
       will, tabbt sich nach JEDEM Klick neu durch die Liste. */
    render(<MaterialDialog {...basis}
      vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: 'a.mp3 aus der Auswahl entfernen' }))
    expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: 'b.mp3 aus der Auswahl entfernen' }))

    // Die letzte Zeile hat keinen Nachfolger — dann traegt der aktive Reiter den Fokus,
    // nicht <body>.
    fireEvent.click(screen.getByRole('button', { name: 'b.mp3 aus der Auswahl entfernen' }))
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Dateien' }))
  })

  it('zeigt eine Grösse nur dort, wo es eine gibt — Links haben noch keine', () => {
    /* `zeilen` mischt Datei- und Link-Zeilen (`ergaenzen`), und die Liste verzweigt zweimal
       danach: Symbol und Groessenspalte. Ohne diesen Test ist `z.datei &&` unbedeckt — die
       Datei-Haelfte allein haelt sie nicht.
       Das SYMBOL bleibt bewusst ungeprueft: lucide rendert `FileAudio` als
       `lucide-file-headphone` (der Importname ist ein Alias) und `Link2` als
       `lucide-link2 lucide-link-2` — eine Zusicherung darauf misst den internen Namen einer
       Bibliothek, nicht unsere Verzweigung, und ein Update faerbte sie rot ohne Fehler.
       Der Unterschied ist im Browser belegt (`material-dialog-gemischt.png`); sein Schaden
       waere kosmetisch und sofort sichtbar. Die Groessenspalte traegt dieselbe Bedingung
       und ist hier scharf. */
    render(<MaterialDialog {...basis}
      vorbelegteDateien={[mitGroesse(datei('a.mp3'), 4_200_000)]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Links' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Video-URLs' }),
                     { target: { value: 'https://youtu.be/aaa' } })
    fireEvent.click(screen.getByRole('button', { name: 'Holen' }))
    fireEvent.click(screen.getByRole('button', { name: /Zurück/ }))

    expect(screen.getByText('2 Aufnahmen gewählt')).toBeInTheDocument()
    expect(screen.getByText('4,2 MB')).toBeInTheDocument()
    // Genau EINE Groessenangabe: die Link-Zeile bekommt keine.
    expect(screen.getAllByText(/\d (MB|KB|GB)$/)).toHaveLength(1)
  })
  it('gibt der Auswahlliste einen EIGENEN Bildlauf, damit das Drop-Ziel stehenbleibt', () => {
    /* Vorher rollte der ganze Inhaltsbereich: wer zehn Dateien gewaehlt hatte und in der
       Liste nach unten ging, schob die Ablageflaeche aus dem Bild — also die Flaeche, auf
       der die naechste Datei landen soll.
       jsdom hat KEIN Layout: `scrollHeight` ist hier immer 0, „rollt wirklich" laesst sich
       damit nicht messen. Dieser Test haelt deshalb nur die Struktur fest, an der es haengt
       (die Liste ist die Rollflaeche, nicht ihr Elternteil). Gemessen ist es im Browser:
       aeusserer Behaelter 310/310 (rollt nicht), Liste 640/138 (rollt), und die
       Ablageflaeche steht vor wie nach dem Rollen bei 162 px. */
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    // Ueber eine Zeile hochgehen, nicht ueber `container`: der Dialog haengt in einem
    // Radix-PORTAL und liegt damit ausserhalb. Und nicht ueber `getByRole('list')` — die
    // Schrittleiste darueber ist ein `<ol>` und traegt dieselbe Rolle.
    const liste = screen.getByText('a.mp3').closest('ul')!
    expect(liste.className).toContain('overflow-y-auto')
    // `min-h-24` traegt hier ZWEI Dinge: es erlaubt das Schrumpfen unter die Inhaltshoehe
    // (sonst waechst ein Flex-Kind mit seinem Inhalt und `overflow` greift nie) UND setzt
    // den Boden aus C1, unter den die Liste nicht mehr fallen darf.
    expect(liste.className).toContain('min-h-24')
    expect(liste.className).toContain('rollbalken')

    /* Die beiden Klassen, an denen die Wirkung WIRKLICH haengt — der Reviewer hat gemessen,
       dass ihr Wegfall exakt den alten Fehler wiederherstellt, waehrend die drei
       Zusicherungen oben gruen bleiben. Ein Waechter, der nur prueft, was ohnehin im
       `expect` steht, lebt vom Zufall. */
    const spalte = liste.closest('div.flex.h-full')
    expect(spalte).not.toBeNull()
    expect(liste.parentElement!.className).toContain('min-h-0')

    // Und die Zusicherung, die den Testnamen einloest: in Schritt 1 rollt GENAU EINE
    // Flaeche. Zwei waeren die Leisten ineinander, die Schritt 2 bewusst vermeidet.
    expect(spalte!.querySelectorAll('[class*="overflow-y-auto"]')).toHaveLength(1)
  })

  it('haelt den Hoerbalken AUSSERHALB der Rollflaeche (Schritt 2)', () => {
    /* Er soll sichtbar bleiben, waehrend man die Liste durchgeht — vorher stand er am Ende
       des Flusses und wanderte beim Blaettern aus dem Bild, ausgerechnet waehrend er spielt.
       Die Attrappe oben rendert dafuer ein Element: mit `() => null` gaebe es nichts, dessen
       Platz im Baum man pruefen koennte. */
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Reinhören: a\.mp3/ }))

    const balken = screen.getByTestId('hoerbalken')
    const liste = screen.getByText('a.mp3').closest('ul')!
    expect(liste.className).toContain('overflow-y-auto')
    /* Der Boden zaehlt hier MEHR als in Schritt 1: der Hoerbalken erscheint auf Klick und
       nimmt der Liste 185 px auf einen Schlag weg (gemessen 354 → 147 px — nicht auf 0,
       der Boden greift ja). OHNE ihn faellt sie auf 0, und dann sind die Zeilen ueber keinen
       Bildlauf mehr erreichbar: derselbe Kollaps wie in PR #313. */
    expect(liste.className).toContain('min-h-24')

    /* Die Klassen an der `<ul>` tun ohne die Elternspalte NICHTS — ein Reviewer hat
       gemessen, dass `h-full` weg, `flex-col` weg und sogar der Rueckbau der ganzen Spalte
       auf `space-y-2` alle 39 Tests gruen liessen. Die tragenden Klassen gehoeren also
       ausdruecklich in die Zusicherung, nicht nur ihre Wirkung. */
    expect(liste.parentElement!.className).toContain('h-full')
    expect(liste.parentElement!.className).toContain('flex-col')

    /* EINE Zusicherung statt zweier: „unmittelbar nach der Liste" deckt „nicht darin" und
       „Geschwister derselben Spalte" mit ab — und zusaetzlich die REIHENFOLGE. Ueber der
       Liste stuende er im Weg. */
    expect(liste.nextElementSibling).toBe(balken)
  })

  it('holt die klingende Zeile zurueck ins Bild, wenn die Liste schrumpft', () => {
    /* Der Hoerbalken nimmt der Liste beim Oeffnen rund die Haelfte ihrer Hoehe (gemessen
       354 → 147 px), waehrend der Browser `scrollTop` behaelt — die eben angeklickte Zeile
       rutscht unter die Kante, samt Fokusring und `aria-pressed`. Ab der fuenften von acht
       Zeilen trifft das jede.
       Ausgeloest wird das Nachfuehren von der GROESSENAENDERUNG, nicht vom Klick: ein
       `requestAnimationFrame` am Klick war der erste Versuch und ist im Browser widerlegt
       (die Liste schrumpft erst, wenn wavesurfer fertig dekodiert hat).
       jsdom kennt keinen `ResizeObserver` und hat kein Layout — der Stub hier laesst den
       Test seinen Rueckruf SELBST ausloesen. Geprueft wird damit die Reaktion, nicht die
       Erkennung; dass die Zeile im echten Browser wirklich zurueckkommt, ist dort gemessen
       (Zeile 6 wanderte von 334 auf 287 und blieb im Bild, ohne den Beobachter blieb sie
       bei 334 und fiel heraus). */
    /* Der Rueckruf wird erst bei `observe()` gesammelt, NICHT im Konstruktor: sonst misst
       der Test nur, dass ein Beobachter gebaut wurde — die Mutation „`observe()` weglassen"
       blieb damit gruen (gemessen). Angemeldet ist er erst, wenn er auch etwas beobachtet. */
    const rueckrufe: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class {
      // Explizites Feld statt Parameter-Property: die ist TypeScript-only-Syntax und faellt
      // unter `erasableSyntaxOnly` (TS1294) — vitest schluckt sie, `npm run build` nicht.
      cb: () => void
      constructor(cb: () => void) { this.cb = cb }
      observe() { rueckrufe.push(this.cb) }
      disconnect() {}
    })
    const holen = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
      fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
      const knopf = screen.getByRole('button', { name: /Reinhören: b\.mp3/ })
      fireEvent.click(knopf)

      // Positivkontrolle: ohne angemeldeten Beobachter wuerde der Test nichts messen.
      expect(rueckrufe.length).toBeGreaterThan(0)
      expect(holen).not.toHaveBeenCalled()      // vor der Groessenaenderung passiert nichts
      rueckrufe.forEach(cb => cb())

      expect(holen.mock.instances).toContain(knopf)
      expect(holen.mock.calls[holen.mock.instances.indexOf(knopf)][0])
        .toEqual({ block: 'nearest' })

      /* Und nach einem Schrittwechsel wieder: 2 → 3 → 2 baut eine NEUE `<ul>`, und der
         Beobachter muss ihr folgen. Mit einem `useRef` statt des Callback-Refs bliebe er am
         alten, abgehaengten Element und die Nachfuehrung waere still tot (CodeRabbit-CLI). */
      const vorher = rueckrufe.length
      fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
      fireEvent.click(screen.getByRole('button', { name: /Zurück/ }))
      expect(rueckrufe.length).toBeGreaterThan(vorher)

      holen.mockClear()
      rueckrufe.slice(vorher).forEach(cb => cb())
      expect(holen.mock.instances)
        .toContain(screen.getByRole('button', { name: /Reinhören: b\.mp3/ }))
    } finally {
      holen.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('legt den Fokus zurueck, wenn der Hoerbalken schliesst', () => {
    /* Der ✕ des Balkens ist der Zwilling des Entfernen-✕ aus PR #310: er nimmt das Element
       weg, auf dem der Fokus steht. Ohne Griff faellt der auf <body>, und Radix zieht ihn an
       den Dialoganfang — weit weg von der Zeile, mit der man gerade gearbeitet hat. */
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Reinhören: b\.mp3/ }))
    fireEvent.click(screen.getByTestId('hoerbalken'))

    // Der Play-Knopf DIESER Zeile, nicht irgendeiner: `findIndex` muss den Schluessel treffen.
    expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: /Reinhören: b\.mp3/ }))
  })

  it('gibt BEIDEN Rollflaechen des Dialogs dieselbe Leiste', () => {
    /* Der aeussere Behaelter traegt die Schritte 2 und 3, die Liste den Schritt 1. Ohne die
       Klasse an beiden stuende in demselben Fenster eine indigofarbene neben einer grauen
       Systemleiste — je nachdem, auf welchem Schritt man gerade ist. */
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    const liste = screen.getByText('a.mp3').closest('ul')!
    const aussen = liste.closest('[class*="overflow-y-auto"]:not(ul)')!
    expect(aussen.className).toContain('rollbalken')
    expect(liste.className).toContain('rollbalken')
  })
})
