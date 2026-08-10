import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '@/lib/types'
import { listProjects } from '@/lib/api'

const POLL_MS = 4000

/** Projektliste, die sich selbst aktuell haelt.
 *
 *  Der Poll ist noetig, seit Jobs auch OHNE Klick starten (Upload loest die Transkription aus,
 *  die wiederum die Korrektur). Ohne ihn saehe der Tab weder die neue Datei noch den fremd
 *  gestarteten Job — `active_jobs` kommt aus genau diesem Endpoint und ist die Quelle, aus der
 *  der JobProvider laufende Jobs adoptiert.
 *
 *  Das Intervall ist eine Konstante und kein Parameter: es gibt genau einen Aufrufer
 *  (`ProjektDatenProvider`), und der einzige je uebergebene Wert war der Vorgabewert. Ein
 *  Parameter, den niemand anders belegt, laedt zur Falle ein — `useProjects(0)` hiess frueher
 *  "einmal holen" und waere heute ein `setInterval(..., 0)`. */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  // Wie useProjectFiles.fehler: gesetzt im .catch, zurueckgesetzt bei jedem Erfolg. Ohne das
  // Flag sah eine gescheiterte Anfrage wie ein leeres projects[] aus -- die Galerie zeigte
  // "Noch keine Projekte" als Tatsache statt eines Fehlers.
  const [fehler, setFehler] = useState(false)
  const laeuft = useRef(false)
  const refresh = useCallback(() => {
    if (laeuft.current) return          // langsame Antwort darf keine Anfragen aufstauen
    laeuft.current = true
    // setLoading nur beim ersten Mal: ein Poll-Flackern alle 4s waere die Liste nicht wert
    listProjects().then(p => { setProjects(p); setFehler(false) }).catch(() => setFehler(true))
      .finally(() => { laeuft.current = false; setLoading(false) })
  }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh])
  return { projects, loading, fehler, refresh }
}
