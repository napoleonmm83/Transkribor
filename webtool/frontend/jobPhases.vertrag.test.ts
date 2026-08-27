import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJobPhases } from './src/lib/jobPhases'

// ─────────────────────────────────────────────────────────────────────────────────────────
// Der Vertrag zwischen den gedruckten Statuszeilen der Laufskripte und ihrem Parser (#375).
//
// ~25 Regexe in jobPhases.ts spiegeln ~110 Meldungsformen in sechs Python-Dateien, und nichts
// hielt die beiden Seiten zusammen: wer eine Druckzeile aendert oder eine neue einfuehrt,
// bekam keinen Fehler — die Datei blieb in der Oberflaeche einfach im falschen Zustand stehen.
// Vier solche Luecken hat eine Gegenueberstellung von Hand gefunden (#374), eine fuenfte diese
// Datei beim Bau (`skip (Audio nicht mehr vorhanden)`, seit dem gestaffelten Lauf die einzige
// skip-Form, die transcribe.py ueberhaupt noch druckt).
//
// Die Formen werden hier GEERNTET, nicht abgetippt. Das ist der Kern: handgetippte Fixtures
// bestaetigen genau die Annahme, die man beim Schreiben hatte — sie koennen nicht auffallen
// lassen, dass eine fuenfte Form existiert. Die Beispielzeilen sind von Hand geschrieben, aber
// an ihre geerntete Form gebunden (dritter Test unten): aendert sich der f-String, wird das
// Beispiel rot statt still falsch.
//
// WARUM DIESE DATEI IM FRONTEND-STAMM LIEGT und nicht unter `src/`: sie liest die
// Python-Quellen ueber `node:fs`, und `tsconfig.app.json` fuehrt bewusst `"types":
// ["vite/client"]` — App-Code soll keine node-APIs importieren koennen.
// Preis, benannt statt verschwiegen: diese Datei wird von `npm run build` NICHT typgeprueft.
// `rollbalken.test.ts` liegt zwar auch hier, ist aber KEIN Praezedenzfall, sondern der
// Gegenfall: es steht in `tsconfig.node.json`s `include` und wird typgeprueft — weil es
// nichts aus `src/` importiert. Diese Datei tut das (`parseJobPhases`), und sie dorthin
// aufzunehmen zoege `src/lib/jobPhases.ts` samt `./types` in das node-Projekt (TS2835,
// nachgemessen). Der Preis ist also echt, nur nicht aus dem Grund, der hier zuerst stand.
//
// SIE GEHT SEIT #408 IN BEIDE RICHTUNGEN. Von der Druckseite zum Parser (erster Test) UND
// zurueck (`parserMuster`): jeder Regex-Zweig muss noch eine lebende Druckform haben. Die
// zweite Richtung fehlte, und die Luecke war keine theoretische — `skip (vorhanden)` verlor
// sein print() in 10098e4, der Zweig lebte bis #408 weiter und trug Fixtures, die eine
// Wirklichkeit beschrieben, die es nicht mehr gab. Eine Liste der Zweige von Hand braucht es
// dafuer nicht: sie werden aus dem Quelltext geerntet, wie die Formen auf der Python-Seite.
//
// DREI GRENZEN, die diese Datei NICHT deckt:
// (1) Geerntet wird, was in QUELLEN steht — seit #409 die drei Laufskripte PLUS
//     `ytdlp_update.py`, `sperre.py` und `whispercpp.py`. Draussen bleiben `paths.py`,
//     `projekt.py` und `settings.py`; die Begruendung steht bei QUELLEN. Der Waechter unten
//     sagt "jede gedruckte Form", und gemeint ist "jede aus QUELLEN".
// (2) Die Beispielzeilen setzen je Platzhalter EINEN Wert ein. Wo der Platzhalter gebunden
//     ist, ist das vollstaendig; wo fremder Text steht (Ausnahmemeldungen, Basisnamen), ist
//     es eine Stichprobe — sowohl fuer die Wirkungslosigkeit als auch fuer die Frage, ob der
//     Toast die Zeile zeigt.
// (3) Der Regex-Scanner liest an einer Umschreibung vorbei (#366): wer die Muster in eine
//     Tabelle legt oder per `new RegExp` baut, faellt nicht auf. Dagegen steht nur die
//     Untergrenze von 20 Mustern.
// ─────────────────────────────────────────────────────────────────────────────────────────

const HIER = path.dirname(fileURLToPath(import.meta.url))
const WURZEL = path.resolve(HIER, '..', '..')
// Die drei Laufskripte PLUS die drei Module, die nachweislich in einen Job-Strom schreiben:
// `ytdlp_update.py` erreicht den fetch-Job ueber `fetch.py` (`ytdlp_update.automatisch`),
// `sperre.py` den correct-Job ueber `cmd_apply` (`sperre.datei`), und `whispercpp.py` den
// transcribe-Job auf Apple Silicon — `transcribe.py:425` ruft `whispercpp.transkribiere(…)`
// OHNE `onLine`, womit dessen `sag` auf sein Default `print` faellt. Vorher standen hier nur
// die drei Laufskripte, waehrend der Waechter unten „jede gedruckte Form" behauptete (#409).
//
// `ruf` ist der EMITTER der Datei, nicht immer `print(`: in `whispercpp.py` heisst er `sag`,
// und die beiden `print(` darin sind dessen Default-SENKE (`lambda z: print(z, …)`), keine
// Meldungsform — geerntet gehoeren die Zeichenketten an `sag(…)`. Der Preis ist benannt: ein
// direktes `print(` in `whispercpp.py` faellt aus der Ernte. Es gibt heute keines (gegruept),
// und die Alternative waere schlechter — beide Formen zu scannen liesse die Senke als
// UNLESBAR anschlagen, also den Test dauerhaft rot.
//
// NICHT aufgenommen: `paths.py`, `projekt.py`, `settings.py`. Sie schreiben auch AUSSERHALB
// von Jobs (Pfad- und Einstellungsmodule laufen im Server), ihre Formen haetten mit der
// Statusanzeige nichts zu tun, und jede Aenderung dort machte diesen Test rot. Die Grenze ist
// damit eine HANDentscheidung — genau das, was diese Datei sonst vermeidet. Was sie deckt,
// deckt seit #422 der vierte Test: eine Form, die versehentlich an einem Muster haengenbleibt,
// faellt dort auf, statt nur hier gezaehlt zu werden.
const QUELLEN: { datei: string; ruf: string }[] = [
  { datei: 'transcribe.py', ruf: 'print(' },
  { datei: 'webtool/correct.py', ruf: 'print(' },
  { datei: 'webtool/fetch.py', ruf: 'print(' },
  { datei: 'webtool/ytdlp_update.py', ruf: 'print(' },
  { datei: 'webtool/sperre.py', ruf: 'print(' },
  { datei: 'webtool/whispercpp.py', ruf: 'sag(' },
]

/** Die erste Zeichenkette eines `ruf(...)` — f-String oder normal, so wie sie im Quelltext
 *  steht. `ruf` ist der Emitter der Quelle (`print(`, in whispercpp.py `sag(`).
 *  Exportiert fuer den Ernter-Test (#410): der UNLESBAR-Zweig hat sonst keinen Sensor. */
export function ersteZeichenkette(zeile: string, ruf = 'print('): string | null {
  const i = zeile.indexOf(ruf)
  if (i < 0) return null
  let j = i + ruf.length
  while (j < zeile.length && (zeile[j] === ' ' || zeile[j] === 'f')) j++
  const q = zeile[j]
  if (q !== '"' && q !== "'") return null
  const raus: string[] = []
  for (j++; j < zeile.length; j++) {
    if (zeile[j] === '\\' && j + 1 < zeile.length) { raus.push(zeile.slice(j, j + 2)); j++; continue }
    if (zeile[j] === q) return raus.join('')
    raus.push(zeile[j])
  }
  return null
}

