# Versionsanzeige und Update-Status — Umsetzungsplan

> **Für agentische Arbeiter:** ERFORDERLICHE UNTER-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`, um diesen Plan Aufgabe für Aufgabe umzusetzen. Die Schritte nutzen Checkbox-Syntax (`- [ ]`).

**Ziel:** Die laufende Version und der Update-Zustand stehen in den Einstellungen der Weboberfläche; der Download startet erst auf Klick und zeigt Prozent, MB und Tempo.

**Architektur:** Ein Zustandsautomat in `electron/updater.js` kapselt `electron-updater` und schiebt bei jeder Änderung ein Zustandsobjekt über die bestehende `preload`-Brücke ins Fenster. Die React-Oberfläche liest es über einen Hook und bildet es direkt ab — kein zweiter Zustand im Frontend.

**Technik:** Electron 43 (CommonJS, `node:test`), React 19 + TypeScript, Vitest + Testing Library.

**Spezifikation:** `docs/superpowers/specs/2026-08-08-transkribor-version-und-update-design.md`

## Globale Vorgaben

- **Sprache:** Bezeichner und Kommentare auf Deutsch, wie im ganzen Repo. **Keine Umlaute in `electron/*.js`** (bestehende Konvention, siehe `setup.js`); in `.tsx` und Markdown sind Umlaute erwünscht.
- **Anzeigetexte gehören ins Frontend, nicht nach Electron.** `electron/updater.js` liefert für `nicht_moeglich` nur einen **Code** (`entwicklung` | `darwin` | `kein-appimage`); die deutschen Sätze mit Umlauten stehen in `SettingsPage.tsx`. So kollidiert die Umlaut-Regel nicht mit lesbarer Oberfläche, und Electron kennt den Grund, ohne die Formulierung zu besitzen.
- **Zustandsobjekt:** trägt IMMER `version` (laufende App-Version) und `art`; die übrigen Felder hängen von `art` ab.
- **Acht `art`-Werte:** `unbekannt`, `prueft`, `aktuell`, `verfuegbar`, `laedt`, `bereit`, `fehler`, `nicht_moeglich`.
- **Electron-Tests:** `node --test electron/*.test.js` über `npm run test:electron`. Kein Framework, keine Fixtures.
- **Frontend-Tests:** `npm --prefix webtool/frontend run test` (Vitest).
- **Fehler gehen weiterhin ins Protokoll** (`protokoll.schreiben`) — zusätzlich, nicht statt in den Zustand.
- **Keine neuen Abhängigkeiten.** `electron-updater` liegt bereits vor.

---

### Task 1: Zustandsautomat `electron/updater.js`

Das Herz. Kapselt `electron-updater` hinter einer Schnittstelle, die ohne Electron prüfbar ist — der `autoUpdater` wird hineingereicht, nicht importiert (dieselbe Idee wie `setup.plan(platform, paketmanager)`).

**Dateien:**
- Anlegen: `electron/updater.js`
- Anlegen: `electron/updater.test.js`

**Schnittstellen:**
- Liefert: `nichtMoeglich(plattform, gepackt, appimage) -> '' | 'entwicklung' | 'darwin' | 'kein-appimage'` (Leerstring = Update möglich). **Codes, keine Sätze** — die Formulierung gehört ins Frontend.
- Liefert: `erstellen({ autoUpdater, version, plattform, gepackt, appimage, aendert }) -> { zustand, pruefen, laden, installieren }`
  - `zustand()` gibt das aktuelle Objekt zurück
  - `aendert(zustandsObjekt)` wird bei **jeder** Änderung gerufen

- [ ] **Schritt 1: Test für die Plattformregeln schreiben**

`electron/updater.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { nichtMoeglich, erstellen } = require('./updater')

test('Entwicklungsmodus kann sich nicht selbst aktualisieren', () => {
  assert.strictEqual(nichtMoeglich('win32', false, false), 'entwicklung')
})

test('macOS kann es nicht, solange die App nicht notarisiert ist', () => {
  assert.strictEqual(nichtMoeglich('darwin', true, false), 'darwin')
})

test('Linux nur als AppImage — ein deb-Start hat die Variable nicht', () => {
  assert.strictEqual(nichtMoeglich('linux', true, false), 'kein-appimage')
  assert.strictEqual(nichtMoeglich('linux', true, true), '')
})

test('Windows kann es', () => {
  assert.strictEqual(nichtMoeglich('win32', true, false), '')
})
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `node --test electron/updater.test.js`
Erwartet: FEHLSCHLAG mit `Cannot find module './updater'`

- [ ] **Schritt 3: `nichtMoeglich` umsetzen**

`electron/updater.js`:

```js
'use strict'
/**
 * Update-Zustand als EIN Objekt. Der autoUpdater wird hineingereicht statt importiert:
 * so laeuft der Automat im Test ohne Electron, wie setup.plan() es vormacht.
 */

