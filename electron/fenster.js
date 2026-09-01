'use strict'
/**
 * Die Plattformweiche fuer den Fensterrahmen — als eigenes Modul, weil main.js beim blossen
 * Laden schon Electron braucht (require('electron') liefert unter reinem Node nur einen
 * Pfad-String, und backend.js/paths.js greifen beim Import sofort auf app.isPackaged zu).
 * Dieselbe Aufteilung wie updater.js: der Automat ohne Electron, die Verdrahtung in main.js.
 */

/** Muss mit der Hoehe in webtool/frontend/src/components/TitleBar.tsx uebereinstimmen —
 *  das Overlay wird vom Betriebssystem ueber unsere Zeile gelegt, nicht daneben. */
const TITELLEISTE_HOEHE = 40

/**
 * Rahmenloses Fenster, aber die Fensterknoepfe malt weiterhin das Betriebssystem:
 * 'hidden' + titleBarOverlay auf Windows/Linux, 'hiddenInset' auf macOS (Ampelknoepfe
 * bleiben nativ, nur eingerueckt). Selbst gezeichnete Knoepfe waeren das eine Stueck,
 * das auf jeder Plattform anders bricht — und macOS/Linux sind hier ungeprueft.
 *
 * `dunkel` entscheidet die Startfarbe hier und nirgends sonst. Der Renderer schiebt beim
 * Themenwechsel zur Laufzeit per 'titelleisteFarbe' nach, sonst stuenden im Dunkelmodus
 * schwarze Symbole auf dunklem Grund.
 */
function fensterOptionen(platform, dunkel) {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: dunkel ? '#0B0B0F' : '#FAFAFA',
      symbolColor: dunkel ? '#FAFAFA' : '#0B0B0F',
      height: TITELLEISTE_HOEHE,
    },
  }
}

/**
 * Nutzlast-Pruefungen fuer die beiden Fenster-Kanaele. Sie stehen hier statt in main.js,
 * weil sie ohne Electron pruefbar sind — dieselbe Aufteilung wie bei `fensterOptionen`.
 *
 * Geprueft wird ueberhaupt, weil `preload.js` die Vertrauensgrenze ist und der Renderer
 * Transkripttext verarbeitet, der aus einem URL-Import stammen kann. Ohne die Pruefung
 * wirft `titelleisteFarbe(null)` im Hauptprozess, und ein Anteil ueber 1 schaltet
 * Electron auf einen UNBESTIMMTEN Balken — einen, der fuer immer weiterlaeuft.
 */
const HEX = /^#[0-9a-f]{6}$/i

/** Eng auf `#rrggbb`, weil die einzigen Absender (ThemeProvider) genau das schicken und
 *  dies eine Vertrauensgrenze ist: durchgelassen wird, was die App tatsaechlich schickt, nicht
 *  alles, was drueben ankaeme (`setTitleBarOverlay` naehme laut Doku jede CSS-Farbe). "Ist ein
 *  String" waere ein Waechter, der wie einer aussieht und keiner ist. */
function farbeGueltig(f) {
  return !!f && HEX.test(f.color) && HEX.test(f.symbolColor)
}

/** -1 (abraeumen) oder 0..1. Alles andere — NaN, Infinity, 2, 'x' — ist kein Fortschritt. */
function fortschrittGueltig(anteil) {
  return anteil === -1 || (Number.isFinite(anteil) && anteil >= 0 && anteil <= 1)
}

