import { expect, test } from '@playwright/test'
import { appEinrichten, DATEIEN, editorEinrichten, PROJEKT } from './testApp'

test('Speicherfehler schuetzt Fusszeile und Palette; bestaetigtes Loeschen verlaesst den Editor', async ({ page }) => {
  await appEinrichten(page, { width: 1280, height: 800 })
  await editorEinrichten(page, true)
  let geloescht = false
  await page.route('**/api/projects', r => r.fulfill({ json: {
    projects: (geloescht ? ['Beta'] : [PROJEKT, 'Beta']).map(name => ({
      name, dateien: 2, fertig: 0, geaendert: 1, active_jobs: [],
    })),
  } }))
  await page.route(`**/api/projects/${PROJEKT}`, r => {
    if (r.request().method() === 'DELETE') {
      geloescht = true
      return r.fulfill({ json: { ok: true } })
    }
    return r.fulfill({ json: { name: PROJEKT, files: DATEIEN } })
  })
  const fragen: string[] = []
  page.on('dialog', async dialog => {
    fragen.push(dialog.message())
    await dialog.dismiss()
  })
  await page.goto(`/p/${PROJEKT}/A_erste`)
  await page.getByText('Browser-Probe', { exact: true }).click()
  await page.locator('textarea').fill('Meine ungespeicherte Fassung')
  await page.locator('textarea').press('Control+Enter')
  await expect(page.getByText('nicht gespeichert', { exact: true })).toBeVisible()

  await page.getByRole('contentinfo').getByRole('link', { name: 'Einstellungen' }).click()
  await expect(page).toHaveURL(`/p/${PROJEKT}/A_erste`)
  expect(fragen).toHaveLength(1)
  expect(fragen[0]).toContain('gespeichert')
  await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: /Beta/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page).toHaveURL(`/p/${PROJEKT}/A_erste`)
  expect(fragen).toHaveLength(2)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: `Projekt ${PROJEKT} löschen` }).click()
  await page.getByRole('textbox', { name: 'Projektname bestätigen' }).fill(PROJEKT)
  await page.getByRole('button', { name: 'Löschen', exact: true }).click()
  await expect(page).toHaveURL('/')
  expect(geloescht).toBe(true)
  await expect(page.getByText('Meine ungespeicherte Fassung', { exact: true })).toHaveCount(0)
})
