'use strict'
/**
 * Ablauf beim Start: Fenster mit Statusseite -> Python-Umgebung pruefen (ggf. einrichten)
 * -> uvicorn starten -> auf "antwortet" warten -> das Web-Tool laden.
 *
 * Das Fenster kommt ZUERST, nicht der Server: die Einrichtung dauert beim ersten Mal Minuten,
 * und ein Nutzer, der so lange auf nichts schaut, haelt die App fuer kaputt.
 */
const { app, BrowserWindow, ipcMain, shell, nativeTheme, net } = require('electron')
const path = require('path')
const backend = require('./backend')
const setup = require('./setup')
const P = require('./paths')
const protokoll = require('./protokoll')
const updater = require('./updater')
const { fensterOptionen, TITELLEISTE_HOEHE, farbeGueltig, fortschrittGueltig } = require('./fenster')

// Vor app.whenReady: HTTP/2 abschalten. autoUpdater.checkForUpdates() nutzt Electrons
// net = HTTP/2, und GitHub/Fastly verweigert dessen Stream sporadisch/persistent mit
// net::ERR_HTTP2_SERVER_REFUSED_STREAM — der Check scheitert vor jedem Versionsabgleich,
// Betroffene sehen nie ein Update (#150). HTTP/1.1 umgeht das (gh holt latest.yml so
// problemlos). Muss VOR dem ready-Event stehen. Einziger externer Chromium-Net-Zugriff
// der App ist dieser Check (uvicorn=localhost, yt-dlp=eigener Subprozess) → risikolos.
app.commandLine.appendSwitch('disable-http2')

let win = null
let aktualisierer = null
let bereit = false
// Der Start darf nur EINMAL laufen: whenReady() prueft, und die Statusseite fragt beim Laden
// selbst nochmal nach — ohne diesen Riegel starten zwei uvicorn-Prozesse auf zwei Ports.
let startLaeuft = null

/**
 * Alles, was ins Fenster geht, geht auch in die Datei — hier ist der Punkt, durch den BEIDE
 * Quellen laufen (setup.einrichten und backend.start). Nur 'log' und 'fehler' werden
 * mitgeschrieben: 'phase' und 'status' sind Anzeigezustand, keine Fehlerspur.
 */
function senden(kanal, nutzlast) {
  if (kanal === 'log') protokoll.schreiben(String(nutzlast))
  if (kanal === 'fehler') protokoll.schreiben(`FEHLER: ${nutzlast}`)
  if (win && !win.isDestroyed()) win.webContents.send(kanal, nutzlast)
}

function fenster() {
  const dunkel = nativeTheme.shouldUseDarkColors
  // fensterOptionen entscheidet die Startfarbe selbst -- dieselbe Quelle wie backgroundColor
  // unten, sonst weichen Fenster und Overlay beim Start voneinander ab.
  const opt = fensterOptionen(process.platform, dunkel)
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    // Electron malt diese Farbe VOR dem ersten Dokument-Zeichnen und an den Raendern beim
    // Vergroessern — ein fester Dunkelwert blitzt seit setup.html hell kann im Hellmodus auf.
    backgroundColor: dunkel ? '#0B0B0F' : '#FAFAFA',
    show: true,
    ...opt,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, 'setup.html'))
  // Externe Links (Key erstellen, Doku) gehoeren in den Browser, nicht in die App.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.on('closed', () => { win = null })
}

function serverStarten() {
  if (startLaeuft) return startLaeuft
  senden('phase', { schritt: 'Server starten' })
  startLaeuft = backend.start(z => senden('log', z)).then(
    () => { bereit = true; if (win) win.loadURL(backend.url()) },
    e => { startLaeuft = null; senden('fehler', String(e.message || e)) },   // Retry erlauben
  )
  return startLaeuft
}

