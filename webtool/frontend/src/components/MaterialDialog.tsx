import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Ablageflaeche } from '@/components/Ablageflaeche'
import { HoerBalken } from '@/components/HoerBalken'
import { MaterialZeile } from '@/components/MaterialZeile'
import { alleGueltig, ergaenzen, sprachText, sprecherText,
         type Aufnahme } from '@/lib/materialZeilen'
import { sprecherWahl } from '@/lib/sprecher'
import { HttpFehler, SendeZeitlimit, fetchUrls, uploadAudio } from '@/lib/api'
import type { StartJob } from '@/lib/types'

const SCHRITTE = ['Material wählen', 'Einstellen', 'Prüfen & starten']

/** Der Dialog „Material hinzufügen": drei waagrechte Schritte (H1), Sprache und
 *  Sprecherzahl je Aufnahme (L2/S1), ein Hörbalken unten (P1).
 *
 *  Der Zustand liegt hier und nicht in den Zeilen — das ist die Bedingung, unter der ein
 *  Schrittwechsel nichts verliert (Spec 6.3).
 */
export function MaterialDialog({ project, offen, vorbelegteDateien, sprachChoices,
                                 projektSprache, sprecherMax, onSchliessen, onFertig }: {
  project: string
  offen: boolean
  vorbelegteDateien?: File[]
  sprachChoices: { id: string; label: string; hint?: string }[]
  projektSprache: string
  sprecherMax: number
  onSchliessen: () => void
  onFertig: (job?: StartJob, art?: 'transcribe' | 'fetch') => void
}) {
  const [schritt, setSchritt] = useState(1)
  const [zeilen, setZeilen] = useState<Aufnahme[]>([])
  const [urlText, setUrlText] = useState('')
  const [quelle, setQuelle] = useState<'datei' | 'link'>('datei')
  const [laeuft, setLaeuft] = useState(false)
  const [klingt, setKlingt] = useState<string | null>(null)
  const laufNr = useRef(0)

  // Der Projektwechsel verwirft ALLES — auch den Schritt und den Abspieler. React Router
  // baut dieses Element beim Parameterwechsel nicht neu auf; ohne Reset landeten Projekt As
  // Dateien samt getippter Zahl in Projekt B, still und mit Erfolgsmeldung.
  // `laufNr.current++` gehoert HIERHER und nicht nur ins Abbrechen: sonst schreibt der
  // laufende Upload aus Projekt A sein Ergebnis in den Dialog von Projekt B.
  useEffect(() => {
    laufNr.current++
    setSchritt(1); setZeilen([]); setUrlText(''); setKlingt(null); setLaeuft(false)
  }, [project])

  // Vorbelegte Dateien kommen aus dem Drop-Overlay der Arbeitsflaeche. `ergaenzen` statt
  // `setZeilen`: ein zweiter Wurf auf denselben offenen Dialog haengt an, statt die schon
  // getippten Zahlen zu loeschen.
  useEffect(() => {
    if (!vorbelegteDateien?.length) return
    setZeilen(alt => {
      const neu = ergaenzen(alt, vorbelegteDateien.map(zeileAus))
      // Stillschweigend weggefallene Dubletten sind ein toter Klick: der Nutzer legt zwei
      // gleichnamige Dateien ab und sieht eine Zeile.
      const weg = alt.length + vorbelegteDateien.length - neu.length
      if (weg > 0) toast.info(`${weg} Aufnahme${weg > 1 ? 'n' : ''} war${weg > 1 ? 'en' : ''} schon in der Liste.`)
      return neu
    })
    // Ein Drop darf nicht in der Zusammenfassung landen: wurde der Dialog auf Schritt 3
    // verlassen, saehe der Nutzer Sprache und Sprecherzahl der neuen Aufnahmen NIE.
    setSchritt(s => Math.min(s, 2))
  }, [vorbelegteDateien])

  // Zeilen, die VOR der Antwort des Einstellungs-GET entstanden sind, tragen `sprache: ''`
  // und zeigen einen Waehler ohne Optionen. Kommt die Antwort nach, ziehen sie nach.
  useEffect(() => {
    if (!projektSprache) return
    setZeilen(alt => alt.some(z => !z.sprache)
      ? alt.map(z => z.sprache ? z : { ...z, sprache: projektSprache })
      : alt)
  }, [projektSprache])

  function zeileAus(d: File): Aufnahme {
    return { schluessel: d.name, anzeige: d.name, sprecherText: '',
             sprache: projektSprache, datei: d }
  }

  const setzeSprecher = (schluessel: string, text: string) =>
    setZeilen(alt => alt.map(z => z.schluessel === schluessel ? { ...z, sprecherText: text } : z))
  const setzeSprache = (schluessel: string, id: string) =>
    setZeilen(alt => alt.map(z => z.schluessel === schluessel ? { ...z, sprache: id } : z))

  const urlsUebernehmen = () => {
    const neu = urlText.split('\n').map(u => u.trim()).filter(Boolean)
      .map(u => ({ schluessel: u, anzeige: u, sprecherText: '', sprache: projektSprache }))
    if (!neu.length) return
    setZeilen(alt => ergaenzen(alt, neu))
    setSchritt(2)
  }

  const starten = async () => {
    const meiner = ++laufNr.current
    setLaeuft(true); setKlingt(null)          // Ton hoert auf, BEVOR Zeilen verschwinden
    const gescheitert: Aufnahme[] = []
    let job: StartJob | undefined
    let art: 'transcribe' | 'fetch' = 'transcribe'

    // Verzweigt wird JE ZEILE, nicht nach dem zuletzt geklickten Reiter. `ergaenzen` haengt
    // an, und `quelle` ist eine Ansicht des Reiters — beides zusammen liess Dateien und
    // Links in EINER Liste landen, die dann ueber EINEN Sendeweg ging: die URL-Zeile lief in
    // `uploadAudio(…, z.datei!)` mit `undefined` (422), oder ein Dateiname ging als URL an
    // `/fetch` (400). Vorher war die Vermischung strukturell unmoeglich — zwei Komponenten,
    // zwei Listen. Das ist der Weg, den dieser Umbau NEU aufgemacht hat.
    const links = zeilen.filter(z => !z.datei)
    const hoch = zeilen.filter(z => z.datei)

    if (links.length) {
      try {
        // Die volle Liste, auch wenn alle gleich sind: sie ist index-parallel zu `urls` und
        // muss ihre Plaetze halten. `sprache` bleibt an Position 3 der Signatur.
        //
        // Der Platz wird mit `null` gehalten, NICHT mit dem Projektwert. Ein mitgeschickter
        // Wert machte aus JEDER importierten Datei einen Override, der spaeteren Aenderungen
        // des Projekt-Standards nicht mehr folgt (#166/#234). `|| null` faengt zusaetzlich
        // den Fall ab, dass die Einstellungen noch nicht geladen waren: `''` ist fuer
        // `pruef_fehler` keine gueltige Sprache und endete in einem 400.
        const res = await fetchUrls(project, links.map(z => z.schluessel),
                                    links.map(z => z.sprache === projektSprache ? null : (z.sprache || null)),
                                    undefined,
                                    links.map(z => sprecherWahl(z.sprecherText, sprecherMax) ?? null))
        job = res; art = 'fetch'
        // Laeuft schon ⇒ die Zeilen BLEIBEN stehen (der Nutzer versucht es spaeter noch
        // einmal); die Meldung dazu macht die Arbeitsflaeche in `onFertig`.
        if (!res.started) gescheitert.push(...links)
      } catch (e) {
        // OHNE diesen Zweig verlaesst die Ausnahme `starten`: `setLaeuft(false)` liefe nie,
        // der Knopf staende fuer immer auf „startet…", und weil dieser Dialog seinen Zustand
        // AUFBEWAHRT, heilt auch Schliessen und Wiederoeffnen ihn nicht. Ausloeser ist kein
        // Sonderfall, sondern der Alltag: eine nicht unterstuetzte URL (400 aus `check_url`).
        toast.error(`Video-Links: ${(e as Error)?.message || 'Import fehlgeschlagen'}`)
        // Nach einem gerissenen ZEITLIMIT die Links NICHT erneut anbieten — das ist der
        // Zustand, den #299 hier neu moeglich gemacht hat. Der Server kann den Job laengst
        // gestartet haben; ein zweiter Klick faengt sich anders als beim Upload KEINEN 409,
        // sondern laedt dieselben Videos noch einmal (`unique_base` → `Video-2.m4a`) und
        // schickt sie durch Transkription und Korrektur. Die Zeilen stehenzulassen waere
        // ausserdem ein Widerspruch zum eigenen Toast („moeglicherweise trotzdem
        // gestartet"). Am TYP unterschieden, nicht am Text — dieselbe Regel wie beim 409.
        if (!(e instanceof SendeZeitlimit)) gescheitert.push(...links)
      }
    }

    for (const z of hoch) {
      try {
        // `?? undefined`, NICHT `?? null`: leer heisst „Formfeld weglassen" (automatisch).
        const wahl = sprecherWahl(z.sprecherText, sprecherMax) ?? undefined
        // Die Sprache geht nur mit, wenn sie vom Projektwert ABWEICHT. Ein mitgeschickter
        // Wert, der ohnehin dem Projekt entspricht, machte daraus einen echten Override —
        // und die Datei zoege bei einer spaeteren Aenderung des Projekt-Standards nicht mehr
        // mit (#234/#166).
        const spr = z.sprache === projektSprache ? '' : z.sprache
        const r = await uploadAudio(project, z.datei!, spr, undefined, wahl)
        if (r.job_id) { job = { job_id: r.job_id, started: !!r.started }; art = 'transcribe' }
      } catch (e) {
        // „existiert bereits" ist KEIN wiederholbarer Fehlschlag — ein zweiter Versuch
        // endete wieder mit 409. Alles Stehenlassen liefe beim naechsten Klick in lauter 409er,
        // bedingungsloses Leeren waere Datenverlust.
        const grund = (e as Error)?.message
        // Am STATUS unterscheiden, nicht am Meldungstext: `app.py` antwortet mit 409, und
        // eine Umformulierung des `detail` liesse die Regex still auf den anderen Zweig
        // fallen — ohne dass ein Test rot wird, weil die Attrappe denselben Text liefert
        // (CodeRabbit-Bot). Der Text bleibt als Rueckfall fuer Aufrufer ohne Status.
        const schonDa = e instanceof HttpFehler ? e.status === 409 : /existiert bereits/.test(grund ?? '')
        if (!schonDa) {
          gescheitert.push(z)
          // Einen Grund nennen, auch wenn der Fehler keinen traegt: eine Zeile, die einfach
          // stehenbleibt, sieht aus wie ein vergessener Klick.
          toast.error(`${z.anzeige}: ${grund || 'Hinzufügen fehlgeschlagen'}`)
        }
      }
    }

    if (meiner === laufNr.current) {
      setLaeuft(false); setZeilen(gescheitert)
      // Zurueck in die Liste, wenn etwas stehenblieb: die Zusammenfassung zeigt nur Zahlen,
      // und der Nutzer muss SEHEN, welche Aufnahme es nicht geschafft hat, bevor er den
      // zweiten Versuch startet. Ist NICHTS stehengeblieben, ist der Dialog fertig — er
      // bleibt sonst mit leerer Liste offen (im Browser gemessen).
      if (gescheitert.length) setSchritt(2)
      // Das URL-Feld MUSS mit geleert werden: der Dialog bewahrt seinen Zustand auf, die eben
      // importierten Links staenden beim naechsten Oeffnen wieder da, und ein Klick auf
      // „Holen" liefe in einen zweiten Download derselben Videos — `ergaenzen` schuetzt
      // innerhalb der Liste, nicht gegen einen bereits erledigten Lauf.
      // Zurueck auf Schritt 1: der Zustand wird aufbewahrt, ein spaeteres Oeffnen landete
      // sonst in einer Zusammenfassung ueber NICHTS (im Test aufgefallen).
      else { setUrlText(''); setSchritt(1); onSchliessen() }
    }
    onFertig(job, art)      // laeuft IMMER — der Workspace muss seine Liste nachziehen
  }

  if (!offen) return null

  const gueltig = alleGueltig(zeilen, sprecherMax)
  const klingende = zeilen.find(z => z.schluessel === klingt)
  const labels = Object.fromEntries(sprachChoices.map(c => [c.id, c.label]))
  // Der Hinweis erscheint NUR, wenn der Projekt-Standard ueberhaupt gewinnen kann. `auto`
  // ist die einzige id ohne Whisper-Code (`sprachen.py`), und der Satz waere sonst eine
  // Zusage ohne Gegenstand. Sollte je eine zweite solche id dazukommen, faellt es hier auf.
  const standardGreift = projektSprache !== 'auto'
  const autoDabei = zeilen.some(z => z.sprache === 'auto')

  return (
    <Dialog open={offen} onOpenChange={o => { if (!o) onSchliessen() }}>
      {/* Die Hoehe haengt am GANZEN Dialog, nicht an der Liste darin — und das ist der
          Unterschied, den erst der Browser gezeigt hat: mit `min-h` auf der Liste stand der
          Dialog bei einem 532-px-Fenster 540 px hoch da, also #283 in eigener Sache (oben und
          unten abgeschnitten, „Los geht's" unerreichbar). Der Rahmen (Kopf, Schrittleiste,
          Knopfzeile, Innenabstand) misst 168 px, deshalb 648 = 480 + 168: auf einem grossen
          Schirm bleiben Marcus' 480 px fuer die Liste, auf einem kleinen greift 90vh und die
          Liste schrumpft mit, statt den Dialog aus dem Fenster zu schieben.
          Fuer ein gegebenes Fenster ist das weiterhin eine KONSTANTE — der Rahmen springt
          beim Schrittwechsel nicht (der Grund fuer H1s feste Hoehe). */}
      <DialogContent className="flex h-[min(648px,90vh)] flex-col sm:max-w-3xl">
        <DialogHeader><DialogTitle>Material hinzufügen</DialogTitle></DialogHeader>

        <ol className="flex items-center gap-2 text-xs text-muted-foreground">
          {SCHRITTE.map((s, i) => (
            <li key={s} aria-current={schritt === i + 1 ? 'step' : undefined}
              className={schritt === i + 1 ? 'font-medium text-foreground' : undefined}>
              {i + 1}. {s}{i < SCHRITTE.length - 1 ? ' ›' : ''}
            </li>
          ))}
        </ol>

        {/* `relative` ist Pflicht (#209): ein overflow-Behaelter klemmt absolut positionierte
            Nachfahren nur, wenn er selbst ihr Bezugsrahmen ist. Der Quellbaum-Waechter hat
            genau diese Zeile rot gemacht — zum zweiten Mal in diesem PR. */}
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          {schritt === 1 && (
            <div className="space-y-3">
              <div role="tablist" className="flex gap-1">
                {([['datei', 'Dateien'], ['link', 'Links']] as const).map(([id, text]) => (
                  <button key={id} type="button" role="tab" aria-selected={quelle === id}
                    onClick={() => setQuelle(id)}
                    className={quelle === id
                      ? 'rounded-md bg-accent px-3 py-1.5 text-sm font-medium'
                      : 'rounded-md px-3 py-1.5 text-sm text-muted-foreground'}>
                    {text}
                  </button>
                ))}
              </div>
              {quelle === 'datei'
                ? <Ablageflaeche gesperrt={laeuft}
                    onDateien={ds => setZeilen(alt => ergaenzen(alt, ds.map(zeileAus)))} />
                : (
                  <div className="space-y-2">
                    <Textarea aria-label="Video-URLs" rows={3} value={urlText}
                      onChange={e => setUrlText(e.target.value)}
                      placeholder="YouTube- oder Instagram-Reel-Links, eine URL pro Zeile" />
                    <Button type="button" onClick={urlsUebernehmen}>Holen</Button>
                  </div>
                )}
              {zeilen.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {zeilen.length} {zeilen.length === 1 ? 'Aufnahme' : 'Aufnahmen'} gewählt
                </p>
              )}
            </div>
          )}

          {schritt === 2 && (
            <div className="space-y-2">
              {/* EINMAL statt je Zeile (#305): der `title` an der Zeile erreicht nur die
                  Maus, und bei zehn Aufnahmen staende zehnmal „Projekt-Standard" ohne
                  Grund daneben. Erreichbar, solange der Einstellungs-GET laeuft (kurz)
                  und nach einem gescheiterten GET (dauerhaft) — die Zeilen zeigen dann
                  statt eines leeren Waehlers den Projekt-Standard an.
                  Nur bei leerer Auswahl: ein Hinweis, der immer dasteht, ist als
                  Daueralarm derselbe Schaden von der anderen Seite. */}
              {sprachChoices.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Die Sprachauswahl steht gerade nicht zur Verfügung — für alle Aufnahmen
                  gilt der Projekt-Standard. Nachträglich änderbar im ⋯-Menü der Aufnahme.
                </p>
              )}
              {/* Kein eigener Bildlauf mehr: seit der Dialog seine Hoehe deckelt und sein
                  Inhaltsbereich scrollt, waeren das zwei Bildlaufleisten ineinander
                  (CodeRabbit-CLI). Die Hoehe verwaltet der Dialog. */}
              <ul className="space-y-1.5">
                {zeilen.map(z => (
                  <MaterialZeile key={z.schluessel} zeile={z} sprachChoices={sprachChoices}
                    sprecherMax={sprecherMax} hoerbar={!!z.datei} klingt={klingt === z.schluessel}
                    gesperrt={laeuft} onSprecher={setzeSprecher} onSprache={setzeSprache}
                    onHoeren={s => setKlingt(a => a === s ? null : s)} />
                ))}
              </ul>
              <HoerBalken datei={klingende?.datei ?? null} anzeige={klingende?.anzeige ?? ''}
                onSchliessen={() => setKlingt(null)} />
            </div>
          )}

          {schritt === 3 && (
            <div className="space-y-1.5 text-sm">
              <p>{zeilen.length} {zeilen.length === 1 ? 'Aufnahme' : 'Aufnahmen'}</p>
              <p className="text-muted-foreground">Sprecher: {sprecherText(zeilen, sprecherMax)}</p>
              <p className="text-muted-foreground">Sprache: {sprachText(zeilen, labels)}</p>
              <p className="text-muted-foreground">
                Danach läuft die Transkription, dann die Korrektur — automatisch.
              </p>
              {autoDabei && (
                <p className="text-muted-foreground">
                  „Automatisch“: Whisper erkennt die Sprache selbst.
                  {/* `||`, nicht `??` — der Zwilling des Lochs, das `sprachText` gerade bekommen hat
                      (#305): bei leerem `projektSprache` stuende hier „gilt der Projekt-Standard
                      „".". Heute nicht erreichbar (`autoDabei` braucht eine Zeile mit `'auto'`,
                      und die entsteht nur an einem Waehler, den es bei leeren `sprachChoices`
                      nicht gibt) — es ist Haertung, aber genau die Form „an EINER Stelle
                      behoben, nicht die Klasse". Ein Zeichen. */}
                  {standardGreift && ` Wird Deutsch erkannt, gilt der Projekt-Standard „${labels[projektSprache] || projektSprache || 'Projekt-Standard'}“.`}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          {/* Waehrend des Laufs heisst der Knopf „Schliessen": er bricht NICHTS ab — die
              Upload-Schleife laeuft weiter, die Dateien landen im Projekt. „Abbrechen" waere
              dort ein Versprechen, das er nicht einloest.
              Gesperrt wird er NIE. Die Begruendung hat sich mit #299 nur verschoben, nicht
              erledigt: `uploadAudio`/`fetchUrls` haben jetzt ein Zeitlimit, aber es waechst
              mit der Datei und reicht bei einer grossen Aufnahme in die Dutzende Minuten.
              Als einziger Rueckweg aus einer haengenden Verbindung bleibt der Knopf also
              genauso noetig wie vorher — das Limit raeumt den REQUEST ab, nicht die
              Wartezeit des Nutzers. */}
          <Button variant="ghost" onClick={onSchliessen}>{laeuft ? 'Schliessen' : 'Abbrechen'}</Button>
          {schritt > 1 && (
            <Button variant="outline" disabled={laeuft}
              onClick={() => setSchritt(s => s - 1)}>Zurück</Button>
          )}
          {schritt < 3 && (
            <Button disabled={!zeilen.length || !gueltig || laeuft}
              onClick={() => setSchritt(s => s + 1)}>Weiter</Button>
          )}
          {schritt === 3 && (
            <Button disabled={laeuft || !zeilen.length} onClick={starten}>
              {laeuft ? 'startet…' : 'Los geht’s'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
