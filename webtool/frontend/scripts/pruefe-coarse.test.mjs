import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Eichzeile zum Waechter aus #438.
 *
 * Warum sie noetig ist: der Waechter am echten Bau ist ein GROBES Instrument. Er
 * beantwortet „entsteht die Regel ueberhaupt noch?", nicht „ist das Muster genau genug?"
 * — jede Zusicherung darunter braucht eine eigene Fixture.
 *
 * Der Waechter selbst lag anfangs in seiner eigenen Falle: er trug den Klassennamen am
 * Stueck in seiner Erfolgsmeldung, und diese Datei liegt INNERHALB des Baums, den
 * Tailwind nach Klassennamen durchsucht — er hielt seine eigene Bedingung am Leben und
 * konnte nie rot werden. Daher der zusammengesetzte Name hier wie dort.
 *
 * Die Scan-Basis ist das VITE-ROOT (`webtool/frontend`, `vite.config.ts` setzt kein
 * eigenes `root`), NICHT der Projektstamm — gemessen mit demselben Oxide-Scanner, den
 * das Plugin nimmt: 171 Dateien ab `webtool/frontend`, 412 ab dem Stamm. Notizdateien
 * im Stamm sind also NICHT bauwirksam. (Hier stand zuerst das Gegenteil: vier solche
 * Dateien seien die Ursache der byte-gleichen Ausgabe gewesen. Das war aus einem `grep`
 * ueber den Stamm geschlossen, nie gemessen — und falsch.)
 *
 * Die Gegenprobe am echten Bau ist damit nachgeholt: Klasse aus allen vier gescannten
 * Quellen entfernt, Notizdateien im Stamm unangetastet ⇒ Bau bricht mit rc=1 ab und der
 * CSS-Hash wechselt (61,81 → 61,74 kB).
 *
 * Was daraus folgt und was NICHT: der Waechter deckt die Ausfallart aus #438 — die
 * Tailwind-Variante faellt weg oder wird umbenannt, dann erzeugt KEINE Quelle mehr eine
 * Regel. Er deckt NICHT, dass ein Bauteil die Klasse noch traegt; das tun die
 * jsdom-Tests in `SpeakerTurn.test.tsx` und `HomeGallery.test.tsx`. Beide zusammen sind
 * vollstaendig, einer allein nicht.
 *
 * Gefahren wird der ECHTE Einstieg als Prozess, nicht eine nachgebaute Kopie seiner
 * Logik — sonst prueft die Eichzeile ihr eigenes Duplikat. Der Rueckgabewert ist die
 * Zusicherung: `postbuild` haelt den Bau nur an, wenn er ungleich 0 ist.
 *
 * Der Klassenname steht auch hier ZUSAMMENGESETZT (Grund im Waechter): diese Datei liegt
 * im selben Baum, den Tailwind durchsucht.
 */
const KLASSE = 'any-pointer-' + 'coarse' + ':opacity-100'
const REGEL = `@media (any-pointer:coarse){.${'any-pointer-' + 'coarse'}\\:opacity-100{opacity:1}}`

const WAECHTER = join(dirname(fileURLToPath(import.meta.url)), 'pruefe-coarse.mjs')

let arbeit
const assets = (css) => {
  const ordner = join(arbeit, `fall-${Math.random().toString(36).slice(2)}`)
  mkdirSync(ordner, { recursive: true })
  if (css !== null) writeFileSync(join(ordner, 'index-test.css'), css, 'utf8')
  return ordner
}
const fahre = (ordner) => spawnSync(process.execPath, [WAECHTER, ordner], { encoding: 'utf8' })

beforeAll(() => { arbeit = mkdtempSync(join(tmpdir(), 'pruefe-coarse-')) })
afterAll(() => { rmSync(arbeit, { recursive: true, force: true }) })