/**
 * Leerstring heisst: dieses System kann sich selbst aktualisieren.
 * Sonst ein CODE, kein Satz — die Formulierung steht in SettingsPage.tsx, wo Umlaute
 * erlaubt sind und der Text hingehoert.
 */
function nichtMoeglich(plattform, gepackt, appimage) {
  if (!gepackt) return 'entwicklung'
  // Squirrel.Mac verlangt eine echte Signatur; unsere dmg ist nur ad-hoc signiert.
  if (plattform === 'darwin') return 'darwin'
  // Die Variable setzt die AppImage-Laufzeit selbst; ein deb-Start hat sie nicht, und
  // fuer deb kennt electron-updater ohnehin keinen Weg.
  if (plattform === 'linux' && !appimage) return 'kein-appimage'
  return ''
}

module.exports = { nichtMoeglich }
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `node --test electron/updater.test.js`
Erwartet: 4 Tests bestehen, `erstellen`-Import ist noch `undefined` (wird in Schritt 5 gefüllt)

- [ ] **Schritt 5: Test für die Zustandsübergänge schreiben**

An `electron/updater.test.js` anhängen:

```js
/** Attrappe des autoUpdater: merkt sich Hoerer und protokolliert Aufrufe. */
function attrappe() {
  const hoerer = {}
  const aufrufe = []
  return {
    autoDownload: true,
    aufrufe,
    on: (ereignis, fn) => { hoerer[ereignis] = fn },
    checkForUpdates: () => { aufrufe.push('pruefen'); return Promise.resolve() },
    downloadUpdate: () => { aufrufe.push('laden'); return Promise.resolve() },
    quitAndInstall: () => { aufrufe.push('installieren') },
    feuern: (ereignis, ...rest) => hoerer[ereignis] && hoerer[ereignis](...rest),
  }
}

function bauen(zusatz = {}) {
  const au = attrappe()
  const gesehen = []
  const u = erstellen({
    autoUpdater: au, version: '0.2.1', plattform: 'win32',
    gepackt: true, appimage: false, aendert: z => gesehen.push(z), ...zusatz,
  })
  return { au, u, gesehen }
}

test('startet unbekannt und traegt immer die laufende Version', () => {
  const { u } = bauen()
  assert.strictEqual(u.zustand().art, 'unbekannt')
  assert.strictEqual(u.zustand().version, '0.2.1')
})

test('autoDownload wird abgeschaltet — sonst laedt das Pruefen sofort 100 MB', () => {
  const { au } = bauen()
  assert.strictEqual(au.autoDownload, false)
})

test('pruefen -> verfuegbar -> laedt -> bereit', () => {
  const { au, u, gesehen } = bauen()
  u.pruefen()
  assert.strictEqual(u.zustand().art, 'prueft')

  au.feuern('update-available', { version: '0.3.0', files: [{ size: 98566144 }] })
  assert.deepStrictEqual(
    { art: u.zustand().art, version: u.zustand().neue, groesse: u.zustand().groesse },
    { art: 'verfuegbar', version: '0.3.0', groesse: 98566144 })

  u.laden()
  au.feuern('download-progress', { percent: 43.2, transferred: 41, total: 94, bytesPerSecond: 6200000 })
  assert.strictEqual(u.zustand().art, 'laedt')
  assert.strictEqual(u.zustand().prozent, 43.2)

  au.feuern('update-downloaded', { version: '0.3.0' })
  assert.strictEqual(u.zustand().art, 'bereit')
  assert.ok(gesehen.length >= 4, 'jede Aenderung wird gemeldet')
})

test('kein Update vorhanden heisst aktuell', () => {
  const { au, u } = bauen()
  u.pruefen()
  au.feuern('update-not-available', {})
  assert.strictEqual(u.zustand().art, 'aktuell')
})

test('ein Fehler landet im Zustand statt im Nichts', () => {
  const { au, u } = bauen()
  au.feuern('error', new Error('404 releases.atom'))
  assert.strictEqual(u.zustand().art, 'fehler')
  assert.match(u.zustand().text, /releases\.atom/)
})

test('wo Updates unmoeglich sind, wird gar nicht erst geprueft', () => {
  const { au, u } = bauen({ plattform: 'darwin' })
  assert.strictEqual(u.zustand().art, 'nicht_moeglich')
  u.pruefen()
  assert.deepStrictEqual(au.aufrufe, [], 'kein Aufruf, der ohnehin scheitern wuerde')
})
```

