import { expect, test } from '@playwright/test'
import { appEinrichten, releasesEinrichten, PROJEKT } from './testApp'

/**
 * Browser-Wächter zu #515: WCAG 1.4.10 — bei 320 px Fensterbreite kein waagerechtes
 * Scrollen. Gemessen hat die zustands-probe am 2026-09-02 auf der Versionsseite
 * 109 px Überhang aus Inhalten ohne 2D-Ausnahme (Issue #515).
 *
 * Entscheidung Marcus 2026-09-11: alle vier Haupt-Routen, nicht nur die Versionsseite
 * — PageHeader und Notizen sind geteilt, ein Fix wirkt ohnehin auf mehreren Seiten.
 * Die Editor-Route ist bewusst draussen (eigene Zeilenwelt, eigener Auftrag).
 *
 * Gemessen wird documentElement.scrollWidth gegen clientWidth — dieselbe Frage, die
 * die Sonde stellt. 320 px ist reiner Browser-Betrieb (Electron: minWidth 900), und
 * auch dort gilt die Regel: die App läuft bewusst auch ohne Hülle.
 */

// INTENTIONAL-UNTESTED: Diese Datei ist der in dieser Sitzung entstehende Test selbst
// (#515) — der rote Erstlauf gegen den ungefixten Baum ist der Pin des HEUTIGEN
// (fehlerhaften) Verhaltens; die Ausbaustufe sortiert nur die Verursaechner-Ausgabe.
/** Reflow-Messung — selbstenthalten, laeuft in der Seite (siehe MESSEN im
 *  Kontrast-Wächter: Closure-Variabeln ueberleben die Serialisierung nicht). */
const REFLOW = () => {
  const de = document.documentElement
  // INTENTIONAL-UNTESTED: entstehender Test selbst (#515). ZWEI Ebenen: das Dokument
  // UND der Inhaltsbereich (main, der eigene Bildlaufbehaelter der Huelle). Die zweite
  // fehlte im Erstlauf, und zwei Mutationen (R1 URL-Token, R3 Aktionsleiste) bewiesen
  // die Blindstelle: was IN main ueberlaeuft, treibt das Dokument nie (overflow-auto
  // schluckt es) — 2D-Scrollen innerhalb des Inhalts ist aber derselbe 1.4.10-Verstoss.
  const main = document.querySelector('main')
  const ueberhang = Math.max(
    de.scrollWidth - de.clientWidth,
    main ? main.scrollWidth - main.clientWidth : 0,
  )
  if (ueberhang <= 1) return { ueberhang: 0, schuldige: [] as string[], treiber: [] as string[] }
  // INTENTIONAL-UNTESTED: diese Datei ist der entstehende Test selbst (#515); die
  // Ausbaustufe sortiert nur die Verursaechner-Ausgabe der selben Messung.
  // Breiteste zuerst: Behaelter (main, header) erben den Ueberhang nur — die Ursache
  // steht am rechtesten Element. KEIN Breitenausschluss: ein 0-px-breites absolut
  // positioniertes Element kann trotzdem rechts ueberstehen.
  // INTENTIONAL-UNTESTED: entstehender Test selbst (#515); Ausbaustufe ergänzt nur
  // den Text-Schnipsel, damit die Fehlermeldung den Verursaecher BENENNT.
  const fund: { bez: string; rechts: number }[] = []
  for (const e of Array.from(document.querySelectorAll('body *'))) {
    const r = e.getBoundingClientRect()
    if (r.right <= de.clientWidth + 1) continue
    const cs = getComputedStyle(e)
    const text = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)
    const bez = `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${(cs.className || '')
      .toString().split(/\s+/).slice(0, 4).join('.')}${text ? ` «${text}»` : ''}`
    fund.push({ bez, rechts: Math.round(r.right) })
  }
  fund.sort((a, b) => b.rechts - a.rechts)
  // INTENTIONAL-UNTESTED: entstehender Test selbst (#515). Zwei Fragen: wer reicht am
  // weitesten rechts raus, und wer laeuft gegen die EIGENE Kante (scrollWidth >
  // clientWidth) — gestreckte Behaelter erben den Überhang, nur der eigene Überlauf
  // identifiziert den TREIBER (ein nicht umbrechbares Token, eine fixe Breite).
  // INTENTIONAL-UNTESTED: entstehender Test selbst (#515); Rauschfilter: sr-only-Reste
  // (clientWidth 1) und aus dem Fluss genommene Ebenen treiben das Layout nicht.
  const treiber: string[] = []
  for (const e of Array.from(document.querySelectorAll('body *'))) {
    if (e.scrollWidth <= e.clientWidth + 1 || e.clientWidth <= 1) continue
    const pos = getComputedStyle(e).position
    if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') continue
    const cs = getComputedStyle(e)
    const text = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)
    const bez = `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${(cs.className || '')
      .toString().split(/\s+/).slice(0, 4).join('.')}${text ? ` «${text}»` : ''}`
    treiber.push(`${bez} ${e.scrollWidth}>${e.clientWidth}`)
    if (treiber.length >= 8) break
  }
  return {
    ueberhang: Math.round(ueberhang),
    schuldige: fund.slice(0, 6).map((f) => `${f.bez} bis ${f.rechts}px`),
    treiber,
  }
}

