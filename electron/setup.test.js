'use strict'
const Module = require('node:module')
const echt = Module._load
Module._load = (req, ...rest) =>
  req === 'electron' ? { app: { isPackaged: false, getPath: () => '/tmp' } } : echt(req, ...rest)

const test = require('node:test')
const assert = require('node:assert')
const { plan, spawnEnv, wingetFfmpeg } = require('./setup')

/** process.platform ist read-only — fuer den Test kurz umbiegen und sicher zuruecksetzen. */
function aufPlattform(p, fn) {
  const echt = process.platform
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  try { return fn() } finally {
    Object.defineProperty(process, 'platform', { value: echt, configurable: true })
  }
}

test('Windows: winget automatisch, torch aus dem CUDA-Index', () => {
  const p = plan('win32', '')
  assert.strictEqual(p.autoInstall, true)
  assert.match(p.torchIndex, /cu128/)
})

test('macOS OHNE Homebrew: kein Automatismus, torch vom PyPI-Standardrad (bringt MPS mit)', () => {
  const p = plan('darwin', '', 'arm64', false)
  assert.strictEqual(p.autoInstall, false)
  assert.strictEqual(p.installer, null)
  assert.strictEqual(p.torchIndex, null)
})

test('macOS ohne Homebrew nennt den Befehl, der Homebrew installiert — nicht `brew install`', () => {
  // Vorher stand hier `brew install python ffmpeg whisper-cpp`. Ohne Homebrew endet das mit
  // "command not found: brew" — ein Rat, der genau dem nicht hilft, der ihn braucht.
  const p = plan('darwin', '', 'arm64', false)
  assert.match(p.hinweis, /Homebrew/)
  assert.match(p.hinweis, /install\.sh/)
})

test('macOS MIT Homebrew installiert die App selbst (brew install braucht kein sudo)', () => {
  const p = plan('darwin', '', 'arm64', true)
  assert.strictEqual(p.autoInstall, true)
  assert.strictEqual(p.installer, 'brew')
  assert.strictEqual(p.hinweis, '')
  assert.strictEqual(p.torchIndex, null)
})

test('macOS arm64: whisper-cpp gehoert zu den Paketen (die schnelle Engine)', () => {
  assert.deepStrictEqual(plan('darwin', '', 'arm64', true).brewPakete,
    ['python', 'ffmpeg', 'whisper-cpp'])
})

test('Intel-macOS: kein whisper-cpp — dort rechnet ohnehin faster-whisper', () => {
  // webtool/device.py:asr_engine prueft arm64. Auf einem Intel-Mac waere das Paket ein
  // Download, der nichts bewirkt — python und ffmpeg braucht er aber weiter.
  assert.deepStrictEqual(plan('darwin', '', 'x64', true).brewPakete, ['python', 'ffmpeg'])
})

test('Linux bleibt beim Hinweis — apt/dnf/pacman brauchen echtes sudo', () => {
  assert.strictEqual(plan('linux', 'apt').installer, null)
  assert.match(plan('linux', 'apt').hinweis, /sudo/)
})

test('nutztWhisperCpp gilt nur fuer macOS auf arm64', () => {
  const { nutztWhisperCpp } = require('./setup')
  assert.strictEqual(nutztWhisperCpp('darwin', 'arm64'), true)
  assert.strictEqual(nutztWhisperCpp('darwin', 'x64'), false)
  assert.strictEqual(nutztWhisperCpp('win32', 'x64'), false)
  assert.strictEqual(nutztWhisperCpp('linux', 'arm64'), false)
})

test('Linux: erkannter Paketmanager steht im Hinweis', () => {
  assert.match(plan('linux', 'apt').hinweis, /apt install/)
  assert.match(plan('linux', 'dnf').hinweis, /dnf install/)
  assert.match(plan('linux', 'pacman').hinweis, /pacman -S/)
})

test('Linux ohne erkannten Paketmanager nennt trotzdem die Pakete', () => {
  const p = plan('linux', '')
  assert.strictEqual(p.autoInstall, false)
  assert.match(p.hinweis, /python3.*ffmpeg/s)
})

test('Linux zieht cu128 ohne vorherige NVIDIA-Erkennung', () => {
  assert.match(plan('linux', 'apt').torchIndex, /cu128/)
})

test('macOS: Homebrew-Pfade stehen VOR dem geerbten PATH (launchd kennt sie nicht)', () => {
  const pfad = aufPlattform('darwin', () => spawnEnv().PATH)
  assert.ok(pfad.startsWith('/opt/homebrew/bin:/usr/local/bin:'),
    `Homebrew muss vorne stehen, sonst gewinnt /usr/bin/python3 (3.9): ${pfad}`)
  assert.ok(pfad.endsWith(process.env.PATH || ''))     // geerbtes PATH bleibt dahinter
})

test('macOS: das Nutzer-bin ist dabei — dort landet claude', () => {
  const pfad = aufPlattform('darwin', () => spawnEnv().PATH)
  const nutzerBin = require('path').join(require('os').homedir(), '.local', 'bin')
  // Kein split(':') — auf einem Windows-Entwicklungsrechner enthaelt homedir() den
  // Laufwerksbuchstaben ("C:\Users\..."), der Trenner zerlegte den Pfad mitten durch.
  assert.ok(pfad.includes(nutzerBin),
    `~/.local/bin fehlt, shutil.which("claude") findet nichts: ${pfad}`)
})

