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
 * Deckel fuer eine EINZELNE Zeile — ebenfalls kodiert gemessen (#435).
 *
 * **Warum es die Konstante gibt.** `mailto` kuerzte von OBEN, bis die URL passt. Sprengte
 * eine einzelne Zeile den Deckel schon allein, lief die Schleife bis auf NULL: der Nutzer
 * schickte einen Bericht ohne eine einzige Protokollzeile ab. Gemessen war die Zahl der
 * Ueberlebenden **exakt die Zahl der Zeilen DAHINTER** — Position 0 von 21 ⇒ 20 ueberleben,
 * Position 20 ⇒ keine. Der Extremfall ist dabei der Normalfall: Protokollzeilen werden
 * angehaengt, eine ueberlange kommt also als juengste an. Ausloesbar mit EINEM `window.open`
 * (#426: die URL kommt mit bis zu 2 MB am Handler an).
 *
 * Mit dieser Kappe gilt: keine Zeile ist laenger als 600 kodiert, der Kopf braucht rund 450,
 * `MAX_URL` sind 1900 ⇒ **es passt immer mindestens eine Zeile**, gleich welche Zeichen darin
 * stehen. Das ist die Zusicherung, nicht die Kuerzung selbst. Sie haengt am Dateipfad, und
 * genau deshalb reserviert `mitPfad` weiter unten Platz fuer eine gekappte Zeile — ohne das
 * waere „immer" falsch, und der Pfad ist laut dem Kommentar dort der eine unkontrollierte
 * Wert („tiefe Ordner, langer Benutzername, Netzlaufwerk").
 *
 * **Der Preis, und er ist der eigentliche neue Weg dieses Fixes:** vor der Kappe ueberlebte
 * eine ueberlange Zeile **nie** — die Schleife raeumte sie mit ab. Der leere Bericht war damit
 * nebenbei ein Filter, ausgerechnet fuer die Klasse, in der am ehesten ein Abzug steht
 * (`protokoll.befund`, Kommando-Echos, pip-Ausgaben, Server-stdout). Ab jetzt gehen die ersten
 * ~600 kodierten Zeichen solcher Zeilen mit. `protokoll.maskiere` laeuft davor und kennt fuenf
 * Schluesselformen (`sk-`, `sk-ant-`, `AIzaSy`, `gsk_`, `hf_`); alles andere passiert sie —
 * gemessen an einem Lizenzschluessel ohne bekanntes Muster: vorher 0 Zeilen und kein Geheimnis
 * in der Mail, nachher 11 Zeilen und das Geheimnis darin. **Kein Fehler des Fixes** (ein
 * Bericht ohne Protokoll ist wertlos, und die Zusage dieses Features ist die VORSCHAU vor dem
 * Senden), aber die ehrliche Antwort auf „was erlaubt er neu". Wer den Preis senken will, hat
 * einen billigen Hebel: 530 statt 600 traefe weiterhin null echte Zeilen — die laengste misst
 * 526 kodiert — und gaebe im krankhaften Fall 12 % weniger preis. 600 ist die getroffene
 * Entscheidung, nicht das Optimum.
 *
 * **Die Kappe macht den Bericht nie schlechter** (gemessen ueber 172 Fuelllaengen gegen die
 * nachgebaute Vorfassung: 68-mal mehr Zeilen, **0-mal weniger**, 104-mal gleich) — anders als
 * die `file:`-Ersetzung darunter, die ausdruecklich nicht monoton ist.
 * Nachfahrbar: `node docs/superpowers/specs/2026-08-28-bericht-kappe-messung/monotonie.js`,
 * Rohausgabe liegt daneben. Hier stand bis zuletzt „75-mal": die Zahl war gewandert, als der
 * Doppelpunkt aus `PFAD_AB_SCHEMA` fiel, und niemand konnte es sehen, weil das Messskript nur
 * im Wegwerf-Verzeichnis lag. Wer an Kappung, Maskierung oder Pfad-Ersetzung etwas aendert,
 * laesst es laufen und zieht die Zahlen hier nach.
 *
 * **600 KODIERT, nicht roh — und der Unterschied ist der ganze Punkt.** Eine Kappe auf die
 * rohe Laenge haelt die Zusicherung NICHT: 500 rohe Umlaute werden kodiert 3000 Zeichen lang,
 * und `verwendet` fiel damit wieder auf 0 (gefahren). Dieselbe Falle, vor der `MAX_URL` oben
 * warnt, eine Ebene tiefer.
 *
 * **Der Wert kostet heute nichts.** In den echten Protokollen dieser Maschine misst die
 * laengste mail-taugliche Zeile 373 roh / **526 kodiert**; ueber 600 liegt keine, ueber 500
 * genau eine. 600 trifft also **null** echte Zeilen und greift nur im krankhaften Fall.
 * (Gemessen am 28.08.2026 an lokalen, nicht versionierten Protokollen — sie tragen
 * Nutzerpfade und Aufnahmenamen und koennen deshalb nicht ins Repo; eine erfundene Fixture
 * belegte nur, dass niemand `file://` hineingeschrieben hat. Drei unabhaengig gebaute
 * Herleitungen: node mit dem echten Filter, grep/awk mit nachgebautem, python mit eigenen
 * Regexen.)
 */
const MAX_ZEILE = 600

/** Die gekappte Zeile sagt es an — ein stillschweigend halber Bericht sieht aus wie ein ganzer. */
const KAPPMARKE = ' […]'

/**
 * Kappt EINE Zeile auf `max` KODIERTE Zeichen und haengt die Marke an.
 *
 * **Ueber Codepoints, nicht ueber `slice()`.** `'abc😀def'.slice(0, 4)` trennt ein
 * Ersatzzeichenpaar, und `encodeURIComponent` wirft darauf `URIError: URI malformed`
 * (gefahren) — ein Absturz in genau der Funktion, die den Fehlerbericht rettet.
 *
 * **Binaere Suche, nicht zeichenweise schrumpfen.** Der krankhafte Fall ist 2 MB gross;
 * einmal kodieren kostet dort ~4 ms, ein `while`-Schrumpfen mit Neu-Kodieren waere
 * quadratisch. So sind es **rund 20** statt Millionen — `log2` der Codepoint-Zahl, bei 2 MB
 * also 21 Halbierungen (nachgezaehlt mit einem zaehlenden `encodeURIComponent`: 26 im ganzen
 * `mailto`-Lauf, davon 6 im URL-Bau). Der eine Ort in dieser Datei, an dem der Aufwand belegt
 * ist und nicht vermutet.
 *
 * **Gekappt wird der SCHWANZ — eine Richtungsentscheidung, die hier benannt gehoert.**
 * `mailto` kuerzt bewusst von OBEN, mit dem Argument „die juengsten Zeilen stehen dem Fehler am
 * naechsten". Innerhalb einer Zeile gilt das spiegelverkehrt: bei `CalledProcessError: Command
 * '[…]' returned non-zero exit status 1` oder `…: No such file or directory` steht das Urteil
 * HINTEN. Die Kappe wirft es weg. Getragen, weil die Zeile vor diesem Fix ueberhaupt nicht
 * mitkam — aber es ist eine Entscheidung, keine Selbstverstaendlichkeit. Wer sie umdreht:
 * Kopf plus Marke plus ein Stueck Schwanz.
 */
function kappen(zeile, max = MAX_ZEILE) {
  if (encodeURIComponent(zeile).length <= max) return zeile
  const budget = max - encodeURIComponent(KAPPMARKE).length
  const zeichen = Array.from(zeile)
  const passt = n => encodeURIComponent(zeichen.slice(0, n).join('')).length <= budget
  let lo = 0
  let hi = zeichen.length
  while (lo < hi) {
    const mitte = Math.ceil((lo + hi) / 2)
    if (passt(mitte)) lo = mitte
    else hi = mitte - 1
  }
  return zeichen.slice(0, lo).join('') + KAPPMARKE
}

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
 * Abweisungs-Diagnose aus `main.js` — gedeckelt statt aussortiert (#506).
 *
 * **Das Problem war die Verdraengung, nicht die Zeile.** `mailto` kuerzt von OBEN, die
 * Abweisungszeilen stehen als juengste ganz unten, und der Rumpf traegt wenig: gemessen an
 * diesem `bericht.js` (echter Kopf, echter Logpfad) passen je nach Zeilenlaenge **2 bis 22**
 * Zeilen hinein — 50 Zeichen ⇒ 22, 200 ⇒ 6, 600 ⇒ 2. Mit 40 FEHLER- und danach 20
 * Abweisungszeilen kamen **0 von 11** echten Zeilen in der Mail an.
 *
 * **Deshalb 1 und nicht 3.** Der kleinste gemessene Rumpf traegt zwei Zeilen; jeder Deckel
 * ueber 1 kann ihn also vollstaendig belegen, und die Zusage („mindestens eine echte Zeile")
 * gaelte nur im guenstigen Fall. Mit 1 bleibt die juengste Abweisung erhalten — die Antwort
 * auf „ich klicke auf einen Link und es passiert nichts" — und daneben ist echte Spur.
 *
 * **Der Deckel allein reicht dafuer NICHT, und das ist die eigentliche Zusicherung.** „Zwei
 * Zeilen passen" ist keine Eigenschaft der Auswahl hier, sondern eine von `mailto`: die
 * ueberlebende Abweisung ist die JUENGSTE und steht ganz unten, also genau dort, wo das
 * Kuerzen von oben aufhoert. Erst weil `mitPfad` weiter unten Platz fuer ZWEI Zeilen
 * reserviert, gilt der Satz — bei langem Ablagepfad trug der Rumpf sonst eine einzige Zeile,
 * und das war die Abweisung (gemessen, Einzelheiten dort).
 *
 * **Nicht aussortiert**, obwohl das eine Zeile weniger waere: die Diagnose ist der einzige
 * Grund, aus dem ein abgewiesener Link je auffaellt. Gedeckelt behaelt sie beides.
 *
 * **Beide Formen gehoeren in DIESELBE Gruppe.** `abweisungProtokollieren` schreibt ab dem
 * 21. Ziel die Schlusszeile „Weitere Abweisungen …" — zaehlte sie separat, stuenden im
 * 2-Zeilen-Rumpf zwei Diagnosezeilen und die Zusage fiele durch die andere Tuer.
 *
 * **Im Flutfall ist die juengste Abweisung genau diese Schlusszeile** — gemessen: 20
 * Abweisungen plus Schlusszeile ergeben hier die Schlusszeile, nicht die letzte echte. Das
 * ist gewollt (sie sagt, dass ab hier geschwiegen wird), war aber inhaltsleer: sie nannte
 * weder Art noch Ziel noch Grund. Seit #506 traegt sie den ersten unterdrueckten Vorgang mit,
 * womit die eine ueberlebende Zeile auch im Flutfall eine Auskunft ist. **Was sie NICHT
 * heilt:** wer nach der Flut auf einen Link klickt, hinterlaesst fuer den Rest der Stunde
 * ueberhaupt keine Zeile — der geteilte Deckel laesst eine Art die andere verstummen. Das ist
 * eine getragene Grenze mit eigenem Mechanismus, kein Versehen (#520).
 * Das Muster trifft ueber `… abgewiesen (…): …` auch die Berechtigungs- und
 * webview-Abweisungen aus #446, und genau so ist es gemeint: ein Berechtigungssturm darf den
 * Fehlerbericht so wenig vergiften wie eine Linkflut.
 *
 * **Es ist bewusst ein INHALTSMUSTER und bewusst breit.** Es kennt keine Absenderliste, also
 * traefe es auch eine kuenftige fremde Zeile der Form „Job abgewiesen (Sperre aktiv): x" —
 * die fiele ab der zweiten still aus dem Bericht. Heute gibt es dafuer keinen Erzeuger
 * (gegrept ueber `webtool/` und `electron/`), und die Fehlerrichtung ist die gewollte:
 * dieselbe Regel wie `=== false` statt `!` bei den Navigationswachen (#266) — ein unbekannter
 * Wert darf eine Bremse nie stillschweigend abschalten. Eine Praefixliste
 * (`Externer Link|Navigation|…`) waere praeziser und genau deshalb schlechter: eine neue
 * Abweisungsart entkaeme dem Deckel, ohne dass es jemand merkt.
 *
 * **Und die Auswahl reicht weiter zurueck als `n` Eintraege.** Ueberspringt sie Abweisungen,
 * fuellt sie die frei gewordenen Plaetze mit AELTEREN Zeilen — nach einer Flut also mit
 * Zeilen von weiter oben (`Umgebungsbefund`, pip-Ausgaben, der Kopf eines frueheren Laufs).
 * Gewollt: ein leerer Platz waere schlechter als eine aeltere echte Zeile. Der Preis ist, dass
 * die bekannte Grenze von `protokoll.maskiere` (fuenf Schluesselformen, #435) jetzt weiter
 * zurueck reicht — dieselbe Klasse, groesseres Fenster.
 */
const ABWEISUNG = [
  / abgewiesen \([^)]*\): /,
  /Weitere Abweisungen werden nicht mehr protokolliert/,
]
const ABWEISUNGEN_IM_BERICHT = 1

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
 * Leerzeichen, sonst haengt die Wache doch wieder an Chromium. Das „(gemessen)" hat seit dem
 * Bot-Vorabcheck einen Sensor: `test_url_kanonisiert_die_schreibweisen` schickt genau diese
 * Eingaben durch `new URL()` und sichert die Ausgaben zu — aendert eine Node- oder
 * Electron-Fassung das Verhalten, wird der Test rot statt der Kommentar still falsch.
 * **Der blosse `file:` ohne Trenner bleibt bewusst draussen:** englische Fehlertexte lauten
 * „could not open file: C:\…", und dieser Pfad ist die Diagnose, nicht der Abfluss. Beide
 * Richtungen im Test.
 *
 * **Der Praefix-Riegel macht aus dem Muster eine Regel ueber das SCHEMA statt ueber die
 * Zeichenfolge.** `logfile:///…` und `profile://…` sind ANDERE Schemata und gehen diese
 * Kuerzung nichts an (Negativkontrollen im Test).
 *
 * Hier stand zuerst ein blosses `\b`, und das war **zu wenig** — gefunden vom CodeRabbit-Bot
 * am PR, nachgemessen: ein Schema darf nach RFC 3986 §3.1 ausser Buchstaben und Ziffern auch
 * `+`, `-` und `.` enthalten, und zwischen `-` und `f` gibt es eine Wortgrenze.
 * `profile-file:///C:/…`, `x+file:///…` und `a.file:///…` wurden also gekuerzt, obwohl der
 * Absatz darueber das Gegenteil versprach. Nicht der Code war zu eng, die Behauptung war zu
 * breit — dieselbe Fehlerklasse, die dieses Repo am haeufigsten trifft.
 *
 * Deshalb ein Praefix-Riegel statt `\b`; die Klasse steht unten am Muster, damit dieser Text
 * sie nicht ein zweites Mal — und womoeglich falsch — behauptet. (Hier stand eine Fassung mit
 * `…` als Auslassungszeichen: wer sie als Zeichenklasse liest, bekommt die UMGEKEHRTE
 * Auskunft, denn eine Zeile mit `…` vor `file:` wird sehr wohl gekuerzt.) Das eingefangene
 * Zeichen kommt ueber `$1` zurueck, sonst frisst die Ersetzung das Leerzeichen vor der URL
 * gleich mit.
 *
 * **Und dieselbe Luecke eine Runde spaeter noch einmal: `/` und `\` gehoeren mit
 * ausgeschlossen** (CodeRabbit-Bot an PR #457). Nach einem Trennzeichen steht `file:` gar
 * nicht an einer Schema-Position — dort ist es Host oder Pfadsegment. Gemessen:
 *
 *     https://file:///C:/…/Interview.mp3        wurde gekuerzt, "file" ist der HOST
 *     https://beispiel.test/a/file:///x         wurde gekuerzt, / mitten im Pfad
 *     C:\file:///x                              wurde gekuerzt
 *
 * **Der Doppelpunkt gehoert AUSDRUECKLICH NICHT dazu — eine Kehrtwende innerhalb derselben
 * Runde.** Der Bot hatte ihn mitvermutet (`mailto:file:///x`), gemessen stimmte es, und er
 * stand hier eine Fassung lang im Ausschluss. Die CodeRabbit-CLI hielt dagegen, mit dem
 * staerkeren Argument: ein Doppelpunkt ist im Deutschen gewoehnliche Zeichensetzung. Mit ihm
 * im Riegel blieb `Quelle:file:///C:/Users/<name>/Interview.mp3` **ungekuerzt stehen**
 * (gefahren) — ein echter lokaler Pfad samt Aufnahmenamen, also genau der Abfluss, den diese
 * Kuerzung verhindern soll. Der Preis der Rueckkehr ist `mailto:file:///x`, das nun
 * mitgekuerzt wird: dessen Rumpf ist der undurchsichtige Teil einer Mailadresse und traegt
 * keinen lokalen Pfad. **Die Fehlerrichtung entscheidet** — zu viel kuerzen kostet Diagnose,
 * zu wenig kuerzen kostet die Zusage.
 *
 * Bemerkenswert ist die Wiederholung: beim ersten Mal fehlten die Schema-Zeichen `+.-`, beim
 * zweiten die Trennzeichen, beim dritten war einer davon zu viel — dieselbe Frage („steht
 * `file:` hier ueberhaupt am Anfang eines Schemas?"), dreimal anders beantwortet. Jede Form
 * hat eine eigene Zeile im Test, in beide Richtungen.
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
const PFAD_AB_SCHEMA = /(^|[^A-Za-z0-9+.\-/\\])file:[\/\\]{1,3}.*/i
const PFAD_ERSATZ = '$1file:///… (Pfad entfernt)'

/**
 * Die letzten `n` verwertbaren Zeilen, in Originalreihenfolge.
 *
 * Gewaehlt wird von HINTEN, weil der Deckel aus `ABWEISUNGEN_IM_BERICHT` die juengste
 * Abweisungszeile behalten soll und die aelteren wegfallen (#506). Ein blosses `slice` vom
 * Ende koennte das nicht: es nimmt einen Block, keine Auswahl.
 */
function letzteZeilen(text, n = ZEILEN) {
  const alle = String(text || '').split(/\r?\n/)
    .filter(z => z.trim() !== '' && !AUSSORTIEREN.some(r => r.test(z)))
  const gewaehlt = []
  let abweisungen = 0
  for (let i = alle.length - 1; i >= 0 && gewaehlt.length < n; i--) {
    if (ABWEISUNG.some(r => r.test(alle[i])) && ++abweisungen > ABWEISUNGEN_IM_BERICHT) continue
    gewaehlt.push(alle[i])
  }
  return gewaehlt.reverse()
    .map(z => z.replace(PFAD_AB_SCHEMA, PFAD_ERSATZ))
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
  //
  // **Und er wird mit PLATZ FUER EINE ZEILE geprueft, nicht mit null** (#435, Kalt-Review).
  // Die Frage „passt der Pfad?" wurde bis dahin an einem Rumpf OHNE Protokollzeilen gemessen.
  // Ein Pfad, der allein passt, aber weniger Luft laesst als eine gekappte Zeile braucht,
  // verdraengte damit ALLE Zeilen — das #435-Symptom durch die andere Tuer, und die Zusicherung
  // an `MAX_ZEILE` („es passt immer mindestens eine") war schlicht falsch. Gefahren, mit Zeilen
  // an der Kappungsgrenze: ab 688 Zeichen Pfad kamen null Protokollzeilen mit, waehrend die
  // URL nur 1306 von 1900 Zeichen nutzte. Reserviert werden `MAX_ZEILE` plus 3 fuer den
  // `%0A`-Umbruch, der die Zeile an den Rumpf haengt.
  //
  // Die Richtung ist dieselbe wie im Absatz darueber: im Zweifel gewinnen die Protokollzeilen,
  // weil der Pfad ohnehin im Dateimanager vor dem Nutzer steht.
  //
  // **Reserviert werden ZWEI Zeilen, sobald es zwei gibt (#506).** Mit EINER Reserve sicherte
  // `mailto` baulich genau EINE Zeile zu — und seit dem Abweisungs-Deckel eine Zeile weiter
  // oben ist das zu wenig: die eine ueberlebende Abweisung ist die JUENGSTE, steht also ganz
  // unten und ist damit genau die Zeile, die das Kuerzen von oben stehen laesst. Die Zusage
  // „mindestens eine echte Zeile" fiel damit durch die Hintertuer. Gemessen ueber 117
  // Pfadlaengen von 20 bis 619 Zeichen (40 FEHLER-Zeilen + 20 Abweisungen, alle an der
  // 600er-Kappe): **ab 294 Zeichen Pfad trug der Rumpf nur noch eine Zeile und keine echte**,
  // 66 der 117 Laengen waren betroffen; mit der Reserve auf zwei sind es **0 von 117**. Der
  // Preis ist benannt und derselbe Grundsatz wie oben: bei so langen Pfaden faellt der Pfad
  // aus der Mail — im Dateimanager steht er ohnehin vor dem Nutzer.
  //
  // `Math.min(zeilen.length, 2)`, nicht pauschal zwei: gibt es nur EINE Zeile, kann sie auch
  // nur eine sein, und eine unnoetig grosse Reserve wuerfe den Pfad grundlos hinaus (die
  // Gegenrichtung hat einen eigenen Test).
  const mitPfad = !!logpfad
    && url(bauen([], true)).length <= maxUrl - Math.min(zeilen.length, 2) * (MAX_ZEILE + 3)
  // `z => kappen(z)`, NICHT `.map(kappen)`: `map` reicht den Index als zweites Argument
  // durch, und der landete als `max` in der Kappe — Zeile 0 waere auf 0 Zeichen gekuerzt.
  let verwendet = zeilen.map(z => kappen(z))
  let fertig = url(bauen(verwendet, false, mitPfad))
  while (fertig.length > maxUrl && verwendet.length > 0) {
    verwendet = verwendet.slice(1)
    fertig = url(bauen(verwendet, true, mitPfad))
  }
  // **`gekuerzt` meldet WEGGELASSENE Zeilen, nicht innerlich gekappte.** Wurde nur gekappt, ist
  // es `false` und die Ueberschrift lautet „— Protokoll —". Fuer den Nutzer gedeckt: die Marke
  // ` […]` steht in der Zeile, die er im Mailfenster vor sich hat. Der Rueckgabewert hat heute
  // keinen Verbraucher, der daran haengt (`VersionPage.berichtSchreiben` wirft ihn weg) — wer
  // daraus einmal „Bericht vollstaendig" baut, braucht ein drittes Feld `gekappt`.
  return { url: fertig, verwendet: verwendet.length, gekuerzt: verwendet.length < zeilen.length }
}

// `MAX_ZEILE` wird exportiert, damit der Test die Invariante gegen DIE Konstante pruefen kann
// statt gegen eine abgeschriebene 600 — sonst waere er nach der ersten Wertaenderung stumm.
module.exports = {
  letzteZeilen, kopf, mailto, MAX_URL, MAX_ZEILE, ZEILEN, AUSSORTIEREN,
  ABWEISUNG, ABWEISUNGEN_IM_BERICHT,
}
