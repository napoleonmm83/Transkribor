'use strict'
/**
 * Zweite Sonde zu #518 — die Messungen, die `check.js` NICHT leisten kann.
 *
 * `check.js` faehrt `setup.html` und zwei nackte HTTP-Seiten. Zwei Fragen bleiben damit offen,
 * und beide haben in den Reviews dieses PR einen Befund geliefert:
 *
 *   --oberflaeche  Was loest die ECHTE, gebaute Oberflaeche aus? (Messung 5 der Spec)
 *                  Antwort: eine 15. Art, `background-sync`, ausgeloest von einem
 *                  gewoehnlichen `fetch()` — sie erscheint NIE beim Request-Handler und steht
 *                  in KEINER der beiden Unionen der Typdeklaration.
 *   --rahmen       Was kommt aus einem UNTERRAHMEN? (Befund 3 des gegnerischen Pruefers)
 *                  Antwort: das Startdokument eines Rahmens traegt `requestingUrl=""` und die
 *                  Herkunft des ELTERN — mit zwei Gruenden im Protokoll hiesse das „fremde
 *                  Herkunft: media von <unsere eigene Adresse>", also eine Luege.
 *
 * **Der Server braucht keine venv.** Die Grenze der ersten Sonde („die React-Oberflaeche
 * startet in diesem Klon nicht, weil die venv kein torch hat") galt dem PYTHON-Server, nicht
 * der Oberflaeche: `webtool/static` ist ein fertiges Bundle und laeuft ueber jeden Server, der
 * einen SPA-Rueckfall kann. `/api/*` beantwortet diese Sonde mit 404 — die Oberflaeche zeigt
 * dann ihren Fehlerzustand, faehrt aber `AppShell` und damit `useOsFortschritt` an.
 *
 * Der Handler entscheidet und protokolliert wortgleich wie `electron/main.js` — eine Sonde,
 * die einen ANDEREN Waechter misst als den ausgelieferten, belegt die falsche Sache.
 *
 *   npx electron docs/superpowers/specs/2026-09-02-berechtigungs-check-sonde/oberflaeche.js --oberflaeche
 *   npx electron docs/superpowers/specs/2026-09-02-berechtigungs-check-sonde/oberflaeche.js --rahmen
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..', '..', '..')
const PRELOAD = path.join(REPO, 'electron', 'preload.js')
const STATIC = path.join(REPO, 'webtool', 'static')
const { eigeneHerkunft } = require(path.join(REPO, 'electron', 'fenster.js'))
const RAHMEN = process.argv.includes('--rahmen')

app.setPath('userData', path.join(os.tmpdir(), `sonde-518b-${process.pid}`))

const BERECHTIGUNGEN_ERLAUBT = new Set(['notifications', 'clipboard-sanitized-write'])
const TYPEN = ['application/javascript', 'text/css', 'image/svg+xml', 'font/woff2', 'text/html']
const nachEndung = p => ({ '.js': TYPEN[0], '.css': TYPEN[1], '.svg': TYPEN[2], '.woff2': TYPEN[3] })[path.extname(p)] || TYPEN[4]

const spur = []
const notiz = z => { spur.push(z); console.log(z) }
// Wortgleich mit `main.js:nurHerkunft` — sonst zeigt die Sonde eine ANDERE Zeile als die, die
// im Protokoll des Nutzers stuende: `about:srcdoc` hat die Herkunft 'null', und dort sagt das
// Schema mehr als nichts.
const nurHerkunft = url => {
  try { const u = new URL(String(url)); return u.origin === 'null' ? u.protocol : u.origin }
  catch { return '(unlesbare Herkunft)' }
}

/** Liefert die gebaute Oberflaeche aus — mit SPA-Rueckfall, und `/api/*` als 404. */
function oberflaechenServer() {
  return new Promise(r => {
    const s = http.createServer((req, res) => {
      const weg = decodeURIComponent(req.url.split('?')[0])
      if (weg.startsWith('/api/')) { res.writeHead(404); return res.end('kein Backend in dieser Sonde') }
      const datei = path.join(STATIC, weg)
      const echt = datei.startsWith(STATIC) && fs.existsSync(datei) && fs.statSync(datei).isFile()
        ? datei : path.join(STATIC, 'index.html')
      res.writeHead(200, { 'Content-Type': nachEndung(echt) })
      res.end(fs.readFileSync(echt))
    })
    s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port))
  })
}