/**
 * Welche Schemata duerfen aus dem Fenster heraus ans BETRIEBSSYSTEM gereicht werden (#426).
 *
 * `setWindowOpenHandler` bekommt seine URL vom RENDERER, und dort laeuft Transkripttext, der
 * aus einem URL-Import stammen kann — dieselbe Vertrauensgrenze, wegen der `_ask_llm` seinen
 * Schreibbereich auf EIN Projekt einengt und `codex exec` zwingend mit `--sandbox read-only`
 * laeuft. Ungeprueft oeffnete `window.open('file:///…')` oder `window.open('ms-msdt:…')`, was
 * der jeweilige SYSTEMhandler hergibt: `shell.openExternal` geht nicht in den Browser, es geht
 * ans Betriebssystem.
 *
 * Eng gehalten wie `farbeGueltig` daneben — durchgelassen wird, was die App tatsaechlich
 * schickt. Und WORAN das haengt, ist wichtiger als die Anzahl: es gibt **elf**
 * `target="_blank"`-Anker im Renderer (ein zwoelfter grep-Treffer in `Sidebar.tsx:192` ist
 * Prosa in einem Kommentar), aber nur ACHT davon tragen eine feste Adresse. Die drei uebrigen
 * sind fremdbestimmt, und was sie auf http(s) haelt, steht in ANDEREN Dateien:
 *   - `Notizen.tsx:38` — eigene Regex `/^https?:\/\//i` auf Text, der ueber HTTP von einem
 *     fremden Server kam. **Hier ist `http:` ausdruecklich erlaubt** — das ist der gemessene
 *     Grund, warum es unten steht (nicht "gleiche Vertrauensklasse", so stand es hier zuerst).
 *   - `SettingsPage.tsx:162` — `lauf.url` aus `webtool/auth.py:62`, `_URL = r"https://…"`.
 *   - `SettingsPage.tsx:931` — `prov.keys_url`, vier https-Konstanten in `webtool/llm.py`.
 * Lockert jemand eine dieser drei Wachen, wird dieser Kommentar still falsch, und nichts
 * verbindet die Stellen. Wer dort etwas aendert, sieht hier nach.
 *
 * **`mailto:` steht bewusst NICHT auf der Liste.** Die erste Fassung hatte es, mit der
 * Begruendung, die App oeffne `mailto:` auf ihrem anderen externen Weg ohnehin. Der
 * Praezedenzfall traegt nicht: dort baut der HAUPTPROZESS die URL aus Konstanten
 * (`bericht.mailto`), hier komponierte sie der RENDERER — Empfaenger, Betreff und Rumpf frei.
 * Genau diese Trennung zieht `preload.js` vier Zeilen weiter oben schon selbst. Kein Link der
 * App braucht diesen Weg (gemessen: keiner der elf ist `mailto:`), und es gibt einen
 * unbelegten, aber plausiblen Zugewinn fuer einen Angreifer: manche Mailprogramme werten
 * `?attach=` aus. Nicht ausgefuehrt — kein Mailprogramm in dieser Umgebung —, aber eine
 * Faehigkeit ohne Nutzer laesst man nicht offen, um einen Verdacht zu widerlegen. Kommt je ein
 * Kontakt-Link, wird die Abweisung protokolliert und die Zeile hier ergaenzt.
 *
 * **Warum das ZIEL zurueckkommt und nicht ja/nein:** mit einem Praedikat prueft der Aufrufer
 * die GEPARSTE URL und oeffnet die ROHE. Gemessen bestehen `"\0https://x"`, `"https\t://x"`
 * und `"ht\ntps://x"` die Pruefung, weil der WHATWG-Parser Steuerzeichen streicht.
 *
 * **Der ZWEITE Aufrufer ist seit #434 da — und die Erwartung an ihn war falsch.** Hier stand,
 * die Luecke werde „erreichbar beim ZWEITEN Aufrufer, und der ist mit dem `will-navigate`-
 * Waechter aus #434 schon vorgeschlagen". Am laufenden Fenster nachgemessen: ein
 * `location.href = "\0http://…"` erreicht `will-navigate` bereits **ohne** das Steuerzeichen —
 * Chromium kanonisiert vor BEIDEN Ereignissen, nicht nur vor dem Fensteroeffner. Die Bauform
 * bleibt richtig (wer den Wert zurueckgibt, kann die Luecke gar nicht erst aufmachen); was sich
 * aendert, ist ihr Status: Vorsorge, kein gedeckter Weg. Erst ein Aufrufer, der seine URL NICHT
 * von Chromium bekommt, macht sie scharf.
 *
 * Der `try` ist die Vertrauensgrenze, **nicht** ein Produktionsfall: aus dem echten Handler
 * kommt nie eine unparsebare URL an (gemessen: `window.open('nicht mal eine url')` erreicht ihn
 * als aufgeloestes `file:///…`). Er kostet nichts und deckt Unit-Tests und kuenftige Aufrufer.
 */
const EXTERN_ERLAUBT = new Set(['https:', 'http:'])

