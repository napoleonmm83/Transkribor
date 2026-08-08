'use strict'
const Module = require('node:module')
const echt = Module._load
Module._load = (req, ...rest) =>
  req === 'electron' ? { app: { isPackaged: false, getPath: () => '/tmp' } } : echt(req, ...rest)

const test = require('node:test')
const assert = require('node:assert')
const { plan, spawnEnv } = require('./setup')

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

test('macOS: kein Automatismus, torch vom PyPI-Standardrad (bringt MPS mit)', () => {
  const p = plan('darwin', '')
  assert.strictEqual(p.autoInstall, false)
  assert.strictEqual(p.torchIndex, null)
  assert.match(p.hinweis, /brew install/)
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

test('Windows und Linux erben die Umgebung unveraendert', () => {
  assert.strictEqual(aufPlattform('win32', spawnEnv), process.env)
  assert.strictEqual(aufPlattform('linux', spawnEnv), process.env)
})
