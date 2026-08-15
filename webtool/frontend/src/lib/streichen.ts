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
/**
 * Die offenen Rueckwege. Sie zeigen auf DAS Dokument, aus dem gestrichen wurde — und sonst auf
 * nichts: `updateDoc`/`updateSegment` sind ueber `useCallback` stabil und schreiben per Updater
 * in das Dokument, das GERADE offen ist. Ein Rueckruf, der einen Dokumentwechsel ueberlebt,
 * traegt den Eintrag der alten Datei in die neue, und der Autosave legt ihn 800 ms spaeter ab
 * — stiller Datenverlust in genau dem Feld, gegen dessen Verlust #154 geschrieben wurde,
 * nur in einer fremden Datei, wo niemand danach sucht. Dieselbe Achse wie #116/#106.
 */
let offen: (string | number)[] = []

export function gestrichen(was: string, zurueck: () => void) {
  // 10 s statt sonners 4: das hier ist eine Datenrettung, keine Erfolgsmeldung — vier Sekunden
  // reichen zum Lesen, nicht zum Entscheiden. Gefahrlos erst, seit der Rueckweg beim
  // Dokumentwechsel entwertet wird; ohne das vergroesserte jede laengere Standzeit den Schaden.
  offen.push(toast(`${was} gestrichen`, {
    duration: 10_000,
    action: { label: 'Rückgängig', onClick: zurueck },
  }))
}

/**
 * Entwertet alle offenen Rueckwege. Gerufen bei **jedem** Dokumentwechsel (`useDoc.reload` und
 * der Cleanup des `[project, base]`-Effekts, der auch das Unmount deckt).
 *
 * **Wegnehmen, nicht falsch feuern lassen.** Ein Toast, der nach dem Wechsel noch dasteht, ist
 * entweder ein Schreibvorgang in die falsche Datei (Wechsel) oder ein Knopf, der stumm nichts
 * tut (Unmount — React verwirft `setDoc` auf einem abgebauten Hook kommentarlos). Beides ist
 * schlechter als kein Angebot: der Nutzer glaubt, sein Eintrag sei zurueck, und traegt ihn
 * nicht von Hand nach.
 */
export function streichungenVergessen() {
  offen.forEach(id => toast.dismiss(id))
  offen = []
}
