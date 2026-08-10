'use strict'
/**
 * Ablauf beim Start: Fenster mit Statusseite -> Python-Umgebung pruefen (ggf. einrichten)
 * -> uvicorn starten -> auf "antwortet" warten -> das Web-Tool laden.
 *
 * Das Fenster kommt ZUERST, nicht der Server: die Einrichtung dauert beim ersten Mal Minuten,
 * und ein Nutzer, der so lange auf nichts schaut, haelt die App fuer kaputt.
 */
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron')
const path = require('path')
const backend = require('./backend')
const setup = require('./setup')
const protokoll = require('./protokoll')
const updater = require('./updater')
const { fensterOptionen, TITELLEISTE_HOEHE } = require('./fenster')

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

ipcMain.handle('einrichten', async () => {
  const r = await setup.einrichten(z => senden('log', z), s => senden('phase', { schritt: s }))
  if (r.ok) await serverStarten()
  else senden('fehler', r.fehler)
  return r
})

ipcMain.handle('logs', () => backend.log())

// Das Overlay ist eine feste Farbe im Hauptprozess und weiss nichts vom Thema der Seite.
// Ohne diesen Weg stuenden im Dunkelmodus schwarze Fensterknoepfe auf dunklem Grund.
ipcMain.handle('titelleisteFarbe', (_e, f) => {
  if (!win || win.isDestroyed() || process.platform === 'darwin') return
  win.setTitleBarOverlay({ color: f.color, symbolColor: f.symbolColor, height: TITELLEISTE_HOEHE })
})

// Anteil 0..1 zeigt den Balken, <0 raeumt ihn ab, >1 waere unbestimmt. Der Renderer
// schickt -1, sobald nichts mehr laeuft — sonst bleibt der Balken nach dem letzten
// Lauf am Symbol stehen und behauptet Arbeit, die es nicht gibt.
// 'error' faerbt ihn rot (Spec-Entscheidung 7). Nur dieser eine Modus wird durchgelassen:
// die Bruecke ist die Vertrauensgrenze, und mehr braucht der Renderer nicht.
ipcMain.handle('fortschritt', (_e, anteil, modus) => {
  if (!win || win.isDestroyed()) return
  const a = typeof anteil === 'number' ? anteil : -1
  if (modus === 'error') win.setProgressBar(a, { mode: 'error' })
  else win.setProgressBar(a)
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

app.whenReady().then(async () => {
  protokoll.kopf()
  fenster()
  await pruefen()
  // Update: Pruefen laeuft von selbst, Laden erst auf Klick. Der Zustand geht ins Fenster
  // (Einstellungen), Fehler zusaetzlich ins Protokoll — ein Popup, das man wegklickt und
  // nicht wiederfindet, gibt es bewusst nicht mehr.
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.logger = null
    aktualisierer = updater.erstellen({
      autoUpdater,
      version: app.getVersion(),
      plattform: process.platform,
      gepackt: app.isPackaged,
      appimage: !!process.env.APPIMAGE,
      aendert: z => {
        if (z.art === 'fehler') protokoll.schreiben(`Update-Pruefung fehlgeschlagen: ${z.text}`)
        if (win && !win.isDestroyed()) win.webContents.send('update', z)
      },
    })
    aktualisierer.pruefen()
  } catch (e) {
    protokoll.schreiben(`Update-Pruefung nicht moeglich: ${e && e.message || e}`)
  }
})

app.on('window-all-closed', () => { backend.stop(); app.quit() })
app.on('before-quit', () => backend.stop())
// Der Server ueberlebt einen harten Abbruch sonst als Waise mit belegter GPU.
process.on('exit', () => backend.stop())

app.on('activate', () => { if (!win) { fenster(); if (bereit) win.loadURL(backend.url()) } })
