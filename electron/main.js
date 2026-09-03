'use strict'
/**
 * Ablauf beim Start: Fenster mit Statusseite -> Python-Umgebung pruefen (ggf. einrichten)
 * -> uvicorn starten -> auf "antwortet" warten -> das Web-Tool laden.
 *
 * Das Fenster kommt ZUERST, nicht der Server: die Einrichtung dauert beim ersten Mal Minuten,
 * und ein Nutzer, der so lange auf nichts schaut, haelt die App fuer kaputt.
 */
const { app, BrowserWindow, ipcMain, shell, nativeTheme, net } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
// Nur fuer den Vergleich in `navigationPruefen`: die Statusseite laedt `loadFile` mit einem
// PFAD, am Waechter kommt sie als `file:`-URL an. Beide Formen muessen aus derselben Quelle
// stammen, sonst sperrt der Waechter ausgerechnet die Einrichtungsseite aus.
const { pathToFileURL } = require('url')
const backend = require('./backend')
const setup = require('./setup')
const protokoll = require('./protokoll')
const bericht = require('./bericht')
const updater = require('./updater')
const fehlerberichte = require('./fehlerberichte')
const P = require('./paths')
const {
  fensterOptionen, TITELLEISTE_HOEHE, farbeGueltig, fortschrittGueltig, externesZiel,
  abweisungsGrund, eigeneHerkunft,
} = require('./fenster')

/** Die EINE Quelle fuer die Statusseite — `loadFile` und der Navigationswaechter (#434). */
const SETUP_HTML = path.join(__dirname, 'setup.html')

/**
 * Die package.json der App — gepackt liegt sie im asar, und electron-builder legt dort per
 * `-c.extraMetadata.bugsinkDsn=…` (release.yml) den DSN hinein. Ein DSN ist ein
 * Client-Schluessel, kein Geheimnis: er steckt in jeder ausgelieferten App. Im Repo steht er
 * nicht (oeffentlich, und GitGuardian kennt die Form); ohne ihn ist das SDK aus.
 */
const paket = require('../package.json')

/** Der Opt-in-Schalter lebt in `userData` (#530). Zur LAUFZEIT aufgeloest, nicht beim Laden,
 *  damit die Tests je Lauf ein frisches Verzeichnis geben koennen. */
function schalterPfad() { return fehlerberichte.pfad(app.getPath('userData')) }

/** Die Projekte-Wurzel, wie der SERVER sie kennt — die `.env` darf `TRANSKRIBOR_PROJEKTE`
 *  ueberschreiben (#218), und dann laese die Namensmaske aus `P.projekte` einen leeren Ordner.
 *  Bis der Server geantwortet hat, gilt `P.projekte`. */
let projekteWurzel = null

// Opt-in Fehlerberichte (#530): das SDK VOR allem anderen — es haengt sich an
// `uncaughtException` und `unhandledRejection`, was davor wirft, sieht es nicht. Ohne DSN
// (Entwicklerlauf, Testbau ohne Secret) ist es `enabled: false`; und mit DSN verlaesst kein
// Byte die Maschine, solange der Schalter AUS ist — das entscheidet `fehlerberichte.beforeSend`
// je Ereignis, nicht ein Zweig hier.
const Sentry = require('@sentry/electron/main')
Sentry.init(fehlerberichte.optionen({
  dsn: paket.bugsinkDsn,
  version: app.getVersion(),
  gepackt: app.isPackaged,
  ipcMode: Sentry.IPCMode.Classic,
  ctx: {
    home: fehlerberichte._home(),
    daten: P.daten,
    projekte: () => projekteWurzel || P.projekte,
    schalterPfad,
    protokollPfad: () => protokoll.pfad(),
  },
}))

// Vor app.whenReady: HTTP/2 abschalten. autoUpdater.checkForUpdates() nutzt Electrons
// net = HTTP/2, und GitHub/Fastly verweigert dessen Stream sporadisch/persistent mit
// net::ERR_HTTP2_SERVER_REFUSED_STREAM — der Check scheitert vor jedem Versionsabgleich,
// Betroffene sehen nie ein Update (#150). HTTP/1.1 umgeht das (gh holt latest.yml so
// problemlos). Muss VOR dem ready-Event stehen. Einziger externer Chromium-Net-Zugriff
// der App ist dieser Check (uvicorn=localhost, yt-dlp=eigener Subprozess) → risikolos.
app.commandLine.appendSwitch('disable-http2')

let win = null
let aktualisierer = null
let bereit = false
// Der Start darf nur EINMAL laufen: whenReady() prueft, und die Statusseite fragt beim Laden
// selbst nochmal nach — ohne diesen Riegel starten zwei uvicorn-Prozesse auf zwei Ports.
let startLaeuft = null

/**
 * Alles, was ins Fenster geht, geht auch in die Datei — hier ist der Punkt, durch den BEIDE
 * Quellen laufen (setup.einrichten und backend.start). Nur 'log' und 'fehler' werden
 * mitgeschrieben: 'phase' und 'status' sind Anzeigezustand, keine Fehlerspur.
 */
function senden(kanal, nutzlast) {
  if (kanal === 'log') protokoll.schreiben(String(nutzlast))
  if (kanal === 'fehler') protokoll.schreiben(`FEHLER: ${nutzlast}`)
  if (win && !win.isDestroyed()) win.webContents.send(kanal, nutzlast)
}

/**
 * Die Abweisung gehoert ins Protokoll — sonst tut ein Link sichtbar nichts und niemand findet
 * den Grund. Der Rueckkanal zum Renderer fehlt dabei ("dieselbe Regel wie beim
 * `fehlerbericht`-Wurf" stand hier zuerst und stimmt NICHT: dort wird die Ablehnung
 * durchgereicht und als Toast gezeigt, `setWindowOpenHandler` ist synchron und kennt keinen).
 * Diagnostizierbar wird es, sichtbar nicht.
 *
 * **Deckel und Bremse sind der Pflichtteil, nicht die Vorsicht** — beides an echtem Electron
 * gemessen, nachdem die erste Fassung dieser Zeile ungebremst schrieb:
 *   - Eine einzelne `window.open`-URL kommt mit bis zu **2 MB** am Handler an
 *     (Chromiums `kMaxURLChars`), und `protokoll.MAX` sind 2 MB. **Vier** Aufrufe draengten
 *     40 echte FEHLER-Zeilen aus dem Protokoll, **zwoelf** loeschten alle vier Generationen
 *     (15,26 MB auf der Platte statt der in `protokoll.js` zugesagten 8).
 *   - Schlimmer als der Datenverlust ist der stille: `bericht.mailto` kuerzt von OBEN und
 *     bricht ab, sobald keine Zeile mehr uebrig ist. **Ein** Aufruf mit ~1800 Zeichen
 *     entleerte den naechsten Fehlerbericht auf "letzte 0 Protokollzeilen" — der Nutzer
 *     schickt eine Mail ohne seinen Fehler ab und merkt nichts.
 *   - Gebremst wird nichts von selbst: 20 000 Aufrufe ohne Nutzergeste kamen alle an
 *     (~4200/s), Electron hat keinen Popup-Blocker.
 * Der Deckel allein reicht nicht (er macht aus 2 MB ~250 Byte, die Rate bleibt), die Bremse
 * allein auch nicht. Kein `replace` fuer Zeilenumbrueche: zweimal unabhaengig gemessen, dass
 * Chromium CR/LF/TAB vor dem Handler entfernt — eine Wache dagegen waere Code fuer einen Fall,
 * den es nicht gibt, mit einem Test, der immer gruen ist.
 */
