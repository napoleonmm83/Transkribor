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