/** Prueft die Umgebung; ist alles da, startet der Server sofort — sonst wartet die Seite auf den Klick. */
async function pruefen() {
  const s = await setup.status()
  // In die Datei, nicht nur ins Fenster: "Python nicht gefunden" ist ohne den Befund daneben
  // (was WURDE gefunden, wo liegt die venv) nicht diagnostizierbar.
  protokoll.befund('Umgebungsbefund', s)
  senden('status', s)
  if (s.venv) await serverStarten()
  return s
}

ipcMain.handle('status', () => pruefen())

// Der Weg vom "bei mir kommt ein Fehler" zu einer Datei, die man verschicken kann.
ipcMain.handle('protokollOeffnen', () => {
  protokoll.schreiben('— Protokoll vom Nutzer geoeffnet —')
  shell.showItemInFolder(protokoll.pfad())
  return protokoll.pfad()
})

/**
 * Der Weg zu den eigenen Daten (#218) — bis hierher gab es `showItemInFolder` genau einmal,
 * fuer die PROTOKOLLdatei, und keinen fuer die Arbeit des Nutzers.
 *
 * `P.projekte` ist dieselbe Quelle, aus der `backend.js` `TRANSKRIBOR_PROJEKTE` an den Server
 * reicht — die angezeigte Zeile (die vom Server kommt) und dieser Knopf koennen also nicht
 * auseinanderlaufen. **Kein Argument vom Renderer**, siehe preload.js.
 *
 * `openPath`, nicht `showItemInFolder`: letzteres zeigt eine DATEI in ihrem Elternordner: auf
 * ein Verzeichnis angewandt oeffnete es dessen Elternverzeichnis mit markiertem `projekte`.
 * Der leere String heisst Erfolg; alles andere ist die Fehlermeldung des Systems und wird
 * geworfen, damit der Toast im Browserfenster sie nennt statt still nichts zu tun.
 */
ipcMain.handle('projekteOeffnen', async () => {
  const fehler = await shell.openPath(P.projekte)
  if (fehler) throw new Error(fehler)
  return P.projekte
})

/**
 * Genau wie `startLaeuft`, und aus demselben Grund — nur ist der Schaden hier groesser:
 * ZWEI `pip install -r` in dasselbe `site-packages`. Die Instanzsperre unten deckt nur den Weg
 * ueber zwei Prozesse; ueber EINEN Prozess bleibt er sonst offen, und zwar alltaeglich: das
 * Standardmenue ist nur versteckt (`setMenuBarVisibility(false)`), seine Accelerators leben —
 * **Ctrl+R laedt `setup.html` mitten im Lauf neu**. Danach fragt die Seite `status()`, sieht
 * (Sondierungsimporte da, Merker noch nicht geschrieben) `venvVeraltet: true` und zeigt den
 * Knopf wieder aktiv. „Es passiert nichts, ich lade mal neu" waehrend eines 10–30-Minuten-
 * Downloads ist genau der Nutzer, fuer den diese Seite gebaut ist. Dasselbe erreicht der
 * `fehler`-Zweig im Renderer, der den Knopf wieder freigibt.
 *
 * Der Riegel gehoert deshalb in den Hauptprozess, nicht in den Renderer: `disabled` am Knopf
 * ueberlebt kein Neuladen.
 */
let einrichtungLaeuft = null
ipcMain.handle('einrichten', () => {
  if (einrichtungLaeuft) return einrichtungLaeuft
  einrichtungLaeuft = setup.einrichten(z => senden('log', z), s => senden('phase', { schritt: s }))
    .then(async r => {
      if (r.ok) await serverStarten()
      else senden('fehler', r.fehler)
      return r
    })
    // Erst danach freigeben — und in BEIDE Richtungen: bliebe der Merker nach einem Wurf
    // stehen, waere die Einrichtung fuer den Rest der Sitzung tot.
    .finally(() => { einrichtungLaeuft = null })
  return einrichtungLaeuft
})

ipcMain.handle('logs', () => backend.log())

