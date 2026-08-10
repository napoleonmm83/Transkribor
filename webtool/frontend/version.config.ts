import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Die App-Version aus der WURZEL-package.json (`webtool/frontend/package.json` traegt
 * dauerhaft 0.0.0 — sie ist nur der Bauplan des Frontends, nicht die Anwendung).
 *
 * Warum zur Bauzeit und nicht ueber einen Endpunkt: im gepackten Lauf liegt der
 * Python-Teil unter `resources/py`, neben ihm gibt es gar keine package.json. Die
 * Release-Workflow hebt die Version, baut danach — der eingesetzte Wert ist also
 * derselbe, den `app.getVersion()` in Electron meldet.
 *
 * Wird von `vite.config.ts` UND `vitest.config.ts` als `__APP_VERSION__` eingesetzt.
 * Fehlt es in einem der beiden, wirft die StatusBar dort mit ReferenceError.
 */
export const APP_VERSION: string = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')).version
