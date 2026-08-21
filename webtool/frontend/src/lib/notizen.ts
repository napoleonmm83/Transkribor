/**
 * Der Zerleger der Release-Notizen — reine Textlogik ohne React, deshalb in `lib/` und nicht
 * neben der Komponente: eine Datei, die neben einer Komponente auch Nicht-Komponenten
 * exportiert, verliert Fast Refresh (`react(only-export-components)`, am Linter gemessen —
 * 38 Warnungen mit, 37 ohne). Dasselbe Muster wie `lib/materialZeilen.ts` neben
 * `components/MaterialZeile.tsx`.
 */
export type Block =
  | { art: 'titel'; text: string }
  | { art: 'absatz'; text: string }
  | { art: 'zitat'; text: string }
  | { art: 'trenner' }
  | { art: 'liste'; punkte: string[]; nummeriert: boolean }

/**
 * Die Markdown-Teilmenge, die in den Release-Notizen wirklich vorkommt — **gezählt, nicht
 * vermutet** (`gh api repos/…/releases?per_page=10`, die zehn Fassungen, die die Seite zeigt):
 * Überschriften 23, Aufzählungen 26, *kursiv* 25, Trennlinien 4, Nummernlisten 3, Zitat 1,
 * Links 0. Kein Paket dafür — der Text stammt aus der eigenen Feder, react-markdown wären
 * 100 KB.
 *
 * Die erste Fassung behauptete dieselbe Vollständigkeit, hatte aber nie gezählt: kursiv,
 * Nummernlisten und Trennlinien fehlten, und **6 von 10** Fassungen rendeten deshalb falsch —
 * 50 literale Sternchen, ein `---` als Absatz, und die dreischrittige Beschreibung des
 * Material-Dialogs zu EINEM Fliesstext verschmolzen. Wer hier etwas ergänzt, zählt erst.
 *
 * Der Punkt, an dem ein zeilenweiser Renderer scheitert: die Notizen umbrechen ihre
 * Listenpunkte und Absätze mitten im Satz (~95 Zeichen). Eine Folgezeile gehört deshalb zum
 * vorhergehenden Block, bis eine LEERZEILE ihn schliesst — sonst zerfällt jeder Punkt in so
 * viele Punkte, wie er Zeilen hat.
 */
export function bloecke(text: string): Block[] {
  const raus: Block[] = []
  let offen: 'absatz' | 'liste' | 'zitat' | null = null
  for (const roh of String(text || '').split(/\r?\n/)) {
    const zeile = roh.trim()
    if (!zeile) { offen = null; continue }

    // Vor dem Listen-Zweig: `---` traegt kein Leerzeichen nach dem Strich, kollidiert also
    // nicht — geprueft wird es trotzdem zuerst, damit die Reihenfolge nicht vom Zufall lebt.
    if (/^-{3,}$/.test(zeile)) { raus.push({ art: 'trenner' }); offen = null; continue }

    const titel = /^#{1,6}\s+(.+)$/.exec(zeile)
    if (titel) { raus.push({ art: 'titel', text: titel[1] }); offen = null; continue }

    const letzter = raus[raus.length - 1]

    const punkt = /^(?:([-*])|\d+[.)])\s+(.+)$/.exec(zeile)
    if (punkt) {
      const nummeriert = !punkt[1]
      // Ein Wechsel der Listenart beginnt eine neue Liste — sonst stuenden nummerierte
      // Schritte als Punkte in einer Aufzaehlung (oder umgekehrt).
      if (offen === 'liste' && letzter?.art === 'liste' && letzter.nummeriert === nummeriert) {
        letzter.punkte.push(punkt[2])
      } else {
        raus.push({ art: 'liste', punkte: [punkt[2]], nummeriert })
      }
      offen = 'liste'
      continue
    }

    const zitat = /^>\s?(.*)$/.exec(zeile)
    if (zitat) {
      if (offen === 'zitat' && letzter?.art === 'zitat') letzter.text += ' ' + zitat[1]
      else raus.push({ art: 'zitat', text: zitat[1] })
      offen = 'zitat'
      continue
    }

    // Fortsetzungszeilen: sie gehoeren dem offenen Block, egal welcher Art er ist.
    if (offen === 'liste' && letzter?.art === 'liste') {
      letzter.punkte[letzter.punkte.length - 1] += ' ' + zeile
      continue
    }
    if (offen === 'zitat' && letzter?.art === 'zitat') { letzter.text += ' ' + zeile; continue }
    if (offen === 'absatz' && letzter?.art === 'absatz') { letzter.text += ' ' + zeile; continue }
    raus.push({ art: 'absatz', text: zeile })
    offen = 'absatz'
  }
  return raus
}
