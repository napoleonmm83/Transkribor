import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { getJob, getVorgang, HttpFehler } from '@/lib/api'
import { korrekturSchlange, laufOrdnung, parseJobPhases, RANG, warteKarte } from '@/lib/jobPhases'
import type { GlobalPhase, JobPhases, Warten } from '@/lib/types'

/** Zwei Zustaende, die der SERVER nie sendet — sie entstehen hier, aus dem Ausbleiben einer
 *  Antwort (#382). Deshalb stehen sie in `Job.status` und NICHT im Antworttyp `JobStatus`:
 *  dort waeren sie eine Behauptung ueber den Server, die er nie aufstellt. */
export const UNERREICHBAR = 'unerreichbar'   // dreimal keine Antwort — der Lauf laeuft weiter
export const VERSCHWUNDEN = 'verschwunden'   // Server antwortet 404 — Kennung unbekannt, Ausgang unbekannt

/** Zaehlt dieser Zustand fuer die ANZEIGE als „es laeuft etwas"?
 *
 *  EINE Stelle fuer eine Regel, die sonst an sieben Lesern haengt: waehrend eines Hängers
 *  soll die Oberflaeche stehenbleiben und nicht auf „Bereit" springen und zurueck. */
export const zeigtLauf = (status: string) => status === 'running' || status === UNERREICHBAR

export type Job = { id: string; project: string; kind: string; status: string; phases: JobPhases }
type Ctx = {
  jobs: Job[]
  adopt: (id: string, project: string, kind: string, bases?: string[]) => void
  /** Eine Vormerkung verfolgen, bis daraus ein Lauf wird (#381). Aufzurufen ueberall dort,
   *  wo ein Start mit `started: false` antwortet — die Job-Kennung ist dann wertlos. */
  verfolge: (nummer: string) => void
  // Nutzlast statt leerem Aufruf: ein Zuhoerer, der wissen muss WAS terminal wurde, kann sich
  // nicht auf `jobs` aus seinem eigenen Render-Closure verlassen -- der Aufruf unten kommt
  // synchron vor dem eigenen Rerender, der Closure-Stand ist zu diesem Zeitpunkt noch alt.
  onSettled: (fn: (beendet: Job[]) => void) => () => void
}
const EMPTY: JobPhases = { global: null, active: {}, perBase: {} }
const JobContext = createContext<Ctx | null>(null)

// `RANG` steht seit #405 in `lib/jobPhases.ts`: dieselbe Regel gilt jetzt auch INNERHALB
// eines Laufs (der gestaffelte Job gibt einer Aufnahme zwei Terminalurteile), und zwei Orte
// mit derselben Regel driften auseinander.

/** Transkription und Korrektur duerfen gleichzeitig laufen (jobs.py: Dedupe je Projekt UND Art),
 *  also mehrere Jobs zusammenfuehren. NUR Jobs EINES Projekts hineingeben — `active` ist nach
 *  Basisnamen indiziert, und derselbe Basisname existiert durchaus in mehreren Projekten.
 *
 *  Drei Regeln, ohne die die Anzeige von der Job-Reihenfolge abhinge:
 *  - Ein perBase-Eintrag weicht, wenn dieselbe Datei in einem anderen Job gerade laeuft — sonst
 *    maskiert das 'Fertig' der Transkription die laufende Korrektur (FileStatusPill prueft state zuerst).
 *  - Kollidieren zwei aktive Phasen auf derselben Datei, gewinnt 'transcribe': dann wird das
 *    Transkript gerade ersetzt, und die Korrektur arbeitet auf gleich veralteten Daten.
 *  - Kollidieren zwei TERMINALE Ausgaenge, gewinnt der schwerere (`RANG`). Hier stand ein
 *    `Object.assign`, also "der spaetere Job im Array" — und diese Reihenfolge ist nicht
 *    zufaellig, sondern systematisch die schlechte: `jobs.py:273` sortiert `active_for` nach
 *    `kind`, also `correct` vor `transcribe`, und `useProjektDaten` adoptiert in dieser
 *    Reihenfolge. Ein Transkriptionslauf druckte beim Start fuer JEDE bereits transkribierte
 *    Datei `skip (vorhanden)` — womit sein 'skipped' jedes 'failed' des parallelen
 *    Korrekturlaufs ueberschrieb. Gemessen an genau dieser Paarung, beide Richtungen.
 *    NACHTRAG: diese Druckform gibt es seit dem gestaffelten Lauf nicht mehr (die dynamische
 *    `pending`-Liste filtert fertige Dateien vorher heraus, sie erzeugen gar keine Zeile).
 *    Die Regel bleibt richtig und noetig — 'skipped' kommt jetzt aus `correct`s `apply: SKIP`
 *    und kann dieselbe Kollision erzeugen —, nur der genannte Ausloeser ist historisch.
 *
 *  `global` bleibt reihenfolgeabhaengig (`?? `) und ist es bewusst: die globalen Phasen sind
 *  keine Rangfolge ("Glossar" ist nicht schwerer als "Vorbereiten"), und der erste laufende
 *  Job ist die naheliegendste Auskunft. Der Satz "ohne die Regeln haenge die Anzeige von der
 *  Reihenfolge ab" galt hier nie — er stand trotzdem da. */
