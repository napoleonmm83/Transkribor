'use strict'
/** Prueft, WAS die Bruecke freigibt — eine zu weit geoeffnete Bruecke faellt sonst niemandem auf. */
const Module = require('node:module')
const test = require('node:test')
const assert = require('node:assert')

let freigegeben = null
const kanaele = []
const echt = Module._load
Module._load = (req, ...rest) => req === 'electron' ? {
  contextBridge: { exposeInMainWorld: (_name, api) => { freigegeben = api } },
  ipcRenderer: { invoke: () => Promise.resolve(), on: (k) => kanaele.push(k) },
} : echt(req, ...rest)
require('./preload')
Module._load = echt

test('die Update-Methoden sind da', () => {
  for (const name of ['status', 'pruefen', 'laden', 'installieren']) {
    assert.strictEqual(typeof freigegeben.update[name], 'function', name)
  }
})

test('der Kanal update ist erlaubt, ein erfundener nicht', () => {
  freigegeben.on('update', () => {})
  freigegeben.on('kanal-den-es-nicht-gibt', () => {})
  assert.deepStrictEqual(kanaele, ['update'])
})
