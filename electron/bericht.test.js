'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { letzteZeilen, kopf, mailto, MAX_URL, MAX_ZEILE } = require('./bericht')

const K = kopf({ version: '0.48.1', plattform: 'win32', arch: 'x64', electron: '43.3.0', node: '22.18.0', gepackt: true })

test('letzteZeilen nimmt die JUENGSTEN und behaelt ihre Reihenfolge', () => {
  const text = 'a\nb\nc\nd'
  assert.deepStrictEqual(letzteZeilen(text, 2), ['c', 'd'])
  assert.deepStrictEqual(letzteZeilen(text, 99), ['a', 'b', 'c', 'd'])
})

test('leere Zeilen zaehlen nicht mit', () => {
  // Der Protokollkopf schreibt Leerzeilen und Trennstriche; ohne den Filter kaeme ein
  // Bericht zurueck, dessen halbe Nutzlast aus Nichts besteht — und der Deckel unten
  // wuerde dafuer echte Zeilen wegwerfen.
  assert.deepStrictEqual(letzteZeilen('a\n\n\nb', 3), ['a', 'b'])
})

test('die PATH-Zeile faellt raus — sie traegt den Benutzernamen UND frisst den Deckel', () => {
  // Sie steht bei JEDEM Start im Protokollkopf, ist auf dieser Maschine >1000 Zeichen lang
  // und stuende bei einem frisch gestarteten Programm unter den letzten Zeilen.
  const text = '[t] PATH      : C:\\Windows;C:\\Users\\marcus\\bin\n[t] Gepackt   : true\n[t] es knallte'
  const z = letzteZeilen(text)
  assert.ok(!z.some(x => /PATH/.test(x)), 'kein PATH')
  // Gegenrichtung: der Filter darf nicht die halbe Datei mitnehmen.
  assert.deepStrictEqual(z, ['[t] Gepackt   : true', '[t] es knallte'])
})

test('erfolgreiche Zugriffszeilen fallen raus, gescheiterte NICHT', () => {
  // Gemessen an einem echten Protokoll: 89,1 % der Zeilen sind uvicorn-Zugriffe, die
  // letzten 60 zu 100 % — ohne diesen Filter besteht der ganze Bericht daraus.
  // Die zweite Haelfte ist die wichtigere: ein 500er ist die Zeile, wegen der jemand
  // schreibt, und im gemessenen Protokoll kam sie 0-mal vor. Selten und alles tragend.
  const z = letzteZeilen([
    '[t] INFO:     127.0.0.1:60884 - "GET /api/projects HTTP/1.1" 200 OK',
    '[t] INFO:     127.0.0.1:60884 - "POST /api/projects/X/audio HTTP/1.1" 500 Internal Server Error',
    '[t] INFO:     127.0.0.1:60884 - "GET /api/settings HTTP/1.1" 403 Forbidden',
    '[t] FEHLER: irgendwas',
  ].join('\n'))
  assert.deepStrictEqual(z, [
    '[t] INFO:     127.0.0.1:60884 - "POST /api/projects/X/audio HTTP/1.1" 500 Internal Server Error',
    '[t] INFO:     127.0.0.1:60884 - "GET /api/settings HTTP/1.1" 403 Forbidden',
    '[t] FEHLER: irgendwas',
  ])
})

