'use strict'
/**
 * Erstinstallation der Python-Seite — das, was bisher im README stand und von Hand lief.
 *
 * Der Installer bringt Electron mit (~100 MB); die ML-Seite (torch cu128, Whisper, pyannote)
 * sind mehrere Gigabyte und kommen deshalb beim ersten Start dazu, sichtbar und abbrechbar,
 * statt den Download in ein 5-GB-Setup zu packen, das jeder Nutzer bei jedem Update erneut zieht.
 *
 * Fehlt Python oder ffmpeg, installieren wir sie ueber winget: das ist auf Windows 11 vorhanden
 * und die einzige Variante, die ohne Adminrechte und ohne eigenen Downloader auskommt.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const P = require('./paths')

const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
const MIN_PY = [3, 10]
const MAC_PFADE = '/opt/homebrew/bin:/usr/local/bin'   // Apple Silicon, dann Intel-Homebrew

/**
 * Umgebung fuer jeden spawn hier. Eine aus dem Finder gestartete .app erbt launchds PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), nicht den der Shell — per brew installiertes Python und
 * ffmpeg sind im Terminal da und fuer die App unsichtbar. VORangestellt, nicht angehaengt:
 * sonst gewinnt /usr/bin/python3 (macOS liefert 3.9, von MIN_PY abgelehnt) gegen brews Python.
 * Dieselbe Lektion wie POSIX_FFMPEG_DIRS in transcribe.py, nur eine Schicht frueher.
 */
function spawnEnv() {
  if (process.platform !== 'darwin') return process.env
  return { ...process.env, PATH: MAC_PFADE + ':' + (process.env.PATH || '') }
}

const LINUX_PAKETE = {
  apt: 'sudo apt install python3 python3-venv ffmpeg',
  dnf: 'sudo dnf install python3 ffmpeg',
  pacman: 'sudo pacman -S python ffmpeg',
}

/**
 * Was auf dieser Plattform zu tun ist — reine Funktion, damit die Entscheidung ohne
 * laufendes Electron pruefbar ist.
 *
 * Auf macOS/Linux installieren wir NICHT selbst: beides braeuchte sudo bzw. ein
 * vorhandenes Homebrew, und eine GUI-App, die dafuer einen Passwort-Prompt aufmacht,
 * ist zu viel Magie. Stattdessen zeigt die Statusseite den Befehl zum Kopieren.
 *
 * torch: macOS bekommt das normale PyPI-Rad — es bringt MPS mit, ein CUDA-Index
 * existiert dort gar nicht. Linux zieht cu128 ohne vorherige NVIDIA-Erkennung: die
 * Raeder installieren auch ohne Karte und fallen zur Laufzeit auf CPU zurueck.
 */
function plan(platform, paketmanager) {
  if (platform === 'win32') {
    return { torchIndex: TORCH_INDEX, autoInstall: true, hinweis: '' }
  }
  if (platform === 'darwin') {
    return {
      torchIndex: null,
      autoInstall: false,
      hinweis: 'Bitte einmalig installieren:  brew install python ffmpeg',
    }
  }
  const befehl = LINUX_PAKETE[paketmanager]
    || 'Bitte python3 (>= 3.10), python3-venv und ffmpeg ueber die Paketverwaltung installieren.'
  return { torchIndex: TORCH_INDEX, autoInstall: false, hinweis: `Bitte einmalig installieren:  ${befehl}` }
}

/** Welcher Paketmanager liegt auf diesem Linux? Leerstring, wenn keiner erkannt wird. */
async function paketmanager() {
  if (process.platform !== 'linux') return ''
  for (const p of ['apt', 'dnf', 'pacman']) {
    if (await ausgabe('which', [p])) return p
  }
  return ''
}

/** Kommando ausfuehren und jede Zeile melden. Loest mit dem Exitcode auf, wirft nie. */
function lauf(cmd, args, onLine, opts = {}) {
  return new Promise(resolve => {
    onLine(`> ${cmd} ${args.join(' ')}`)
    let proc
    try {
      proc = spawn(cmd, args, { windowsHide: true, env: spawnEnv(), ...opts })
    } catch (e) {
      onLine(`FEHLER: ${e.message}`)
      return resolve(-1)
    }
    const rest = { out: '', err: '' }
    const pump = (k, buf) => {
      rest[k] += buf.toString()
      const zeilen = rest[k].split(/\r?\n/)
      rest[k] = zeilen.pop()
      zeilen.filter(z => z.trim()).forEach(onLine)
    }
    proc.stdout.on('data', b => pump('out', b))
    proc.stderr.on('data', b => pump('err', b))
    proc.on('error', e => { onLine(`FEHLER: ${e.message}`); resolve(-1) })
    proc.on('close', code => {
      if (rest.out.trim()) onLine(rest.out.trim())
      if (rest.err.trim()) onLine(rest.err.trim())
      resolve(code === null ? -1 : code)
    })
  })
}

function ausgabe(cmd, args) {
  return new Promise(resolve => {
    let proc
    try { proc = spawn(cmd, args, { windowsHide: true, env: spawnEnv() }) } catch { return resolve(null) }
    let s = ''
    proc.stdout.on('data', b => { s += b })
    proc.stderr.on('data', b => { s += b })          // `python --version` schrieb frueher nach stderr
    proc.on('error', () => resolve(null))
    proc.on('close', code => resolve(code === 0 ? s.trim() : null))
  })
}

