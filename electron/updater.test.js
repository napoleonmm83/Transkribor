'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { nichtMoeglich, sollPruefen, erstellen, macUrls, istNeuer, parseLatestMac } = require('./updater')

test('Entwicklungsmodus kann sich nicht selbst aktualisieren', () => {
  assert.strictEqual(nichtMoeglich('win32', false, false), 'entwicklung')
})

test('macOS prüft jetzt manuell — kein nicht_moeglich mehr (Spec 2026-08-11)', () => {
  assert.strictEqual(nichtMoeglich('darwin', true, false), '')
  assert.strictEqual(nichtMoeglich('darwin', false, false), 'entwicklung')
})

test('Linux nur als AppImage — ein deb-Start hat die Variable nicht', () => {
  assert.strictEqual(nichtMoeglich('linux', true, false), 'kein-appimage')
  assert.strictEqual(nichtMoeglich('linux', true, true), '')
})

test('Windows kann es', () => {
  assert.strictEqual(nichtMoeglich('win32', true, false), '')
})

test('die Hintergrund-Pruefung ruht, sobald es etwas zu tun gibt', () => {
  // Erneut suchen darf nur, wer nichts gefunden hat. 'fehler' zaehlt dazu (Netzaussetzer),
  // 'verfuegbar'/'laedt'/'bereit' nicht — sonst ueberschreibt der Zeitgeber die Anzeige,
  // in der das gefundene Update steht.
  for (const art of ['unbekannt', 'aktuell', 'fehler'])
    assert.strictEqual(sollPruefen({ art }), true, art)
  for (const art of ['prueft', 'verfuegbar', 'verfuegbar_manuell', 'laedt', 'bereit', 'nicht_moeglich', 'neuartig'])
    assert.strictEqual(sollPruefen({ art }), false, art)
  assert.strictEqual(sollPruefen(null), false, 'kein Automat gebaut')
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
  // Mac prüft jetzt manuell (eigener Zweig); dieser Test sichert das generelle
  // nicht_moeglich-Verhalten am Linux-deb-Fall (kein-appimage).
  const au = attrappe()
  const u = erstellen({ autoUpdater: au, version: '0.2.1', plattform: 'linux', gepackt: true, appimage: false, aendert: () => {} })
  assert.strictEqual(u.zustand().art, 'nicht_moeglich')
  u.pruefen()
  assert.deepStrictEqual(au.aufrufe, [], 'kein Aufruf, der ohnehin scheitern wuerde')
})

// --- Mac: manuelle Pruefung am autoUpdater vorbei (Spec 2026-08-11) ---

test('macUrls leitet Feed + Release aus build.publish ab', () => {
  const urls = macUrls({ build: { publish: [{ provider: 'github', owner: 'napoleonmm83', repo: 'Transkribor' }] } })
  assert.strictEqual(urls.feed, 'https://github.com/napoleonmm83/Transkribor/releases/latest/download/latest-mac.yml')
  assert.strictEqual(urls.release, 'https://github.com/napoleonmm83/Transkribor/releases/latest')
})

test('macUrls ohne github-publish -> null', () => {
  assert.strictEqual(macUrls({}), null)
  assert.strictEqual(macUrls({ build: { publish: [{ provider: 's3' }] } }), null)
})

test('istNeuer erkennt semver-Gefaelle', () => {
  assert.strictEqual(istNeuer('0.17.0', '0.16.0'), true)
  assert.strictEqual(istNeuer('0.16.0', '0.17.0'), false)
  assert.strictEqual(istNeuer('0.17.0', '0.17.0'), false)
  assert.strictEqual(istNeuer('1.0.0', '0.99.99'), true)
})

test('istNeuer liefert null bei ungueltigem Format', () => {
  assert.strictEqual(istNeuer('x.y.z', '0.17.0'), null)
  assert.strictEqual(istNeuer('0.17.0', 'kaputt'), null)
})

test('parseLatestMac liest Version und size', () => {
  const yml = 'version: 0.17.0\nfiles:\n  - url: X.dmg\n    size: 149843177\npath: X.dmg\n'
  assert.deepStrictEqual(parseLatestMac(yml), { version: '0.17.0', groesse: 149843177 })
})

