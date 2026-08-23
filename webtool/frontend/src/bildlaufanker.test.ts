/**
 * #209: Die Bezugsrahmen-Regel als Quellbaumtest — die Generalisierung des Hüllen-Tests
 * in `AppShell.test.tsx` („gibt JEDEM Bildlaufbehaelter der Huelle einen Bezugsrahmen").
 *
 * `overflow-auto`/`overflow-scroll` klemmen absolut positionierte Nachfahren nur, wenn
 * der Behaelter selbst ihr Bezugsrahmen ist (`relative`/`absolute`/`fixed`/`sticky`);
 * sonst haengen die am Viewport und machen das DOKUMENT scrollbar. Der Hüllen-Test sieht
 * nur, was die Huelle rendert — Bildlaufbehaelter einzelner Seiten blieben ungeprueft.
 *
 * Bewusst ein Quellbaumtest und KEINE Lint-Regel: `npm run lint` laeuft nicht in der CI
 * (`test.yml` faehrt `npm test` und `npm run build`), eine oxlint-Regel waere ein Waechter
 * ohne Vollzug (Wellenplan 2, Welle D).
 *
 * Zwei Grenzen, benannt statt uebersehen:
 * - Der Scanner kennt nur Zeichenketten-Literale (`className="…"` und `className={…}`).
 *   `cn(...)`- oder Ternary-Aufrufe sieht er nicht — die Positivkontrolle faengt dagegen,
 *   wenn er GAR nichts mehr findet (Utility-Umbenennung, kaputte Regex).
 * - `overflow-hidden` bleibt ausgeklammert: dieselbe Luecke, aber ueberall Zierrat
 *   (Text-Abschneiden), jeder Treffer waere Rauschen — dieselbe Abgrenzung wie im
 *   Hüllen-Test.
 *
 * Drei weitere Vektoren (heute null Fundstellen im Korpus, bewusst nur dokumentiert —
 * ein Kommentar-Stripper oder Breakpoint-Paar-Scanner waere der Ueberbau fuer 4 Stellen):
 * - FALSCH ROT: auskommentiertes JSX mit `className="… overflow-auto …"` matcht weiter.
 * - FALSCH ROT: interpolierte Anker (`` className={`overflow-auto ${x ? 'relative' : ''}`} ``)
 *   sind im Rohquelltext kein bare Token, obwohl der Anker zur Laufzeit existiert.
 * - FALSCH ROT: responsive Varianten (`md:overflow-auto md:relative`) — der Anker muesste
 *   paarweise je Breakpoint stehen, das kann ein Token-Vergleich nicht ausdruecken.
 */
import { describe, it, expect } from 'vitest'

/** Was einen Behaelter zum Bezugsrahmen macht — dieselbe Liste wie im Hüllen-Test. */
const ANKER = ['relative', 'absolute', 'fixed', 'sticky']
/** Testdateien und Typdeklarationen gehoeren nicht zum Produktionsmarkup. */
const KEIN_QUELLCODE = /\.(test|d)\.(ts|tsx)$/

// `import.meta.glob` mit `?raw` statt `node:fs`: tsconfig.app.json schraenkt die Typen
// bewusst auf `vite/client` ein (App-Code bleibt browser-only), und der Walk gehoert in
// die Vite-Welt, nicht hinter eine tsconfig-Aufweichung.
const quellDateien: Record<string, string> = {
  ...import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('./**/*.tsx', { query: '?raw', import: 'default', eager: true }),
}

/** className="…" wie className={…} — siehe Grenzen im Dateikopf. Die Form mit
 *  einfachen Anfuehrungszeichen (nackt wie in {'…'}) gehoert dazu: sie waere sonst
 *  der einzige Weg, dem Waechter unbemerkt zu entkommen (CodeRabbit-Fund PR #291). */
const CLASSNAME_RE = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{'([^']*)'\}|\{`([^`]*)`\})/g

