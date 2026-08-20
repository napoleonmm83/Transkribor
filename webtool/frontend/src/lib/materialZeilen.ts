import { sprecherWahl } from '@/lib/sprecher'

/** Eine Aufnahme in der Auswahl. `datei` fehlt beim URL-Import — dort gibt es noch nichts.
 *
 *  Der Typ heisst `Aufnahme` und NICHT `MaterialZeile`: `components/MaterialZeile.tsx`
 *  exportiert eine Funktion dieses Namens, und `MaterialDialog` importiert beide.
 */
export type Aufnahme = {
  schluessel: string      // Dateiname bzw. URL — Dublettenschutz und React-key
  anzeige: string
  sprecherText: string
  sprache: string
  datei?: File
}

/** ERGAENZT die Auswahl; Dubletten am Schluessel fallen weg, die alte Zeile gewinnt.
 *
 *  Anhaengen statt Ersetzen, weil „ich habe eine vergessen" sonst Datenverlust waere: die
 *  zweite Auswahl loeschte die getippten Zahlen der ersten.
 *
 *  `bekannt` waechst WAEHREND des Filterns mit — sonst deckt der Schutz nur gegen fruehere
 *  Zeilen und nicht gegen Dubletten in DERSELBEN Auswahl (zwei gleichnamige Dateien aus
 *  verschiedenen Ordnern: zwei Zeilen mit demselben React-key, `onAendern` traefe beide,
 *  und der Server kollidierte mit 409).
 */
export function ergaenzen(alt: Aufnahme[], neu: Aufnahme[]): Aufnahme[] {
  const bekannt = new Set(alt.map(z => z.schluessel))
  const raus: Aufnahme[] = []
  for (const z of neu) {
    if (bekannt.has(z.schluessel)) continue
    bekannt.add(z.schluessel)
    raus.push(z)
  }
  return [...alt, ...raus]
}

/** EINE ungueltige Zeile sperrt den ganzen Knopf.
 *
 *  `every`, nicht `some`: sonst liesse sich ueber eine gueltige Nachbarzeile starten, und
 *  die fehlerhafte Eingabe ginge als „automatisch" durch — als eine Entscheidung also, die
 *  niemand getroffen hat.
 */
export function alleGueltig(zeilen: Aufnahme[], max: number): boolean {
  return zeilen.every(z => sprecherWahl(z.sprecherText, max) !== undefined)
}

/** „3× automatisch" · „1 von 3 gesetzt" · „3× von Hand" — fuer die Zusammenfassung. */
export function sprecherText(zeilen: Aufnahme[], max: number): string {
  if (!zeilen.length) return '—'
  // `!= null` schliesst BEIDE Nicht-Werte aus: `null` (leeres Feld = automatisch) und
  // `undefined` (ungueltige Eingabe). Eine ungueltige Zeile ist keine gesetzte Zahl —
  // und der Knopf ist daneben ohnehin gesperrt (`alleGueltig`).
  const gesetzt = zeilen.filter(z => sprecherWahl(z.sprecherText, max) != null).length
  if (!gesetzt) return `${zeilen.length}× automatisch`
  if (gesetzt === zeilen.length) return `${zeilen.length}× von Hand`
  return `${gesetzt} von ${zeilen.length} gesetzt`
}

/** „Schweizerdeutsch für alle" · „2× Schweizerdeutsch, 1× Englisch". */
export function sprachText(zeilen: Aufnahme[], labels: Record<string, string>): string {
  if (!zeilen.length) return '—'
  const zahl: Record<string, number> = {}
  for (const z of zeilen) zahl[z.sprache] = (zahl[z.sprache] ?? 0) + 1
  const teile = Object.entries(zahl).sort((a, b) => b[1] - a[1])
  if (teile.length === 1) return `${labels[teile[0][0]] ?? teile[0][0]} für alle`
  return teile.map(([id, n]) => `${n}× ${labels[id] ?? id}`).join(', ')
}
