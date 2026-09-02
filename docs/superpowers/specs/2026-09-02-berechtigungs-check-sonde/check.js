'use strict'
/**
 * ECHTER PFAD zu #518 — welche Berechtigungen erreichen den CHECK-Handler?
 *
 * Der Request-Handler aus #446 haengt; sein Gegenpart `setPermissionCheckHandler` nicht, also
 * beantwortet Chromiums Voreinstellung jedes `navigator.permissions.query(...)`. Die beiden
 * Handler sehen VERSCHIEDENE Mengen (`electron.d.ts`: `hid`, `serial`, `usb` und
 * `deprecated-sync-clipboard-read` nur beim Check, `display-capture`, `keyboardLock`,
 * `speaker-selection`, `window-management` nur beim Request — `clipboard-read` steht entgegen
 * dem ersten Entwurf dieser Zeile in BEIDEN Unionen und laeuft gemessen durch beide), und beim Request-Handler lag die
 * Vermutung schon einmal daneben: `clipboard-sanitized-write` laeuft dort statt beim Check, ein
 * Deny-all haette „Lizenzschluessel kopieren" still abgeschaltet.
 *
 * Deshalb wird gezaehlt statt geraten. Diese Sonde ist ein EIGENER Hauptprozess (wie
 * `2026-08-28-will-navigate-sonde/navigation.js`), kein Unit-Test:
 *   - eigenes `userData` (die installierte `Transkribor.exe` haelt sonst den Ordner, und die
 *     Sonde schriebe in das echte Protokoll des Nutzers),
 *   - dasselbe `preload.js` und `contextIsolation` wie `fenster()`,
 *   - ein Check-Handler, der PROTOKOLLIERT statt abzulehnen (Lauf 1) bzw. der Waechter selbst
 *     (Lauf 2, `--mit-waechter`),
 *   - zwei Herkuenfte: `setup.html` ueber `file:` und ein lokaler HTTP-Server als Statthalter
 *     fuer `backend.url()`; dazu ein zweiter Server als FREMDE Herkunft.
 *
 * Gefahren wird, was die App wirklich tut — `Notification.permission` lesen und
 * `requestPermission()` (`useOsFortschritt.ts`), `navigator.clipboard.writeText`
 * (`SettingsPage.tsx`) — plus ein Rundumschlag ueber `navigator.permissions.query`.
 *
 *   npx electron docs/superpowers/specs/2026-09-02-berechtigungs-check-sonde/check.js
 *   npx electron docs/superpowers/specs/2026-09-02-berechtigungs-check-sonde/check.js --mit-waechter
 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '..', '..', '..', '..')
const PRELOAD = path.join(REPO, 'electron', 'preload.js')
const SETUP_HTML = path.join(REPO, 'electron', 'setup.html')
const MIT_WAECHTER = process.argv.includes('--mit-waechter')

// Eigenes Verzeichnis, VOR `whenReady` gesetzt: sonst gewinnt die installierte App den Ordner
// (auf Windows sind `Transkribor` und `transkribor` derselbe), und die Sonde schreibt in das
// echte Protokoll.
app.setPath('userData', path.join(os.tmpdir(), `sonde-518-${process.pid}`))

// Die 19 Namen, die `electron.d.ts` fuer den CHECK-Handler fuehrt (Stand Electron 43).
const CHECK_ARTEN = ['clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'fullscreen',
  'hid', 'idle-detection', 'media', 'mediaKeySystem', 'midi', 'midiSysex', 'notifications',
  'openExternal', 'pointerLock', 'serial', 'storage-access', 'top-level-storage-access', 'usb',
  'deprecated-sync-clipboard-read', 'fileSystem']
// Die WEB-Namen von `navigator.permissions.query` sind andere — deshalb beide Listen.
const QUERY_NAMEN = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read',
  'clipboard-write', 'midi', 'storage-access', 'top-level-storage-access', 'idle-detection',
  'screen-wake-lock', 'window-management', 'local-fonts', 'persistent-storage']

const spur = []
const notiz = z => { spur.push(z); console.log(z) }

function server(titel) {
  return new Promise(r => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset=utf-8><title>${titel}</title><body>${titel}`)
    })
    s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port))
  })
}

/** Was die App an Berechtigungen wirklich anfasst, plus der Rundumschlag. */
const SZENARIO = namen => `(async () => {
  const raus = []
  const sag = (was, wie) => raus.push(was + ' -> ' + wie)
  sag('Notification.permission (lesen)', Notification.permission)
  try { sag('Notification.requestPermission()', await Notification.requestPermission()) }
  catch (e) { sag('Notification.requestPermission()', 'FEHLER ' + e.name) }
  sag('Notification.permission (nach)', Notification.permission)
  try { new Notification('Sonde', { body: 'Fertigmeldung' }); sag('new Notification', 'OK') }
  catch (e) { sag('new Notification', 'FEHLER ' + e.name) }
  try { await navigator.clipboard.writeText('probe'); sag('clipboard.writeText', 'OK') }
  catch (e) { sag('clipboard.writeText', 'FEHLER ' + e.name) }
  try { sag('clipboard.readText', JSON.stringify(await navigator.clipboard.readText())) }
  catch (e) { sag('clipboard.readText', 'FEHLER ' + e.name) }
  for (const name of ${JSON.stringify(namen)}) {
    try { sag('permissions.query ' + name, (await navigator.permissions.query({ name })).state) }
    catch (e) { sag('permissions.query ' + name, 'FEHLER ' + e.name) }
  }
  try {
    const strom = await navigator.mediaDevices.getUserMedia({ audio: true })
    strom.getTracks().forEach(s => s.stop())   // sonst laeuft das Mikrofon der Sonde weiter
    sag('getUserMedia(audio)', 'OK')
  } catch (e) { sag('getUserMedia(audio)', 'FEHLER ' + e.name) }
  try {
    // Mit Zeitgrenze: erlaubt und ohne Antwort wartet der Standortdienst sonst unbegrenzt,
    // und die Sonde haengt statt zu messen.
    sag('geolocation', await new Promise(r =>
      navigator.geolocation.getCurrentPosition(() => r('OK'), f => r('abgelehnt: ' + f.code),
        { timeout: 3000 })))
  } catch (e) { sag('geolocation', 'FEHLER ' + e.name) }
  return raus.join('\\n')
})()`

