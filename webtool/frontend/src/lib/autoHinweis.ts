/** Der Erklärsatz zur `auto`-Regel — EINE Quelle für drei Stellen (#301).
 *
 *  Verwendet im Datei-Dialog, im Projekt-Dialog und in Schritt 3 des Material-Dialogs.
 *  Drei Formulierungen desselben Sachverhalts wären drei Gelegenheiten, ihn verschieden
 *  falsch zu erklären — und genau das war schon passiert (siehe unten).
 *
 *  **Es gibt zwei Fälle, nicht drei, und das ist gemessen.** Der Projekt-Standard gewinnt
 *  gegen die Detektion nur, wenn sein Whisper-Code ihr entspricht — sichtbar wird das
 *  ausschliesslich dort, wo sich zwei ids einen Code teilen. Nachgemessen an
 *  `sprachen.von_whisper_code`:
 *
 *      erkannt   Standard   mit Vorrang   ohne Vorrang
 *      de        ch         ch            de            <- der EINZIGE Unterschied
 *      de        en         de            de
 *      en        ch         en            en
 *      fr        ch         fr            fr
 *
 *  Der Satz in Schritt 3 des Material-Dialogs stand deshalb auf der falschen Bedingung
 *  (`projektSprache !== 'auto'`): ein englisches Projekt bekam „Wird Deutsch erkannt, gilt
 *  der Projekt-Standard Englisch" — gemessen gilt dort `de`.
 *
 *  **Das `dialekt`-Flag kommt vom Server** (`sprachen.fuer_frontend`), nicht aus einem
 *  hartverdrahteten `'ch'`: die Tabelle in `sprachen.py` ist die EINE Quelle, und eine
 *  zweite Dialekt-Sprache zöge die Oberfläche so von selbst mit.
 */
export function autoHinweis(
  gewaehlt: string,
  projektStandard: string | null,
  wahl: { id: string; label: string; dialekt?: boolean }[],
): string | null {
  if (gewaehlt !== 'auto') return null
  const OHNE = 'Es gilt, was Whisper erkennt. Schweizerdeutsch wird dabei als Deutsch '
             + 'behandelt, ohne Dialekt-Glättung.'
  // `null` heisst „es gibt keinen übergeordneten Standard" (Projekt-Dialog), `'auto'` heisst
  // „er trifft nie" — beides sicher, also OHNE.
  //
  // **`''` gehört ausdrücklich NICHT hierher.** Es heisst „noch nicht geladen", nicht „keiner
  // da" — der Standard könnte `ch` sein, und OHNE wäre dann eine Falschaussage. Ein früheres
  // `!projektStandard` warf beides in denselben Zweig und verkaufte das als Gewinn. `''`
  // fällt jetzt durch bis zum `find`, findet nichts und führt zum Schweigen — dieselbe
  // Richtung wie beim fehlenden Flag unten. (Reviewbefund m3; heute nicht erreichbar,
  // nachgeprüft — es ist ein Zeichen, kein Fix.)
  if (projektStandard === null || projektStandard === 'auto') return OHNE
  const c = wahl.find(x => x.id === projektStandard)
  // Unbekannter Standard oder fehlendes Flag (älterer Server): dann ist UNBEKANNT, welcher
  // der beiden Sätze stimmt — und „ohne Dialekt-Glättung" wäre eine mögliche Falschaussage.
  // Schweigen ist hier die ehrliche Richtung, nicht die bequeme.
  if (!c || typeof c.dialekt !== 'boolean') return null
  return c.dialekt
    ? `Wird Deutsch erkannt, gilt der Projekt-Standard „${c.label}“ — also mit Dialekt-Glättung.`
    : OHNE
}