test('der Pfad hinter einem file:-Schema faellt raus, der Hinweis bleibt (#447)', () => {
  // Seit dem will-navigate-Waechter (#434) protokolliert ein Fehlwurf beim Drag & Drop den
  // vollen Pfad der Aufnahme — und die Zeile faehrt in der Fehlerbericht-Mail mit. Der Pfad
  // hat dort keinen Diagnosewert (WELCHE Datei jemand danebenwarf, hilft niemandem), die
  // Zeile selbst schon: sie ist die einzige Antwort auf „ich habe etwas ins Fenster gezogen
  // und es passiert nichts".
  const z = letzteZeilen(
    '[t] Navigation abgewiesen (Schema nicht erlaubt): file:///C:/Users/marcu/Videos/Interview%20Meier.mp3')
  assert.deepStrictEqual(z,
    ['[t] Navigation abgewiesen (Schema nicht erlaubt): file:///… (Pfad entfernt)'])
  // Jede Schreibweise, die ein lokaler Pfad annehmen kann. Die einschraegige Form und den
  // Rueckstrich kanonisiert Chromium heute weg, und Schemata liefert es klein — genau darauf
  // soll sich diese Wache nicht verlassen, derselbe Grund wie beim Leerzeichen unten.
  // `FILE:///` ist der EINZIGE Fall, der das `i` festnagelt: ohne ihn blieb die Suite bei
  // entferntem Flag 20/20 gruen (Mutationsprobe des gegnerischen Reviews).
  for (const roh of ['file:///C:/x/Meier.mp3', 'file://nas/x/Meier.mp3', 'file:/C:/x/Meier.mp3',
    'file:\\C:\\x\\Meier.mp3', 'FILE:///C:/x/Meier.mp3'])
    assert.deepStrictEqual(letzteZeilen('[t] abgewiesen: ' + roh),
      ['[t] abgewiesen: file:///… (Pfad entfernt)'], roh)

  // **Der Doppelpunkt ist AUSDRUECKLICH kein Ausschluss** (CodeRabbit-CLI an #435, gegen den
  // Bot-Befund an #457): stand er im Riegel, blieb `Quelle:file:///C:/Users/<name>/…`
  // ungekuerzt — ein echter lokaler Pfad samt Aufnahmenamen, also genau der Abfluss, den
  // diese Kuerzung verhindern soll. Ein Doppelpunkt ist im Deutschen Zeichensetzung, kein
  // Schema-Trenner. Der Preis steht in der zweiten Zeile: `mailto:file:///…` wird
  // mitgekuerzt; sein Rumpf traegt keinen lokalen Pfad. Wer `:` wieder ausschliesst, macht
  // diese Zeilen rot.
  for (const [praefix, roh] of [['Quelle:', 'file:///C:/Users/marcu/Interview Meier.mp3'],
    ['mailto:', 'file:///C:/x/Meier.mp3']]) {
    const z = letzteZeilen('[t] ' + praefix + roh)
    assert.deepStrictEqual(z, ['[t] ' + praefix + 'file:///… (Pfad entfernt)'], praefix)
    assert.ok(!z[0].includes('Meier'), `${praefix}: kein Aufnahmename uebrig`)
  }
})

test('auch ein Pfad MIT Leerzeichen hinterlaesst keinen Rest (#447)', () => {
  // Der Grund fuer `.*` statt `\S*`: bei `\S*` endete die Ersetzung am ersten Leerzeichen und
  // ausgerechnet der Dateiname bliebe stehen. Chromium normalisiert zwar zu %20 — aber dann
  // haengt die Wache an einer fremden Zusicherung statt an sich selbst.
  const z = letzteZeilen(
    '[t] Externer Link abgewiesen (Schema nicht erlaubt): file:///C:/My Videos/Interview Meier.mp3')
  assert.ok(!z[0].includes('Meier'), 'kein Rest hinter der Ersetzung')
  assert.deepStrictEqual(z,
    ['[t] Externer Link abgewiesen (Schema nicht erlaubt): file:///… (Pfad entfernt)'])
})