const ABWEISUNGEN_MAX = 20
const ABWEISUNGEN_FENSTER_MS = 60 * 60 * 1000
let abweisungen = 0
let fensterStart = 0
/**
 * `was` unterscheidet die beiden Absender (#434) — sonst steht im Protokoll nicht, ob ein
 * FENSTER aufgehen wollte oder das bestehende wegnavigieren. `grund` sagt daneben, WARUM
 * abgewiesen wurde (#458): der Klammerzusatz war eine Konstante und stand unter drei
 * verschiedenen Gruenden. Zaehler, Deckel und Bremse bleiben **geteilt**, und das ist die
 * eigentliche Zusicherung: ein zweiter, eigener Schreibweg waere genau der Fehler, den #426
 * hier schon einmal gemacht hat — ein Renderer, der beide Wege abwechselnd flutet, haette
 * sonst wieder den doppelten Deckel und entleerte den naechsten Fehlerbericht auf
 * „letzte 0 Protokollzeilen".
 *
 * **Der Deckel ist ein Zeitfenster, kein Lebenszeit-Budget (#448).** Bis dahin wurde
 * `abweisungen` nie zurueckgesetzt: nach 20 abgewiesenen Zielen — verteilt ueber beliebig
 * viele Tage, und die App bleibt bei langen Transkriptionen tagelang offen — schwieg die
 * Diagnose bis zum Neustart. Genau dann fehlte sie, wenn jemand meldet „ich klicke auf den
 * Link und es passiert nichts". Jetzt beginnt der Zaehler jede Stunde neu.
 *
 * **Was das NEU erlaubt, benannt statt uebersehen — und die Rechnung geht nur fuer die PLATTE
 * auf.** An einer Fenstergrenze sind im Extremfall 40 Zeilen in kurzer Folge moeglich (20 am
 * Ende von Fenster N, 20 am Anfang von N+1). Der gemessene Schaden von #426 kam von
 * UNGEKAPPTEN URLs — eine mit 2 MB entleerte den naechsten Fehlerbericht, zwoelf loeschten alle
 * vier Protokollgenerationen. Seit dem 200-Zeichen-Deckel eine Zeile weiter unten sind 40
 * Zeilen rund **11 KB** (277 Byte je Zeile, gemessen; hier stand zuerst „8 KB", geschaetzt),
 * und bis 2 MB dauert es in dem Tempo Tage. Fuer Platte und Rotation bleibt der Flutschutz
 * also intakt. Wer `ABWEISUNGEN_FENSTER_MS` verkleinert, rechnet das nach.
 *
 * **Fuer den FEHLERBERICHT gilt das NICHT — und das ist der Preis dieses Fixes, nicht eine
 * Randnotiz.** Drei Reviewstufen haben es unabhaengig am echten `bericht.js` gemessen:
 * `bericht.mailto` kuerzt von OBEN, `AUSSORTIEREN` filtert Abweisungszeilen nicht, und der
 * Bericht traegt ohnehin nur 2-14 Zeilen — **drei bis fuenf** Abweisungen am Protokollende
 * genuegen also, damit die naechste Mail NULL echte Zeilen enthaelt. Genau diesen Kanal nennt
 * der Absatz weiter oben den STILLEN Schadensweg.
 *
 * Der Unterschied ist die Dauer, nicht die Moeglichkeit: vorher waren es 20 Schuss je App-Lauf
 * — einmal verbraucht, und jede spaetere echte Zeile schob die Abweisungen aus dem
 * Mail-Ausschnitt heraus. Jetzt kann ein dauerhaft flutender Renderer das Protokollende
 * **stuendlich neu** belegen (~96-160 Vergiftungen am Tag), und der Zustand heilt nicht mehr
 * von selbst aus. Das ist bewusst in Kauf genommen: die Alternative waere die stumme Diagnose
 * aus #448, und der Hebel dagegen liegt ohnehin nicht hier, sondern in `bericht.js`
 * (Abweisungszeilen deckeln oder aus `AUSSORTIEREN` heraushalten) — eigener Mechanismus,
 * eigener Pruefstand: **#506**, verwandt mit #435 und #436.
 *
 * **Die Schlusszeile feuert je Fenster erneut** — gewollt: sie sagt, ab wo geschwiegen wurde,
 * und das gilt pro Stunde neu.
 *
 * **`grund` hat bewusst KEINEN Vorgabewert.** Er hatte einen (`'Schema nicht erlaubt'`), und der
 * war nach diesem Fix tot: beide Aufrufer setzen ihn. Ein toter Vorgabewert genau dieses Textes
 * ist aber kein Komfort, sondern eine Falle — der naechste Aufrufer, der ihn vergisst, stellt
 * #458 wieder her, und zwar STILL. Ohne Vorgabewert steht im Protokoll „abgewiesen (undefined)":
 * sofort sichtbar falsch statt plausibel falsch. `was` behaelt seinen, weil ein fehlendes `was`
 * nur unspezifisch ist und nicht luegt.
 */
/**
 * Von einer FREMDEN URL geht nur die Herkunft ins Protokoll (CodeRabbit-Bot an PR #522).
 *
 * Die drei alten Wege (#426, #434) protokollieren die volle URL, und das bleibt richtig: dort
 * hat der NUTZER das Ziel gewaehlt, und „welcher Link ging nicht auf" ist die Frage, wegen der
 * jemand schreibt — genau so steht es in der README. Bei den beiden Wegen aus #446 ist es
 * umgekehrt: gefragt hat eine fremde Seite, und die Antwort auf „wer" ist die Herkunft. Pfad,
 * Query und Fragment tragen dort nichts bei, koennen aber ein Token oder einen OAuth-Code
 * fuehren — und der Rumpf faehrt ueber `bericht.letzteZeilen` in eine Mail.
 *
 * `origin` ist bei `file:`, `data:` und Co. die Zeichenkette `'null'`; dann sagt das SCHEMA
 * mehr als nichts. Unlesbares wird benannt statt verschwiegen — eine leere Klammer laesst den
 * Leser glauben, es sei nichts angekommen.
 */
function nurHerkunft(url) {
  try {
    const u = new URL(String(url))
    return u.origin === 'null' ? u.protocol : u.origin
  } catch { return '(unlesbare Herkunft)' }
}

function abweisungProtokollieren(url, was = 'Externer Link', grund) {
  // `performance.now()`, NICHT `Date.now()`: die Wanduhr springt (NTP, Handkorrektur,
  // VM-Snapshot). Ausgefuehrt gemessen: bei einem Ruecksprung um 24 h schwieg die Diagnose
  // 25 h statt einer Stunde, 24 von 30 Abweisungen gingen verloren — und der Satz „beginnt
  // jede Stunde neu" waere unwahr. Sommerzeit und Zeitzone sind kein Fall (UTC-Epoche).
  // `performance.now()` laeuft ab Prozessstart monoton; `fensterStart = 0` heisst damit
  // „erstes Fenster endet eine Stunde nach dem START", nicht „nach der ersten Abweisung" —
  // folgenlos, weil `abweisungen` beim Start ohnehin 0 ist.
  const jetzt = performance.now()
  if (jetzt - fensterStart >= ABWEISUNGEN_FENSTER_MS) { fensterStart = jetzt; abweisungen = 0 }
  abweisungen += 1
  if (abweisungen <= ABWEISUNGEN_MAX) {
    protokoll.schreiben(was + ' abgewiesen (' + grund + '): ' + String(url).slice(0, 200))
  } else if (abweisungen === ABWEISUNGEN_MAX + 1) {
    // **Nicht mehr „Links" (#446) und nicht mehr leer (#506).** Seit die Berechtigungs- und
    // webview-Wachen ueber denselben Zaehler melden, sind es nicht zwangslaeufig Links; und
    // weil `bericht.letzteZeilen` genau EINE Zeile dieser Gruppe in die Fehlermail laesst, ist
    // im Flutfall GENAU DIESE Zeile die einzige Auskunft ueber Abweisungen, die der Nutzer
    // mitschickt. Ohne den Zusatz nennt sie weder Art noch Ziel noch Grund — gemessen am
    // echten `bericht.js`: acht echte Zeilen, 20 Abweisungen, eine Schlusszeile, und was
    // ankommt, ist die Schlusszeile. Sie traegt deshalb den Vorgang mit, der als erster
    // unterdrueckt wurde; derselbe 200-Zeichen-Deckel wie oben.
    protokoll.schreiben(`Weitere Abweisungen werden nicht mehr protokolliert (Deckel: ${ABWEISUNGEN_MAX} je Stunde; die naechste war: ${was}, ${grund}, ${String(url).slice(0, 200)})`)
  }
}

