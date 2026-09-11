import { expect, test, type Locator, type Page } from '@playwright/test'
import { MATH_QUELLE } from './farb-mathematik'
import { appEinrichten } from './testApp'

/**
 * Browser-Wächter zu #515: die drei Seitenleisten-Bedienelemente („+ Neues Projekt“,
 * Projektzeile, „Projekt unterstützen“) brauchen in ALLEN vier Zuständen mindestens
 * 3:1 Fläche-gegen-Umgebung — gemessen hat die zustands-probe am 2026-09-02 nur
 * 1,00–1,05:1 (Issue #515, SUMMARY probe=115 befunde=13).
 *
 * Warum ein eigener Wächter neben der Sonde: die Sonde ist ein Skill-Werkzeug auf
 * diesem Rechner, die CI sieht sie nie. Derselbe Schritt wie bei #423 — der jsdom-
 * Wächter prüft Klassenstrings, weil jsdom kein Layout rechnet; HIER wird im echten
 * Chromium gerechnet: Zustand herstellen (echter Zeiger, echter Fokus), Farbe gegen
 * komponierte Umgebung stellen, Schwellwert urteilen.
 *
 * Die Regeln sind die der Sonde (zustands-probe.mjs), an einer Stelle bewusst
 * schärfer: eine VORHANDENE Kontur, deren Farbe sich nicht zerlegen lässt, ist rot
 * statt UNBEKANNT — ein Wächter darf an seiner eigenen Messgrösse nicht blind sein.
 */

/** Zustandsmessung — ECHTE FUNKTION, nie als String (derselbe Stolperstein, an dem
 *  die erste Fassung der zustands-probe nie etwas mass). Läuft IN der Seite und ist
 *  selbstenthalten: Closure-Variabeln aus dem Test überleben die Serialisierung nicht. */
const MESSEN = (el: HTMLElement) => {
  const H = (globalThis as { TKFarbe?: any }).TKFarbe
  if (!H) return { unbekannt: 'rechenkern-fehlt' }

  // Komponierte Unterlage OHNE das Element selbst — dieselbe Kette wie die Sonde:
  // Eltern mit Alpha schichten, bis eine deckende Schicht kommt; Verläufe gelten
  // als nicht messbar (nicht nur ungenau: pro Pixel verschieden).
  const hintergrund = (e: HTMLElement) => {
    const schichten: any[] = []
    let n: HTMLElement | null = e.parentElement
    while (n) {
      const cs = getComputedStyle(n)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null
      const roh = cs.backgroundColor
      const c = H.rgba(roh)
      if (!c) {
        const leer = !roh || roh === 'transparent' || roh === 'rgba(0, 0, 0, 0)'
        if (!leer) return null
      } else if (c.a > 0) {
        schichten.push(c)
        if (c.a >= 1) break
      }
      n = n.parentElement
    }
    let unten = { r: 255, g: 255, b: 255, a: 1 }
    for (let i = schichten.length - 1; i >= 0; i--) unten = H.ueber(schichten[i], unten)
    return unten
  }

  const cs = getComputedStyle(el)
  const umgebung = hintergrund(el)
  if (!umgebung) return { unbekannt: 'umgebung' }
  const erg: Record<string, number | null | unknown[]> = {
    text: null, flaeche: null, kontur: null, hatKontur: false, ringe: [] as number[],
  }
  const vorn = H.rgba(cs.color)
  const eigen = H.rgba(cs.backgroundColor)
  // Der Text steht auf der EIGENEN Flaeche, falls eine da ist — sonst auf der Umgebung.
  const untergrund = eigen && eigen.a > 0 ? (eigen.a < 1 ? H.ueber(eigen, umgebung) : eigen) : umgebung
  if (vorn) erg.text = H.verhaeltnis(vorn.a < 1 ? H.ueber(vorn, untergrund) : vorn, untergrund)
  if (eigen && eigen.a > 0) erg.flaeche = H.verhaeltnis(eigen.a < 1 ? H.ueber(eigen, umgebung) : eigen, umgebung)
  const rb = parseFloat(cs.borderTopWidth) || 0
  if (rb > 0 && cs.borderTopStyle !== 'none') {
    erg.hatKontur = true
    const bc = H.rgba(cs.borderTopColor)
    if (bc) erg.kontur = H.verhaeltnis(bc.a < 1 ? H.ueber(bc, umgebung) : bc, umgebung)
  }
  erg.ringe = H.schattenFarben(cs.boxShadow)
    .map((c: any) => H.verhaeltnis(c.a < 1 ? H.ueber(c, umgebung) : c, umgebung))
  return erg
}

type Messung = {
  unbekannt?: string
  text: number | null
  flaeche: number | null
  kontur: number | null
  hatKontur: boolean
  ringe: number[]
}