- [ ] **Schritt 6: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `node --test electron/updater.test.js`
Erwartet: FEHLSCHLAG mit `erstellen is not a function`

- [ ] **Schritt 7: `erstellen` umsetzen**

In `electron/updater.js` vor `module.exports` einfügen:

```js
/**
 * Baut den Automaten. `aendert` wird bei jeder Zustandsaenderung gerufen — daran haengt
 * die Anzeige im Fenster.
 */
function erstellen({ autoUpdater, version, plattform, gepackt, appimage, aendert }) {
  const grund = nichtMoeglich(plattform, gepackt, appimage)
  let stand = grund ? { version, art: 'nicht_moeglich', grund } : { version, art: 'unbekannt' }

  const setzen = neu => { stand = { version, ...neu }; aendert(stand) }

  if (!grund) {
    // Ohne das laedt electron-updater beim Pruefen sofort los und "erst auf Klick"
    // waere wirkungslos.
    autoUpdater.autoDownload = false
    autoUpdater.on('update-available', info => setzen({
      art: 'verfuegbar',
      neue: info.version,
      groesse: (info.files && info.files[0] && info.files[0].size) || 0,
    }))
    autoUpdater.on('update-not-available', () => setzen({ art: 'aktuell' }))
    autoUpdater.on('download-progress', p => setzen({
      art: 'laedt',
      prozent: p.percent,
      geladen: p.transferred,
      gesamt: p.total,
      tempo: p.bytesPerSecond,
    }))
    autoUpdater.on('update-downloaded', info => setzen({ art: 'bereit', neue: info.version }))
    autoUpdater.on('error', e => setzen({ art: 'fehler', text: String((e && e.message) || e) }))
  }

  return {
    zustand: () => stand,
    pruefen: () => {
      if (grund) return                       // wuerde ohnehin scheitern
      setzen({ art: 'prueft' })
      autoUpdater.checkForUpdates().catch(() => {})   // Fehler kommt ueber 'error'
    },
    laden: () => { if (!grund) autoUpdater.downloadUpdate().catch(() => {}) },
    installieren: () => { if (!grund) autoUpdater.quitAndInstall() },
  }
}
```

`module.exports` erweitern zu `module.exports = { nichtMoeglich, erstellen }`.

- [ ] **Schritt 8: Alle Electron-Tests laufen lassen**

Ausführen: `npm run test:electron`
Erwartet: alle bestehen (18 vorhandene + 10 neue = 28)

- [ ] **Schritt 9: Committen**

```bash
git add electron/updater.js electron/updater.test.js
git commit -m "feat(update): Zustandsautomat fuer den Updater, ohne Electron pruefbar"
```

---

### Task 2: Brücke — `preload.js` und `main.js` verdrahten

Der Automat aus Task 1 wird an Electron angeschlossen und ans Fenster gereicht.

**Dateien:**
- Ändern: `electron/preload.js`
- Ändern: `electron/main.js:89-113` (der bestehende `if (app.isPackaged)`-Block)
- Anlegen: `electron/preload.test.js`

**Schnittstellen:**
- Nutzt: `updater.erstellen(...)` aus Task 1
- Liefert: `window.transkribor.update = { status, pruefen, laden, installieren }` und den Ereigniskanal `'update'`

- [ ] **Schritt 1: Test für den Brückenvertrag schreiben**

`electron/preload.test.js`:

