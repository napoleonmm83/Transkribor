/**
 * Der Waechter fuer den Waechter (#510).
 *
 * `testlauf.mjs` ist die einzige Stelle, an der ein leerer Testlauf noch auffaellt — faellt
 * seine Zaehlpruefung still aus, ist genau der Zustand wieder da, gegen den er gebaut wurde,
 * und er sieht dabei gruen aus. Deshalb haengt er im SELBEN npm-Skript wie die
 * Electron-Suite (`test:electron`) — ein Waechter ohne Aufrufweg ist keiner, die Lehre aus
 * PR #501, wo `scripts/test_weg_benchmark.py` ein Vierteljahr lang in keinem Workflow lief.
 * Aber in einem ZWEITEN Aufruf hinter `&&`, nicht als weiteres Muster im ersten: sonst
 * halten diese Tests die Gesamtzahl ueber null, waehrend die Electron-Suite still
 * verschwindet — gemessen, `tests 3`, rc 0.
 *
 * Gefahren wird das Skript als echter Kindprozess ueber ein Wegwerf-Verzeichnis; geprueft
 * wird der Exitcode, also genau das, was die CI liest. Das Muster ist relativ (`*.test.js`)
 * und der Lauf bekommt `cwd` — so bleibt die Frage draussen, wie Node einen Backslash im
 * Glob deutet.
 */
import test from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTLAUF = fileURLToPath(new URL('./testlauf.mjs', import.meta.url))
const GRUENE_PROBE = "const test = require('node:test')\ntest('gruen', () => {})\n"
const ROTE_PROBE = "const test = require('node:test')\ntest('rot', () => { throw new Error('mit Absicht') })\n"
// Beide Formen der Bilanzzeile: Node 22 schreibt ins Rohr TAP, Node 24 den Spec-Reporter.
// Eine Zusicherung nur auf die TAP-Form waere auf der CI-Fassung rot — und damit jeder
// Release-Bau (`release.yml`), der `npm run test:electron` vor dem Packen faehrt.
const BILANZ_EINS = /(?:# |ℹ )tests 1\b/
// Das Steuerzeichen als Zeichencode, nicht als Escape im Literal — ein rohes ESC im
// Quelltext ist unsichtbar und ueberlebt keinen Editor zuverlaessig.
const ESC = String.fromCharCode(27)
const temps = []

/** Wegwerf-Verzeichnis, optional mit einer Testdatei darin. */
function wegwerf(inhalt) {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'testlauf-'))
  temps.push(ordner)
  if (inhalt) fs.writeFileSync(path.join(ordner, 'probe.test.js'), inhalt)
  return ordner
}

function starte(ordner, zusatz, muster) {
  // In einer Testdatei steht `NODE_TEST_CONTEXT=child-v8` in der Umgebung (gemessen). Erbt
  // das Kind sie, verweigert dessen Runner die Arbeit — „run() is being called recursively
  // within a test file. skipping running files" — und druckt GAR KEINE Bilanzzeile. Gemessen
  // ohne diesen Griff: Fall 1 und 2 kippen ROT (mit der falschen Begruendung), Fall 3 bleibt
  // vacuous gruen. Der Waechter selbst braucht das nicht: ihn faehrt sonst niemand aus einem
  // laufenden Testprozess heraus.
  const umgebung = { ...process.env, ...zusatz }
  delete umgebung.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [TESTLAUF, ...muster], { cwd: ordner, encoding: 'utf8', env: umgebung })
}

const lauf = (ordner, ...muster) => starte(ordner, {}, muster)
const laufFarbig = (ordner, ...muster) => starte(ordner, { FORCE_COLOR: '1' }, muster)

test.after(() => { for (const o of temps) fs.rmSync(o, { recursive: true, force: true }) })

test('ein Glob ohne Treffer ist ROT, nicht gruen (#510)', () => {
  const e = lauf(wegwerf(null), '*.test.js')
  assert.notStrictEqual(e.status, 0, 'null gesammelte Tests muessen den Lauf scheitern lassen')
  assert.match(e.stderr, /null Tests gesammelt/, 'der Grund gehoert ins Protokoll, nicht nur der Code')
})

test('ein gruener Lauf bleibt gruen — die Positivkontrolle (#510)', () => {
  const e = lauf(wegwerf(GRUENE_PROBE), '*.test.js')
  assert.strictEqual(e.status, 0, `unerwartet rot:\n${e.stdout}\n${e.stderr}`)
  assert.match(e.stdout, BILANZ_EINS, 'die Ausgabe des Runners wird durchgereicht')
})

test('ein roter Test bleibt rot — der Exitcode des Kindes wird durchgereicht (#510)', () => {
  const e = lauf(wegwerf(ROTE_PROBE), '*.test.js')
  assert.notStrictEqual(e.status, 0, 'ein fehlgeschlagener Test darf nicht an der Zaehlpruefung vorbeikommen')
  assert.doesNotMatch(e.stderr, /null Tests gesammelt/, 'hier zaehlt der Testfehler, nicht die Zahl')
})

test('ein Lauf OHNE Bilanzzeile ist ROT — der Sensor darf nicht still ausfallen (#510)', () => {
  // Der `dot`-Reporter druckt einen Punkt je Test und KEINE Bilanz (gemessen); das Kind endet
  // dabei mit rc 0. Genau dieser Fall unterscheidet den Waechter vom alten Zustand: er darf
  // dem Exitcode nicht glauben, wenn er die Zahl nicht lesen konnte.
  const e = lauf(wegwerf(GRUENE_PROBE), '--test-reporter=dot', '--test-reporter-destination=stdout', '*.test.js')
  assert.notStrictEqual(e.status, 0, 'gruener Testlauf, aber kein lesbarer Sensor: muss rot sein')
  assert.match(e.stderr, /keine Bilanzzeile/, 'und der Grund muss dastehen')
})

test('eine GEFAERBTE Bilanzzeile bleibt lesbar — kein falsches Rot (#510)', () => {
  // Mit `FORCE_COLOR=1` faerbt der Spec-Reporter seine Bilanz (`ESC[34m…`), und eine am
  // Zeilenanfang verankerte Regex greift ohne Entfaerben nicht mehr: gruene Tests waeren dann
  // ein gemeldeter Ausfall. Die Richtung ist zwar laut statt still — aber ein Waechter, der
  // bei gruenen Tests rot wird, wird abgeschaltet, und danach schuetzt er nichts mehr.
  const e = laufFarbig(wegwerf(GRUENE_PROBE), '--test-reporter=spec', '--test-reporter-destination=stdout', '*.test.js')
  // Vorbedingung zuerst: ohne wirklich gefaerbte Ausgabe prueft dieser Fall gar nichts und
  // bliebe auch dann gruen, wenn das Entfaerben ersatzlos verschwaende.
  assert.ok(e.stdout.includes(ESC + '['), 'Vorbedingung verfehlt: die Ausgabe ist gar nicht gefaerbt')
  assert.strictEqual(e.status, 0, `unerwartet rot:\n${e.stdout}\n${e.stderr}`)
})
