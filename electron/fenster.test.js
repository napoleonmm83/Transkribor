'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { fensterOptionen, TITELLEISTE_HOEHE, farbeGueltig, fortschrittGueltig, externesZiel } = require('./fenster')

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

test('nur brauchbare Farben kommen durch die Bruecke', () => {
  assert.ok(farbeGueltig({ color: '#0B0B0F', symbolColor: '#FAFAFA' }))   // was ThemeProvider schickt
  const schlecht = [null, undefined, 'blau', {}, { color: '#000' }, { color: 1, symbolColor: 2 },
    { color: '', symbolColor: '' },                        // leer ist kein Wert
    { color: '#FAFAFA', symbolColor: 'javascript:alert(1)' },
    { color: '#fff', symbolColor: '#000' },                // Kurzform schickt niemand von uns
  ]
  for (const schrott of schlecht) {
    assert.strictEqual(farbeGueltig(schrott), false, JSON.stringify(schrott))
  }
})

test('nur -1 oder 0..1 gilt als Fortschritt', () => {
  for (const gut of [-1, 0, 0.5, 1]) assert.ok(fortschrittGueltig(gut), String(gut))
  // 2 schaltet Electron auf einen unbestimmten Dauerbalken -- der Grund fuer die Obergrenze.
  for (const schlecht of [2, -0.5, -2, NaN, Infinity, '0.5', null, undefined]) {
    assert.strictEqual(fortschrittGueltig(schlecht), false, String(schlecht))
  }
})

test('nur harmlose Schemata duerfen ans Betriebssystem (#426)', () => {
  // Was die App wirklich schickt: elf target="_blank"-Anker, acht mit fester https-Adresse;
  // von den drei fremdbestimmten laesst Notizen.tsx ausdruecklich auch http zu.
  for (const gut of ['https://example.org/doku', 'http://example.org'])
    assert.ok(externesZiel(gut), gut)

  // Der Grund, warum es diesen Waechter gibt: shell.openExternal geht ans BETRIEBSSYSTEM,
  // nicht in den Browser — diese Schemata erreichen dort einen Handler, keinen Tab.
  const schlecht = [
    'file:///C:/Windows/System32/calc.exe',
    'ms-msdt:/id PCWDiagnostic',                  // Follina-Klasse
    'search-ms:query=geheim',
    'shell:startup',
    'javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',                                // window.open() ohne Argument
    // mailto: ist bewusst NICHT erlaubt — kein Link der App braucht es ueber DIESEN Weg,
    // und der Renderer duerfte sonst Empfaenger, Betreff und Rumpf frei komponieren.
    'mailto:opfer@example.org?subject=x&body=y',
    'nicht mal eine url', '', ' ', null, undefined, 42, {}, [],
  ]
  for (const schrott of schlecht)
    assert.strictEqual(externesZiel(schrott), null, String(schrott))
})

test('zurueck kommt die GEPARSTE URL, nicht die rohe Eingabe (#426)', () => {
  // Der WHATWG-Parser streicht Steuerzeichen — ein Praedikat haette hier `true` gesagt, und
  // der Aufrufer haette die ROHE Zeichenkette ans Betriebssystem gereicht. Genau diese
  // Bauform-Luecke schliesst die Rueckgabe des Wertes. Aus dem heutigen Handler unerreichbar
  // (Chromium kanonisiert vorher); der zweite Aufrufer aus #434 ist schon vorgeschlagen.
  for (const [roh, erwartet] of [
    ['\u0000https://example.org/doku', 'https://example.org/doku'],
    ['https\t://example.org/doku', 'https://example.org/doku'],
    ['ht\ntps://example.org/doku', 'https://example.org/doku'],
    ['  https://example.org/doku  ', 'https://example.org/doku'],
  ]) {
    assert.strictEqual(externesZiel(roh), erwartet, JSON.stringify(roh))
    assert.notStrictEqual(externesZiel(roh), roh, 'die rohe Form darf NIE zurueckkommen')
  }
})