// Was `ersteZeichenkette` nicht lesen kann, bekommt DIESE Signatur — sie steht bewusst nicht im
// INVENTAR, der Gleichheitstest wird also rot. Ohne sie waere ein `print(meldung)` oder ein
// `print(` mit der Zeichenkette in der naechsten Zeile eine Form, die der Ernter still
// ueberspringt: Test gruen, Form unklassifiziert — genau das Loch, gegen das diese Datei gebaut
// ist. Die Form gibt es im Repo bereits (`webtool/whispercpp.py`: `lambda z: print(z, …)`), nur
// heute in keiner der QUELLEN. Preis, benannt: ein `print(` in einem Kommentar loest jetzt
// Fehlalarm aus — die umgekehrte Fehlbarkeit steckt ohnehin schon drin (ein `print("x")` in
// einem Kommentar WIRD geerntet).
const UNLESBAR = '<<print( ohne lesbare Zeichenkette>>'

/** Die Formen EINER Datei, in eine bestehende Karte hinein.
 *  Signatur = Literal mit allen Platzhaltern auf `{}` normalisiert -> stabil gegen Umbenennungen.
 *
 *  HERAUSGELOEST, damit der UNLESBAR-Zweig einen Sensor bekommt (#410): `ernte()` liest die
 *  echten Quellen, und dort loest er heute 0-mal aus — an ihnen ist er nicht pruefbar. Mit
 *  synthetischen Zeilen schon, und genau das tut der Test unten. */
export function formenAusZeilen(datei: string, zeilen: string[], formen: Map<string, string[]>,
                                ruf = 'print('): void {
  zeilen.forEach((zeile, nr) => {
    const lit = ersteZeichenkette(zeile, ruf)
    if (lit === null) {
      if (zeile.includes(ruf)) formen.set(UNLESBAR, [...(formen.get(UNLESBAR) ?? []), `${datei}:${nr + 1}`])
      return
    }
    const sig = lit.replace(/\{[^{}]*\}/g, '{}')
    formen.set(sig, [...(formen.get(sig) ?? []), `${datei}:${nr + 1}`])
  })
}

function ernte(): Map<string, string[]> {
  const formen = new Map<string, string[]>()
  for (const { datei, ruf } of QUELLEN) {
    formenAusZeilen(datei, fs.readFileSync(path.join(WURZEL, datei), 'utf-8').split(/\r?\n/), formen, ruf)
  }
  return formen
}

const PARSER = 'src/lib/jobPhases.ts'

/** Die Regex-Literale, die `parseJobPhases` wirklich auf eine Zeile anwendet.
 *
 *  GEERNTET, nicht gelistet — aus demselben Grund wie auf der Python-Seite: eine Liste von
 *  Zweigen waere wieder von Hand gepflegt, also genau die Fehlerklasse, gegen die diese Datei
 *  gebaut ist. Genommen werden nur `^`-verankerte Literale (alle Zeilenmuster sind es) in
 *  einer der drei Verwendungen `.match(/…/)`, `/…/.test(…)` und `.replace(/…/)`; die letzte
 *  wird VERWORFEN — sie ist der Zeilenschnitt, kein Zweig.
 *
 *  Der Preis steht in #366: ein Quelltext-Scanner liest an einer Umschreibung vorbei. Wer die
 *  Muster kuenftig in eine Tabelle legt oder per `new RegExp` baut, faellt hier nicht auf —
 *  dagegen steht die Untergrenze in der letzten Zusicherung des Tests, nicht mehr. */
export function parserMuster(quelle: string): string[] {
  const raus: string[] = []
  for (let p = quelle.indexOf('/^'); p >= 0; p = quelle.indexOf('/^', p + 1)) {
    let k = p + 1, klasse = false
    for (; k < quelle.length; k++) {
      const c = quelle[k]
      if (c === '\\') { k++; continue }
      if (c === '[') klasse = true
      else if (c === ']') klasse = false
      else if (c === '/' && !klasse) break
    }
    if (k >= quelle.length) continue
    const davor = quelle.slice(Math.max(0, p - 7), p)
    const danach = quelle.slice(k + 1, k + 7)
    if (!davor.endsWith('.match(') && !danach.startsWith('.test(')) continue
    raus.push(quelle.slice(p + 1, k))
    // Weitergesprungen wird NUR ueber einen angenommenen Fund — sonst frisst ein `/^` in
    // einem Kommentar (Prosa ueber ein Muster, ein halb zitierter Ausdruck) alles bis zum
    // naechsten Schraegstrich, und der liegt womoeglich hinter einem ECHTEN Zweig: der faellt
    // dann still aus der Ernte, und der Waechter oben prueft ihn nie wieder. Gemessen an
    // genau so einer Kommentarzeile — der `fertig`-Zweig verschwand.
    p = k
  }
  return raus
}

// Eine Ausnahmeliste („Zweig ohne Druckform, aus diesem Grund") gibt es BEWUSST NICHT — und
// das ist ein Befund, kein Weglassen. Sie stand hier kurz, mit genau einem Eintrag fuer den
// tqdm-Zweig `^(\d+)%\|` und der Begruendung „kein print() in unseren Quellen". Die war
// FALSCH: `whispercpp.py` druckt genau diese Form (siehe INVENTAR), sie stand nur nicht in
// QUELLEN. Der Eintrag haette also eine echte Abdeckungsluecke als geprueft ausgewiesen.
// Dazu kam die strukturelle Schwaeche: eine Ausnahme fuer einen LEBENDEN Zweig faellt nicht
// auf (gemessen — Test blieb gruen), die Liste waere damit der bequeme Weg, einen toten
// Zweig am Waechter vorbeizubekommen. Wer sie wieder braucht, misst zuerst nach, ob die
// Druckform wirklich fehlt, und sichert dann die exakte Schluesselmenge zu.

/** Begruendung der 16 Formen, die `useJobAusgang.grund()` ueber seinen generischen Filter in
 *  den Toast zieht (#422/B5). Sie sind fuer `parseJobPhases` wirkungslos — aber NICHT
 *  ungelesen, und `ignoriert` behauptete genau das. Wer eine davon umformuliert und dabei
 *  „FEHLER"/„Fehler"/„Error"/„Traceback" verliert, nimmt dem Nutzer im Fehlerfall die einzige
 *  Auskunft (am Hook end-to-end gemessen). Welche Formen es sind, entscheidet nicht diese
 *  Liste, sondern ein Test — siehe „was der Toast dem Nutzer zeigt". */
const GRUND = 'useJobAusgang.grund(): steht als Begruendung im Toast, wenn ein Lauf ohne '
  + 'bekannte Dateinamen scheitert (generischer /FEHLER|Fehler|Error|Traceback/-Filter)'

type Art = 'gelesen' | 'gelesen_anderswo' | 'ignoriert' | 'luecke'
type Eintrag = {
  art: Art
  /** Nur bei 'gelesen': eine konkrete Zeile, die im Parser etwas bewirken MUSS. */
  beispiel?: string
  kind?: string
  /** Erwarteter Basisname im Ergebnis. Ohne ihn genuegte dem Wirkungstest JEDE Aenderung —
   *  auch eine unter dem FALSCHEN Schluessel, und genau das war #374 Punkt 1. */
  basis?: string
  /** Zeilen davor/danach, ohne die die Wirkung nicht sichtbar waere (Blockfortschritt, Sweeps). */
  vor?: string[]
  nach?: string[]
  notiz?: string
}

