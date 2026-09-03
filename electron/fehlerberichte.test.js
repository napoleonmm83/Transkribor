'use strict'
// Wie in backend.test.js: `protokoll.js` zieht `paths.js`, und das liest `app.getPath` beim Laden.
const Module = require('node:module')
const echt = Module._load
Module._load = (req, ...rest) =>
  req === 'electron' ? { app: { isPackaged: false, getPath: () => require('os').tmpdir() } } : echt(req, ...rest)

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const fb = require('./fehlerberichte')
const bericht = require('./bericht')

const temps = []
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fehlerberichte-'))
  temps.push(d)
  return d
}
function datei(wurzel, rel) {
  const p = path.join(wurzel, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '')
}
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }) })

const HOME = 'C:\\Users\\marcus'
const DATEN = 'C:\\Users\\marcus\\AppData\\Roaming\\Transkribor'
const PROJEKTE = 'C:\\Users\\marcus\\AppData\\Roaming\\Transkribor\\projekte'
const NAMEN = { projekte: ['Interview Mueller'], dateien: ['2026-01-01 Gespraech Mueller'] }
const CTX = { home: HOME, daten: DATEN, projekte: PROJEKTE, namen: NAMEN }

// ---------------------------------------------------------------- Schalter-Datei

test('lesen: fehlende, kaputte und fremd geformte Datei heissen AUS und „nie gefragt"', () => {
  const p = fb.pfad(tmp())
  assert.deepStrictEqual(fb.lesen(p), { automatisch: false, gefragt: null })
  fs.writeFileSync(p, '{kaputt')
  assert.deepStrictEqual(fb.lesen(p), { automatisch: false, gefragt: null })
  fs.writeFileSync(p, JSON.stringify({ automatisch: 'ja', gefragt: 42 }))
  assert.deepStrictEqual(fb.lesen(p), { automatisch: false, gefragt: null })
})

test('lesen: ein fuehrendes BOM (Notepad, PowerShell) macht die Datei nicht zu AUS', () => {
  const p = fb.pfad(tmp())
  fs.writeFileSync(p, '﻿{"automatisch": true, "gefragt": "2026-09-03T02:45:00Z"}')
  assert.deepStrictEqual(fb.lesen(p), { automatisch: true, gefragt: '2026-09-03T02:45:00Z' })
})

test('schreiben/lesen: Rundreise ueber ein noch fehlendes Verzeichnis, keine tmp-Datei bleibt liegen', () => {
  const p = fb.pfad(path.join(tmp(), 'noch', 'nicht', 'da'))
  fb.schreiben(p, { automatisch: true, gefragt: '2026-09-03T01:00:00Z' })
  assert.deepStrictEqual(fb.lesen(p), { automatisch: true, gefragt: '2026-09-03T01:00:00Z' })
  assert.ok(!fs.existsSync(`${p}.tmp`), 'tmp-Datei muss weg sein')
  fb.schreiben(p, { automatisch: false })
  assert.deepStrictEqual(fb.lesen(p), { automatisch: false, gefragt: null })
})

// ---------------------------------------------------------------- Namensliste

test('namen: Projekte und Basisnamen, laengste zuerst; Kurznamen und Dateien im Stamm bleiben weg', () => {
  const d = tmp()
  datei(d, 'Interview Mueller/audio/2026-01-01 Gespraech Mueller.m4a')
  datei(d, 'Interview Mueller/transkripte/2026-01-01 Gespraech Mueller.segments.txt')
  datei(d, 'ab/audio/xy.m4a')                 // Projekt- und Basisname zu kurz
  datei(d, 'Zwei/audio/Kurz.m4a')
  fs.writeFileSync(path.join(d, 'notiz.txt'), '')   // kein Ordner, kein Projekt
  // `.segments.txt` liefert ZWEI Praefixe (bis zum ersten und bis zum zweiten Punkt) — beide
  // gehoeren in die Liste, die laengere zuerst.
  assert.deepStrictEqual(fb.namen(d), {
    projekte: ['Interview Mueller', 'Zwei'],
    dateien: ['2026-01-01 Gespraech Mueller.segments', '2026-01-01 Gespraech Mueller', 'Kurz'],
  })
  assert.deepStrictEqual(fb.namen(path.join(d, 'gibt-es-nicht')), { projekte: [], dateien: [] })
})