const ROUTEN: [string, string][] = [
  ['Start', '/'],
  ['Version', '/version'],
  ['Einstellungen', '/einstellungen'],
  ['Arbeitsfläche', `/p/${PROJEKT}`],
]

test.beforeEach(async ({ page }) => {
  await appEinrichten(page, { width: 320, height: 400 })
  await releasesEinrichten(page)
})

/** Positivkontrolle je Route (Review F5): eine LEERE oder abgestuerzte Seite bestuende
 *  eine reine scrollWidth-Messung vacuous — erst die sichtbare Hauptueberschrift
 *  beweist, dass ueberhaupt gemessen wurde, was die Route zeigt. */
// INTENTIONAL-UNTESTED: entstehender Test selbst (#515) — Korrektur des Titels
// der Startseite gegen den Quelltext (HomeGallery.tsx:172: titel=Übersicht).
const ROUTEN_KOPF: Record<string, RegExp> = {
  '/': /übersicht/i,
  '/version': /version und updates/i,
  '/einstellungen': /einstellungen/i,
}

for (const [name, route] of ROUTEN) {
  test(`${name} (${route}): bei 320 px kein waagerechter Überhang`, async ({ page }) => {
    await page.goto(route)
    // Positivkontrolle VOR der Messung — sie ist die Voraussetzung, nicht das Ergebnis.
    const kopf = ROUTEN_KOPF[route]
    if (kopf) {
      await expect(page.getByRole('heading', { level: 1, name: kopf }),
        `${name}: Seite muss gerendert haben, sonst misst dieser Test nichts`).toBeVisible()
    } else {
      // Die Arbeitsflaeche traegt den Projektnamen als H1.
      await expect(page.getByRole('heading', { level: 1, name: PROJEKT }),
        `${name}: Seite muss gerendert haben, sonst misst dieser Test nichts`).toBeVisible()
    }
    // Umbruch-Animationen und nachlaufende Effekte abwarten: die Rechtecke muessen
    // stehen, sonst misst der Test einen Zwischenstand.
    await page.waitForTimeout(300)
    const ergebnis = await page.evaluate(REFLOW)
    // INTENTIONAL-UNTESTED: entstehender Test selbst (#515); die Meldung nennt beide
    // Fragen — wer am weitesten rechts steht und wer gegen die EIGENE Kante laeuft.
    expect(ergebnis.ueberhang,
      `${name}: ${ergebnis.ueberhang}px waagerechter Überhang — Verursaecher: ${ergebnis.schuldige.join(' · ')} — Treiber (eigener Überlauf): ${ergebnis.treiber.join(' · ') || 'keine'}`)
      .toBeLessThanOrEqual(1)
  })
}
