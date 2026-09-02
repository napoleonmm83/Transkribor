// Stehender Waechter zu #438: die Touch-Sichtbarkeit muss im GEBAUTEN CSS ankommen.
//
// Bei #428 bekamen drei Stellen die coarse-Variante (Name unten aus Teilen
// zusammengesetzt, Grund dort), weil sie ohne Zeiger unsichtbar blieben: die zwei
// Aktionsmenues in HomeGallery (Karte und Zeile) und die SPRECHERWAHL in SpeakerTurn —
// dort ist es ausdruecklich kein Aktionsmenue (SpeakerTurn.tsx:55). Geprueft wird
// das bisher NUR in jsdom — und jsdom rechnet
// keine Media Queries und wertet kein Stylesheet aus. Die Tests sehen den String im DOM,
// nicht die Regel. Faellt die Tailwind-Variante bei einem Update weg oder wird sie
// umbenannt, bleibt die ganze Suite gruen und die Menues sind auf Touch wieder weg:
// der tote Schalter mit Bestaetigungston.
//
// Haengt IM `build`-Befehl, nicht an einem `postbuild`-Haken — und das ist kein
// Geschmack: `npm run build --ignore-scripts` (oder `ignore-scripts=true` in einer
// .npmrc, eine verbreitete Lieferketten-Haertung) ueberspringt `postbuild` LAUTLOS.
// Gemessen an einer Sonde unter npm 12.0.2: mit Haken rc=1, mit `--ignore-scripts`
// rc=0 — ein gehaerteter Rechner haette gruen gebaut, ohne dass der Waechter je lief.
// In der `&&`-Kette gibt es diesen Weg nicht.
//
// Gemessen laufen ALLE drei Bauwege ueber denselben Befehl —
// .github/workflows/test.yml:148 (CI), webtool.ps1 (lokaler Start) und die
// package.json der Wurzel, deren `dist` UND `release` beide `build:frontend` aufrufen.
// Der Waechter greift damit auch beim Bau der Installationsdatei, also an der Stelle,
// an der ein Ausfall sonst ungeprueft zum Nutzer geht. **webtool.ps1 brauchte dafuer
// eine eigene Zeile**: PowerShell wertet den Rueckgabewert eines externen Befehls nicht
// aus, der Waechter lief dort also und hielt nichts auf (Begruendung steht dort).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// vite.config.ts: outDir = <frontend>/../static. Von scripts/ aus zwei Ebenen hoch.
// Ein Argument setzt den Ort ausser Kraft — nur damit die Eichzeile daneben den ECHTEN
// Einstieg samt Rueckgabewerten fahren kann statt einer nachgebauten Kopie davon.
// `postbuild` uebergibt keines.
const ASSETS = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'static', 'assets')

// ZUSAMMENGESETZT, nie als ein Stueck — aber aus einem engeren Grund, als hier zuerst
// stand. Diese Datei liegt INNERHALB des Baums, den Tailwind durchsucht; am Stueck
// geschrieben waere sie selbst eine Quelle der Regel (gemessen: nach dem Entfernen der
// Klasse aus beiden Bauteilen UND beiden Tests blieb das CSS byte-gleich, weil die
// Meldung unten den Namen trug).
//
// Was das NICHT bedeutet, und so stand es hier faelschlich: „der Waechter koennte nie
// rot werden". Er wuerde es sehr wohl. Seine Ausfallart ist „die Variante faellt weg
// oder heisst anders" — dann erzeugt KEINE Quelle mehr CSS, auch nicht ein Name am
// Stueck in dieser Datei (der gegnerische Pruefer hat es kompiliert:
// `any-pointer-koarse:opacity-100` ergibt leeres CSS). Die Zerlegung haelt lediglich die
// Scan-Quellen sauber — und genau das macht die Negativkontrolle von aussen ueberhaupt
// erst moeglich. `SpeakerTurn.test.tsx` und `HomeGallery.test.tsx` tragen den Namen
// ohnehin am Stueck und halten die Regel mit am Leben.
const VARIANTE = 'any-pointer-' + 'coarse'
const KLASSE = `${VARIANTE}:` + 'opacity-100'

const raus = (grund) => {
  console.error(`\npruefe-coarse: ${grund}\n`)
  console.error('  Betroffen: die Aktionsmenues in HomeGallery.tsx und die Sprecherwahl in')
  console.error('  SpeakerTurn.tsx sind auf Tablets und Touch-Bildschirmen unsichtbar (#428/#438).')
  console.error(`  Zu pruefen: traegt Tailwind die Variante \`${VARIANTE}:\` noch,`)
  console.error('  oder heisst sie inzwischen anders?\n')
  process.exit(1)
}

let dateien
try {
  dateien = readdirSync(ASSETS).filter(n => n.endsWith('.css'))
} catch {
  // Kein Verzeichnis ist ROT, nicht gruen: ein Waechter, der ohne Eingabe "nichts zu
  // beanstanden" meldet, ist genau der Fehler, gegen den er gebaut ist.
  raus(`kein Bau-Verzeichnis unter ${ASSETS} — wurde das Frontend gebaut?`)
}
if (dateien.length === 0) raus(`keine CSS-Datei unter ${ASSETS} — wurde das Frontend gebaut?`)

