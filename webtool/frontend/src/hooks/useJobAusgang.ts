import { useEffect } from 'react'
import { toast } from 'sonner'
import { getJob } from '@/lib/api'
import { useActiveJob, type Job } from './useActiveJob'
import { ausgang } from '@/lib/jobAusgang'
import { KIND_LABEL } from '@/lib/jobPhases'

/**
 * Der Ausgang JEDES Laufs, an EINER Stelle — im Fenster.
 *
 * Vorher hing die Ausgangsmeldung am Startweg, und es gibt mehrere davon: die Knoepfe der
 * Seitenleiste gehen ueber `useJob`, die der Arbeitsflaeche ueber `startJob`, dazu der
 * Auto-Start nach dem Upload. Wer einen Lauf von der Arbeitsflaeche aus startete, bekam ueber
 * seinen Ausgang **gar nichts**: die Job-Leiste haengt an `status === 'running'` und
 * verschwindet mit dem Lauf, die Statuszeile sagt wieder „Bereit". Dieselben Knoepfe in der
 * Seitenleiste meldeten einen Fehler — zwei Wege zum selben Lauf, zwei Wahrheiten.
 *
 * `onSettled` ist die einzige Stelle, die JEDEN Ausgang sieht: der `JobProvider` pollt alle
 * adoptierten Jobs, gleich wer sie gestartet hat. **Das setzt voraus, dass jeder Startweg
 * adoptiert** — sonst faellt die Meldung dort aus (siehe #381 fuer den einen Weg, der es
 * nicht kann).
 *
 * WAS gemeldet wird, entscheidet `lib/jobAusgang.ts` — dieselbe Funktion fragt der
 * OS-Zwilling `useOsFortschritt`. Hier steht nur, wie es im Fenster aussieht.
 */
export function useJobAusgang(): void {
  const { onSettled } = useActiveJob()

  useEffect(() => onSettled(beendet => {
    for (const j of beendet) {
      // Ohne die Ellipse: `KIND_LABEL` ist als LAUFENDE Beschriftung gebaut („Korrigieren…"),
      // und „Korrigieren… fertig" liest sich wie ein halber Satz.
      const kopf = `${j.project}: ${(KIND_LABEL[j.kind] ?? j.kind).replace(/…$/, '')}`
      const a = ausgang(j)

      if (a.art === 'abbruch') {
        // Ein Abbruch ist eine Entscheidung, kein Unfall — und nachzulesen gibt es nichts.
        toast.warning(`${kopf} abgebrochen`, { duration: 4000 })
      } else if (a.art === 'erfolg') {
        toast.success(`${kopf} fertig`, { duration: 4000 })
      } else if (a.art === 'fehler') {
        melde(j, 'error', `${kopf} fehlgeschlagen`, [])
      } else if (a.art === 'teil') {
        melde(j, 'warning', `${kopf}: ${a.misslungen.length} von ${a.versucht} fehlgeschlagen`,
          a.misslungen)
      } else {
        melde(j, 'warning', `${kopf}: ${a.ok} von ${a.gesamt} geladen`, [])
      }
    }
  }), [onSettled])
}

/**
 * Meldung mit Begruendung — und die Begruendung wird VOR dem Toast geholt.
 *
 * Sind Dateinamen bekannt, sind sie die Antwort („welche?"). Sind sie es nicht — der Lauf
 * starb vor der ersten Datei, der Anbieter war nicht erreichbar, ein Video liess sich nicht
 * laden —, lautet die Frage „warum?", und darauf antworten nur die Log-Zeilen. `useJob`
 * zeigte dafuer die letzten drei; mit dem Umzug hierher waere das ersatzlos entfallen, und
 * weil die Zeilen mit dem Job sterben (#371) stuende der Grund danach NIRGENDS mehr.
 *
 * **Erst holen, dann zeigen** — und das ist eine Korrektur: zuerst stand hier ein sofortiger
 * Toast, der spaeter ueber dieselbe `id` ersetzt wurde. An installiertem sonner gemessen
 * erweckt das einen vom Nutzer bereits WEGGEKLICKTEN Toast wieder (nach zugestelltem Dismiss
 * entsteht ein neuer, im selben Frame wird das Wegklicken storniert). Ein Toast, der sich
 * gegen den Nutzer neu oeffnet, ist schlimmer als einer, der eine Netzrunde spaeter kommt —
 * auf Loopback sind das Millisekunden.
 *
 * Schlaegt `getJob` fehl oder haengt es, kommt die Meldung ohne Grund: eine Diagnose, die
 * selbst scheitert, darf die Meldung nicht verschlucken.
 */
function melde(j: Job, art: 'error' | 'warning', titel: string, namen: string[]): void {
  const zeigen = (beschreibung?: string) =>
    toast[art](titel, { duration: 8000, description: beschreibung || undefined })
  if (namen.length) { zeigen(namen.join(', ')); return }

  // Gegen die Frist, und das ist KEINE Vorsichtsmassnahme: `getJob` hat kein Zeitlimit, und
  // seit die Begruendung VOR dem Toast geholt wird, verschluckt ein haengender Aufruf die
  // GANZE Meldung — also genau der stille Ausgang, gegen den dieser Hook gebaut ist. In der
  // Fassung davor (Toast zuerst, Grund nachgereicht) war ein Haenger folgenlos; die Umstellung
  // hat den Fall erst scharf gemacht. `einmal` sorgt dafuer, dass Frist und Antwort nicht
  // beide melden.
  let gezeigt = false
  const einmal = (beschreibung?: string) => { if (!gezeigt) { gezeigt = true; zeigen(beschreibung) } }
  const uhr = setTimeout(() => einmal(), GRUND_FRIST_MS)
  getJob(j.id)
    .then(r => { clearTimeout(uhr); einmal(grund(r.lines ?? [])) })
    .catch(() => { clearTimeout(uhr); einmal() })
}

/** So lange darf die Begruendung den Toast aufhalten. Grosszuegig gegenueber einem langsamen
 *  Job-Log, kurz genug, dass niemand auf eine Meldung wartet, die schon feststeht. */
const GRUND_FRIST_MS = 3000

/**
 * Die drei Zeilen, die am ehesten den Grund tragen.
 *
 * Bevorzugt Zeilen, die sich selbst als Fehler bezeichnen: der URL-Import druckt seine
 * `[fetch] FEHLER <url>: …` beliebig weit oben und danach jeden Erfolg plus die Bilanz
 * (`fetch.py:455/458/575`) — die blanken letzten drei Zeilen zeigten dort auf die geglueckten
 * Downloads statt auf den Grund. Findet sich keine solche Zeile, bleibt es beim Ende des
 * Protokolls (der Transkriptionslauf endet mit seinem Wurf, dort ist das richtig).
 */
function grund(lines: string[]): string {
  const nicht_leer = lines.filter(l => l.trim())

  // Strukturierte Diagnose aus dem Korrekturlauf (`[diagnose] <kategorie>\t<titel>\t<hinweis>`)
  for (let i = nicht_leer.length - 1; i >= 0; i--) {
    const m = nicht_leer[i].match(/\[diagnose\]\s*([^\t]+)\t([^\t]+)\t(.+)/)
    if (m) {
      return `${m[2]}: ${m[3]}`
    }
  }

  const fehlerzeilen = nicht_leer.filter(l => /FEHLER|Fehler|Error|Traceback/.test(l))
  return (fehlerzeilen.length ? fehlerzeilen : nicht_leer).slice(-3).join(' · ')
}