```js
'use strict'
/** Prueft, WAS die Bruecke freigibt — eine zu weit geoeffnete Bruecke faellt sonst niemandem auf. */
const Module = require('node:module')
const test = require('node:test')
const assert = require('node:assert')

let freigegeben = null
const kanaele = []
const echt = Module._load
Module._load = (req, ...rest) => req === 'electron' ? {
  contextBridge: { exposeInMainWorld: (_name, api) => { freigegeben = api } },
  ipcRenderer: { invoke: () => Promise.resolve(), on: (k) => kanaele.push(k) },
} : echt(req, ...rest)
require('./preload')
Module._load = echt

test('die Update-Methoden sind da', () => {
  for (const name of ['status', 'pruefen', 'laden', 'installieren']) {
    assert.strictEqual(typeof freigegeben.update[name], 'function', name)
  }
})

test('der Kanal update ist erlaubt, ein erfundener nicht', () => {
  freigegeben.on('update', () => {})
  freigegeben.on('kanal-den-es-nicht-gibt', () => {})
  assert.deepStrictEqual(kanaele, ['update'])
})
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `node --test electron/preload.test.js`
Erwartet: FEHLSCHLAG — `freigegeben.update` ist `undefined`

- [ ] **Schritt 3: `preload.js` erweitern**

`electron/preload.js` — `update`-Objekt ergänzen und `'update'` in die Kanalliste aufnehmen:

```js
contextBridge.exposeInMainWorld('transkribor', {
  status: () => ipcRenderer.invoke('status'),
  einrichten: () => ipcRenderer.invoke('einrichten'),
  logs: () => ipcRenderer.invoke('logs'),
  protokollOeffnen: () => ipcRenderer.invoke('protokollOeffnen'),
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    pruefen: () => ipcRenderer.invoke('update:pruefen'),
    laden: () => ipcRenderer.invoke('update:laden'),
    installieren: () => ipcRenderer.invoke('update:installieren'),
  },
  on: (kanal, fn) => {
    if (!['log', 'phase', 'status', 'fehler', 'update'].includes(kanal)) return
    ipcRenderer.on(kanal, (_e, nutzlast) => fn(nutzlast))
  },
})
```

Den Kommentar in Zeile 2 anpassen: „genau diese fuenf Dinge" stimmt nicht mehr — ersetzen durch „nur die hier aufgezaehlten Dinge".

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `node --test electron/preload.test.js`
Erwartet: 2 Tests bestehen

- [ ] **Schritt 5: `main.js` umbauen**

In `electron/main.js` den Block `if (app.isPackaged) { ... }` (Zeilen 89–113) **vollständig** ersetzen durch:

```js
  // Update: Pruefen laeuft von selbst, Laden erst auf Klick. Der Zustand geht ins Fenster
  // (Einstellungen), Fehler zusaetzlich ins Protokoll — ein Popup, das man wegklickt und
  // nicht wiederfindet, gibt es bewusst nicht mehr.
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.logger = null
    aktualisierer = updater.erstellen({
      autoUpdater,
      version: app.getVersion(),
      plattform: process.platform,
      gepackt: app.isPackaged,
      appimage: !!process.env.APPIMAGE,
      aendert: z => {
        if (z.art === 'fehler') protokoll.schreiben(`Update-Pruefung fehlgeschlagen: ${z.text}`)
        if (win && !win.isDestroyed()) win.webContents.send('update', z)
      },
    })
    aktualisierer.pruefen()
  } catch (e) {
    protokoll.schreiben(`Update-Pruefung nicht moeglich: ${e && e.message || e}`)
  }
