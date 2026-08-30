import { AudioLines, Check, Clock, FileText, Loader2, SkipForward, TriangleAlert } from 'lucide-react'
import type { Erreicht, FilePhase, FileState, GlobalPhase, ProjectFile } from '@/lib/types'
import { PHASE_LABEL } from '@/lib/jobPhases'

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
  skipped: { icon: SkipForward, label: 'Übersprungen', klasse: 'text-muted-foreground' },
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
 */
function ruhe(file: ProjectFile, erreicht?: Erreicht) {
  if (file.has_edit || erreicht === 'edit') return { icon: Check, label: 'Fertig' }
  if (file.has_md) return { icon: Check, label: 'Export vorhanden' }
  if (file.has_raw || erreicht) return { icon: FileText, label: 'Transkribiert — noch nicht korrigiert' }
  if (file.has_audio) return { icon: AudioLines, label: 'Nur Audio — noch nicht transkribiert' }
  return null
}

export function FileStatusPill({ file, active, pct, detail, state, erreicht, jobRunning, inScope, globalPhase, mitText }: {
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
    if (jobRunning && betrifft && !state) {
      if (globalPhase && GLOBAL_WAIT[globalPhase]) {
        const gLabel = GLOBAL_WAIT[globalPhase]
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {gLabel}
          </span>
        )
      }

      const wLabel = 'In Warteschlange…'
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
