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
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Was einen Behaelter zum Bezugsrahmen macht — dieselbe Liste wie im Hüllen-Test. */
const ANKER = ['relative', 'absolute', 'fixed', 'sticky']
/** Testdateien und Typdeklarationen gehoeren nicht zum Produktionsmarkup. */
const KEIN_QUELLCODE = /\.(test|d)\.(ts|tsx)$/

function quellDateien(ordner: string): string[] {
  const raus: string[] = []
  for (const name of readdirSync(ordner)) {
    if (KEIN_QUELLCODE.test(name)) continue
    const pfad = join(ordner, name)
    if (statSync(pfad).isDirectory()) raus.push(...quellDateien(pfad))
    else if (/\.(ts|tsx)$/.test(name)) raus.push(pfad)
  }
  return raus
}

/** className="…" wie className={…} — siehe Grenzen im Dateikopf. */
const CLASSNAME_RE = /className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\})/g

const fundstellen: { datei: string; klassen: string }[] = []
for (const pfad of quellDateien(dirname(fileURLToPath(import.meta.url)))) {
  const inhalt = readFileSync(pfad, 'utf8')
  for (const treffer of inhalt.matchAll(CLASSNAME_RE)) {
    const klassen = treffer[1] ?? treffer[2] ?? ''
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
