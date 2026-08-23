import { useEffect } from 'react'
import { toast } from 'sonner'
import { useActiveJob, type Job } from './useActiveJob'
import { KIND_LABEL } from '@/lib/jobPhases'

/**
 * Der Ausgang JEDES Laufs, an EINER Stelle — im Browser wie in der App.
 *
 * Vorher hing die Ausgangsmeldung am Startweg, und es gibt zwei davon: die Knoepfe der
 * Seitenleiste gehen ueber `useJob` (eigener Poll, eigener Toast), die der Arbeitsflaeche
 * ueber `startJob` (nur `adopt` + „gestartet") und der Auto-Start nach dem Upload ueber den
 * MaterialDialog. Wer einen Lauf von der Arbeitsflaeche aus startete, bekam ueber seinen
 * Ausgang **gar nichts**: die Job-Leiste haengt an `status === 'running'` und verschwindet
 * mit dem Lauf, die Statuszeile sagt wieder „Bereit", die Datei-Pillen fallen auf den
 * Ruhezustand zurueck. Dieselben Knoepfe in der Seitenleiste meldeten einen Fehler — zwei
 * Wege zum selben Lauf, zwei Wahrheiten ueber sein Ende.
 *
 * `onSettled` ist die einzige Stelle, die JEDEN Ausgang sieht: der `JobProvider` pollt alle
 * adoptierten Jobs, gleich wer sie gestartet hat. Deshalb steht die Meldung hier und nicht
 * in den Startwegen — sonst braeuchte jeder neue Startweg seine eigene Kopie, und die
 * naechste liefe wieder auseinander.
 *
 * Zwilling von `useOsFortschritt`: dort die Meldung des BETRIEBSSYSTEMS (nur mit erteilter
 * Erlaubnis, im Browser per Default also nie), hier die im Fenster. Beide muessen sein —
 * die eine erreicht den Nutzer, der weggeklickt hat, die andere den, der hinsieht.
 */
export function useJobAusgang(): void {
  const { onSettled } = useActiveJob()

  useEffect(() => onSettled(beendet => {
    for (const j of beendet) {
      // Ohne die Ellipse: `KIND_LABEL` ist als LAUFENDE Beschriftung gebaut („Korrigieren…"),
      // und „Korrigieren… fertig" liest sich wie ein halber Satz.
      const was = (KIND_LABEL[j.kind] ?? j.kind).replace(/…$/, '')
      const kopf = `${j.project}: ${was}`
      const misslungen = fehlgeschlagene(j)
      const namen = misslungen.join(', ')

      if (j.status === 'cancelled') {
        // Ein Abbruch ist eine Entscheidung, kein Unfall — und nachzulesen gibt es nichts.
        // Wortlaut wie in `useOsFortschritt`, damit dieselbe Sache nicht zwei Namen hat.
        toast.warning(`${kopf} abgebrochen`, { duration: 4000 })
      } else if (j.status !== 'done') {
        toast.error(`${kopf} fehlgeschlagen`, { duration: 8000, description: namen || undefined })
      } else if (misslungen.length) {
        // DER Fall, um den es geht: der Lauf endet mit Exitcode 0 und gilt als `done`, obwohl
        // einzelne Dateien gescheitert sind. `correct.py:1064` wirft nur, wenn KEINE Datei
        // gelang; `transcribe.py:501` ueberspringt eine kaputte und laeuft weiter. Ein
        // blankes „fertig" darueber ist die teuerste Falschaussage der ganzen Kette: der
        // Nutzer haelt das Projekt fuer durchgearbeitet und sieht nie wieder hin.
        toast.warning(`${kopf}: ${misslungen.length} von ${Object.keys(j.phases.perBase).length} fehlgeschlagen`,
          { duration: 8000, description: namen })
      } else {
        toast.success(`${kopf} fertig`, { duration: 4000 })
      }
    }
  }), [onSettled])
}

/**
 * Die gescheiterten Aufnahmen des Laufs — aus den Phasen, nicht aus den Rohzeilen.
 *
 * `useJob` zeigte im Fehlerfall die letzten drei Log-Zeilen. Die sind fuer den Parser
 * geschrieben, nicht fuer Menschen (derselbe Grund, aus dem `describePhases` existiert), und
 * sie beantworten die eine Frage nicht, die hier zaehlt: WELCHE Datei. `perBase` beantwortet
 * genau die.
 */
function fehlgeschlagene(j: Job): string[] {
  return Object.entries(j.phases.perBase)
    .filter(([, zustand]) => zustand === 'failed')
    .map(([base]) => base)
    .sort((a, b) => a.localeCompare(b, 'de'))
}
