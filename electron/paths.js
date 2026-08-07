'use strict'
/**
 * Wo liegt was — der einzige Unterschied zwischen "aus dem Repo gestartet" und "installiert".
 *
 * Installiert darf NICHTS neben die .exe geschrieben werden (Program Files ist schreibgeschuetzt,
 * und ein Update ersetzt das Verzeichnis): venv, Projekte und Einstellungen wandern deshalb
 * immer nach userData. Im Repo bleibt alles dort, wo webtool.ps1 es auch erwartet — sonst
 * sieht die Entwicklung andere Daten als der Installer.
 */
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

const istPaket = app.isPackaged
// Gepackt liegt der Python-Teil unter resources/py (extraResources in package.json).
const pyRoot = istPaket ? path.join(process.resourcesPath, 'py') : path.join(__dirname, '..')
const daten = app.getPath('userData')

module.exports = {
  istPaket,
  pyRoot,
  daten,
  // Im Repo die vorhandene .venv weiterverwenden — wer schon eingerichtet hat, soll nicht 5 GB neu laden.
  venv: istPaket ? path.join(daten, 'venv') : path.join(pyRoot, '.venv'),
  projekte: istPaket ? path.join(daten, 'projekte') : path.join(pyRoot, 'projekte'),
  envDatei: istPaket ? path.join(daten, '.env') : path.join(pyRoot, '.env'),
  requirements: path.join(pyRoot, 'requirements.txt'),
  /** python.exe der venv (existiert erst nach der Einrichtung). */
  venvPython(venvDir) {
    return process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python')
  },
  exists: p => { try { return fs.existsSync(p) } catch { return false } },
}
