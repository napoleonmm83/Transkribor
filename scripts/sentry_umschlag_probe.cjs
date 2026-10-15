'use strict'
// Faehrt das ECHTE `@sentry/electron/main` unter node mit `fehlerberichte.optionen()` und gibt den
// Event-Umschlag als JSON auf stdout aus. Electron wird per Module._load ersetzt, der Transport
// sammelt statt zu senden. Aufgerufen von electron/fehlerberichte.test.js in einem eigenen
// Prozess, weil das SDK prozessweite Hooks setzt (Idee und erste Fassung: Review zu PR #664).
// Liegt bewusst unter scripts/: electron/** wandert ins Paket.
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const wurzel = path.join(__dirname, '..')
Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
process.resourcesPath = os.tmpdir()
const ee = () => ({ on() {}, once() {}, handle() {}, removeListener() {} })
const electron = {
  app: {
    name: 'Transkribor', getName: () => 'Transkribor', getVersion: () => '0.0.1', isPackaged: true,
    whenReady: () => Promise.resolve(), isReady: () => false, getAppPath: () => wurzel,
    getPath: () => os.tmpdir(), on() {}, once() {}, getLocale: () => 'de', getAppMetrics: () => [],
    getSystemLocale: () => 'de-CH', getGPUFeatureStatus: () => ({}), getGPUInfo: async () => ({}),
  },
  session: { defaultSession: { webRequest: { onHeadersReceived() {} }, setPreloads() {}, getPreloads: () => [] } },
  ipcMain: ee(), protocol: { registerSchemesAsPrivileged() {} }, crashReporter: { start() {} },
  webContents: { getAllWebContents: () => [] }, BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: ee(), screen: { ...ee(), getPrimaryDisplay: () => ({ size: {}, scaleFactor: 1 }) },
  net: { request() { throw new Error('net') } }, MessageChannelMain: class {},
}
const laden = Module._load
Module._load = function (anfrage, ...rest) { return anfrage === 'electron' ? electron : laden.call(this, anfrage, ...rest) }
// Lade-Hooks mitschneiden, nicht nur die interne Marke lesen: die Marke kann ein SDK-Update
// umbenennen oder spaeter setzen (Review Runde 2). VOR dem require — das SDK kopiert den
// node:module-Namensraum beim Laden.
const hookAufrufe = []
for (const name of ['register', 'registerHooks']) {
  const echt = Module[name]
  if (typeof echt === 'function') Module[name] = function (...a) { hookAufrufe.push(name); return echt.apply(this, a) }
}

const Sentry = require('@sentry/electron/main')
const fb = require(path.join(wurzel, 'electron', 'fehlerberichte'))
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-umschlag-'))
const schalter = path.join(ordner, 'fehlerberichte.json')
fs.writeFileSync(schalter, JSON.stringify({ automatisch: true, gefragt: 'probe' }))
const gesammelt = []
const optionen = fb.optionen({
  dsn: 'http://k@127.0.0.1:9/1', version: '0.0.1', gepackt: true, ipcMode: 0,
  ctx: { home: os.homedir(), daten: ordner, projekte: () => ordner, schalterPfad: () => schalter, protokollPfad: () => path.join(ordner, 'fehlt.log') },
})
optionen.transport = () => ({ send: async umschlag => { gesammelt.push(umschlag); return { statusCode: 200 } }, flush: async () => true })
Sentry.init(optionen)
Sentry.captureException(new Error('umschlag-probe'))
Sentry.flush(3000).finally(() => {
  fs.rmSync(ordner, { recursive: true, force: true })
  const ereignisse = gesammelt.flatMap(u => u[1]).filter(([kopf]) => kopf.type === 'event').map(([, rumpf]) => rumpf)
  process.stdout.write(JSON.stringify({
    umschlaege: gesammelt.length,
    ereignisse: ereignisse.map(e => ({ sdk: e.sdk, user: e.user ?? null, server_name: e.server_name ?? null })),
    lade_hook: globalThis.__SENTRY_ORCHESTRION__ != null,
    hook_aufrufe: hookAufrufe,
    rechnername_im_ereignis: ereignisse.some(e => JSON.stringify(e).includes(os.hostname())),
  }))
  process.exit(0)
})
