/**
 * Die Bildlaufleiste haengt an `*`, nicht an einer Klasse.
 *
 * Vorher stand sie als `.rollbalken` an drei Stellen des Material-Dialogs — und nur dort:
 * Huelle, Seitenleiste und Editor trugen daneben die graue Systemleiste (im Browser
 * gesehen, `d244`-Aufnahme). Eine Klasse, die man an jede kuenftige Rollflaeche NICHT
 * vergisst, gibt es nicht; `scrollbar-width` vererbt sich ausserdem nicht, ein
 * `html { … }` genuegt also auch nicht. Dieser Waechter haelt die VERANKERUNG fest, nicht
 * die Farbe.
 *
 * Zwei Dinge, die man nicht aus dem Diff liest:
 * - **Er liegt bewusst NICHT unter `src/`.** Dort haette er die Datei nur ueber Vite lesen
 *   koennen, und `import './src/index.css?raw'` liefert unter vitest einen LEEREN String:
 *   ohne `test.css` stubbt vitest jeden CSS-Import, und der Stub greift vor Vites `?raw`
 *   (gemessen: `laenge: 0`). `test.css: true` haette dafuer die verarbeitete Tailwind-CSS
 *   in JEDEN der ~900 Tests gezogen — ein globaler Umbau fuer eine Zusicherung. Am Root
 *   liegend faellt der Waechter unter `tsconfig.node.json` und darf `node:fs` lesen.
 * - **Die Wirkung selbst ist hier nicht pruefbar:** jsdom rechnet kein Layout und rendert
 *   keine Bildlaufleisten, `getComputedStyle` kennt `scrollbar-width` dort nicht. Geprueft
 *   wurde sie im echten Browser; hier steht nur, woran sie haengt.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// `new URL(…, import.meta.url)` geht hier NICHT: vitest laedt Module ueber seinen eigenen
// Runner, `import.meta.url` traegt dort kein `file:`-Schema („The URL must be of scheme
// file"). `import.meta.dirname` liefert den echten Ordner dieser Datei.
const css = readFileSync(resolve(import.meta.dirname, 'src/index.css'), 'utf8')

describe('Bildlaufleiste', () => {
  it('faerbt JEDE Rollflaeche, nicht nur eine Klasse', () => {
    // Positivkontrolle: die Datei ist wirklich gelesen — sonst waeren die Zusicherungen
    // unten rot aus dem falschen Grund (verschobene Datei statt verschobene Regel).
    expect(css).toContain('@layer base')

    // `[^{}]*` kann keine Regelgrenze ueberschreiten: das matcht NUR einen Block, dessen
    // Selektor `*` ist. `.rollbalken { … }` oder `main { … }` faellt durch. Das `m` ist
    // Pflicht — der Block steht hinter einem Kommentar, vor ihm liegt also `*/`, nicht
    // `}` oder der Dateianfang.
    expect(css).toMatch(/^\s*\*\s*\{[^{}]*scrollbar-width:\s*thin/m)
    expect(css).toMatch(/^\s*\*\s*\{[^{}]*scrollbar-color:/m)
  })
})