/** Reihenfolge mit Boden: Fokus VOR jedem Zeiger-Kontakt. Chrominiums :focus-visible-
 *  Heuristik stuft script-focus() nach einer Zeigerbewegung als Maus-Fokus ein — der
 *  Ring erschiene nie, und der Test pruefte einen Zustand, der im Programm nicht
 *  herstellbar waere. Ruhe zuerst (Maus startet bei 0/0, ohne Treffer), dann Fokus,
 *  dann die Zeiger-Zustaende. */
const ZUSTAENDE = ['ruhe', 'focus', 'hover', 'active'] as const
type Zustand = (typeof ZUSTAENDE)[number]

/** Echte Tastatur statt Skript-Fokus: Chromiums :focus-visible-Heuristik stuft
 *  el.focus() aus Skript als Maus-Fokus ein — der Ring erschiene nie, und der Test
 *  pruefte einen Zustand, der fuer Tastatur-Nutzer nie eintritt. Tab bis das Element
 *  fokussiert ist (Reihenfolge-agnostisch, laut rot, wenn das Element nicht
 *  erreichbar waere). Zurueck auf body first, damit der Startpunkt feststeht. */
async function tastaturFokussieren(page: Page, el: Locator) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  for (let i = 0; i < 15; i++) {
    if (await el.evaluate((e) => document.activeElement === e && e.matches(':focus-visible'))) return
    await page.keyboard.press('Tab')
  }
  expect(el, 'per Tastatur fokussierbar (Tab-Reihenfolge)').toBeFocused()
}

/** Zustand herstellen, messen, Spuren wegnehmen — das Loesen der Taste ausserhalb
 *  des Elements (die Sonde hat vorgeführt, warum: Druck+Loesung am selben Ort ist
 *  ein KLICK, und der Spend-Link würde navigieren).
 *
 *  EINGESCHWUNGEN messen: die Knöpfe tragen transition-all (150 ms). Im selben Tick
 *  nach dem Umschalten misst man den START der Transition — im Debug-Lauf stand der
 *  Knopf noch auf den HELLEN Werten, während der Körper längst dunkel war. WCAG
 *  1.4.11 urteilt über den gesetzten Zustand, nicht über ein Übergangsbild. */
