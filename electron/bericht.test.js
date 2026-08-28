'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { letzteZeilen, kopf, mailto, MAX_URL } = require('./bericht')

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
  ].join('\n'))
  assert.deepStrictEqual(z, [
    '[t] venvPfad = C:\\Users\\marcu\\AppData\\Roaming\\Transkribor\\venv',
    '[t] INFO:     127.0.0.1:60884 - "POST /api/projects/X/audio HTTP/1.1" 500 Internal Server Error',
    '[t] could not open file: C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] profile://default/x',
    '[t] profile-file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] x+file:///C:/Users/marcu/Videos/Interview Meier.mp3',
    '[t] a.file:///C:/Users/marcu/Videos/Interview Meier.mp3',
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
  // Jede EINZELNE Zeile sprengt den Deckel — es bleibt nichts zum Mitnehmen uebrig.
  const zeilen = ['x'.repeat(3000), 'y'.repeat(3000)]
  const { url, verwendet } = mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen })
  assert.strictEqual(verwendet, 0)
  assert.ok(decodeURIComponent(url.split('&body=')[1]).includes('0.48.1'),
    'eine Mail mit Fassung und Plattform ist mehr als keine')
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
