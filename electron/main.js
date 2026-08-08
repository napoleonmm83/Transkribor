'use strict'
/**
 * Ablauf beim Start: Fenster mit Statusseite -> Python-Umgebung pruefen (ggf. einrichten)
 * -> uvicorn starten -> auf "antwortet" warten -> das Web-Tool laden.
 *
 * Das Fenster kommt ZUERST, nicht der Server: die Einrichtung dauert beim ersten Mal Minuten,
 * und ein Nutzer, der so lange auf nichts schaut, haelt die App fuer kaputt.
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const backend = require('./backend')
const setup = require('./setup')
const protokoll = require('./protokoll')

let win = null
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
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#0b0b0c',
    show: true,
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

app.whenReady().then(async () => {
  protokoll.kopf()
  fenster()
  await pruefen()
  if (app.isPackaged) {
    // Erst nach dem Start pruefen: ein Update-Fehler (kein Netz, privates Repo) darf den
    // Start nie blockieren, deshalb bewusst verschluckt statt als Dialog.
    try {
      const { autoUpdater } = require('electron-updater')
      autoUpdater.logger = null
      autoUpdater.on('update-downloaded', async info => {
        const a = await dialog.showMessageBox(win, {
          type: 'info', buttons: ['Jetzt neu starten', 'Später'], defaultId: 0,
          message: `Transkribor ${info.version} ist bereit.`,
          detail: 'Die neue Version wird beim Neustart installiert.',
        })
        if (a.response === 0) { backend.stop(); autoUpdater.quitAndInstall() }
      })
      autoUpdater.checkForUpdates().catch(() => {})
    } catch { /* ohne Update-Feed laeuft die App normal weiter */ }
  }
})

app.on('window-all-closed', () => { backend.stop(); app.quit() })
app.on('before-quit', () => backend.stop())
// Der Server ueberlebt einen harten Abbruch sonst als Waise mit belegter GPU.
process.on('exit', () => backend.stop())

app.on('activate', () => { if (!win) { fenster(); if (bereit) win.loadURL(backend.url()) } })
