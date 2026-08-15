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

test('venv ohne Merker gilt als veraltet — jede heute bestehende Installation ist es (#181)', () => {
  const { paketeAktuell } = require('./setup')
  assert.strictEqual(paketeAktuell(leereVenv()), false)
})

test('nach dem Vermerken gilt die venv als aktuell', () => {
  const { paketeAktuell, stempelSchreiben } = require('./setup')
  const venv = leereVenv()
  assert.strictEqual(stempelSchreiben(venv), true)
  // Rundlauf statt zweier getrennter Behauptungen: er pinnt Dateiname UND Hashquelle
  // zusammen. Schreibt die eine Seite woanders hin oder hasht etwas anderes, bricht er.
  assert.strictEqual(paketeAktuell(venv), true)
})

test('geaenderte requirements.txt entwertet den Merker — das ist der ganze Zweck', () => {
  const fs = require('node:fs'), path = require('node:path')
  const { paketeAktuell, stempelSchreiben } = require('./setup')
  const venv = leereVenv()
  stempelSchreiben(venv)
  // Den Merker verbiegen statt die echte requirements.txt anzufassen: dieselbe Wirkung
  // (Merker != heutiger Stand), ohne eine Datei des Repos im Test zu veraendern.
  fs.writeFileSync(path.join(venv, '.requirements'), 'stand-von-gestern')
  assert.strictEqual(paketeAktuell(venv), false)
})