test('namen: ein Punkt im Namen (Anrede, Datum) schneidet den Namen nicht ab (Kalt-Review)', () => {
  const d = tmp()
  datei(d, 'Projekt Mueller/audio/Dr. Mueller Interview.m4a')
  datei(d, 'Projekt Mueller/audio/Interview 12.03.2026.m4a')
  const n = fb.namen(d)
  assert.ok(n.dateien.includes('Dr. Mueller Interview'), n.dateien.join(' | '))
  assert.ok(n.dateien.includes('Interview 12.03.2026'), n.dateien.join(' | '))
  assert.ok(!n.dateien.includes('Dr'), 'Kurzpraefix bleibt unter MIN_NAME weg')
  const ctx = { ...CTX, namen: { projekte: n.projekte, dateien: n.dateien } }
  assert.strictEqual(fb.maskiere('Datei Dr. Mueller Interview.m4a nicht lesbar', ctx), 'Datei <datei>.m4a nicht lesbar')
  assert.strictEqual(fb.maskiere('Interview 12.03.2026.m4a fehlt', ctx), '<datei>.m4a fehlt')
})

test('maskiere: URL-kodierte Namen in uvicorn-Zeilen (4xx bleiben im Bericht) fallen ebenfalls (Kalt-Review)', () => {
  const zeile = 'INFO: 127.0.0.1:51234 - "GET /api/projects/Interview%20Mueller/files/2026-01-01%20Gespraech%20Mueller HTTP/1.1" 404 Not Found'
  const m = fb.maskiere(zeile, CTX)
  assert.ok(!m.includes('Mueller'), m)
  assert.strictEqual(m, 'INFO: 127.0.0.1:51234 - "GET /api/projects/<projekt>/files/<datei> HTTP/1.1" 404 Not Found')
  assert.deepStrictEqual(fb.protokollZeilen(zeile, CTX), [m], 'die 404-Zeile bleibt, aber maskiert')
})

// ---------------------------------------------------------------- Maskierung

test('maskiere: Schluessel, Pfad, Aufnahme (Endung bleibt) und Projekt in EINER Zeile', () => {
  const z = `Datei ${PROJEKTE}\\Interview Mueller\\audio\\2026-01-01 Gespraech Mueller.m4a nicht lesbar (Schluessel sk-ant-api03-abcdefghijklmnopqrstuvwxyz)`
  const m = fb.maskiere(z, CTX)
  assert.strictEqual(m, 'Datei <projekte>\\<projekt>\\audio\\<datei>.m4a nicht lesbar (Schluessel ***[API-KEY]***)')
})

test('maskiere: derselbe Pfad in drei Schreibweisen — notiert, mit /, JSON-kodiert', () => {
  assert.strictEqual(fb.maskiere(`x ${HOME}\\y`, CTX), 'x <home>\\y')
  assert.strictEqual(fb.maskiere('x C:/Users/marcus/y', CTX), 'x <home>/y')
  assert.strictEqual(fb.maskiere('x C:\\\\Users\\\\marcus\\\\y', CTX), 'x <home>\\\\y')
})

test('maskiere: der laengste Pfad gewinnt — projekte liegt unter daten, daten unter home', () => {
  assert.strictEqual(fb.maskiere(`${PROJEKTE}\\a | ${DATEN}\\b | ${HOME}\\c`, CTX), '<projekte>\\a | <daten>\\b | <home>\\c')
})

test('maskiere: Gegenrichtung — ein Name als Teil eines anderen Wortes wird MIT maskiert (Ueber- statt Untermaskierung)', () => {
  // Bewusst so: `Interview Muellers Ordner` traegt den Projektnamen, also faellt er. Dass dabei ein
  // „s" uebrig bleibt, ist der Preis; die Alternative (Wortgrenzen) liesse `Mueller-2` durch.
  assert.strictEqual(fb.maskiere('in Interview Muellers Ordner', CTX), 'in <projekt>s Ordner')
  assert.strictEqual(fb.maskiere('Pfad C:\\Users\\marcusX\\z', CTX), 'Pfad <home>X\\z')
})

