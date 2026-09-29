'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function seite() {
  const html = fs.readFileSync(require('node:path').join(__dirname, 'setup.html'), 'utf8')
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1])
  const elemente = Object.fromEntries(ids.map(id => [id, {
    style: {}, textContent: '', classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this[k] = v }, removeAttribute(k) { delete this[k] }, focus() {},
  }]))
  const events = {}
  const window = { addEventListener() {}, transkribor: {
    on: (name, fn) => { events[name] = fn }, status: () => new Promise(() => {}),
  } }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window, document: { getElementById: id => elemente[id] },
    navigator: { platform: 'Win32' }, Date, Number, Math,
  })
  return { html, elemente, events }
}

test('ein Gesamtbalken bleibt beim Wechsel zwischen Paketen erhalten', () => {
  const { html, elemente: e, events } = seite()
  events.phase({ schritt: 'Whisper und Werkzeuge laden' })
  events.progress({ download: 'gross.whl', bytes: 100, gesamt: 100 })
  events.progress({ download: 'klein.whl', bytes: 1, gesamt: 100 })
  assert.equal((html.match(/role="progressbar"/g) || []).length, 1)
  assert.equal(e.balken['aria-valuenow'], '50')
  assert.match(e['gesamt-stand'].textContent, /Gesamtfortschritt.*50 %/)
  assert.match(e.fortschritt.textContent, /klein.whl.*1 %/)
  events.progress({ installation: true })
  assert.equal(e.balken['aria-valuenow'], '50')
  assert.match(e.fortschritt.textContent, /installiert/)
})

test('Gesamtabschluss bleibt beim anschliessenden Serverstart auf 100 Prozent', () => {
  const { elemente: e, events } = seite()
  events.phase({ schritt: 'Prüfen' })
  events.progress({ fertig: true })
  events.phase({ schritt: 'Server starten' })
  assert.equal(e.balken['aria-valuenow'], '100')
  assert.match(e['gesamt-stand'].textContent, /100 %/)
})
