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

/** Dieselbe Liste wie `app.py:AUDIO_EXT` und das `accept` des Dateifelds.
 *
 *  Sie steht HIER und nicht in einer der beiden Ablageflaechen: es gibt zwei Drop-Wege (die
 *  Flaeche im Dialog und das seitenweite Overlay der Arbeitsflaeche), und zwei Listen liefen
 *  beim naechsten Format auseinander.
 */
export const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|mp4)$/i

export const istAudio = (name: string) => AUDIO_RE.test(name)

/** Die Meldung dazu steht hier MIT der Regel: sie stand kurz an beiden Drop-Wegen wortgleich,
 *  und wer eine Stelle aendert, laesst die andere gruen zurueck (CodeRabbit-Bot). */
export const KEIN_AUDIO = 'Keine Audiodatei dabei — es passiert nichts.'

/** Filtert auf Audio und meldet, wenn nichts uebrig bleibt. `melden` ist der Toast des
 *  Aufrufers — die Bibliothek gehoert nicht in eine reine Logikdatei. */
export function nurAudio(roh: File[], melden: (text: string) => void): File[] {
  const audio = roh.filter(f => istAudio(f.name))
  if (!audio.length && roh.length) melden(KEIN_AUDIO)
  return audio
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
  // `||`, nicht `??` (#305): eine Zeile, die VOR der Antwort des Einstellungs-GET entstanden
  // ist, traegt `sprache: ''` — und `labels[''] ?? ''` machte daraus „ für alle", ein Loch an
  // genau der Stelle, die dem Nutzer ansagt, was gleich passiert. Leer heisst hier nicht
  // „unbekannt", sondern „kein Override" — es gilt der Projekt-Standard, und das ist die
  // Auskunft, die hinschreibbar ist, ohne den Wert zu kennen.
  const name = (id: string) => labels[id] || id || 'Projekt-Standard'
  if (teile.length === 1) return `${name(teile[0][0])} für alle`
  return teile.map(([id, n]) => `${n}× ${name(id)}`).join(', ')
}

/** „4,2 MB" · „812 KB" — die Groesse neben dem Dateinamen in Schritt 1.
 *
 *  Dezimal (1000), nicht binaer (1024): `api.uploadFrist` bemisst das Zeitlimit mit
 *  `bytes / 1_000_000`. Zwei MB-Begriffe nebeneinander hiesse, dass die angezeigte Groesse
 *  eine andere ist als die, auf der die Frist rechnet.
 *
 *  KEIN `Math.max(1, …)`: eine 0-Byte-Aufnahme (abgebrochener Export) soll als „0 KB"
 *  dastehen. Eine auf „1 KB" aufgerundete Anzeige verstellte genau den Blick, fuer den
 *  diese Liste ueberhaupt da ist.
 */
export function groesseText(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`
  return `${Math.round(bytes / 1000)} KB`
}
