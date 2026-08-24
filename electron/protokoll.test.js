'use strict'
const fsEcht = require('fs')
const osEcht = require('os')
const pathEcht = require('path')

// Eigenes Datenverzeichnis, bevor paths.js es beim Require einliest.
const DATEN = fsEcht.mkdtempSync(pathEcht.join(osEcht.tmpdir(), 'transkribor-log-'))
const Module = require('node:module')
const echt = Module._load
Module._load = (req, ...rest) =>
  req === 'electron' ? { app: { isPackaged: false, getPath: () => DATEN } } : echt(req, ...rest)

const test = require('node:test')
const assert = require('node:assert')
const protokoll = require('./protokoll')

function frisch() {
  try { fsEcht.unlinkSync(protokoll.pfad()) } catch {}
  for (let i = 1; i <= protokoll.MAX_GENERATIONEN + 1; i++) {
    try { fsEcht.unlinkSync(`${protokoll.pfad()}.${i}`) } catch {}
  }
}

test('schreibt in eine Datei im Datenverzeichnis', () => {
  frisch()
  protokoll.schreiben('erste Zeile')
  protokoll.schreiben('zweite Zeile')
  const inhalt = fsEcht.readFileSync(protokoll.pfad(), 'utf8')
  assert.match(inhalt, /erste Zeile/)
  assert.match(inhalt, /zweite Zeile/)
  // Zeitstempel davor, sonst ist die Reihenfolge spaeter nicht rekonstruierbar
  assert.match(inhalt, /^\[\d{4}-\d{2}-\d{2}T/m)
})

test('rotiert ueber der Groessengrenze statt die Platte zu fuellen', () => {
  frisch()
  fsEcht.writeFileSync(protokoll.pfad(), 'x'.repeat(protokoll.MAX + 1))
  protokoll.schreiben('nach der Rotation')
  assert.ok(fsEcht.existsSync(protokoll.pfad() + '.1'), 'alte Generation muss erhalten bleiben')
  const neu = fsEcht.readFileSync(protokoll.pfad(), 'utf8')
  assert.match(neu, /nach der Rotation/)
  assert.ok(neu.length < 1000, 'die neue Datei faengt leer an')
})

test('rotiert ueber mehrere Generationen bis MAX_GENERATIONEN (#371)', () => {
  frisch()
  // Schritt 1: Erstes Log füllen und rotieren -> .1 entsteht
  fsEcht.writeFileSync(protokoll.pfad(), 'Generation 1')
  fsEcht.writeFileSync(protokoll.pfad(), 'x'.repeat(protokoll.MAX + 1))
  protokoll.schreiben('Start Gen 2')
  assert.ok(fsEcht.existsSync(protokoll.pfad() + '.1'))

  // Schritt 2: Zweites Log füllen und rotieren -> .2 und .1 entstehen
  fsEcht.writeFileSync(protokoll.pfad(), 'x'.repeat(protokoll.MAX + 1))
  protokoll.schreiben('Start Gen 3')
  assert.ok(fsEcht.existsSync(protokoll.pfad() + '.2'))
  assert.ok(fsEcht.existsSync(protokoll.pfad() + '.1'))

  // Schritt 3: Drittes Log füllen und rotieren -> .3, .2, .1 entstehen
  fsEcht.writeFileSync(protokoll.pfad(), 'x'.repeat(protokoll.MAX + 1))
  protokoll.schreiben('Start Gen 4')
  assert.ok(fsEcht.existsSync(protokoll.pfad() + '.3'))
  assert.ok(fsEcht.existsSync(protokoll.pfad() + '.2'))
  assert.ok(fsEcht.existsSync(protokoll.pfad() + '.1'))

  // Schritt 4: Viertes Log füllen -> .4 existiert nicht, da MAX_GENERATIONEN = 3 gedeckelt ist
  fsEcht.writeFileSync(protokoll.pfad(), 'x'.repeat(protokoll.MAX + 1))
  protokoll.schreiben('Start Gen 5')
  assert.ok(!fsEcht.existsSync(protokoll.pfad() + '.4'), 'Generation .4 darf nicht angelegt werden')
})

test('maskiert sensible API-Keys und Token (#371)', () => {
  frisch()
  const textMitKeys = 'Fehler mit OpenAI sk-proj-1234567890abcdef1234 und Anthropic sk-ant-api03-abcdef1234567890 sowie Google AIzaSyD1234567890abcdef1234567890 sowie Groq gsk_1234567890abcdef1234567890 und HF hf_1234567890abcdef1234567890'
  protokoll.schreiben(textMitKeys)
  const inhalt = fsEcht.readFileSync(protokoll.pfad(), 'utf8')
  assert.doesNotMatch(inhalt, /sk-proj-1234567890/)
  assert.doesNotMatch(inhalt, /sk-ant-api03/)
  assert.doesNotMatch(inhalt, /AIzaSyD1234567890/)
  assert.doesNotMatch(inhalt, /gsk_1234567890/)
  assert.doesNotMatch(inhalt, /hf_1234567890/)
  assert.match(inhalt, /\*\*\*\[API-KEY\]\*\*\*/)
})

test('der Kopf nennt PATH — der teuerste Fehler des Projekts steckte dort', () => {
  frisch()
  protokoll.kopf()
  const inhalt = fsEcht.readFileSync(protokoll.pfad(), 'utf8')
  assert.match(inhalt, /PATH\s+:/)
  assert.match(inhalt, /Plattform\s+:/)
  assert.match(inhalt, /venv\s+:/)
})

test('befund gibt ein Objekt lesbar aus, auch mit leeren Werten', () => {
  frisch()
  protokoll.befund('Umgebung', { python: 'Python 3.13', ffmpeg: '', venv: true })
  const inhalt = fsEcht.readFileSync(protokoll.pfad(), 'utf8')
  assert.match(inhalt, /Umgebung:/)
  assert.match(inhalt, /python = Python 3\.13/)
  assert.match(inhalt, /ffmpeg = \(leer\)/)      // leer != fehlend, das muss unterscheidbar bleiben
})

test('ein Schreibfehler bringt die App nicht zum Absturz', () => {
  frisch()
  const echteAppend = fsEcht.appendFileSync
  fsEcht.appendFileSync = () => { throw new Error('Platte voll') }
  try {
    assert.doesNotThrow(() => protokoll.schreiben('darf nicht werfen'))
  } finally {
    fsEcht.appendFileSync = echteAppend
  }
})