test('ein Pfad OHNE file:-Schema bleibt unangetastet — die Kuerzung ist eng (#447)', () => {
  // Gegenrichtung, und sie ist die teurere: `C:\Users\…` steht bewusst im Rumpf (der
  // Benutzername ist getragen und im Kopf dieser Datei begruendet), und eine 500er-Zeile mit
  // Projekt- und Basisnamen ist genau die, wegen der jemand schreibt. Wer hier breiter
  // kuerzt, nimmt die Auskunft mit. Die PATH-Zeile faellt weiter GANZ raus — Kuerzen und
  // Weglassen sind zwei verschiedene Behandlungen.
  const z = letzteZeilen([
    '[t] PATH      : C:\\Windows;C:\\Users\\marcu\\bin',
    '[t] venvPfad = C:\\Users\\marcu\\AppData\\Roaming\\Transkribor\\venv',
    '[t] INFO:     127.0.0.1:60884 - "POST /api/projects/X/audio HTTP/1.1" 500 Internal Server Error',
    // Das `file:` OHNE Trenner ist die eine Grenze der Kuerzung: hier IST der Pfad die
    // Diagnose. Wer das Muster auf `\bfile:` verbreitert, macht diese Zeile rot.
    '[t] could not open file: C:/Users/marcu/Videos/Interview Meier.mp3',
    // Und die andere Grenze: die Regel gilt dem SCHEMA `file:`, nicht der Zeichenfolge.
    // `profile:` faengt ein blosses `\b` noch ab — die drei darunter NICHT: nach RFC 3986 §3.1
    // gehoeren `+`, `-` und `.` zu den Schema-Zeichen, und zwischen `-` und `f` liegt eine
    // Wortgrenze (CodeRabbit am PR, nachgemessen). Wer den Praefix-Riegel auf `\b`
    // zurueckdreht, macht genau diese drei Zeilen rot.
    '[t] profile://default/x',
    '[t] profile-file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] x+file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] a.file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    // Und die Trennerzeichen: nach `/` oder `\` steht `file:` gar nicht an einer
    // Schema-Position — dort ist es Host oder Pfadsegment. Gefunden vom Bot an PR #457.
    // Der Doppelpunkt gehoert NICHT dazu, siehe die `Quelle:`-Zeile im Test darueber.
    '[t] https://file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] https://beispiel.test/a/file:///C:/x/Interview Meier.mp3',
    '[t] C:' + String.fromCharCode(92) + 'file:///C:/x/Interview Meier.mp3',
  ].join('\n'))
  assert.deepStrictEqual(z, [
    '[t] venvPfad = C:\\Users\\marcu\\AppData\\Roaming\\Transkribor\\venv',
    '[t] INFO:     127.0.0.1:60884 - "POST /api/projects/X/audio HTTP/1.1" 500 Internal Server Error',
    '[t] could not open file: C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] profile://default/x',
    '[t] profile-file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] x+file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] a.file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] https://file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] https://beispiel.test/a/file:///C:/x/Interview Meier.mp3',
    '[t] C:' + String.fromCharCode(92) + 'file:///C:/x/Interview Meier.mp3',
  ])
})

test('new URL kanonisiert die Schreibweisen — der Sensor unter dem „(gemessen)" (#447)', () => {
  // Der Kommentar in bericht.js begruendet `[\/\\]{1,3}` damit, dass die Plattform `file:/x`
  // und `file:C:/x` heute zu `file:///x` kanonisiert — und dass die Wache sich darauf gerade
  // NICHT verlassen soll. Ohne diesen Test war „(gemessen)" eine Behauptung ohne Sensor
  // (CodeRabbit-Vorabcheck am PR). Aendert eine Node- oder Electron-Fassung das Verhalten,
  // wird hier rot, statt dass der Kommentar still falsch wird.
  assert.strictEqual(new URL('file:/C:/x').href, 'file:///C:/x')
  assert.strictEqual(new URL('file:C:/x').href, 'file:///C:/x')
  assert.strictEqual(new URL('file:///C:/x').href, 'file:///C:/x')
  // Die Gegenrichtung, sonst laese sich der Test als „alles wird zu file:///" missverstehen:
  // ein Host bleibt erhalten, die UNC-Form ist KEIN Sonderfall der drei Schraegstriche.
  assert.strictEqual(new URL('file://nas/x').href, 'file://nas/x')
})

test('der Kopf nennt Fassung, Plattform und ob gepackt', () => {
  const t = K.join('\n')
  for (const stueck of ['0.48.1', 'win32', '43.3.0', 'true']) assert.ok(t.includes(stueck), stueck)
})

