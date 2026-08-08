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
  try { fsEcht.unlinkSync(protokoll.pfad() + '.1') } catch {}
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
