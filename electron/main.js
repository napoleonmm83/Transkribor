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
// Nur fuer den Vergleich in `navigationPruefen`: die Statusseite laedt `loadFile` mit einem
// PFAD, am Waechter kommt sie als `file:`-URL an. Beide Formen muessen aus derselben Quelle
// stammen, sonst sperrt der Waechter ausgerechnet die Einrichtungsseite aus.
const { pathToFileURL } = require('url')
const backend = require('./backend')
const setup = require('./setup')
const protokoll = require('./protokoll')
const bericht = require('./bericht')
const updater = require('./updater')
const {
  fensterOptionen, TITELLEISTE_HOEHE, farbeGueltig, fortschrittGueltig, externesZiel, eigeneHerkunft,
} = require('./fenster')

/** Die EINE Quelle fuer die Statusseite — `loadFile` und der Navigationswaechter (#434). */
const SETUP_HTML = path.join(__dirname, 'setup.html')

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
let abweisungen = 0
/**
 * `was` unterscheidet die beiden Absender (#434) — sonst steht im Protokoll nicht, ob ein
 * FENSTER aufgehen wollte oder das bestehende wegnavigieren. Zaehler, Deckel und Bremse bleiben
 * dabei **geteilt**, und das ist die eigentliche Zusicherung: ein zweiter, eigener Schreibweg
 * waere genau der Fehler, den #426 hier schon einmal gemacht hat — ein Renderer, der beide Wege
 * abwechselnd flutet, haette sonst wieder den doppelten Deckel und entleerte den naechsten
 * Fehlerbericht auf „letzte 0 Protokollzeilen".
 *
 * **Der Preis gehoert dazu:** `abweisungen` wird nie zurueckgesetzt, 20 ist also ein
 * LEBENSZEIT-Budget — und die App bleibt bei langen Transkriptionen tagelang offen. Seit #434
 * zahlen zwei Erzeuger darauf ein: eine Flut auf dem Navigationsweg legt damit auch die
 * Diagnose des Fensteroeffners still. Das ist die bewusste Seite des Tauschs (lieber eine
 * stumme Diagnose als ein entleerter Fehlerbericht), nicht ein uebersehener Nebeneffekt.
 */
function abweisungProtokollieren(url, was = 'Externer Link') {
  abweisungen += 1
  if (abweisungen <= ABWEISUNGEN_MAX) {
    protokoll.schreiben(was + ' abgewiesen (Schema nicht erlaubt): ' + String(url).slice(0, 200))
  } else if (abweisungen === ABWEISUNGEN_MAX + 1) {
    protokoll.schreiben(`Weitere abgewiesene Links werden nicht mehr protokolliert (Deckel: ${ABWEISUNGEN_MAX}).`)
  }
}

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
    else abweisungProtokollieren(url)
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
    const ziel = extern ? externesZiel(url) : null
    if (ziel) shell.openExternal(ziel)
    else abweisungProtokollieren(url, extern ? 'Navigation' : 'Weiterleitung')
  }
  // Zwei Marken statt einer: im Protokoll steht damit auch, WELCHES Ereignis gefeuert hat —
  // bei einer Umleitungskette ist genau das die Information, die man sucht.
  win.webContents.on('will-navigate', navigationPruefen(true))
  win.webContents.on('will-redirect', navigationPruefen(false))
  win.on('closed', () => { win = null })
}

function serverStarten() {
  if (startLaeuft) return startLaeuft
  senden('phase', { schritt: 'Server starten' })
  startLaeuft = backend.start(z => senden('log', z)).then(
    () => { bereit = true; if (win) win.loadURL(backend.url()) },
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
  const paket = require('../package.json')
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
    const paket = require('../package.json')
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
app.on('before-quit', () => backend.stop())
// Der Server ueberlebt einen harten Abbruch sonst als Waise mit belegter GPU.
process.on('exit', () => backend.stop())

app.on('activate', () => { if (!win) { fenster(); if (bereit) win.loadURL(backend.url()) } })