test('der volle PATH gehoert NICHT in den Rumpf — nur der Pfad der Datei', () => {
  // Die Datenschutz-Entscheidung dieses Features: der PATH traegt den Benutzernamen. Er
  // steht im Protokollkopf und damit in der DATEI, die der Nutzer bewusst anhaengt.
  const { url } = mailto({
    empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['irgendwas'],
    logpfad: 'C:\\Users\\x\\AppData\\Roaming\\Transkribor\\transkribor.log',
  })
  const rumpf = decodeURIComponent(url.split('&body=')[1])
  assert.ok(!/PATH/i.test(rumpf), 'kein PATH im Rumpf')
  assert.ok(rumpf.includes('transkribor.log'), 'der Weg zur Datei steht drin')
})

test('gekuerzt wird von OBEN — die juengsten Zeilen ueberleben', () => {
  // Wer von unten kuerzt, wirft genau die Zeilen weg, wegen derer jemand schreibt.
  const zeilen = Array.from({ length: 200 }, (_, i) => `Zeile ${i} mit etwas Text daran`)
  const { url, verwendet, gekuerzt } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen })
  assert.ok(gekuerzt && verwendet > 0 && verwendet < 200)
  const rumpf = decodeURIComponent(url.split('&body=')[1])
  assert.ok(rumpf.includes('Zeile 199'), 'die letzte Zeile muss drin sein')
  assert.ok(!rumpf.includes('Zeile 0 '), 'die aelteste faellt weg')
})

test('die KODIERTE URL haelt den Deckel, nicht der rohe Rumpf', () => {
  // Der Kern der Konstante: `%0A` je Umbruch, zwei Prozentgruppen je Umlaut — ein Rumpf
  // von 1800 Zeichen ergibt leicht 3000 Zeichen URL, und Windows reicht ~2048 durch.
  const zeilen = Array.from({ length: 300 }, (_, i) => `Zeile ${i}: äöü über größere Ausfälle`)
  const { url } = mailto({ empfaenger: 'a@b.c', betreff: 'Fehlerbericht Transkribor', kopf: K, zeilen })
  assert.ok(url.length <= MAX_URL, `URL ist ${url.length} Zeichen`)
})

test('der Kopf ueberlebt auch, wenn nichts anderes passt', () => {
  // Dieser Test fuhr bis #435 zwei 3000-Zeichen-Zeilen und erwartete `verwendet === 0` —
  // er pinnte damit GENAU das Verhalten, das #435 als Defekt meldet. Sein Anliegen (der
  // Kopf geht raus, auch wenn nichts anderes passt) bleibt richtig und wird jetzt ueber
  // einen winzigen Deckel hergestellt statt ueber ueberlange Zeilen: seit der Kappung
  // KANN eine Zeile den Deckel nicht mehr allein sprengen.
  const { url, verwendet } = mailto({
    empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['eine Zeile'], maxUrl: 120,
  })
  assert.strictEqual(verwendet, 0)
  assert.ok(decodeURIComponent(url.split('&body=')[1]).includes('0.48.1'),
    'eine Mail mit Fassung und Plattform ist mehr als keine')
})

test('eine EINZELNE ueberlange Zeile leert den Bericht nicht mehr (#435)', () => {
  // Der Kern: `mailto` kuerzte von OBEN, bis es passt — sprengte eine einzelne Zeile den
  // Deckel schon allein, lief die Schleife bis auf NULL. Gemessen war die Zahl der
  // Ueberlebenden exakt die Zahl der Zeilen DAHINTER; steht die lange am Ende (der
  // Normalfall, denn Protokollzeilen werden angehaengt), blieb nichts uebrig.
  const normal = Array.from({ length: 20 }, (_, i) => `[t] Zeile ${i}: eine gewoehnliche Protokollzeile`)
  for (const pos of [0, 10, 19, 20]) {
    const zeilen = [...normal]
    zeilen.splice(pos, 0, '[t] LANG: ' + 'x'.repeat(1800))
    const { verwendet } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen, logpfad: 'C:\\log.txt' })
    assert.ok(verwendet >= 1, `Position ${pos}: verwendet=${verwendet}, es muss mindestens eine Zeile mitkommen`)
  }
})

