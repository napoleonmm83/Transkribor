'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  fensterOptionen, TITELLEISTE_HOEHE, farbeGueltig, fortschrittGueltig, externesZiel,
  abweisungsGrund, eigeneHerkunft,
} = require('./fenster')

// ── Abweisungsgrund (#458) ───────────────────────────────────────────────────
// EINE Eingabeliste fuer BEIDE Funktionen, und das ist der Zweck dieser Tabelle, nicht ihr
// Nebeneffekt: `abweisungsGrund` sitzt NEBEN `externesZiel` statt darin (Begruendung im
// Docstring dort — ein erweiterter Rueckgabewert waere im Ablehnungsfall truthy gewesen, und
// beide Aufrufer in `main.js` pruefen mit `if (ziel)`). Zwei Stellen koennen auseinanderlaufen:
// kommt in `externesZiel` je ein dritter Ablehnungsgrund dazu, den `abweisungsGrund` nicht
// kennt, wird diese Tabelle rot. Das ist die einzige Sicherung dagegen — deshalb laufen beide
// Funktionen ueber DIESELBE Liste und nicht ueber je eine eigene.
//
// Die Faelle sind die in #458 am Ist-Code GEMESSENEN, plus zwei Schema-Faelle aus dem Alltag.
const ABWEISUNGEN = [
  { roh: 'http://x.test/a', durchgelassen: true },
  { roh: 'HTTPS://X.test', durchgelassen: true },
  { roh: 'ht!tp://kaputt', durchgelassen: false, grund: 'nicht lesbar' },
  { roh: '', durchgelassen: false, grund: 'nicht lesbar' },
  { roh: 'javascript:alert(1)', durchgelassen: false, grund: 'Schema nicht erlaubt' },
  { roh: 'file:///C:/x', durchgelassen: false, grund: 'Schema nicht erlaubt' },
  { roh: 'mailto:a@b.c', durchgelassen: false, grund: 'Schema nicht erlaubt' },
]

test('abweisungsGrund nennt den Grund, aus dem externesZiel abgelehnt hat (#458)', () => {
  for (const { roh, durchgelassen, grund } of ABWEISUNGEN) {
    assert.strictEqual(externesZiel(roh) !== null, durchgelassen,
      `externesZiel(${JSON.stringify(roh)}) — die Tabelle beschreibt den falschen Pfad`)
    if (durchgelassen) continue
    assert.strictEqual(abweisungsGrund(roh), grund, JSON.stringify(roh))
  }
})

test('abweisungsGrund ist eine Beschriftung, KEIN zweiter Waechter (#458)', () => {
  // Die Vorbedingung aus dem Docstring, hier festgenagelt: fuer eine ERLAUBTE URL antwortet die
  // Funktion trotzdem etwas — sie kennt die Frage nicht, nur die Ablehnung. Wer sie fuer eine
  // Entscheidung benutzt statt fuer deren Beschriftung, bekommt „Schema nicht erlaubt" fuer ein
  // erlaubtes Schema. Der Test steht hier, damit niemand sie fuer eine Wache haelt.
  assert.strictEqual(externesZiel('https://gut.test/'), 'https://gut.test/')
  assert.strictEqual(abweisungsGrund('https://gut.test/'), 'Schema nicht erlaubt')
})

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
  // (Chromium kanonisiert vorher) — und seit #434 ist gemessen, dass der ZWEITE Aufrufer daran
  // nichts aendert: `will-navigate` bekommt die URL ebenfalls schon kanonisiert. Der Test bleibt
  // trotzdem, er bewacht die BAUFORM; nur die Erwartung „bald erreichbar" war falsch.
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

// ── eigeneHerkunft (#434) ────────────────────────────────────────────────────
// Die beiden Herkuenfte, die die App selbst laedt: die Statusseite als Datei und der
// Loopback-Server. Beide Formen stehen hier so, wie sie am Waechter ankommen — am laufenden
// Fenster nachgemessen, nicht nachgebaut.
const EIGEN = ['file:///E:/Git/Transkribor/electron/setup.html', 'http://127.0.0.1:8000/']

test('die eigene App gilt als eigene Herkunft (#434)', () => {
  for (const gut of [
    'http://127.0.0.1:8000/',
    'http://127.0.0.1:8000/p/Projekt/datei?x=1#y',   // Deep-Link nach einem Reload
    'file:///E:/Git/Transkribor/electron/setup.html',
    'file:///E:/Git/Transkribor/electron/setup.html#neu',   // Reload behaelt den Hash
  ]) {
    assert.strictEqual(eigeneHerkunft(gut, EIGEN), true, gut)
  }
})

