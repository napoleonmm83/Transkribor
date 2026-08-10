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
function farbeGueltig(f) {
  return !!f && typeof f.color === 'string' && typeof f.symbolColor === 'string'
}

/** -1 (abraeumen) oder 0..1. Alles andere — NaN, Infinity, 2, 'x' — ist kein Fortschritt. */
function fortschrittGueltig(anteil) {
  return anteil === -1 || (Number.isFinite(anteil) && anteil >= 0 && anteil <= 1)
}

module.exports = { fensterOptionen, TITELLEISTE_HOEHE, farbeGueltig, fortschrittGueltig }