test('maskiere: was NICHT getroffen wird — fremde Pfade, kurze Namen, Nicht-Strings', () => {
  assert.strictEqual(fb.maskiere('C:\\Program Files\\Transkribor\\app.asar', CTX), 'C:\\Program Files\\Transkribor\\app.asar')
  const kurz = { ...CTX, namen: { projekte: ['ab'], dateien: [] }, home: 'C:' }
  assert.strictEqual(fb.maskiere('ab und C:\\x', kurz), 'ab und C:\\x', 'Namen/Pfade unter MIN_NAME bleiben')
  assert.strictEqual(fb.maskiere(42, CTX), 42)
  assert.strictEqual(fb.maskiere('', CTX), '')
})

test('maskiere: Gross-/Kleinschreibung von Pfaden zaehlt nur auf Windows', () => {
  const m = fb.maskiere('C:\\users\\MARCUS\\z', CTX)
  if (process.platform === 'win32') assert.strictEqual(m, '<home>\\z')
  else assert.strictEqual(m, 'C:\\users\\MARCUS\\z')
})

test('maskiereTief: jeder String im Ereignis, Zahlen und Struktur bleiben', () => {
  const ereignis = {
    message: `Absturz in ${HOME}\\x`,
    exception: { values: [{ type: 'Error', value: 'Interview Mueller fehlt', stacktrace: { frames: [{ filename: `${DATEN}\\app.asar\\main.js`, lineno: 3 }] } }] },
    extra: { zahl: 5, liste: [`${PROJEKTE}\\y`], nichts: null },
  }
  const m = fb.maskiereTief(ereignis, CTX)
  assert.strictEqual(m.message, 'Absturz in <home>\\x')
  assert.strictEqual(m.exception.values[0].value, '<projekt> fehlt')
  assert.strictEqual(m.exception.values[0].stacktrace.frames[0].filename, '<daten>\\app.asar\\main.js')
  assert.strictEqual(m.exception.values[0].stacktrace.frames[0].lineno, 3)
  assert.deepStrictEqual(m.extra, { zahl: 5, liste: ['<projekte>\\y'], nichts: null })
  assert.strictEqual(ereignis.message, `Absturz in ${HOME}\\x`, 'das Original bleibt unangetastet')
})

test('maskiereTief: ein Zyklus bricht ab statt endlos zu laufen (gemessen im gepackten Lauf: kein Envelope)', () => {
  const a = { name: `${HOME}\\x` }
  a.selbst = a
  const m = fb.maskiereTief({ a, liste: [a] }, CTX)
  assert.strictEqual(m.a.name, '<home>\\x')
  assert.strictEqual(m.a.selbst, '[Zyklus]')
  assert.strictEqual(m.liste[0], '[Zyklus]', 'dasselbe Objekt ein zweites Mal ist ein Zyklus')
})

test('ereignisMaskieren: Inhaltsfelder werden maskiert, die SDK-Metadaten bleiben DASSELBE Objekt', () => {
  const meta = { scope: {} }
  meta.scope.zurueck = meta            // so haengt das SDK seine eigenen Strukturen an
  const ereignis = {
    message: `in ${HOME}`,
    exception: { values: [{ value: 'Interview Mueller' }] },
    sdkProcessingMetadata: meta,
    event_id: 'abc', timestamp: 1, platform: 'node',
  }
  const m = fb.ereignisMaskieren(ereignis, CTX)
  assert.strictEqual(m.message, 'in <home>')
  assert.strictEqual(m.exception.values[0].value, '<projekt>')
  assert.strictEqual(m.sdkProcessingMetadata, meta, 'nicht kopiert, nicht angefasst')
  assert.strictEqual(m.event_id, 'abc')
  assert.ok(fb.INHALTSFELDER.includes('extra') && !fb.INHALTSFELDER.includes('sdkProcessingMetadata'))
})

// ---------------------------------------------------------------- Protokollzeilen