test('parseLatestMac ohne Version -> null, size optional', () => {
  assert.strictEqual(parseLatestMac('path: X.dmg\n'), null)
  assert.strictEqual(parseLatestMac('version: 0.17.0\n').groesse, null)
})

// --- Mac-Automat: manuelle Pruefung am autoUpdater vorbei ---

/** Attrappe fuer den Mac-Pfad: `hole` als Fake-fetch, `openExternal` protokolliert. */
function bauenMac({ yml, fehler, version = '0.16.0' } = {}) {
  const ereignisse = []
  const openExternal = (...a) => ereignisse.push(['openExternal', ...a])
  const hole = async () => {
    if (fehler) throw new Error(fehler)
    return { ok: true, text: async () => yml }
  }
  const u = erstellen({
    autoUpdater: attrappe(), version, plattform: 'darwin', gepackt: true, appimage: false,
    hole, openExternal,
    feedUrl: 'https://x/latest-mac.yml', releaseUrl: 'https://x/releases/latest',
    aendert: z => ereignisse.push([z]),
  })
  return { u, ereignisse }
}

/** Ein Macrotask-Schritt: laesst die fetch-Kette (Microtasks) ablaufen. */
const settles = () => new Promise(r => setImmediate(r))

test('Mac: startet unbekannt (nicht nicht_moeglich)', () => {
  const { u } = bauenMac()
  assert.strictEqual(u.zustand().art, 'unbekannt')
  assert.strictEqual(u.zustand().version, '0.16.0')
})

test('Mac: neuere Version -> verfuegbar_manuell mit Groesse', async () => {
  const { u } = bauenMac({ version: '0.16.0', yml: 'version: 0.17.0\n  size: 149843177\n' })
  u.pruefen()
  assert.strictEqual(u.zustand().art, 'prueft')
  await settles()
  assert.strictEqual(u.zustand().art, 'verfuegbar_manuell')
  assert.strictEqual(u.zustand().neue, '0.17.0')
  assert.strictEqual(u.zustand().groesse, 149843177)
})

test('Mac: gleiche Version -> aktuell', async () => {
  const { u } = bauenMac({ version: '0.17.0', yml: 'version: 0.17.0\n' })
  u.pruefen()
  await settles()
  assert.strictEqual(u.zustand().art, 'aktuell')
})

test('Mac: Fetch-Fehler -> fehler (kein throw, kein Haengen)', async () => {
  const { u } = bauenMac({ fehler: 'netz weg' })
  u.pruefen()
  await settles()
  assert.strictEqual(u.zustand().art, 'fehler')
  assert.match(u.zustand().text, /netz weg/)
})

test('Mac: kaputte YAML (keine Version) -> fehler', async () => {
  const { u } = bauenMac({ yml: 'path: X.dmg\n' })
  u.pruefen()
  await settles()
  assert.strictEqual(u.zustand().art, 'fehler')
})

test('Mac: HTTP-Fehler (z. B. 404) -> fehler mit Status, nicht "ohne Version"', async () => {
  const u = erstellen({
    autoUpdater: attrappe(), version: '0.16.0', plattform: 'darwin', gepackt: true, appimage: false,
    hole: async () => ({ ok: false, status: 404, text: async () => 'Not Found' }),
    openExternal: () => {}, feedUrl: 'f', releaseUrl: 'r', aendert: () => {},
  })
  u.pruefen()
  await settles()
  assert.strictEqual(u.zustand().art, 'fehler')
  assert.match(u.zustand().text, /HTTP 404/)
})

test('Mac: laden oeffnet den Browser, nicht downloadUpdate', () => {
  const au = attrappe()
  const auf = []   // openExternal-Aufrufe
  const u = erstellen({
    autoUpdater: au, version: '0.16.0', plattform: 'darwin', gepackt: true, appimage: false,
    hole: async () => ({ text: async () => 'version: 0.17.0\n' }),
    openExternal: (url) => auf.push(url),
    feedUrl: 'f', releaseUrl: 'https://x/releases/latest',
    aendert: () => {},
  })
  u.laden()
  assert.deepStrictEqual(au.aufrufe, [], 'kein downloadUpdate auf Mac')
  assert.deepStrictEqual(auf, ['https://x/releases/latest'], 'oeffnet die Release-Seite')
})

