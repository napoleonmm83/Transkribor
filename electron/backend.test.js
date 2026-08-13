'use strict'
// Wie in setup.test.js: `paths.js` liest `app.isPackaged` beim Laden, und unter `node --test`
// liefert `require('electron')` nur den Pfad zum Binary.
const Module = require('node:module')
const echt = Module._load
Module._load = (req, ...rest) =>
  req === 'electron' ? { app: { isPackaged: false, getPath: () => '/tmp' } } : echt(req, ...rest)

const test = require('node:test')
const assert = require('node:assert')
const { serverEnv } = require('./backend')

test('die gepackte App reicht ihr eigenes Binary als JS-Laufzeit durch (#171)', () => {
  // yt-dlp braucht fuer YouTubes Signatur eine JS-Laufzeit; die gepackte App hat weder node
  // noch deno. Sie bringt aber eine mit: Electrons Binary ist mit ELECTRON_RUN_AS_NODE=1 ein
  // gewoehnliches Node. Ohne diese Zeile bleibt der URL-Import im Installer bei 403.
  const env = serverEnv('C:\\Program Files\\Transkribor\\Transkribor.exe')
  assert.strictEqual(env.TRANSKRIBOR_JS_RUNTIME, 'C:\\Program Files\\Transkribor\\Transkribor.exe')
})

test('die beiden Variablen der JS-Laufzeit bleiben zusammen', () => {
  // DER Riegel dieses Fixes. Ohne ELECTRON_RUN_AS_NODE startet der Pfad, auf den
  // TRANSKRIBOR_JS_RUNTIME zeigt, ein zweites GUI-Fenster statt zu rechnen — und weil
  // yt-dlp danach ohnehin auf Player-Clients ohne Signatur ausweicht, faellt es meistens
  // nicht einmal auf. Die Kombination laesst sich im Betrieb nur durch ein Editieren
  // trennen; genau davor steht dieser Test.
  const env = serverEnv('/Applications/Transkribor.app/Contents/MacOS/Transkribor')
  assert.ok(env.TRANSKRIBOR_JS_RUNTIME, 'Pfad fehlt')
  assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1')
})

test('die uebrigen Pfade des Servers bleiben gesetzt', () => {
  // serverEnv wurde aus start() herausgeloest — die vier bestehenden Variablen duerfen
  // dabei nicht verlorengehen (TRANSKRIBOR_PROJEKTE ist die, an der ein gepackter Lauf
  // sonst neben dem Code nach Projekten sucht und nichts findet).
  const env = serverEnv('exe')
  for (const k of ['PYTHONUNBUFFERED', 'PYTHONIOENCODING', 'TRANSKRIBOR_ENV',
                   'TRANSKRIBOR_PROJEKTE', 'TRANSKRIBOR_GGML']) {
    assert.ok(env[k], `${k} fehlt`)
  }
})