/**
 * Was der Renderer an Berechtigungen bekommen darf (#446) — heute genau zwei, und beide sind
 * am laufenden Fenster GEMESSEN, nicht aus dem Code geschlossen. Die Begruendung steht am
 * Handler in `fenster()`.
 */
const BERECHTIGUNGEN_ERLAUBT = new Set(['notifications', 'clipboard-sanitized-write'])

function fenster() {
  const dunkel = nativeTheme.shouldUseDarkColors
  // fensterOptionen entscheidet die Startfarbe selbst -- dieselbe Quelle wie backgroundColor
  // unten, sonst weichen Fenster und Overlay beim Start voneinander ab.
  const opt = fensterOptionen(process.platform, dunkel)
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    // Electron malt diese Farbe VOR dem ersten Dokument-Zeichnen und an den Raendern beim
    // Vergroessern — ein fester Dunkelwert blitzt seit setup.html hell kann im Hellmodus auf.
    backgroundColor: dunkel ? '#0B0B0F' : '#FAFAFA',
    show: true,
    ...opt,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })
  win.setMenuBarVisibility(false)
  win.loadFile(SETUP_HTML)
  // Externe Links (Key erstellen, Doku) gehoeren in den Browser, nicht in die App — aber nur
  // die, deren Schema `externesZiel` kennt (#426). Die URL kommt vom Renderer; ungeprueft war
  // diese Zeile ein "oeffne beliebige URL" fuers Betriebssystem, also genau das, was
  // `preload.js` fuer den Kanal daneben ausdruecklich ausschliesst.
  // Geoeffnet wird der ZURUECKGEGEBENE Wert, nie `url`: geprueft wurde die geparste Form, und
  // nur sie darf hinausgehen (Begruendung in fenster.js).
  win.webContents.setWindowOpenHandler(({ url }) => {
    const ziel = externesZiel(url)
    if (ziel) shell.openExternal(ziel)
    else abweisungProtokollieren(url, 'Externer Link', abweisungsGrund(url))
    return { action: 'deny' }
  })
  /**
   * Der Gegenpart dazu (#434): der Handler darueber sieht nur NEUE Fenster, nicht das
   * bestehende, das selbst wegnavigiert. Tut es das auf eine fremde Herkunft, laeuft
   * `preload.js` dort erneut — gemessen liegt `window.transkribor` dann mit 12 Schluesseln auf
   * der fremden Seite. Nicht ein einzelner Aufruf wie bei #426, sondern dauerhafter Zugriff.
   *
   * **Beide Ereignisse, und der Grund ist gemessen, nicht vorsorglich:** bei einem
   * 302-Redirect von der eigenen auf eine fremde Herkunft feuert `will-navigate` mit der
   * EIGENEN URL (der Waechter laesst sie zu Recht durch) und erst `will-redirect` mit der
   * fremden. Nur mit `will-navigate` landete das Fenster also auf der fremden Seite — der
   * „Redirect"-Weg aus dem Issue waere ungedeckt geblieben.
   *
   * **`will-frame-navigate` bewusst NICHT**, ebenfalls gemessen: es feuert bei jeder
   * Hauptrahmen-Navigation ZUSAETZLICH (jede Abweisung zaehlte doppelt gegen den geteilten
   * Deckel), und im einzigen Fall, den es allein abdeckt — ein iframe auf fremde Herkunft —
   * bekommt der Rahmen den Preload gar nicht (`window.transkribor` dort `undefined`). Es
   * schuetzt hier also nichts und kostet die halbe Protokollbremse.
   *
   * Die eigenen Herkuenfte werden bei JEDEM Ereignis neu erfragt: `backend.url()` steht beim
   * Fensterbau noch nicht fest (der Port entsteht erst mit dem Server).
   *
   * Alle Zahlen dieses Blocks stammen aus der Sonde in
   * `docs/superpowers/specs/2026-08-28-transkribor-will-navigate-sonde.md` (Aufbau, Kommandos,
   * Rohausgaben) — hier stehen Verweise darauf, keine Behauptungen.
   */
  const navigationPruefen = extern => (e, urlVeraltet) => {
    // **Die Angaben stehen im ERSTEN Argument.** Seit Electron 25 ist das ein Details-Ereignis
    // (`electron.d.ts`: `on(event: 'will-navigate', listener: (details:
    // Event<WebContentsWillNavigateEventParams>, …`), und `WebContentsWillNavigateEventParams`
    // traegt `url` und `isMainFrame` — dieselbe Form bei `will-redirect`. Die positionalen
    // Parameter dahinter sind dort ausdruecklich `@deprecated`, werden aber weiter uebergeben.
    // Deshalb das Details-Feld zuerst und der positionale Wert nur als Rueckfall: heute liefern
    // beide dasselbe, aber nur einer davon ist der zugesagte Weg.
    const url = e.url ?? urlVeraltet
    // **Nur der Hauptrahmen.** `will-navigate` feuert ohnehin nur dort, `will-redirect` aber
    // AUCH fuer Unterrahmen (gemessen: `isMainFrame=false` beim Redirect eines iframes). Ohne
    // diese Zeile griffe der Waechter in eine Navigation ein, die ihn nichts angeht: der
    // Unterrahmen bekaeme ein `preventDefault()` und eine Abweisungszeile, waehrend er vor
    // #434 dem Redirect einfach in sich selbst folgte — eine stille Verhaltensaenderung an
    // einem Rahmen, der den Preload gar nicht bekommt (`window.transkribor` dort `undefined`).
    //
    // **Der SYSTEM-Browser ginge dabei NICHT auf**, und hier stand bis zur dritten
    // Reviewrunde das Gegenteil: `will-redirect` laeuft als `navigationPruefen(false)`, damit
    // ist `ziel` null und die Umleitung wird abgewiesen (siehe die `extern`-Begruendung
    // unten). Der Satz galt der ERSTEN Fassung, in der beide Ereignisse mit `externesZiel`
    // bewertet wurden; die Trennung sechs Zeilen tiefer hat ihn ueberholt, und er blieb
    // stehen — zwei Begruendungen in derselben Funktion, die einander widersprachen. Die
    // Wache ist damit Tiefenverteidigung, kein Riegel vor dem Systembrowser.
    // `=== false`, nicht `!`: fehlt die Angabe, MUSS der Waechter greifen. Ein unbekannter
    // Wert darf eine Wache nie stillschweigend abschalten (dieselbe Richtung wie bei #266).
    if (e.isMainFrame === false) return
    if (eigeneHerkunft(url, [pathToFileURL(SETUP_HTML).href, backend.url()])) return
    e.preventDefault()
    // Derselbe Weg wie ein externer Link, dieselbe Weissliste, derselbe Zaehler — ein Link
    // ohne `target` gehoert in den Browser, nicht in dieses Fenster.
    //
    // **Aber nur bei `will-navigate` (`extern`).** Dort hat der Renderer das Ziel gewaehlt: ein
    // Klick, ein `location.href`. Bei `will-redirect` waehlt es ein SERVER — dieselbe Frage wie
    // beim Unterrahmen oben, nur eine Ebene hoeher: eine 302 auf der eigenen Herkunft genuegte
    // sonst, um `shell.openExternal` mit einer beliebigen fremden http(s)-URL zu feuern, ohne
    // Klick und ohne Nutzergeste. **Heute nicht ausloesbar** (gemessen: `RedirectResponse` und
    // explizite 3xx kommen in `webtool/` nicht vor, nur Starlettes Schraegstrich-Umleitung auf
    // dieselbe Herkunft) — aber eine Faehigkeit ohne Nutzer laesst man nicht offen, und genau
    // mit dieser Begruendung fehlt `mailto:` in `externesZiel` und faellt der Unterrahmen raus.
    // Der Preis ist benannt: leitete unser Server je absichtlich nach draussen um, wuerde die
    // Umleitung abgewiesen statt geoeffnet — fail-safe, und im Protokoll steht warum.
    //
    // **Der Grund haengt an genau dieser Verzweigung (#458).** Bei `extern` hat `externesZiel`
    // geurteilt, also weiss `abweisungsGrund` warum. Bei einer Weiterleitung wird gar nicht
    // erst gefragt — abgewiesen wird dort, WEIL ein Server das Ziel waehlt, nicht wegen des
    // Schemas. Das Protokoll behauptete hier bis #458 „Schema nicht erlaubt" auch fuer ein
    // voellig erlaubtes `https:` und schickte jeden Leser ans falsche Ende; der Satz eine
    // Zeile weiter oben stimmt also erst seit diesem Fix.
    const ziel = extern ? externesZiel(url) : null
    if (ziel) shell.openExternal(ziel)
    else abweisungProtokollieren(url, extern ? 'Navigation' : 'Weiterleitung',
      extern ? abweisungsGrund(url) : 'Weiterleitung folgt keinem Link')
  }
  // Zwei Marken statt einer: im Protokoll steht damit auch, WELCHES Ereignis gefeuert hat —
  // bei einer Umleitungskette ist genau das die Information, die man sucht.
  win.webContents.on('will-navigate', navigationPruefen(true))
  win.webContents.on('will-redirect', navigationPruefen(false))
  /**
   * Der dritte und vierte Weg, auf dem dieses Fenster Faehigkeiten bekaeme (#446) — dieselbe
   * Frage wie bei #426 und #434, nur fuer BERECHTIGUNGEN und `<webview>`. Ohne sie entscheidet
   * Chromiums Voreinstellung, und die Fenster-Faehigkeiten waeren nur zu drei Vierteln hier.
   *
   * **Der Handler haengt an der SESSION, nicht an `webContents`.** Das Issue nennt
   * `win.webContents.setPermissionRequestHandler` — diese Methode gibt es nicht; gemessen in
   * `node_modules/electron/electron.d.ts` steht `setPermissionRequestHandler` unter `Session`.
   * `win.webContents.session` ist dabei ohne `partition` die **Standard-Session**, also
   * prozessweit geteilt und nicht fensterlokal. Folgenlos und an der d.ts belegt: der Handler
   * ist EIN Slot („To clear the handler, call `setPermissionRequestHandler(null)`") — ein
   * zweiter `fenster()`-Lauf ueber `app.on('activate')` ERSETZT ihn, es haengen nie zwei, und
   * die Closure traegt keinen Fensterzustand.
   *
   * **Die Weissliste ist GEMESSEN, nicht hergeleitet — und die Messung hat die Herleitung
   * widerlegt.** Am laufenden Fenster (eigenes `--user-data-dir`, CDP, echte Handler) kamen
   * DREI Anfragen am Handler an: `media`, `geolocation` und **`clipboard-sanitized-write`**.
   * Die dritte war der Fund: der Plan hatte sie beim *Check*-Handler vermutet, sie laeuft aber
   * durch DIESEN. Ein Deny-all haette damit zwei echte Funktionen still abgeschaltet —
   * `Notification.requestPermission()` fuer die Fertigmeldung (#376, `useOsFortschritt.ts`)
   * und `navigator.clipboard.writeText` fuer „Lizenzschluessel kopieren"
   * (`SettingsPage.tsx`). Genau davor warnt das Issue („sonst sperrt der Fix etwas, das die App
   * braucht, und das faellt erst beim Nutzer auf"). Alles andere fragt die App nicht an, und was
   * sie nicht anfragt, bekommt sie auch nicht — dieselbe Regel wie die Schema-Weissliste in
   * `fenster.externesZiel`.
   *
   * **`setPermissionCheckHandler` haengt seit #518 daneben** — bis dahin eine benannte Grenze
   * dieses Handlers, denn Electron schreibt selbst, dass fuer vollstaendige Behandlung beide
   * noetig sind. Seine Begruendung steht an ihm selbst, ein paar Zeilen weiter unten.
   *
   * **`<webview>` ist heute ohnehin aus** — `webviewTag` steht seit Electron 5 auf `false` und
   * die `webPreferences` oben setzen es nicht. Der Hoerer ist die zweite Sperre gegen den
   * einzigen Weg, auf dem in diesem Fenster doch ein Kontext MIT Preload entstuende: bei einem
   * `iframe` ist das gemessen nicht so (`window.transkribor` dort `undefined`, #434).
   *
   * **Beide melden ueber `abweisungProtokollieren`** — geteilter Zaehler, geteilter Deckel,
   * geteilte Bremse. Ein zweiter, eigener Schreibweg waere genau der Fehler aus #426; und die
   * Zeilen fallen so nebenbei unter den Abweisungs-Deckel des Fehlerberichts (#506), ein
   * Berechtigungssturm kann die naechste Fehlermail also nicht entleeren.
   */
  win.webContents.session.setPermissionRequestHandler((_inhalt, art, erlauben, angaben) => {
    // **Die HERKUNFT zaehlt mit, nicht nur die Art** — dieselbe Liste und dieselbe
    // Laufzeit-Abfrage wie bei den Navigationswachen oben, weil `backend.url()` beim
    // Fensterbau noch nicht feststeht. `details` traegt `requestingUrl` bei den DREI
    // gemessenen Anfragearten (`notifications`, `clipboard-sanitized-write`, `media` — je mit
    // `isMainFrame`). Fuer die uebrigen rund zwanzig aus der Typdeklaration ist es nicht
    // gemessen, und darauf ist der Handler eingerichtet: fehlt die Angabe, wirft
    // `eigeneHerkunft` nicht, sondern liefert `false`, und die Anfrage wird abgelehnt. Das ist
    // die richtige Fehlerrichtung — ein unbekannter Wert darf eine Wache nie stillschweigend
    // abschalten (#266) —, aber es ist eine Annahme ueber den ungemessenen Rest.
    //
    // **Und der Handler darf NICHT werfen.** Eine geworfene Ausnahme darin lehnt still JEDE
    // Berechtigung ab — die Zwischenablage kippte dadurch von `OK` auf `NotAllowedError`, und
    // im Protokoll stand KEINE einzige Zeile, weder eine Sonden- noch eine Abweisungszeile.
    // `eigeneHerkunft` faengt sein `new URL` selbst ab, `Set.prototype.has` kann nicht werfen.
    //
    // Alle Rohausgaben dieses Blocks — welche Berechtigungen ankommen, was in `details` steht,
    // und der Wurf-Fall — stehen in
    // `docs/superpowers/specs/2026-09-02-transkribor-berechtigungs-sonde.md` samt Aufbau,
    // Kommandos und den Grenzen der Messung. Hier stehen Verweise darauf, keine Behauptungen.
    const eigen = eigeneHerkunft(angaben?.requestingUrl,
      [pathToFileURL(SETUP_HTML).href, backend.url()])
    const erlaubt = eigen && BERECHTIGUNGEN_ERLAUBT.has(art)
    if (!erlaubt) {
      // Bei fremder Herkunft faehrt sie mit: „media abgelehnt" allein sagt nicht, WER gefragt
      // hat, und genau das ist dort die Information. Der 200-Zeichen-Deckel gilt wie ueberall.
      abweisungProtokollieren(eigen ? art : `${art} von ${nurHerkunft(angaben?.requestingUrl)}`,
        'Berechtigung', eigen ? 'nicht in der Weissliste' : 'fremde Herkunft')
    }
    erlauben(erlaubt)
  })
  /**
   * Der Gegenpart (#518). Ohne ihn beantwortet Chromiums Voreinstellung jedes
   * `navigator.permissions.query(...)`, und die Auskunft an die Seite kann von der
   * Entscheidung abweichen, die der Handler darueber dann faellt.
   *
   * **Dieselbe Weissliste — und das ist gemessen, nicht angenommen.** Am laufenden Fenster
   * (eigenes `userData`, echte Handler, `setup.html` und ein lokaler Server als zweite
   * Herkunft) kamen beim CHECK-Handler VIERZEHN Arten an, beim Request-Handler fuenf — und
   * die gebaute Oberflaeche steuert eine FUENFZEHNTE bei, `background-sync`, ausgeloest von
   * einem gewoehnlichen `fetch()` und nur hier sichtbar. Die
   * beiden, die diese App wirklich braucht, sind auf beiden Seiten dieselben:
   * `notifications` — schon das blosse LESEN von `Notification.permission` laeuft hier durch,
   * und `useOsFortschritt.ts` liest es vor jeder Fertigmeldung — und
   * `clipboard-sanitized-write` fuer „Lizenzschluessel kopieren". Alles andere fragt die App
   * nicht an.
   *
   * **Die Typdeklaration ist unvollstaendig, verlassen kann man sich nur auf die Messung.**
   * `electron.d.ts` fuehrt fuer den Check 19 Arten; SECHS der gemessenen stehen dort nicht
   * (`web-app-installation`, `speaker-selection`, `window-management`, `screen-wake-lock`,
   * `local-fonts`, `persistent-storage`). Eine Weissliste aus der Typdeklaration waere also
   * eine Liste ueber einen Teil der Wirklichkeit. Weil hier abgelehnt wird, was nicht
   * dasteht, ist die Richtung trotzdem richtig: eine unbekannte Art bekommt nichts.
   *
   * **Vier Pruefungen laufen VOR jeder Seiteninteraktion auf, mit LEERER Herkunft**
   * (`media` zweimal, `web-app-installation`, `geolocation` — `requestingUrl` ist dann der
   * leere String). `eigeneHerkunft` wirft darauf nicht, sondern liefert `false`, und die
   * Pruefung wird abgelehnt. Das ist die richtige Fehlerrichtung (#266) und derselbe Griff
   * wie oben.
   *
   * **Entschieden wird an `requestingUrl`, nicht an `requestingOrigin`.** Bei einer
   * `file:`-Seite ist die Herkunft `file:///` — sie kann `setup.html` von jeder anderen
   * lokalen Datei nicht unterscheiden, waehrend `requestingUrl` die zuletzt geladene URL des
   * Rahmens traegt (beides gemessen). Ist sie leer, wird abgelehnt; im PROTOKOLL darf dann
   * die Herkunft den Namen liefern, denn dort geht es nur darum, WER gefragt hat.
   *
   * **Die Typdeklaration sagt, `requestingUrl` fehle im Unterrahmen fremder Herkunft — das
   * ist an Electron 43 gemessen NICHT so.** Der Schluessel kommt immer (leer, wenn unbekannt),
   * und im fremden Unterrahmen sogar mit voller URL. Der Handler behandelt beide Formen
   * gleich, weil eine leere Angabe und eine fehlende dieselbe Antwort verdienen — aber der
   * Vergleich ist `||`, nicht `??`: gegen den leeren String traegt `??` nicht.
   *
   * **Gemeldet wird nur der ERSTE Fall je Art, und daran haengt der Fehlerbericht.** Auf
   * 18 Anfragen kamen 111 Pruefungen — sechsmal so viele. Ungebremst waere der gemeinsame
   * Abweisungs-Deckel (#426) nach wenigen Sekunden voll, und genau der entscheidet, was von
   * einem Fehlerbericht uebrig bleibt (#506): eine Fehlermail ohne den Fehler war der Anlass
   * dieser Regel. Die Merkliste haengt an DIESEM Fensterlauf; ein zweiter `fenster()`-Lauf
   * ersetzt Handler und Liste gemeinsam (der Handler ist ein Slot, siehe oben).
   *
   * Rohausgaben, Aufbau und Grenzen der Messung:
   * `docs/superpowers/specs/2026-09-02-transkribor-berechtigungs-sonde.md`, Messung 4.
   */
  const berechtigungGemeldet = new Set()
  win.webContents.session.setPermissionCheckHandler((_inhalt, art, herkunft, angaben) => {
    const eigen = eigeneHerkunft(angaben?.requestingUrl,
      [pathToFileURL(SETUP_HTML).href, backend.url()])
    const erlaubt = eigen && BERECHTIGUNGEN_ERLAUBT.has(art)
    // **Chromium prueft ZWEIMAL je Dokument, und nur die erste Runde schweigt.** Beim
    // Startdokument des FENSTERS kommen `media` (zweimal), `web-app-installation` und
    // `geolocation` ohne jede Angabe — Herkunft UND `requestingUrl` leer; dafuer gibt es
    // keinen Frager, also auch keine Zeile (die Ablehnung bleibt). Nur dort: das
    // Startdokument eines UNTERRAHMENS traegt die Herkunft des Elterns und wird deshalb
    // protokolliert, mit dem dritten Grund unten. Danach kommt dieselbe
    // Gruppe je geladenem Dokument NOCH EINMAL, diesmal mit der Seiten-URL, also als eigene
    // Herkunft. **Gemessen stehen nach einem App-Start damit vier Zeilen im Protokoll**
    // (`media`, `web-app-installation`, `geolocation`, `background-sync`), nicht null — und
    // wer hier „gespart" liest, liest falsch: gespart ist das falsche Etikett, nicht die
    // Zeile.
    //
    // **Dass sie bleiben, ist eine Entscheidung mit Preis.** Sie kosten vier der zwanzig
    // Deckelplaetze je Fensterlauf, und in einer kurzen Sitzung traegt die Fehlermail eine
    // davon (`bericht.ABWEISUNGEN_IM_BERICHT` = 1, gewaehlt von hinten — jede spaetere echte
    // Abweisung verdraengt sie wieder). Dafuer sind sie der EINZIGE Kanal fuer die Arten, die
    // nur hier auflaufen: `background-sync` ist genau so gefunden worden — es erscheint nie
    // beim Request-Handler, wird von einem gewoehnlichen `fetch()` ausgeloest, und heute
    // bricht daran nichts. Ohne die Zeile waere die naechste solche Art unsichtbar.
    //
    // Der Marker traegt beide Haelften: eine eigene und eine fremde Abweisung derselben Art
    // sind zwei Vorgaenge. Zaehlte er nur die Art, waere nach dem Start eine ECHTE fremde
    // Anfrage mit `media` oder `geolocation` nie mehr protokolliert worden (gemessen).
    //
    // **Die HERKUNFT gehoert bewusst NICHT in den Marker** (Vorschlag der CodeRabbit-CLI an
    // diesem PR, abgelehnt mit Grund): sie ist der einzige Teil, den eine Seite frei
    // variieren kann. Ein Marker je Herkunft waere eine unbegrenzte Menge und ein
    // Schreibweg, der den gemeinsamen Deckel (#426) in Sekunden leerraeumt — genau der
    // Ausfall, gegen den #506 gebaut wurde. Der Preis ist benannt: eine ZWEITE fremde
    // Herkunft mit derselben Art bleibt hier stumm. Verloren geht dabei nichts, was wirklich
    // angefragt wurde — der Request-Handler daneben entdoppelt gar nicht und nennt jede
    // Herkunft einzeln; stumm bleibt nur die zusaetzliche Nachfrage einer zweiten Seite.
    const wer = angaben?.requestingUrl || herkunft
    const marke = `${art}|${eigen}`
    if (!erlaubt && wer && !berechtigungGemeldet.has(marke)) {
      berechtigungGemeldet.add(marke)
      // Drei Gruende, nicht zwei: das Startdokument eines Unterrahmens kommt ohne
      // `requestingUrl`, aber mit der Herkunft des ELTERN — also unserer eigenen. „fremde
      // Herkunft: media von <unsere Adresse>" waere dort schlicht gelogen (gemessen an einer
      // Rahmen-Sonde; in dieser App heute unerreichbar, sie hat kein `<iframe>`).
      abweisungProtokollieren(eigen ? art : `${art} von ${nurHerkunft(wer)}`,
        'Berechtigungspruefung',
        eigen ? 'nicht in der Weissliste' : angaben?.requestingUrl ? 'fremde Herkunft' : 'ohne Seitenangabe')
    }
    return erlaubt
  })
  win.webContents.on('will-attach-webview', (e, _einstellungen, angaben) => {
    e.preventDefault()
    abweisungProtokollieren(angaben?.src ? nurHerkunft(angaben.src) : '(ohne src)',
      'Eingebettete Ansicht', 'webview ist in dieser App nicht vorgesehen')
  })
  win.on('closed', () => { win = null })
}