// --- Feed-Quelle im GEPACKTEN Build (macOS-Fehler "Failed to parse URL from null") ----------
// electron-builder loescht `build` aus der package.json, die es in die .app legt
// (app-builder-lib/out/fileTransformer.js: ignoredPackageMetadataProperties enthaelt "build").
// Im Repo lief macUrls deshalb gruen und lieferte gepackt null -> fetch(null).

test('macUrls liest owner/repo aus app-update.yml — die Quelle, die das Packen ueberlebt', () => {
  const yml = 'provider: github\nowner: napoleonmm83\nrepo: Transkribor\nupdaterCacheDirName: transkribor-updater\n'
  const urls = macUrls({}, yml)   // package.json OHNE build — genau der gepackte Fall
  assert.strictEqual(urls.feed, 'https://github.com/napoleonmm83/Transkribor/releases/latest/download/latest-mac.yml')
  assert.strictEqual(urls.release, 'https://github.com/napoleonmm83/Transkribor/releases/latest')
})

test('macUrls faellt ohne yml auf build.publish zurueck — der Entwicklungsbetrieb hat keine', () => {
  const paket = { build: { publish: [{ provider: 'github', owner: 'napoleonmm83', repo: 'Transkribor' }] } }
  for (const ohne of [undefined, null, '', 'provider: generic\nurl: https://x/\n']) {
    const urls = macUrls(paket, ohne)
    assert.ok(urls, `Rueckfall fehlt bei ${JSON.stringify(ohne)}`)
    assert.strictEqual(urls.feed, 'https://github.com/napoleonmm83/Transkribor/releases/latest/download/latest-mac.yml')
  }
})

test('macUrls: eine unvollstaendige yml verdeckt den Rueckfall nicht', () => {
  // owner ohne repo ist kein halbes Ergebnis, sondern gar keines — sonst baute die
  // naechste Zeile eine URL mit "undefined" darin.
  const paket = { build: { publish: [{ provider: 'github', owner: 'napoleonmm83', repo: 'Transkribor' }] } }
  const urls = macUrls(paket, 'provider: github\nowner: napoleonmm83\n')
  assert.strictEqual(urls.feed, 'https://github.com/napoleonmm83/Transkribor/releases/latest/download/latest-mac.yml')
  assert.strictEqual(macUrls({}, 'provider: github\nowner: napoleonmm83\n'), null)
})

test('Mac ohne Feed-URL: nicht_moeglich statt fetch(null)', () => {
  let geholt = 0
  const u = erstellen({
    autoUpdater: attrappe(), version: '0.16.0', plattform: 'darwin', gepackt: true, appimage: false,
    hole: () => { geholt++; throw new Error('haette nie laufen duerfen') },
    openExternal: () => {}, feedUrl: null, releaseUrl: null, aendert: () => {},
  })
  assert.strictEqual(u.zustand().art, 'nicht_moeglich')
  assert.strictEqual(u.zustand().grund, 'keine-quelle')
  u.pruefen()
  assert.strictEqual(geholt, 0, 'ohne Quelle wird nichts geholt')
  assert.strictEqual(u.zustand().art, 'nicht_moeglich', 'und der Zustand bleibt ehrlich')
})

test('Mac ohne Release-URL: laden oeffnet nichts', () => {
  const auf = []
  const u = erstellen({
    autoUpdater: attrappe(), version: '0.16.0', plattform: 'darwin', gepackt: true, appimage: false,
    hole: async () => ({ ok: true, text: async () => 'version: 0.17.0\n' }),
    openExternal: url => auf.push(url), feedUrl: null, releaseUrl: null, aendert: () => {},
  })
  u.laden()
  assert.deepStrictEqual(auf, [], 'openExternal(null) waere ein Wurf im Hauptprozess')
})
