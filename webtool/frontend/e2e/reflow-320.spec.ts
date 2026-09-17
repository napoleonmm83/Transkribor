import { expect, test } from '@playwright/test'
import { appEinrichten, editorEinrichten, releasesEinrichten, PROJEKT } from './testApp'

/**
 * Browser-Wächter zu #515: WCAG 1.4.10 — bei 320 px Fensterbreite kein waagerechtes
 * Scrollen. Gemessen hat die zustands-probe am 2026-09-02 auf der Versionsseite
 * 109 px Überhang aus Inhalten ohne 2D-Ausnahme (Issue #515).
 *
 * Entscheidung Marcus 2026-09-11: alle vier Haupt-Routen, nicht nur die Versionsseite
 * — PageHeader und Notizen sind geteilt, ein Fix wirkt ohnehin auf mehreren Seiten.
 * Die vier Haupt-Routen laufen bei 320 px; der Editor hat wegen seiner eigenen
 * Zeilenwelt zusätzliche Prüfungen bei 900, 768 und 320 px.
 *
 * Gemessen wird documentElement.scrollWidth gegen clientWidth — dieselbe Frage, die
 * die Sonde stellt. 320 px ist reiner Browser-Betrieb (Electron: minWidth 900), und
 * auch dort gilt die Regel: die App läuft bewusst auch ohne Hülle.
 */

// Der rote Erstlauf gegen den ungefixten Baum pinnt das fehlerhafte Verhalten;
// die Diagnose sortiert nur die Verursaechner-Ausgabe.
/** Reflow-Messung — selbstenthalten, laeuft in der Seite (siehe MESSEN im
 *  Kontrast-Wächter: Closure-Variabeln ueberleben die Serialisierung nicht). */
const REFLOW = () => {
  const de = document.documentElement
  // ZWEI Ebenen: das Dokument UND der Inhaltsbereich (main, der eigene
  // Bildlaufbehaelter der Huelle). Die zweite
  // fehlte im Erstlauf, und zwei Mutationen (R1 URL-Token, R3 Aktionsleiste) bewiesen
  // die Blindstelle: was IN main ueberlaeuft, treibt das Dokument nie (overflow-auto
  // schluckt es) — 2D-Scrollen innerhalb des Inhalts ist aber derselbe 1.4.10-Verstoss.
  const main = document.querySelector('main')
  const ueberhang = Math.max(
    de.scrollWidth - de.clientWidth,
    main ? main.scrollWidth - main.clientWidth : 0,
  )
  if (ueberhang <= 1) return { ueberhang: 0, schuldige: [] as string[], treiber: [] as string[] }
  // Breiteste zuerst: Behaelter (main, header) erben den Ueberhang nur — die Ursache
  // steht am rechtesten Element. KEIN Breitenausschluss: ein 0-px-breites absolut
  // positioniertes Element kann trotzdem rechts ueberstehen.
  // Der Text-Schnipsel benennt den Verursacher in der Fehlermeldung.
  const fund: { bez: string; rechts: number }[] = []
  for (const e of Array.from(document.querySelectorAll('body *'))) {
    const r = e.getBoundingClientRect()
    if (r.right <= de.clientWidth + 1) continue
    // Die Klassen kommen vom ELEMENT, nicht aus `getComputedStyle` — ein
    // CSSStyleDeclaration hat kein
    // `className`. Der Ausdruck war an BEIDEN Stellen immer `undefined` und fiel auf ''
    // zurueck: die Fehlermeldung nannte den Verursaecher ohne eine einzige Klasse, und
    // sichtbar wird das erst, wenn der Waechter rot ist — also genau dann, wenn die
    // Meldung zaehlt (CodeRabbit-Bot, minor, an beiden Stellen).
    const text = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)
    const bez = `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${(e.getAttribute('class') || '')
      .split(/\s+/).slice(0, 4).join('.')}${text ? ` «${text}»` : ''}`
    fund.push({ bez, rechts: Math.round(r.right) })
  }
  fund.sort((a, b) => b.rechts - a.rechts)
  // Zwei Fragen: wer reicht am weitesten rechts raus, und wer laeuft gegen die
  // EIGENE Kante (scrollWidth >
  // clientWidth) — gestreckte Behaelter erben den Überhang, nur der eigene Überlauf
  // identifiziert den TREIBER (ein nicht umbrechbares Token, eine fixe Breite).
  // Rauschfilter: sr-only-Reste (clientWidth 1) und aus dem Fluss genommene Ebenen
  // treiben das Layout nicht.
  const treiber: string[] = []
  for (const e of Array.from(document.querySelectorAll('body *'))) {
    if (e.scrollWidth <= e.clientWidth + 1 || e.clientWidth <= 1) continue
    const pos = getComputedStyle(e).position
    if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') continue
    // Gleiche Klassenermittlung wie oben.
    const text = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)
    const bez = `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${(e.getAttribute('class') || '')
      .split(/\s+/).slice(0, 4).join('.')}${text ? ` «${text}»` : ''}`
    treiber.push(`${bez} ${e.scrollWidth}>${e.clientWidth}`)
    if (treiber.length >= 8) break
  }
  return {
    ueberhang: Math.round(ueberhang),
    schuldige: fund.slice(0, 6).map((f) => `${f.bez} bis ${f.rechts}px`),
    treiber,
  }
}

