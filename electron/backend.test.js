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

test('ELECTRON_RUN_AS_NODE steht NICHT in der Server-Umgebung', () => {
  // Gegenrichtung, Review-Befund: jobs.py gibt diese Umgebung an JEDEN Subprozess weiter
  // (transcribe, correct, `claude`/`codex` samt Anmelde-Flow). Gebraucht wird das Flag nur
  // von dem einen node-Aufruf, den yt-dlp startet — deshalb setzt es `fetch.download_one`
  // in seinem eigenen Prozess (webtool/test_fetch.py haelt das fest).
  assert.strictEqual(serverEnv('exe').ELECTRON_RUN_AS_NODE, undefined)
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

test('der Server schreibt keinen Bytecode neben die Anwendung (#505)', () => {
  // Gemessen am gebauten Paket, nicht hergeleitet: eine frisch nach /Applications
  // installierte .app hatte nach EINEM Start 21 .pyc in Contents/Resources/py und
  // `codesign --verify --deep --strict` sagte "a sealed resource is missing or invalid".
  // Mit dieser Variablen: 0 Dateien, Signatur gueltig.
  //
  // Der Test haengt an `serverEnv`, weil dort die eine Stelle ist, die zaehlt: jobs.py
  // startet transcribe.py und die Korrektur mit {**os.environ}, erbt die Umgebung des
  // Servers also — ein Unterprozess, der die Variable NICHT erbt, schriebe den Cache
  // weiter ins Bundle und braeche das Siegel genauso.
  assert.strictEqual(serverEnv('exe').PYTHONDONTWRITEBYTECODE, '1')
})

// ── projektePfad (#218) ────────────────────────────────────────────────────────
// Gegen einen ECHTEN lokalen HTTP-Server, nicht gegen eine Attrappe von `http`: die
// Zusicherung ist „wir fragen den Server und glauben ihm", und dazu gehoert der Weg durch
// Statuscode, Body und JSON.
const http = require('node:http')
const { projektePfad } = require('./backend')

function server(antwort) {
  return new Promise(res => {
    const s = http.createServer((req, r) => antwort(req, r))
    s.listen(0, '127.0.0.1', () => res({ s, basis: `http://127.0.0.1:${s.address().port}/` }))
  })
}

test('projektePfad nimmt den Pfad des SERVERS, nicht P.projekte (#218)', async () => {
  // Der Kern des Befunds: `serverEnv()` reicht `TRANSKRIBOR_PROJEKTE` zwar hinein, aber die
  // `.env` des Servers darf es ueberschreiben. Wer hier `P.projekte` nimmt, oeffnet still
  // einen anderen Ordner als die Seite anzeigt — und weil `start()` `P.projekte` anlegt,
  // gibt `shell.openPath` dazu keinen Fehler.
  let gefragt = null
  const { s, basis } = await server((req, r) => {
    gefragt = req.url
    r.writeHead(200, { 'Content-Type': 'application/json' })
    r.end(JSON.stringify({ projekte_pfad: 'D:\\Daten\\MeineTranskripte', provider: 'claude-cli' }))
  })
  try {
    assert.strictEqual(await projektePfad(basis), 'D:\\Daten\\MeineTranskripte')
    assert.strictEqual(gefragt, '/api/settings')
  } finally { s.close() }
})

test('projektePfad faellt NICHT auf einen geratenen Pfad zurueck, wenn der Server schweigt', async () => {
  // Ein Rueckfall waere genau die stille Divergenz, gegen die die Funktion gebaut ist —
  // dann lieber eine Fehlermeldung, die der Nutzer sieht.
  const { s, basis } = await server((_req, r) => { r.writeHead(500); r.end('kaputt') })
  try {
    await assert.rejects(projektePfad(basis), /antwortet mit 500/)
  } finally { s.close() }
})

test('projektePfad meldet eine Antwort ohne Projektordner, statt "undefined" zu oeffnen', async () => {
  const { s, basis } = await server((_req, r) => {
    r.writeHead(200, { 'Content-Type': 'application/json' })
    r.end(JSON.stringify({ provider: 'claude-cli' }))     // Feld fehlt
  })
  try {
    await assert.rejects(projektePfad(basis), /keinen Projektordner/)
  } finally { s.close() }
})

test('projektePfad meldet unlesbares JSON als solches', async () => {
  const { s, basis } = await server((_req, r) => { r.writeHead(200); r.end('<html>kein JSON') })
  try {
    await assert.rejects(projektePfad(basis), /nicht lesbar/)
  } finally { s.close() }
})

test('projektePfad meldet einen nicht erreichbaren Server', async () => {
  // Port, auf dem nichts lauscht: der `error`-Zweig der Anfrage, nicht der der Antwort.
  await assert.rejects(projektePfad('http://127.0.0.1:1/'), /nicht erreichbar/)
})

test('projektePfad haengt nicht, wenn der Server annimmt und dann schweigt (#218)', async () => {
  // Der gefaehrlichste Ausgang: die Verbindung steht, es kommt nur nie eine Antwort. `http.get`
  // bringt dafuer KEINE Frist mit — ohne sie bliebe das Promise fuer immer offen, der Knopf
  // drehte, und kein Toast erschiene. Ein Haenger ist schlimmer als eine Ausnahme: beim
  // Aufrufer faengt ihn kein `catch`.
  const { s, basis } = await server(() => { /* absichtlich keine Antwort */ })
  try {
    await assert.rejects(projektePfad(basis, 60), /antwortet nicht/)
  } finally {
    s.closeAllConnections()
    s.close()
  }
})