/** Was der Python-Server ueber Fehlerberichte wissen muss (PR b liest es): DSN, Fassung, Schalterdatei. */
function serverExtras() {
  return { bugsinkDsn: paket.bugsinkDsn || '', version: app.getVersion(), fehlerberichte: schalterPfad() }
}

/** `TRANSKRIBOR_FEHLERPROBE=1`: einmal absichtlich werfen, um den Berichtsweg im GEPACKTEN Lauf
 *  zu messen — der einzige Weg dorthin ohne Testcode in der Oberflaeche.
 *  Der Riegel haelt es bei EINEM Wurf je Prozess: seit die Nachfrage aus der Oberflaeche kommt,
 *  gibt es zwei Zuendstellen (Serverstart bei gesetztem `gefragt`, ipc-Handler bei der ersten
 *  Antwort). Wird die Schalterdatei zur Laufzeit geloescht, treffen beide im selben Lauf zu. */
let probeGeworfen = false
function fehlerprobe() {
  if (probeGeworfen || !fehlerberichte.fehlerprobeGewuenscht(process.env)) return
  probeGeworfen = true
  protokoll.schreiben('Fehlerprobe: wirft jetzt absichtlich (TRANSKRIBOR_FEHLERPROBE)')
  setImmediate(() => { throw new Error(fehlerberichte.FEHLERPROBE) })
}