test('ein langer Dateipfad verdraengt nicht ALLE Zeilen (#435, Kalt-Review)', () => {
  // Die `mitPfad`-Frage wurde an einem Rumpf OHNE Protokollzeilen gemessen. Ein Pfad, der
  // allein passt, aber weniger Luft laesst als eine gekappte Zeile braucht, verdraengte damit
  // alle Zeilen — dasselbe Symptom wie #435, nur durch die andere Tuer. Gemessen mit Zeilen AN
  // der Kappungsgrenze: ab 688 Zeichen Pfad kamen null Zeilen mit, waehrend die URL nur 1306
  // von 1900 nutzte. Mit kurzen Zeilen ist der Fall NICHT herstellbar — der erste Versuch
  // sah ihn deshalb nicht.
  const zeilen = Array.from({ length: 20 }, (_, i) => `[t] Zeile ${i}: ` + 'x'.repeat(1200))
  for (const n of [688, 772, 1108]) {
    const logpfad = 'C:/Users/marcu/' + 'ordner/'.repeat(Math.round((n - 20) / 7)) + 'transkribor.log'
    const { verwendet } = mailto({ empfaenger: 'a@b.c', betreff: 'Fehlerbericht Transkribor 0.48.1', kopf: K, zeilen, logpfad })
    assert.ok(verwendet >= 1, `Pfadlaenge ${logpfad.length}: verwendet=${verwendet}`)
  }
})

test('gekappt wird an der KODIERTEN Laenge, nicht an der rohen (#435)', () => {
  // Der Grund fuer die Einheit, und er ist gemessen: 500 rohe Umlaute werden kodiert 3000
  // Zeichen lang. Eine Kappe auf die ROHE Laenge haette die Zusicherung nicht gehalten —
  // `verwendet` fiel damit wieder auf 0, also genau der leere Bericht.
  const { verwendet } = mailto({
    empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['ä'.repeat(500)], logpfad: 'C:\\log.txt',
  })
  assert.ok(verwendet >= 1, `Umlautzeile: verwendet=${verwendet}`)
})

test('die Kappung wird ANGESAGT, nicht stillschweigend gemacht (#435)', () => {
  // Dieselbe Regel wie beim `gekuerzt`-Merker eine Ebene hoeher: ein stillschweigend halber
  // Bericht sieht aus wie ein vollstaendiger.
  const { url } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['A'.repeat(1200)] })
  const rumpf = decodeURIComponent(url.split('&body=')[1])
  assert.ok(rumpf.includes(' […]'), 'die gekappte Zeile sagt es an')
  // Gegenrichtung: eine normale Zeile bekommt die Marke NICHT — sonst ist sie wertlos.
  const ganz = decodeURIComponent(
    mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['kurz'] }).url.split('&body=')[1])
  assert.ok(!ganz.includes(' […]'), 'eine ungekappte Zeile traegt die Marke nicht')
})

test('ein Ersatzzeichenpaar wird nicht zerschnitten (#435)', () => {
  // `'abc😀def'.slice(0,4)` trennt das Paar, und `encodeURIComponent` wirft darauf
  // `URIError: URI malformed` — ein Absturz in der Funktion, die den Fehlerbericht rettet.
  // Deshalb wird ueber Codepoints geschnitten, nicht ueber UTF-16-Einheiten.
  const zeile = '😀'.repeat(400)
  assert.doesNotThrow(() => mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: [zeile] }))
  const { url, verwendet } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: [zeile] })
  assert.ok(verwendet >= 1)
  // Hier stand `!/%ED…/.test(url)` — die Zeile konnte NIE ausloesen (Kalt-Review): fuer ein
  // halbes Paar emittiert `encodeURIComponent` kein `%ED`, es WIRFT. Der Sensor ist das
  // `doesNotThrow` darueber; geprueft wird hier stattdessen, dass die Emojis ganz geblieben
  // sind — ein zerschnittenes Paar waere ein U+FFFD im dekodierten Rumpf.
  const rumpf = decodeURIComponent(url.split('&body=')[1])
  assert.ok(!rumpf.includes('�'), 'kein Ersatzzeichen aus einem zerschnittenen Paar')
  assert.ok(rumpf.includes('😀'), 'die Emojis sind noch da')
})