async function lauf() {
  const EIGEN = await server('EIGEN (steht fuer backend.url())')
  const FREMD = await server('FREMD')
  await app.whenReady()

  const win = new BrowserWindow({
    width: 900, height: 600, show: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  })
  const ses = win.webContents.session
  const eigene = [pathToFileURL(SETUP_HTML).href, EIGEN]

  // Der Request-Handler wie in `main.js` — er faehrt mit, damit sichtbar wird, WELCHE Art bei
  // welchem Handler auflaeuft; genau daran ist die Vermutung zu #446 gescheitert.
  ses.setPermissionRequestHandler((_inhalt, art, erlauben, angaben) => {
    notiz(`REQUEST ${art} :: requestingUrl=${angaben && angaben.requestingUrl}`)
    erlauben(true)
  })

  if (MIT_WAECHTER) {
    const { eigeneHerkunft } = require(path.join(REPO, 'electron', 'fenster.js'))
    const ERLAUBT = new Set(['notifications', 'clipboard-sanitized-write'])
    ses.setPermissionCheckHandler((_inhalt, art, _herkunft, angaben) => {
      // Genau die Entscheidung aus `main.js` — ohne Rueckfall auf die Herkunft. Die erste
      // Fassung hatte einen, und auf den aufgezeichneten Eingaben faellt beides gleich aus;
      // eine Sonde, die einen ANDEREN Waechter misst als den ausgelieferten, belegt aber die
      // falsche Sache (Befund des kalten Lesers zu diesem PR).
      const eigen = eigeneHerkunft(angaben && angaben.requestingUrl, eigene)
      const erlaubt = eigen && ERLAUBT.has(art)
      notiz(`CHECK(waechter) ${art} :: eigen=${eigen} -> ${erlaubt}`)
      return erlaubt
    })
  } else {
    ses.setPermissionCheckHandler((_inhalt, art, herkunft, angaben) => {
      notiz(`CHECK ${art} :: herkunft=${herkunft} :: requestingUrl=${angaben && angaben.requestingUrl}`
        + ` :: isMainFrame=${angaben && angaben.isMainFrame}`
        + ` :: keys=${Object.keys(angaben || {}).sort().join('|')}`)
      return true
    })
  }

  for (const [was, laden] of [['file: setup.html', () => win.loadFile(SETUP_HTML)],
    ['http EIGEN', () => win.loadURL(EIGEN)], ['http FREMD', () => win.loadURL(FREMD)]]) {
    notiz(`\n===== Herkunft: ${was} =====`)
    await laden()
    const ergebnis = await win.webContents.executeJavaScript(SZENARIO(QUERY_NAMEN), true)
    notiz('--- was die Seite gesehen hat ---')
    notiz(ergebnis)
  }

  notiz('\n===== Zusammenfassung =====')
  const arten = art => [...new Set(spur.filter(z => z.startsWith(art))
    .map(z => z.split(' ')[1]))].sort().join(', ') || '(keine)'
  notiz(`Beim CHECK-Handler aufgelaufen:   ${arten('CHECK')}`)
  notiz(`Beim REQUEST-Handler aufgelaufen: ${arten('REQUEST')}`)
  notiz(`Nie gesehen (von ${CHECK_ARTEN.length} Check-Arten der Typdeklaration): `
    + CHECK_ARTEN.filter(a => !spur.some(z => z.startsWith(`CHECK`) && z.includes(` ${a} ::`))).join(', '))
  app.quit()
}

lauf().catch(e => { console.error('SONDE GESCHEITERT:', e); app.exit(1) })