function serverStarten() {
  if (startLaeuft) return startLaeuft
  senden('phase', { schritt: 'Server starten' })
  startLaeuft = backend.start(z => senden('log', z), serverExtras()).then(
    () => {
      bereit = true
      if (win) win.loadURL(backend.url())
      backend.projektePfad().then(p => { if (p) projekteWurzel = p }).catch(() => { /* P.projekte bleibt */ })
      // Die Nachfrage stellt jetzt die Oberflaeche (`FehlerberichteFrage.tsx`) — sie sieht
      // an `gefragt: null` selbst, dass noch nie gefragt wurde, und antwortet ueber
      // `fehlerberichte:setzen`. Hier bleibt nur die Ordnung, die daran hing: die Probe erst NACH
      // der Antwort, denn vorher steht der Schalter auf AUS (Vorgabe) und ein
      // TRANSKRIBOR_FEHLERPROBE=1 beim allerersten Start liefe trotz „Ja“ still ins Leere
      // (Bot-Review #531). Beim ersten Start zuendet sie deshalb der ipc-Handler, nicht diese Zeile.
      if (fehlerberichte.lesen(schalterPfad()).gefragt) fehlerprobe()
    },
    e => { startLaeuft = null; senden('fehler', String(e.message || e)) },   // Retry erlauben
  )
  return startLaeuft
}

