'use strict'
/**
 * Gegenprobe zum Review-Befund B1: feuert `will-redirect` auch fuer UNTERRAHMEN, und was
 * steht dann in `e.isMainFrame`? Davon haengt ab, ob der Waechter aus #434 einem iframe
 * erlaubt, den SYSTEM-Browser zu oeffnen — eine Faehigkeit, die es vor #434 nicht gab.
 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')

let A = '', B = ''

const warte = ms => new Promise(r => setTimeout(r, ms))

function server(handler) {
  return new Promise(r => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port))
  })
}

app.commandLine.appendSwitch('disable-http2')
app.whenReady().then(async () => {
  B = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>FREMD</title>fremd')
  })
  A = await server((req, res) => {
    if (req.url === '/rahmenred') { res.writeHead(302, { Location: B + '/aus-dem-iframe' }); res.end(); return }
    if (req.url === '/topred') { res.writeHead(302, { Location: B + '/aus-dem-hauptrahmen' }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<title>EIGEN</title><body><iframe id=r src="about:blank" width=40 height=40></iframe></body>')
  })

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } })
  const kurz = u => String(u).split(A).join('{EIGEN}').split(B).join('{FREMD}')
  // Mitschreiber am POSITIONALEN Argument, mit Abweichungsmarke gegen `e.url` — dieselbe
  // Messung wie in navigation.js, hier nur je Zeile statt gezaehlt.
  for (const art of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    win.webContents.on(art, (e, urlVeraltet) => {
      const marke = e.url === urlVeraltet ? '' : `  [!! e.url WEICHT AB: ${kurz(e.url)}]`
      console.log(`  ${art.padEnd(20)} isMainFrame=${String(e.isMainFrame).padEnd(9)} ${kurz(urlVeraltet)}${marke}`)
    })
  }

  // Nachbau des Waechters aus main.js — **szenariospezifisch, nicht wortgleich**, und der
  // Unterschied gehoert benannt: die Herkunftsliste traegt hier NUR `A + '/'`, waehrend
  // `main.js` und `navigation.js` zusaetzlich `pathToFileURL(SETUP_HTML).href` fuehren. Diese
  // Sonde misst die RAHMENfrage (erreicht ein Unterrahmen den Waechter?), nicht die
  // Datei-Herkunft; setup.html kommt in ihrem Szenario nicht vor, und eine zweite Herkunft
  // ohne Fall waere Beiwerk, das man fuer gemessen haelt.
  //
  // Die ENTSCHEIDUNGEN sind dieselben: `e.url ?? urlVeraltet` (das Details-Ereignis ist der
  // zugesagte Weg, das positionale Argument `@deprecated` und nur der Rueckfall), Ausstieg
  // bei `isMainFrame === false`, und `externesZiel` nur bei `will-navigate`.
  const { eigeneHerkunft, externesZiel } = require(require('node:path').join(__dirname, '..', '..', '..', '..', 'electron', 'fenster.js'))
  const pruefen = extern => (e, urlVeraltet) => {
    const url = e.url ?? urlVeraltet
    if (e.isMainFrame === false) return
    if (eigeneHerkunft(url, [A + '/'])) return
    e.preventDefault()
    const ziel = extern ? externesZiel(url) : null
    console.log(`  >>> WAECHTER greift: ${ziel ? 'oeffnete den SYSTEM-BROWSER' : 'abgewiesen + protokolliert'} — ${kurz(url)}`)
  }
  win.webContents.on('will-navigate', pruefen(true))
  win.webContents.on('will-redirect', pruefen(false))

  await win.loadURL(A + '/')
  await warte(300)
  console.log('\n── iframe navigiert auf einen Pfad, der 302 auf FREMD umleitet')
  await win.webContents.executeJavaScript(
    "document.getElementById('r').src = " + JSON.stringify(A + '/rahmenred'), true)
  await warte(1200)

  console.log('\n── zum Vergleich: derselbe Redirect im HAUPTRAHMEN')
  await win.webContents.executeJavaScript('location.href = ' + JSON.stringify(A + '/topred'), true)
  await warte(1200)

  // Der Satz „…und damit shell.openExternal" stand hier bis zur dritten Reviewrunde und ist
  // seit der Umleitungs-Trennung FALSCH: `pruefen(false)` setzt `ziel = null`, ein
  // Unterrahmen-Redirect wuerde also abgewiesen, nicht in den Browser geschickt. Er galt der
  // ERSTEN Fassung, in der beide Ereignisse mit `externesZiel` bewertet wurden.
  console.log('\nFazit: `will-redirect` feuert mit isMainFrame=false, ein UNTERRAHMEN erreicht also')
  console.log('den Waechter. Ohne die Wache dagegen wuerde er ABGEWIESEN (nicht in den Browser')
  console.log('geschickt — `will-redirect` laeuft als `pruefen(false)`, ziel bleibt null): der')
  console.log('Rahmen folgte dem Redirect dann nicht mehr in sich selbst, was er vor #434 tat.')
  console.log('Die Wache ist damit heute Tiefenverteidigung, kein Riegel vor dem Systembrowser.')
  app.quit()
})
