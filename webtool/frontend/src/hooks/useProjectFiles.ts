import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProjectFile } from '@/lib/types'
import { getProjectFiles } from '@/lib/api'

function leer(project: string) {
  return { project, sitzung: {}, files: [] as ProjectFile[], loading: !!project, fehler: false }
}

/** Dateien eines Projekts; Nachladen erfolgt durch die Job-/Summenpoll-Verbraucher. */
export function useProjectFiles(project: string) {
  const [zustand, setZustand] = useState(() => leer(project))
  // Der Projektbezug ist State: auch ein Zwischenrender darf keine fremden Dateien liefern.
  if (zustand.project !== project) setZustand(leer(project))
  const { sitzung } = zustand
  const aktiv = useRef<object | null>(sitzung)
  const kennung = useRef(0)
  useLayoutEffect(() => {
    aktiv.current = sitzung
    return () => { aktiv.current = null }
  }, [sitzung])
  const refresh = useCallback(() => {
    if (!project || aktiv.current !== sitzung) return
    const meineKennung = ++kennung.current
    // Sitzungsidentitaet trennt auch A -> B -> A; Kennung trennt parallele Refreshs in A.
    const aktuell = () => aktiv.current === sitzung && meineKennung === kennung.current
    getProjectFiles(project)
      .then(r => { if (aktuell()) setZustand(z => z.sitzung === sitzung ? { ...z, files: r.files, fehler: false } : z) })
      .catch(() => { if (aktuell()) setZustand(z => z.sitzung === sitzung ? { ...z, fehler: true } : z) })
      .finally(() => { if (aktuell()) setZustand(z => z.sitzung === sitzung ? { ...z, loading: false } : z) })
  }, [project, sitzung])
  useEffect(() => { refresh() }, [refresh])
  const passend = zustand.project === project
  return {
    files: passend ? zustand.files : [],
    loading: passend ? zustand.loading : !!project,
    fehler: passend ? zustand.fehler : false,
    refresh,
  }
}