async function messeZustand(page: Page, el: Locator, zustand: Zustand): Promise<Messung> {
  // INTENTIONAL-UNTESTED: Diese Datei IST der Waechter (#515); Netz ist der gruene Lauf
  // plus die Mutationen K1-K4.
  //
  // Zustaende duerfen einander NICHT faerben. Die Schleife misst dasselbe Element
  // nacheinander, und nach dem Fokus-Durchgang bleibt der Fokus stehen: Chromium wendet
  // weiter `:focus-visible` an, also auch `focus-visible:border-ring` (button.tsx) — und
  // diese Kontur verdeckte dann eine zu schwache Hover- oder Aktiv-Kontur. Der Waechter
  // haette Zustaende bescheinigt, die er nie isoliert gesehen hat (CodeRabbit-Bot, major;
  // dieselbe Klasse wie die Fokus-Zusicherung, eine Ebene weiter).
  if (zustand !== 'focus') {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await page.mouse.move(2, 2)
  }
  if (zustand === 'hover') await el.hover()
  if (zustand === 'focus') await tastaturFokussieren(page, el)
  if (zustand === 'active') {
    const box = (await el.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
  }
  await page.waitForTimeout(250)
  const m = (await el.evaluate(MESSEN)) as Messung
  if (zustand === 'active') {
    await page.mouse.move(2, 2)
    await page.mouse.up()
  }
  return m
}

/** Die drei Zusicherungen je Element × Zustand — die Flaeche darf fehlen (transparent
 *  ist die WCAG-konforme Ghost-Bauart), aber nie schwach sein; eine Kontur, sobald
 *  vorhanden, muss messbar UND >= 3:1 sein; der Text braucht 4,5:1; im Fokus muss ein
 *  Indikator >= 3:1 tragen, der gegenueber der RUHE NEU ist — siehe dort. */
function urteile(name: string, zustand: Zustand, thema: string, m: Messung, ruhe?: Messung) {
  expect(m.unbekannt, `${thema} · ${name} · ${zustand}: messbar`).toBeUndefined()
  if (m.flaeche !== null)
    expect(m.flaeche, `${thema} · ${name} · ${zustand}: Fläche >= 3:1 (WCAG 1.4.11)`).toBeGreaterThanOrEqual(3)
  if (m.hatKontur)
    expect(m.kontur, `${thema} · ${name} · ${zustand}: Kontur messbar UND >= 3:1`).toBeGreaterThanOrEqual(3)
  if (m.text !== null)
    expect(m.text, `${thema} · ${name} · ${zustand}: Schrift >= 4,5:1 (WCAG 1.4.3)`).toBeGreaterThanOrEqual(4.5)
  if (zustand === 'focus') {
    // Gemessen gegen die RUHE, nicht absolut: der #515-Fix gibt "+ Neues Projekt" eine
    // DAUERHAFTE Kontur >= 3:1, und die erfuellte diese Zusicherung von selbst — mit
    // button.tsx ohne jeden Fokus-Indikator (weder Ring noch Konturwechsel) blieben alle
    // drei Tests GRUEN. Gezaehlt wird deshalb nur, was im Fokus NEU ist oder sich
    // geaendert hat; ein Indikator, den der Ruhezustand schon garantiert, beweist nichts
    // ueber den Fokus. Befund der CodeRabbit-CLI, Mutation als Beleg gefahren.
    const gleich = (a: number, b: number) => Math.abs(a - b) < 0.05
    const neueRinge = m.ringe.filter((r) => !(ruhe?.ringe ?? []).some((v) => gleich(v, r)))
    const neueKontur =
      m.kontur !== null && (ruhe?.kontur == null || !gleich(m.kontur, ruhe.kontur)) ? m.kontur : 0
    const bester = Math.max(...neueRinge, neueKontur)
    expect(bester, `${thema} · ${name} · Fokus: ein NEUER Indikator (Ring/Kontur) >= 3:1`).toBeGreaterThanOrEqual(3)
  }
}

/** Die drei Elemente aus Issue #515 — über Namen, nicht über Klassen: ein Selektor
 *  wie button.inline-flex.shrink-0 wäre die Klassenstring-Pruefung, gegen die #423
 *  geschrieben wurde. */
async function dieDrei(page: Page): Promise<[string, Locator][]> {
  return [
    ['+ Neues Projekt', page.getByRole('button', { name: '+ Neues Projekt' })],
    ['Projektzeile', page.locator('nav[aria-label="Projekte"] button').first()],
    ['Projekt unterstützen', page.locator('a[href*="github.com/sponsors"]')],
  ]
}

async function alleMessen(page: Page, thema: string) {
  for (const [name, el] of await dieDrei(page)) {
    await expect(el, `${thema}: ${name} sichtbar`).toBeVisible()
    // Ruhe zuerst und FESTGEHALTEN — sie ist der Bezug, gegen den der Fokus-Indikator
    // gemessen wird. Ueber ZUSTAENDE zu laufen und darauf zu bauen, dass 'ruhe' vorne
    // steht, waere dieselbe Zusicherung mit einer stillen Bedingung: eine Umsortierung
    // des Arrays machte sie wieder zahnlos, ohne dass ein Test rot wuerde.
    const ruhe = await messeZustand(page, el, 'ruhe')
    urteile(name, 'ruhe', thema, ruhe)
    for (const zustand of ZUSTAENDE.filter((z) => z !== 'ruhe')) {
      const m = await messeZustand(page, el, zustand)
      urteile(name, zustand, thema, m, ruhe)
    }
  }
}

test.beforeEach(async ({ page }) => {
  // 1280, nicht 320: erst ab md (768 px) existiert die Seitenleiste (AppShell blendet
  // sie darunter aus) — die Kontrastmessung der drei Elemente braucht sie sichtbar.
  await appEinrichten(page, { width: 1280, height: 800 })
})

test('Rechenkern: schwarz/weiss 21:1, oklch und color(srgb) landen korrekt', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(MATH_QUELLE)
  const checks = await page.evaluate(() => {
    const H = (globalThis as { TKFarbe: any }).TKFarbe
    const schwarz = H.rgba('rgb(0, 0, 0)')
    const weiss = H.rgba('rgb(255, 255, 255)')
    const oklchWeiss = H.rgba('oklch(1 0 0)')
    const oklchSchwarz = H.rgba('oklch(0 0 0)')
    const srgbWeiss = H.rgba('color(srgb 1 1 1)')
    const prozentAlpha = H.rgba('rgb(0 0 0 / 50%)')
    return {
      schwarzWeiss: H.verhaeltnis(schwarz, weiss),
      oklchWeiss: [oklchWeiss.r, oklchWeiss.g, oklchWeiss.b],
      oklchSchwarz: [oklchSchwarz.r, oklchSchwarz.g, oklchSchwarz.b],
      srgbWeiss: [srgbWeiss.r, srgbWeiss.g, srgbWeiss.b],
      // Prozent-Alpha skaliert 0-1 (kalter Review: gab 127.5, Kaskade bis in
      // verhaeltnis hinein) — der Gegenfall zum eigenen Kommentar im Parser.
      prozentAlpha: [prozentAlpha.r, prozentAlpha.g, prozentAlpha.b, prozentAlpha.a],
    }
  })
  expect(checks.schwarzWeiss).toBeCloseTo(21, 1)
  expect(checks.oklchWeiss).toEqual([255, 255, 255])
  expect(checks.oklchSchwarz).toEqual([0, 0, 0])
  expect(checks.srgbWeiss).toEqual([255, 255, 255])
  expect(checks.prozentAlpha).toEqual([0, 0, 0, 0.5])
})

test('Hell: drei Bedienelemente × vier Zustände >= 3:1', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(MATH_QUELLE)
  await alleMessen(page, 'hell')
})

test('Dunkel: dieselben Elemente und Zustände >= 3:1', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(MATH_QUELLE)
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.waitForTimeout(250)
  await alleMessen(page, 'dunkel')
})