/** Erstes brauchbares System-Python. `py -3` zuerst: der Launcher findet auch Installationen, die nicht im PATH stehen. */
async function findePython() {
  const kandidaten = process.platform === 'win32'
    ? [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]]
  for (const [cmd, args] of kandidaten) {
    const v = await ausgabe(cmd, args)
    const m = v && v.match(/(\d+)\.(\d+)/)
    if (!m) continue
    const [maj, min] = [+m[1], +m[2]]
    if (maj > MIN_PY[0] || (maj === MIN_PY[0] && min >= MIN_PY[1])) {
      return { cmd, args: args.slice(0, -1), version: `${maj}.${min}` }
    }
  }
  return null
}

/** Die venv gilt erst als fertig, wenn sie wirklich importierbar ist — ein abgebrochener
 *  pip-Lauf hinterlaesst sonst eine halbe Umgebung, die beim naechsten Start "da" aussieht. */
async function venvVollstaendig() {
  const py = P.venvPython(P.venv)
  if (!P.exists(py)) return false
  const r = await ausgabe(py, ['-c', 'import torch, whisper, fastapi, uvicorn; print("ok")'])
  return r !== null && r.includes('ok')
}

async function status() {
  const py = await findePython()
  const ff = await ausgabe(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'])
  const pl = plan(process.platform, await paketmanager())
  return {
    python: py ? `Python ${py.version}` : '',
    ffmpeg: ff ? ff.split(/\r?\n/)[0].trim() : '',
    venv: await venvVollstaendig(),
    winget: process.platform === 'win32' ? (await ausgabe('winget', ['--version'])) || '' : '',
    venvPfad: P.venv,
    projektePfad: P.projekte,
    // Nicht leer heisst: hier installiert die App nichts selbst (macOS/Linux), der Nutzer
    // braucht den Befehl. Auf Windows bleibt es leer — winget uebernimmt.
    hinweis: (py && ff) ? '' : pl.hinweis,
  }
}

/**
 * Richtet alles Fehlende ein. `onLine` bekommt jede Log-Zeile, `onSchritt` den Fortschritt.
 * Gibt `{ok, fehler}` zurueck; wirft nicht, damit das Fenster den Fehler anzeigen kann.
 */
async function einrichten(onLine, onSchritt) {
  const schritte = []
  let py = await findePython()
  const pm = await paketmanager()
  const pl = plan(process.platform, pm)

  if (!py && pl.autoInstall) {
    onSchritt('Python installieren')
    onLine('Python nicht gefunden — installiere Python 3.13 ueber winget …')
    const code = await lauf('winget', ['install', '-e', '--id', 'Python.Python.3.13',
      '--accept-package-agreements', '--accept-source-agreements'], onLine)
    if (code !== 0) return { ok: false, fehler: 'Python konnte nicht installiert werden. Bitte von python.org installieren und Transkribor neu starten.' }
    py = await findePython()
    if (!py) return { ok: false, fehler: 'Python wurde installiert, ist aber noch nicht im PATH. Bitte Transkribor neu starten.' }
  }
  if (!py) return { ok: false, fehler: `Kein Python >= 3.10 gefunden. ${pl.hinweis}` }
  schritte.push(`Python: ${py.version}`)

  if (!(await ausgabe(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']))) {
    if (pl.autoInstall) {
      onSchritt('ffmpeg installieren')
      onLine('ffmpeg nicht gefunden — installiere ueber winget …')
      // Nicht abbrechen wenn es scheitert: transcribe.ensure_ffmpeg() findet auch den winget-Pfad
      // ausserhalb des PATH, und ohne ffmpeg laeuft immerhin noch das Bearbeiten vorhandener Transkripte.
      await lauf('winget', ['install', '-e', '--id', 'Gyan.FFmpeg',
        '--accept-package-agreements', '--accept-source-agreements'], onLine)
    } else {
      onLine(`ffmpeg nicht gefunden. ${pl.hinweis}`)
    }
  }

  if (!P.exists(P.venvPython(P.venv))) {
    onSchritt('Umgebung anlegen')
    fs.mkdirSync(path.dirname(P.venv), { recursive: true })
    const code = await lauf(py.cmd, [...py.args, '-m', 'venv', P.venv], onLine)
    if (code !== 0) return { ok: false, fehler: 'venv konnte nicht angelegt werden.' }
  }
  const vpy = P.venvPython(P.venv)

  onSchritt('pip aktualisieren')
  await lauf(vpy, ['-m', 'pip', 'install', '-U', 'pip'], onLine)

  onSchritt(pl.torchIndex ? 'PyTorch mit CUDA laden (mehrere GB, dauert)'
                          : 'PyTorch laden (mehrere GB, dauert)')
  const torchArgs = ['-m', 'pip', 'install', 'torch']
  if (pl.torchIndex) torchArgs.push('--index-url', pl.torchIndex)
  let code = await lauf(vpy, torchArgs, onLine)
  if (code !== 0 && pl.torchIndex) {
    onLine('CUDA-Variante fehlgeschlagen — versuche die CPU-Variante (Transkription wird dann langsam).')
    code = await lauf(vpy, ['-m', 'pip', 'install', 'torch'], onLine)
  }
  if (code !== 0) return { ok: false, fehler: 'PyTorch konnte nicht installiert werden.' }

  onSchritt('Whisper und Werkzeuge laden')
  code = await lauf(vpy, ['-m', 'pip', 'install', '-r', P.requirements], onLine)
  if (code !== 0) return { ok: false, fehler: 'Python-Pakete konnten nicht installiert werden.' }

  onSchritt('Prüfen')
  if (!(await venvVollstaendig())) return { ok: false, fehler: 'Einrichtung unvollstaendig — bitte erneut versuchen.' }
  onLine('Fertig. ' + schritte.join(' · '))
  return { ok: true }
}

module.exports = { status, einrichten, venvVollstaendig, findePython, plan, spawnEnv }
