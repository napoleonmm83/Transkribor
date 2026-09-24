'use strict'
const Module = require('node:module')
const echt = Module._load
Module._load = (req, ...rest) => req === 'electron'
  ? { app: { isPackaged: false, getPath: () => require('os').tmpdir() } }
  : echt(req, ...rest)
const test = require('node:test')
const assert = require('node:assert/strict')
const m = require('./manueller-bericht')

const META = { version: '1.2.3', plattform: 'win32', arch: 'x64', electron: '44', node: '22', gepackt: true }
const CTX = { home: 'C:\\Users\\Ada', daten: 'C:\\Users\\Ada\\Data', projekte: '/kein-ordner' }

test('DSN wird zur Sentry-Envelope-URL', () => {
  assert.equal(m.envelopeUrl('http://key@127.0.0.1:8123/1'),
    'http://127.0.0.1:8123/api/1/envelope/?sentry_version=7&sentry_key=key')
  assert.throws(() => m.envelopeUrl(''), /Bugsink/)
  assert.throws(() => m.envelopeUrl('file:///tmp/1'), /ungueltig/)
})

test('Vorschau und Envelope enthalten dieselben Zeilen; abgewählte Zeilen bleiben weg', async () => {
  const b = m.vorschau('FEHLER: C:\\Users\\Ada\\Data\\x\nGeheimnis LIC-EXAMPLE-9731\n', CTX, META)
  assert.equal(b.zeilen.length, 2)
  assert.ok(b.zeilen[0].includes('<daten>'))
  let event
  const transport = o => {
    assert.equal(o.url, 'http://127.0.0.1:8123/api/1/envelope/?sentry_version=7&sentry_key=key')
    return { send: async envelope => { event = envelope[1][0][1]; return { statusCode: 202 } } }
  }
  const r = await m.senden({ dsn: 'http://key@127.0.0.1:8123/1', snapshot: b, indices: [0],
    kommentar: 'Pfad C:\\Users\\Ada\\Data\\x', meta: META, ctx: CTX, transport })
  assert.equal(r.id, b.id)
  assert.deepEqual(event.extra.protokoll, [b.zeilen[0]])
  assert.ok(!JSON.stringify(event).includes('LIC-EXAMPLE-9731'))
  assert.ok(event.extra.kommentar.includes('<daten>'))
})

test('nur eine bestätigte 2xx-Antwort ist Erfolg; falsche Auswahl wird nie gesendet', async () => {
  const b = m.vorschau('Fehler\n', CTX, META)
  let aufrufe = 0
  const transport = () => ({ send: async () => { aufrufe++; return {} } })
  await assert.rejects(() => m.senden({ dsn: 'http://key@localhost/1', snapshot: b, indices: [0],
    kommentar: '', meta: META, ctx: CTX, transport }), /nicht bestaetigt/)
  await assert.rejects(() => m.senden({ dsn: 'http://key@localhost/1', snapshot: b, indices: [1],
    kommentar: '', meta: META, ctx: CTX, transport }), /ungueltig/)
  assert.equal(aufrufe, 1)
})

// Kalt-Review 24.09.: diese Riegel hatten keinen Waechter. Die Eindeutigkeit ist zugleich der
// einzige Groessendeckel der Auswahl ([0,0,0,…] waere sonst beliebig gross).
test('doppelte Indizes und ein zu langer Kommentar werden nie gesendet', async () => {
  const b = m.vorschau('Fehler\n', CTX, META)
  let aufrufe = 0
  const transport = () => ({ send: async () => { aufrufe++; return { statusCode: 202 } } })
  const senden = (indices, kommentar) => m.senden({ dsn: 'http://key@localhost/1', snapshot: b,
    indices, kommentar, meta: META, ctx: CTX, transport })
  await assert.rejects(() => senden([0, 0], ''), /ungueltig/)
  await assert.rejects(() => senden([0], 'x'.repeat(2001)), /zu lang/)
  await senden([0], 'x'.repeat(2000))
  assert.equal(aufrufe, 1)
})

test('4xx und 5xx vom Server sind kein Erfolg', async () => {
  const b = m.vorschau('Fehler\n', CTX, META)
  for (const statusCode of [429, 500, 300]) {
    const transport = () => ({ send: async () => ({ statusCode }) })
    await assert.rejects(() => m.senden({ dsn: 'http://key@localhost/1', snapshot: b, indices: [0],
      kommentar: '', meta: META, ctx: CTX, transport }), /nicht bestaetigt/, String(statusCode))
  }
})

test('ein Server, der nie antwortet, endet nach der Frist mit einem Fehler statt zu haengen', async () => {
  const b = m.vorschau('Fehler\n', CTX, META)
  const transport = () => ({ send: () => new Promise(() => {}) })
  await assert.rejects(() => m.senden({ dsn: 'http://key@localhost/1', snapshot: b, indices: [0],
    kommentar: '', meta: META, ctx: CTX, transport, frist: 20 }), /antwortet nicht/)
})
