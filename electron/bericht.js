'use strict'
/**
 * Fehlerbericht per `mailto:` (#372) — die Entscheidungen als reine Funktionen, damit sie
 * einen Test haben (Muster wie `fenster.fensterOptionen` und `updater.macUrls`).
 *
 * **Warum `mailto` und nicht ein eigener Dienst:** kein Konto, kein Empfaengerserver, keine
 * Aufbewahrungsfrist — und die Vorschau ist gratis. Der Text steht im Mailprogramm des
 * Nutzers, BEVOR er sendet; das ist die Antwort auf „was darf mit?" aus dem Issue. Ein
 * Filter, dem man vertrauen muesste, waere teurer und schwaecher.
 *
 * **Was NICHT mitgeht: der volle PATH.** Er steht im Protokollkopf (`protokoll.kopf`) und
 * traegt den Benutzernamen; im Rumpf einer Mail waere er ein Datum, das der Nutzer
 * mitschickt, ohne es gesucht zu haben. Wer ihn braucht, bekommt ihn ueber die Datei, die
 * daneben im Dateimanager aufgeht — das ist dann eine Entscheidung, kein Nebeneffekt.
 * Aus demselben Grund steht der Pfad IM Rumpf: der Nutzer soll wissen, was er anhaengen
 * kann, nicht suchen muessen.
 */

/**
 * Deckel fuer die FERTIGE, kodierte URL.
 *
 * Gemessen wird die kodierte Laenge, nicht die rohe — und das ist der ganze Punkt dieser
 * Konstante: `encodeURIComponent` macht aus jedem Zeilenumbruch `%0A` und aus jedem Umlaut
 * zwei Prozentgruppen, ein Rumpf aus 1800 Zeichen wird also leicht 3000 Zeichen URL. Windows
 * reicht `ShellExecute` rund 2048 Zeichen durch; darueber passiert entweder nichts oder der
 * Rumpf kommt abgeschnitten an. 1900 laesst Luft fuer den Empfaenger und den Betreff.
 */
const MAX_URL = 1900

/** Wie viele Protokollzeilen ueberhaupt in Betracht kommen, bevor der Deckel kuerzt. */
const ZEILEN = 60

/**
 * Zeilen, die NIE in den Rumpf gehen.
 *
 * Bisher genau eine: die PATH-Zeile aus `protokoll.kopf`. **Der tragende Grund ist die
 * LAENGE**: sie ist auf dieser Maschine ueber 1000 Zeichen lang und fraesse den halben
 * URL-Deckel fuer eine Auskunft, die in der DATEI danebensteht.
 *
 * Dass sie zusaetzlich den Benutzernamen traegt, ist ein Nebeneffekt und **kein**
 * Datenschutzversprechen — das waere am echten Protokoll gemessen falsch: der Benutzername
 * steht ueber `logpfad`, `stempelPfad`, `venvPfad` und `projektePfad` ohnehin viermal im
 * Rumpf (Reviewbefund B2), und der `Umgebungsbefund`, aus dem sie stammen, ist der
 * nuetzlichste Block darin. Die Zusage dieses Features ist die VORSCHAU, nicht ein Filter.
 * Die Datei behaelt die Zeile: wer sie anhaengt, entscheidet sich dafuer.
 *
 * Die zweite ist GEMESSEN, nicht vermutet, und ohne sie waere dieses Feature wirkungslos:
 * an einem echten Protokoll dieser Maschine (484 KB, 5113 Zeilen) sind **89,1 %**
 * uvicorn-Zugriffszeilen — der 60-Sekunden-Poll auf `/api/projects` laeuft, solange die App
 * offen steht. Die letzten 60 Zeilen waren zu **100 %** davon, und in die Mail passten
 * genau zehn: zehnmal `GET /api/projects 200 OK`. Ein Bericht, in dem der Fehler garantiert
 * NICHT steht.
 *
 * **Nur 2xx/3xx fliegen raus.** Ein `403` oder `500` ist die Zeile, wegen der jemand
 * schreibt — die Statusgruppe steht deshalb in der Regex, und die Gegenrichtung hat einen
 * eigenen Test. (Im gemessenen Protokoll: 0 solche Zeilen. Genau deshalb duerfen sie nicht
 * mit weggeworfen werden — sie sind selten und tragen alles.)
 */
const AUSSORTIEREN = [
  /\bPATH\s*:/,
  / - "(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) [^"]*" [23]\d\d/,
]