test('protokollZeilen: dieselbe Auswahl wie der Mail-Bericht, maskiert und gedeckelt', () => {
  const zeilen = []
  for (let i = 0; i < 80; i++) zeilen.push(`INFO: 127.0.0.1:5${i} - "GET /api/projects HTTP/1.1" 200 OK`)
  zeilen.push(`FEHLER: ${PROJEKTE}\\Interview Mueller\\audio\\2026-01-01 Gespraech Mueller.m4a nicht lesbar`)
  zeilen.push(`INFO: ${'x'.repeat(900)}`)
  for (let i = 0; i < 70; i++) zeilen.push(`Zeile ${i}`)
  const aus = fb.protokollZeilen(zeilen.join('\n'), CTX)
  assert.ok(aus.length <= bericht.ZEILEN, `hoechstens ${bericht.ZEILEN} Zeilen`)
  assert.ok(!aus.some(z => z.includes('200 OK')), 'Zugriffszeilen fliegen raus')
  assert.ok(aus.every(z => encodeURIComponent(z).length <= bericht.MAX_ZEILE), 'jede Zeile unter dem Deckel')
  assert.ok(aus.some(z => z === 'Zeile 69'), 'die juengsten Zeilen sind dabei')
})

test('protokollZeilen: Namen in Protokollzeilen fallen', () => {
  const text = `FEHLER: ${PROJEKTE}\\Interview Mueller\\audio\\2026-01-01 Gespraech Mueller.m4a nicht lesbar`
  assert.deepStrictEqual(fb.protokollZeilen(text, CTX), ['FEHLER: <projekte>\\<projekt>\\audio\\<datei>.m4a nicht lesbar'])
})

// ---------------------------------------------------------------- beforeSend

function welt(automatisch) {
  const d = tmp()
  const schalter = fb.pfad(path.join(d, 'daten'))
  if (automatisch !== undefined) fb.schreiben(schalter, { automatisch, gefragt: 'x' })
  const projekte = path.join(d, 'projekte')
  datei(projekte, 'Interview Mueller/audio/2026-01-01 Gespraech Mueller.m4a')
  const log = path.join(d, 'transkribor.log')
  fs.writeFileSync(log, `Start\nFEHLER: ${projekte}\\Interview Mueller\\audio\\2026-01-01 Gespraech Mueller.m4a nicht lesbar\n`)
  const ctx = { home: d, daten: path.join(d, 'daten'), projekte: () => projekte, schalterPfad: () => schalter, protokollPfad: () => log }
  return { ctx, projekte, d }
}

test('beforeSend: ohne Zustimmung geht NICHTS — Schalter AUS oder Datei fehlt ⇒ null', () => {
  assert.strictEqual(fb.beforeSend(welt(false).ctx)({ message: 'x' }), null)
  assert.strictEqual(fb.beforeSend(welt(undefined).ctx)({ message: 'x' }), null)
})

test('beforeSend: mit Zustimmung — Protokoll als Liste, Namen und Pfade maskiert, Original unangetastet', () => {
  const { ctx, projekte } = welt(true)
  const ereignis = { message: `Gespraech Mueller in ${projekte}`, exception: { values: [{ value: `2026-01-01 Gespraech Mueller.m4a fehlt` }] } }
  const aus = fb.beforeSend(ctx)(ereignis)
  assert.ok(Array.isArray(aus.extra.protokoll), 'Protokoll ist eine Liste, kein String')
  assert.deepStrictEqual(aus.extra.protokoll, ['Start', 'FEHLER: <projekte>\\<projekt>\\audio\\<datei>.m4a nicht lesbar'])
  assert.strictEqual(aus.exception.values[0].value, '<datei>.m4a fehlt')
  assert.strictEqual(aus.message, 'Gespraech Mueller in <projekte>')
  assert.ok(!JSON.stringify(aus).includes('Interview Mueller'), 'kein Projektname im Ereignis')
  assert.ok(!JSON.stringify(aus).includes(projekte), 'kein Klartext-Pfad im Ereignis')
  assert.strictEqual(ereignis.extra, undefined, 'das Original bekommt kein extra')
})

test('beforeSend: ein Ereignis mit zyklischen SDK-Metadaten kommt durch — vorher warf es und ging verloren', () => {
  const { ctx } = welt(true)
  const meta = {}
  meta.zurueck = meta
  const aus = fb.beforeSend(ctx)({ message: 'x', sdkProcessingMetadata: meta })
  assert.ok(aus, 'muss ein Ereignis liefern, kein Wurf')
  assert.strictEqual(aus.sdkProcessingMetadata, meta)
})

