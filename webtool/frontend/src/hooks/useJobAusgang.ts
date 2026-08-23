import { useEffect } from 'react'
import { toast } from 'sonner'
import { getJob } from '@/lib/api'
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
 * Erlaubnis, im Browser per Default also nie), hier die im Fenster.
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
      const b = j.phases.bilanz

      if (j.status === 'cancelled') {
        // Ein Abbruch ist eine Entscheidung, kein Unfall — und nachzulesen gibt es nichts.
        // Wortlaut wie in `useOsFortschritt`, damit dieselbe Sache nicht zwei Namen hat.
        toast.warning(`${kopf} abgebrochen`, { duration: 4000 })
      } else if (j.status !== 'done') {
        melde('error', `${kopf} fehlgeschlagen`, misslungen, j)
      } else if (misslungen.length) {
        // DER Fall, um den es geht: der Lauf endet mit Exitcode 0 und gilt als `done`, obwohl
        // einzelne Dateien gescheitert sind. `correct.py:1064` wirft nur, wenn KEINE Datei
        // gelang; `transcribe.py` kennt ueberhaupt keinen `SystemExit` und laeuft ueber jede
        // kaputte Aufnahme hinweg. Ein blankes „fertig" darueber ist die teuerste
        // Falschaussage der Kette: der Nutzer haelt das Projekt fuer durchgearbeitet.
        //
        // Nenner sind die VERSUCHTEN, nicht alle Eintraege: ein Lauf ueber ein 14er-Projekt,
        // in dem 13 Dateien schon fertig waren („skip (vorhanden)"), meldete sonst
        // „1 von 14 fehlgeschlagen" — und der Nutzer sucht dreizehn Aufnahmen, die nie
        // angefasst wurden.
        const versucht = Object.values(j.phases.perBase).filter(z => z !== 'skipped').length
        melde('warning', `${kopf}: ${misslungen.length} von ${versucht} fehlgeschlagen`, misslungen, j)
      } else if (b && b.ok < b.gesamt) {
        // Der URL-Import kennt keine Basisnamen — er laedt sie ja erst herunter —, also gibt
        // es hier nie einen `perBase`-Eintrag und der Zweig darueber greift nicht. Ohne
        // diesen hier meldete ein Import, bei dem 2 von 5 Videos tot sind, glatten ERFOLG:
        // `fetch.py:576` wirft nur, wenn gar nichts geladen wurde. Der Fehlschlag war vorher
        // bloss unsichtbar; ihn als Erfolg zu behaupten waere schlimmer.
        melde('warning', `${kopf}: ${b.ok} von ${b.gesamt} geladen`, [], j)
      } else {
        toast.success(`${kopf} fertig`, { duration: 4000 })
      }
    }
  }), [onSettled])
}

/**
 * Meldung mit Begruendung — und die Begruendung wird NACHGEREICHT.
 *
 * Sind Dateinamen bekannt, sind sie die Antwort („welche?"). Sind sie es nicht — der Lauf
 * starb vor der ersten Datei, der Anbieter war nicht erreichbar, der Import fand kein Video —,
 * lautet die Frage aber „warum?", und darauf antworten nur die Log-Zeilen. `useJob` zeigte
 * dafuer die letzten drei; mit dem Umzug hierher waere das ersatzlos entfallen, und weil die
 * Zeilen mit dem Job sterben (#371) stuende der Grund danach NIRGENDS mehr.
 *
 * Nachgereicht statt vorher geholt, weil der Toast nicht auf einen Netzaufruf warten soll;
 * `toast` mit derselben `id` ersetzt ihn an Ort und Stelle. Schlaegt der Aufruf fehl, bleibt
 * es bei der Meldung ohne Grund — eine Diagnose, die selbst scheitert, darf die Meldung
 * nicht verschlucken.
 */
function melde(art: 'error' | 'warning', titel: string, namen: string[], j: Job): void {
  const id = `${art}-${j.id}`
  const dauer = 8000
  toast[art](titel, { id, duration: dauer, description: namen.join(', ') || undefined })
  if (namen.length) return
  getJob(j.id)
    .then(r => {
      const grund = (r.lines ?? []).filter(l => l.trim()).slice(-3).join(' · ')
      if (grund) toast[art](titel, { id, duration: dauer, description: grund })
    })
    .catch(() => {})
}

/**
 * Die gescheiterten Aufnahmen des Laufs — aus den Phasen, nicht aus den Rohzeilen.
 * `perBase` beantwortet „welche Datei", und das ist bei einem Teilfehlschlag die Frage.
 */
function fehlgeschlagene(j: Job): string[] {
  return Object.entries(j.phases.perBase)
    .filter(([, zustand]) => zustand === 'failed')
    .map(([base]) => base)
    .sort((a, b) => a.localeCompare(b, 'de'))
}
