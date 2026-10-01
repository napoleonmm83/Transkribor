import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { getJob, getVorgang, HttpFehler } from '@/lib/api'
import { parseJobPhases } from '@/lib/jobPhases'
import type { JobPhases } from '@/lib/types'
import { JobContext, UNERREICHBAR, VERSCHWUNDEN, zeigtLauf, type Job } from './useActiveJob'
const EMPTY: JobPhases = { global: null, active: {}, perBase: {} }

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
          // `r.eingereiht` ist der VIERTE Rueckweg (#561) und der letzte der drei
          // Wartequellen, der noch allein am Zeilenpuffer hing: die Einreih-Zeile faellt bei
          // `MAX_JOB_LINES` aus der Mitte, und mit ihr verschwand die Aufnahme aus der
          // Schlange — samt einer um eins zu kleinen Zahl fuer alle uebrigen. Auch hier gilt
          // die #488-Lehre: ein weggelassenes fuenftes Argument schaltete den Fix still ab,
          // Verdrahtungs-Test in useActiveJob.test.tsx.
          const parsed = parseJobPhases(j.kind, r.lines, r.gesehen, r.entfernt, r.eingereiht, r.entfernt_je)
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
