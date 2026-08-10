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
const fs = require('node:fs')
const path = require('node:path')
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

test('extraResources nimmt Modellgewichte und deren Lizenz mit', () => {
  // Seit dem Wegfall des HF-Tokens liegt das Diarisierungsmodell im Repo und MUSS ins Paket.
  // Faellt der Filter weg, laeuft die Sprechertrennung im Installer still nicht — genau der
  // Schaden, den der Umbau beseitigen sollte, und im Repo unsichtbar, weil dort alles da ist.
  //
  // LICENSE-MODELLE.md haengt mit dran: CC-BY-4.0 erlaubt die Weitergabe der Gewichte nur
  // gegen Namensnennung. Gewichte ohne die Lizenzdatei auszuliefern waere ein Lizenzverstoss,
  // nicht bloss eine fehlende Datei. Dieselbe Regel gilt fuer LICENSE-SCHRIFTEN.md: OFL 1.1
  // verlangt den Hinweis bei jeder Weitergabe der fuenf mitgepackten Schriftdateien.
  const filter = (konfig.extraResources || []).flatMap(r => r.filter || [])
  for (const noetig of ['models/**/*', 'LICENSE-MODELLE.md', 'LICENSE-SCHRIFTEN.md']) {
    assert.ok(filter.includes(noetig), `${noetig} fehlt in extraResources: ${filter.join(', ')}`)
  }
})

test('setup.html findet Zeichen und Schriften neben sich', () => {
  // Das Einrichtungsfenster laedt per file:// aus electron/. Fehlt eine dieser
  // Dateien, faellt es still auf system-ui bzw. ein leeres Bild zurueck — im
  // gepackten Lauf sieht das niemand mehr.
  const html = fs.readFileSync(path.join(__dirname, 'setup.html'), 'utf8')
  for (const datei of ['marke.png', 'fonts/space-grotesk.woff2', 'fonts/dm-sans.woff2']) {
    assert.ok(html.includes(datei), `setup.html verweist nicht auf ${datei}`)
    assert.ok(fs.existsSync(path.join(__dirname, datei)), `${datei} fehlt in electron/`)
  }
})