/** Eine Seite mit drei Unterrahmen: fremde Herkunft, `data:` und `srcdoc`. */
function rahmenServer(fremd) {
  return new Promise(r => {
    const s = http.createServer((req, res) => {
      const kind = '<!doctype html><meta charset=utf-8><script>'
        + 'navigator.permissions.query({name:"notifications"}).catch(()=>{});'
        + 'navigator.permissions.query({name:"geolocation"}).catch(()=>{})</script>'
      if (req.url.startsWith('/kind')) {
        res.writeHead(200, { 'Content-Type': TYPEN[4] }); return res.end(kind)
      }
      res.writeHead(200, { 'Content-Type': TYPEN[4] })
      res.end('<!doctype html><meta charset=utf-8><title>ELTERN</title><body>'
        + `<iframe src="${fremd}/kind"></iframe>`
        + '<iframe src="data:text/html,<script>navigator.permissions.query({name:%22notifications%22})</script>"></iframe>'
        + `<iframe srcdoc='${kind.replace(/'/g, '&apos;')}'></iframe>`)
    })
    s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port))
  })
}

const warte = ms => new Promise(r => setTimeout(r, ms))

async function lauf() {
  const FREMD = await rahmenServer('about:blank')
  const EIGEN = RAHMEN ? await rahmenServer(FREMD) : await oberflaechenServer()
  await app.whenReady()

  const win = new BrowserWindow({
    width: 1100, height: 800, show: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  })
  const eigene = [EIGEN]
  // Wortgleich mit `main.js` — Entscheidung, Marker, drei Gruende.
  const gemeldet = new Set()
  const protokoll = []
  win.webContents.session.setPermissionCheckHandler((_inhalt, art, herkunft, angaben) => {
    const eigen = eigeneHerkunft(angaben?.requestingUrl, eigene)
    const erlaubt = eigen && BERECHTIGUNGEN_ERLAUBT.has(art)
    notiz(`CHECK ${art} :: eigen=${eigen} -> ${erlaubt} :: herkunft="${herkunft}"`
      + ` :: requestingUrl="${angaben?.requestingUrl}" :: isMainFrame=${angaben?.isMainFrame}`)
    const wer = angaben?.requestingUrl || herkunft
    const marke = `${art}|${eigen}`
    if (!erlaubt && wer && !gemeldet.has(marke)) {
      gemeldet.add(marke)
      protokoll.push(`Berechtigungspruefung abgewiesen `
        + `(${eigen ? 'nicht in der Weissliste' : angaben?.requestingUrl ? 'fremde Herkunft' : 'ohne Seitenangabe'}): `
        + `${eigen ? art : `${art} von ${nurHerkunft(wer)}`}`)
    }
    return erlaubt
  })
  win.webContents.session.setPermissionRequestHandler((_i, art, erlauben) => {
    notiz(`REQUEST ${art}`); erlauben(false)
  })

  notiz(`===== ${RAHMEN ? 'Unterrahmen' : 'gebaute Oberflaeche'} — ${EIGEN} =====`)
  await win.loadURL(EIGEN)
  await warte(8000)
  const nachLaden = spur.filter(z => z.startsWith('CHECK')).length
  notiz(`\n--- nach dem Laden: ${nachLaden} Pruefungen ---`)
  await warte(20000)
  notiz(`--- nach 20 s Leerlauf: ${spur.filter(z => z.startsWith('CHECK')).length - nachLaden} weitere ---`)

  notiz('\n===== Protokollzeilen, die `main.js` geschrieben haette =====')
  protokoll.forEach(z => notiz(z))
  const arten = [...new Set(spur.filter(z => z.startsWith('CHECK')).map(z => z.split(' ')[1]))].sort()
  notiz(`\n===== ${arten.length} Arten: ${arten.join(', ')} =====`)
  app.quit()
}

lauf().catch(e => { console.error('SONDE GESCHEITERT:', e); app.exit(1) })