/**
 * Die EINE Klassifikation: Urteil und Begruendung entstehen an derselben Stelle (#458).
 *
 * Rueckgabe `{ziel, grund}` — genau eines von beiden ist gesetzt. Diese Funktion ist bewusst
 * NICHT exportiert: nach aussen gehen die zwei schmalen Sichten darunter, damit der Vertrag
 * von `externesZiel` (`string | null`) unveraendert bleibt. Ein exportiertes Objekt waere im
 * Ablehnungsfall **truthy**, und beide Aufrufer in `main.js` pruefen mit `if (ziel)` — aus
 * einer Diagnose-Verbesserung wuerde ein stiller Durchlass fuer abgewiesene URLs.
 *
 * **Warum EINE Funktion und nicht zwei nebeneinander.** Die erste Fassung dieses Fixes hatte
 * `abweisungsGrund` als eigenstaendigen Zwilling mit eigenem `try`, und der Docstring behauptete,
 * ein Tabellentest ueber dieselbe Eingabeliste fange die Drift. **Das ist widerlegt** (kalter
 * Zweitleser, ausgefuehrt): ein dritter Ablehnungszweig — probiert mit
 * `if (u.username || u.password) return null` — liess alle 15 Tests der Datei GRUEN, und der
 * Zwilling schrieb fuer die so abgewiesene URL weiter „Schema nicht erlaubt" ins Protokoll,
 * also genau die Luege, die #458 beheben sollte.
 *
 * **Was der Umbau bringt, und was NICHT — beides gemessen, damit hier nicht zum zweiten Mal
 * eine zu grosse Zusage steht:**
 *   - GEWINN: Urteil und Begruendung entstehen aus EINEM Parse an EINER Stelle. Fuer dieselbe
 *     Eingabe koennen sie nicht mehr auseinanderlaufen — das konnten die zwei `try` vorher.
 *   - GEWINN: ein Zweig, der `grund` vergisst, faellt LAUT aus. `return null` statt eines
 *     Objekts ergibt beim ersten Aufruf `TypeError` (ausgefuehrt: `externesZiel` und
 *     `abweisungsGrund` warfen beide fuer `https://user:pw@x.test/`), statt still einen
 *     falschen Grund zu protokollieren.
 *   - KEIN GEWINN: die TESTSUITE bleibt trotzdem gruen. Dieselbe Mutation gegen den Umbau
 *     gefahren ergab wieder 15/15 — kein Test kennt eine URL mit Zugangsdaten, also betritt
 *     keiner den neuen Zweig. Einen Test fuer einen Zweig, den es noch nicht gibt, kann es
 *     nicht geben; **ein dritter Ablehnungsgrund ist eine Reviewfrage, keine Testfrage.**
 *     Wer einen einbaut, klassifiziert ihn hier UND legt eine Zeile in `ABWEISUNGEN` an.
 *
 * **`nicht lesbar` ist wie der `try` oben KEIN Produktionsfall.** Aus `setWindowOpenHandler`,
 * `will-navigate` und `will-redirect` kommt nie eine unparsebare URL an — Chromium reicht
 * aufgeloeste URLs durch (gemessen, siehe Kommentar ueber `EXTERN_ERLAUBT`). Der Zweig deckt
 * Unit-Tests und kuenftige Aufrufer. Der produktiv sichtbare Gewinn von #458 liegt woanders:
 * bei einer Weiterleitung mit ERLAUBTEM Schema, wo die Zeile bisher einen Grund behauptete,
 * den es nicht gab.
 */
function pruefen(url) {
  let u
  try { u = new URL(String(url)) } catch { return { ziel: null, grund: 'nicht lesbar' } }
  return EXTERN_ERLAUBT.has(u.protocol)
    ? { ziel: u.href, grund: null }
    : { ziel: null, grund: 'Schema nicht erlaubt' }
}

/** Die gepruefte, kanonisierte URL — oder `null`. Absichtlich der WERT statt ja/nein. */
function externesZiel(url) {
  return pruefen(url).ziel
}

/** WARUM `externesZiel` abgelehnt hat — oder `null`, wenn sie es gar nicht getan hat (#458). */
function abweisungsGrund(url) {
  return pruefen(url).grund
}

