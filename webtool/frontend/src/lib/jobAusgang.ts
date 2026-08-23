import type { JobPhases } from './types'

/**
 * Wie ein Lauf ausgegangen ist — EINE Entscheidung, zwei Darstellungen.
 *
 * Es gibt zwei Flaechen, die das Ende eines Laufs melden: `useJobAusgang` (Toast im Fenster)
 * und `useOsFortschritt` (Meldung des Betriebssystems). Beide hatten ihre eigene Fassung
 * davon, und sie liefen auseinander: der OS-Zwilling bildete `status === 'done'`
 * bedingungslos auf „fertig" ab und meldete damit Erfolg ueber einen Lauf, in dem einzelne
 * Dateien gescheitert sind — ausgerechnet der Person gegenueber, die NICHT hinsieht und fuer
 * die die OS-Meldung ueberhaupt existiert.
 *
 * Deshalb steht das Urteil hier, ohne DOM und ohne Toast: eine reine Funktion, die beide
 * Seiten fragen. Wer eine dritte Flaeche baut, fragt dieselbe.
 */
export type Ausgang =
  | { art: 'erfolg' }
  | { art: 'abbruch' }
  /** Der Lauf selbst ist gescheitert (Exitcode != 0, oder der Provider hat aufgegeben). */
  | { art: 'fehler' }
  /** `done`, aber einzelne Aufnahmen sind gescheitert — der Fall, um den es in #376 geht. */
  | { art: 'teil'; misslungen: string[]; versucht: number }
  /** Nur der URL-Import: er kennt keine Basisnamen, nur seine Bilanz. */
  | { art: 'unvollstaendig'; ok: number; gesamt: number }

export function ausgang(j: { status: string; phases: JobPhases }): Ausgang {
  if (j.status === 'cancelled') return { art: 'abbruch' }
  if (j.status !== 'done') return { art: 'fehler' }

  const misslungen = Object.entries(j.phases.perBase)
    .filter(([, zustand]) => zustand === 'failed')
    .map(([base]) => base)
    .sort((a, b) => a.localeCompare(b, 'de'))
  if (misslungen.length) {
    // Nenner sind die VERSUCHTEN, nicht alle Eintraege: ein Lauf ueber ein gewachsenes
    // Projekt druckt fuer jede schon fertige Datei `skip (vorhanden)`. Zaehlte der Nenner die
    // mit, hiesse es „1 von 14 fehlgeschlagen", und der Nutzer sucht dreizehn Aufnahmen, die
    // nie angefasst wurden.
    const versucht = Object.values(j.phases.perBase).filter(z => z !== 'skipped').length
    return { art: 'teil', misslungen, versucht }
  }

  // Der URL-Import laedt seine Dateien erst herunter, hat also keine Basisnamen und damit nie
  // einen `perBase`-Eintrag — der Zweig darueber greift bei ihm nie. Ohne die Bilanz meldete
  // ein Import, bei dem 2 von 5 Videos tot sind, glatten ERFOLG: `fetch.py:576` wirft nur,
  // wenn GAR nichts geladen wurde.
  const b = j.phases.bilanz
  if (b && b.ok < b.gesamt) return { art: 'unvollstaendig', ok: b.ok, gesamt: b.gesamt }

  return { art: 'erfolg' }
}