// Das Overlay ist eine feste Farbe im Hauptprozess und weiss nichts vom Thema der Seite.
// Ohne diesen Weg stuenden im Dunkelmodus schwarze Fensterknoepfe auf dunklem Grund.
ipcMain.handle('titelleisteFarbe', (_e, f) => {
  if (!win || win.isDestroyed() || process.platform === 'darwin') return
  if (!farbeGueltig(f)) return          // ungeprueft wirft `f.color` bei null, s. fenster.js
  win.setTitleBarOverlay({ color: f.color, symbolColor: f.symbolColor, height: TITELLEISTE_HOEHE })
})

// Anteil 0..1 zeigt den Balken, <0 raeumt ihn ab, >1 waere unbestimmt. Der Renderer
// schickt -1, sobald nichts mehr laeuft — sonst bleibt der Balken nach dem letzten
// Lauf am Symbol stehen und behauptet Arbeit, die es nicht gibt.
// 'error' faerbt ihn rot (Spec-Entscheidung 7). Nur dieser eine Modus wird durchgelassen:
// die Bruecke ist die Vertrauensgrenze, und mehr braucht der Renderer nicht.
ipcMain.handle('fortschritt', (_e, anteil, modus) => {
  if (!win || win.isDestroyed()) return
  if (!fortschrittGueltig(anteil)) return   // >1 waere ein unbestimmter Dauerbalken, s. fenster.js
  if (modus === 'error') win.setProgressBar(anteil, { mode: 'error' })
  else win.setProgressBar(anteil)
})

ipcMain.handle('update:status', () => aktualisierer && aktualisierer.zustand())
ipcMain.handle('update:pruefen', () => aktualisierer && aktualisierer.pruefen())
ipcMain.handle('update:laden', () => aktualisierer && aktualisierer.laden())
ipcMain.handle('update:installieren', () => {
  // Erst wenn der Download wirklich fertig ist: sonst laeuft die App mit totem Backend
  // weiter, ohne dass quitAndInstall() je zum Neustart kommt.
  if (!aktualisierer || aktualisierer.zustand().art !== 'bereit') return
  backend.stop()          // sonst bleibt uvicorn als Waise mit belegter GPU zurueck
  aktualisierer.installieren()
})

/**
 * Nur EINE Instanz — und zwar wegen der venv, nicht wegen des Fensters (#231).
 *
 * Zwei Electron-Prozesse teilen sich dasselbe `userData` und damit dieselbe venv. Ein Klick
 * auf „Jetzt einrichten" in beiden Fenstern schickt zwei `pip install -r` in dasselbe
 * `site-packages`; pip hat dafuer keinen Schutz (das Lock in webtool/sperre.py deckt die
 * yt-dlp-Selbstaktualisierung ab, nicht diesen Weg). `startLaeuft` weiter unten ist KEIN
 * Ersatz: es gilt innerhalb eines Prozesses.
 *
 * Der Fall existierte vorher schon, war aber nur im allerersten Start erreichbar — ein
 * Zeitfenster von Minuten, einmal pro Installation. Seit dem requirements-Merker (#181)
 * erscheint die Einrichtungsseite nach JEDEM Update, das Pakete bringt; das Fenster geht
 * damit regelmaessig wieder auf. Das ist die Frage „was erlaubt die Reparatur NEU?":
 * kein neuer Fehler, aber eine deutlich groessere Trefferflaeche fuer einen alten.
 *
 * Nebenbei geschlossen: zwei uvicorn auf zwei Ports.
 *
 * **`return`, nicht `else`.** `app.quit()` ist asynchron — es feuert `before-quit`/`will-quit`
 * und sagt NICHT zu, dass `ready` danach ausbleibt. Kaeme es doch, taete die sterbende Instanz
 * genau das, was die Sperre verhindern soll: `fenster()`, `pruefen()` → `setup.status()`
 * (spawnt Python und winget) und bei fertiger venv `serverStarten()` — ein zweiter uvicorn.
 * Deshalb haengt `starten` im `else`, nicht am Modulrumpf: die Zusage ist baulich gedeckt
 * statt zeitlich gehofft — der lokale Nachweis „ein Fenster statt zwei" haette ein Fenster,
 * das 200 ms lebt, ohnehin nicht gesehen.
 *
 * Hier stand kurz `app.quit(); return` auf Modulebene. Node nimmt das in CommonJS an (der
 * Modulrumpf IST eine Funktion, nachgemessen), aber **Biome bricht die Datei damit GANZ ab**
 * („Illegal return statement outside of a function" → „formatting aborted due to parsing
 * errors", selbst nachgefahren). Nicht die eine Zeile faellt dann aus der statischen Analyse,
 * sondern `main.js` vollstaendig — und still. Zu teuer fuer ein gespartes Einruecken; die
 * benannte Funktion kostet dasselbe und liest sich besser.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Der zweite Doppelklick ist keine Fehlbedienung, sondern die Suche nach dem Fenster —
    // kommentarlos zu sterben laese ihn wie eine kaputte App aussehen. Steht noch kein Fenster
    // (die Millisekunden zwischen Sperre und `fenster()`), bleibt es dabei: `app.focus()`
    // haette dann nichts zu holen.
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(starten)
}

/** Der eigentliche Start — nur die Instanz, die die Sperre haelt, ruft ihn (Funktion statt
 *  Rueckgabe an Ort und Stelle, damit der Rumpf seine Einrueckung behaelt). */
