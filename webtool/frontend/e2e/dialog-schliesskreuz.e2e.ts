import { expect, test, type Page } from '@playwright/test'
import { appEinrichten, PROJEKT } from './testApp'

/**
 * Browser-Wächter zu #330, nachgebaut als wiederholbarer Test (#423).
 *
 * Die jsdom-Wächter (`ui/dialog-schliesskreuz.test.tsx`) prüfen ZUSICHERUNGEN —
 * Klassenstrings — weil jsdom kein Layout rechnet. Genau die drei Lücken aus dem Issue
 * sieht diese Datei: ein arbitraryer Selektor im String ohne Regel im Bundle, `:has()`
 * ohne Unterstützung, Layout-Wechselwirkung der Sonderfälle. Gemessen wird hier, was
 * #330 von Hand gemessen hat: der ✕ bleibt bei jedem Rollstand im Dialog und im
 * Fenster, und die Mitte des ✕ trifft `elementFromPoint`.
 *
 * Drei Dialoge, wie im Issue: die Basis (`DateiEinstellungenDialog`, rollt selbst),
 * `CommandDialog` (nimmt `overflow-hidden p-0` zurück) und `MaterialDialog` (nimmt
 * `overflow-visible` zurück und ersetzt `grid` durch `flex flex-col`).
 *
 * KEIN Backend: `/api/**` wird per `page.route()` mit Fixtures beantwortet. Es wird
 * Geometrie geprüft, kein Datenfluss — der gehört in die vitest-Suite.
 */

// INTENTIONAL-UNTESTED: Die Inline-Fixture ist nach e2e/testApp.ts gezogen (#515 braucht
// dasselbe Gerüst) — diese Datei IST der Test selbst (entstanden in #423, derselbe Bundel-D-
// Diff); das Netz ist der gruene E2E-Lauf nach dem Umbau, der dieselben drei Dialoge prueft.
/** Das Herzstück, in allen drei Dialogen gleich:
 *  1. jede rollbare Fläche IM Dialog bis zum Ende rollen (der Dialog selbst und alle
 *     Nachfahren — `CommandDialog` rollt in der Liste, `MaterialDialog` in der Spalte,
 *     nicht in der Hülle),
 *  2. der ✕ liegt im Dialogrechteck UND im Fenster,
 *  3. `elementFromPoint` in der ✕-Mitte trifft den ✕ — der #330-Nachweis, dass er
 *     nicht nur irgendwo klebt, sondern anklickbar da ist.
 *
 *  `erwartetRollweg > 0` ist die VORBEDINGUNG des Tests, nicht sein Nebenergebnis: ein
 *  Dialog, der nicht rollt, prüft den Sticky-Fix nicht — rot statt still grün. */