describe(`Waechter: ${KLASSE} im gebauten CSS (#438)`, () => {
  it('laesst durch, wenn Media-Query UND Klassenselektor stehen', () => {
    const r = fahre(assets(`.a{color:red}${REGEL}`))
    expect(r.status).toBe(0)
  })

  it('haelt an, wenn die Regel gar nicht mehr entsteht — der Fall aus #438', () => {
    const r = fahre(assets('.a{color:red}.opacity-100{opacity:1}'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('weder die Media-Query noch der Klassenselektor')
  })

  it('haelt an, wenn der Selektor OHNE Media-Query steht — die Regel griffe dann ueberall', () => {
    const r = fahre(assets(`.${'any-pointer-' + 'coarse'}\\:opacity-100{opacity:1}`))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('NICHT in einer passenden Media-Query')
  })

  it('haelt an, wenn die coarse-Variante lebt, aber NICHT auf dieser Regel', () => {
    // Die Variante steht hier an einer ANDEREN Utility. Mit einem blossen `.p-4` war
    // dieser Test blind fuer die GENAUIGKEIT des Selektor-Musters: ein auf das nackte
    // `any-pointer-coarse` verengter Waechter blieb gruen (kalter Zweitleser, mit einer
    // Mutation belegt) und liesse damit ein CSS durch, in dem die Variante zwar lebt,
    // die opacity-Regel aber weg ist — genau der halbe Ausfall.
    const r = fahre(assets(`@media (any-pointer:coarse){.${'any-pointer-' + 'coarse'}\\:p-4{padding:1rem}}`))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('einer anderen Zusicherung')
  })

  it('haelt an, wenn der Selektor NEBEN der Query steht statt darin', () => {
    // Beide Teile sind da, nur nicht ineinander — die Regel griffe damit auf JEDEM
    // Geraet. Mit zwei voneinander unabhaengigen Treffern im ganzen Text kam genau
    // dieses CSS durch (rc=0, gemessen); deshalb schneidet der Waechter den Rumpf der
    // Query aus und sucht nur dort.
    const r = fahre(assets(
      `@media (any-pointer:coarse){.fremd{color:red}}\n.${'any-pointer-' + 'coarse'}\\:opacity-100{opacity:1}`))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('einer anderen Zusicherung')
  })

  it('haelt an bei einer NEGIERTEN Query — die kehrt die Zusicherung um', () => {
    // `not (any-pointer: coarse)` gilt fuer Geraete OHNE groben Zeiger. Die Suche fand
    // vorher nur die Teilzeichenfolge und liess das durch (gemessen, rc=0) — der Bau
    // waere gruen gewesen, und die Regel haette ausgerechnet auf Touch nicht gegriffen.
    const r = fahre(assets(
      `@media not (any-pointer: coarse){.${'any-pointer-' + 'coarse'}\\:opacity-100{opacity:1}}`))
    expect(r.status).toBe(1)
  })

  it('haelt an, wenn die Regel in der Query steht, aber die Deckkraft null ist', () => {
    // Der Selektor allein sagt nichts ueber die Wirkung: mit `opacity:0` blieben die
    // Bedienelemente unsichtbar, und der Waechter meldete gruen (gemessen, rc=0).
    const r = fahre(assets(
      `@media (any-pointer:coarse){.${'any-pointer-' + 'coarse'}\\:opacity-100{opacity:0}}`))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('KEINE volle Deckkraft')
  })

  it('nimmt 100% als volle Deckkraft an — der Minifier waehlt die Form, nicht wir', () => {
    // Gegenrichtung: eine Pruefung, die den WERT `1` als Text verlangt, waere ein
    // Fehlalarm, sobald ein Minifier `100%` schreibt — und ein Fehlalarm haelt hier
    // den Bau an, auch den der Installationsdatei.
    const r = fahre(assets(
      `@media (any-pointer:coarse){.${'any-pointer-' + 'coarse'}\\:opacity-100{opacity:100%}}`))
    expect(r.status).toBe(0)
  })

  it('haelt an, wenn gar kein Stylesheet da ist — leere Eingabe ist kein Bestehen', () => {
    const r = fahre(assets(null))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('keine CSS-Datei')
  })

  it('haelt an, wenn das Bau-Verzeichnis fehlt', () => {
    const r = fahre(join(arbeit, 'gibt-es-nicht'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('kein Bau-Verzeichnis')
  })
})
