import { AudioLines, Check, Clock, FileCheck, FileText, Loader2, SkipForward, TriangleAlert } from 'lucide-react'
import type { FilePhase, FileState, GlobalPhase, ProjectFile } from '@/lib/types'
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
  done: { icon: Check, label: 'Fertig', klasse: 'text-muted-foreground' },
  skipped: { icon: SkipForward, label: 'Übersprungen', klasse: 'text-muted-foreground' },
  failed: { icon: TriangleAlert, label: 'Fehler', klasse: 'text-destructive' },
} satisfies Record<FileState, { icon: typeof Check; label: string; klasse: string }>

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
 */
function ruhe(file: ProjectFile) {
  if (file.has_edit) return { icon: FileCheck, label: 'Korrigiert' }
  if (file.has_md) return { icon: Check, label: 'Export vorhanden' }
  if (file.has_raw) return { icon: FileText, label: 'Transkribiert — noch nicht korrigiert' }
  if (file.has_audio) return { icon: AudioLines, label: 'Nur Audio — noch nicht transkribiert' }
  return null
}

export function FileStatusPill({ file, active, pct, detail, state, jobRunning, inScope, globalPhase, mitText }: {
  file: ProjectFile
  active?: FilePhase
  pct?: number
  detail?: string
  state?: FileState
  jobRunning?: boolean
  inScope?: boolean
  globalPhase?: GlobalPhase | null
  /** Ruhezustand mit Wort statt nur Symbol. Die Arbeitsflaeche hat die Breite dafuer,
   *  die 260px-Seitenleiste des Editors nicht. */
  mitText?: boolean
}) {
  if (state) {
    const { icon: Icon, label, klasse } = STATE[state]
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs ${klasse}`}>
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {label}
      </span>
    )
  }

  if (active) {
    const label = `${PHASE_LABEL[active]} ${detail ?? (pct != null ? `${pct}%` : '…')}`
    return (
      // aria-live: der Fortschritt aendert sich ohne Zutun des Nutzers, ein Screenreader
      // erfaehrt sonst nie, dass die Datei durch ist.
      // tabular-nums am Elternteil statt einer <span> um die Zahl: gleiche Ziffernbreite,
      // aber der Text bleibt EIN Knoten — sonst zerfaellt "Korrigieren 45%" in zwei Stuecke.
      <span className="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-primary"
        aria-live="polite">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        {label}
      </span>
    )
  }

  // Nur Dateien, die im Scope des laufenden Jobs liegen, zeigen Wartestatus.
  // Wenn inScope explizit false ist, bleibt der echte Ruhezustand der Datei erhalten.
  const betrifft = inScope ?? jobRunning
  if (jobRunning && betrifft) {
    if (globalPhase && GLOBAL_WAIT[globalPhase]) {
      const gLabel = GLOBAL_WAIT[globalPhase]
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary" aria-live="polite">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          {gLabel}
        </span>
      )
    }

    const wLabel = 'In Warteschlange…'
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
        <Clock className="size-3.5 shrink-0 animate-pulse" aria-hidden="true" />
        {wLabel}
      </span>
    )
  }

  const r = ruhe(file)
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
