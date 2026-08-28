'use strict'
/**
 * ECHTER PFAD zu #434 — kein Unit-Test, sondern ein laufendes Electron-Fenster.
 *
 * Gemessen werden die zwei Aussagen, die im Issue ausdruecklich HERGELEITET und nicht
 * gemessen sind:
 *   (a) Laeuft `preload.js` auf einer ZWEITEN Herkunft erneut, und ist `window.transkribor`
 *       dort sichtbar?  (Die Kernpraemisse des ganzen Issues.)
 *   (b) Feuert `will-navigate` bei allen vier Wegen (location.href, Link ohne target,
 *       form action, Redirect) — und mit welcher URL?
 *
 * Dazu drei Fragen, an denen der Entwurf haengt:
 *   (c) Feuert `will-navigate` auch bei `loadURL`/`loadFile` aus dem Hauptprozess und bei
 *       Reload? (Wenn ja, MUSS der Waechter die eigene Herkunft treffen, sonst sperrt er
 *       die App aus — der Entwurfshaken aus dem Issue.)
 *   (d) Bekommt ein IFRAME den Preload? Nur dann schuetzt `will-frame-navigate` etwas.
 *   (e) Kommt die URL kanonisiert an? `fenster.js:97` behauptet, der Rohform-Zweig von
 *       `externesZiel` werde durch genau diesen zweiten Aufrufer erreichbar.
 *
 * Kein Netzzugriff nach draussen: zwei lokale HTTP-Server auf verschiedenen Ports sind die
 * zwei Herkuenfte. `shell.openExternal` wird NIE gerufen — die Sonde protokolliert nur.
 *
 * Lauf OHNE Waechter (Ist-Zustand) ist der Standard; mit `--mit-waechter` haengt sie den
 * Fix an und misst dasselbe noch einmal (Vorher/Nachher).
 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = require('node:path').resolve(__dirname, '..', '..', '..', '..')
const PRELOAD = path.join(REPO, 'electron', 'preload.js')
const SETUP_HTML = path.join(REPO, 'electron', 'setup.html')
const MIT_WAECHTER = process.argv.includes('--mit-waechter')

let A = ''     // eigene Herkunft (steht fuer backend.url())
let B = ''     // fremde Herkunft

function server(seite, extra) {
  return new Promise(r => {
    const s = http.createServer((req, res) => {
      if (extra && extra(req, res)) return
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(seite())
    })
    s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port))
  })
}

const seiteA = () => '<!doctype html><meta charset=utf-8><title>EIGEN</title><body>'
  + '<a id=lnk href="' + B + '/ziel">Link ohne target</a>'
  + '<form id=fget action="' + B + '/ziel" method=get><input name=a value=1></form>'
  + '<form id=fpost action="' + B + '/ziel" method=post><input name=a value=1></form>'
  + '<iframe id=rahmen src="about:blank" width=50 height=50></iframe>'
  + '</body>'
const seiteB = () => '<!doctype html><meta charset=utf-8><title>FREMD</title><body>fremde Herkunft</body>'

// ── Ereignis-Aufzeichnung ────────────────────────────────────────────────────
let lauf = []
const merken = (art, url, extra) => lauf.push(art + (extra || '') + ' -> ' + url)
const kurz = u => String(u).split(A).join('{EIGEN}').split(B).join('{FREMD}')
const warte = ms => new Promise(r => setTimeout(r, ms))

async function zustand(ziel) {
  try {
    return await ziel.executeJavaScript(
      '({u: location.href, b: typeof window.transkribor,'
      + ' k: window.transkribor ? Object.keys(window.transkribor).length : 0})', true)
  } catch (e) { return { u: '(nicht abfragbar)', b: 'FEHLER: ' + e.message, k: 0 } }
}

async function fall(win, name, js) {
  await win.loadURL(A + '/')                 // programmatisch zuruecksetzen
  await warte(200)
  lauf = []                                  // erst JETZT aufzeichnen
  try { await win.webContents.executeJavaScript(js, true) } catch { /* ein Wurf ist auch ein Ergebnis */ }
  await warte(900)
  const z = await zustand(win.webContents)
  const gelandet = z.u.startsWith(B) ? 'FREMD' : (z.u.startsWith(A) ? 'eigen' : z.u)
  console.log('\n── ' + name)
  console.log('   Ereignisse: ' + (lauf.length ? lauf.map(kurz).join(' | ') : '(KEINES)'))
  console.log('   gelandet:   ' + gelandet + '   ·   window.transkribor: ' + z.b + ' (' + z.k + ' Schluessel)')
  return { name, lauf: lauf.slice(), gelandet, bruecke: z.b, schluessel: z.k }
}

