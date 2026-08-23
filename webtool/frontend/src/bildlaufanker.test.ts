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
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { ScrollArea } from './components/ui/scroll-area'

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
 * traegt kein `overflow-*` im Markup, Radix setzt `overflow` zur LAUFZEIT
 * (`@radix-ui/react-scroll-area` Viewport: nur `overflowX`/`overflowY`, KEIN `position`;
 * die Root setzt `position:"relative"` inline). Der Viewport ist damit ein
 * Bildlaufbehaelter, den ein Quelltext-Scanner strukturell nie sieht.
 *
 * Gemessen am echten Dokument (105 Segmente, 14 Anmerkungen, Fenster 1927x1299), bevor der
 * Anker gesetzt war: von 121 absolut positionierten Nachfahren entkamen **16** der Klemmung
 * — alle `sr-only`, deren Bezugsrahmen die ScrollArea-WURZEL war. Ihre Flusspositionen
 * reichten bis 9909 px bei einer Viewport-Unterkante von 1144 px; das blies die Wurzel auf
 * `scrollHeight` 9816 und gab dem `overflow-auto`-Div aus `EditorView.tsx` eine ZWEITE,
 * echte Bildlaufflaeche. Mit dem Anker im selben Lauf: entkommene 16 -> 0, `scrollHeight`
 * des Divs 9816 -> 1051 (= `clientHeight`), native Leiste 10 px -> 0 px, Transkript rollt
 * weiter (Viewport 9951 > 1051).
 *
 * **Gemessen wird das GERENDERTE Element, nicht der Quelltext — und das ist der Kern.**
 * Die erste Fassung las `scroll-area.tsx` und nahm das erste `className="…"` nach dem
 * Viewport. Schreibt man den Viewport als `className={cn("size-full …")}` — die Form, die
 * Root und ScrollBar in DERSELBEN Datei benutzen —, findet die Regex dort keinen
 * Anfuehrungsstrich und rutscht weiter bis zum `ScrollAreaThumb`, der zufaellig `relative`
 * traegt: Build gruen, Waechter gruen, Defekt zurueck (im Review gemessen). Am gerenderten
 * Knoten ist die Bauform der Klassenliste egal.
 *
 * jsdom rechnet kein Layout — die WIRKUNG ist hier nicht pruefbar, sie ist im Browser
 * gemessen (Zahlen oben). Hier steht, woran sie haengt.
 */
describe('Radix-ScrollArea: der Viewport traegt den Anker selbst', () => {
  it('der gerenderte Viewport hat eine Anker-Klasse', () => {
    const { container } = render(
      createElement(ScrollArea, null, createElement('p', null, 'Inhalt')),
    )
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]')
    // Positivkontrolle: ohne sie waere eine umbenannte Radix-Marke ein gruener Test.
    expect(viewport).not.toBeNull()
    const klassen = (viewport!.className || '').split(/\s+/)
    expect(klassen.filter(k => ANKER.includes(k))).not.toEqual([])
  })
})
