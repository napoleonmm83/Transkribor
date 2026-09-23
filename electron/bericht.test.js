'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { letzteZeilen, kopf, kappen, MAX_ZEILE, ZEILEN } = require('./bericht')

test('letzteZeilen nimmt die juengsten 60 in Originalreihenfolge', () => {
  const zeilen = Array.from({ length: 70 }, (_, i) => `FEHLER ${i}`).join('\n')
  const aus = letzteZeilen(zeilen)
  assert.equal(aus.length, ZEILEN)
  assert.equal(aus[0], 'FEHLER 10')
  assert.equal(aus.at(-1), 'FEHLER 69')
})

test('leere Zeilen, PATH und erfolgreiche Zugriffe bleiben draussen; Fehlschlaege bleiben', () => {
  assert.deepEqual(letzteZeilen('PATH : geheim\n\nINFO - "GET /api/projects HTTP/1.1" 200 OK\n'
    + 'INFO - "GET /api/projects HTTP/1.1" 500 Fehler\nFEHLER echt\n'),
  ['INFO - "GET /api/projects HTTP/1.1" 500 Fehler', 'FEHLER echt'])
})

test('Abweisungsflut verdraengt den eigentlichen Fehler nicht', () => {
  const text = 'FEHLER echt\n' + Array.from({ length: 20 }, (_, i) =>
    `Externer Link abgewiesen (x): ${i}`).join('\n')
  const aus = letzteZeilen(text)
  assert.deepEqual(aus, ['FEHLER echt', 'Externer Link abgewiesen (x): 19'])
})

test('file:-Pfad wird aus einer Abweisung entfernt', () => {
  const aus = letzteZeilen('Navigation abgewiesen (x): file:///C:/Users/Ada/Interview.mp3')
  assert.equal(aus.length, 1)
  assert.ok(!aus[0].includes('Interview.mp3'))
  assert.ok(aus[0].includes('Pfad entfernt'))
})

test('Kappung misst kodierte Zeichen, markiert sie und trennt keine Emojis', () => {
  const z = kappen('😀'.repeat(200))
  assert.ok(encodeURIComponent(z).length <= MAX_ZEILE)
  assert.ok(z.endsWith(' […]'))
  assert.doesNotThrow(() => encodeURIComponent(z))
})

test('Kopf nennt Fassung, Plattform und Verpackung', () => {
  const aus = kopf({ version: '1.2.3', plattform: 'win32', arch: 'x64', electron: '44', node: '22', gepackt: true })
  assert.ok(aus.join(' ').includes('1.2.3'))
  assert.ok(aus.join(' ').includes('win32 x64'))
  assert.ok(aus.join(' ').includes('true'))
})