// Diese Datei IST der Browser-Waechter (#515); ihr Netz ist der
// gruene Lauf plus scripts/mutationen/buendel-d-515-kontrast-reflow_e2e.json.
//
// Der TITEL steht als Literal in der Tabelle, nicht mehr im Template. Der
// Mutationsplan nennt Testnamen, und scripts/test_mutationsplaene.py sucht sie im
// Quelltext — ein interpolierter Name ist dort per Konstruktion nicht auffindbar.
// Gemessen: fuenf `rot`-Namen dieses Plans galten als fehlend, die Ankerpruefung war
// rot. Die Richtung ist dabei das Teure: bei `rot` meldet sich der Tippfehler, bei
// einer `gruen`-Gegenprobe faellt er STILL aus (ein Name, den es nicht gibt, taucht
// nie in einer roten Zeile auf — die Gegenprobe gilt als erfuellt, ohne zu pruefen).
// Die Route bleibt aus dem Titel heraus: sie traegt bei der Arbeitsflaeche PROJEKT,
// und ein Literal daraus liefe beim naechsten Umbenennen still neben der Wahrheit her.
const ROUTEN: [string, string, string][] = [
  ['Start', '/', 'Start: bei 320 px kein waagerechter Überhang'],
  ['Version', '/version', 'Version: bei 320 px kein waagerechter Überhang'],
  ['Einstellungen', '/einstellungen', 'Einstellungen: bei 320 px kein waagerechter Überhang'],
  ['Arbeitsfläche', `/p/${PROJEKT}`, 'Arbeitsfläche: bei 320 px kein waagerechter Überhang'],
]

test.beforeEach(async ({ page }) => {
  await appEinrichten(page, { width: 320, height: 400 })
  await releasesEinrichten(page)
})

/** Positivkontrolle je Route (Review F5): eine LEERE oder abgestuerzte Seite bestuende
 *  eine reine scrollWidth-Messung vacuous — erst die sichtbare Hauptueberschrift
 *  beweist, dass ueberhaupt gemessen wurde, was die Route zeigt. */
// Die Startseite traegt laut HomeGallery.tsx:172 den Titel „Übersicht“.
const ROUTEN_KOPF: Record<string, RegExp> = {
  '/': /übersicht/i,
  '/version': /version und updates/i,
  '/einstellungen': /einstellungen/i,
}

