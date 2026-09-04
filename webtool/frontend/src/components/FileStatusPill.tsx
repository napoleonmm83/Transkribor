import { AudioLines, Check, Clock, FileText, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { Erreicht, FilePhase, FileState, GlobalPhase, ProjectFile, Warten } from '@/lib/types'
import { PHASE_LABEL, WARTE_LABEL } from '@/lib/jobPhases'

/**
 * Vorher standen hier Emoji (✓ ↷ ✗ ○ ✎ ●). Die rendern auf jedem System in einer anderen
 * Schrift, erben die Textfarbe nicht (ein rotes ✗ blieb schwarz) und haben keinen Namen fuer
 * Screenreader. lucide liegt ohnehin im Bundle.
 *
 * Farbe traegt hier Bedeutung, deshalb steht neben jeder Farbe ein eigenes Symbol UND ein
 * Wort — Farbe allein waere fuer Farbfehlsichtige kein Signal.
 */
const STATE = {
  // 'Fertig' nimmt sich bewusst zurueck: erledigt ist der Ruhezustand. Das Auge soll zu dem
  // springen, was NICHT fertig ist — ein gruener Haken pro Zeile faerbt die Liste zu und
  // macht den einen Fehlschlag darin unsichtbar.
  // 'Handarbeit behalten', nicht 'Uebersprungen' (#368). Der urspruengliche Befund des Issues
  // — dass auch schon FERTIGE Dateien so markiert wurden — ist entfallen: die Druckform
  // `skip (vorhanden)` gibt es seit dem gestaffelten Lauf (10098e4) nicht mehr, weil
  // `transcribe.py` fertige Aufnahmen schon beim Aufbau seiner `pending`-Liste herausfiltert
  // (`transcribe.py:730`) und fuer sie GAR KEINE Zeile mehr druckt.
  //
  // Uebrig bleiben genau zwei Quellen fuer 'skipped', und beide sind SCHUTZPFADE: `apply: SKIP`
  // und `↷ SKIP` (jobPhases.ts:376/377) fuer `human_edited=true`, fuer eine waehrend des Laufs
  // im Editor angefasste Datei (#278) und fuer eine unlesbare `edit.json` (#190). Das alte Wort
  // verschwieg, dass hier etwas BEWAHRT wurde, und der Vorspul-Pfeil las sich wie „liegen
  // geblieben".
  //
  // GENAUIGKEITSGRENZE, benannt statt uebergangen (kalter Plan-Reviewer): im #190-Fall ist
  // nichts von Hand gemacht worden — dort gilt eine unlesbare Datei ABSICHTLICH als
  // handbearbeitet (`_is_human_edited`: wer die Zusage nicht LESEN kann, darf sie nicht
  // ueberschreiben). Das Etikett sagt dann „bewahrt", obwohl die Datei kaputt ist. Ein eigener
  // dritter Zustand dafuer waere richtiger; er braucht aber ein eigenes Urteil im Parser, und
  // die Schutzwirkung ist in beiden Faellen dieselbe.
  skipped: { icon: ShieldCheck, label: 'Handarbeit behalten', klasse: 'text-muted-foreground' },
  failed: { icon: TriangleAlert, label: 'Fehler', klasse: 'text-destructive' },
} satisfies Record<Exclude<FileState, 'done'>, { icon: typeof Check; label: string; klasse: string }>

const GLOBAL_WAIT: Record<GlobalPhase, string> = {
  glossary: 'Glossar wird erstellt…',
  prep: 'Vorbereiten…',
  diarize: 'Diarisieren…',
  download: 'Herunterladen…',
}

/**
 * Ruhezustand ohne laufenden Job: wie weit ist diese Datei gediehen?
 *
 * has_raw MUSS abgefragt werden. Die alte Kette (edit -> md -> audio) fiel bei einer
 * transkribierten, aber unkorrigierten Datei bis auf 'audio' durch — das Zeichen dafuer war
 * ein nichtssagendes '●', weshalb es nie auffiel. Mit einem echten Namen wird die Luecke zur
 * Falschaussage ("noch nicht transkribiert" ueber eine Datei mit fertigem Transkript).
 *
 * Kein Stift-Symbol: der steht in derselben Zeile als Knopf fuer "korrigieren". Ein Status,
 * der aussieht wie die Schaltflaeche daneben, laedt zum Klicken auf eine Anzeige ein.
 *
 * `erreicht` ist die UNTERGRENZE aus dem laufenden Job (jobPhases). Sie ist noetig, weil `file`
 * hier die aeltere der zwei Quellen ist: die Dateiliste wird NICHT gepollt (`useProjectFiles`),
 * sondern nur bei Job-Ende und wenn der 4-s-Summenpoll `dateien`/`fertig` wechseln sieht — und
 * ein geschriebenes Roh-`<base>.json` aendert KEINEN der beiden Zaehler (app.py:341-369).
 * Genau im Moment des Endurteils (`state==='done'` faellt hierher durch) behauptete die Zeile
 * deshalb „Nur Audio — noch nicht transkribiert" ueber eine fertige Aufnahme. Im Browser
 * gemessen; Gegenprobe: bei laufendem Job allein neu geladen, stand dasselbe Etikett richtig.
 *
 * Nur nach OBEN, nie nach unten: fehlt der Beleg, entscheidet der Schnappschuss wie bisher.
 *
 * GETRAGENE GRENZE, gemessen: am JOBENDE bleibt ein Rest-Ruecksprung. Der Job faellt aus dem
 * `running`-Filter (`erreicht` und `state` sind damit weg), waehrend `onSettled` den
 * Dateilisten-Abruf erst ANSTOESST — dazwischen rendert diese Funktion noch einmal auf dem
 * alten Schnappschuss. Am echten Pfad gemessen (Einzeldatei, Autocorrect aus): „Transkribiert"
 * → „Nur Audio" → „Transkribiert", die mittlere Stufe **13 ms** lang, also unter einem Frame.
 * Nicht behoben, weil die naheliegende Abhilfe — den Beleg ueber die Job-Grenze hinaus halten —
 * ihn genau dort am Leben liesse, wo er falsch werden kann (geloeschte und gleichnamig neu
 * hochgeladene Aufnahme). Gefunden vom kalten Zweitleser, der die Behauptung der Release-Notiz
 * gegen den Code gehalten hat.
 */
function ruhe(file: ProjectFile, erreicht?: Erreicht) {
  if (file.has_edit || erreicht === 'edit') return { icon: Check, label: 'Fertig' }
  if (file.has_md) return { icon: Check, label: 'Export vorhanden' }
  if (file.has_raw || erreicht) return { icon: FileText, label: 'Transkribiert — noch nicht korrigiert' }
  if (file.has_audio) return { icon: AudioLines, label: 'Nur Audio — noch nicht transkribiert' }
  return null
}

export function FileStatusPill({ file, active, pct, detail, state, erreicht, jobRunning, inScope, warten, globalPhase, mitText }: {
  file: ProjectFile
  active?: FilePhase
  pct?: number
  detail?: string
  state?: FileState
  /** Untergrenze aus dem laufenden Job — siehe `ruhe`. Am selben Riegel wie `state`
   *  durchgereicht (`zugelassen`), gilt also nur waehrend eines Laufs.
   *
   *  Dieser Riegel ist heute REDUNDANT, und das ist gemessen (Mutation an beiden
   *  Aufrufstellen: 821 von 821 Tests bleiben gruen): `terminal()` bucht ohnehin nur
   *  zugelassene Basen, und beide Verbraucher mergen nur LAUFENDE Jobs. Er bleibt trotzdem
   *  stehen, weil `state` denselben traegt und aus demselben Grund unerreichbar ist — faellt
   *  eine der beiden Voraussetzungen weg, braucht ihn diese Zeile genauso wie die daneben.
   *  Steht hier, damit ihn niemand fuer einen scharfen Schutz haelt. */
  erreicht?: Erreicht
  jobRunning?: boolean
  inScope?: boolean
  /** Worauf diese Aufnahme wartet, und wie viele des Laufs vor ihr liegen (#370/#442).
   *  Haengt am selben Riegel wie `inScope` (`imBereich`), NICHT an `zugelassen` — es ist
   *  eine PROGNOSE ueber den Lauf, und die rechtfertigt allein der Bereich. Ueber `gesehen`
   *  durchgereicht stellte ein Einzeldatei-Korrekturlauf den ganzen Korpus auf „wartet",
   *  weil das Glossar seit #450 korpusweit `[active]` meldet. */
  warten?: Warten
  globalPhase?: GlobalPhase | null
  /** Ruhezustand mit Wort statt nur Symbol. Die Arbeitsflaeche hat die Breite dafuer,
   *  die 260px-Seitenleiste des Editors nicht. */
  mitText?: boolean
}) {
  const inhalt = () => {
    if (state && state !== 'done') {
      const { icon: Icon, label, klasse } = STATE[state]
      return (
        <span className={`inline-flex items-center gap-1.5 text-xs ${klasse}`}>
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          {label}
        </span>
      )
    }

    if (active && state !== 'done') {
      const label = `${PHASE_LABEL[active]} ${detail ?? (pct != null ? `${pct}%` : '…')}`
      return (
        // tabular-nums am Elternteil statt einer <span> um die Zahl: gleiche Ziffernbreite,
        // aber der Text bleibt EIN Knoten — sonst zerfaellt "Korrigieren 45%" in zwei Stuecke.
        <span className="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-primary">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          {label}
        </span>
      )
    }

    // Nur Dateien, die im Scope des laufenden Jobs liegen, zeigen Wartestatus.
    // Wenn inScope explizit false ist oder die Datei bereits fertig (state === 'done') ist,
    // bleibt der echte Ruhezustand der Datei erhalten.
    const betrifft = inScope ?? jobRunning
    // `!state` hat seit #442 eine Ausnahme, und sie ist eng gefasst: eine Aufnahme in der
    // KORREKTUR-Schlange traegt per Konstruktion `state === 'done'` — das Urteil ihrer
    // TRANSKRIPTION. Ohne die Ausnahme faellt sie auf `ruhe()` durch und zeigt „Transkribiert
    // — noch nicht korrigiert": wahr, aber keine Warteauskunft, und genau der Zustand, gegen
    // den dieser Fix gebaut ist.
    //
    // NUR fuer `art === 'correct'`, nicht fuer jedes `warten`: der #393-Grund („ein gruener
    // Haken pro Zeile faerbt die Liste zu") bleibt damit unangetastet, und ein kuenftiger
    // dritter Wartezustand muesste sich hier ausdruecklich eintragen statt still mitzufahren.
    const nachUrteilWartend = warten?.art === 'correct' && state === 'done'
    if (jobRunning && betrifft && (!state || nachUrteilWartend)) {
      if (globalPhase && GLOBAL_WAIT[globalPhase]) {
        const gLabel = GLOBAL_WAIT[globalPhase]
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {gLabel}
          </span>
        )
      }

      // „Wartet auf Korrektur · noch 3 vor dieser" statt des blanken „In Warteschlange…"
      // (#370/#442). Die Zahl ist eine MENGE, keine Position — der Korrekturlauf arbeitet
      // mehrere Dateien gleichzeitig; „noch N vor dieser" bleibt dabei wahr, „Platz N von M"
      // waere ein Versprechen, das der Lauf nicht gibt.
      //
      // Die ganze Auskunft haengt an `mitText`, nicht nur die Zahl — und das ist im Browser
      // GEMESSEN, nicht abgeschaetzt. Die 260px-Seitenleiste teilt sich Name, Pille und
      // ⋯-Menue; am selben Lauf mit nur ausgetauschtem Etikett stand dort mit dem alten Text
      // „Intervi…", mit „Wartet auf Transkription" nur noch „I…". Aus drei Dateien wurden
      // damit drei ununterscheidbare Zeilen — der Name ist in einer Dateiliste aber die
      // Hauptinformation, keine Nebensache. Die Kuerzung selbst ist aelter als diese Zeile;
      // neu waere nur gewesen, sie bis zur Unkenntlichkeit zu treiben.
      //
      // Bei `vor === 0` entfaellt der Zusatz: „noch 0 vor dieser" ist keine Auskunft.
      //
      // Ohne `warten` bleibt der bisherige Text stehen. Das ist kein Randfall, sondern die
      // gewollte sichere Richtung: der URL-Import kennt keine Basisnamen, und ein Lauf ohne
      // `[scope]`-Zeile im Puffer hat keine Grundlage fuer eine Zahl. Lieber kein Wert als
      // ein geratener.
      const wLabel = warten && mitText
        ? WARTE_LABEL[warten.art] + (warten.vor > 0 ? ` · noch ${warten.vor} vor dieser` : '')
        : 'In Warteschlange…'
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5 shrink-0 animate-pulse" aria-hidden="true" />
          {wLabel}
        </span>
      )
    }

    const r = ruhe(file, erreicht)
    if (!r) return null
    if (mitText) return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <r.icon className="size-3.5" aria-hidden="true" /> {r.label}
      </span>
    )
    // Ohne Text: der Name steckt in aria-label (Screenreader) und title (Maus) — ein nacktes
    // Symbol waere beides nicht. Beides am Wrapper, weil lucide-Icons kein title-Prop annehmen.
    return (
      <span role="img" aria-label={r.label} title={r.label} className="inline-flex shrink-0 text-muted-foreground">
        <r.icon className="size-3.5" aria-hidden="true" />
      </span>
    )
  }

  const node = inhalt()
  if (!node) return null
  // aria-live: der Fortschritt aendert sich ohne Zutun des Nutzers. Der aeussere Knoten
  // behaelt aria-live auch beim Wechsel auf den Ruhezustand (Fertig), damit Screenreader
  // den Abschluss ansagen (#380).
  return (
    <span aria-live="polite" className="inline-flex items-center">
      {node}
    </span>
  )
}
