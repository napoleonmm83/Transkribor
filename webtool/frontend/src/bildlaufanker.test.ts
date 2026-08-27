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
 * - Der Scanner kennt nur Zeichenketten-Literale — aber seit #366 an JEDER Stelle, nicht
 *   nur direkt am Attribut: `cn(...)`, `cva`-Varianten, Arrays und die Zweige eines
 *   Ternary fallen darunter, weil es dieselbe Zeichenkette ist. Was ihm bleibt: ein zur
 *   LAUFZEIT zusammengesetzter Wert (Interpolation, Fremdkomponente ohne Klasse im
 *   Markup). Genau dafuer gibt es unten den zweiten Block, der am GERENDERTEN DOM misst.
 * - `overflow-hidden` bleibt ausgeklammert: dieselbe Luecke, aber ueberall Zierrat
 *   (Text-Abschneiden), jeder Treffer waere Rauschen — dieselbe Abgrenzung wie im
 *   Hüllen-Test.
 *
 * Drei weitere Vektoren (heute null Fundstellen im Korpus, bewusst nur dokumentiert —
 * ein Kommentar-Stripper oder Breakpoint-Paar-Scanner waere der Ueberbau fuer 4 Stellen):
 * - FALSCH ROT: auskommentierter Code mit `"… overflow-auto …"` matcht weiter. Seit #366
 *   ist der Vektor BREITER (jede Zeichenkette im Kommentar, nicht nur ein className-JSX);
 *   am Korpus dieses Commits gemessen bleibt er bei null. Die Prosa dieses Repos zitiert
 *   Klassennamen in Backticks — und die stehen bewusst nur am Attribut zur Verfuegung,
 *   sonst waeren es hier und heute 9 Fehlalarme.
 * - FALSCH ROT: interpolierte Anker (`` className={`overflow-auto ${x ? 'relative' : ''}`} ``)
 *   sind im Rohquelltext kein bare Token, obwohl der Anker zur Laufzeit existiert.
 * - FALSCH ROT: responsive Varianten (`md:overflow-auto md:relative`) — der Anker muesste
 *   paarweise je Breakpoint stehen, das kann ein Token-Vergleich nicht ausdruecken.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { ScrollArea } from './components/ui/scroll-area'
import { Command, CommandList } from './components/ui/command'

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

/** JEDE Zeichenkette in Anfuehrungszeichen, nicht nur die direkt am Attribut (#366).
 *  `className="…"` und `className={'…'}` fallen weiterhin darunter — der alte Ausdruck
 *  war eine echte Teilmenge dieses hier (CodeRabbit-Fund PR #291 bleibt gedeckt).
 *
 *  Der Grund fuer die Weitung: `cn("… overflow-y-auto …", …)` ist die Form, die
 *  `components/ui/` durchweg benutzt. Am Korpus dieses Commits gemessen sah der alte
 *  Scanner dort **0 von 4** Bildlaufbehaeltern — blind ausgerechnet bei den GETEILTEN
 *  Bauteilen, die jede Seite erbt. Ternaries, Arrays und `cva`-Varianten fallen als
 *  Nebenwirkung mit ab: es ist dieselbe Zeichenkette, nur ein anderer Aufrufer. Ein
 *  `cn(`-Sonderfall waere ein zweiter Parser fuer denselben Zweck gewesen.
 *
 *  `\n` als Ausschluss ist nicht Zierrat, sondern die Klammer um den breiten Durchgang.
 *  Am Attribut war der Ausdruck von selbst begrenzt; frei im Text ist er es nicht — und
 *  die Anfuehrungszeichen-Paritaet gewoehnlichen Codes ist keine Zusicherung, weil die
 *  beiden Alternativen einander die Zeichen wegnehmen. OHNE die Klammer gemessen (Mutation
 *  am Korpus dieses Commits): ein Treffer der `'`-Alternative lief in `MaterialDialog.tsx`
 *  ab Zeile 300 ueber **3868 Zeichen** und rund 40 Zeilen JSX und Kommentar hinweg, zog
 *  ein `overflow-y-auto` ohne Anker mit herein — und machte den Waechter an voellig
 *  gesundem Code rot. Ein Waechter mit Fehlalarmen wird weggeklickt. */