/**
 * Was GEKUERZT statt weggelassen wird: der Pfad hinter einem `file:`-Schema (#447).
 *
 * Seit dem `will-navigate`-Waechter (#434) protokolliert ein Fehlwurf beim Drag & Drop die
 * abgewiesene Navigation — samt Ort UND Namen der Aufnahme, und die Zeile faehrt hier mit.
 * Der Pfad hat in der Mail keinen Diagnosewert: WELCHE Datei jemand danebenwarf, hilft
 * niemandem. Die Zeile selbst schon — sie ist die einzige Antwort auf „ich habe etwas ins
 * Fenster gezogen und es passiert nichts". Deshalb kuerzen und nicht aussortieren.
 *
 * **Bis ZEILENENDE, nicht bis zum naechsten Leerzeichen.** Mit `\S*` endete die Ersetzung bei
 * `file:///C:/My Videos/Interview Meier.mp3` nach `My` — und ausgerechnet der Dateiname bliebe
 * stehen. Chromium normalisiert Leerzeichen zwar zu `%20`, aber dann haengt diese Wache an
 * einer fremden Zusicherung statt an sich selbst. Der Preis (Text HINTER einer `file:`-URL
 * faellt mit weg) ist gemessen null: in 49 035 echten Protokollzeilen dieser Maschine
 * (`transkribor.log` + `.1` + `.2`) kommt `file://` **0-mal** vor — und der Sensor konnte den
 * Fall sehen: **775** pip-Zeilen liegen darin (768 „Requirement already satisfied" + 6
 * „Looking in" + 1), und pips `Requirement already satisfied: x from file:///…` ist der
 * plausibelste Erzeuger von Text HINTER einer `file:`-URL. Keine einzige traegt eine.
 *
 * **„Null" gilt dem TEXT, nicht der Zeilenzahl.** Der Ersatz ist kodiert 45 Zeichen lang, eine
 * kuerzere `file:`-URL macht die Zeile also laenger — und `mailto` deckelt kodiert. Gemessen
 * ueber 81 Fuelllaengen: beim echten Ablagepfad passt in 20 Faellen eine Zeile MEHR in die Mail
 * und nie eine weniger; bei einer nackten `file:///`-URL genau eine weniger. Netto ein Gewinn,
 * aber nicht monoton.
 *
 * **Ein bis drei Trenner, Schraegstrich ODER Rueckstrich, aus demselben Grund.** `new URL()`
 * macht aus `file:/C:/x` und `file:C:/x` beides `file:///C:/x` (gemessen), und `file:\C:\x` ist
 * dieselbe Frage mit dem Windows-Trenner — verlassen wollen wir uns darauf so wenig wie beim
 * Leerzeichen, sonst haengt die Wache doch wieder an Chromium. **Der blosse `file:` ohne Trenner
 * bleibt bewusst draussen:** englische Fehlertexte lauten „could not open file: C:\…", und
 * dieser Pfad ist die Diagnose, nicht der Abfluss. Beide Richtungen im Test.
 *
 * **Das `\b` gehoert dazu und bleibt.** Es macht aus dem Muster eine Regel ueber das SCHEMA
 * `file:` statt ueber die Zeichenfolge `file:`; `logfile:///…` und `profile://…` sind ANDERE
 * Schemata und gehen diese Kuerzung nichts an (Negativkontrolle im Test). Ohne `\b` kuerzte die
 * Wache jedes Wort mit, das zufaellig auf `file` endet — und liesse sich nicht mehr in einem
 * Satz sagen.
 *
 * **Das `i` ist kein Schmuck — es hat einen eigenen Testfall, weil es sonst keinen haette.**
 * Bei entferntem Flag blieb die Suite 20/20 gruen (Mutation C des gegnerischen Reviews); ein
 * Waechter, der auch ohne seine Logik gruen bleibt, ist Dekoration. Schemata sind nach
 * RFC 3986 §3.1 gross-/kleinschreibungsunabhaengig — dass Chromium sie klein liefert, ist
 * wieder nur eine fremde Zusicherung.
 *
 * **Nicht in `protokoll.SENSIBLE_MUSTER`**, obwohl dort schon maskiert wird: das greift beim
 * SCHREIBEN, und das lokale Protokoll soll den Pfad behalten. Die Zusage gilt der Mail.
 *
 * Die Grenze gehoert dazu: Projekt- und Basisnamen stehen weiter in gescheiterten
 * Zugriffszeilen (`POST /api/projects/X/audio … 500`). Das ist die Zeile, wegen der jemand
 * schreibt, sie bleibt bewusst — so steht es auch in der README.
 */
const PFAD_AB_SCHEMA = /\bfile:[\/\\]{1,3}.*/i

/** Die letzten `n` verwertbaren Zeilen, in Originalreihenfolge. */
function letzteZeilen(text, n = ZEILEN) {
  const alle = String(text || '').split(/\r?\n/)
    .filter(z => z.trim() !== '' && !AUSSORTIEREN.some(r => r.test(z)))
  return alle.slice(Math.max(0, alle.length - n))
    .map(z => z.replace(PFAD_AB_SCHEMA, 'file:///… (Pfad entfernt)'))
}

