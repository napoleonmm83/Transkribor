import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getJob } from '@/lib/api'
import { parseJobPhases } from '@/lib/jobPhases'
import type { JobPhases } from '@/lib/types'

type Job = { id: string; project: string; kind: string; status: string; lines: string[] }
type Ctx = {
  job: Job | null
  phases: JobPhases
  adopt: (id: string, project: string, kind: string) => void
  onSettled: (fn: () => void) => () => void
}
const EMPTY: JobPhases = { global: null, active: {}, perBase: {} }
const JobContext = createContext<Ctx | null>(null)

export function JobProvider({ children, intervalMs = 1500 }: { children: ReactNode; intervalMs?: number }) {
  const [job, setJob] = useState<Job | null>(null)
  const [phases, setPhases] = useState<JobPhases>(EMPTY)
  const jobRef = useRef<Job | null>(null)
  jobRef.current = job
  const listeners = useRef(new Set<() => void>())

  const adopt = useCallback((id: string, project: string, kind: string) => {
    if (jobRef.current?.id === id) return
    setPhases(EMPTY)
    setJob({ id, project, kind, status: 'running', lines: [] })
  }, [])

  const onSettled = useCallback((fn: () => void) => {
    listeners.current.add(fn)
    return () => { listeners.current.delete(fn) }
  }, [])

  const jobId = job?.id
  const jobKind = job?.kind
  const running = job?.status === 'running'
  useEffect(() => {
    if (!jobId || !running) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    const tick = async () => {
      let j
      try { j = await getJob(jobId); failures = 0 }
      catch {
        if (!alive) return
        failures++
        if (failures >= 3) { listeners.current.forEach(fn => fn()); setJob(null); return }
        timer = setTimeout(tick, intervalMs)
        return
      }
      if (!alive) return
      setPhases(parseJobPhases(jobKind!, j.lines))
      if (j.status === 'running') { timer = setTimeout(tick, intervalMs) }
      else {
        setJob(prev => prev ? { ...prev, status: j.status, lines: j.lines } : prev)
        listeners.current.forEach(fn => fn())
      }
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [jobId, jobKind, running, intervalMs])

  return <JobContext.Provider value={{ job, phases, adopt, onSettled }}>{children}</JobContext.Provider>
}

export function useActiveJob(): Ctx {
  const c = useContext(JobContext)
  if (!c) throw new Error('useActiveJob ausserhalb JobProvider')
  return c
}
