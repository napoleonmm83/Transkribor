import { useEffect, useId, useRef, useState } from 'react'
import { FileAudio, Link2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Ablageflaeche } from '@/components/Ablageflaeche'
import { HoerBalken } from '@/components/HoerBalken'
import { MaterialZeile } from '@/components/MaterialZeile'
import { alleGueltig, ergaenzen, groesseText, sprachText, sprecherText,
         type Aufnahme } from '@/lib/materialZeilen'
import { sprecherWahl } from '@/lib/sprecher'
import { autoHinweis } from '@/lib/autoHinweis'
import { HttpFehler, SendeZeitlimit, fetchUrls, uploadAudio } from '@/lib/api'
import type { StartJob } from '@/lib/types'

const SCHRITTE = ['Material wählen', 'Einstellen', 'Prüfen & starten']
/** Die Reiter als Liste, damit Pfeiltasten und Umlauf ueber den INDEX rechnen koennen
 *  statt ueber ein zweites `if`. Kommt ein dritter Reiter dazu, traegt ihn beides. */
const QUELLEN = [['datei', 'Dateien'], ['link', 'Links']] as const

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
  sprachChoices: { id: string; label: string; hint?: string; dialekt: boolean }[]
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
  // Fuer die Ids der Entfernen-Knoepfe: der Fokus springt beim Entfernen auf den Nachbarn,
  // und `document.getElementById` ist dafuer der Weg, den die Reiterleiste schon geht.
  // NICHT der `schluessel` — der traegt Leerzeichen („Interview Mueller.mp3“).
  const listeId = useId()
  // STATE, kein `useRef`: der Effekt unten haengt an diesem Knoten, und ein Ref aendert
  // keine Abhaengigkeit. Beim Schrittwechsel (2 → 3 → 2) baut React eine NEUE `<ul>` — mit
  // einem Ref liefe der Effekt nicht erneut und der Beobachter bliebe am alten, laengst
  // abgehaengten Element (CodeRabbit-CLI). Ein Callback-Ref auf `setListe` ist das
  // idiomatische Mittel dafuer.
  const [liste, setListe] = useState<HTMLUListElement | null>(null)

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
  // `setKlingt` geht MIT: eine klingende Zeile, die aus der Liste faellt, ist derselbe Fall
  // wie der Teil-Fehlschlag in `starten` — sonst bleibt ihr Schluessel stehen, und dieselbe
  // Datei, spaeter erneut hinzugefuegt, steht in Schritt 2 wieder als „klingend“ da: der
  // Hoerbalken oeffnet sich unaufgefordert und dekodiert die ganze Datei. ABGESPIELT wird
  // dabei nichts — `Waveform` ruft `play()` ausschliesslich aus `steuerung.toggle`, also aus
  // einem Klick (gelesen: `Waveform.tsx:100-113`). Eine fruehere Fassung dieses Kommentars
  // behauptete eine Wiedergabe; das war gemessen falsch.
  //
  // Die URL geht ebenfalls mit — und das ist der Weg, den erst dieser Knopf aufgemacht hat.
  // Vorher liess sich in Schritt 1 keine Zeile entfernen; jetzt zeigt das Textfeld sie
  // weiter an, und ein Klick auf „Holen“ macht die Entfernung rueckgaengig UND springt
  // ungefragt auf Schritt 2. Dieselbe Regel steht in `starten` („Das URL-Feld MUSS mit
  // geleert werden“), dort fuer den ganzen Lauf. Bei einer Datei-Zeile trifft der Filter
  // nie etwas: ihr Schluessel ist ein Dateiname und steht in keinem URL-Feld.
  const entfernen = (schluessel: string) => {
    setZeilen(alt => alt.filter(z => z.schluessel !== schluessel))
    setKlingt(a => a === schluessel ? null : a)
    setUrlText(t => t.split('\n').filter(u => u.trim() !== schluessel).join('\n'))
  }

  // Der Hoerbalken nimmt der Liste beim Oeffnen rund die Haelfte ihrer Hoehe (gemessen
  // 354 → 147 px), waehrend der Browser `scrollTop` behaelt: die eben angeklickte Zeile
  // rutscht unter die Kante — samt Fokusring und dem `aria-pressed`, das die Wirkung des
  // Klicks anzeigt. Ab der fuenften von acht Zeilen trifft das jede.
  //
  // Beobachtet wird die GROESSE der Liste, nicht der Klick. Ein `requestAnimationFrame` am
  // Klick war der erste Versuch und ist im Browser widerlegt: die Liste schrumpft erst,
  // wenn wavesurfer fertig dekodiert hat — der Rahmen danach sieht ein unveraendertes
  // Layout und `block: 'nearest'` tut folgerichtig nichts.
  // `nearest` bleibt trotzdem richtig: solange die Zeile im Bild steht, ist der Aufruf ein
  // No-op, es springt also nichts. Und weil die Groesse auch beim Fensterwechsel faellt,
  // bleibt die klingende Zeile dabei gleich mit sichtbar.
  useEffect(() => {
    if (!klingt || !liste || typeof ResizeObserver === 'undefined') return
    const beobachter = new ResizeObserver(() => {
      const i = zeilen.findIndex(z => z.schluessel === klingt)
      if (i >= 0) document.getElementById(`${listeId}-play-${i}`)?.scrollIntoView({ block: 'nearest' })
    })
    beobachter.observe(liste)
    return () => beobachter.disconnect()
  }, [klingt, zeilen, listeId, liste])

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
  const autoDabei = zeilen.some(z => z.sprache === 'auto')
  // Der Satz kommt seit #301 aus `autoHinweis` — EINE Quelle fuer Datei-Dialog,
  // Projekt-Dialog und diese Zusammenfassung. Sie deckt nebenbei den #305-Fall mit ab
  // (leerer `projektSprache` ⇒ „es gilt, was Whisper erkennt"), der hier bis eben als
  // `|| 'Projekt-Standard'` von Hand nachgebaut war.
  const hinweis = autoDabei ? autoHinweis('auto', projektSprache, sprachChoices) : null

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
      <DialogContent className="rahmen-animiert flex h-[min(648px,90vh)] flex-col sm:max-w-3xl">
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
        {/* `rollbalken` auch hier: sonst traegt derselbe Dialog in Schritt 1 eine
            indigofarbene und in Schritt 2 die graue Systemleiste. */}
        <div className="rollbalken relative min-h-0 flex-1 overflow-y-auto">
          {/* Schritt 1 traegt seine Hoehe selbst (`h-full` + Spalte): Reiterleiste und
              Ablageflaeche bleiben stehen, GEROLLT wird nur die Auswahlliste. Vorher rollte
              der ganze Bereich, und wer zehn Dateien gewaehlt hatte, schob beim Suchen einer
              einzelnen Zeile das Drop-Ziel aus dem Bild — also genau die Flaeche, auf der
              die naechste Datei landen soll.
              Der aeussere Behaelter behaelt sein `overflow-y-auto` fuer die Schritte 2 und 3;
              oberhalb der Kippkante unten greift es in Schritt 1 nicht mehr, weil dieser
              Block dann nicht hoeher wird als sein Platz — genau der Grund, aus dem Schritt 2
              seinen eigenen Bildlauf wieder verloren hat (CodeRabbit-CLI).
              **Die Kippkante ist gemessen, nicht geschaetzt** (Reviewer-Replik gegen das
              gebaute Bundle, an der Browsermessung kreuzvalidiert): ab **378 px**
              Fensterhoehe faellt die Liste auf 0 (Links-Reiter: 398 px), und im Links-Reiter
              schon bei vollem Fenster ab ~15 Adressen im Textfeld. Eine erste Fassung dieses
              Kommentars schrieb „etwa 300 px … nicht schlechter als vorher" — beides falsch:
              vorher war JEDE Zeile ueber den aeusseren Behaelter erreichbar, nachher keine.
              Deshalb traegt die Liste unten einen Boden (`min-h-24`), und unterhalb der Kante
              rollen bewusst BEIDE Behaelter: zwei Leisten sind besser als unerreichbarer
              Inhalt. */}
          {schritt === 1 && (
            <div className="flex h-full flex-col gap-3">
              {/* Von Hand nach dem APG-Muster (#304) statt shadcn-`Tabs`: das braechte eine
                  Radix-Abhaengigkeit fuer zwei Reiter, und die fehlenden Attribute sind
                  billiger als sie.
                  **Roving Tabindex ist eine Verhaltensaenderung, kein Zusatz:** vorher tabbte
                  man durch BEIDE Knoepfe, jetzt ist die Leiste EIN Halt und man navigiert
                  darin mit Pfeilen. Ohne ihn waere die Pfeiltasten-Navigation ein zweiter,
                  konkurrierender Weg statt des vorgesehenen. */}
              <div role="tablist" aria-label="Art des Materials" className="flex gap-1">
                {QUELLEN.map(([id, text], i) => (
                  <button key={id} type="button" role="tab" id={`mat-reiter-${id}`}
                    aria-selected={quelle === id}
                    // NUR am aktiven Reiter: gerendert wird ein einziges Panel, der inaktive
                    // zeigte sonst auf eine Id, die es nicht gibt — derselbe Fehler, den
                    // #304 behebt, nur verschoben. Gefunden hat das der Browser-Test, nicht
                    // die Unit-Tests: die prueften den AKTIVEN Reiter und blieben gruen.
                    // Kein `aria-controls` ist besser als eines ins Leere: ein Verweis auf
                    // eine nicht existierende Id ist stumm — das folgt schon aus ARIA, ohne
                    // dass man das APG dafuer bemuehen muesste.
                    aria-controls={quelle === id ? `mat-panel-${id}` : undefined}
                    tabIndex={quelle === id ? 0 : -1}
                    onClick={() => setQuelle(id)}
                    onKeyDown={e => {
                      // `Home`/`End` gehoeren zum Muster; ohne sie ist die Leiste bei mehr
                      // als zwei Reitern eine Klickstrecke.
                      const ziel = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1
                                 : e.key === 'Home' ? 0 : e.key === 'End' ? QUELLEN.length - 1
                                 : null
                      if (ziel === null) return
                      e.preventDefault()
                      // Umlauf: am Ende der Leiste stehenzubleiben ist ein toter Tastendruck.
                      const n = (ziel + QUELLEN.length) % QUELLEN.length
                      setQuelle(QUELLEN[n][0])
                      document.getElementById(`mat-reiter-${QUELLEN[n][0]}`)?.focus()
                    }}
                    className={quelle === id
                      ? 'rounded-md bg-accent px-3 py-1.5 text-sm font-medium'
                      : 'rounded-md px-3 py-1.5 text-sm text-muted-foreground'}>
                    {text}
                  </button>
                ))}
              </div>
              {/* Das Panel, das die Reiter mit `aria-controls` ankuendigen. Es wird
                  UMGEHAENGT statt beide zu rendern — `id` und `aria-labelledby` folgen dem
                  aktiven Reiter, und ein verstecktes zweites Panel waere ein zweiter
                  Textbereich im Baum, den die Suche und der Tabstopp mitzaehlen. */}
              <div role="tabpanel" id={`mat-panel-${quelle}`}
                aria-labelledby={`mat-reiter-${quelle}`}>
                {quelle === 'datei'
                  ? <Ablageflaeche gesperrt={laeuft}
                      onDateien={ds => setZeilen(alt => ergaenzen(alt, ds.map(zeileAus)))} />
                  : (
                    <div className="space-y-2">
                      {/* `max-h-48`: die shadcn-`Textarea` traegt `field-sizing-content`
                          ohne Obergrenze und waechst 20 px je Zeile — bei 20 Adressen 460 px,
                          womit sie ihren eigenen „Holen"-Knopf unter die Kante schiebt. Der
                          Boden an der Liste (C1) deckt den Fall ohnehin; das hier ist die
                          Ursache statt der Wirkung, und es gilt fuer jedes Fenster. */}
                      <Textarea aria-label="Video-URLs" rows={3} value={urlText}
                        className="max-h-48"
                        onChange={e => setUrlText(e.target.value)}
                        placeholder="YouTube- oder Instagram-Reel-Links, eine URL pro Zeile" />
                      <Button type="button" onClick={urlsUebernehmen}>Holen</Button>
                    </div>
                  )}
              </div>
              {/* Vorher stand hier NUR die Zahl („3 Aufnahmen gewählt"), grau und klein — wer
                  mehrere Dateien auf einmal waehlte, sah bis Schritt 2 nicht, WELCHE es
                  geworden sind, und ein Fehlgriff war bis dahin nur ueber „Abbrechen"
                  zurueckzunehmen. Der Entfernen-Knopf gehoert deshalb zur Sichtbarkeit
                  dazu: eine Liste, die einen Fehler zeigt, aber nicht korrigieren laesst,
                  verschiebt das Problem nur nach vorn.
                  Das Symbol unterscheidet Datei und Link — beide Arten landen in DERSELBEN
                  Liste (`ergaenzen`), und `starten` verzweigt je Zeile danach. */}
              {/* Die Zaehlzeile steht AUSSERHALB der Bedingung und ist DAUERHAFT im Baum
                  (#311). Der ✕ entfernt eine Zeile — sichtbar sofort, hoerbar bisher nicht:
                  fuer Tastaturnutzer traegt der Fokuswechsel die Ansage (er springt auf den ✕
                  der Nachbarzeile, deren `aria-label` den Namen fuehrt), fuer
                  SPRACHSTEUERUNG („klick Podium.wav entfernen") passiert akustisch nichts.
                  **Warum herausgehoben statt bloss `role="status"` angehaengt:** eine
                  Live-Region, die erst MIT ihrem Inhalt in den Baum kommt, wird von
                  Screenreadern oft nicht mehr beobachtet — sie muss vorher dastehen und nur
                  ihren Text wechseln. Das ist der Umbau der Bedingung, nicht ein Attribut.
                  Leer kostet sie NICHTS: im Browser gemessen 0 px hoch — ein leerer Block
                  erzeugt keine Zeilenbox, die `text-sm`-Zeilenhoehe greift also gar nicht.
                  (Hier stand zuerst „kostet eine Zeilenhoehe"; das war geraten, nicht
                  gemessen.) `empty:hidden` waere trotzdem der Rueckschritt in genau das
                  Problem — `display:none` ist aus dem Barrierefreiheitsbaum raus, das
                  Wiedereinblenden waere dasselbe Einziehen.
                  jsdom bildet Live-Regionen nicht nach — der Test kann nur Rolle und Text
                  pruefen, die Ansage selbst gehoert in den Browser-Gegencheck. */}
              <p role="status" className="text-sm font-medium">
                {zeilen.length > 0
                  ? `${zeilen.length} ${zeilen.length === 1 ? 'Aufnahme' : 'Aufnahmen'} gewählt`
                  : ''}
              </p>
              {zeilen.length > 0 && (
                <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                  {/* `min-h-0` ist die zweite Haelfte von `flex-1`: ohne es waechst ein
                      Flex-Kind mit seinem Inhalt (Default `min-height: auto`) und das
                      `overflow-y-auto` greift nie — dieselbe Falle wie im Raster der
                      App-Huelle — hier traegt `min-h-24` diese Rolle: es ist der Boden aus
                      C1 UND erlaubt zugleich das Schrumpfen unter die Inhaltshoehe. `min-h-0`
                      daneben waere ein Konflikt auf derselben Eigenschaft, entschieden von der
                      Reihenfolge im gebauten CSS.
                      **Der Boden ist kein Feinschliff, sondern der Fix eines Datenverlusts:**
                      die `<ul>` ist das einzige schrumpfbare Kind der Spalte, fiel also als
                      einzige — bis auf 0 px, und dann fuehrte KEIN Bildlauf mehr zu den Zeilen
                      (auch `scrollIntoView` nicht). Ausgeloest schon bei vollem Fenster durch
                      das mitwachsende URL-Feld: 20 Adressen einfuegen, „Holen", „Zurueck" —
                      und die 20 frisch angelegten Zeilen samt ihrem ✕ waren unerreichbar.
                      96 px ≈ zwei Zeilen; oberhalb von ~420 px Fensterhoehe aendert der Boden
                      nichts (`flex-1` gewinnt).
                      `relative` ist die zweite Haelfte von `overflow-y-auto`:
                      geklemmt werden absolut positionierte Nachfahren nur, wenn der
                      Behaelter ihr Bezugsrahmen ist — die Liste hat heute keine, die
                      Regel gilt aber fuer JEDE Bildlaufflaeche (#209), und der
                      Quellbaum-Waechter hat genau diese Zeile rot gemacht.
                      `pr-1` haelt die Leiste vom ✕ weg. */}
                  <ul className="rollbalken relative min-h-24 flex-1 space-y-1 overflow-y-auto pr-1">
                    {zeilen.map((z, i) => (
                      <li key={z.schluessel}
                        className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm">
                        {z.datei
                          ? <FileAudio className="size-4 shrink-0 text-primary" aria-hidden="true" />
                          : <Link2 className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                        <span className="min-w-0 flex-1 truncate" title={z.anzeige}>{z.anzeige}</span>
                        {/* Nur bei Dateien: eine URL-Zeile hat noch nichts, was eine Groesse
                            haette — heruntergeladen wird erst nach dem Start. */}
                        {z.datei && (
                          <span className="ziffern shrink-0 text-xs text-muted-foreground">
                            {groesseText(z.datei.size)}
                          </span>
                        )}
                        {/* KEIN `disabled={laeuft}`: die Liste wird nie mit `laeuft === true`
                            gerendert — `starten` ist nur vom Schritt-3-Knopf aus erreichbar,
                            „Zurueck“/„Weiter“ sind waehrenddessen gesperrt, und die beiden Wege
                            zurueck auf Schritt 1 setzen `laeuft` im selben Batch auf false.
                            Ein Riegel, den kein Test rot bekommt, ist Dekoration.
                            `p-1.5` statt `p-0.5` ergibt 28 px Zielflaeche: mit 20 px bestuende
                            WCAG 2.2 SC 2.5.8 nur ueber die Abstandsausnahme — knapp fuer die
                            einzige zerstoerende Aktion der Liste. */}
                        <button type="button" id={`${listeId}-${i}`}
                          aria-label={`${z.anzeige} aus der Auswahl entfernen`}
                          onClick={() => {
                            // Sonst faellt der Fokus auf <body>, und Radix' FocusScope zieht ihn
                            // an den Dialoganfang: wer drei Fehlgriffe herausnehmen will, tabbt
                            // sich nach JEDEM Klick neu durch die Liste. Der Nachbarknopf steht
                            // schon im DOM und verschwindet nicht, der Griff wirkt also
                            // synchron — React haengt danach nur eine andere `id` an denselben
                            // Knoten (wiederverwendet ueber `key`). Bei der letzten Zeile der
                            // Vorgaenger, bei der einzigen der aktive Reiter: den gibt es in
                            // Schritt 1 immer.
                            const nachbar = i + 1 < zeilen.length ? `${listeId}-${i + 1}`
                                          : i > 0 ? `${listeId}-${i - 1}` : `mat-reiter-${quelle}`
                            entfernen(z.schluessel)
                            document.getElementById(nachbar)?.focus()
                          }}
                          className="shrink-0 rounded-sm p-1.5 text-muted-foreground hover:text-foreground
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <X className="size-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Schritt 2 traegt seine Hoehe selbst — dieselbe Spalte wie Schritt 1, aus
              demselben Grund: gerollt wird die LISTE, der Hoerbalken steht fest darunter.
              Vorher rollte der ganze Bereich, und die Welle wanderte beim Blaettern aus dem
              Bild — ausgerechnet waehrend sie spielt. */}
          {schritt === 2 && (
            <div className="flex h-full flex-col gap-2">
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
              {/* Hier stand „Kein eigener Bildlauf mehr … waeren das zwei Bildlaufleisten
                  ineinander (CodeRabbit-CLI)". Der Einwand war richtig, seine Bedingung ist
                  aber weggefallen: solange der Block seine Hoehe selbst traegt, rollt der
                  aeussere Behaelter in Schritt 2 nicht mehr mit — es gibt also weiterhin nur
                  EINE Leiste, nur an einer anderen Stelle.
                  **Die Kippkante ist hier eine ANDERE als in Schritt 1**, und „siehe Schritt 1"
                  stand hier zuerst falsch: dort sind es 378 px Fensterhoehe, hier mit offenem
                  Hoerbalken ≈ **513 px** (mit dem Sprachhinweis ≈ 557). Darunter greift der
                  Boden, die Spalte ueberlaeuft und beide Behaelter rollen — bewusst, denn zwei
                  Leisten sind besser als unerreichbarer Inhalt. Was kippt, ist der Boden, NICHT
                  das Selbst-Tragen der Hoehe: das gilt immer.
                  `min-h-24` ist auch hier der Boden aus dem 0-px-Kollaps und ERSETZT
                  `min-h-0` — dieselbe Eigenschaft, und hier ist der Fall naeher: der
                  Hoerbalken erscheint auf Klick und nimmt der Liste auf einen Schlag seine
                  Hoehe weg. */}
              <ul ref={setListe}
                className="rollbalken relative min-h-24 flex-1 space-y-1.5 overflow-y-auto pr-1">
                {zeilen.map((z, i) => (
                  <MaterialZeile key={z.schluessel} zeile={z} sprachChoices={sprachChoices}
                    sprecherMax={sprecherMax} hoerbar={!!z.datei} klingt={klingt === z.schluessel}
                    gesperrt={laeuft} playId={`${listeId}-play-${i}`}
                    onSprecher={setzeSprecher} onSprache={setzeSprache}
                    onHoeren={s => setKlingt(a => a === s ? null : s)} />
                ))}
              </ul>
              {/* AUSSERHALB der Rollflaeche: er soll sichtbar bleiben, waehrend man die
                  Liste durchgeht. `null`, wenn nichts klingt — dann kostet er auch keinen
                  Platz. */}
              <HoerBalken datei={klingende?.datei ?? null} anzeige={klingende?.anzeige ?? ''}
                onSchliessen={() => {
                  // Der ✕ des Balkens ist der Zwilling des Entfernen-✕ aus PR #310: er nimmt
                  // das Element weg, auf dem der Fokus steht, und ohne Griff faellt der auf
                  // <body>. Der Play-Knopf der Zeile ist der richtige Rueckweg — dorthin
                  // wollte der Nutzer ohnehin zurueck. Er bleibt im DOM, der Griff wirkt also
                  // synchron. Dieselbe Frage an der Nachbarstelle gestellt statt nur die
                  // gemeldete zu beheben.
                  const i = zeilen.findIndex(z => z.schluessel === klingt)
                  setKlingt(null)
                  if (i >= 0) document.getElementById(`${listeId}-play-${i}`)?.focus()
                }} />
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
                  {/* Die Bedingung hier war FALSCH und ist gemessen widerlegt: sie lautete
                      `projektSprache !== 'auto'`, also bekam ein englisches Projekt „Wird
                      Deutsch erkannt, gilt der Projekt-Standard Englisch" — nachgemessen an
                      `sprachen.von_whisper_code` gilt dort `de`. Der Vorrang greift NUR, wo
                      sich zwei ids einen Whisper-Code teilen, und das ist ausschliesslich
                      `ch`/`de`. Die Unterscheidung liegt jetzt am `dialekt`-Flag der Tabelle
                      statt an einer hier nachgebauten Regel. */}
                  {/* Der Hinweis ERSETZT den generischen Satz, er haengt sich nicht daran:
                      „…Whisper erkennt die Sprache selbst. Es gilt, was Whisper erkennt."
                      waren zwei Saetze mit derselben Aussage. In den beiden Dialogen traegt
                      der erste Halbsatz von `OHNE`, hier steht er schon davor. */}
                  „Automatisch“: {hinweis ?? 'Whisper erkennt die Sprache selbst.'}
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
