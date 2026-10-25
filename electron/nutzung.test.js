'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const n = require('./nutzung')

const temps = []
function schalter(inhalt) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nutzung-'))
  temps.push(d)
  const p = n.pfad(d)
  if (inhalt !== undefined) fs.writeFileSync(p, typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt))
  return p
}
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }) })

const LAST = n.nutzlast({ kennung: 'abc-123', version: '0.60.1', plattform: 'win32', arch: 'x64' })
const JETZT = new Date(2026, 9, 25, 12)
function holer(status = 200) {
  const aufrufe = []
  const f = async (url, opt) => { aufrufe.push({ url, opt }); return { ok: status >= 200 && status < 300, status } }
  f.aufrufe = aufrufe
  return f
}

test('Nutzlast hat GENAU drei Felder und traegt die Rohkennung nicht', () => {
  assert.deepStrictEqual(Object.keys(LAST).sort(), ['geraet', 'plattform', 'version'])
  assert.match(LAST.geraet, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(LAST).includes('abc-123'))
  assert.strictEqual(LAST.plattform, 'win32-x64')
})

test('Fingerabdruck ist stabil und gesalzen', () => {
  assert.strictEqual(n.fingerabdruck('x'), n.fingerabdruck('x'))
  assert.notStrictEqual(n.fingerabdruck('x'), n.fingerabdruck('y'))
  const ungesalzen = require('crypto').createHash('sha256').update('x').digest('hex')
  assert.notStrictEqual(n.fingerabdruck('x'), ungesalzen)
})

test('ohne Kennung keine Nutzlast', () => {
  assert.strictEqual(n.nutzlast({ kennung: null, version: '1', plattform: 'linux', arch: 'x64' }), null)
})

test('Schalter: fehlend, kaputt, BOM, nicht-true', () => {
  assert.strictEqual(n.lesen(schalter()).an, false)
  assert.strictEqual(n.lesen(schalter('{kaputt')).an, false)
  assert.strictEqual(n.lesen(schalter('﻿{"an":true}')).an, true)
  assert.strictEqual(n.lesen(schalter({ an: 'true' })).an, false)
})

test('AUS sendet nichts', async () => {
  const h = holer()
  assert.strictEqual(await n.tick({ schalterPfad: schalter({ an: false }), url: 'u', last: LAST, holen: h, jetzt: JETZT }), 'aus')
  assert.strictEqual(await n.tick({ schalterPfad: schalter(), url: 'u', last: LAST, holen: h, jetzt: JETZT }), 'aus')
  assert.strictEqual(h.aufrufe.length, 0)
})

test('AN sendet genau die Nutzlast, einmal je Tag', async () => {
  const p = schalter({ an: true })
  const h = holer()
  assert.strictEqual(await n.tick({ schalterPfad: p, url: 'https://x/v1/ping', last: LAST, holen: h, jetzt: JETZT }), 'gesendet')
  assert.strictEqual(await n.tick({ schalterPfad: p, url: 'https://x/v1/ping', last: LAST, holen: h, jetzt: JETZT }), 'erledigt')
  assert.strictEqual(h.aufrufe.length, 1)
  assert.deepStrictEqual(JSON.parse(h.aufrufe[0].opt.body), LAST)
  assert.strictEqual(n.lesen(p).zuletzt, '2026-10-25')
  const morgen = new Date(2026, 9, 26, 1)
  assert.strictEqual(await n.tick({ schalterPfad: p, url: 'u', last: LAST, holen: h, jetzt: morgen }), 'gesendet')
})

test('Fehlschlag merkt sich den Tag NICHT', async () => {
  for (const h of [holer(500), async () => { throw new Error('offline') }]) {
    const p = schalter({ an: true })
    assert.strictEqual(await n.tick({ schalterPfad: p, url: 'u', last: LAST, holen: h, jetzt: JETZT }), 'fehler')
    assert.strictEqual(n.lesen(p).zuletzt, null)
  }
})

test('dauerhafte Ablehnung (4xx) wird bis morgen nicht wiederholt, 429 schon', async () => {
  const p = schalter({ an: true })
  assert.strictEqual(await n.tick({ schalterPfad: p, url: 'u', last: LAST, holen: holer(400), jetzt: JETZT }), 'abgelehnt')
  assert.strictEqual(n.lesen(p).zuletzt, '2026-10-25')
  const q = schalter({ an: true })
  assert.strictEqual(await n.tick({ schalterPfad: q, url: 'u', last: LAST, holen: holer(429), jetzt: JETZT }), 'fehler')
  assert.strictEqual(n.lesen(q).zuletzt, null)
})

test('ohne Kennung kein Versand', async () => {
  const h = holer()
  assert.strictEqual(await n.tick({ schalterPfad: schalter({ an: true }), url: 'u', last: null, holen: h, jetzt: JETZT }), 'ohne-kennung')
  assert.strictEqual(h.aufrufe.length, 0)
})

test('Abschalten waehrend der Anfrage bleibt AUS', async () => {
  const p = schalter({ an: true })
  const h = async () => { n.schreiben(p, { an: false }); return { ok: true } }
  await n.tick({ schalterPfad: p, url: 'u', last: LAST, holen: h, jetzt: JETZT })
  assert.strictEqual(n.lesen(p).an, false)
})

test('Rechnerkennung je Plattform', () => {
  const win = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    1111-2222\r\n'
  assert.strictEqual(n.rechnerKennung('win32', () => win), '1111-2222')
  const mac = '  "IOPlatformUUID" = "AAAA-BBBB"\n'
  assert.strictEqual(n.rechnerKennung('darwin', () => mac), 'AAAA-BBBB')
  assert.strictEqual(n.rechnerKennung('linux', null, () => 'cafe\n'), 'cafe')
  assert.strictEqual(n.rechnerKennung('win32', () => { throw new Error('x') }), null)
  assert.strictEqual(n.rechnerKennung('win32', () => 'nichts'), null)
})

test('zwei gleichzeitige Ticks senden nur einmal', async () => {
  const p = schalter({ an: true })
  // Alle Aufloesungen sammeln: sendete eine Regression doppelt, wird der Test rot statt zu haengen.
  const offen = []
  const h = holer()
  const langsam = (url, opt) => new Promise(r => { offen.push(() => r(h(url, opt))) })
  const a = n.tick({ schalterPfad: p, url: 'u', last: LAST, holen: langsam, jetzt: JETZT })
  const b = n.tick({ schalterPfad: p, url: 'u', last: LAST, holen: langsam, jetzt: JETZT })
  await new Promise(r => setImmediate(r))
  for (const f of offen) f()
  assert.deepStrictEqual(await Promise.all([a, b]), ['gesendet', 'laeuft'])
  assert.strictEqual(h.aufrufe.length, 1)
})

// Auf Linux ohne /etc/machine-id (manche Container) gibt es keine Kennung — dort ist nichts zu messen.
const ohneKennungsQuelle = process.platform === 'linux' && !fs.existsSync('/etc/machine-id')
test('echte Rechnerkennung dieses Geraets ist lesbar', { skip: ohneKennungsQuelle }, () => {
  assert.ok(n.rechnerKennung(), 'auf diesem Rechner muss eine Kennung lesbar sein')
})