async function kreuzHaelt(page: Page, huelleRollt: boolean) {
  const dialog = page.locator('[data-slot="dialog-content"]')
  const kreuz = page.locator('[data-slot="dialog-close"]')
  await expect(dialog).toBeVisible()
  await expect(kreuz).toBeVisible()
  // Ein-/Ausblendanimation (duration-200) abwarten: boundingBox() wartet nicht auf sie.
  await page.waitForTimeout(300)

  // INTENTIONAL-UNTESTED: Diese Datei IST der Browser-Waechter (#423); ihr Netz ist der
  // gruene Lauf direkt danach plus der committete Mutationsplan
  // scripts/mutationen/dialog-schliesskreuz_e2e.json, der genau diese Zusicherungen
  // rot bekommen muss. Ein Pin-Test ueber einen Test waere eine dritte Schicht ohne
  // eigenen Sensor.
  //
  // Gerollt wird ALLES, was rollen kann — das ✕ wird im gerollten Zustand geprueft.
  // Die Vorbedingung liest danach aber NUR den Weg der Huelle: das Maximum ueber alle
  // Nachfahren machte den Satz "der Dialog selbst rollt" auch dann wahr, wenn allein
  // ein Kind rollt — und diese Vorbedingung ist genau das, was den Test vor dem
  // Leerlauf bewahrt. Heute traegt `dialog-content` sein `overflow-y-auto` selbst
  // (ui/dialog.tsx), die Meldung stimmt also; sie misst es jetzt, statt es zu erben.
  // Befund der CodeRabbit-CLI; latent, gleiche Klasse wie der Fokus-Befund im
  // Kontrast-Waechter desselben Buendels.
  // INTENTIONAL-UNTESTED: Diese Datei IST der Waechter (#423), Netz wie oben.
  const { huelleWeg, irgendwoWeg } = await dialog.evaluate((el) => {
    let eigener = 0
    let weitester = 0
    for (const flaeche of [el, ...el.querySelectorAll<HTMLElement>('*')]) {
      if (flaeche.scrollHeight > flaeche.clientHeight + 1) {
        flaeche.scrollTop = flaeche.scrollHeight
        weitester = Math.max(weitester, flaeche.scrollTop)
        if (flaeche === el) eigener = flaeche.scrollTop
      }
    }
    return { huelleWeg: eigener, irgendwoWeg: weitester }
  })
  // JEDE Variante muss wirklich gerollt haben — sonst prueft der Test das ✕ im
  // Ruhezustand, und die Mutation sticky->absolute koennte gruen bleiben. Bis hierher
  // galt eine Rollbedingung nur fuer den Basis-Dialog; CommandDialog und MaterialDialog
  // uebergeben `false` und hatten damit GAR KEINE (CodeRabbit-Bot, major). Die
  // Huellen-Bedingung bleibt daneben stehen, weil sie eine ANDERE Tatsache prueft.
  expect(irgendwoWeg, 'im Dialog muss etwas gerollt sein — sonst prüft dieser Test nichts')
    .toBeGreaterThan(0)
  if (huelleRollt)
    expect(huelleWeg, 'der Dialog selbst rollt — sonst prüft dieser Test nichts').toBeGreaterThan(0)

  const vp = page.viewportSize()!
  const k = (await kreuz.boundingBox())!
  const d = (await dialog.boundingBox())!
  expect(k.y, '✕-Oberkante im Dialog').toBeGreaterThanOrEqual(d.y - 0.5)
  expect(k.y + k.height, '✕-Unterkante im Dialog').toBeLessThanOrEqual(d.y + d.height + 0.5)
  // INTENTIONAL-UNTESTED: Ausbau des eigenen Tests (derselbe Buendel-D-Diff) um die
  // x-Assertionen, die der Kommentar bereits versprach (kalter Review, Befund 2) —
  // das Netz ist der grueene Lauf dieses Tests selbst, direkt danach gefahren.
  expect(k.x, '✕-Linke Kante im Dialog').toBeGreaterThanOrEqual(d.x - 0.5)
  expect(k.x + k.width, '✕-Rechte Kante im Dialog').toBeLessThanOrEqual(d.x + d.width + 0.5)
  expect(k.y, '✕-Oberkante im Fenster').toBeGreaterThanOrEqual(-0.5)
  expect(k.y + k.height, '✕-Unterkante im Fenster').toBeLessThanOrEqual(vp.height + 0.5)
  expect(k.x, '✕-Linke Kante im Fenster').toBeGreaterThanOrEqual(-0.5)
  expect(k.x + k.width, '✕-Rechte Kante im Fenster').toBeLessThanOrEqual(vp.width + 0.5)

  const trifft = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return !!el && !!el.closest('[data-slot="dialog-close"]')
    },
    { x: k.x + k.width / 2, y: k.y + k.height / 2 },
  )
  expect(trifft, 'elementFromPoint in der ✕-Mitte trifft den ✕').toBe(true)
}

// INTENTIONAL-UNTESTED: diese Datei IST der Test (entsteht in dieser Sitzung, #423);
// der Edit fixt ihren eigenen Hook-Aufruf, der im ersten Lauf an der Signatur scheiterte.
// Es gibt kein Verhalten vor diesem Edit, das verschwinden koennte.
test.beforeEach(async ({ page }) => appEinrichten(page))

test('Basis-Dialog (Datei-Einstellungen): ✕ bleibt im gerollten Dialog und ist klickbar', async ({ page }) => {
  // Noch enger als 400: die Datei-Einstellungen sind hoch (Sprache, Tiefe, Sprecher,
  // Hinweise) — bei 340 px Fensterhöhe rollt die Hülle garantiert.
  await page.setViewportSize({ width: 320, height: 340 })
  // INTENTIONAL-UNTESTED: entstehender E2E (#423) — Korrektur des eigenen Ablaufs: das
  // Aufklappen der Seitenleiste navigiert nicht, die URL treibt die App (AppShell:
  // das aufgeklappte Projekt der Leiste IST das aus der URL).
  await page.goto(`/p/${PROJEKT}`)
  await page.getByRole('button', { name: 'Aktionen für „A_erste“' }).click()
  // INTENTIONAL-UNTESTED: entstehender E2E (#423) — Menüpunkt heisst „Sprache, Sprecher &
  // Korrektur“, nicht „Einstellungen“ (DateiMenue.tsx:193).
  await page.getByRole('menuitem', { name: 'Sprache, Sprecher & Korrektur' }).click()
  await kreuzHaelt(page, true)
})

test('CommandDialog (overflow-hidden · p-0): ✕ bleibt sichtbar und klickbar', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 300 })
  await page.goto('/')
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog')).toBeVisible()
  await kreuzHaelt(page, false)
})

test('MaterialDialog (flex · overflow-visible): ✕ klebt oben und bleibt klickbar', async ({ page }) => {
  // INTENTIONAL-UNTESTED: entstehender E2E (#423) — Direktnavigation, gleicher Grund
  // wie im Basis-Test: die Seitenleisten-Zeile klappt nur auf.
  await page.goto(`/p/${PROJEKT}`)
  await page.getByRole('button', { name: /Material/ }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await kreuzHaelt(page, false)
})