for (const [name, route, titel] of ROUTEN) {
  test(titel, async ({ page }) => {
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
    // Auf die NACHLAUFENDEN Inhalte warten, nicht auf eine Frist. Die Ueberschrift kann
    // stehen, bevor die Hardware-Antwort und die Release-Notizen gerendert sind — dann
    // misst der Waechter einen Zwischenstand und bliebe gruen, ohne StatusBar.tsx oder
    // Notizen.tsx je gesehen zu haben. Das sind genau die beiden Flaechen, die R5 und R1
    // mutieren; eine feste Frist macht die Mutationsprobe vom Zeitverhalten des Laeufers
    // abhaengig statt vom Code (CodeRabbit-Bot, major).
    // Die Fusszeile rendert `rechenwerk` NUR, wenn er nicht leer ist
    // (StatusBar.tsx:124) — die Zeile ist damit selbst der Beleg, dass die Antwort da ist.
    await expect(page.getByText('cuda · NVIDIA GeForce RTX 5080'),
      `${name}: Fusszeile muss die Hardware-Antwort tragen, sonst fehlt die Flaeche von R5`).toBeVisible()
    if (route === '/version') {
      await expect(page.getByText(/Seitenleiste klar erkennbar/),
        'Version: Release-Notizen muessen stehen, sonst fehlt die Flaeche von R1').toBeVisible()
    }
    // Kurzer Nachlauf nur noch fuer Umbruch-Animationen; die Inhalte stehen bereits.
    await page.waitForTimeout(150)
    const ergebnis = await page.evaluate(REFLOW)
    // Die Meldung nennt beide Fragen: wer am weitesten rechts steht und wer gegen die
    // EIGENE Kante laeuft.
    expect(ergebnis.ueberhang,
      `${name}: ${ergebnis.ueberhang}px waagerechter Überhang — Verursaecher: ${ergebnis.schuldige.join(' · ')} — Treiber (eigener Überlauf): ${ergebnis.treiber.join(' · ') || 'keine'}`)
      .toBeLessThanOrEqual(1)
  })
}

test('Editor: bei 900 px bleiben Fehlerstand, Suche und Exporte ohne waagerechten Ueberhang', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await editorEinrichten(page, true)
  await page.goto(`/p/${PROJEKT}/A_erste`)

  await page.getByText('Browser-Probe', { exact: true }).click()
  await page.locator('textarea').fill('Meine ungespeicherte Fassung')
  await page.locator('textarea').press('Control+Enter')
  await expect(page.getByText('nicht gespeichert', { exact: true })).toBeVisible()

  await page.getByRole('textbox', { name: 'Im Transkript suchen' }).fill('Meine')
  await expect(page.getByText('1 / 1', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export .md' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Untertitel .srt' })).toBeVisible()
  await expect(page.getByText('Meine ungespeicherte Fassung', { exact: true })).toBeVisible()

  const ergebnis = await page.evaluate(REFLOW)
  expect(ergebnis.ueberhang,
    `Editor: ${ergebnis.ueberhang}px waagerechter Ueberhang — Verursacher: ${ergebnis.schuldige.join(' · ')} — Treiber: ${ergebnis.treiber.join(' · ') || 'keine'}`)
    .toBeLessThanOrEqual(1)

  const messwerte = [{ breite: 900, ueberhang: ergebnis.ueberhang }]
  for (const [breite, hoechstens] of [[768, 1], [320, 1]] as const) {
    await page.setViewportSize({ width: breite, height: 700 })
    const messung = await page.evaluate(REFLOW)
    messwerte.push({ breite, ueberhang: messung.ueberhang })
    expect(messung.ueberhang,
      `Editor bei ${breite}px: ${messung.ueberhang}px waagerechter Ueberhang — Verursacher: ${messung.schuldige.join(' · ')} — Treiber: ${messung.treiber.join(' · ') || 'keine'}`)
      .toBeLessThanOrEqual(hoechstens)
  }
  console.info(`Editor-Reflow-Messwerte: ${JSON.stringify(messwerte)}`)
})