/**
 * Gehoert `url` zu einer der Herkuenfte, die die App SELBST laedt (#434)?
 *
 * `setWindowOpenHandler` daneben sieht nur NEUE Fenster. Navigiert das bestehende Fenster weg,
 * laeuft `preload.js` auf der Zielseite erneut — und legt `window.transkribor` dorthin. Das
 * stand im Issue als Herleitung aus Electrons Doku; am laufenden Fenster nachgemessen ist es
 * wahr und schlimmer, als eine Herleitung klingt: auf der fremden Herkunft steht die Bruecke
 * mit **12 Schluesseln** (`einrichten`, `logs`, `protokollOeffnen`, `fehlerbericht`,
 * `projekteOeffnen`, die Update-Kanaele) — nicht ein einzelner Aufruf wie bei #426, sondern
 * dauerhafter Zugriff.
 *
 * Vier Dinge, die man nicht aus dem Diff liest — alle an einem echten Fenster gemessen.
 * **Aufbau, Kommandos und Rohausgaben stehen in
 * `docs/superpowers/specs/2026-08-28-transkribor-will-navigate-sonde.md`**; die Zahlen hier
 * sind Verweise darauf, keine Behauptungen:
 *
 * **Die eigene Herkunft MUSS durchkommen, und das ist kein Vorbehalt, sondern ein Fall.** Ein
 * `loadFile`/`loadURL` aus dem Hauptprozess feuert **kein `will-navigate`** (gemessen; fuer
 * `will-redirect` gilt das nicht — ein Server-Redirect innerhalb eines Hauptprozess-Ladevorgangs
 * erreicht den Waechter sehr wohl, hier folgenlos, weil das Backend nur auf sich selbst
 * umleitet). Ein `location.reload()` im Renderer feuert dagegen
 * sehr wohl, mit der EIGENEN URL. Fuer die Statusseite ist genau das ein dokumentierter
 * Nutzerweg: „Ctrl+R laedt `setup.html` mitten im Lauf neu" steht in `electron/CLAUDE.md` als
 * der Grund, warum `einrichtungLaeuft` im Hauptprozess sitzt. Der `file:`-Arm hier traegt also
 * eine echte Bedienung, keine Theorie.
 *
 * **`file:` hat KEINE Herkunft.** `new URL('file:///x').origin` ist der String `'null'`, und
 * zwar fuer JEDE `file:`-URL. Ein reiner `origin`-Vergleich haette damit
 * `file:///C:/Windows/System32/calc.exe` fuer „unsere setup.html" gehalten — der teuerste
 * Einzelfehler, den diese Funktion machen kann, und er sieht im Code aus wie die kuerzere
 * Fassung. Deshalb der Pfadvergleich, und deshalb faellt alles andere ohne echte Herkunft
 * (`data:`, `about:`) hart durch.
 *
 * **`blob:` gehoert ausdruecklich NICHT in diese Aufzaehlung** — hier stand es zuerst, und das
 * war falsch (gemessen: `blob:http://127.0.0.1:8000/…` hat die Herkunft
 * `http://127.0.0.1:8000` und kommt durch). Ein Blob traegt die Herkunft seines ERZEUGERS,
 * und erzeugen kann einen mit unserer Herkunft nur unsere eigene Seite. Das Verhalten ist
 * richtig und muss so bleiben: `useDoc.ts` und `api.ts` bauen die Export-Downloads genau so.
 * Ein `blob:` fremder Herkunft faellt dagegen durch, und `blob:file:///…` ebenfalls.
 *
 * **Die Liste kommt zur LAUFZEIT.** `backend.url()` steht beim Fensterbau noch nicht fest (der
 * Port entsteht erst mit dem Server, `backend.js:112`). Beim Anhaengen eingeschlossen sperrte
 * der Waechter die eigene App aus, sobald sie vom Startbildschirm zum Server wechselt — und
 * das faellt erst im gepackten Lauf auf.
 *
 * **Boolean statt Wert, anders als `externesZiel` daneben.** Der Grund dort ist, dass der
 * Aufrufer die geparste Form prueft und die rohe WEITERREICHT. Auf dem Durchlass-Pfad hier
 * wird nichts weitergereicht: der Waechter kehrt um, und Chromium navigiert mit der URL, die
 * es ohnehin schon haelt. Es gibt keine Roh/geparst-Luecke, die ein Rueckgabewert schliessen
 * koennte.
 */
function eigeneHerkunft(url, eigene) {
  let u
  try { u = new URL(String(url)) } catch { return false }
  return (eigene || []).some(e => {
    let o
    try { o = new URL(String(e)) } catch { return false }
    // Der HOST gehoert mitverglichen, auch wenn `file:`-URLs meist keinen haben: eine
    // UNC-Referenz auf einen FREMDEN Rechner (`file://server/E:/…/setup.html`) traegt denselben
    // Pfad und galt ohne diese Haelfte als unsere Statusseite (gemessen, Kalt-Review zu #434).
    // `pathToFileURL` liefert immer `''`, und `file://localhost/…` normalisiert der Parser
    // selbst darauf — die beiden echten Formen kostet der Vergleich also nichts.
    if (o.protocol === 'file:') {
      return u.protocol === 'file:' && u.host === o.host && u.pathname === o.pathname
    }
    // Ohne echte Herkunft gibt es nichts zu vergleichen — `'null' === 'null'` waere sonst wahr.
    if (o.origin === 'null') return false
    return u.origin === o.origin
  })
}

module.exports = {
  fensterOptionen, TITELLEISTE_HOEHE, farbeGueltig, fortschrittGueltig, externesZiel,
  abweisungsGrund, eigeneHerkunft,
}
