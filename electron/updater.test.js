'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { nichtMoeglich, erstellen } = require('./updater')

test('Entwicklungsmodus kann sich nicht selbst aktualisieren', () => {
  assert.strictEqual(nichtMoeglich('win32', false, false), 'entwicklung')
})

test('macOS kann es nicht, solange die App nicht notarisiert ist', () => {
  assert.strictEqual(nichtMoeglich('darwin', true, false), 'darwin')
})

test('Linux nur als AppImage — ein deb-Start hat die Variable nicht', () => {
  assert.strictEqual(nichtMoeglich('linux', true, false), 'kein-appimage')
  assert.strictEqual(nichtMoeglich('linux', true, true), '')
})

test('Windows kann es', () => {
  assert.strictEqual(nichtMoeglich('win32', true, false), '')
})

/** Attrappe des autoUpdater: merkt sich Hoerer und protokolliert Aufrufe. */
function attrappe() {
  const hoerer = {}
  const aufrufe = []
  return {
    autoDownload: true,
    aufrufe,
    on: (ereignis, fn) => { hoerer[ereignis] = fn },
    checkForUpdates: () => { aufrufe.push('pruefen'); return Promise.resolve() },
    downloadUpdate: () => { aufrufe.push('laden'); return Promise.resolve() },
    quitAndInstall: () => { aufrufe.push('installieren') },
    feuern: (ereignis, ...rest) => hoerer[ereignis] && hoerer[ereignis](...rest),
  }
}

function bauen(zusatz = {}) {
  const au = attrappe()
  const gesehen = []
  const u = erstellen({
    autoUpdater: au, version: '0.2.1', plattform: 'win32',
    gepackt: true, appimage: false, aendert: z => gesehen.push(z), ...zusatz,
  })
  return { au, u, gesehen }
}

test('startet unbekannt und traegt immer die laufende Version', () => {
  const { u } = bauen()
  assert.strictEqual(u.zustand().art, 'unbekannt')
  assert.strictEqual(u.zustand().version, '0.2.1')
})

test('autoDownload wird abgeschaltet — sonst laedt das Pruefen sofort 100 MB', () => {
  const { au } = bauen()
  assert.strictEqual(au.autoDownload, false)
})

test('pruefen -> verfuegbar -> laedt -> bereit', () => {
  const { au, u, gesehen } = bauen()
  u.pruefen()
  assert.strictEqual(u.zustand().art, 'prueft')

  au.feuern('update-available', { version: '0.3.0', files: [{ size: 98566144 }] })
  assert.deepStrictEqual(
    { art: u.zustand().art, version: u.zustand().neue, groesse: u.zustand().groesse },
    { art: 'verfuegbar', version: '0.3.0', groesse: 98566144 })

  u.laden()
  au.feuern('download-progress', { percent: 43.2, transferred: 41, total: 94, bytesPerSecond: 6200000 })
  assert.strictEqual(u.zustand().art, 'laedt')
  assert.strictEqual(u.zustand().prozent, 43.2)

  au.feuern('update-downloaded', { version: '0.3.0' })
  assert.strictEqual(u.zustand().art, 'bereit')
  assert.ok(gesehen.length >= 4, 'jede Aenderung wird gemeldet')
})

test('kein Update vorhanden heisst aktuell', () => {
  const { au, u } = bauen()
  u.pruefen()
  au.feuern('update-not-available', {})
  assert.strictEqual(u.zustand().art, 'aktuell')
})

test('ein Fehler landet im Zustand statt im Nichts', () => {
  const { au, u } = bauen()
  au.feuern('error', new Error('404 releases.atom'))
  assert.strictEqual(u.zustand().art, 'fehler')
  assert.match(u.zustand().text, /releases\.atom/)
})

test('der ausfuehrliche Text von electron-updater geht nicht verloren', () => {
  // electron-updater liefert als zweites Argument den langen Text — der ging vorher unter.
  const { au, u } = bauen()
  au.feuern('error', new Error('boom'), 'Cannot check for updates: boom')
  assert.strictEqual(u.zustand().text, 'Cannot check for updates: boom')
})

test('fehlende Groesse wird nicht zu "0 MB" erfunden', () => {
  const { au, u } = bauen()
  au.feuern('update-available', { version: '0.3.0', files: [] })
  assert.strictEqual(u.zustand().groesse, null)
})

test('wo Updates unmoeglich sind, wird gar nicht erst geprueft', () => {
  const { au, u } = bauen({ plattform: 'darwin' })
  assert.strictEqual(u.zustand().art, 'nicht_moeglich')
  u.pruefen()
  assert.deepStrictEqual(au.aufrufe, [], 'kein Aufruf, der ohnehin scheitern wuerde')
})