test('KEINE Zeile im Rumpf ist laenger als MAX_ZEILE kodiert (#435)', () => {
  // Die Kern-Invariante des Fixes — und sie hatte NULL Abdeckung (gegnerisches Review):
  // die Mutation `const budget = max` (Kappmarke nicht eingerechnet) liefert eine Zeile mit
  // 618 kodierten Zeichen und liess alle 195 Tests gruen. Geprueft wird gegen die KONSTANTE,
  // nicht gegen eine abgeschriebene 600 — sonst ist der Test nach der ersten Wertaenderung
  // stumm.
  const zeilen = ['A'.repeat(1200), 'ä'.repeat(500), '😀'.repeat(400), 'x']
  const { url } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen })
  const rumpf = decodeURIComponent(url.split('&body=')[1])
  for (const z of rumpf.split('\n')) {
    const kodiert = encodeURIComponent(z).length
    assert.ok(kodiert <= MAX_ZEILE, `Zeile mit ${kodiert} kodierten Zeichen: ${z.slice(0, 40)}…`)
  }
})

test('eine 2-MB-Zeile bringt das Kappen nicht zum Stehen (#435)', () => {
  // Der krankhafte Fall ist gemessen, nicht erfunden: eine `window.open`-URL kommt mit bis
  // zu 2 MB am Handler an (#426). Zeichenweises Schrumpfen mit Neu-Kodieren waere hier
  // quadratisch — einmal kodieren allein kostet ~4 ms. Deshalb binaere Suche.
  const start = Date.now()
  const { verwendet } = mailto({
    empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['y'.repeat(2 * 1024 * 1024)],
  })
  const dauer = Date.now() - start
  assert.ok(verwendet >= 1, 'auch die 2-MB-Zeile kommt gekappt mit')
  assert.ok(dauer < 1000, `Kappen dauerte ${dauer} ms — die binaere Suche ist weg?`)
})

test('eine Kuerzung wird ANGESAGT', () => {
  const zeilen = Array.from({ length: 200 }, (_, i) => `Zeile ${i} mit etwas Text daran`)
  const kurz = decodeURIComponent(mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen }).url.split('&body=')[1])
  assert.ok(/gekuerzt/.test(kurz), 'ein stillschweigend halber Bericht sieht aus wie ein ganzer')
  const ganz = decodeURIComponent(mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['eine Zeile'] }).url.split('&body=')[1])
  assert.ok(!/gekuerzt/.test(ganz), 'und ein ganzer sagt es NICHT — sonst ist die Marke wertlos')
})

test('Sonderzeichen aus dem Protokoll brechen die URL nicht', () => {
  // `&` und `=` kommen in Pfaden und yt-dlp-Meldungen vor; unkodiert waere ab dort alles
  // ein neuer URL-Parameter, und der Rumpf endete mitten im Satz.
  const { url } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['a&b=c ?d #e'] })
  const teile = url.split('&body=')
  assert.strictEqual(teile.length, 2, 'genau EIN &body=')
  // Gemessen wird der ROHE Teil hinter `&body=`: `decodeURIComponent` allein waere hier
  // vacuous — es liefert auch aus einem UNkodierten Rumpf denselben Text zurueck, und die
  // Mutation „Rumpf unkodiert" blieb damit gruen. Kein `&`, `#` oder Umbruch darf roh
  // dastehen; jedes davon beendet den Rumpf im Mailprogramm mitten im Satz.
  assert.ok(!/[&#\n]/.test(teile[1]), `roh: ${teile[1]}`)
  assert.ok(decodeURIComponent(teile[1]).includes('a&b=c ?d #e'))
})

test('nur das @ bleibt roh — der Rest der Adresse wird weiter kodiert', () => {
  // Die Gegenrichtung zu B5: ein blankes `empfaenger` ohne Kodierung waere die Tuer, durch
  // die ein `?` oder `&` in der Adresse ein zweites Feld aufmachte.
  const { url } = mailto({ empfaenger: 'a b&c@x.y', betreff: 'x', kopf: K, zeilen: [] })
  assert.ok(url.startsWith('mailto:a%20b%26c@x.y?subject='), url.slice(0, 40))
  assert.strictEqual(url.split('&body=').length, 2, 'genau EIN &body=')
})