const css = dateien.map(n => readFileSync(join(ASSETS, n), 'utf8')).join('\n')

// Die Regel muss INNERHALB der Query stehen — deshalb wird deren Rumpf ausgeschnitten
// und nur dort gesucht. Zwei voneinander unabhaengige Treffer im ganzen Text genuegen
// NICHT: mit ihnen kam ein CSS durch, in dem eine fremde coarse-Query steht und der
// Selektor DANEBEN liegt (gemessen, rc=0) — der griffe dann auf jedem Geraet, und die
// Zusicherung „erst beide zusammen belegen die Weiche" war unbelegt.
//
// Klammern werden GEZAEHLT statt per Regex begrenzt: ein `[^}]*` endet schon an der
// ersten Innenregel, und in der Query steht mindestens eine.
//
// Der Doppelpunkt steht im CSS maskiert (`.any-pointer-coarse\:opacity-100`); die Suche
// laesst den Rueckstrich optional — sie deckt damit „Rueckstrich oder nichts", NICHT die
// zweite zulaessige Maskierung (Hex-Form). Die erzeugt Tailwind heute nicht.
const SELEKTOR = /\.any-pointer-coarse\\?:opacity-100\s*\{/
const REGEL = /\.any-pointer-coarse\\?:opacity-100\s*\{([^}]*)\}/

// Die Regel muss VOLLE Deckkraft setzen — der Selektor allein sagt nichts ueber die
// Wirkung: `@media (any-pointer:coarse){.any-pointer-coarse\:opacity-100{opacity:0}}`
// bestand den Waechter (gemessen, rc=0), die Knoepfe waeren unsichtbar geblieben und der
// Bau gruen. Geprueft wird der WERT, nicht sein Text: `1`, `1.0` und `100%` sind
// dasselbe, und welche Form der Minifier waehlt, ist seine Sache (gebaut steht dort
// `opacity:1`). Ein Test haelt die Prozentform fest, damit die Pruefung nicht beim
// naechsten Minifier zum Fehlalarm wird.
const volleDeckkraft = (rumpf) => {
  const regel = REGEL.exec(rumpf)
  if (!regel) return false
  const wert = /opacity\s*:\s*([^;}]+)/.exec(regel[1])
  if (!wert) return false
  const roh = wert[1].trim()
  const zahl = Number.parseFloat(roh)
  if (!Number.isFinite(zahl)) return false
  return (roh.endsWith('%') ? zahl / 100 : zahl) === 1
}

const ruempfe = []
// `(?![^{]*\bnot\b)`: eine NEGIERTE Query (`@media not (any-pointer: coarse)`) gilt fuer
// Geraete OHNE groben Zeiger — sie erfuellt die Zusicherung nicht, sie kehrt sie um.
// Ohne den Ausschluss kam sie durch, weil die Suche nur die Teilzeichenfolge fand
// (gemessen, rc=0). Bewusst grob: jedes `not` vor der Bedingung genuegt zum Ausschluss.
// Ein Fehlalarm ist hier billig — Tailwind erzeugt genau `@media (any-pointer:coarse)`,
// im gebauten CSS nachgelesen —, ein Durchlasser teuer.
const anfang = /@media(?![^{]*\bnot\b)[^{]*any-pointer\s*:\s*coarse[^{]*\{/g
for (let m; (m = anfang.exec(css)) !== null; ) {
  let tiefe = 1
  let i = m.index + m[0].length
  const von = i
  while (i < css.length && tiefe > 0) {
    if (css[i] === '{') tiefe++
    else if (css[i] === '}') tiefe--
    i++
  }
  ruempfe.push(css.slice(von, i - 1))
}

const hatQuery = ruempfe.length > 0
const hatSelektor = ruempfe.some(volleDeckkraft)
// Nur fuer die MELDUNG: „steht woanders", „steht nirgends" und „steht da, wirkt aber
// nicht" sind drei Lagen, und jede schickt den Leser an eine andere Stelle.
const selektorIrgendwo = SELEKTOR.test(css)
const selektorInQuery = ruempfe.some(r => SELEKTOR.test(r))

if (!hatQuery && !selektorIrgendwo) raus('weder die Media-Query noch der Klassenselektor stehen im gebauten CSS')
if (!hatQuery) raus('der Klassenselektor steht im gebauten CSS, aber NICHT in einer passenden Media-Query — die Regel griffe damit auf jedem Geraet')
if (selektorInQuery && !hatSelektor) raus(`die Regel \`${KLASSE}\` steht in der Media-Query, setzt dort aber KEINE volle Deckkraft — die Bedienelemente blieben auf Touch unsichtbar`)
if (!hatSelektor) raus(`eine passende Media-Query steht im gebauten CSS, aber ohne die Regel \`${KLASSE}\` — die Query gehoert einer anderen Zusicherung`)

console.log(`pruefe-coarse: ${KLASSE} liegt im gebauten CSS (${dateien.join(', ')}).`)