const fundstellen: { datei: string; klassen: string }[] = []
for (const [pfad, inhalt] of Object.entries(quellDateien)) {
  if (KEIN_QUELLCODE.test(pfad)) continue
  for (const treffer of inhalt.matchAll(CLASSNAME_RE)) {
    const klassen = treffer[1] ?? treffer[2] ?? treffer[3] ?? treffer[4] ?? ''
    if (/overflow-(x-|y-)?(auto|scroll)/.test(klassen)) fundstellen.push({ datei: pfad, klassen })
  }
}

describe('Quellbaum: jeder Bildlaufbehaelter hat einen Bezugsrahmen (#209)', () => {
  it('findet ueberhaupt Bildlaufbehaelter (Positivkontrolle)', () => {
    // Still leere Schleife = still grüne Zusicherung — dieselbe Falle wie am Hüllen-Test.
    expect(fundstellen.length).toBeGreaterThan(0)
  })

  it('jeder Bildlaufbehaelter im Quellbaum traegt einen Anker', () => {
    // Erst sammeln, dann pruefen — die Fehlermeldung soll den Fundort nennen.
    const ohneAnker = fundstellen
      .filter(f => !f.klassen.split(/\s+/).some(k => ANKER.includes(k)))
      .map(f => `${f.datei}: ${f.klassen}`)
    expect(ohneAnker).toEqual([])
  })
})

/**
 * Der Scanner oben ist an der KLASSE verankert — und genau daran laeuft die meistbenutzte
 * Rollflaeche der App vorbei: Radix' ScrollArea-Viewport (`Transcript.tsx` rollt darin)
 * traegt kein `overflow-*` im Markup, Radix setzt `overflow: scroll` zur LAUFZEIT. Der
 * Viewport ist damit ein Bildlaufbehaelter, den der Scanner strukturell nie sieht.
 *
 * Gemessen am echten Dokument (105 Segmente, 14 Anmerkungen, Fenster 1927x1299), bevor der
 * Anker gesetzt war: von 121 absolut positionierten Nachfahren entkamen **16** der Klemmung
 * — alle `sr-only`, deren Bezugsrahmen die ScrollArea-WURZEL war (`relative`), waehrend der
 * Viewport `static` stand. Ihre Flusspositionen reichten bis 9909 px bei einer
 * Viewport-Unterkante von 1144 px; das blies die Wurzel auf `scrollHeight` 9816 und gab dem
 * `overflow-auto`-Div aus `EditorView.tsx` eine ZWEITE, echte Bildlaufflaeche. Sichtbar als
 * zweite Leiste am rechten Rand, die erst greift, wenn die innere unten ist.
 * Mit `position: relative` am Viewport im selben Lauf: entkommene 16 -> 0,
 * `scrollHeight` des Divs 9816 -> 1051 (= `clientHeight`), native Leiste 10 px -> 0 px,
 * und das Transkript rollt weiter (Viewport 9951 > 1051).
 *
 * Warum eine EIGENE Zusicherung und keine Erweiterung des Scanners: der Scanner
 * muesste dafuer wissen, welche Fremdkomponenten ihr `overflow` in JS setzen — das ist
 * keine Regel ueber den Quellbaum mehr, sondern eine Liste. Diese Liste hat heute genau
 * einen Eintrag, und der steht hier.
 */
describe('Radix-ScrollArea: der Viewport traegt den Anker selbst', () => {
  const quelle = quellDateien['./components/ui/scroll-area.tsx']

  it('die Datei ist wirklich gelesen (Positivkontrolle)', () => {
    // Ohne das waere eine verschobene Datei ein gruener Test statt eines roten.
    expect(quelle).toBeDefined()
    expect(quelle).toContain('ScrollAreaPrimitive.Viewport')
  })

  it('der Viewport hat einen Bezugsrahmen', () => {
    const ab = quelle.indexOf('ScrollAreaPrimitive.Viewport')
    const treffer = /className\s*=\s*"([^"]*)"/.exec(quelle.slice(ab))
    expect(treffer).not.toBeNull()
    const klassen = treffer![1].split(/\s+/)
    expect(klassen.filter(k => ANKER.includes(k))).not.toEqual([])
  })
})