/** Prueft die Umgebung; ist alles da, startet der Server sofort — sonst wartet die Seite auf den Klick. */
async function pruefen() {
  const s = await setup.status()
  // In die Datei, nicht nur ins Fenster: "Python nicht gefunden" ist ohne den Befund daneben
  // (was WURDE gefunden, wo liegt die venv) nicht diagnostizierbar.
  protokoll.befund('Umgebungsbefund', s)
  senden('status', s)
  if (s.venv) await serverStarten()
  return s
}

ipcMain.handle('status', () => pruefen())

// Der Weg vom "bei mir kommt ein Fehler" zu einer Datei, die man verschicken kann.
ipcMain.handle('protokollOeffnen', () => {
  protokoll.schreiben('— Protokoll vom Nutzer geoeffnet —')
  shell.showItemInFolder(protokoll.pfad())
  return protokoll.pfad()
})

// Der Opt-in-Schalter (#530): lesen und setzen. Das Argument ist ein Boolean und sonst nichts —
// alles andere heisst AUS; der Hauptprozess entscheidet, wo die Datei liegt.
ipcMain.handle('fehlerberichte:status', () => fehlerberichte.lesen(schalterPfad()))
ipcMain.handle('fehlerberichte:setzen', (_e, an) => {
  const pfad = schalterPfad()
  const vorher = fehlerberichte.lesen(pfad)
  let jetzt
  try {
    jetzt = fehlerberichte.schreiben(pfad, {
      automatisch: an === true,
      gefragt: vorher.gefragt || new Date().toISOString(),
    })
  } catch (e) {
    // Der alte Weg hatte diese Zeile (`FEHLER: Nachfrage Fehlerberichte: …` am `catch` von
    // `zustimmungFragen`); mit dem Umzug in die Oberflaeche waere sie ersatzlos entfallen. Der
    // Nutzer sieht dann zwar einen Toast, aber im PROTOKOLL stuende nichts — und genau das
    // Protokoll ist die Quelle des Fehlerberichts. „Es fragt mich bei jedem Start" haette dann
    // keine einzige Zeile hinterlassen (gegnerisches Review, Befund 4).
    protokoll.schreiben(`FEHLER: Fehlerberichte-Schalter: ${e.message || e}`)
    throw e
  }
  protokoll.schreiben(`— Fehlerberichte automatisch: ${jetzt.automatisch ? 'an' : 'aus'} —`)
  // War `gefragt` leer, ist dies die erste Antwort ueberhaupt — und erst jetzt darf die
  // Fehlerprobe werfen (siehe `serverStarten`): vorher stand der Schalter auf AUS.
  // **Der ABSENDER steht hier nicht fest, deshalb steht er auch nicht in der Zeile.** Der
  // Handler sieht nur den Dateizustand; schlug das Schreiben der Dialog-Antwort fehl, ist die
  // erste Antwort der Haken unter „Version". Ein Zusatz wie „(Nachfrage beim Start)" waere dann
  // eine Behauptung ueber etwas, das nicht stattfand — und sie bliebe nicht hier: `AUSSORTIEREN`
  // filtert sie nicht, sie faehrt ueber `bericht.letzteZeilen` in die Fehlermail und ueber
  // `fehlerberichte.protokollZeilen` in den Bugsink-Bericht (gegnerisches Review, Befund 2).
  if (!vorher.gefragt) fehlerprobe()
  return jetzt
})

/**
 * Fehlerbericht per Mail (#372) — der zweite Halbschritt zu `protokollOeffnen` darueber.
 *
 * `mailto:` statt eines eigenen Dienstes: kein Konto, kein Empfaengerserver, keine
 * Aufbewahrungsfrage — und die VORSCHAU ist gratis, weil der Text im Mailprogramm des
 * Nutzers steht, bevor er sendet. Das ist die Antwort auf „was darf mit?" aus dem Issue:
 * gezeigt statt gefiltert.
 *
 * Die Protokolldatei geht daneben im Dateimanager auf — `mailto` kann keine Anhaenge, und
 * die vollstaendige Spur ist genau das, was man anhaengen will. Der Rumpf nennt deshalb
 * ihren Pfad.
 *
 * Eine Leitung: was mitgeht und wie gekuerzt wird, entscheidet `bericht.js` (mit Tests).
 * Die Zeilen laufen trotzdem noch einmal durch `protokoll.maskiere` — geschrieben werden
 * sie zwar schon maskiert, aber eine rotierte Datei kann aus einer Fassung vor #371
 * stammen, und ein durchgerutschter Schluessel waere hier in einer Mail.
 */
ipcMain.handle('fehlerbericht', async () => {
  const pfad = protokoll.pfad()
  let text = ''
  try { text = fs.readFileSync(pfad, 'utf8') } catch { /* kein Protokoll: Kopf allein reicht */ }
  // Erst lesen, dann die Marke: sonst stuende sie als juengste Zeile im eigenen Bericht und
  // verdraengte dort eine echte.
  protokoll.schreiben('— Fehlerbericht vom Nutzer erstellt —')
  const { url, verwendet, gekuerzt } = bericht.mailto({
    empfaenger: paket.author && paket.author.email,
    betreff: `Fehlerbericht Transkribor ${app.getVersion()}`,
    kopf: bericht.kopf({
      version: app.getVersion(),
      plattform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      gepackt: app.isPackaged,
    }),
    zeilen: bericht.letzteZeilen(text).map(protokoll.maskiere),
    logpfad: pfad,
  })
  // Reihenfolge: erst der Weg, der IMMER geht. `openExternal` lehnt ab, wenn kein
  // `mailto:`-Handler registriert ist (frische Windows-Installation ohne Mailprogramm, Linux
  // ohne xdg-Handler) — dann hat der Nutzer wenigstens die Datei vor sich.
  shell.showItemInFolder(pfad)
  // Die Ablehnung wird DURCHGEREICHT, nicht geschluckt — dieselbe Regel wie bei
  // `projekteOeffnen` (#218/I1): ohne sie tut der Knopf sichtbar nichts, waehrend die Seite
  // eine Zeile darueber eine vorbereitete Mail verspricht.
  await shell.openExternal(url)
  return { pfad, verwendet, gekuerzt }
})

