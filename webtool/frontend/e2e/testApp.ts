import type { Page } from '@playwright/test'

/**
 * Geteilte Fixture der Browser-Wächter: alle /api/**-Routen per page.route(), kein
 * Backend, kein Python. Aus dialog-schliesskreuz.e2e.ts (#423) herausgelöst, sobald der
 * zweite Wächter (#515) dasselbe Gerüst brauchte — dieselbe Regel wie bei DateiMenue:
 * denselben Knopf zweimal fuehren heisst, ihn beim naechsten Mal an einer Stelle zu
 * vergessen.
 *
 * Der Viewport ist PARAMETER, nicht Konstante: der Reflow-Wächter misst 320 px, der
 * Kontrast-Wächter 1280 (erst dort ist die Seitenleiste sichtbar, AppShell blendet sie
 * unter md aus).
 */

export const PROJEKT = 'Rhyathlon'
export const DATEIEN = [
  { base: 'A_erste', has_audio: true, has_raw: true, has_edit: false, has_md: false },
  { base: 'B_zweite', has_audio: true, has_raw: true, has_edit: false, has_md: false },
]

/** Volle Einstellungen — LEERE Listen sind der dokumentierte Zustand (#305), undefinierte
 *  Felder lassen die Flaeche an React-Seitenfehlern sterben (gemessen am ProjectWorkspace). */
const EINSTELLUNGEN = {
  sprache: 'ch', korrektur: 'auto', mehrsprachig: false,
  sprach_choices: [], tiefen: [], sprecher_max: 20,
  diarisierung_aktiv: true, diarize_verfuegbar: true,
}

/** Die Serverform von GET /api/settings — vollstaendig genug, dass SettingsPage rendert
 *  statt zu stuerzen; den Inhalt prueft die vitest-Suite, hier zaehlt nur Geometrie. */
const SETTINGS = {
  provider: 'claude', model: 'opus', base_url: '', has_key: false,
  providers: [], env_key: '',
  whisper_model: 'large-v3', whisper_lang: 'de', whisper_choices: [{ model: 'large-v3', label: 'large-v3' }],
  parallel: '3', parallel_max: 16, parallel_default: '3', parallel_env: '', parallel_env_wirksam: '3',
  ai_ready: false, ai_reason: 'Testlauf ohne Anbieter',
  ytdlp_auto: '1', ytdlp: { laeuft: false, ergebnis: null, unlesbar: false, ejs_unlesbar: false, auto: true },
  kaputt: '', projekte_pfad: 'C:/tmp/transkribor-test',
}

export async function appEinrichten(page: Page, viewport: { width: number; height: number } = { width: 320, height: 400 }) {
  await page.route('**/api/projects', (r) =>
    r.fulfill({
      json: {
        projects: [
          { name: PROJEKT, dateien: DATEIEN.length, fertig: 0, geaendert: 1, active_jobs: [] },
        ],
      },
    }),
  )
  await page.route(`**/api/projects/${PROJEKT}`, (r) =>
    r.fulfill({ json: { name: PROJEKT, files: DATEIEN } }))
  await page.route(`**/api/projects/${PROJEKT}/einstellungen`, (r) =>
    r.fulfill({ json: EINSTELLUNGEN }))
  await page.route(`**/api/projects/${PROJEKT}/files/**`, (r) =>
    r.fulfill({ json: { ...EINSTELLUNGEN, sprache_eigen: null, sprache_projekt: 'ch',
      mehrsprachig_eigen: null, mehrsprachig_projekt: false, sprecher: null } }))
  // Seitenweite Abfragen stillstellen (useAiReady/Hardware-Status): sonst rauscht der
  // tote Proxy des Dev-Servers als 502 durch die Konsole.
  await page.route('**/api/settings', (r) => r.fulfill({ json: SETTINGS }))
  await page.route('**/api/hardware', (r) => r.fulfill({ json: {} }))
  await page.setViewportSize(viewport)
}

/** Der Versionsverlauf kommt DIREKT aus dem Browser von api.github.com — auch die ist
 *  per page.route() abfangbar. Der Body tragt absichtlich eine LANGE URL: lange
 *  ungebrochene Zeichenketten sind ein echter Reflow-Verursaecher der Versionsseite,
 *  ein kurzer Mock wuerde den Wächter einen Zufallssieg feiern lassen. */
export async function releasesEinrichten(page: Page) {
  await page.route('**/api.github.com/**', (r) =>
    r.fulfill({
      json: [
        {
          tag_name: 'v0.53.0', published_at: '2026-09-10T00:00:00Z', draft: false, prerelease: false,
          body: '- Behoben: Seitenleiste klar erkennbar\n- Einzelheiten und ältere Fassungen unter\n  https://github.com/napoleonmm83/Transkribor/releases/tag/v0.53.0-mit-langem-versionsanhang',
          html_url: 'https://github.com/napoleonmm83/Transkribor/releases/tag/v0.53.0',
        },
        {
          tag_name: 'v0.52.0', published_at: '2026-09-03T00:00:00Z', draft: false, prerelease: false,
          body: '- Neu: Release-Notizen entstehen automatisch im PR',
          html_url: 'https://github.com/napoleonmm83/Transkribor/releases/tag/v0.52.0',
        },
      ],
    }),
  )
}