```

Oben in der Datei ergänzen: `const updater = require('./updater')` neben den anderen `require`s, und `let aktualisierer = null` neben `let win = null`.

Bei den übrigen `ipcMain.handle`-Zeilen ergänzen:

```js
ipcMain.handle('update:status', () => aktualisierer && aktualisierer.zustand())
ipcMain.handle('update:pruefen', () => aktualisierer && aktualisierer.pruefen())
ipcMain.handle('update:laden', () => aktualisierer && aktualisierer.laden())
ipcMain.handle('update:installieren', () => {
  if (!aktualisierer) return
  backend.stop()          // sonst bleibt uvicorn als Waise mit belegter GPU zurueck
  aktualisierer.installieren()
})
```

**Wichtig:** `app.isPackaged` steht nicht mehr als Bedingung davor — der Automat wird immer gebaut und meldet im Entwicklungsmodus selbst `nicht_moeglich`. Ohne das bliebe die Oberfläche beim Entwickeln leer und niemand sähe den Abschnitt je.

- [ ] **Schritt 6: Syntax und alle Electron-Tests prüfen**

Ausführen: `node --check electron/main.js && npm run test:electron`
Erwartet: `syntax ok`, alle Tests bestehen (30)

- [ ] **Schritt 7: Committen**

```bash
git add electron/preload.js electron/preload.test.js electron/main.js
git commit -m "feat(update): Zustand ueber die preload-Bruecke ans Fenster reichen"
```

---

### Task 3: React-Hook `useUpdate.ts`

**Dateien:**
- Anlegen: `webtool/frontend/src/hooks/useUpdate.ts`
- Anlegen: `webtool/frontend/src/hooks/useUpdate.test.tsx`
- Ändern: `webtool/frontend/src/lib/types.ts` (Typ ergänzen)

**Schnittstellen:**
- Nutzt: `window.transkribor.update` und den Kanal `'update'` aus Task 2
- Liefert: `useUpdate() -> { zustand: UpdateZustand | null, pruefen, laden, installieren }`
  `zustand === null` heisst: kein Electron (normaler Browser) → Abschnitt nicht anzeigen

- [ ] **Schritt 1: Typ ergänzen**

An `webtool/frontend/src/lib/types.ts` anhängen:

```ts
/** Update-Zustand aus Electron. `version` ist immer die LAUFENDE App-Version. */
export type UpdateZustand =
  | { version: string; art: 'unbekannt' | 'prueft' | 'aktuell' }
  | { version: string; art: 'verfuegbar'; neue: string; groesse: number }
  | { version: string; art: 'laedt'; prozent: number; geladen: number; gesamt: number; tempo: number }
  | { version: string; art: 'bereit'; neue: string }
  | { version: string; art: 'fehler'; text: string }
  /** `grund` ist ein Code, kein Satz — der deutsche Text steht in SettingsPage.tsx. */
  | { version: string; art: 'nicht_moeglich'; grund: 'entwicklung' | 'darwin' | 'kein-appimage' }
```

- [ ] **Schritt 2: Test schreiben**

`webtool/frontend/src/hooks/useUpdate.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useUpdate } from './useUpdate'
import type { UpdateZustand } from '@/lib/types'

const AKTUELL: UpdateZustand = { version: '0.2.1', art: 'aktuell' }

function bruecke(start: UpdateZustand) {
  let melden: ((z: UpdateZustand) => void) | null = null
  const api = {
    update: {
      status: vi.fn().mockResolvedValue(start),
      pruefen: vi.fn().mockResolvedValue(undefined),
      laden: vi.fn().mockResolvedValue(undefined),
      installieren: vi.fn().mockResolvedValue(undefined),
    },
    on: (kanal: string, fn: (z: UpdateZustand) => void) => { if (kanal === 'update') melden = fn },
  }
  ;(window as unknown as { transkribor: unknown }).transkribor = api
  return { api, schieben: (z: UpdateZustand) => act(() => melden?.(z)) }
}

describe('useUpdate', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('holt den Anfangszustand aus Electron', async () => {
    bruecke(AKTUELL)
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toEqual(AKTUELL))
  })

  it('uebernimmt geschobene Aenderungen ohne erneutes Abfragen', async () => {
    const { api, schieben } = bruecke(AKTUELL)
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toEqual(AKTUELL))

    schieben({ version: '0.2.1', art: 'laedt', prozent: 43, geladen: 41, gesamt: 94, tempo: 6200000 })
    await waitFor(() => expect(result.current.zustand?.art).toBe('laedt'))
    expect(api.update.status).toHaveBeenCalledTimes(1)
  })

  it('ohne Electron bleibt der Zustand null — der Abschnitt erscheint dann gar nicht', async () => {
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand).toBeNull())
  })

  it('reicht die Knopfdruecke durch', async () => {
    const { api } = bruecke({ version: '0.2.1', art: 'verfuegbar', neue: '0.3.0', groesse: 99 })
    const { result } = renderHook(() => useUpdate())
    await waitFor(() => expect(result.current.zustand?.art).toBe('verfuegbar'))
    act(() => result.current.laden())
    expect(api.update.laden).toHaveBeenCalled()
  })
})
```

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `npm --prefix webtool/frontend run test -- useUpdate`
Erwartet: FEHLSCHLAG — Modul `./useUpdate` fehlt

- [ ] **Schritt 4: Hook umsetzen**

`webtool/frontend/src/hooks/useUpdate.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'
import type { UpdateZustand } from '@/lib/types'