test('beforeSend: der Schalter wird JE EREIGNIS gelesen — AUS wirkt sofort', () => {
  const { ctx } = welt(true)
  const senden = fb.beforeSend(ctx)
  assert.ok(senden({ message: 'a' }))
  fb.schreiben(ctx.schalterPfad(), { automatisch: false })
  assert.strictEqual(senden({ message: 'b' }), null)
})

// ---------------------------------------------------------------- Optionen

test('optionen: ohne DSN ist das SDK aus, mit DSN an — und die Vorgaben stehen', () => {
  const ctx = welt(true).ctx
  const aus = fb.optionen({ dsn: '', version: '1.2.3', gepackt: true, ctx })
  assert.strictEqual(aus.enabled, false)
  assert.strictEqual(aus.dsn, undefined)
  const an = fb.optionen({ dsn: 'http://k@127.0.0.1:8123/1', version: '1.2.3', gepackt: false, ctx })
  assert.strictEqual(an.includeServerName, false, 'Rechnername (server_name) geht nie mit')
  assert.strictEqual(an.enabled, true)
  assert.strictEqual(an.release, 'transkribor@1.2.3')
  assert.strictEqual(an.environment, 'dev')
  assert.strictEqual(fb.optionen({ dsn: 'x', version: '1', gepackt: true, ctx }).environment, 'gepackt')
  assert.strictEqual(an.sendDefaultPii, false)
  assert.ok(an.maxValueLength >= bericht.MAX_ZEILE, 'eine Fehlermeldung in Zeilenlaenge kommt ganz an (maxValueLength kuerzt message/value, nicht extra)')
  assert.strictEqual(an.beforeBreadcrumb({ category: 'console' }), null)
  assert.strictEqual(typeof an.beforeSend, 'function')
})

test('optionen: auch der Offline-Transport liest den Schalter — beim Ablegen und beim Senden (Kalt-Review)', () => {
  const { ctx } = welt(true)
  const an = fb.optionen({ dsn: 'x', version: '1', gepackt: true, ctx })
  assert.strictEqual(an.transportOptions.shouldStore(), true)
  assert.strictEqual(an.transportOptions.shouldSend(), true)
  fb.schreiben(ctx.schalterPfad(), { automatisch: false })
  assert.strictEqual(an.transportOptions.shouldStore(), false, 'nichts mehr auf die Platte')
  assert.strictEqual(an.transportOptions.shouldSend(), false, 'nichts aus der Schlange raus')
})

test('optionen: der Integrationsfilter ist eine ERLAUBNISLISTE — Unbekanntes bleibt draussen', () => {
  const an = fb.optionen({ dsn: 'x', version: '1', gepackt: true, ctx: welt(true).ctx })
  // Die gemessene Vorgabe-Liste des gepackten 7.18.0 (sdk.integrations im Envelope) plus zwei
  // Namen, die es je nach Node-Version oder SDK-Update geben kann: beide muessen draussen bleiben.
  const vorgaben = ['ElectronContext', 'ChildProcess', 'OnUncaughtException', 'AdditionalContext',
    'GpuContext', 'EventFilters', 'FunctionToString', 'LinkedErrors', 'OnUnhandledRejection',
    'ContextLines', 'LocalVariablesAsync', 'Context', 'NormalizePaths',
    'LocalVariables', 'SentryMinidump', 'MainProcessSession', 'Screenshots', 'NeuMitUpdate']
    .map(name => ({ name }))
  const bleibt = an.integrations(vorgaben).map(i => i.name)
  assert.deepStrictEqual(bleibt, ['ElectronContext', 'ChildProcess', 'OnUncaughtException', 'AdditionalContext',
    'GpuContext', 'EventFilters', 'FunctionToString', 'LinkedErrors', 'OnUnhandledRejection',
    'ContextLines', 'Context', 'NormalizePaths'])
  for (const verboten of ['LocalVariables', 'LocalVariablesAsync', 'SentryMinidump', 'MainProcessSession', 'Screenshots', 'PreloadInjection']) {
    assert.ok(!fb.ERLAUBT.includes(verboten), `${verboten} darf nie in ERLAUBT stehen`)
  }
})