export function mergePhases(jobs: Job[]): JobPhases {
  // `Object.create(null)` aus demselben Grund wie in `parseJobPhases` — und die Stelle war
  // beim ersten Anlauf uebersehen: dort ist der Schaden ein Wurf, hier ist er STILL. Fuer eine
  // Aufnahme namens `constructor` ist `base in warten` ueber den Prototyp wahr, die
  // Kollisionsregel eine Zeile darunter greift, und die Datei bekaeme gar keine Warteauskunft.
  // Gefunden von der CodeRabbit-CLI, nachdem der kalte Diff-Leser die Klasse im Parser fand.
  const active: JobPhases['active'] = Object.create(null)
  const perBase: JobPhases['perBase'] = Object.create(null)
  const globalPerBase: Record<string, GlobalPhase> = Object.create(null)
  const warten: Record<string, Warten> = Object.create(null)
  // Getrennt gesammelt und ERST NACH der Raeumung eingemischt (#442): die Eintraege der
  // Korrektur-Schlange tragen per Konstruktion ein Endurteil (`done` aus ihrer Transkription),
  // die Schleife `for (base of keys(perBase)) delete warten[base]` weiter unten loeschte sie
  // also samt und sonders wieder. Hier oben eingehaengt waere der ganze Fix wirkungslos —
  // und zwar lautlos, weil das Ergebnis dann einfach dem Vorzustand gleicht.
  const korrWarten: Record<string, Warten> = Object.create(null)
  let global: JobPhases['global'] = null
  let allScoped = jobs.length > 0
  let scope: Set<string> | undefined
  // Rein additiv, ohne `allScoped`-Vorbehalt: `scope` ist eine ZUSAGE ueber den ganzen Lauf
  // (faellt sie bei einem Job weg, taugt die vereinigte Menge nicht mehr als Filter),
  // `gesehen` dagegen ist eine BEOBACHTUNG je Datei - die bleibt wahr, egal was die anderen
  // Jobs melden.
  let gesehen: Set<string> | undefined
  // Wie `gesehen` rein additiv und ohne `allScoped`-Vorbehalt: ein Beweis ueber die Platte
  // bleibt wahr, egal was die anderen Jobs melden.
  //
  // `edit` schlaegt `raw` — und das ist hier ein TIE-BREAK, keine Regel wie in `terminal()`.
  // Dort entscheidet die Zeilenreihenfolge (die spaetere Zeile ist der frischere Beweis);
  // ueber JOBS hinweg gibt es keine solche Ordnung, `jobs.py:273` sortiert nach `kind` und
  // die Adoptionsreihenfolge sagt nichts ueber die Zeit. Der Fall ist praktisch unerreichbar:
  // ein Projektlauf fasst nur Aufnahmen OHNE `.json` an, kann also keinen `raw`-Beleg fuer
  // eine Datei erzeugen, die ein parallel laufender `correct`-Job gerade beschreibt; und der
  // Loesch-plus-Neu-Upload-Weg landet entweder im SELBEN Strom (dann entscheidet `terminal`)
  // oder in einem Job, der erst startet, wenn dieser hier laengst terminal ist.
  //
  // TRAGENDE INVARIANTE (kalter Plan-Review zu K1 Glied 3): diese Vereinigung darf nur
  // LAUFENDE Jobs sehen — alle drei Konsumenten filtern vorher auf `running`
  // (ProjectWorkspace.tsx, AppShell.tsx, useDokumentTitel.ts). Ein kuenftiger Konsument,
  // der ueber ALLE Jobs merged, holte `erreicht[X]='edit'` aus einem terminalen
  // Vorlaeufer zurueck, und der TIE-BREAK darunter (`edit` schlaegt `raw`) machte es
  // schlimmer: genau der Beleg, den `parseJobPhases` fuer geloeschte Aufnahmen tilgt,
  // kaeme hier ein zweites Mal herein.
  const erreicht: NonNullable<JobPhases['erreicht']> = Object.create(null)
  for (const j of jobs) {
    for (const [base, e] of Object.entries(j.phases.erreicht ?? {})) {
      if (erreicht[base] !== 'edit') erreicht[base] = e
    }
    if (j.phases.gesehen) {
      gesehen = gesehen ?? new Set()
      for (const b of j.phases.gesehen) gesehen.add(b)
    }
    if (j.phases.scope) {
      scope = scope ?? new Set()
      for (const b of j.phases.scope) {
        scope.add(b)
        if (j.phases.global && !Object.hasOwn(j.phases.active, b) && !Object.hasOwn(j.phases.perBase, b)) {
          globalPerBase[b] = j.phases.global
        }
      }
    } else {
      allScoped = false
      global = global ?? j.phases.global
    }
    for (const [base, work] of Object.entries(j.phases.active)) {
      if (Object.hasOwn(active, base) && j.kind !== 'transcribe') continue
      active[base] = work
    }
    for (const [base, zustand] of Object.entries(j.phases.perBase)) {
      const da = perBase[base]
      if (!da || RANG[zustand] > RANG[da]) perBase[base] = zustand
    }
    // Die Warteauskunft entsteht HIER und nicht im Parser (#370/#442) — Pflicht, nicht
    // Geschmack: `parsed.scope` wird eine Handvoll Zeilen weiter oben mit `r.bases`
    // VEREINIGT (der Rueckweg gegen den Zeilendeckel, #475/#483). Im Parser gerechnet
    // kennte die Karte genau die Aufnahmen nicht, fuer die es diesen Rueckweg gibt, und
    // zwei Dateien im selben Wartezustand traegen zwei verschiedene Texte.
    //
    // Je Job, weil nur der Job die ART seiner Arbeit kennt (`j.kind`) — nach dem Merge ist
    // sie weg. Kollisionsregel wie bei `active` daneben: `transcribe` gewinnt. Sie ist
    // heute unerreichbar (die Bereiche sind disjunkt: der Transkriptionslauf nimmt die
    // Aufnahmen OHNE Roh-JSON, der Korrekturlauf die MIT), steht aber da, damit die
    // Reihenfolge der Jobs nie entscheidet.
    for (const [base, eintrag] of Object.entries(warteKarte(j.phases, j.kind))) {
      if (Object.hasOwn(warten, base) && j.kind !== 'transcribe') continue
      warten[base] = eintrag
    }
    Object.assign(korrWarten, korrekturSchlange(j.phases, j.kind))
  }
  for (const base of Object.keys(active)) {
    delete perBase[base]
    delete globalPerBase[base]
    // `warten` wird hier BEWUSST NICHT geraeumt, anders als `globalPerBase` daneben — und die
    // erste Fassung tat es, was ein Rechenfehler war (Bot-Befund): die laufende Aufnahme LIEGT
    // VOR den wartenden, sie gehoert also in die Zaehlung. Ihre Pille zeigt ohnehin die Phase,
    // nicht den Wartetext (`FileStatusPill` prueft `active` vor dem Wartezweig) — die
    // Anwesenheit im Datensatz kostet nichts und haelt die Zahl richtig. `warteKarte` fuehrt
    // die laufende Datei aus demselben Grund innerhalb eines Jobs mit.
  }
  for (const base of Object.keys(perBase)) {
    delete globalPerBase[base]
    delete warten[base]     // fertig heisst: liegt vor niemandem mehr
  }
  // ... ausser, die Aufnahme steht jetzt in der ZWEITEN Schlange (#442). Ihr Urteil `done`
  // gilt der Transkription; auf ihre Korrektur wartet sie noch. `active` schlaegt das hier
  // NICHT aus — `korrekturSchlange` hat aktive Aufnahmen bereits ausgenommen, und die
  // Raeumung darueber fasst `warten` ohnehin nicht an.
  Object.assign(warten, korrWarten)
  // Nach dem Raeumen NEU durchzaehlen. `warteKarte` vergibt die Positionen je Job, die
  // Raeumung darueber nimmt einzelne Basen heraus — die Luecke bliebe sonst als zu grosse Zahl
  // stehen. Gemeldet vom Bot mit genau diesem Beispiel: Bereich A/B/C, B in einem zweiten Job
  // fertig ⇒ C behielt `vor: 2`, obwohl nur noch A vor ihm liegt.
  //
  // Je ART getrennt, weil zwei Laeufe zwei Schlangen sind. Dass ihre Bereiche disjunkt sind
  // (transcribe nimmt die Aufnahmen OHNE Roh-JSON, correct die MIT), macht die Trennung nicht
  // ueberfluessig: sie ist der Grund, warum hier ueberhaupt nach `art` gruppiert werden DARF.
  for (const art of ['transcribe', 'correct'] as const) {
    laufOrdnung(Object.keys(warten).filter(b => warten[b].art === art))
      .forEach((b, i) => { warten[b] = { art, vor: i } })
  }
  // KEINE `bilanz` im Ergebnis, und das ist Absicht: sie gehoert EINEM Lauf (dem URL-Import),
  // und ihr einziger Leser — der Ausgang — bekommt ihn einzeln aus der `onSettled`-Nutzlast.
  // Hier stand ein `bilanz ?? j.phases.bilanz` mit der Begruendung „zwei fetch-Jobs desselben
  // Projekts kann es nicht geben"; die haelt der Code nicht (jobs.py dedupliziert nur
  // LAUFENDE, der Provider behaelt terminale Jobs), und gelesen hat es ohnehin niemand —
  // die Zeile zu entfernen liess alle Tests gruen. Erster-gewinnt haette bei terminalem
  // Eingang die Bilanz des AELTESTEN Laufs gemeldet.
  return {
    global: Object.keys(active).length ? null : global,
    globalPerBase,
    scope: allScoped ? scope : undefined,
    gesehen,
    // Bewusst NICHT ueber `active` geraeumt wie `perBase` gleich darueber: das Urteil weicht,
    // wenn die Datei wieder laeuft, der geschriebene Inhalt auf der Platte nicht.
    erreicht: Object.keys(erreicht).length ? erreicht : undefined,
    // Wie `gesehen`/`erreicht` nur, wenn wirklich etwas darin steht — ein immer vorhandenes
    // leeres Objekt waere eine Feldaenderung in JEDER Antwort, fuer einen Fall, den es meist
    // gar nicht gibt (kein Bereich, kein wartender Rest).
    warten: Object.keys(warten).length ? warten : undefined,
    active,
    perBase,
  }
}

