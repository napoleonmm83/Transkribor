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
 * und `"ht\ntps://x"` die Pruefung, weil der WHATWG-Parser Steuerzeichen streicht. Heute nicht
 * erreichbar — Chromium kanonisiert vor dem Handler (zweimal unabhaengig gemessen) —, aber
 * erreichbar beim ZWEITEN Aufrufer, und der ist mit dem `will-navigate`-Waechter aus #434 schon
 * vorgeschlagen. Wer den Wert zurueckgibt, kann die Luecke gar nicht mehr aufmachen.
 *
 * Der `try` ist die Vertrauensgrenze, **nicht** ein Produktionsfall: aus dem echten Handler
 * kommt nie eine unparsebare URL an (gemessen: `window.open('nicht mal eine url')` erreicht ihn
 * als aufgeloestes `file:///…`). Er kostet nichts und deckt Unit-Tests und kuenftige Aufrufer.
 */
const EXTERN_ERLAUBT = new Set(['https:', 'http:'])

/** Die gepruefte, kanonisierte URL — oder `null`. Absichtlich der WERT statt ja/nein. */
function externesZiel(url) {
  try {
    const u = new URL(String(url))
    return EXTERN_ERLAUBT.has(u.protocol) ? u.href : null
  } catch { return null }
}

module.exports = { fensterOptionen, TITELLEISTE_HOEHE, farbeGueltig, fortschrittGueltig, externesZiel }
