import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectFile } from '@/lib/types'
import { getProjectFiles } from '@/lib/api'

/** Dateien EINES Projekts. Kein Poll: die Arbeitsflaeche/der Editor erfahren Aenderungen ueber
 *  den Job-Status (useActiveJob.onSettled bzw. useJob's onDone) und rufen refresh() dort selbst
 *  — ein zweiter Poll hier waere genau die Verdopplung, die diese Aufteilung abschaffen soll. */
export function useProjectFiles(project: string) {
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [loading, setLoading] = useState(true)
  const laeuft = useRef(false)
  const refresh = useCallback(() => {
    if (!project || laeuft.current) return
    laeuft.current = true
    getProjectFiles(project).then(r => setFiles(r.files)).catch(() => {})
      .finally(() => { laeuft.current = false; setLoading(false) })
  }, [project])
  useEffect(() => { refresh() }, [refresh])
  return { files, loading, refresh }
}
