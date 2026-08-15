import { toast } from 'sonner'

/**
 * Der Rueckweg fuer eine Streichung, die sofort passiert (#154).
 *
 * Anmerkung und Segment-Notiz werden durch **Leeren** gestrichen — es gibt keinen Loeschknopf,
 * den man versehentlich nicht trifft, und der Autosave schreibt das 800 ms spaeter weg. Anders
 * als beim Segmenttext (dort haelt `raw_text` die Erstfassung) hat beides **keine Zweitschrift**:
 * weg ist weg. Und in genau diesen Feldern steht, was die Korrektur NICHT raten wollte — ein
 * verlorener Eintrag heisst eine unsichere Stelle, von der niemand mehr weiss, dass sie unsicher
 * war.
 *
 * Der Rueckweg geht ueber **denselben** Schreibpfad wie die Streichung (`onChange` bzw.
 * `updateSegment` → `beruehrt()` → Autosave). Kein zweiter Speicherweg, kein Zustand daneben —
 * dieselbe Regel wie beim Autosave: zwei Wahrheiten darueber, wann ein Dokument gesichert ist,
 * waren hier schon zweimal ein stiller Datenverlust.
 */
export function gestrichen(was: string, zurueck: () => void) {
  toast(`${was} gestrichen`, { action: { label: 'Rückgängig', onClick: zurueck } })
}