// Klassifikation aller gedruckten Formen. Wer eine Zeile aendert oder hinzufuegt, traegt sie
// hier ein — und beantwortet damit die Frage, die bisher niemand gestellt hat: liest das jemand?
const INVENTAR: Record<string, Eintrag> = {
  // ── gelesen von parseJobPhases ────────────────────────────────────────────────────────
  '[scope] ': { art: 'gelesen', beispiel: '[scope] A\tB' },
  '[{}] -> transkribiere {} …': { art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] -> transkribiere A …', basis: 'A' },
  '[{}] fertig {}: {}s, {} Segmente, ': {
    art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] fertig A: 12s, 30 Segmente, 1.2x Echtzeit', basis: 'A',
  },
  '[{}] FEHLER {}: {}': { art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] FEHLER A: kaputt', basis: 'A' },
  '[{}] skip (Audio nicht mehr vorhanden): {}': {
    art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] skip (Audio nicht mehr vorhanden): A', basis: 'A',
    notiz: 'seit 10098e4 die einzige skip-Form; transcribe.py zaehlt sie in failed_bases -> failed',
  },
  // Die beiden Prozentformen von whisper.cpp (macOS) — DIE Druckform des tqdm-Zweigs.
  // `whispercpp.py:154` traegt dazu den Kommentar „Format wie jobPhases.ts es liest", die
  // Kopplung ist dort also beabsichtigt und stand hier bis #409 trotzdem nicht drin. Auf
  // Windows/Linux fuellt Whispers tqdm-Balken (stderr, in jobs.py nach stdout gemergt)
  // dieselbe Regex — DER hat kein print() bei uns, aber ein Zweig braucht nur EINE lebende
  // Druckform, und diese beiden sind es.
  // `vor` ist Pflicht: der Zweig schreibt in `active[cursor]`, ohne laufende Datei ist er
  // folgenlos — und der Wirkungstest bliebe rot, obwohl der Zweig lebt.
  '{}%| Sprachmodell': {
    art: 'gelesen', kind: 'transcribe', beispiel: '45%| Sprachmodell', basis: 'A',
    vor: ['[Demo] -> transkribiere A …'],
  },
  '{}%| {}': {
    art: 'gelesen', kind: 'transcribe', beispiel: '45%| large-v3', basis: 'A',
    vor: ['[Demo] -> transkribiere A …'],
  },
  'Lade Sprachmodell {} …': {
    art: 'ignoriert', beispiel: 'Lade Sprachmodell ggml-large-v3-q5_0.bin …',
  },
  '[fetch] {} von {} geladen': { art: 'gelesen', kind: 'fetch', beispiel: '[fetch] 2 von 3 geladen' },
  '[fetch] lade {} …': { art: 'gelesen', kind: 'fetch', beispiel: '[fetch] lade Video …' },
  '[fetch] FEHLER {}: {}': { art: 'gelesen', kind: 'fetch', beispiel: '[fetch] FEHLER https://x/y: tot' },
  '[fetch] fertig {}': { art: 'gelesen', kind: 'fetch', beispiel: '[fetch] fertig Video' },
  '[fetch] roh ({}, extraktor-verdacht=': {
    art: 'gelesen', kind: 'fetch', beispiel: '[fetch] roh (DownloadError, extraktor-verdacht=True)',
  },
  '[fetch] yt-dlp aktualisiert — versuche {} noch einmal': {
    art: 'gelesen', kind: 'fetch', beispiel: '[fetch] yt-dlp aktualisiert — versuche https://x noch einmal',
  },
  '[done] {}': {
    art: 'gelesen', beispiel: '[done] A', vor: ['→ Diarisiere A …'],
    notiz: 'einziges Terminal je Datei in der Diarisierungsphase; jobs.py liest es ausserdem',
  },
  '→ Diarisiere {}{} …': { art: 'gelesen', beispiel: '→ Diarisiere A (5 Sprecher) …', basis: 'A' },
  '→ Korrigiere {}{} …': { art: 'gelesen', beispiel: '→ Korrigiere A · Block 1/4 …', basis: 'A' },
  '→ Verifiziere {}{} (Treue gegen Roh) …': { art: 'gelesen', beispiel: '→ Verifiziere A (Treue gegen Roh) …', basis: 'A' },
  '→ Leichte Korrektur {} …': { art: 'gelesen', beispiel: '→ Leichte Korrektur A …', basis: 'A' },
  '→ Nur Zusammenfassung {} …': { art: 'gelesen', beispiel: '→ Nur Zusammenfassung A …', basis: 'A' },
  '→ Glossar (gemeinsame Namen/Begriffe) …': { art: 'gelesen', beispiel: '→ Glossar (gemeinsame Namen/Begriffe) …' },
  '✓ Glossar: {} Eigennamen, ': { art: 'gelesen', beispiel: '✓ Glossar: 4 Eigennamen, 2 Korrekturen' },
  '↷ nutze vorhandenes _glossar.json': { art: 'gelesen', beispiel: '↷ nutze vorhandenes _glossar.json' },
  '  {}: {} Segmente → {} Blöcke à max. {}': {
    art: 'gelesen', beispiel: '  A: 540 Segmente → 4 Blöcke à max. 150', basis: 'A',
    nach: ['→ Korrigiere A · Block 1/4 …'],
  },
  '  ✓ {}{} fertig': {
    art: 'gelesen', beispiel: '  ✓ A · Block 1/4 fertig', basis: 'A',
    vor: ['  A: 540 Segmente → 4 Blöcke à max. 150'], nach: ['→ Korrigiere A · Block 2/4 …'],
  },
  '  ✗ {}{} ohne gültiges Ergebnis': {
    art: 'gelesen', beispiel: '  ✗ A · Block 1/4 ohne gültiges Ergebnis', basis: 'A',
    vor: ['  A: 540 Segmente → 4 Blöcke à max. 150'], nach: ['→ Korrigiere A · Block 2/4 …'],
  },
  '  ↷ {}{} schon vorhanden': {
    art: 'gelesen', beispiel: '  ↷ A · Block 1/4 schon vorhanden', basis: 'A',
    vor: ['  A: 540 Segmente → 4 Blöcke à max. 150'], nach: ['→ Korrigiere A · Block 2/4 …'],
  },
  'apply: {} -> edit.json + md ({} Segmente)': { art: 'gelesen', beispiel: 'apply: A -> edit.json + md (12 Segmente)', basis: 'A' },
  'apply: SKIP {} (human_edited=true; --force zum Ueberschreiben)': {
    art: 'gelesen', beispiel: 'apply: SKIP A (human_edited=true; --force zum Ueberschreiben)', basis: 'A',
  },
  'apply: SKIP {} ({} nicht lesbar: ': {
    art: 'gelesen',
    beispiel: 'apply: SKIP A (A.edit.json nicht lesbar: JSONDecodeError: x; --force zum Ueberschreiben)', basis: 'A',
  },
  'apply: SKIP {} (waehrend des Laufs handbearbeitet; ': {
    art: 'gelesen', beispiel: 'apply: SKIP A (waehrend des Laufs handbearbeitet; --force zum Ueberschreiben)', basis: 'A',
  },
  'apply: FEHLT {}.correction.json - erst Korrektur-Workflow laufen lassen': {
    art: 'gelesen', beispiel: 'apply: FEHLT A.correction.json - erst Korrektur-Workflow laufen lassen', basis: 'A',
    notiz: 'im Job-Protokoll nur ueber ein TOCTOU-Fenster erreichbar (one() prueft _valid_correction '
      + 'vor cmd_apply); der Zweig bleibt, weil sein Wegfall dort einen Dauer-Spinner hinterliesse',
  },
  '↷ SKIP {} (human_edited=true; --force zum Neu-Korrigieren)': {
    art: 'gelesen', beispiel: '↷ SKIP A (human_edited=true; --force zum Neu-Korrigieren)', basis: 'A',
  },
  '✗ FEHLT/ungültig: {}.correction.json — überspringe': {
    art: 'gelesen', beispiel: '✗ FEHLT/ungültig: A.correction.json — überspringe', basis: 'A',
  },
  '✗ Fehler bei {}: {} — überspringe': { art: 'gelesen', beispiel: '✗ Fehler bei A: RuntimeError — überspringe', basis: 'A' },
  'diarize: {} Datei(en) diarisiert in {}s': {
    art: 'gelesen', beispiel: 'diarize: 2 Datei(en) diarisiert in 45s', vor: ['→ Diarisiere A …'],
  },
  'prep: {} Datei(en) getaggt in {}': { art: 'gelesen', beispiel: 'prep: 3 Datei(en) getaggt in /x' },

  // ── gelesen, aber von einem ANDEREN Verbraucher ───────────────────────────────────────
  '[active] {}': {
    art: 'gelesen_anderswo', beispiel: '[active] A',
    notiz: 'jobs.py (Backend): welche Datei gerade geschrieben wird',
  },
  // Die Beispielzeile traegt `\\t` als ZWEI Zeichen, nicht als Tabulator — die geerntete
  // Signatur tut es auch (der Ernter behaelt Escapes roh), und der dritte Test bindet das
  // Beispiel an die Signatur. Fuer die Wirkungslosigkeit ist es gleich; als Nachbau der
  // ECHTEN Zeile taugt sie damit nicht, und das ist hier gesagt statt stillschweigend.
  '  [diagnose] {}\\t{}\\t{}': {
    art: 'gelesen_anderswo', beispiel: '  [diagnose] network\\tKeine Verbindung\\tInternet pruefen',
    notiz: 'useJobAusgang.ts: Grund einer gescheiterten Korrektur',
  },
  'korrektur: FEHLER — 0 von {} versuchten Datei(en) korrigiert ': {
    art: 'gelesen_anderswo',
    beispiel: 'korrektur: FEHLER — 0 von 3 versuchten Datei(en) korrigiert (die Transkripte sind '
      + 'geschrieben — siehe die Zeilen oben)',
    notiz: 'Bilanz-Riegel des gestaffelten Laufs (#417). Der KANAL ist nicht diese Zeile, sondern '
      + 'das SystemExit(1) dahinter: jobs.py macht daraus status=error, ausgang() {art:"fehler"}. '
      + 'useJobAusgang.grund() zieht sie zusaetzlich als Begruendung in den Toast (generischer '
      + '/FEHLER/-Filter, keine eigene Regex). Bewusst OHNE [{}]-Praefix und ohne ": " hinter '
      + 'FEHLER — ^\\[[^\\]]+\\] FEHLER (.+?): legte sonst einen perBase-Eintrag unter einem '
      + 'Basisnamen an, den es gar nicht gibt',
  },

  'apply: FEHLT {}.json - Roh-Transkript nicht gefunden': {
    art: 'gelesen', beispiel: 'apply: FEHLT A.json - Roh-Transkript nicht gefunden', basis: 'A',
    notiz: 'Erreichbar nur ueber ein TOCTOU-Fenster — und ueber ein WEITES: correct_ai_single '
      + 'prueft die Roh-JSON beim Eintritt (correct.py:1009) und steigt aus, bevor [active] '
      + 'gedruckt wird; dazwischen liegt die ganze KI-Korrektur samt Treue-Pass, also Minuten. '
      + 'Ungelesen war das nicht bloss ein Spinner: cmd_apply liefert "missing", und '
      + 'correct_ai_single VERWARF den Rueckgabewert — ohne perBase-Eintrag fiel ausgang() auf '
      + '{art:"erfolg"}, also ERFOLG ueber eine nie geschriebene edit.json. Die Backend-Haelfte '
      + 'ist seit #412 zu (`!= "missing"`), dieser Zweig bleibt die Anzeige-Haelfte (#407)',
  },

  // ── bewusst ignoriert: Umgebung, Messung, Diagnose — kein Datei-Ereignis ───────────────
  // Die zwei Meldungen des Autocorrect-Riegels (#406). 'ignoriert' ist hier eine ZUSICHERUNG,
  // keine Verlegenheit: sie duerfen KEINE Phase setzen — sie sagen, dass die Korrektur gar
  // nicht erst laeuft, und eine Datei-Meldung daraus waere eine Falschaussage. Dass sie an
  // keinem Muster haengenbleiben, ist seit #413 auch strukturell zu: `^\[[^\]]+\] ` laesst
  // den fremden Grund hinter dem Praefix nicht mehr an die Datei-Muster heran.
  '[autocorrect] uebersprungen — TRANSKRIBOR_AUTOCORRECT=0': {
    art: 'ignoriert', beispiel: '[autocorrect] uebersprungen — TRANSKRIBOR_AUTOCORRECT=0',
  },
  '[autocorrect] KI-Phase uebersprungen — {}': {
    art: 'ignoriert', beispiel: '[autocorrect] KI-Phase uebersprungen — kein KI-Anbieter eingestellt',
  },
  '  KI-Anbieter: {}': { art: 'ignoriert', beispiel: '  KI-Anbieter: Anthropic (claude-opus-5)' },
  '  claude Timeout nach {}s': { art: 'ignoriert', beispiel: '  claude Timeout nach 600s' },
  '  claude exit {}: {}': { art: 'ignoriert', beispiel: '  claude exit 1: nicht angemeldet' },
  '  keine .raw.txt gefunden — überspringe Glossar': {
    art: 'ignoriert', beispiel: '  keine .raw.txt gefunden — überspringe Glossar',
  },
  '  {}': { art: 'ignoriert', beispiel: '  claude nicht gefunden auf dem PATH' },
  '  {}  ({} Audio)': { art: 'ignoriert', beispiel: '  Demo  (3 Audio)' },
  '  {}: {} Fenster, ': { art: 'ignoriert', beispiel: '  A: 28 Fenster, davon 2 englisch erkannt' },
  '  ⚠ {}: {} Segment(e) ohne Korrektur — bleiben auf Rohstand': {
    art: 'ignoriert', beispiel: '  ⚠ A: 4 Segment(e) ohne Korrektur — bleiben auf Rohstand',
  },
  '  ✓ {}: {} Blöcke zusammengeführt ({} Segmente)': {
    art: 'ignoriert', beispiel: '  ✓ A: 4 Blöcke zusammengeführt (540 Segmente)',
  },
  '  ✗ {}: Block 1 gescheitert — die weiteren Blöcke braeuchten seine ': {
    art: 'ignoriert', beispiel: '  ✗ A: Block 1 gescheitert — die weiteren Blöcke braeuchten seine Sprecherzuordnung',
  },
  '  ✗ {}: {} von {} Blöcken fehlgeschlagen — Teil-Dateien ': {
    art: 'ignoriert', beispiel: '  ✗ A: 2 von 4 Blöcken fehlgeschlagen — Teil-Dateien bleiben liegen',
  },
  'Projekt nicht gefunden: {}': { art: 'ignoriert', beispiel: 'Projekt nicht gefunden: Demo' },
  'TRANSKRIBOR_PARALLEL={} ist nicht der wirksame Wert — ': {
    art: 'ignoriert', beispiel: 'TRANSKRIBOR_PARALLEL=99 ist nicht der wirksame Wert — es gilt 3',
  },
  'WARN: ffmpeg nicht gefunden. Installiere: winget install Gyan.FFmpeg': {
    art: 'ignoriert', beispiel: 'WARN: ffmpeg nicht gefunden. Installiere: winget install Gyan.FFmpeg',
  },
  'WARN: ffmpeg nicht gefunden. Installiere: {}': {
    art: 'ignoriert', beispiel: 'WARN: ffmpeg nicht gefunden. Installiere: brew install ffmpeg',
  },
  // Die 19 Formen der beiden Module aus #409. Alle 'ignoriert': sie melden Umgebung und
  // Sperrzustand, kein Datei-Ereignis. Dass sie an keinem Muster haengenbleiben, behauptet die
  // Tabelle nicht mehr nur — der vierte Test misst es (#422), in BEIDEN kind-Zweigen.
  '[sperre] warte auf {} (raeume nach {}s auf, falls ': {
    art: 'ignoriert', beispiel: '[sperre] warte auf /x/settings.json.lock (raeume nach 65s auf, falls verwaist)',
  },
  '[sperre] {} ist kein Verzeichnis — ungeschuetzt weiter': {
    art: 'ignoriert', beispiel: '[sperre] /x/settings.json.lock ist kein Verzeichnis — ungeschuetzt weiter',
  },
  '[sperre] {} laesst sich nicht uebernehmen — ungeschuetzt ': {
    art: 'ignoriert', beispiel: '[sperre] /x/settings.json.lock laesst sich nicht uebernehmen — ungeschuetzt weiter',
  },
  '[sperre] {} nicht anlegbar ({}) — ungeschuetzt weiter': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '[sperre] /x/settings.json.lock nicht anlegbar (PermissionError) — ungeschuetzt weiter',
  },
  '[sperre] {} wird uebernommen (der gemeldete Halter haelt laenger, ': {
    art: 'ignoriert',
    beispiel: '[sperre] /x/settings.json.lock wird uebernommen (der gemeldete Halter haelt laenger, '
      + 'als sein Abschnitt dauern darf)',
  },
  '[ytdlp] Anforderungen von yt-dlp unlesbar: {}: {}': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '[ytdlp] Anforderungen von yt-dlp unlesbar: UnicodeDecodeError: invalid start byte',
  },
  '[ytdlp] Hintergrundlauf abgebrochen: {}: {}': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '[ytdlp] Hintergrundlauf abgebrochen: OSError: Zugriff verweigert',
  },
  '[ytdlp] Kalenderpruefung beim Start uebersprungen ': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '[ytdlp] Kalenderpruefung beim Start uebersprungen (OSError: kein Zugriff)',
  },
  '[ytdlp] Kalenderpruefung uebersprungen — es aktualisiert schon jemand': {
    art: 'ignoriert', beispiel: '[ytdlp] Kalenderpruefung uebersprungen — es aktualisiert schon jemand',
  },
  '[ytdlp] Marker unlesbar ({}): {}: {}': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: "[ytdlp] Marker unlesbar ('/x/ytdlp.geprueft'): ValueError: kaputt",
  },
  '[ytdlp] Merker fuer den pip-Lauf nicht loeschbar: {} — die Faelligkeit ': {
    art: 'gelesen_anderswo', notiz: GRUND,
    beispiel: '[ytdlp] Merker fuer den pip-Lauf nicht loeschbar: PermissionError — die Faelligkeit '
      + 'entscheidet der Kalender',
  },
  '[ytdlp] Metadaten von yt-dlp unlesbar: {}: {}': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '[ytdlp] Metadaten von yt-dlp unlesbar: PackageNotFoundError: yt-dlp',
  },
  '[ytdlp] Metadaten von {} unlesbar: {}: {}': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '[ytdlp] Metadaten von yt-dlp-ejs unlesbar: UnicodeDecodeError: invalid start byte',
  },
  '[ytdlp] Sperrverzeichnis nicht anlegbar: {}': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '[ytdlp] Sperrverzeichnis nicht anlegbar: PermissionError',
  },
  '[ytdlp] Update fehlgeschlagen: {}': {
    art: 'ignoriert', beispiel: '[ytdlp] Update fehlgeschlagen: TimeoutExpired',
  },
  '[ytdlp] aktualisiere (installiert: {}) …': {
    art: 'ignoriert', beispiel: '[ytdlp] aktualisiere (installiert: 2026.7.4) …',
  },
  '[ytdlp] uebersprungen — inzwischen hat ein anderer Lauf aktualisiert': {
    art: 'ignoriert', beispiel: '[ytdlp] uebersprungen — inzwischen hat ein anderer Lauf aktualisiert',
  },
  '[ytdlp] {} nicht schreibbar: {}': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '[ytdlp] /x/ytdlp.geprueft nicht schreibbar: PermissionError',
  },
  // Der erste Platzhalter ist gebunden ('ok' bzw. 'fehlgeschlagen'), der zweite ist die letzte
  // pip-Zeile — fremder Text hinter einem Klammerpraefix, also die Klasse aus #413.
  '[ytdlp] {}: {}': {
    art: 'ignoriert', beispiel: '[ytdlp] ok: Successfully installed yt-dlp-2026.7.4',
  },
  '[{}] -> {}': { art: 'ignoriert', beispiel: '[Demo] -> /x/projekte/Demo/transkripte' },
  // Seit #405/#421 vom Parser GELESEN, nicht mehr nur vom Toast: ein Wurf in der Vorbereitung
  // mit stehendem KI-Pool ist ein gescheiterter Korrekturversuch und faerbt die Aufnahme
  // 'failed' — dieselbe Aussage, die die Bilanz im Backend seit #417 trifft. `gelesen`
  // schlaegt `gelesen_anderswo`: es ist die staerkere Zusage, der Toast liest sie weiterhin
  // mit (deshalb bleibt der GRUND-Hinweis in der Notiz stehen).
  '[{}] Autocorrect-Fehler bei {}: {}': {
    art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] Autocorrect-Fehler bei A: RuntimeError',
    basis: 'A',
    notiz: `${GRUND}. Die Datei IST transkribiert — nur die angehaengte Korrektur scheiterte`,
  },
  // Der Zwilling ohne KI-Pool. Er sieht wie eine Verlegenheit aus und ist der Kern von #421:
  // aus der frueheren, GEMEINSAMEN Zeile war nicht entscheidbar, ob die Korrektur scheiterte
  // oder gar nicht angefordert war — und seit der Parser sie liest, waere das der Unterschied
  // zwischen „Aufnahme gescheitert" und einer Falschaussage ueber einen Schritt, den niemand
  // wollte. Bewusst NICHT vom Parser gelesen.
  '[{}] Vorbereitung gescheitert bei {} ': {
    art: 'gelesen_anderswo', notiz: GRUND,
    beispiel: '[Demo] Vorbereitung gescheitert bei A (ohne KI-Phase): RuntimeError',
  },
  '[{}] Korrektur: {} von {} Datei(en) korrigiert': {
    art: 'ignoriert', beispiel: '[Demo] Korrektur: 3 von 5 Datei(en) korrigiert',
    notiz: 'Bilanz der angehaengten Korrektur je Projekt (#417). GETRAGENE GRENZE: ein TEILausfall '
      + '(3 von 5) bleibt damit gruen — die Zeile nennt ihn, gelesen wird sie nicht. Sie in '
      + 'phases.bilanz zu ziehen ginge, macht aber die in jobAusgang.ts:51 benannte Reihenfolge '
      + 'scharf (perBase schlaegt Bilanz, und ein transcribe-Lauf kann BEIDES haben) — das ist '
      + 'eine eigene Entscheidung, sie steht als #421',
  },
  '[{}] Modell {}, {} Datei(en)': { art: 'ignoriert', beispiel: '[Demo] Modell large-v3, 3 Datei(en)' },
  '[{}] Warte auf verbleibende KI-Korrekturen…': {
    art: 'ignoriert', beispiel: '[Demo] Warte auf verbleibende KI-Korrekturen…',
  },
  '[{}] device={} ({}){}': { art: 'ignoriert', beispiel: '[Demo] device=cuda (NVIDIA GeForce RTX 5080)' },
  '[{}] engine=whisper.cpp (Metal)': { art: 'ignoriert', beispiel: '[Demo] engine=whisper.cpp (Metal)' },
  '[{}] keine Audiodateien in {}': {
    art: 'ignoriert', beispiel: '[Demo] keine Audiodateien in /x/projekte/Demo/audio',
  },
  '[{}] nichts zu tun — {} Datei(en) bereits transkribiert': {
    art: 'ignoriert', beispiel: '[Demo] nichts zu tun — 3 Datei(en) bereits transkribiert',
  },
  '[{}] ⚠ {}: {} Abschnitt(e) ohne Transkript ': {
    art: 'ignoriert', beispiel: '[Demo] ⚠ A: 2 Abschnitt(e) ohne Transkript (0:12-0:30) — bitte im Ton gegenhoeren',
  },
  'diarize: SKIP {} (Roh-JSON unlesbar: {})': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: 'diarize: SKIP A (Roh-JSON unlesbar: JSONDecodeError)',
  },
  'diarize: SKIP {} (kein Audio gefunden)': {
    art: 'ignoriert', beispiel: 'diarize: SKIP A (kein Audio gefunden)',
  },
  'diarize: SKIP {} (keine Sprecher erkannt)': {
    art: 'ignoriert', beispiel: 'diarize: SKIP A (keine Sprecher erkannt)',
  },
  'diarize: SKIP {} ({}: {}) — Korrektur ohne Cluster': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: 'diarize: SKIP A (RuntimeError: CUDA out of memory) — Korrektur ohne Cluster',
  },
  'prep: SKIP {} ({}: {})': { art: 'gelesen_anderswo', notiz: GRUND, beispiel: 'prep: SKIP A (OSError: kein Zugriff)' },
  // Steht hier statt oben bei seinem Zwilling, weil die Liste alphabetisch laeuft — die
  // Klassifikation ist dieselbe, und das ist der Punkt: sie war es bis zum #417-Review NICHT.
  // Die Form ist bytegleich zum `korrektur: FEHLER …`-Eintrag oben und wird vom selben
  // Verbraucher gelesen (`useJobAusgang.grund()`, generischer /FEHLER/-Filter) — es gibt sogar
  // einen Test dafuer (`useJobAusgang.test.tsx`, „ohne Dateinamen wird der GRUND nachgereicht"
  // #376/B2). Als `ignoriert` behauptete die Tabelle, die Zeile werde nirgends gelesen; wer
  // sie so las, haette sie beim naechsten Umbau bedenkenlos umformuliert.
  'run: FEHLER — 0 von {} versuchten Datei(en) korrigiert ': {
    art: 'gelesen_anderswo',
    beispiel: 'run: FEHLER — 0 von 3 versuchten Datei(en) korrigiert (siehe die Zeilen oben)',
    notiz: 'useJobAusgang.grund(): Begruendung im Toast, wenn keine Dateinamen bekannt sind. '
      + 'Zwilling der korrektur:-Form oben — zwei bytegleiche Zeilen muessen dieselbe '
      + 'Klassifikation tragen, sonst ist die Tabelle selbst die Falschaussage',
  },
  'run: fertig — {}/{} Datei(en) korrigiert': {
    art: 'ignoriert', beispiel: 'run: fertig — 3/5 Datei(en) korrigiert',
  },
  'run: keine Roh-Transkripte — erst transkribieren': {
    art: 'ignoriert', beispiel: 'run: keine Roh-Transkripte — erst transkribieren',
  },
  'run: keine solche Datei: {}': { art: 'ignoriert', beispiel: 'run: keine solche Datei: A' },
  'run: {} Datei(en) in Projekt {}': { art: 'ignoriert', beispiel: 'run: 5 Datei(en) in Projekt Demo' },
  '↷ Diarisierung deaktiviert (TRANSKRIBOR_DIARIZE=0)': {
    art: 'ignoriert', beispiel: '↷ Diarisierung deaktiviert (TRANSKRIBOR_DIARIZE=0)',
  },
  '↷ nutze vorhandene {}.correction.json': { art: 'ignoriert', beispiel: '↷ nutze vorhandene A.correction.json' },
  '↷ nutze vorhandene {}.diar.json': { art: 'ignoriert', beispiel: '↷ nutze vorhandene A.diar.json' },
  '⏱ Phasen: glossar {}s · pipeline {}s · ': {
    art: 'ignoriert', beispiel: '⏱ Phasen: glossar 12s · pipeline 340s · apply 2s',
  },
  '⏱ [{}]: {} Datei(en) transkribiert in {}s ': {
    art: 'ignoriert', beispiel: '⏱ [Demo]: 3 Datei(en) transkribiert in 54s (Audio 9:27, 10.5x)',
  },
  '⏱ {}: Diarisierung {}s': { art: 'ignoriert', beispiel: '⏱ A: Diarisierung 45s' },
  '⏱ {}{}: Korrektur {}s{}': { art: 'ignoriert', beispiel: '⏱ A: Korrektur 25s' },
  '⚠ Glossar fehlt/ungültig — fahre ohne gemeinsames Glossar fort': {
    art: 'ignoriert', beispiel: '⚠ Glossar fehlt/ungültig — fahre ohne gemeinsames Glossar fort',
  },
  '⚠ Verifikation ungültig — behalte unverifizierte {}.correction.json': {
    art: 'ignoriert', beispiel: '⚠ Verifikation ungültig — behalte unverifizierte A.correction.json',
  },
  '⚠ kontext.md nicht lesbar ({}: {}) — fahre ohne ': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '⚠ kontext.md nicht lesbar (OSError: kein Zugriff) — fahre ohne Kontext fort',
  },
  '⚠ {} nicht lesbar ({}: {}) — gilt ': {
    art: 'gelesen_anderswo', notiz: GRUND, beispiel: '⚠ /x/A.edit.json nicht lesbar (JSONDecodeError: x) — gilt als handbearbeitet',
  },
}