const KLASSENLISTE_RE = /"([^"\n]*)"|'([^'\n]*)'/g
/** Template-Literale NUR direkt am Attribut — bewusst nicht im breiten Durchgang.
 *  Gemessen: breit gescannt bringen Backticks **9 Fundstellen** dazu, allesamt Prosa aus
 *  den Doku-Kommentaren dieses Repos (`overflow-auto` in JSDoc/JSX-Kommentaren), und
 *  KEINE davon traegt einen Anker — der Waechter ginge also am DOKUMENTIEREN rot. Ein
 *  Waechter mit Fehlalarmen wird weggeklickt, und dann ist er schlechter als keiner. */
const TEMPLATE_AM_ATTRIBUT_RE = /className\s*=\s*\{`([^`]*)`\}/g

const fundstellen: { datei: string; klassen: string }[] = []
for (const [pfad, inhalt] of Object.entries(quellDateien)) {
  if (KEIN_QUELLCODE.test(pfad)) continue
  for (const re of [KLASSENLISTE_RE, TEMPLATE_AM_ATTRIBUT_RE]) {
    for (const treffer of inhalt.matchAll(re)) {
      const klassen = treffer[1] ?? treffer[2] ?? ''
      if (/overflow-(x-|y-)?(auto|scroll)/.test(klassen)) fundstellen.push({ datei: pfad, klassen })
    }
  }
}

describe('Quellbaum: jeder Bildlaufbehaelter hat einen Bezugsrahmen (#209)', () => {
  it('findet ueberhaupt Bildlaufbehaelter (Positivkontrolle)', () => {
    // Still leere Schleife = still grüne Zusicherung — dieselbe Falle wie am Hüllen-Test.
    expect(fundstellen.length).toBeGreaterThan(0)
  })

  it('sieht Klassenlisten auch in cn(...) — die geteilten ui/-Bauteile (#366)', () => {
    // Die Positivkontrolle darueber genuegt hier NICHT: sie blieb gruen, waehrend der
    // Scanner zwei Drittel des Korpus uebersah (6 von 19 Zeilen gesehen). Sie faengt
    // nur den Totalausfall, nicht das Schrumpfen.
    //
    // `components/ui/` ist die Probe mit Aussage: dort steht die Klassenliste DURCHWEG
    // als `cn("…")`, nie als Literal am Attribut. Der alte Ausdruck fand hier deshalb
    // exakt NULL, der neue vier (alert-dialog, command, dialog, select) — und es sind
    // die Bauteile, die jede Seite erbt, ein Loch wirkt hier breiter als anderswo.
    // An der KLASSE festgemacht, nicht an Dateinamen: eine umbenannte Datei soll den
    // Waechter nicht stillegen.
    const ui = fundstellen.filter(f => f.datei.includes('/components/ui/'))
    expect(
      ui.length,
      'keine Bildlaufbehaelter in components/ui/ — sieht der Scanner cn(...) nicht mehr?',
    ).toBeGreaterThan(0)
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
/** Traegt der gerenderte Knoten eine Anker-Klasse? Positivkontrolle inklusive: ein
 *  fehlender Knoten (umbenannte Fremd-Marke) macht rot statt still gruen. */
function ankerPruefen(container: HTMLElement, selektor: string) {
  const el = container.querySelector(selektor)
  expect(el, `kein Knoten fuer ${selektor}`).not.toBeNull()
  const klassen = (el!.className || '').split(/\s+/)
  expect(klassen.filter(k => ANKER.includes(k))).not.toEqual([])
}

describe('Fremdkomponenten mit Laufzeit-overflow tragen den Anker selbst', () => {
  it('Radix-ScrollArea: der Viewport', () => {
    const { container } = render(
      createElement(ScrollArea, null, createElement('p', null, 'Inhalt')),
    )
    ankerPruefen(container, '[data-radix-scroll-area-viewport]')
  })

  // cmdk setzt sein `overflow` als KLASSE in `cn(…)`. Seit #366 sieht der Scanner oben das
  // mit — diese Zusicherung ist also nicht mehr die einzige Deckung, sondern die zweite.
  // Sie bleibt trotzdem: der Scanner liest den QUELLTEXT von `command.tsx`, sie den
  // gerenderten Knoten. Wandert das `overflow` in eine Fremdkomponente ohne Klasse im
  // Markup (der Weg, den Radix daneben geht), sieht es nur noch dieser Test.
  it('cmdk: die CommandList', () => {
    const { container } = render(
      createElement(Command, null, createElement(CommandList, null, createElement('div', null, 'x'))),
    )
    ankerPruefen(container, '[data-slot="command-list"]')
  })
})
