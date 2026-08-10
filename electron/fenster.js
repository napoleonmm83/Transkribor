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
 * `dunkel` entscheidet die Startfarbe hier und nirgends sonst — main.js reichte sie frueher
 * per Nachpatchen rein (ein totes Erstbelegungs-Geruest, weil das Patchen jede Vorgabe
 * ohnehin ueberschrieb). Der Renderer schiebt beim Themenwechsel zur Laufzeit per
 * 'titelleisteFarbe' nach, sonst stuenden im Dunkelmodus schwarze Symbole auf dunklem Grund.
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

module.exports = { fensterOptionen, TITELLEISTE_HOEHE }