/**
 * Der Kopf des Berichts: was man zuerst wissen will, ohne die Datei zu oeffnen.
 * Bewusst kurz — er ueberlebt jede Kuerzung, jede Zeile hier geht also von den
 * Protokollzeilen ab.
 */
function kopf({ version, plattform, arch, electron, node, gepackt }) {
  return [
    `Transkribor : ${version}`,
    `Plattform   : ${plattform} ${arch}`,
    `Electron    : ${electron} | Node ${node}`,
    `Gepackt     : ${gepackt}`,
  ]
}

/**
 * Baut die `mailto:`-URL und kuerzt den Protokollteil, bis die KODIERTE URL unter `maxUrl`
 * liegt.
 *
 * **Gekuerzt wird von OBEN.** Die juengsten Zeilen stehen dem Fehler am naechsten; wer von
 * unten kuerzt, wirft genau die weg, wegen derer jemand schreibt. Dass gekuerzt wurde, steht
 * im Rumpf — ein stillschweigend halber Bericht sieht aus wie ein vollstaendiger.
 *
 * Passt nicht einmal der Kopf, kommt die URL trotzdem (ohne Protokollteil): eine Mail mit
 * Fassung und Plattform ist mehr als keine.
 */
function mailto({ empfaenger, betreff, kopf: kopfzeilen, zeilen, logpfad, maxUrl = MAX_URL }) {
  // `paket.author` darf laut npm auch ein STRING sein — dann ist `.email` undefined und die
  // URL waere `mailto:undefined?…`: ein Mailfenster an niemanden, das aussieht, als haette es
  // geklappt. Lieber ein Wurf, den der Toast im Fenster nennt (Reviewbefund B5).
  if (!empfaenger) throw new Error('Kein Empfaenger fuer den Fehlerbericht hinterlegt')
  const bauen = (verwendet, gekuerzt, mitPfad = true) => [
    ...kopfzeilen,
    '',
    'Was ist passiert?',
    '',
    '',
    // NICHT "vollstaendiges Protokoll": `protokoll.js` rotiert bei 2 MB ueber bis zu drei
    // Generationen, direkt nach einer Rotation ist diese Datei fast leer (Reviewbefund B4).
    logpfad && mitPfad ? `Protokolldatei (zum Anhaengen; aeltere Teile liegen als .1 bis .3 daneben):\n${logpfad}` : null,
    '',
    gekuerzt ? `— letzte ${verwendet.length} Protokollzeilen (gekuerzt) —` : '— Protokoll —',
    ...verwendet,
  ].filter(z => z !== null).join('\n')

  // Das `@` bleibt ROH. Nach RFC 6068 ist es in `addr-spec` ein Trenner; prozentkodiert ist
  // `mailto:a%40b.c` streng gelesen eine local-part ohne Domain (RFC 3986 §2.4: ein kodiertes
  // reserviertes Zeichen bedeutet nicht dasselbe wie das rohe). Die meisten Clients dekodieren
  // vorher — **hier nicht nachgemessen**, es gibt in dieser Umgebung kein Mailprogramm. Die
  // Adresse ist eine Konstante aus der package.json, die sichere Fassung kostet also nichts.
  const url = rumpf => 'mailto:' + encodeURIComponent(empfaenger).replace(/%40/g, '@')
    + '?subject=' + encodeURIComponent(betreff)
    + '&body=' + encodeURIComponent(rumpf)

  // **Der Dateipfad wird ZUERST geprueft, nicht zuletzt.** Er ist der einzige Teil, dessen
  // Laenge wir nicht in der Hand haben (tiefe Ordner, langer Benutzername, Netzlaufwerk);
  // ohne diese Frage leerte die Schleife erst alle Protokollzeilen und gaebe DANN immer noch
  // eine URL ueber dem Deckel zurueck (CodeRabbit-Bot) — die schneidet Windows selbst ab, an
  // beliebiger Stelle. Passt er nicht einmal mit NULL Zeilen, ist er der Ballast, nicht sie:
  // im Dateimanager steht er ohnehin vor dem Nutzer, die Protokollzeilen bekaeme er nirgends.
  const mitPfad = !!logpfad && url(bauen([], true)).length <= maxUrl
  let verwendet = zeilen.slice()
  let fertig = url(bauen(verwendet, false, mitPfad))
  while (fertig.length > maxUrl && verwendet.length > 0) {
    verwendet = verwendet.slice(1)
    fertig = url(bauen(verwendet, true, mitPfad))
  }
  return { url: fertig, verwendet: verwendet.length, gekuerzt: verwendet.length < zeilen.length }
}

module.exports = { letzteZeilen, kopf, mailto, MAX_URL, ZEILEN, AUSSORTIEREN }