/**
 * Der Weg zu den eigenen Daten (#218) — bis hierher gab es `showItemInFolder` genau einmal,
 * fuer die PROTOKOLLdatei, und keinen fuer die Arbeit des Nutzers.
 *
 * **Kein Argument vom Renderer**, siehe preload.js: `shell.openPath` fuehrt eine DATEI aus,
 * ein durchgereichter Pfad waere also nicht nur „fremder Ordner", sondern „fremdes Programm".
 *
 * Den Pfad liefert `backend.projektePfad()` — der fragt den SERVER, statt `P.projekte` neu zu
 * rechnen; warum das nicht dasselbe ist, steht dort (Reviewbefund I1). Diese Zeile bleibt eine
 * Leitung: `main.js` ist das einzige Electron-Modul ohne eigene Tests, also gehoert alles,
 * was eine Entscheidung trifft, woandershin (Muster wie `fenster.fensterOptionen`).
 *
 * `openPath`, nicht `showItemInFolder`: letzteres zeigt eine DATEI in ihrem Elternordner, auf
 * ein Verzeichnis angewandt oeffnete es also dessen Elternverzeichnis mit markiertem
 * `projekte`. Der leere String heisst Erfolg; alles andere ist die Fehlermeldung des Systems
 * und wird geworfen, damit der Toast im Fenster sie nennt statt still nichts zu tun.
 */
ipcMain.handle('projekteOeffnen', async () => {
  const pfad = await backend.projektePfad()
  const fehler = await shell.openPath(pfad)
  if (fehler) throw new Error(fehler)
  return pfad
})

/**
 * Genau wie `startLaeuft`, und aus demselben Grund — nur ist der Schaden hier groesser:
 * ZWEI `pip install -r` in dasselbe `site-packages`. Die Instanzsperre unten deckt nur den Weg
 * ueber zwei Prozesse; ueber EINEN Prozess bleibt er sonst offen, und zwar alltaeglich: das
 * Standardmenue ist nur versteckt (`setMenuBarVisibility(false)`), seine Accelerators leben —
 * **Ctrl+R laedt `setup.html` mitten im Lauf neu**. Danach fragt die Seite `status()`, sieht
 * (Sondierungsimporte da, Merker noch nicht geschrieben) `venvVeraltet: true` und zeigt den
 * Knopf wieder aktiv. „Es passiert nichts, ich lade mal neu" waehrend eines 10–30-Minuten-
 * Downloads ist genau der Nutzer, fuer den diese Seite gebaut ist. Dasselbe erreicht der
 * `fehler`-Zweig im Renderer, der den Knopf wieder freigibt.
 *
 * Der Riegel gehoert deshalb in den Hauptprozess, nicht in den Renderer: `disabled` am Knopf
 * ueberlebt kein Neuladen.
 */
let einrichtungLaeuft = null
ipcMain.handle('einrichten', () => {
  if (einrichtungLaeuft) return einrichtungLaeuft
  einrichtungLaeuft = setup.einrichten(z => senden('log', z), s => senden('phase', { schritt: s }))
    .then(async r => {
      if (r.ok) await serverStarten()
      // Ein GEWOLLTER Abbruch ist kein Fehler: die Seite zeigt ihn aus dem Rueckgabewert,
      // nicht rot (#242). Ohne die Ausnahme stuende "Abgebrochen" als FEHLER-Zeile im
      // Protokoll und auf der Seite.
      else if (!r.abgebrochen) senden('fehler', r.fehler)
      return r
    })
    // Erst danach freigeben — und in BEIDE Richtungen: bliebe der Merker nach einem Wurf
    // stehen, waere die Einrichtung fuer den Rest der Sitzung tot.
    .finally(() => { einrichtungLaeuft = null })
  return einrichtungLaeuft
})

// Der Rueckweg (#242): der laengste Lauf der App war der einzige ohne Abbruch.
// Ohne laufende Einrichtung ist der Aufruf wirkungslos — der Knopf existiert nur waehrend eines Laufs.
ipcMain.handle('einrichten:abbrechen', () => {
  if (einrichtungLaeuft) {
    // Eine Zeile ins Protokoll: der Abbruch selbst schreibt nirgends hin, und die Datei
    // existiert fuer genau solche Fragen (war der Lauf abgebrochen oder gestorben?).
    senden('log', 'Abbruch angefordert — beende den laufenden Schritt …')
    setup.abbrechen()
  }
})

ipcMain.handle('logs', () => backend.log())

// Das Overlay ist eine feste Farbe im Hauptprozess und weiss nichts vom Thema der Seite.
// Ohne diesen Weg stuenden im Dunkelmodus schwarze Fensterknoepfe auf dunklem Grund.
ipcMain.handle('titelleisteFarbe', (_e, f) => {
  if (!win || win.isDestroyed() || process.platform === 'darwin') return
  if (!farbeGueltig(f)) return          // ungeprueft wirft `f.color` bei null, s. fenster.js
  win.setTitleBarOverlay({ color: f.color, symbolColor: f.symbolColor, height: TITELLEISTE_HOEHE })
})

// Anteil 0..1 zeigt den Balken, <0 raeumt ihn ab, >1 waere unbestimmt. Der Renderer
// schickt -1, sobald nichts mehr laeuft — sonst bleibt der Balken nach dem letzten
// Lauf am Symbol stehen und behauptet Arbeit, die es nicht gibt.
// 'error' faerbt ihn rot (Spec-Entscheidung 7). Nur dieser eine Modus wird durchgelassen:
// die Bruecke ist die Vertrauensgrenze, und mehr braucht der Renderer nicht.
ipcMain.handle('fortschritt', (_e, anteil, modus) => {
  if (!win || win.isDestroyed()) return
  if (!fortschrittGueltig(anteil)) return   // >1 waere ein unbestimmter Dauerbalken, s. fenster.js
  if (modus === 'error') win.setProgressBar(anteil, { mode: 'error' })
  else win.setProgressBar(anteil)
})

ipcMain.handle('update:status', () => aktualisierer && aktualisierer.zustand())
ipcMain.handle('update:pruefen', () => aktualisierer && aktualisierer.pruefen())
ipcMain.handle('update:laden', () => aktualisierer && aktualisierer.laden())
ipcMain.handle('update:installieren', () => {
  // Erst wenn der Download wirklich fertig ist: sonst laeuft die App mit totem Backend
  // weiter, ohne dass quitAndInstall() je zum Neustart kommt.
  if (!aktualisierer || aktualisierer.zustand().art !== 'bereit') return
  backend.stop()          // sonst bleibt uvicorn als Waise mit belegter GPU zurueck
  aktualisierer.installieren()
})

