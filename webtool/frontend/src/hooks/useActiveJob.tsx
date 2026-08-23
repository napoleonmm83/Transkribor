import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getJob } from '@/lib/api'
import { parseJobPhases } from '@/lib/jobPhases'
import type { FileState, JobPhases } from '@/lib/types'

export type Job = { id: string; project: string; kind: string; status: string; phases: JobPhases }
type Ctx = {
  jobs: Job[]
  adopt: (id: string, project: string, kind: string) => void
  // Nutzlast statt leerem Aufruf: ein Zuhoerer, der wissen muss WAS terminal wurde, kann sich
  // nicht auf `jobs` aus seinem eigenen Render-Closure verlassen -- der Aufruf unten kommt
  // synchron vor dem eigenen Rerender, der Closure-Stand ist zu diesem Zeitpunkt noch alt.
  onSettled: (fn: (beendet: Job[]) => void) => () => void
}
const EMPTY: JobPhases = { global: null, active: {}, perBase: {} }
const JobContext = createContext<Ctx | null>(null)

/** Schwere der Endzustaende. Ein Fehlschlag darf NIE von etwas Harmlosem verdeckt werden;
 *  zwischen 'done' und 'skipped' gewinnt 'done', weil "in diesem Lauf gemacht" mehr aussagt
 *  als "es gab nichts zu tun". */
const RANG: Record<FileState, number> = { failed: 3, done: 2, skipped: 1 }

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
 *    Reihenfolge. Ein Transkriptionslauf druckt beim Start fuer JEDE bereits transkribierte
 *    Datei `skip (vorhanden)` — womit sein 'skipped' jedes 'failed' des parallelen
 *    Korrekturlaufs ueberschrieb. Gemessen an genau dieser Paarung, beide Richtungen.
 *
 *  `global` bleibt reihenfolgeabhaengig (`?? `) und ist es bewusst: die globalen Phasen sind
 *  keine Rangfolge ("Glossar" ist nicht schwerer als "Vorbereiten"), und der erste laufende
 *  Job ist die naheliegendste Auskunft. Der Satz "ohne die Regeln haenge die Anzeige von der
 *  Reihenfolge ab" galt hier nie — er stand trotzdem da. */
export function mergePhases(jobs: Job[]): JobPhases {
  const active: JobPhases['active'] = {}
  const perBase: JobPhases['perBase'] = {}
  let global: JobPhases['global'] = null
  let bilanz: JobPhases['bilanz']
  for (const j of jobs) {
    for (const [base, work] of Object.entries(j.phases.active)) {
      if (base in active && j.kind !== 'transcribe') continue
      active[base] = work
    }
    for (const [base, zustand] of Object.entries(j.phases.perBase)) {
      const da = perBase[base]
      if (!da || RANG[zustand] > RANG[da]) perBase[base] = zustand
    }
    global = global ?? j.phases.global
    // Wie `global`: der erste, der eine hat. Zwei fetch-Jobs desselben Projekts kann es nicht
    // geben (Dedupe je Projekt UND Art, jobs.py), eine Rangfolge braucht es also nicht.
    bilanz = bilanz ?? j.phases.bilanz
  }
  for (const base of Object.keys(active)) delete perBase[base]
  return { global: Object.keys(active).length ? null : global, active, perBase, bilanz }
}

export function JobProvider({ children, intervalMs = 1500 }: { children: ReactNode; intervalMs?: number }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const listeners = useRef(new Set<(beendet: Job[]) => void>())
  const failures = useRef<Record<string, number>>({})
  // Zuletzt ERFOLGREICH gelesene Phasen je Job. Der Rueckfall unten braucht sie: `jobs` aus
  // dem Effekt-Closure steht auf dem Stand des Aufsatzes und darf dort auch nicht rein (mit
  // `jobs` in den Deps setzte der Poll bei jeder Phasenaenderung neu auf).
  const letztePhasen = useRef<Record<string, JobPhases>>({})

  const adopt = useCallback((id: string, project: string, kind: string) => {
    setJobs(prev => prev.some(j => j.id === id) ? prev
      : [...prev, { id, project, kind, status: 'running', phases: EMPTY }])
  }, [])

  const onSettled = useCallback((fn: (beendet: Job[]) => void) => {
    listeners.current.add(fn)
    return () => { listeners.current.delete(fn) }
  }, [])

  // Signatur statt jobs im Dep-Array: der Effekt soll neu aufsetzen, wenn sich die MENGE der
  // laufenden Jobs aendert — nicht bei jedem Poll-Ergebnis.
  const runningIds = jobs.filter(j => j.status === 'running').map(j => j.id).sort().join(',')
  useEffect(() => {
    if (!runningIds) return
    const ids = runningIds.split(',')
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    // Zuletzt gesehener Status je Kennung, ueberlebt alle Ticks DIESER Effekt-Instanz (s.
    // Kommentar an der beendet-Berechnung unten -- der Grund, warum es das braucht).
    const zuletzt: Record<string, string> = {}
    const tick = async () => {
      const ergebnisse = await Promise.all(ids.map(id =>
        getJob(id).then(r => [id, r] as const).catch(() => [id, null] as const)))
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
        } else {
          failures.current[id] = (failures.current[id] ?? 0) + 1
          neu[id] = failures.current[id] >= 3 ? 'error' : 'running'  // dreimal weg -> aufgeben
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
        if (r) letztePhasen.current[j.id] = phasen[j.id] = parseJobPhases(j.kind, r.lines)
      }
      setJobs(prev => prev.map(j => {
        if (!(j.id in neu)) return j
        const r = ergebnis.get(j.id)
        // `phasen[j.id]` ist gesetzt, wann immer `r` existiert: `neu` und `phasen` entstehen
        // beide aus DERSELBEN Poll-Runde ueber dieselben Kennungen.
        if (r) return { ...j, status: r.status, phases: phasen[j.id] }
        return neu[j.id] === 'error' ? { ...j, status: 'error' } : j
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
        .filter(j => neu[j.id] && neu[j.id] !== 'running' && zuletzt[j.id] !== neu[j.id])
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
      if (stati.some(s => s === 'running')) timer = setTimeout(tick, intervalMs)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
    // jobs bewusst nicht in den Deps: `runningIds` ist die Signatur, s.o. -- `jobs` wird nur
    // innerhalb von tick() fuer Job-Identitaet gelesen, nie fuer den Effekt-Aufsatz selbst.
  }, [runningIds, intervalMs])  // eslint-disable-line react-hooks/exhaustive-deps

  // Bewusst KEIN projektuebergreifendes `phases` im Context: das war die Falle — die Datei-Pillen
  // haetten den Status eines gleichnamigen Files aus einem anderen Projekt gezeigt.
  // Verbraucher filtern selbst auf ihr Projekt und rufen mergePhases().
  return <JobContext.Provider value={{ jobs, adopt, onSettled }}>{children}</JobContext.Provider>
}

export function useActiveJob(): Ctx {
  const c = useContext(JobContext)
  if (!c) throw new Error('useActiveJob ausserhalb JobProvider')
  return c
}