type Bruecke = {
  update: {
    status: () => Promise<UpdateZustand>
    pruefen: () => Promise<void>
    laden: () => Promise<void>
    installieren: () => Promise<void>
  }
  on: (kanal: string, fn: (z: UpdateZustand) => void) => void
}

function bruecke(): Bruecke | null {
  const w = window as unknown as { transkribor?: Bruecke }
  return w.transkribor?.update ? w.transkribor : null
}

/** Update-Zustand aus Electron. `null` heisst: laeuft im normalen Browser, es gibt hier
 *  keine Updates — die Einstellungen blenden den Abschnitt dann aus. */
export function useUpdate() {
  const [zustand, setZustand] = useState<UpdateZustand | null>(null)

  useEffect(() => {
    const b = bruecke()
    if (!b) return
    b.update.status().then(setZustand).catch(() => {})
    // Jede Aenderung wird geschoben — kein Polling, der Fortschritt kaeme sonst ruckelig an.
    b.on('update', setZustand)
  }, [])

  const pruefen = useCallback(() => { bruecke()?.update.pruefen().catch(() => {}) }, [])
  const laden = useCallback(() => { bruecke()?.update.laden().catch(() => {}) }, [])
  const installieren = useCallback(() => { bruecke()?.update.installieren().catch(() => {}) }, [])

  return { zustand, pruefen, laden, installieren }
}
```

- [ ] **Schritt 5: Test laufen lassen, Erfolg bestätigen**

Ausführen: `npm --prefix webtool/frontend run test -- useUpdate`
Erwartet: 4 Tests bestehen

- [ ] **Schritt 6: Committen**

```bash
git add webtool/frontend/src/hooks/useUpdate.ts webtool/frontend/src/hooks/useUpdate.test.tsx webtool/frontend/src/lib/types.ts
git commit -m "feat(update): Hook, der den Update-Zustand aus Electron liest"
```

---

### Task 4: Abschnitt „Version und Updates" in den Einstellungen

**Dateien:**
- Ändern: `webtool/frontend/src/pages/SettingsPage.tsx`
- Ändern: `webtool/frontend/src/pages/SettingsPage.test.tsx`

**Schnittstellen:**
- Nutzt: `useUpdate()` aus Task 3

- [ ] **Schritt 1: Test für die acht Zustände schreiben**

An `webtool/frontend/src/pages/SettingsPage.test.tsx` anhängen (Import von `useUpdate` mocken, wie die Seite es sonst auch mit `@/lib/api` tut):

```tsx
vi.mock('@/hooks/useUpdate')

import { useUpdate } from '@/hooks/useUpdate'
import type { UpdateZustand } from '@/lib/types'

function zeigeMit(zustand: UpdateZustand | null) {
  vi.mocked(useUpdate).mockReturnValue({
    zustand, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(),
  })
  return render(<SettingsPage />)
}