test('backend.js startet uvicorn mit spawnEnv, nicht mit blankem process.env', () => {
  // Naht-Test: der Serverprozess vererbt seine Umgebung an jeden Job (jobs.py nutzt
  // {**os.environ}). Faellt spawnEnv hier weg, sucht claude/ffmpeg wieder im leeren PATH.
  const quelle = require('fs').readFileSync(require('path').join(__dirname, 'backend.js'), 'utf8')
  assert.match(quelle, /\.\.\.S\.spawnEnv\(\)/,
    'backend.js muss die uvicorn-Umgebung ueber setup.spawnEnv() bauen')
  assert.ok(!/env:\s*\{\s*\.\.\.process\.env/.test(quelle),
    'blankes ...process.env im uvicorn-env waere der alte, kaputte Zustand')
})

test('Windows und Linux erben die Umgebung unveraendert', () => {
  assert.strictEqual(aufPlattform('win32', spawnEnv), process.env)
  assert.strictEqual(aufPlattform('linux', spawnEnv), process.env)
})

test('ffmpeg wird im winget-Paketordner gefunden — dort steht es nie auf dem PATH', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'winget-'))
  const bin = path.join(wurzel, 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-9.0-full_build', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'ffmpeg.exe'), '')
  assert.strictEqual(wingetFfmpeg(wurzel), path.join(bin, 'ffmpeg.exe'))
})

test('fehlendes winget-Verzeichnis liefert Leerstring statt zu werfen', () => {
  assert.strictEqual(wingetFfmpeg('C:\gibt-es-nicht-42'), '')
})

/** Eine venv-Attrappe in einem Wegwerf-Ordner — NIE die echte .venv des Entwicklers. */
function leereVenv() {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'venv-'))
}

/** Eine requirements.txt zum Anfassen — die echte darf ein Test nicht veraendern. */
function reqDatei(inhalt) {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'req-')), 'requirements.txt')
  fs.writeFileSync(p, inhalt)
  return p
}

test('venv ohne Merker gilt als veraltet — jede heute bestehende Installation ist es (#181)', () => {
  const { paketeAktuell } = require('./setup')
  assert.strictEqual(paketeAktuell(leereVenv(), reqDatei('faster-whisper\n')), false)
})

test('eine GEAENDERTE requirements.txt entwertet den Merker — daran haengt der ganze Zweck', () => {
  const { paketeAktuell, stempelSchreiben } = require('./setup')
  const venv = leereVenv()
  const alt = reqDatei('faster-whisper\n'), neu = reqDatei('faster-whisper\npackaging\n')
  assert.strictEqual(stempelSchreiben(venv, alt), true)
  assert.strictEqual(paketeAktuell(venv, alt), true)
  // Der Kern: der Merker muss AN DER DATEI haengen. Einen Test, der nur den Merker verbiegt,
  // ueberlebt ein reqHash(), das eine Konstante liefert — und damit #181 unbemerkt wieder oeffnet.
  assert.strictEqual(paketeAktuell(venv, neu), false)
})

test('unlesbare requirements.txt heisst "nichts nachzuziehen", nicht "veraltet"', () => {
  const { paketeAktuell } = require('./setup')
  // Die Gegenrichtung waere eine Einrichtung, die bei jedem Start erscheint und nie gelingen kann.
  assert.strictEqual(paketeAktuell(leereVenv(), 'C:\gibt-es-nicht-42\requirements.txt'), true)
})

test('nur importierbar UND aktuell startet den Server — beides einzeln reicht nicht', () => {
  const { venvZustand } = require('./setup')
  // Diese Entscheidung liest main.js (`if (s.venv) serverStarten()`). Stuende sie nur inline
  // in status(), liesse `venv: importe` einen veralteten Stand durch, ohne dass ein Test murrt.
  assert.deepStrictEqual(venvZustand(true, true), { venv: true, venvVeraltet: false })
  assert.deepStrictEqual(venvZustand(true, false), { venv: false, venvVeraltet: true })
  // Ohne Importe ist die venv nicht "veraltet", sondern gar nicht da — sonst stuende auf der
  // Seite "vorhanden, aber nicht auf dem neuesten Stand" ueber einem leeren Ordner.
  assert.deepStrictEqual(venvZustand(false, false), { venv: false, venvVeraltet: false })
  assert.deepStrictEqual(venvZustand(false, true), { venv: false, venvVeraltet: false })
})

test('ein CPU-Rad nach dem Nachlauf wird erkannt — sonst waere die GPU still weg', () => {
  const { cudaVerloren } = require('./setup')
  const mitIndex = { torchIndex: 'https://download.pytorch.org/whl/cu128' }
  assert.strictEqual(cudaVerloren(mitIndex, 'CUDA=12.8'), false)
  assert.strictEqual(cudaVerloren(mitIndex, 'CUDA='), true)
  // Die Marke ist noetig, weil `ausgabe` stderr mitliest: eine Warnung beim Import macht
  // einen blossen Leerstring-Vergleich blind.
  assert.strictEqual(cudaVerloren(mitIndex, 'UserWarning: irgendwas\nCUDA='), true)
  // Keine verwertbare Antwort (torch laesst sich gar nicht importieren, `ausgabe` -> null):
  // nichts tun. Die Pruefung danach meldet die kaputte venv, ein GB-Download waere geraten.
  assert.strictEqual(cudaVerloren(mitIndex, null), false)
  // macOS hat keinen CUDA-Index; dort ist `torch.version.cuda` IMMER leer.
  assert.strictEqual(cudaVerloren({ torchIndex: null }, 'CUDA='), false)
})
