import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getJob } from '@/lib/api'
import { parseJobPhases } from '@/lib/jobPhases'
import type { JobPhases } from '@/lib/types'

export type Job = { id: string; project: string; kind: string; status: string; phases: JobPhases }
type Ctx = {
  jobs: Job[]
  /** Ueber alle LAUFENDEN Jobs gemergt — fuer die Statuspille je Datei. */
  phases: JobPhases
  adopt: (id: string, project: string, kind: string) => void
  onSettled: (fn: () => void) => () => void
}
const EMPTY: JobPhases = { global: null, active: {}, perBase: {} }
const JobContext = createContext<Ctx | null>(null)

/** Transkription und Korrektur duerfen gleichzeitig laufen (jobs.py: Dedupe je Projekt UND Art),
 *  also mehrere Jobs zusammenfuehren. `active` ist nach Basisnamen indiziert, das mergt sauber;
 *  ein perBase-Eintrag muss weichen, wenn dieselbe Datei woanders gerade wieder laeuft — sonst
 *  maskiert das 'Fertig' der Transkription die laufende Korrektur (FileStatusPill prueft state zuerst). */
export function mergePhases(jobs: Job[]): JobPhases {
  const active: JobPhases['active'] = {}
  const perBase: JobPhases['perBase'] = {}
  let global: JobPhases['global'] = null
  for (const j of jobs) {
    Object.assign(active, j.phases.active)
    Object.assign(perBase, j.phases.perBase)
    global = global ?? j.phases.global
  }
  for (const base of Object.keys(active)) delete perBase[base]
  return { global: Object.keys(active).length ? null : global, active, perBase }
}

export function JobProvider({ children, intervalMs = 1500 }: { children: ReactNode; intervalMs?: number }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const listeners = useRef(new Set<() => void>())
  const failures = useRef<Record<string, number>>({})

  const adopt = useCallback((id: string, project: string, kind: string) => {
    setJobs(prev => prev.some(j => j.id === id) ? prev
      : [...prev, { id, project, kind, status: 'running', phases: EMPTY }])
  }, [])

  const onSettled = useCallback((fn: () => void) => {
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
    const tick = async () => {
      const ergebnisse = await Promise.all(ids.map(id =>
        getJob(id).then(r => [id, r] as const).catch(() => [id, null] as const)))
      if (!alive) return
      let settled = false
      setJobs(prev => prev.map(j => {
        const treffer = ergebnisse.find(([id]) => id === j.id)
        if (!treffer) return j
        const [, r] = treffer
        if (!r) {
          failures.current[j.id] = (failures.current[j.id] ?? 0) + 1
          if (failures.current[j.id] < 3) return j
          settled = true                       // dreimal weg -> aufgeben, nicht endlos pollen
          return { ...j, status: 'error' }
        }
        failures.current[j.id] = 0
        if (r.status !== 'running') settled = true
        return { ...j, status: r.status, phases: parseJobPhases(j.kind, r.lines) }
      }))
      if (settled) listeners.current.forEach(fn => fn())
      timer = setTimeout(tick, intervalMs)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [runningIds, intervalMs])

  const phases = useMemo(() => mergePhases(jobs.filter(j => j.status === 'running')), [jobs])

  return <JobContext.Provider value={{ jobs, phases, adopt, onSettled }}>{children}</JobContext.Provider>
}

export function useActiveJob(): Ctx {
  const c = useContext(JobContext)
  if (!c) throw new Error('useActiveJob ausserhalb JobProvider')
  return c
}