describe('Abschnitt Version und Updates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ohne Electron erscheint der Abschnitt gar nicht', async () => {
    zeigeMit(null)
    await screen.findByText(/Qualität der Transkription/i)
    expect(screen.queryByText(/Version und Updates/)).toBeNull()
  })

  it('zeigt die laufende Version', async () => {
    zeigeMit({ version: '0.2.1', art: 'aktuell' })
    expect(await screen.findByText(/0\.2\.1/)).toBeTruthy()
    expect(screen.getByText(/aktuell/)).toBeTruthy()
  })

  it('vor der ersten Pruefung nur Version und Knopf, kein "aktuell"', async () => {
    zeigeMit({ version: '0.2.1', art: 'unbekannt' })
    expect(await screen.findByRole('button', { name: /Nach Updates suchen/ })).toBeTruthy()
    expect(screen.queryByText(/aktuell/)).toBeNull()   // sonst behauptet die Seite Wissen, das sie nicht hat
  })

  it('bietet den Download mit Groesse an', async () => {
    zeigeMit({ version: '0.2.1', art: 'verfuegbar', neue: '0.3.0', groesse: 98566144 })
    expect(await screen.findByText(/0\.3\.0 verfügbar/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Herunterladen \(94 MB\)/ })).toBeTruthy()
  })

  it('zeigt beim Laden Prozent, MB und Tempo', async () => {
    zeigeMit({ version: '0.2.1', art: 'laedt', prozent: 43.2, geladen: 41 * 1048576, gesamt: 94 * 1048576, tempo: 6.2 * 1048576 })
    expect(await screen.findByText(/43 %/)).toBeTruthy()
    expect(screen.getByText(/41 von 94 MB/)).toBeTruthy()
    expect(screen.getByText(/6,2 MB\/s/)).toBeTruthy()
  })

  it('bietet nach dem Laden den Neustart an', async () => {
    zeigeMit({ version: '0.2.1', art: 'bereit', neue: '0.3.0' })
    expect(await screen.findByRole('button', { name: /Neu starten und installieren/ })).toBeTruthy()
  })

  it('macht aus dem Code einen deutschen Satz, samt Link', async () => {
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'darwin' })
    expect(await screen.findByText(/nicht notarisiert/)).toBeTruthy()
    expect(screen.getByText(/möglich/)).toBeTruthy()          // mit Umlaut, nicht "moeglich"
    expect(screen.getByRole('link', { name: /Versionen/ })).toBeTruthy()
  })

  it('kennt auch die beiden anderen Gruende', async () => {
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'entwicklung' })
    expect(await screen.findByText(/Entwicklungsmodus/)).toBeTruthy()
    cleanup()
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'kein-appimage' })
    expect(await screen.findByText(/AppImage/)).toBeTruthy()
  })

  it('zeigt einen Fehler samt Weg zum Protokoll', async () => {
    zeigeMit({ version: '0.2.1', art: 'fehler', text: '404 releases.atom' })
    expect(await screen.findByText(/404 releases\.atom/)).toBeTruthy()
  })

  it('sperrt den Knopf waehrend der Pruefung', async () => {
    zeigeMit({ version: '0.2.1', art: 'prueft' })
    expect((await screen.findByRole('button', { name: /Wird geprüft/ })).hasAttribute('disabled')).toBe(true)
  })
})
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Ausführen: `npm --prefix webtool/frontend run test -- SettingsPage`
Erwartet: FEHLSCHLAG — der Abschnitt existiert nicht

- [ ] **Schritt 3: Abschnitt umsetzen**

In `SettingsPage.tsx` oben ergänzen:

```tsx
import { useUpdate } from '@/hooks/useUpdate'
```

Im Rumpf von `SettingsPage()` ergänzen: `const { zustand: upd, pruefen, laden, installieren } = useUpdate()`

Hilfsfunktionen auf Modulebene (über `export function SettingsPage()`):

```tsx
const RELEASES = 'https://github.com/napoleonmm83/Transkribor/releases'

/** Bytes als MB mit einer Nachkommastelle, deutsches Dezimalkomma. */
function mb(bytes: number, stellen = 0) {
  return (bytes / 1048576).toFixed(stellen).replace('.', ',')
}

/** Der Grund kommt als Code aus Electron — der Satz gehoert hierher, wo Umlaute erlaubt sind. */
const GRUENDE: Record<string, string> = {
  entwicklung: 'Entwicklungsmodus — Updates gibt es nur in der installierten App.',
  darwin: 'Auf macOS nicht möglich, solange die App nicht notarisiert ist.',
  'kein-appimage': 'Nur die AppImage kann sich selbst aktualisieren.',
}
```

Vor dem schliessenden `</div>` der Seite einfügen:

```tsx
{upd && (
  <div className="mt-8 border-t pt-6">
    <h2 className="font-medium">Version und Updates</h2>
    <p className="mt-1 text-sm">
      <span className="font-medium">Transkribor {upd.version}</span>
      {upd.art === 'aktuell' && <span className="text-muted-foreground"> · aktuell</span>}
    </p>

    {(upd.art === 'unbekannt' || upd.art === 'aktuell' || upd.art === 'prueft') && (
      <Button className="mt-3" variant="outline" disabled={upd.art === 'prueft'} onClick={pruefen}>
        {upd.art === 'prueft'
          ? <><Loader2 className="size-4 animate-spin" /> Wird geprüft …</>
          : 'Nach Updates suchen'}
      </Button>
    )}

    {upd.art === 'verfuegbar' && (
      <div className="mt-3">
        <p className="text-sm">{upd.neue} verfügbar</p>
        <Button className="mt-2" onClick={laden}>Herunterladen ({mb(upd.groesse)} MB)</Button>
      </div>
    )}

    {upd.art === 'laedt' && (
      <div className="mt-3">
        <div className="h-2 w-full overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${upd.prozent}%` }} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {Math.round(upd.prozent)} % · {mb(upd.geladen)} von {mb(upd.gesamt)} MB · {mb(upd.tempo, 1)} MB/s
        </p>
      </div>
    )}

    {upd.art === 'bereit' && (
      <div className="mt-3">
        <p className="text-sm">{upd.neue} ist bereit.</p>
        <Button className="mt-2" onClick={installieren}>Neu starten und installieren</Button>
      </div>
    )}

    {upd.art === 'fehler' && (
      <p className="mt-3 text-sm text-muted-foreground">
        Prüfung fehlgeschlagen: {upd.text} — Einzelheiten stehen im Protokoll.
      </p>
    )}

    {upd.art === 'nicht_moeglich' && (
      <p className="mt-3 text-sm text-muted-foreground">
        {GRUENDE[upd.grund] ?? 'Updates sind auf diesem System nicht möglich.'}{' '}
        <a className="underline" href={RELEASES} target="_blank" rel="noreferrer">Versionen ansehen</a>
      </p>
    )}
  </div>
)}
```

- [ ] **Schritt 4: Test laufen lassen, Erfolg bestätigen**

Ausführen: `npm --prefix webtool/frontend run test -- SettingsPage`
Erwartet: alle 9 neuen Tests bestehen (die acht Zustände plus der Fall ohne Electron)

- [ ] **Schritt 5: Gesamte Suiten laufen lassen**

Ausführen: `npm run test:electron && npm --prefix webtool/frontend run test`
Erwartet: alles grün

- [ ] **Schritt 6: Committen**

```bash
git add webtool/frontend/src/pages/SettingsPage.tsx webtool/frontend/src/pages/SettingsPage.test.tsx
git commit -m "feat(update): Abschnitt Version und Updates in den Einstellungen"
```

---

### Task 5: In der echten App prüfen

Automatische Tests sehen die Verdrahtung nicht — genau dort lagen in dieser Codebasis die Fehler (`transcribe.py` fand aus dem Installer kein Projekt, obwohl 245 Tests grün waren).

**Dateien:** keine (Prüfschritt)

- [ ] **Schritt 1: Aus dem Repo starten**

```bash
npm start
```

Erwartet: Einstellungen zeigen „Transkribor 0.2.1" und den Grund „Entwicklungsmodus — Updates gibt es nur in der installierten App." samt Link.

- [ ] **Schritt 2: Installer bauen und installieren**

```bash
npm run dist
```

Dann `dist\Transkribor-Setup-<version>.exe` mit `/S` installieren und starten.

- [ ] **Schritt 3: Zustand prüfen**

Erwartet: Einstellungen zeigen die Version und „aktuell" (die installierte Fassung ist die neueste). Im Protokoll (`%APPDATA%\Transkribor\transkribor.log`) steht **keine** Fehlermeldung mehr zur Update-Prüfung.

- [ ] **Schritt 4: Den Fund festhalten**

Weicht etwas ab, im Plan als Abschnitt „Beim Dogfooding gefunden" ergänzen, statt es stillschweigend zu korrigieren.

- [ ] **Schritt 5: CLAUDE.md ergänzen**

Im Abschnitt „Desktop-App (Electron)" ergänzen:

```markdown
- **Update-Zustand liegt in `electron/updater.js`**, nicht in `main.js`: der Automat bekommt
  den `autoUpdater` hineingereicht und ist damit ohne Electron testbar. `autoDownload` ist
  **aus** — sonst zöge das Prüfen sofort 100 MB, ungefragt. Die Oberfläche dazu steht in den
  Einstellungen (`useUpdate` + `SettingsPage`) und erscheint im reinen Browser gar nicht,
  weil `window.transkribor` dort fehlt.
```

```bash
git add CLAUDE.md
git commit -m "docs: Update-Zustand in der CLAUDE.md festhalten"
```