test('optionen: ipcMode wird durchgereicht, ohne Angabe bleibt die SDK-Vorgabe unberuehrt', () => {
  const ctx = welt(true).ctx
  assert.strictEqual(fb.optionen({ dsn: 'x', version: '1', gepackt: true, ctx, ipcMode: 1 }).ipcMode, 1)
  assert.ok(!('ipcMode' in fb.optionen({ dsn: 'x', version: '1', gepackt: true, ctx })))
})

/**
 * Die Erlaubnisliste greift nur, wenn die Namen die des INSTALLIERTEN SDK sind — die Doku nennt
 * andere (`InboundFilters`, `GPUContext`), und ein Name, den es nicht gibt, ist still ein Loch
 * in der Liste (die Integration bliebe draussen, ohne dass es jemand merkt). Sensor: jeder
 * erlaubte Name kommt als String-Literal im Paketquelltext vor; ein erfundener darf es NICHT
 * (Positivkontrolle des Sensors). Ob die Liste im GEPACKTEN Lauf wirkt, misst
 * docs/bugsink/envelope-sammler.py am Envelope (`sdk.integrations`).
 */
function quelltextTraegt(name) {
  // ALLE @sentry-Pakete, nicht eine geratene Auswahl: `LocalVariables` lebt in `node-core`,
  // nicht in `node` — die erste Fassung dieser Liste kannte das Paket nicht und war rot.
  const scope = path.join(__dirname, '..', 'node_modules', '@sentry')
  assert.ok(fs.existsSync(scope), 'das SDK muss installiert sein (npm install)')
  const wurzeln = fs.readdirSync(scope).map(p => path.join(scope, p))
  const nadel = [`'${name}'`, `"${name}"`]
  const stapel = [...wurzeln]
  while (stapel.length) {
    const d = stapel.pop()
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') stapel.push(p); continue }
      if (!/\.(c?js|mjs)$/.test(e.name)) continue
      const t = fs.readFileSync(p, 'utf8')
      if (nadel.some(n => t.includes(n))) return true
    }
  }
  return false
}

test('fehlerprobeGewuenscht: nur der Wert 1 zaehlt', () => {
  assert.strictEqual(fb.fehlerprobeGewuenscht({ TRANSKRIBOR_FEHLERPROBE: '1' }), true)
  for (const v of ['0', 'true', 'ja', '', undefined]) {
    assert.strictEqual(fb.fehlerprobeGewuenscht({ TRANSKRIBOR_FEHLERPROBE: v }), false, String(v))
  }
  assert.strictEqual(fb.fehlerprobeGewuenscht(undefined), false)
})

test('ERLAUBT: jeder erlaubte Name steht im Quelltext des installierten SDK — ein erfundener nicht', () => {
  for (const name of fb.ERLAUBT) assert.ok(quelltextTraegt(name), `${name} fehlt im SDK — umbenannt? Dann faellt die Integration still weg`)
  assert.strictEqual(quelltextTraegt('GibtEsNichtIntegration'), false, 'Positivkontrolle des Sensors')
  assert.ok(quelltextTraegt('LocalVariablesAsync'), 'die Async-Variante existiert im SDK — genau die, die die Verbotsliste uebersah')
})

test('namensFormen: NFD/NFC und URL-kodiert, jede Form maskiert', () => {
  const nfd = 'Gespräch Müller'          // so legt macOS den Namen ab
  const nfc = nfd.normalize('NFC')
  const ctx = { ...CTX, namen: { projekte: [], dateien: [nfd] } }
  assert.strictEqual(fb.maskiere(`Datei ${nfc}.m4a fehlt`, ctx), 'Datei <datei>.m4a fehlt')
  assert.strictEqual(fb.maskiere(`GET /files/${encodeURIComponent(nfc)} 404`, ctx), 'GET /files/<datei> 404')
  assert.strictEqual(fb.maskiere(`x C:%5CUsers%5Cmarcus%5Cy`, CTX), 'x <home>%5Cy', 'auch der Pfad URL-kodiert')
})
