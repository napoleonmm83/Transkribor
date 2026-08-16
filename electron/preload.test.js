'use strict'
/** Prueft, WAS die Bruecke freigibt — eine zu weit geoeffnete Bruecke faellt sonst niemandem auf. */
const Module = require('node:module')
const test = require('node:test')
const assert = require('node:assert')

let freigegeben = null
const kanaele = []
const abmeldungen = []
const aufrufe = []
const echt = Module._load
Module._load = (req, ...rest) => req === 'electron' ? {
  contextBridge: { exposeInMainWorld: (_name, api) => { freigegeben = api } },
  ipcRenderer: {
    // ALLE Argumente merken, nicht nur das erste: sonst sieht der Test einen zweiten Wert
    // (den Fortschritts-Modus) nicht, und eine verlorene Weitergabe faellt nicht auf.
    invoke: (...args) => { aufrufe.push(args); return Promise.resolve() },
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