export function JobProvider({ children, intervalMs = 1500 }: { children: ReactNode; intervalMs?: number }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [vorgaenge, setVorgaenge] = useState<string[]>([])   // offene Vormerkungen (#381)
  const listeners = useRef(new Set<(beendet: Job[]) => void>())
  const failures = useRef<Record<string, number>>({})
  // Zuletzt ERFOLGREICH gelesene Phasen je Job. Der Rueckfall unten braucht sie: `jobs` aus
  // dem Effekt-Closure steht auf dem Stand des Aufsatzes und darf dort auch nicht rein (mit
  // `jobs` in den Deps setzte der Poll bei jeder Phasenaenderung neu auf).
  const letztePhasen = useRef<Record<string, JobPhases>>({})

  const adopt = useCallback((id: string, project: string, kind: string, bases?: string[]) => {
    const initPhases: JobPhases = bases && bases.length > 0
      ? { ...EMPTY, scope: new Set(bases) }
      : EMPTY
    setJobs(prev => prev.some(j => j.id === id) ? prev
      : [...prev, { id, project, kind, status: 'running', phases: initPhases }])
  }, [])

  const onSettled = useCallback((fn: (beendet: Job[]) => void) => {
    listeners.current.add(fn)
    return () => { listeners.current.delete(fn) }
  }, [])

  /** Eine Vormerkung verfolgen (#381). Der Aufrufer bekommt bei `started: false` eine Nummer
   *  statt einer brauchbaren Job-Kennung — hier wird daraus wieder ein adoptierter Lauf. */
  const verfolge = useCallback((nummer: string) => {
    setVorgaenge(prev => (prev.includes(nummer) ? prev : [...prev, nummer]))
  }, [])

  // Solange Vormerkungen offen sind, wird nach ihnen gefragt — im selben Takt wie die Jobs.
  // Sobald eine `gestartet` meldet, ist der Nachlauf ein Lauf wie jeder andere: adoptiert,
  // gepollt, und sein AUSGANG laeuft ueber `useJobAusgang` — dafuer gibt es keinen zweiten
  // Meldeweg. Der `aufgegeben`-Hinweis unten ist die eine Ausnahme, und er ist auch keiner:
  // dort ist nie ein Job entstanden, also hat `useJobAusgang` nichts, worueber es reden
  // koennte.
  const offeneVorgaenge = vorgaenge.join(',')
  useEffect(() => {
    if (!offeneVorgaenge) return
    const nummern = offeneVorgaenge.split(',')
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      const fertig: string[] = []
      for (const nummer of nummern) {
        try {
          const v = await getVorgang(nummer)
          if (!alive) return
          if (v.status === 'gestartet' && v.job_id) {
            adopt(v.job_id, v.project, v.kind, v.base ? [v.base] : undefined)
            fertig.push(nummer)
          } else if (v.status === 'verworfen') {
            fertig.push(nummer)   // Abbruch ist eine Entscheidung — dazu gibt es nichts zu sagen
          } else if (v.status === 'aufgegeben') {
            // Dieser Ausgang war bisher NUR eine stderr-Zeile. Der Nutzer hat hochgeladen und
            // haette nie erfahren, dass daraus nichts wird.
            toast.warning('Die Aufnahme konnte nicht eingereiht werden — der Platz blieb belegt.')
            fertig.push(nummer)
          }
        } catch (e) {
          // 404 heisst: diese Nummer kennt der Server nicht (mehr) — weiter zu fragen bringt
          // nichts. Alles andere ist ein Haenger, und da lohnt die naechste Runde.
          if (e instanceof HttpFehler && e.status === 404) fertig.push(nummer)
        }
      }
      if (!alive) return
      if (fertig.length) setVorgaenge(prev => prev.filter(n => !fertig.includes(n)))
      timer = setTimeout(tick, intervalMs)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [offeneVorgaenge, intervalMs, adopt])

  // Signatur statt jobs im Dep-Array: der Effekt soll neu aufsetzen, wenn sich die MENGE der
  // laufenden Jobs aendert — nicht bei jedem Poll-Ergebnis.
  // `unerreichbar` bleibt IM Poll — das ist der halbe Fix von #382. Frueher fiel der Job hier
  // heraus und wurde nie wieder gefragt; die Rueckkehr des Servers half dann nichts mehr.
  const runningIds = jobs.filter(j => zeigtLauf(j.status)).map(j => j.id).sort().join(',')
  useEffect(() => {
    if (!runningIds) return
    const ids = runningIds.split(',')
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    // Zuletzt gesehener Status je Kennung, ueberlebt alle Ticks DIESER Effekt-Instanz (s.
    // Kommentar an der beendet-Berechnung unten -- der Grund, warum es das braucht).
    const zuletzt: Record<string, string> = {}
    const tick = async () => {
      // ZWEI Fehlerarten, nicht eine (#382). Bisher fing ein blankes `.catch` beides und
      // machte aus dreimal Schweigen einen `error` — also „fehlgeschlagen" ueber einen Lauf,
      // dessen Subprozess weiterlief. Ein 404 heisst dagegen: der Server ANTWORTET, er kennt
      // die Kennung nur nicht mehr (die Registry liegt im Arbeitsspeicher, ein Neustart
      // leert sie). Das ist terminal und trotzdem kein Fehlschlag — wir wissen es schlicht
      // nicht mehr, und Schweigen ist ehrlicher als eine erfundene Meldung.
      const weg = new Set<string>()
      const ergebnisse = await Promise.all(ids.map(async id => {
        try {
          return [id, await getJob(id)] as const
        } catch (e) {
          if (e instanceof HttpFehler && e.status === 404) weg.add(id)
          return [id, null] as const
        }
      }))
      if (!alive) return

      // Den Ausgang HIER bestimmen, nicht im setJobs-Updater. React ruft Updater in der
      // Render-Phase — also erst NACH den Zeilen unten — und unter StrictMode zweimal.
      // Beides stand vorher drin und beides ging schief: `settled` war unten immer noch
      // false (die onSettled-Listener feuerten nie, gemessen 0x), und `failures` zaehlte
      // doppelt, womit aus "dreimal weg" schon nach zwei Netzhaengern ein Abbruch wurde.
      // Ein Updater darf rechnen, aber nichts entscheiden und nichts veraendern.
      const neu: Record<string, string> = {}
      for (const [id, r] of ergebnisse) {
        if (r) {
          failures.current[id] = 0
          neu[id] = r.status
        } else if (weg.has(id)) {
          neu[id] = VERSCHWUNDEN
        } else {
          failures.current[id] = (failures.current[id] ?? 0) + 1
          // Dreimal keine Antwort heisst NICHT mehr `error`. Der Lauf ist ein `Popen`-Kind und
          // laeuft weiter; frueher meldete die Oberflaeche hier „fehlgeschlagen" und nahm den
          // Job zugleich aus dem Poll — eine Einbahnstrasse, aus der ihn auch die Rueckkehr
          // des Servers nicht mehr holte (#377 Punkt 3, #382).
          neu[id] = failures.current[id] >= 3 ? UNERREICHBAR : 'running'
        }
      }
      const ergebnis = new Map(ergebnisse)
      // EINMAL je Job und Tick geparst (#77). Vorher lief `parseJobPhases` zweimal ueber
      // dieselben Zeilen — hier fuer den Ref und gleich nochmal im setJobs-Updater. Reine
      // Rechenzeit ohne Wirkung, aber sie waechst mit der Log-Laenge, und ein Korrekturlauf
      // ueber ein grosses Projekt schreibt viele tausend Zeilen. Der Updater bedient sich
      // jetzt aus derselben Map; `kind` aendert sich nach dem Adoptieren nie, die Ergebnisse
      // sind also identisch.
      const phasen: Record<string, JobPhases> = {}
      for (const j of jobs) {
        const r = ergebnis.get(j.id)
        if (r) {
          // `r.entfernt` ist der dritte Rueckweg neben `r.bases` und `r.gesehen`: das
          // Loeschen einer Aufnahme druckt keine Zeile in den Strom, aber der Parser liest
          // den GANZEN Puffer neu — ohne diese Menge erbte eine unter gleichem Namen neu
          // hochgeladene Datei die Urteile der geloeschten (#479/#489). Verdrahtungs-Test
          // in useActiveJob.test.tsx: ein weggelassenes viertes Argument wuerde den Fix
          // still abschalten (die #488-Lehre: kein Test sah das fehlende Prop).
          const parsed = parseJobPhases(j.kind, r.lines, r.gesehen, r.entfernt)
          // Die Serverbuchfuehrung ERGAENZT den Zeilenpuffer, sie springt nicht nur ein,
          // wenn er leer ist — und das ist seit dem Bereichs-Nachtrag Pflicht, nicht
          // Feinschliff. `[scope]` ist die erste Zeile des Laufs und damit von
          // `fuege_zeile_an` geschuetzt (die ersten zehn bleiben stehen); `[scope+]` wird per
          // Konstruktion MITTEN im Lauf gedruckt und faellt bei > MAX_JOB_LINES aus der Mitte
          // heraus. Als blosser Rueckfall (`!parsed.scope`) kam die Serverwahrheit dort NIE
          // zum Zug, weil die geschuetzte `[scope]`-Zeile `parsed.scope` immer besetzt — der
          // Nachtrag war ueber dem Deckel also dauerhaft weg, nicht nur kurz. Genau der
          // Mechanismus, gegen den `gesehen` eine Zeile tiefer angetreten ist (#475).
          //
          // Die frueher hier festgehaltene Regel „expliziter [scope] hat VORRANG vor r.bases"
          // ist damit bewusst aufgegeben. Sie war richtig, solange `bases` aus derselben einen
          // Zeile stammte wie `parsed.scope` — dann konnte die Vereinigung nichts hinzufuegen.
          // Seit dem Nachtrag ist `bases` eine OBERMENGE und oft die aktuellere.
          // Rueckwaertskompatibel: ohne `[scope]` im Puffer ergibt die Vereinigung genau die
          // Menge, die der Rueckfall vorher gesetzt hat.
          if (r.bases && r.bases.length > 0) {
            parsed.scope = new Set([...(parsed.scope ?? []), ...r.bases])
          }
          letztePhasen.current[j.id] = phasen[j.id] = parsed
        }
      }
      setJobs(prev => prev.map(j => {
        if (!(j.id in neu)) return j
        const r = ergebnis.get(j.id)
        // `phasen[j.id]` ist gesetzt, wann immer `r` existiert: `neu` und `phasen` entstehen
        // beide aus DERSELBEN Poll-Runde ueber dieselben Kennungen.
        if (r) return { ...j, status: r.status, phases: phasen[j.id] }
        // Ohne Antwort gibt es keine frischen Phasen — der Zustand wechselt, die Phasen
        // bleiben auf dem zuletzt gelesenen Stand.
        return neu[j.id] !== 'running' ? { ...j, status: neu[j.id] } : j
      }))

      const stati = Object.values(neu)
      // Das Ereignis traegt, WAS beendet wurde. Ohne Nutzlast muesste jeder Zuhoerer `jobs`
      // aus seinem Render-Closure lesen -- und der ist hier zwangslaeufig veraltet, weil wir
      // synchron nach setJobs rufen, also vor Reacts Rerender. Identitaet (id/project/kind)
      // darf aus dem (moeglicherweise veralteten) `jobs` kommen, die aendert sich nach dem
      // Adoptieren nie mehr -- der Status kommt aus `neu`, das IST der frische Poll-Ausgang.
      //
      // Ein Job wird gemeldet, wenn er in DIESEM Tick terminal GEWORDEN ist -- nicht, wenn er
      // terminal IST. Der Unterschied ist der Punkt: `ids` friert beim Effekt-Aufsatz ein (oben).
      // Im Normalfall verengt sich `runningIds`, sobald ein Job nicht mehr laeuft, der Effekt
      // setzt neu auf, und dessen Cleanup verwirft den schon geplanten Folge-Tick -- der Job
      // faellt aus `ids` und taucht in einem spaeteren `neu` nicht mehr auf. Das ist aber ein
      // Timing-Vorsprung, kein Garant: haengt der Hauptthread zwischen `setJobs` und Reacts
      // Cleanup laenger als `intervalMs`, laeuft die ALTE Tick-Closure mit ihrem alten `ids`
      // noch einmal und fragt einen bereits erledigten Job erneut ab -- der stuende dann wieder
      // in `neu`. `zuletzt` faengt genau das ab: ein Zustand ("ist terminal") liefert bei
      // wiederholter Abfrage zweimal dasselbe, ein Uebergang ("ist GERADE terminal geworden")
      // nicht, weil `zuletzt[j.id]` beim zweiten Mal schon auf dem neuen Status steht. Diese
      // Race laesst sich in keinem Test erzwingen (bräuchte einen echten Hauptthread-Stillstand
      // im exakt richtigen Fenster) -- diese Begruendung ist das Argument dafuer, nicht ein
      // roter Testlauf.
      const beendet = jobs
        // `unerreichbar` ist KEIN Ausgang: der Lauf ist nicht beendet, wir hoeren ihn nur
        // gerade nicht. Ein onSettled darauf waere die Falschmeldung aus #382 durch die
        // Hintertuer — `useJobAusgang` macht aus jedem terminalen Zustand eine Meldung.
        .filter(j => neu[j.id] && !zeigtLauf(neu[j.id]) && zuletzt[j.id] !== neu[j.id])
        // Phasen aus dem Merker, nicht aus dem Closure: `jobs.phases` steht dort auf dem
        // Stand des Effekt-Aufsatzes -- ein Zuhoerer bekaeme bei einem Netzfehler nicht die
        // zuletzt gelesene Phase, sondern die vom Adoptieren (leer).
        .map(j => ({ ...j, status: neu[j.id], phases: letztePhasen.current[j.id] ?? j.phases }))
      for (const id of Object.keys(neu)) zuletzt[id] = neu[id]
      if (beendet.length) listeners.current.forEach(fn => fn(beendet))
      // Nur weiterpollen, solange wirklich etwas laeuft. Bedingungslos neu zu planen liess
      // nach dem letzten Job einen Timer stehen, den allein das Aufraeumen des Effekts noch
      // abfangen konnte — ein Wettlauf, den ein ausgelasteter CI-Runner verliert. Der
      // Extra-Aufruf traf dort einen erschoepften Mock: undefined.then -> Unhandled Rejection.
      // MUSS `unerreichbar` mitnehmen, sonst stirbt der Poll beim dritten Fehlversuch und der
      // Job oben im `runningIds`-Filter waere ein Zustand ohne Uhr — die Rueckkehr des
      // Servers wuerde nie bemerkt. Selbst nachgelesen, nicht angenommen.
      if (stati.some(zeigtLauf)) timer = setTimeout(tick, intervalMs)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
    // jobs bewusst nicht in den Deps: `runningIds` ist die Signatur, s.o. -- `jobs` wird nur
    // innerhalb von tick() fuer Job-Identitaet gelesen, nie fuer den Effekt-Aufsatz selbst.
  }, [runningIds, intervalMs])  // eslint-disable-line react-hooks/exhaustive-deps

  // Bewusst KEIN projektuebergreifendes `phases` im Context: das war die Falle — die Datei-Pillen
  // haetten den Status eines gleichnamigen Files aus einem anderen Projekt gezeigt.
  // Verbraucher filtern selbst auf ihr Projekt und rufen mergePhases().
  return <JobContext.Provider value={{ jobs, adopt, verfolge, onSettled }}>{children}</JobContext.Provider>
}

export function useActiveJob(): Ctx {
  const c = useContext(JobContext)
  if (!c) throw new Error('useActiveJob ausserhalb JobProvider')
  return c
}
