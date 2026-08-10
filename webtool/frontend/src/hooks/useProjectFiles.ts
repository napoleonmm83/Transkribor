import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectFile } from '@/lib/types'
import { getProjectFiles } from '@/lib/api'

/** Dateien EINES Projekts. Kein Poll: die Arbeitsflaeche/der Editor erfahren Aenderungen ueber
 *  den Job-Status (useActiveJob.onSettled bzw. useJob's onDone) und rufen refresh() dort selbst
 *  — ein zweiter Poll hier waere genau die Verdopplung, die diese Aufteilung abschaffen soll. */
export function useProjectFiles(project: string) {
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [loading, setLoading] = useState(true)
  // Traegt das GERADE angefragte Projekt. useProjects nutzt fuer sowas ein simples laeuft-Ref
  // ("eine langsame Antwort darf keine Anfragen aufstauen") — das passt dort, weil es dort NUR
  // einen unparametrisierten Poll gibt, wo ein uebersprungener Aufruf folgenlos ist. Hier haengt
  // die Anfrage an `project`: derselbe Guard wuerde beim Wechsel von project mitten in einer
  // laufenden Anfrage den neuen refresh() lautlos ueberspringen (laeuft.current noch true von der
  // alten Anfrage) UND, kaeme die alte Antwort danach herein, die Dateien des verlassenen
  // Projekts in den State des neuen schreiben. Darum hier: nie uebersprungen, sondern jede
  // Antwort gegen das inzwischen aktuelle Projekt geprueft und verworfen, wenn sie nicht passt.
  const angefragt = useRef(project)
  const refresh = useCallback(() => {
    if (!project) return
    angefragt.current = project
    getProjectFiles(project)
      .then(r => { if (angefragt.current === project) setFiles(r.files) })
      .catch(() => {})
      .finally(() => { if (angefragt.current === project) setLoading(false) })
  }, [project])
  useEffect(() => { refresh() }, [refresh])
  return { files, loading, refresh }
}
