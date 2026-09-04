import { useEffect, useRef } from 'react'
import { useActiveJob, zeigtLauf } from './useActiveJob'
import { ausgang } from '@/lib/jobAusgang'
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
      // WAS ausgegangen ist, entscheidet `lib/jobAusgang.ts` — dieselbe Funktion fragt der
      // Toast im Fenster. Hier stand eine eigene Fassung, und sie war die schlechtere: sie
      // bildete `done` bedingungslos auf „fertig" ab und meldete damit Erfolg ueber einen
      // Lauf, in dem einzelne Aufnahmen gescheitert sind. Ausgerechnet hier wiegt das am
      // schwersten — die OS-Meldung existiert fuer die Person, die NICHT hinsieht, und genau
      // die ist die Zielperson von #376.
      const a = ausgang(j)
      // `unbekannt` braucht einen EIGENEN Zweig, sonst faellt es durch die Kette bis zum
      // Schluss und wird als „fehlgeschlagen" gemeldet — als Systembenachrichtigung, also an
      // die Person, die gerade nicht hinsieht. Das ist die Falschmeldung aus #382 in ihrer
      // teuersten Form. Geschwiegen wird hier trotzdem nicht: bei einem geordneten Neustart
      // ist der Lauf wirklich abgebrochen, und ausgerechnet diese Person erfuehre es sonst
      // gar nicht.
      const [wie, body] = a.art === 'erfolg'
        ? ['fertig', 'Das Ergebnis liegt im Projekt.']
        : a.art === 'unbekannt'
        ? ['Ausgang unbekannt', 'Die Verbindung zum Lauf ist abgerissen.']
        : a.art === 'abbruch'
          ? ['abgebrochen', 'Der Lauf wurde auf deinen Wunsch beendet.']
          : a.art === 'teil'
            ? [`${a.misslungen.length} von ${a.versucht} fehlgeschlagen`, a.misslungen.join(', ')]
            : a.art === 'unvollstaendig'
              ? [`${a.ok} von ${a.gesamt} geladen`, 'Nicht jede Adresse liess sich laden.']
              : ['fehlgeschlagen', 'Details stehen im Protokoll.']
      new Notification(`${j.project}: ${was} ${wie}`, { body })
    }
  }), [onSettled])

  // Erlaubnis EINMAL erfragen, nicht bei jedem Lauf: unter Electron ist sie ohnehin
  // erteilt, im Browser waere eine wiederholte Frage aufdringlich.
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  const laufend = jobs.filter(j => zeigtLauf(j.status))
  const projekt = projects.find(p => p.name === laufend[0]?.project)
  /** Laeuft gerade nichts? DAS ist der Leerlauf — nicht „kein Balken zu zeichnen" (#76). */
  const leerlauf = laufend.length === 0
  // -1 raeumt den Balken ab. Ohne das bleibt er nach dem letzten Lauf fuer immer stehen.
  const anteil = leerlauf || !projekt || projekt.dateien === 0
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
  //
  // Der Schnappschuss haengt an `leerlauf`, NICHT an `anteil < 0` (#76): `anteil` wird auch
  // negativ, waehrend etwas laeuft — naemlich solange das Projekt noch nicht in der
  // Zusammenfassung steht (der Poll ist bis zu 4 s alt) oder `dateien === 0` meldet. In genau
  // diesem Fenster wurde ein frischer Fehlschlag beiseitegelegt und blieb es: er faerbte den
  // laufenden Balken nie rot. Folge war ein FEHLENDES Rot — die Richtung, die man nicht
  // bemerkt, weil nichts passiert.
  const alteFehler = useRef(new Set<string>())
  useEffect(() => {
    if (leerlauf) alteFehler.current = new Set(jobs.filter(j => j.status === 'error').map(j => j.id))
  }, [leerlauf, jobs])
  const modus = anteil >= 0 && jobs.some(j =>
    j.project === projekt?.name && j.status === 'error' && !alteFehler.current.has(j.id))
    ? 'error' : undefined
  useEffect(() => { bruecke()?.(anteil, modus)?.catch?.(() => {}) }, [anteil, modus])
}
