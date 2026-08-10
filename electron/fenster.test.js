'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { fensterOptionen, TITELLEISTE_HOEHE } = require('./fenster')

test('Windows und Linux bekommen ein Overlay mit nativen Knoepfen', () => {
  for (const p of ['win32', 'linux']) {
    const o = fensterOptionen(p)
    assert.strictEqual(o.titleBarStyle, 'hidden', p)
    assert.ok(o.titleBarOverlay, `${p}: ohne Overlay malt niemand die Fensterknoepfe`)
    // Muss zur Hoehe der TitleBar-Komponente passen, sonst sitzen die Knoepfe versetzt.
    assert.strictEqual(o.titleBarOverlay.height, TITELLEISTE_HOEHE, p)
  }
})

test('macOS behaelt seine Ampelknoepfe und bekommt KEIN Overlay', () => {
  const o = fensterOptionen('darwin')
  assert.strictEqual(o.titleBarStyle, 'hiddenInset')
  // titleBarOverlay ist auf macOS wirkungslos; gesetzt zu lassen taeuscht den Leser.
  assert.strictEqual(o.titleBarOverlay, undefined)
})

test('die Overlay-Farben folgen dem Thema', () => {
  const hell = fensterOptionen('win32', false).titleBarOverlay
  const dunkel = fensterOptionen('win32', true).titleBarOverlay
  assert.notStrictEqual(hell.color, dunkel.color, 'hell und dunkel muessen sich unterscheiden')
  // symbolColor kontrastiert zur Grundflaeche -- hier als Tausch der beiden Werte geprueft.
  assert.strictEqual(hell.symbolColor, dunkel.color)
  assert.strictEqual(dunkel.symbolColor, hell.color)
})