app.commandLine.appendSwitch('disable-http2')
app.whenReady().then(async () => {
  B = await server(seiteB)
  A = await server(seiteA, (req, res) => {
    if (req.url.indexOf('/weiter') === 0) { res.writeHead(302, { Location: B + '/ziel' }); res.end(); return true }
    return false
  })

  const win = new BrowserWindow({
    show: false,
    // Exakt die webPreferences des echten Fensters (main.js: fenster()).
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  })

  for (const art of ['will-navigate', 'will-frame-navigate', 'will-redirect'])
    win.webContents.on(art, (e, url) => merken(art, url))

  if (MIT_WAECHTER) {
    const { eigeneHerkunft, externesZiel } = require(path.join(REPO, 'electron', 'fenster.js'))
    const pruefen = (e, url) => {
      if (eigeneHerkunft(url, [pathToFileURL(SETUP_HTML).href, A + '/'])) return
      e.preventDefault()
      merken('  [WAECHTER blockt]', url, externesZiel(url) ? ' (ginge in den Browser)' : ' (abgewiesen)')
    }
    win.webContents.on('will-navigate', pruefen)
    win.webContents.on('will-redirect', pruefen)
  }

  console.log('eigene Herkunft {EIGEN} = ' + A)
  console.log('fremde Herkunft {FREMD} = ' + B)
  console.log('Waechter: ' + (MIT_WAECHTER ? 'AN (nach dem Fix)' : 'AUS (Ist-Zustand)'))

  // (c) Feuert ein programmatisches Laden ueberhaupt? Und (a) auf der eigenen Seite.
  lauf = []
  await win.loadFile(SETUP_HTML)
  await warte(300)
  const zSetup = await zustand(win.webContents)
  console.log('\n── (c) loadFile(setup.html) aus dem Hauptprozess')
  console.log('   Ereignisse: ' + (lauf.length ? lauf.map(kurz).join(' | ') : '(KEINES)'))
  console.log('   window.transkribor auf setup.html: ' + zSetup.b + ' (' + zSetup.k + ' Schluessel)')

  lauf = []
  await win.loadURL(A + '/')
  await warte(300)
  console.log('── (c) loadURL(eigene Herkunft) aus dem Hauptprozess')
  console.log('   Ereignisse: ' + (lauf.length ? lauf.map(kurz).join(' | ') : '(KEINES)'))

  const ergebnisse = []
  ergebnisse.push(await fall(win, '(b1) location.href = FREMD', 'location.href = ' + JSON.stringify(B + '/ziel')))
  ergebnisse.push(await fall(win, '(b2) Link ohne target, geklickt', "document.getElementById('lnk').click()"))
  ergebnisse.push(await fall(win, '(b3) form action, GET', "document.getElementById('fget').submit()"))
  ergebnisse.push(await fall(win, '(b4) form action, POST', "document.getElementById('fpost').submit()"))
  ergebnisse.push(await fall(win, '(b5) 302-Redirect EIGEN -> FREMD', 'location.href = ' + JSON.stringify(A + '/weiter')))
  ergebnisse.push(await fall(win, '(e) Steuerzeichen vor der URL', 'location.href = ' + JSON.stringify('\u0000' + B + '/ziel')))
  ergebnisse.push(await fall(win, '(c) location.reload() im Renderer', 'location.reload()'))
  ergebnisse.push(await fall(win, '(c) eigene Herkunft, anderer Pfad', 'location.href = ' + JSON.stringify(A + '/andere/seite?x=1#y')))

  // (c2) Reload von setup.html IM RENDERER — der in electron/CLAUDE.md dokumentierte
  // Ctrl+R-Fall mitten in der Einrichtung. Das ist der einzige Weg, auf dem eine file:-URL
  // ueberhaupt an den Waechter kommt; traefe er sie nicht, sperrte er die Einrichtungsseite aus.
  await win.loadFile(SETUP_HTML)
  await warte(300)
  lauf = []
  await win.webContents.executeJavaScript('location.reload()', true)
  await warte(900)
  const zSetupReload = await zustand(win.webContents)
  console.log('\n── (c2) location.reload() AUF setup.html (Ctrl+R waehrend der Einrichtung)')
  console.log('   Ereignisse (ROHE URL): ' + (lauf.length ? lauf.join(' | ') : '(KEINES)'))
  console.log('   erwartete eigene URL:  will-navigate -> ' + pathToFileURL(SETUP_HTML).href)
  console.log('   gelandet: ' + zSetupReload.u)

  // (d) IFRAME auf fremde Herkunft
  await win.loadURL(A + '/')
  await warte(300)
  lauf = []
  await win.webContents.executeJavaScript(
    "document.getElementById('rahmen').src = " + JSON.stringify(B + '/ziel'), true)
  await warte(1000)
  const rahmen = win.webContents.mainFrame.frames[0]
  const rz = rahmen ? await zustand(rahmen) : { u: '(kein Rahmen)', b: '-', k: 0 }
  console.log('\n── (d) IFRAME auf fremde Herkunft')
  console.log('   Ereignisse: ' + (lauf.length ? lauf.map(kurz).join(' | ') : '(KEINES)'))
  console.log('   Rahmen-URL: ' + kurz(rz.u) + '   ·   window.transkribor im Rahmen: ' + rz.b + ' (' + rz.k + ' Schluessel)')

  console.log('\n\n=== BILANZ ===')
  console.log('Fall                                     will-navigate  gelandet  Bruecke')
  console.log('---------------------------------------- -------------  --------  -------')
  for (const e of ergebnisse) {
    const wn = e.lauf.some(z => z.indexOf('will-navigate') === 0) ? 'JA' : 'nein'
    console.log(e.name.padEnd(41) + wn.padEnd(15) + e.gelandet.padEnd(10) + e.bruecke + '/' + e.schluessel)
  }
  app.quit()
})
