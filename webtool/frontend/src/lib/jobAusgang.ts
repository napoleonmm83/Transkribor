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
  /** Der Lauf ist aus der Sicht der Oberflaeche zu Ende, sein Ausgang aber UNBEKANNT — der
   *  Server antwortet, kennt die Kennung nur nicht mehr (Registry im Arbeitsspeicher, ein
   *  Neustart leert sie).
   *
   *  GEMESSEN und deshalb hier benannt, statt schoenzureden: bei einem GEORDNETEN Neustart
   *  ruft der Lifespan `jobs.cancel_all()` und toetet den Lauf samt Prozessbaum — auf Windows
   *  tut `taskkill /F /T` dasselbe. In genau diesem Fall war das frueher gemeldete
   *  „fehlgeschlagen" SACHLICH RICHTIG. Der Lauf ueberlebt nur einen Absturz oder Haenger.
   *  Eine erste Fassung dieses Kommentars behauptete „ueber einen Lauf, der oft sauber
   *  durchgelaufen war" — eine Haeufigkeitsbehauptung ohne Messung, die in die Gegenrichtung
   *  zeigt (Befund des `was-erlaubt-der-fix-neu`-Pruefers). */
  | { art: 'unbekannt' }

export function ausgang(j: { status: string; phases: JobPhases }): Ausgang {
  if (j.status === 'cancelled') return { art: 'abbruch' }
  if (j.status === 'verschwunden') return { art: 'unbekannt' }
  if (j.status !== 'done') return { art: 'fehler' }

  const misslungen = Object.entries(j.phases.perBase)
    .filter(([, zustand]) => zustand === 'failed')
    .map(([base]) => base)
    .sort((a, b) => a.localeCompare(b, 'de'))
  if (misslungen.length) {
    // Nenner sind die VERSUCHTEN, nicht alle Eintraege: sonst hiesse es „1 von 14
    // fehlgeschlagen", und der Nutzer sucht dreizehn Aufnahmen, die nie angefasst wurden.
    // Der urspruengliche Ausloeser war `skip (vorhanden)` — ein Lauf ueber ein gewachsenes
    // Projekt druckte das fuer jede schon fertige Datei. Diese Form gibt es seit dem
    // gestaffelten Lauf nicht mehr; 'skipped' kommt heute aus `correct`s `apply: SKIP …`
    // („deine Handarbeit bleibt stehen"), und dafuer gilt dieselbe Rechnung: absichtlich in
    // Ruhe gelassen ist nicht versucht.
    const versucht = Object.values(j.phases.perBase).filter(z => z !== 'skipped').length
    return { art: 'teil', misslungen, versucht }
  }

  // Der URL-Import laedt seine Dateien erst herunter, hat also keine Basisnamen und damit nie
  // einen `perBase`-Eintrag — der Zweig darueber greift bei ihm nie. Ohne die Bilanz meldete
  // ein Import, bei dem 2 von 5 Videos tot sind, glatten ERFOLG: `fetch.py:576` wirft nur,
  // wenn GAR nichts geladen wurde.
  //
  // Die Reihenfolge (erst `perBase`, dann Bilanz) verliert nichts: BEIDES zugleich gibt es
  // nicht. Der fetch-JOB faehrt immer `--download-only` (app.py:1005) und druckt
  // ausschliesslich `[fetch] `-Zeilen — die verwirft `jobPhases.ts:54` saemtlich, es entsteht
  // dort also nie ein `perBase`-Eintrag; die anschliessende Transkription ist ein EIGENER Job
  // (ueber `then=`) und druckt keine `[fetch]`-Zeile. Wer das aendert, prueft diese Stelle mit:
  // dann faellt die Bilanz still unter den Tisch.
  const b = j.phases.bilanz
  if (b && b.ok < b.gesamt) return { art: 'unvollstaendig', ok: b.ok, gesamt: b.gesamt }

  return { art: 'erfolg' }
}