async function starten() {
  protokoll.kopf()
  fenster()
  await pruefen()
  // Update: Pruefen laeuft von selbst, Laden erst auf Klick. Der Zustand geht ins Fenster
  // (Einstellungen), Fehler zusaetzlich ins Protokoll — ein Popup, das man wegklickt und
  // nicht wiederfindet, gibt es bewusst nicht mehr.
  try {
    const { autoUpdater } = require('electron-updater')
    const paket = require('../package.json')
    const macUrls = updater.macUrls(paket)
    autoUpdater.logger = null
    aktualisierer = updater.erstellen({
      autoUpdater,
      version: app.getVersion(),
      plattform: process.platform,
      gepackt: app.isPackaged,
      appimage: !!process.env.APPIMAGE,
      // Mac prueft manuell per latest-mac.yml (Auto-Update ohne Notarisierung tot); Win/Linux
      // ignorieren hole/openExternal/URLs — sie wandern nur in den Mac-Zweig von erstellen().
      hole: fetch,
      openExternal: shell.openExternal,
      feedUrl: macUrls && macUrls.feed,
      releaseUrl: macUrls && macUrls.release,
      aendert: z => {
        if (z.art === 'fehler') protokoll.schreiben(`Update-Pruefung fehlgeschlagen: ${z.text}`)
        if (win && !win.isDestroyed()) win.webContents.send('update', z)
      },
    })
    aktualisierer.pruefen()
    // Danach alle 6 h leise nachsehen. Ohne das erfaehrt eine App, die tagelang offen bleibt
    // (bei langen Transkriptionen der Normalfall), erst beim naechsten Start von einer neuen
    // Version. Eine Runde kostet einen GET auf latest.yml (~1 KB); geladen wird weiterhin
    // erst auf Klick (autoDownload=false).
    const zeitgeber = setInterval(() => {
      // Offline ergaebe nur eine Fehlerzeile im Protokoll und "Pruefung fehlgeschlagen" in
      // der Fusszeile — beides falsch, solange niemand danach gefragt hat.
      if (!net.isOnline()) return
      if (!updater.sollPruefen(aktualisierer.zustand())) return
      aktualisierer.pruefen()
    }, 6 * 60 * 60 * 1000)
    // Ein Hintergrund-Zeitgeber darf die App nie am Leben halten.
    zeitgeber.unref()
  } catch (e) {
    protokoll.schreiben(`Update-Pruefung nicht moeglich: ${e && e.message || e}`)
  }
}

app.on('window-all-closed', () => { backend.stop(); app.quit() })
app.on('before-quit', () => backend.stop())
// Der Server ueberlebt einen harten Abbruch sonst als Waise mit belegter GPU.
process.on('exit', () => backend.stop())

app.on('activate', () => { if (!win) { fenster(); if (bereit) win.loadURL(backend.url()) } })
