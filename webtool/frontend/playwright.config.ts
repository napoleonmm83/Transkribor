import { defineConfig } from '@playwright/test'

/**
 * Browser-Testläufer für #423: die jsdom-Suite rechnet kein Layout — `position: sticky`,
 * `overflow`-Clipping und Trefferprüfung sind dort unsichtbar. Diese Konfiguration bringt
 * die Layout-Wächter (derzeit: Dialog-Schließkreuz #330/#423) in einen echten Chromium.
 *
 * Bewusst KEIN Backend im E2E: die Specs fangen `/api/**` per `page.route()` mit
 * Fixture-Antworten ab. Der CI-Job bleibt damit node-only — kein Python, keine GPU-losen
 * Läufer, keine Abhängigkeit von `webtool.app`. Wer Datenfluss testen will, gehört in die
 * vitest-Suite; hier wird Geometrie geprüft.
 *
 * Port 5179 mit `--strictPort`: der Standard-Port 5173 steht regelmäßig für eine laufende
 * Dev-Instanz, und ein stiller Ausweichport würde den Tests eine andere Proxylage geben.
 * `reuseExistingServer` nur ausserhalb der CI — dort startet der Läufer seinen eigenen.
 */
export default defineConfig({
  testDir: './e2e',
  // `*.e2e.ts` statt des Playwright-Defaults `*.spec|test.ts`: vitest greift auf
  // `*.test.*` und `*.spec.*` — gemeinsame Muster wuerden die Browser-Tests in die
  // jsdom-Suite ziehen (und umgekehrt). Beide Seiten deklarieren ihr Muster selbst.
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:5179',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // `--host 127.0.0.1` ist Pflicht: Vite bindet `localhost`, und Windows loest das
    // zuerst als ::1 — der Readiness-Poll auf die IPv4-Adresse laeuft dann in sein
    // Zeitlimit, obwohl der Server laeuft (gemessen: 120-s-Timeout bei laufendem Vite).
    command: 'npm run dev -- --port 5179 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5179',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
