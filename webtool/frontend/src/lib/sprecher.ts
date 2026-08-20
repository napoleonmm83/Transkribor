/** Text aus einem Sprecher-Eingabefeld -> Wahl.
 *
 *  `null` = automatisch (Feld leer), `undefined` = ungueltige Eingabe, sonst die Zahl.
 *  Drei Zustaende, weil „leer" hier eine ENTSCHEIDUNG ist (automatisch erkennen lassen) und
 *  nicht dasselbe wie „falsch getippt" — derselbe Unterschied wie zwischen `"text": ""` und
 *  einem fehlenden `text`-Schluessel in `apply_correction`.
 *
 *  EINE Quelle fuer beide Eingabestellen (Datei-Dialog und Vorschau beim Hinzufuegen): zwei
 *  Fassungen derselben Regel driften, und die Folge waere ein Feld, das an einer Stelle
 *  sperrt und an der anderen den 400 des Servers vorlegt.
 *
 *  `max` kommt vom Aufrufer (aus `sprecher_max` im GET), damit `sprachen.SPRECHER_MAX` nicht
 *  ein zweites Mal im Frontend steht.
 */
export function sprecherWahl(text: string, max: number): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  // Reine Ziffernfolge, nicht `Number.isInteger(+t)`: letzteres liesse "1e1", "0x10" und
  // "2.0" durch — Schreibweisen, die niemand in ein Feld „Anzahl Sprecher" tippt und die der
  // Server (StrictInt) ohnehin zurueckwiese.
  return /^\d+$/.test(t) && +t >= 1 && +t <= max ? +t : undefined
}
