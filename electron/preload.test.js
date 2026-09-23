'use strict'
/** Prueft, WAS die Bruecke freigibt — eine zu weit geoeffnete Bruecke faellt sonst niemandem auf. */
const Module = require('node:module')
const test = require('node:test')
const assert = require('node:assert')

let freigegeben = null
const welten = {}
const kanaele = []
const abmeldungen = []
const aufrufe = []
const senden = []
const echt = Module._load
Module._load = (req, ...rest) => req === 'electron' ? {
  contextBridge: { exposeInMainWorld: (name, api) => { welten[name] = api; if (name === 'transkribor') freigegeben = api } },
  ipcRenderer: {
    // ALLE Argumente merken, nicht nur das erste: sonst sieht der Test einen zweiten Wert
    // (den Fortschritts-Modus) nicht, und eine verlorene Weitergabe faellt nicht auf.
    invoke: (...args) => { aufrufe.push(args); return Promise.resolve() },
    send: (...args) => senden.push(args),
    on: (k) => kanaele.push(k),
    removeListener: (k) => abmeldungen.push(k),
  },
} : echt(req, ...rest)
require('./preload')
Module._load = echt

test('die Update-Methoden sind da', () => {
  for (const name of ['status', 'pruefen', 'laden', 'installieren']) {
    assert.strictEqual(typeof freigegeben.update[name], 'function', name)
  }
})

test('abbrechen ist die Bruecke für den Rückweg der Einrichtung (#242)', async () => {
  // Letzte Kante der Abbruchkette: Knopf -> Bruecke -> Hauptprozess. Dass der
  // Kanal ohne Argument gerufen wird, ist die schmale Bruecke (#218-Muster).
  assert.strictEqual(typeof freigegeben.abbrechen, 'function')
  await freigegeben.abbrechen()
  assert.deepStrictEqual(aufrufe.at(-1), ['einrichten:abbrechen'])
})

test('der Kanal update ist erlaubt, ein erfundener nicht', () => {
  freigegeben.on('update', () => {})
  freigegeben.on('kanal-den-es-nicht-gibt', () => {})
  assert.deepStrictEqual(kanaele, ['update'])
})

test('on gibt eine Abmeldefunktion zurueck, die den Hoerer wieder entfernt', () => {
  const ab = freigegeben.on('update', () => {})
  assert.strictEqual(typeof ab, 'function')
  ab()
  assert.deepStrictEqual(abmeldungen, ['update'])
})

test('ein erfundener Kanal liefert trotzdem eine (wirkungslose) Abmeldefunktion', () => {
  const ab = freigegeben.on('kanal-den-es-nicht-gibt', () => {})
  assert.strictEqual(typeof ab, 'function')
  assert.doesNotThrow(() => ab())
})

test('projekteOeffnen ruft den Hauptprozess OHNE Argument (#218)', async () => {
  // Das fehlende Argument ist die Zusicherung, nicht ein Detail: naehme der Kanal einen Pfad
  // entgegen, koennte alles, was in diesem Fenster laeuft, ein beliebiges Verzeichnis
  // oeffnen lassen — und dort laeuft Transkripttext, der aus einem URL-Import stammen kann.
  // Der Hauptprozess kennt `P.projekte` selbst.
  await freigegeben.projekteOeffnen()
  assert.deepStrictEqual(aufrufe.at(-1), ['projekteOeffnen'])
})

test('manueller Fehlerbericht holt die Vorschau ohne Argument und sendet die Auswahl', async () => {
  await freigegeben.fehlerbericht.vorschau()
  assert.deepStrictEqual(aufrufe.at(-1), ['fehlerbericht:vorschau'])
  await freigegeben.fehlerbericht.senden('token', [0, 2], 'Beschreibung')
  assert.deepStrictEqual(aufrufe.at(-1), ['fehlerbericht:senden', 'token', [0, 2], 'Beschreibung'])
})

test('Renderer-SDK darf nur einen Envelope-Kanal senden', () => {
  const bruecke = welten.__SENTRY_IPC__['sentry-ipc']
  const envelope = { event: 'test' }
  bruecke.sendEnvelope(envelope)
  assert.deepStrictEqual(senden.at(-1), ['fehlerberichte:renderer', envelope])
  const vorher = senden.length
  for (const methode of ['sendRendererStart', 'sendScope', 'sendStatus', 'sendStructuredLog', 'sendMetric']) bruecke[methode]('ignoriert')
  assert.strictEqual(senden.length, vorher)
})

test('plattform ist die process.platform des Hauptprozesses', () => {
  // Der Renderer kennt process.platform wegen contextIsolation nicht selbst -- die
  // Bruecke muss ihn deshalb als Wert (nicht als Funktion) mitgeben.
  assert.strictEqual(freigegeben.plattform, process.platform)
})

test('titelleisteFarbe reicht Farbe an den Hauptprozess weiter', async () => {
  const f = { color: '#0B0B0F', symbolColor: '#FAFAFA' }
  await freigegeben.titelleisteFarbe(f)
  assert.deepStrictEqual(aufrufe.at(-1), ['titelleisteFarbe', f])
})

test('fortschritt reicht Anteil und Modus an den Hauptprozess weiter', async () => {
  await freigegeben.fortschritt(0.5)
  assert.deepStrictEqual(aufrufe.at(-1), ['fortschritt', 0.5, undefined])
  // Ohne den zweiten Wert kaeme der gescheiterte Lauf als normaler Balken an.
  await freigegeben.fortschritt(0.5, 'error')
  assert.deepStrictEqual(aufrufe.at(-1), ['fortschritt', 0.5, 'error'])
})

test('fehlerberichte: status ohne Argument, setzen reicht NUR ein echtes true durch (#530)', async () => {
  await freigegeben.fehlerberichte.status()
  assert.deepStrictEqual(aufrufe.at(-1), ['fehlerberichte:status'])
  await freigegeben.fehlerberichte.setzen(true)
  assert.deepStrictEqual(aufrufe.at(-1), ['fehlerberichte:setzen', true])
  // Alles andere kommt als `false` an — die Bruecke komponiert nichts (#218), sie normiert.
  for (const wert of ['ja', 1, {}, undefined]) {
    await freigegeben.fehlerberichte.setzen(wert)
    assert.deepStrictEqual(aufrufe.at(-1), ['fehlerberichte:setzen', false], String(wert))
  }
})
