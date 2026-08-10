import { useEffect, useRef } from 'react'
import { useActiveJob } from './useActiveJob'
import { useProjekte } from './useProjektDaten'
import { KIND_LABEL } from '@/lib/jobPhases'

function bruecke() {
  const w = window as unknown as {
    transkribor?: { fortschritt?: (a: number, modus?: string) => Promise<void> }
  }
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

  // `beendet` ist die Nutzlast des Ereignisses (useActiveJob.tsx) -- schon auf die JUST terminal
  // gewordenen Jobs dieses Ticks beschraenkt. Kein eigener Riegel noetig: useActiveJob.tsx
  // dedupliziert selbst (zuletzt-Tracking, siehe Kommentar an der beendet-Stelle dort).
  useEffect(() => onSettled(beendet => {
    for (const j of beendet) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') continue
      const was = KIND_LABEL[j.kind] ?? j.kind
      // Drei Ausgaenge, drei Texte. Ein Abbruch ist eine Entscheidung des Nutzers und darf
      // nicht wie ein Unfall klingen -- und nachzulesen gibt es dort nichts, er weiss ja,
      // was er getan hat. Wortlaut wie in useJob.ts, damit dieselbe Sache nicht zwei
      // Namen hat.
      const [ausgang, body] = j.status === 'done'
        ? ['fertig', 'Das Ergebnis liegt im Projekt.']
        : j.status === 'cancelled'
          ? ['abgebrochen', 'Der Lauf wurde auf deinen Wunsch beendet.']
          : ['fehlgeschlagen', 'Details stehen im Protokoll.']
      new Notification(`${j.project}: ${was} ${ausgang}`, { body })
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
  // Rot heisst "etwas ist schiefgegangen, waehrend noch etwas laeuft" -- und zwar SEIT der
  // Balken zuletzt leer war. `jobs` gibt keinen je adoptierten Job wieder her, ein
  // Fehlschlag von vor einer Stunde faerbte sonst jeden spaeteren Lauf mit; darum werden
  // die bereits gescheiterten Kennungen bei jedem Leerlauf beiseitegelegt.
  // NUR 'error': ein Abbruch ist eine Entscheidung des Nutzers und darf nicht wie ein
  // Fehler aussehen (useActiveJob setzt 'error' auch selbst, nach dreimal weg).
  // Der Schnappschuss wird im LEERLAUF genommen, gebraucht wird er erst beim naechsten Lauf --
  // dazwischen liegt mindestens ein Commit, der Effekt ist also rechtzeitig durch. Darum darf
  // er hier stehen und muss NICHT in die Renderphase (React verbietet das Schreiben von Refs
  // dort ausdruecklich, und unter Concurrent Rendering liefe es auch fuer Durchlaeufe, die nie
  // committen).
  const alteFehler = useRef(new Set<string>())
  useEffect(() => {
    if (anteil < 0) alteFehler.current = new Set(jobs.filter(j => j.status === 'error').map(j => j.id))
  }, [anteil, jobs])
  const modus = anteil >= 0 && jobs.some(j =>
    j.project === projekt?.name && j.status === 'error' && !alteFehler.current.has(j.id))
    ? 'error' : undefined
  useEffect(() => { bruecke()?.(anteil, modus)?.catch?.(() => {}) }, [anteil, modus])
}