test('ohne Protokollzeilen kommt trotzdem eine brauchbare Mail', () => {
  const { url, gekuerzt } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: [] })
  assert.strictEqual(gekuerzt, false)
  // `@` bleibt roh (Reviewbefund B5): prozentkodiert ist `mailto:a%40b.c` streng gelesen eine
  // local-part ohne Domain. Der Rest der Adresse geht weiter durch encodeURIComponent.
  assert.ok(url.startsWith('mailto:a@b.c?subject=x&body='), url.slice(0, 40))
})

test('ohne Empfaenger wird geworfen statt eine Mail an niemanden zu oeffnen', () => {
  // `paket.author` darf ein String sein; `.email` waere dann undefined und die URL
  // `mailto:undefined?…` — ein Fenster, das aussieht, als haette es geklappt.
  assert.throws(() => mailto({ empfaenger: undefined, betreff: 'x', kopf: K, zeilen: [] }),
    /Kein Empfaenger/)
})

test('ein sehr langer Dateipfad sprengt den Deckel NICHT — er faellt zuletzt weg', () => {
  // Der einzige Teil, dessen Laenge wir nicht in der Hand haben: tiefe Ordner, langer
  // Benutzername, Netzlaufwerk. Ohne den letzten Schritt gab die Schleife nach der letzten
  // Protokollzeile eine URL ueber dem Deckel zurueck (CodeRabbit-Bot).
  const lang = 'C:\\' + 'sehr-tiefer-ordner\\'.repeat(120) + 'transkribor.log'
  const { url, verwendet } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K,
    zeilen: ['eine Zeile'], logpfad: lang })
  assert.ok(url.length <= MAX_URL, `URL ist ${url.length} Zeichen`)
  const rumpf = decodeURIComponent(url.split('&body=')[1])
  assert.ok(!rumpf.includes('sehr-tiefer-ordner'), 'der Pfad ist weg')
  // Und die Protokollzeile ueberlebt: der Pfad geht ZULETZT, nicht zuerst.
  assert.strictEqual(verwendet, 1)
  assert.ok(rumpf.includes('eine Zeile'))
})

test('ein normaler Pfad bleibt drin — die Notbremse greift nicht immer', () => {
  // Gegenrichtung: faellt der Pfad grundsaetzlich weg, verliert der Bericht den Hinweis,
  // was der Nutzer anhaengen kann.
  const { url } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['x'],
    logpfad: 'C:\\Users\\m\\AppData\\Roaming\\Transkribor\\transkribor.log' })
  assert.ok(decodeURIComponent(url.split('&body=')[1]).includes('transkribor.log'))
})

test('der Name einer Aufnahme steht in der FERTIGEN URL nicht mehr (#447)', () => {
  // Der Weg, den es wirklich gibt: Protokollzeile -> letzteZeilen -> mailto -> das, was der
  // Nutzer im Mailfenster sieht. Die Tests darueber pruefen ein Zwischenergebnis; dieser
  // prueft das Ergebnis.
  const zeilen = letzteZeilen(
    '[t] Navigation abgewiesen (Schema nicht erlaubt): file:///C:/Users/marcu/Videos/Interview%20Meier.mp3')
  const { url } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen,
    logpfad: 'C:\\Users\\m\\AppData\\Roaming\\Transkribor\\transkribor.log' })
  // BEIDE Schreibweisen: der Rumpf wird kodiert, aus `Interview%20Meier` wuerde dabei
  // `Interview%2520Meier` — eine Suche allein in der rohen URL waere immer gruen.
  assert.ok(!url.includes('Meier'), 'kein Aufnahmename in der rohen URL')
  const rumpf = decodeURIComponent(url.split('&body=')[1])
  assert.ok(!rumpf.includes('Meier'), 'auch nicht im dekodierten Rumpf')
  // Positivkontrolle, sonst prueft dieser Test auch dann nichts, wenn die Zeile GANZ fehlt.
  assert.ok(rumpf.includes('Navigation abgewiesen'), 'der Hinweis selbst bleibt stehen')
})
