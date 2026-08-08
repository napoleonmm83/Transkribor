'use strict'
/**
 * Prueft den build-Block der package.json gegen electron-builders eigenes JSON-Schema.
 *
 * Warum das hier steht: ein falsch platzierter Schluessel (z.B. `depends` unter `linux`
 * statt unter `deb`) laesst electron-builder auf JEDER Plattform mit "Invalid configuration
 * object" abbrechen — bemerkt hat das bisher erst die CI, drei Runner spaeter. Das Schema
 * liegt in node_modules, die Pruefung kostet Millisekunden.
 */
const test = require('node:test')
const assert = require('node:assert')
const Ajv = require('ajv')

const schema = require('app-builder-lib/scheme.json')
const konfig = require('../package.json').build

function pruefen(konfiguration) {
  // Das Schema referenziert Formate (z.B. "regex"), die wir nicht brauchen — ohne
  // strict:false lehnt ajv das Schema selbst ab, nicht unsere Konfiguration.
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
  const gueltig = ajv.validate(schema, konfiguration)
  return { gueltig, fehler: (ajv.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`) }
}

test('build-Block entspricht dem electron-builder-Schema', () => {
  // Das Schema referenziert Formate (z.B. "regex"), die wir nicht brauchen — ohne
  // strict:false lehnt ajv das Schema selbst ab, nicht unsere Konfiguration.
  const { gueltig, fehler } = pruefen(konfig)      // die Schemawurzel IST die Konfiguration
  assert.ok(gueltig, `Konfiguration ungueltig:\n  ${fehler.join('\n  ')}`)
})

test('die Pruefung faengt den Fehler, der die CI dreimal abbrechen liess', () => {
  // `depends` gehoert unter `deb`, nicht unter `linux`. Ohne diesen Fall waere oben ein
  // Test, der immer besteht — und der naechste falsch platzierte Schluessel faellt wieder
  // erst drei Runner spaeter auf.
  const kaputt = { ...konfig, linux: { ...konfig.linux, depends: ['libasound2'] } }
  assert.strictEqual(pruefen(kaputt).gueltig, false)
})
