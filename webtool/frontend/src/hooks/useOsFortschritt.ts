import { useEffect, useRef } from 'react'
import { useActiveJob } from './useActiveJob'
import { useProjekte } from './useProjektDaten'
import { KIND_LABEL } from '@/lib/jobPhases'

function bruecke() {
  const w = window as unknown as { transkribor?: { fortschritt?: (a: number) => Promise<void> } }
  return w.transkribor?.fortschritt ?? null
}

/**
 * Die zwei Dinge, die eine App tut und eine Webseite nicht: Bescheid geben, wenn eine
 * halbe Stunde Rechnen vorbei ist, und den Fortschritt am Symbol in der Taskleiste zeigen.
 *
 * Beide sind im Browser wirkungslos, aber nicht kaputt: `Notification` gibt es dort auch
 * (nur mit Erlaubnisfrage), `fortschritt` fehlt und wird uebersprungen.
 */
export function useOsFortschritt(): void {
  const { jobs, onSettled } = useActiveJob()
  const { projects } = useProjekte()
  // Welche Laeufe schon gemeldet wurden. onSettled feuert bei JEDEM Tick, in dem irgendein Job
  // terminal ist -- ohne diesen Riegel meldet die App im Poll-Takt dasselbe noch einmal.
  const gemeldet = useRef(new Set<string>())

  // `beendet` ist die Nutzlast des Ereignisses (useActiveJob.tsx) -- schon auf die JUST terminal
  // gewordenen Jobs gefiltert, mit frischem Status. Kein `jobs` aus dem eigenen Render-Closure
  // noetig: das waere hier zwangslaeufig veraltet (der Aufruf kommt synchron vor dem Rerender).
  useEffect(() => onSettled(beendet => {
    for (const j of beendet) {
      if (gemeldet.current.has(j.id)) continue
      gemeldet.current.add(j.id)
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') continue
      const was = KIND_LABEL[j.kind] ?? j.kind
      new Notification(
        j.status === 'done' ? `${j.project}: ${was} fertig` : `${j.project}: ${was} fehlgeschlagen`,
        { body: j.status === 'done' ? 'Das Ergebnis liegt im Projekt.' : 'Details stehen im Protokoll.' },
      )
    }
  }), [onSettled])

  // Erlaubnis EINMAL erfragen, nicht bei jedem Lauf: unter Electron ist sie ohnehin
  // erteilt, im Browser waere eine wiederholte Frage aufdringlich.
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  const laufend = jobs.filter(j => j.status === 'running')
  const projekt = projects.find(p => p.name === laufend[0]?.project)
  // -1 raeumt den Balken ab. Ohne das bleibt er nach dem letzten Lauf fuer immer stehen.
  const anteil = laufend.length === 0 || !projekt || projekt.dateien === 0
    ? -1 : projekt.fertig / projekt.dateien
  useEffect(() => { bruecke()?.(anteil)?.catch?.(() => {}) }, [anteil])
}