/** Der generische Grund-Filter aus `useJobAusgang.grund()` — gespiegelt, nicht importiert.
 *  Die Zusicherung im Test bindet ihn an die Quelle. */
const GRUND_FILTER = /FEHLER|Fehler|Error|Traceback/

const fest = (w: unknown) => JSON.stringify(w, (_k, v) => (v instanceof Set ? [...v].sort() : v))

describe('Vertrag: gedruckte Statuszeilen <-> jobPhases.ts (#375)', () => {
  it('jede gedruckte Form ist klassifiziert — und keine klassifizierte ist verschwunden', () => {
    // Der eigentliche Waechter. Eine NEUE Druckzeile ist hier unbekannt und macht den Test rot;
    // wer sie eintraegt, muss dabei entscheiden, ob der Parser sie lesen soll. Eine GEAENDERTE
    // Zeile aendert ihre Signatur und wirkt wie eine neue. Eine ENTFERNTE faellt als
    // ueberzaehliger Inventareintrag auf.
    const geerntet = [...ernte().keys()].sort()
    expect(geerntet).toEqual(Object.keys(INVENTAR).sort())
  })

  it('jede als „gelesen" markierte Form bewirkt im Parser auch etwas', () => {
    // Ohne diesen Test waere „gelesen" eine Behauptung. Gemessen wird die einzige Frage, auf die
    // es ankommt: aendert die Zeile den geparsten Zustand? Genau das taten die vier Formen aus
    // #374 nicht — sie standen im Protokoll und liefen ins Leere.
    // `luecke` ist eine ABSICHT, kein Ruhezustand — und seit der letzte Eintrag auf `gelesen`
    // umgestellt wurde, ist die Art ein TOTER SCHALTER: die Schleife darunter ueberspringt
    // alles ausser `gelesen`, wer ein bekanntes Loch so markiert, bleibt also gruen. Test 1
    // zaehlt die Form als klassifiziert, dieser hier prueft sie nicht — der Vertrag verloere
    // seinen Druck genau dort, wo er gebraucht wird. Deshalb muss die Liste LEER bleiben:
    // wer wieder etwas parken will, kommt hier vorbei und entscheidet bewusst.
    // (Gefunden vom CodeRabbit-Bot; die Art wurde in DIESEM PR verwaist.)
    expect(Object.entries(INVENTAR).filter(([, e]) => e.art === 'luecke').map(([s]) => s)).toEqual([])

    const tot: string[] = []
    for (const [sig, e] of Object.entries(INVENTAR)) {
      if (e.art !== 'gelesen') continue
      expect(e.beispiel, `Beispielzeile fehlt fuer ${sig}`).toBeTruthy()
      const kind = e.kind ?? 'correct'
      const mit = parseJobPhases(kind, [...(e.vor ?? []), e.beispiel!, ...(e.nach ?? [])])
      const ohne = parseJobPhases(kind, [...(e.vor ?? []), ...(e.nach ?? [])])
      if (fest(mit) === fest(ohne)) { tot.push(`${sig} (ohne Wirkung)`); continue }
      if (e.basis && ![...Object.keys(mit.active), ...Object.keys(mit.perBase)].includes(e.basis))
        tot.push(`${sig} (Wirkung, aber nicht unter '${e.basis}')`)
    }
    expect(tot).toEqual([])
  })

  it('jeder Parser-Zweig hat noch eine lebende Druckform (#408)', () => {
    // Die GEGENRICHTUNG. Der erste Test geht von der Druckseite zum Parser; ein Regex-Zweig,
    // dessen Druckform verschwindet, faellt dort nicht auf — und genau das ist passiert:
    // `skip (vorhanden)` ist in 10098e4 (v0.48.0) ersatzlos entfallen, der Zweig dafuer lebte
    // bis #408 weiter. Ein toter Zweig ist nicht bloss Ballast: er traegt Fixtures, die eine
    // nicht mehr existierende Wirklichkeit beschreiben, und Kommentare, die dadurch falsch
    // werden.
    //
    // Gemessen wird an den BEISPIELZEILEN, nicht an einer zweiten Liste von Hand: sie haengen
    // ueber den Test darunter an ihrer geernteten Form, und die haengt ueber den ersten Test
    // am Quelltext. Damit reicht die Kette vom Regex bis zum `print(` — ohne eine einzige
    // Stelle, an der jemand zwei Seiten von Hand gleichhalten muss.
    const quelle = fs.readFileSync(path.join(HIER, PARSER), 'utf-8')
    const muster = parserMuster(quelle)
    // Genau der Zeilenschnitt, den parseJobPhases vorne macht — sonst faende kein Muster die
    // eingerueckten Blockzeilen.
    const zeilen = Object.values(INVENTAR)
      .filter((e) => e.art === 'gelesen' && e.beispiel)
      .map((e) => e.beispiel!.replace(/^ {0,2}/, ''))

    const tot = muster.filter((m) => !zeilen.some((z) => new RegExp(m).test(z)))
    expect(tot).toEqual([])

    // Negativkontrolle zum Scanner selbst: liest er nichts mehr (umgebautes jobPhases.ts,
    // kaputter Pfad), waere die Zusicherung darueber leer gegen leer — gruen, ohne je etwas
    // geprueft zu haben. Dieselbe Falle wie ein Fixture, das nie geladen wird.
    expect(muster.length).toBeGreaterThanOrEqual(20)

    // Und der Scanner ist selbst ein Waechter — einer ohne eigenen Test ist Dekoration.
    // Geprueft an einem Miniaturquelltext, weil an jobPhases.ts nur das ERGEBNIS sichtbar
    // waere: die erste Zeile ist der gemessene Fehlerfall (ein `/^` in einem KOMMENTAR frass
    // alles bis zum naechsten Schraegstrich und damit den echten Zweig dahinter), dazu beide
    // Verwendungen und die `.replace`-Form, die NICHT mitkommen darf — sie ist der
    // Zeilenschnitt, kein Zweig.
    const probe = [
      '// Prosa ueber ein Muster: /^ ohne Ende',
      "if ((m = l.match(/^\\[[^\\]]+\\] fertig (.+?): /))) terminal(m[1], 'done')",
      "else if (/^prep: \\d+ Datei/.test(l)) { global = 'prep' }",
      "const l = rawLine.replace(/^ {0,2}/, '')",
    ].join('\n')
    expect(parserMuster(probe)).toEqual(['^\\[[^\\]]+\\] fertig (.+?): ', '^prep: \\d+ Datei'])
  })

  it('was der Toast dem Nutzer zeigt, ist nicht „ignoriert" (#422/B5)', () => {
    // `useJobAusgang.grund()` sucht in den Protokollzeilen eines gescheiterten Laufs nach
    // einem Grund und zeigt ihn im Toast. Der Filter ist GENERISCH — er fragt nicht nach
    // einer Form, sondern nach vier Woertern. Damit ist jede Zeile, die eines davon traegt,
    // von einem Verbraucher gelesen, und `ignoriert` waere fuer sie eine Falschaussage:
    // wer sie beim naechsten Umbau umformuliert und dabei das Wort verliert, nimmt dem
    // Nutzer die einzige Auskunft ueber einen Fehlschlag (am Hook end-to-end gemessen).
    // Genau mit dieser Begruendung wurde `run: FEHLER …` umklassifiziert — der Massstab
    // gilt dann auch fuer die anderen.
    //
    // Die GRENZE steht dazu: geprueft wird die BEISPIELZEILE, und die setzt je Platzhalter
    // einen Wert ein. Eine Form, deren Beispiel den Filter nicht trifft, kann ihn mit
    // anderem Ausnahmetext sehr wohl treffen — das ist dieselbe Stichprobengrenze wie im
    // Test darunter, keine Zusage.
    const hookQuelle = fs.readFileSync(path.join(HIER, 'src', 'hooks', 'useJobAusgang.ts'), 'utf-8')
    // Der Filter steht dort als Literal in einer nicht exportierten Funktion. Ihn zu
    // importieren zoege React, sonner und die halbe API in diese Datei (sie laeuft bewusst
    // ohne DOM); stattdessen wird er hier gespiegelt UND an die Quelle gebunden.
    expect(hookQuelle).toContain(GRUND_FILTER.source)

    const stumm = Object.entries(INVENTAR)
      .filter(([, e]) => e.art === 'ignoriert' && e.beispiel && GRUND_FILTER.test(e.beispiel))
      .map(([sig]) => sig)
    expect(stumm).toEqual([])
  })

  it('jede Form ohne Parser-Wirkung bleibt im Parser wirklich wirkungslos (#422)', () => {
    // Spiegelbild des Tests darueber. `ignoriert` ist eine ZUSICHERUNG — die Zeilen duerfen
    // KEINE Phase setzen, weil sie von Umgebung, Messung oder Sperrzustand handeln und eine
    // Datei-Meldung daraus eine Falschaussage waere. Geprueft hat das bisher niemand: der
    // zweite Test filtert auf `gelesen`, fuer die ~66 `ignoriert`-Formen gab es kein
    // Gegenstueck. Genau diese Klasse hat das Repo zweimal getroffen (#413: `^\[.+?\]`
    // backtrackt und meldete eine erfundene Datei als FERTIG; die `apply: SKIP`-Zerlegung).
    //
    // ALLE DREI kind-Zweige, nicht nur einer: die Muster unterscheiden sich, und seit #405
    // faellt ein `transcribe`-Job zusaetzlich in den correct-Dialekt durch. Waere dieser Test
    // auf `correct` beschraenkt, deckte er ausgerechnet den Zweig nicht, den #405 neu oeffnet.
    //
    // DREI Grenzen, alle nachgemessen und keine davon behoben:
    // (a) Die Beispielzeilen setzen je Platzhalter EINEN Wert ein. Wo der gebunden ist
    //     (`{}` = 'ok' bzw. 'fehlgeschlagen'), ist das vollstaendig; wo fremder Text steht
    //     (Ausnahmemeldungen, Basisnamen), ist es eine Stichprobe.
    // (b) Gemessen wird ISOLIERT, eine Zeile gegen den leeren Zustand. Drei Parser-Zweige
    //     wirken nur mit Vorzustand (`blockDone` braucht eine Bloecke-Zeile, der
    //     Prozent-Zweig einen `cursor`, `[done]` eine laufende Diarisierung) — an ihnen kann
    //     eine Zeile isoliert wirkungslos aussehen und im Lauf doch etwas tun. Mit
    //     Praeludium nachgemessen: heute 0 Treffer, mit und ohne `[scope]`.
    // (c) Der Stichprobenwert `Demo` steht fuer den PROJEKTNAMEN. Heisst das Projekt `fetch`,
    //     setzt dieselbe Form unter kind `fetch` `global:'download'` (gemessen) — das ist
    //     nicht Boesartigkeit, sondern die bekannte Namenskollision aus #379/#396.
    // Absichtlich boesartige Werte gehoeren NICHT hierher: sie pruefen die Haertung der
    // Muster (#413/#416), nicht die Zusicherung 'ignoriert'.
    const haengt: string[] = []
    const leer = { transcribe: fest(parseJobPhases('transcribe', [])),
                   correct: fest(parseJobPhases('correct', [])),
                   fetch: fest(parseJobPhases('fetch', [])) }
    for (const [sig, e] of Object.entries(INVENTAR)) {
      // BEIDE Arten: 'gelesen_anderswo' heisst „ein ANDERER Verbraucher liest das" — fuer
      // `parseJobPhases` ist die Zeile genauso wirkungslos, und ohne diese Zeile verloeren
      // die 15 Formen aus #422/B5 ihre Abdeckung genau durch ihre Umklassifizierung.
      if (e.art !== 'ignoriert' && e.art !== 'gelesen_anderswo') continue
      expect(e.beispiel, `Beispielzeile fehlt fuer ${sig}`).toBeTruthy()
      for (const kind of ['transcribe', 'correct', 'fetch'] as const) {
        const mit = fest(parseJobPhases(kind, [e.beispiel!]))
        if (mit !== leer[kind]) haengt.push(`${sig} (${kind}) -> ${mit}`)
      }
    }
    expect(haengt).toEqual([])
  })

  it('jede Beispielzeile passt noch zu ihrer geernteten Form', () => {
    // Bindet die von Hand geschriebenen Beispiele an die geerntete Wahrheit: die festen Teile
    // der Signatur muessen der Reihe nach im Beispiel vorkommen. Ohne das koennte ein Beispiel
    // eine Form beschreiben, die es so nicht mehr gibt — und der Test darueber bliebe gruen,
    // waehrend er nichts mehr bewacht.
    const schief: string[] = []
    for (const [sig, e] of Object.entries(INVENTAR)) {
      if (!e.beispiel) continue
      let pos = 0
      for (const stueck of sig.split('{}')) {
        if (!stueck) continue
        const gefunden = e.beispiel.indexOf(stueck, pos)
        if (gefunden < 0) { schief.push(`${sig} -> ${e.beispiel}`); break }
        pos = gefunden + stueck.length
      }
    }
    expect(schief).toEqual([])
  })

  it('die geernteten Formen stammen aus JEDER Quelle', () => {
    // Negativkontrolle zur Ernte selbst: ein kaputter Pfad oder ein zu enger Parser liefert
    // eine leere oder halbe Menge, und die beiden Tests darueber waeren dann gruen, ohne je
    // etwas geprueft zu haben — dieselbe Falle wie ein Fixture, das nie geladen wird.
    // Je Datei geprueft, nicht ueber die Summe: eine unlesbare Quelle verschwaende sonst hinter
    // den 90+ Fundstellen der anderen (seit #409 sind es fuenf statt drei).
    const orte = [...ernte().values()].flat()
    for (const { datei } of QUELLEN) expect(orte.some((o) => o.startsWith(datei))).toBe(true)
    expect(orte.length).toBeGreaterThan(80)
  })

  it('eine unlesbare print(-Form wird gemeldet statt still verschluckt (#410)', () => {
    // Der UNLESBAR-Sentinel war ein WAECHTER OHNE SENSOR: 95 print(-Zeilen in den QUELLEN, alle
    // 95 lesbar geerntet, 0 Ausloeser — und die Gegenprobe (Zweig ersatzlos entfernt) liess alle
    // vier Tests gruen. Er ist auch fuer den Build unsichtbar, weil diese Datei in keinem
    // tsconfig-`include` steht. Geprueft wird deshalb der ERNTER, nicht die Quellen: haengte der
    // Waechter daran, dass irgendwann jemand ein `print(meldung)` schreibt, waere er wieder
    // ungeprueft, bis genau das passiert.
    expect(ersteZeichenkette('    print(meldung)')).toBeNull()
    expect(ersteZeichenkette('    print(')).toBeNull()
    // PFLICHT, keine Zugabe: ohne sie bliebe der Test gruen, wenn der Ernter gar nichts mehr
    // liest — und dann waere jede Form unklassifiziert, ohne dass ein Test es sagt.
    expect(ersteZeichenkette('    print(f"[{name}] fertig")')).toBe('[{name}] fertig')

    // Zweite Haelfte: der Ernter muss den Sentinel auch WIRKLICH eintragen. Die drei
    // Zusicherungen oben pruefen nur `ersteZeichenkette`; der Zweig, der daraus einen
    // Inventareintrag macht, bliebe ohne diese Zeilen genauso unbeobachtet wie zuvor.
    const formen = new Map<string, string[]>()
    formenAusZeilen('x.py', ['    print(meldung)', '    print(f"[{n}] fertig {b}: {s}")'], formen)
    expect(formen.get(UNLESBAR)).toEqual(['x.py:1'])
    expect(formen.get('[{}] fertig {}: {}')).toEqual(['x.py:2'])

    // Und die dritte Haelfte der Zusage: der Sentinel darf NICHT im INVENTAR stehen. Stuende er
    // dort, waere er klassifiziert — der Gleichheitstest oben bliebe bei einer unlesbaren Form
    // gruen, und genau das soll er nicht.
    expect(Object.keys(INVENTAR)).not.toContain(UNLESBAR)
  })
})