/**
 * Nur EINE Instanz — und zwar wegen der venv, nicht wegen des Fensters (#231).
 *
 * Zwei Electron-Prozesse teilen sich dasselbe `userData` und damit dieselbe venv. Ein Klick
 * auf „Jetzt einrichten" in beiden Fenstern schickt zwei `pip install -r` in dasselbe
 * `site-packages`; pip hat dafuer keinen Schutz (das Lock in webtool/sperre.py deckt die
 * yt-dlp-Selbstaktualisierung ab, nicht diesen Weg). `startLaeuft` weiter unten ist KEIN
 * Ersatz: es gilt innerhalb eines Prozesses.
 *
 * Der Fall existierte vorher schon, war aber nur im allerersten Start erreichbar — ein
 * Zeitfenster von Minuten, einmal pro Installation. Seit dem requirements-Merker (#181)
 * erscheint die Einrichtungsseite nach JEDEM Update, das Pakete bringt; das Fenster geht
 * damit regelmaessig wieder auf. Das ist die Frage „was erlaubt die Reparatur NEU?":
 * kein neuer Fehler, aber eine deutlich groessere Trefferflaeche fuer einen alten.
 *
 * Nebenbei geschlossen: zwei uvicorn auf zwei Ports.
 *
 * **`return`, nicht `else`.** `app.quit()` ist asynchron — es feuert `before-quit`/`will-quit`
 * und sagt NICHT zu, dass `ready` danach ausbleibt. Kaeme es doch, taete die sterbende Instanz
 * genau das, was die Sperre verhindern soll: `fenster()`, `pruefen()` → `setup.status()`
 * (spawnt Python und winget) und bei fertiger venv `serverStarten()` — ein zweiter uvicorn.
 * Deshalb haengt `starten` im `else`, nicht am Modulrumpf: die Zusage ist baulich gedeckt
 * statt zeitlich gehofft — der lokale Nachweis „ein Fenster statt zwei" haette ein Fenster,
 * das 200 ms lebt, ohnehin nicht gesehen.
 *
 * Hier stand kurz `app.quit(); return` auf Modulebene. Node nimmt das in CommonJS an (der
 * Modulrumpf IST eine Funktion, nachgemessen), aber **Biome bricht die Datei damit GANZ ab**
 * („Illegal return statement outside of a function" → „formatting aborted due to parsing
 * errors", selbst nachgefahren). Nicht die eine Zeile faellt dann aus der statischen Analyse,
 * sondern `main.js` vollstaendig — und still. Zu teuer fuer ein gespartes Einruecken; die
 * benannte Funktion kostet dasselbe und liest sich besser.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Der zweite Doppelklick ist keine Fehlbedienung, sondern die Suche nach dem Fenster —
    // kommentarlos zu sterben laese ihn wie eine kaputte App aussehen. Steht noch kein Fenster
    // (die Millisekunden zwischen Sperre und `fenster()`), bleibt es dabei: `app.focus()`
    // haette dann nichts zu holen.
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(starten)
}

/** Der eigentliche Start — nur die Instanz, die die Sperre haelt, ruft ihn (Funktion statt
 *  Rueckgabe an Ort und Stelle, damit der Rumpf seine Einrueckung behaelt). */
async function starten() {
  protokoll.kopf()
  fenster()
  await pruefen()
  // Update: Pruefen laeuft von selbst, Laden erst auf Klick. Der Zustand geht ins Fenster
  // (Einstellungen), Fehler zusaetzlich ins Protokoll — ein Popup, das man wegklickt und
  // nicht wiederfindet, gibt es bewusst nicht mehr.
  try {
    const { autoUpdater } = require('electron-updater')
    // app-update.yml ist die EINZIGE Publish-Quelle, die das Packen ueberlebt: electron-builder
    // loescht `build` aus der package.json, die es in die App legt (app-builder-lib/out/
    // fileTransformer.js, `ignoredPackageMetadataProperties`). Ohne sie stand auf macOS in
    // jedem Protokoll "Failed to parse URL from null" — der Mac-Zweig holt seine
    // latest-mac.yml selbst und lief damit gegen feedUrl=null.
    // Fehlt die Datei (Entwicklungsbetrieb), faellt macUrls auf paket.build.publish zurueck.
    let updateYml = ''
    try { updateYml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8') }
    catch (e) {
      // Im Entwicklungsbetrieb gibt es die Datei nicht — das ist der Normalfall und keine
      // Meldung wert. GEPACKT ist ihr Fehlen der Grund, warum gleich nichts mehr geht:
      // ohne die Zeile stuende im Protokoll danach NICHTS (vorher stand dort wenigstens
      // "Failed to parse URL from null"), und wer "bei mir kommt kein Update" meldet,
      // liefert eine Datei, in der der Grund fehlt. Dieselbe Regel wie #192.
      if (app.isPackaged) protokoll.schreiben(`app-update.yml nicht lesbar: ${e && e.message || e}`)
    }
    const macUrls = updater.macUrls(paket, updateYml)
    autoUpdater.logger = null
    aktualisierer = updater.erstellen({
      autoUpdater,
      version: app.getVersion(),
      plattform: process.platform,
      gepackt: app.isPackaged,
      appimage: !!process.env.APPIMAGE,
      // Mac prueft manuell per latest-mac.yml (Auto-Update ohne Notarisierung tot); Win/Linux
      // ignorieren hole/openExternal/URLs — sie wandern nur in den Mac-Zweig von erstellen().
      hole: fetch,
      openExternal: shell.openExternal,
      feedUrl: macUrls && macUrls.feed,
      releaseUrl: macUrls && macUrls.release,
      // Hereingereicht wie `hole`/`openExternal`, aus demselben Grund: sonst liesse sich der
      // Mac-Zweig nur auf einem Mac pruefen. `os.release()` liefert die DARWIN-Version
      // ("22.6.0" = macOS 13); die Umrechnung macht `updater.macosAusDarwin` (#536).
      osRelease: () => os.release(),
      aendert: z => {
        if (z.art === 'fehler') protokoll.schreiben(`Update-Pruefung fehlgeschlagen: ${z.text}`)
        if (win && !win.isDestroyed()) win.webContents.send('update', z)
      },
    })
    // Der Anfangszustand geht NICHT durch `aendert` (er wird in `erstellen` direkt gesetzt),
    // faende also keinen Weg ins Protokoll — und `keine-quelle` ist genau der Zustand, ueber
    // den jemand spaeter Auskunft braucht.
    const anfang = aktualisierer.zustand()
    if (anfang.art === 'nicht_moeglich' && anfang.grund === 'keine-quelle') {
      protokoll.schreiben('Update-Pruefung nicht moeglich: keine Update-Quelle '
        + '(app-update.yml fehlt/ohne github-Publish, und die gepackte package.json traegt kein build-Feld)')
    }
    aktualisierer.pruefen()
    // Danach alle 6 h leise nachsehen. Ohne das erfaehrt eine App, die tagelang offen bleibt
    // (bei langen Transkriptionen der Normalfall), erst beim naechsten Start von einer neuen
    // Version. Eine Runde kostet einen GET auf latest.yml (~1 KB); geladen wird weiterhin
    // erst auf Klick (autoDownload=false).
    const zeitgeber = setInterval(() => {
      // Offline ergaebe nur eine Fehlerzeile im Protokoll und "Pruefung fehlgeschlagen" in
      // der Fusszeile — beides falsch, solange niemand danach gefragt hat.
      if (!net.isOnline()) return
      if (!updater.sollPruefen(aktualisierer.zustand())) return
      aktualisierer.pruefen()
    }, 6 * 60 * 60 * 1000)
    // Ein Hintergrund-Zeitgeber darf die App nie am Leben halten.
    zeitgeber.unref()
  } catch (e) {
    // Eigener Wortlaut, nicht derselbe wie beim fehlenden Feed (oben): seit die Oberflaeche
    // den Nutzer aktiv in diese Datei schickt, muessen die beiden Lagen unterscheidbar sein.
    protokoll.schreiben(`Update-Aufbau fehlgeschlagen: ${e && e.message || e}`)
    // Ohne Ersatz bliebe `aktualisierer` null, `update:status` lieferte null — und das ist im
    // Frontend NICHT von „laeuft im normalen Browser" zu unterscheiden (#319). Die
    // Entscheidung „behalten oder ersetzen" steht in `updater.nachFehler`, damit sie einen
    // Test hat; hier bleibt eine Leitung. Der `catch` deckt dabei ALLES ab `require` bis
    // `erstellen` — nicht nur den Namensgeber `electron-updater`.
    aktualisierer = updater.nachFehler(aktualisierer, app.getVersion())
  }
}

app.on('window-all-closed', () => { backend.stop(); app.quit() })
// `Sentry.close` gibt dem Transport bis zu 2 s, was noch unterwegs ist. Nicht abgewartet:
// Electron wartet hier ohnehin nicht, und ein Ereignis, das dabei verloren geht, ist eines
// (die Offline-Warteschlange greift nur bei FEHLGESCHLAGENEM Senden, nicht beim Beenden).
app.on('before-quit', () => { backend.stop(); Sentry.close(2000).catch(() => {}) })
// Der Server ueberlebt einen harten Abbruch sonst als Waise mit belegter GPU.
process.on('exit', () => backend.stop())

app.on('activate', () => { if (!win) { fenster(); if (bereit) win.loadURL(backend.url()) } })