test('alles andere ist FREMD — auch was der eigenen Adresse aehnelt (#434)', () => {
  const fremd = [
    'https://example.org/',
    'http://127.0.0.1:8001/',                     // anderer Port ist eine andere Herkunft
    'https://127.0.0.1:8000/',                    // anderes Schema ebenso
    'http://localhost:8000/',                     // die App laedt nur 127.0.0.1
    'http://127.0.0.1:8000@example.org/',         // Benutzername-Falle: der Wirt ist example.org
    'http://127.0.0.1.example.org/',              // Praefix-Falle
    'file:///C:/Windows/System32/calc.exe',       // s.u. — der teuerste Einzelfehler
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'nicht mal eine url', '', ' ', null, undefined, 42, {}, [],
  ]
  for (const schrott of fremd) {
    assert.strictEqual(eigeneHerkunft(schrott, EIGEN), false, String(schrott))
  }
})

test('file: hat KEINE Herkunft — der Pfad entscheidet, nicht origin (#434)', () => {
  // `new URL('file:///x').origin` ist fuer JEDE file:-URL der String 'null'. Ein
  // origin-Vergleich haette also jede beliebige lokale Datei fuer unsere setup.html gehalten —
  // der Fehler sieht im Code aus wie die kuerzere Fassung und ist der teuerste dieser Funktion.
  assert.strictEqual(new URL('file:///x').origin, 'null', 'Praemisse des Tests')
  assert.strictEqual(new URL('file:///y').origin, new URL('file:///z').origin, 'Praemisse des Tests')
  assert.strictEqual(eigeneHerkunft('file:///E:/anderes/verzeichnis/boese.html', EIGEN), false)
  assert.strictEqual(eigeneHerkunft('file:///E:/Git/Transkribor/electron/preload.js', EIGEN), false,
    'auch eine Nachbardatei im selben Ordner ist nicht die Statusseite')
})

test('bei file: zaehlt auch der HOST, nicht nur der Pfad (#434)', () => {
  // Aus dem Kalt-Review: eine UNC-Referenz auf einen FREMDEN Rechner traegt denselben Pfad.
  // Ohne den Host-Vergleich galt sie als unsere Statusseite — und zwar an genau der Stelle,
  // deren Dichtheit der Kommentar darueber zusichert.
  assert.strictEqual(eigeneHerkunft('file://evil.example.com/E:/Git/Transkribor/electron/setup.html', EIGEN), false)
  // Gegenrichtung, sonst waere der Vergleich zu scharf und sperrte die eigene Seite aus:
  // `pathToFileURL` liefert immer den leeren Host, und `localhost` normalisiert der Parser
  // selbst darauf — beide echten Formen muessen weiterhin durchkommen.
  assert.strictEqual(new URL(EIGEN[0]).host, '', 'Praemisse: unsere eigene file:-URL hat keinen Host')
  assert.strictEqual(eigeneHerkunft('file://localhost/E:/Git/Transkribor/electron/setup.html', EIGEN), true,
    'file://localhost/ IST die lokale Datei — der Parser normalisiert den Host auf leer')
})

test('ein blob: der eigenen Seite IST die eigene Herkunft (#434)', () => {
  // Der Kommentar zaehlte `blob:` zuerst unter „faellt hart durch" — falsch: ein Blob traegt
  // die Herkunft seines ERZEUGERS, und einen mit unserer Herkunft erzeugt nur unsere eigene
  // Seite. Das VERHALTEN muss so bleiben, `useDoc.ts`/`api.ts` bauen die Export-Downloads so;
  // festgehalten wird hier die wahre Regel, nicht die falsche Aufzaehlung.
  assert.strictEqual(eigeneHerkunft('blob:http://127.0.0.1:8000/abc-123', EIGEN), true)
  assert.strictEqual(eigeneHerkunft('blob:https://example.org/abc-123', EIGEN), false,
    'ein Blob FREMDER Herkunft bleibt fremd')
  assert.strictEqual(eigeneHerkunft('blob:file:///E:/Git/Transkribor/electron/setup.html', EIGEN), false,
    'ein Blob mit file:-Innerem hat die undurchsichtige Herkunft')
})

test('eine Liste ohne echte Herkunft laesst nichts durch (#434)', () => {
  // Kein Produktionsfall, sondern die Vertrauensgrenze fuer kuenftige Aufrufer: stuende in der
  // Liste etwas Undurchsichtiges, machte `'null' === 'null'` daraus ein Scheunentor.
  for (const kaputt of [['data:text/html,x'], ['about:blank'], ['keine url'], [], null, undefined]) {
    assert.strictEqual(eigeneHerkunft('data:text/html,y', kaputt), false, JSON.stringify(kaputt))
    assert.strictEqual(eigeneHerkunft('https://example.org/', kaputt), false, JSON.stringify(kaputt))
  }
})
