/**
 * Die Bildlaufleiste im Hausakzent haengt an `*`, nicht an einer Klasse — und dort, wo `*`
 * nicht ankommt, am Daumen von Radix.
 *
 * Vorher stand sie als `.rollbalken` an drei Stellen des Material-Dialogs und nur dort:
 * Huelle, Seitenleiste und alle anderen Dialoge trugen daneben die graue Systemleiste (im
 * Browser gesehen). `scrollbar-width` vererbt sich nicht, ein `html { … }` genuegt also
 * auch nicht. Dieser Waechter haelt die VERANKERUNG fest, nicht die Farbe.
 *
 * **Der Editor braucht eine ZWEITE Zusicherung, und das ist der Befund, an dem die erste
 * Fassung dieses Fixes vorbeilief:** das Transkript rollt in einem Radix-ScrollArea
 * (`Transcript.tsx`), und Radix versteckt die native Leiste zur Laufzeit per injiziertem,
 * UNGESCHICHTETEM `<style>` — die `@layer base`-Regel verliert dagegen doppelt (Schicht und
 * Spezifitaet). Sichtbar ist dort Radix' eigener Daumen; der muss die Farbe selbst tragen.
 *
 * Zwei Dinge, die man nicht aus dem Diff liest:
 * - **Der Waechter liegt bewusst NICHT unter `src/`.** Dort haette er die Datei nur ueber
 *   Vite lesen koennen, und `import './src/index.css?raw'` liefert unter vitest einen LEEREN
 *   String: ohne `test.css` stubbt vitest jeden CSS-Import, und der Stub greift vor Vites
 *   `?raw`. GEMESSEN mit einer Wegwerf-Testdatei, die den Wert in eine Zusicherung schrieb:
 *   `{ typ: 'string', laenge: 0, kopf: '' }` bei 17 719 Byte Datei — sowohl als direkter
 *   Import als auch ueber `import.meta.glob(..., { query: '?raw' })`. Mit `test.css: true`
 *   kam derselbe Ausdruck auf `laenge: 17653`; das haette die verarbeitete Tailwind-CSS in
 *   JEDEN der ~900 Tests gezogen. Am Root faellt der Waechter unter `tsconfig.node.json`
 *   und darf `node:fs` lesen.
 * - **Kommentare werden vor dem Vergleich entfernt.** Ohne das haelt ein Kommentar, der die
 *   Regel ZITIERT, den Waechter gruen, waehrend die Regel geloescht ist. GEMESSEN als
 *   Mutation an `src/index.css`: den `* { … }`-Block ersetzt durch
 *   `/* Hier stand frueher: * { scrollbar-width: thin; … } *\/` und
 *   `npx vitest run rollbalken.test.ts` gefahren — OHNE `ohneKommentare` gruen (2 passed),
 *   MIT rot (`1 failed | 1 passed`), Rueckbau gruen. Dieses Repo zitiert Code in
 *   Kommentaren am laufenden Band (die Datei hier auch).
 *
 * Die Wirkung selbst ist hier nicht pruefbar: jsdom rechnet kein Layout und rendert keine
 * Bildlaufleisten, `getComputedStyle` kennt `scrollbar-width` dort nicht. Geprueft wurde sie
 * im echten Browser; hier steht nur, woran sie haengt.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// `new URL(…, import.meta.url)` geht hier NICHT: vitest laedt Module ueber seinen eigenen
// Runner, `import.meta.url` traegt dort kein `file:`-Schema („The URL must be of scheme
// file"). `import.meta.dirname` liefert den echten Ordner dieser Datei.
const lies = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), 'utf8')
const ohneKommentare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('Bildlaufleiste', () => {
  it('faerbt JEDE native Rollflaeche, nicht nur eine Klasse', () => {
    const roh = lies('src/index.css')
    // Lesekontrolle: es ist wirklich diese Datei — sonst waeren die Zusicherungen unten rot
    // aus dem falschen Grund (verschobene Datei statt verschobene Regel).
    expect(roh).toContain('@layer base')

    const css = ohneKommentare(roh)
    // `[^{}]*` kann keine Regelgrenze ueberschreiten: das matcht NUR einen Block, dessen
    // Selektor `*` ist. `main { … }` faellt durch. Das `m` ist Pflicht — vor dem Block steht
    // ein Kommentar, der Blockanfang liegt also weder am Dateianfang noch hinter einem `}`.
    expect(css).toMatch(/^\s*\*\s*\{[^{}]*scrollbar-width:\s*thin/m)
    expect(css).toMatch(/^\s*\*\s*\{[^{}]*scrollbar-color:/m)

    // Und sie darf nicht WIEDER an eine Klasse wandern: ein klassengebundener Block wuerde
    // dieselbe Luecke aufmachen, aus der dieser Fix kommt. Mutation `* {` → `.rollbalken {`
    // ⇒ `1 failed | 1 passed`, Rueckbau ⇒ `2 passed`.
    expect(css).not.toMatch(/\.[\w-]+[^{}]*\{[^{}]*scrollbar-width/)
  })

  it('faerbt den Radix-Daumen, den die globale Regel nicht erreicht', () => {
    const tsx = ohneKommentare(lies('src/components/ui/scroll-area.tsx'))
    // Dieselbe Farbe wie die globale Regel: Tailwind v4 uebersetzt `/70` nach
    // `color-mix(in oklab, var(--primary) 70%, transparent)` — am gebauten Bundle abgelesen.
    expect(tsx).toMatch(/ScrollAreaThumb[\s\S]{0,300}bg-primary\/70/)
    expect(tsx).not.toMatch(/ScrollAreaThumb[\s\S]{0,300}bg-border/)
  })
})
