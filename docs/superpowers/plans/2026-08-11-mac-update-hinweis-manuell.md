# Mac-Update-Hinweis (manuell) — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development oder superpowers:executing-plans. Schritte nutzen Checkbox-Syntax (`- [ ]`).

**Goal:** Auf macOS aktiv prüfen, ob eine neue Version verfügbar ist, und den Nutzer in Fußzeile + Einstellungen informieren, dass er sie manuell herunterladen kann (Auto-Update bleibt ohne Notarisierung tot).

**Architecture:** Mac bekommt in `electron/updater.js` einen eigenen, am `autoUpdater` vorbeilaufenden Prüf-Automaten: HTTP-GET der veröffentlichten `latest-mac.yml`, `version:` parsen, semver vergleichen. Bei verfügbar → neuer Zustand `verfuegbar_manuell`; `laden()` öffnet die Release-Seite via `shell.openExternal` (kein `downloadUpdate`). Win/Linux unverändert. URL wird aus `build.publish` abgeleitet; `hole`/`openExternal` werden wie `autoUpdater` in `erstellen` hereingereicht → ohne Mac-Hardware testbar.

**Tech Stack:** Electron-Main (Node 20, globales `fetch`), `node:test`/`node:assert` (`npm run test:electron`), React + Vitest (Frontend).

## Global Constraints

- **Mac prüft, wendet nicht an:** `laden()` öffnet den Browser, `installieren()` ist No-Op. Kein `autoUpdater.downloadUpdate` auf Mac.
- **`hole`/`openExternal`/URLs werden hereingereicht** (wie `autoUpdater`) — der Automat läuft im `node:test` ohne Electron und ohne Netz.
- **URL aus `build.publish`** (`require('../package.json').build.publish[0]`), nicht hartkodiert.
- **Kaputte `latest-mac.yml` / Offline → `fehler`, kein Crash.**
- `sollPruefen`-Weißliste unverändert (`verfuegbar_manuell` ist wie `verfuegbar` ausgeschlossen).
- Test-Stack: Electron `npm run test:electron` (`node --test`, einzelne Datei: `node --test electron/updater.test.js`); Frontend `cd webtool/frontend && npx vitest run`, Typecheck `npx tsc -b`, Lint `npx oxlint`.

## File Structure

- **Modify** `electron/updater.js` — `nichtMoeglich` (darwin raus), neue Helfer `macUrls`/`istNeuer`/`parseLatestMac`, Mac-Zweig in `erstellen`.
- **Modify** `electron/updater.test.js` — Mac-Tests umstellen + neue Mac-Automat-Tests.
- **Modify** `electron/main.js` — `hole`/`openExternal`/URLs an `erstellen` reichen.
- **Modify** `webtool/frontend/src/lib/types.ts` — `verfuegbar_manuell`, `darwin`-Grund streichen.
- **Modify** `webtool/frontend/src/components/StatusBar.tsx` — `verfuegbar_manuell` in `updateHinweis`.
- **Modify** `webtool/frontend/src/pages/SettingsPage.tsx` — `verfuegbar_manuell`-Zweig, `darwin`-Text raus.
- **Modify** `CLAUDE.md` (lokal) — Mac prüft manuell, wendet nicht an.

---

### Task 1: `updater.js` — Helfer + Mac-Automat (TDD)

**Files:** Modify `electron/updater.js`, `electron/updater.test.js`.

**Interfaces:**
- Produces: `macUrls(paket) → {feed, release}`, `istNeuer(a,b) → boolean|null`, `parseLatestMac(yaml) → {version, groesse}|null`, `erstellen` um Mac-Zweig + Params `{hole, openExternal, feedUrl, releaseUrl}` erweitert.

- [ ] **Step 1: RED — reine Helfer**

In `updater.test.js` (neuer Block):

```js
const { macUrls, istNeuer, parseLatestMac } = require('./updater')

test('macUrls leitet Feed + Release aus build.publish ab', () => {
  const urls = macUrls({ build: { publish: [{ provider: 'github', owner: 'napoleonmm83', repo: 'Transkribor' }] } })
  assert.strictEqual(urls.feed, 'https://github.com/napoleonmm83/Transkribor/releases/latest/download/latest-mac.yml')
  assert.strictEqual(urls.release, 'https://github.com/napoleonmm83/Transkribor/releases/latest')
})

test('istNeuer erkennt semver-Gefälle', () => {
  assert.strictEqual(istNeuer('0.17.0', '0.16.0'), true)
  assert.strictEqual(istNeuer('0.16.0', '0.17.0'), false)
  assert.strictEqual(istNeuer('0.17.0', '0.17.0'), false)
  assert.strictEqual(istNeuer('1.0.0', '0.99.99'), true)
})

test('istNeuer liefert null bei ungueltigem Format', () => {
  assert.strictEqual(istNeuer('x.y.z', '0.17.0'), null)
  assert.strictEqual(istNeuer('0.17.0', 'kaputt'), null)
})

test('parseLatestMac liest Version und size', () => {
  const yml = "version: 0.17.0\nfiles:\n  - url: X.dmg\n    size: 149843177\npath: X.dmg\n"
  assert.deepStrictEqual(parseLatestMac(yml), { version: '0.17.0', groesse: 149843177 })
})

test('parseLatestMac ohne Version -> null, size optional', () => {
  assert.strictEqual(parseLatestMac('path: X.dmg\n'), null)
  assert.strictEqual(parseLatestMac('version: 0.17.0\n').groesse, null)
})
```

Run: `node --test electron/updater.test.js` → diese 5 FAIL (Helfer fehlen).

- [ ] **Step 2: Helfer implementieren**

In `updater.js` (oberer Bereich, nach `nichtMoeglich`):

```js
/** Feed- + Release-URL aus build.publish ableiten (eine Wahrheitsquelle, nicht hartkodiert). */
function macUrls(paket) {
  const p = paket && paket.build && paket.build.publish && paket.build.publish[0]
  if (!p || p.provider !== 'github' || !p.owner || !p.repo) return null
  const base = `https://github.com/${p.owner}/${p.repo}`
  return { feed: `${base}/releases/latest/download/latest-mac.yml`, release: `${base}/releases/latest` }
}

/** Semver-Vergleich. true falls a > b (X.Y.Z numerisch), null falls Format ungueltig. */
function istNeuer(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(a))
  const pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(b))
  if (!pa || !pb) return null
  for (let i = 1; i <= 3; i++) {
    const d = +pa[i] - +pb[i]
    if (d > 0) return true
    if (d < 0) return false
  }
  return false
}

/** Liest {version, groesse} aus einer latest-mac.yml; null ohne version-Zeile. */
function parseLatestMac(text) {
  const v = /^version:\s*(\S+)/m.exec(text)
  if (!v) return null
  const s = /^[\s-]*size:\s*(\d+)/m.exec(text)
  return { version: v[1], groesse: s ? +s[1] : null }
}
```

`module.exports` um `macUrls, istNeuer, parseLatestMac` erweitern. Run → 5 PASS.

- [ ] **Step 3: nichtMoeglich — darwin streichen + Test umstellen**

In `updater.js` die `darwin`-Zeile aus `nichtMoeglich` entfernen. In `updater.test.js` den Test „macOS kann es nicht …" ersetzen:

```js
test('macOS prueft jetzt manuell (kein nicht_moeglich mehr)', () => {
  assert.strictEqual(nichtMoeglich('darwin', true, false), '')
  assert.strictEqual(nichtMoeglich('darwin', false, false), 'entwicklung')
})
```

- [ ] **Step 4: RED — Mac-Automat**

In `updater.test.js` (neuer Block). `bauenMac` baut den Mac-Automaten mit Fake-`hole`/`openExternal`:

```js
function bauenMac({ yml, fehler, version = '0.16.0' } = {}) {
  const gesehen = []
  const openExternal = (...a) => gesehen.push(['openExternal', ...a])
  const hole = async () => {
    if (fehler) throw new Error(fehler)
    return { text: async () => yml }
  }
  const u = erstellen({
    autoUpdater: attrappe(), version, plattform: 'darwin', gepackt: true, appimage: false,
    hole, openExternal,
    feedUrl: 'https://x/latest-mac.yml', releaseUrl: 'https://x/releases/latest',
    aendert: z => gesehen.push([z]),
  })
  return { u, gesehen }
}

test('Mac: neuere Version -> verfuegbar_manuell mit Groesse', () => {
  const { u, gesehen } = bauenMac({ version: '0.16.0', yml: 'version: 0.17.0\n  size: 149843177\n' })
  u.pruefen()
  assert.strictEqual(u.zustand().art, 'prueft')
  // pruefen ist async (fetch); Bestaetigung im naechsten Tick
  setImmediate(() => {
    assert.strictEqual(u.zustand().art, 'verfuegbar_manuell')
    assert.strictEqual(u.zustand().neue, '0.17.0')
    assert.strictEqual(u.zustand().groesse, 149843177)
  })
})

test('Mac: gleiche Version -> aktuell', () => {
  const { u } = bauenMac({ version: '0.17.0', yml: 'version: 0.17.0\n' })
  u.pruefen()
  setImmediate(() => assert.strictEqual(u.zustand().art, 'aktuell'))
})

test('Mac: Fetch-Fehler -> fehler (kein throw, kein Haengen)', () => {
  const { u } = bauenMac({ fehler: 'netz weg' })
  u.pruefen()
  setImmediate(() => { assert.strictEqual(u.zustand().art, 'fehler'); assert.match(u.zustand().text, /netz weg/) })
})

test('Mac: kaputte YAML -> fehler', () => {
  const { u } = bauenMac({ yml: 'path: X.dmg\n' })
  u.pruefen()
  setImmediate(() => assert.strictEqual(u.zustand().art, 'fehler'))
})

test('Mac: laden oeffnet den Browser, nicht downloadUpdate', () => {
  const au = attrappe()
  const { u, gesehen } = bauenMac({})
  u.laden()
  assert.deepStrictEqual(au.aufrufe, [], 'kein downloadUpdate auf Mac')
  assert.ok(gesehen.some(e => e[0] === 'openExternal' && e[1] === 'https://x/releases/latest'))
})
```

Hinweis: `node:test` macht die `setImmediate`-Assertions asynchron — bei Bedarf in `await new Promise(r => setImmediate(r))` wandeln oder Promises zurückgeben. Run → FAIL (Mac-Zweig fehlt).

- [ ] **Step 5: Mac-Zweig in `erstellen`**

`erstellen`-Signatur um `hole, openExternal, feedUrl, releaseUrl` erweitern. Mac-Zweig VOR dem `if (!grund)`-autoUpdater-Block einfügen (frühes `return`):

```js
function erstellen({ autoUpdater, version, plattform, gepackt, appimage, aendert, hole, openExternal, feedUrl, releaseUrl }) {
  const grund = nichtMoeglich(plattform, gepackt, appimage)
  let stand = grund ? { version, art: 'nicht_moeglich', grund } : { version, art: 'unbekannt' }
  const setzen = neu => { stand = { version, ...neu }; aendert(stand) }

  // Mac: manuelle Pruefung am autoUpdater vorbei (Auto-Update ohne Notarisierung tot).
  if (plattform === 'darwin' && gepackt) {
    return {
      zustand: () => stand,
      pruefen: () => {
        setzen({ art: 'prueft' })
        hole(feedUrl).then(r => r.text()).then(parseLatestMac).then(gelesen => {
          if (!gelesen) return setzen({ art: 'fehler', text: 'latest-mac.yml ohne Version' })
          const neu = istNeuer(gelesen.version, version)
          if (neu === null) return setzen({ art: 'fehler', text: `Version nicht lesbar: ${gelesen.version}` })
          if (neu) return setzen({ art: 'verfuegbar_manuell', neue: gelesen.version, groesse: gelesen.groesse })
          setzen({ art: 'aktuell' })
        }).catch(e => setzen({ art: 'fehler', text: (e && e.message) || String(e) }))
      },
      laden: () => { openExternal(releaseUrl) },
      installieren: () => {},
    }
  }

  if (!grund) {
    autoUpdater.autoDownload = false
    // ... bestehende Listener unverändert ...
  }
  return { zustand: () => stand, pruefen: ..., laden: ..., installieren: ... }   // bestehend
}
```

- [ ] **Step 6: bestehenden „nicht_moeglich"-Test umstellen**

Der Test „wo Updates unmoeglich sind …" nutzt heute `{plattform:'darwin'}` — Mac ist nicht mehr nicht_moeglich. Auf Linux-deb umstellen:

```js
test('wo Updates unmoeglich sind, wird gar nicht erst geprueft', () => {
  const au = attrappe()
  const u = erstellen({ autoUpdater: au, version: '0.2.1', plattform: 'linux', gepackt: true, appimage: false, aendert: () => {} })
  assert.strictEqual(u.zustand().art, 'nicht_moeglich')
  u.pruefen()
  assert.deepStrictEqual(au.aufrufe, [], 'kein Aufruf, der ohnehin scheitern wuerde')
})
```

- [ ] **Step 7: Run + Commit**

`node --test electron/updater.test.js` → alles grün. `npm run test:electron` → alles grün.
`git add electron/updater.js electron/updater.test.js && git commit -m "feat(updater): Mac prüft manuell per latest-mac.yml (\`verfuegbar_manuell\`)"`

---

### Task 2: `types.ts` + `main.js`-Wiring

**Files:** Modify `webtool/frontend/src/lib/types.ts`, `electron/main.js`.

- [ ] **Step 1: `UpdateZustand` erweitern**

In `types.ts` neuen Zweig + `darwin` am grund streichen:

```ts
export type UpdateZustand =
  | { version: string; art: 'unbekannt' | 'prueft' | 'aktuell' }
  | { version: string; art: 'verfuegbar'; neue: string; groesse: number | null }
  | { version: string; art: 'verfuegbar_manuell'; neue: string; groesse: number | null }
  | { version: string; art: 'laedt'; prozent: number; geladen: number; gesamt: number; tempo: number }
  | { version: string; art: 'bereit'; neue: string }
  | { version: string; art: 'fehler'; text: string }
  | { version: string; art: 'nicht_moeglich'; grund: 'entwicklung' | 'kein-appimage' }
```

- [ ] **Step 2: `main.js` reicht `hole`/`openExternal`/URLs durch**

In `main.js` (der `erstellen`-Aufruf, ~Zeile 136):

```js
const { autoUpdater } = require('electron-updater')
const { shell } = require('electron')
const paket = require('../package.json')
const urls = updater.macUrls(paket)
autoUpdater.logger = null
aktualisierer = updater.erstellen({
  autoUpdater,
  version: app.getVersion(),
  plattform: process.platform,
  gepackt: app.isPackaged,
  appimage: !!process.env.APPIMAGE,
  hole: fetch,                                   // Node-20-globales fetch
  openExternal: shell.openExternal,
  feedUrl: urls && urls.feed,
  releaseUrl: urls && urls.release,
  aendert: z => { /* wie bisher */ },
})
```

(Falls `macUrls` `null` liefert — Publish nicht github — fällt Mac auf `fehler` beim ersten `pruefen`; akzeptabel, denn ohne Publish gibt es ohnehin keinen Feed.)

- [ ] **Step 3: Typecheck + Electron-Tests**

`cd webtool/frontend && npx tsc -b` (clean, aber `SettingsPage` nutzt ggf. `upd.grund==='darwin'` noch — das wird in Task 3 entfernt; falls tsc hier scheitert, Task 3 zuerst oder gemeinsam). `node --test electron/updater.test.js` → grün.

- [ ] **Step 4: Commit**

`git add electron/main.js webtool/frontend/src/lib/types.ts && git commit -m "feat(updater): reicht hole/openExternal/URLs durch; verfuegbar_manuell-Typ"`

---

### Task 3: Frontend — StatusBar + SettingsPage

**Files:** Modify `webtool/frontend/src/components/StatusBar.tsx`, `webtool/frontend/src/pages/SettingsPage.tsx` + dessen Test.

- [ ] **Step 1: StatusBar `updateHinweis` erweitern**

In `StatusBar.tsx`:

```ts
if (z.art === 'verfuegbar' || z.art === 'verfuegbar_manuell') return `Update ${z.neue} verfügbar`
```

(dieselbe Zeile für beide — nur der SettingsPage-Zweig unterscheidet sich).

- [ ] **Step 2: SettingsPage — `verfuegbar_manuell`-Zweig + `darwin`-Text raus**

`GRUENDE` um den `darwin`-Eintrag kürzen. Den `nicht_moeglich`-Block belassen (für `entwicklung`/`kein-appimage`). Einen neuen Zweig neben dem bestehenden `verfuegbar`-Block einfügen:

```tsx
{upd.art === 'verfuegbar_manuell' && (
  <p className="mt-2">
    Update {upd.neue} verfügbar.{' '}
    {upd.groesse != null && `(${mb(upd.groesse)} MB) `}
    Auf macOS ist Auto-Update ohne Notarisierung nicht möglich.{' '}
    <a className="underline underline-offset-2 hover:text-foreground" href={RELEASES} target="_blank" rel="noreferrer">
      Manuell herunterladen
    </a>
  </p>
)}
```

- [ ] **Step 3: Frontend-Tests**

`SettingsPage.test.tsx` (falls dort `nicht_moeglich/darwin`-Fall getestet ist — ggf. entfernen/umstellen) + ein neuer Test: Zustand `verfuegbar_manuell` rendert den „Manuell herunterladen"-Link (nicht den „Herunterladen"-Knopf aus dem `verfuegbar`-Zweig).

- [ ] **Step 4: Run + Typecheck + Lint**

`cd webtool/frontend && npx vitest run && npx tsc -b && npx oxlint` → alles grün.

- [ ] **Step 5: Commit**

`git add webtool/frontend/src/components/StatusBar.tsx webtool/frontend/src/pages/SettingsPage.tsx webtool/frontend/src/pages/SettingsPage.test.tsx && git commit -m "feat(settings): Mac zeigt Manuelldownload-Hinweis statt „nicht möglich" (\`verfuegbar_manuell\`)"`

---

### Task 4: CLAUDE.md-Notiz (lokal)

**Files:** Modify `CLAUDE.md` (gitignored, lokal).

- [ ] **Step 1: Mac-Update-Absatz anpassen**

Im macOS-Signatur-Absatz: „Auto-Update bleibt auf macOS tot (Squirrel.Mac will echte Signatur) — **aber die App prüft jetzt manuell**: ein HTTP-Vergleich gegen `latest-mac.yml` (eigener Pfad in `updater.js`, `verfuegbar_manuell`) zeigt in Fußzeile + Einstellungen einen Manuelldownload-Hinweis. `laden()` öffnet die Release-Seite via `shell.openExternal`, `installieren()` ist No-Op. URL aus `build.publish` abgeleitet; `hole`/`openExternal` in `erstellen` hereingereicht → ohne Mac-Hardware testbar."

---

## Self-Review

1. **Spec-Abdeckung:** `nichtMoeglich` darwin raus (T1) · Mac-Automat mit HTTP-Check (T1) · `verfuegbar_manuell`-Typ (T2) · main.js-Wiring (T2) · StatusBar + SettingsPage + Link (T3) · Tests ohne Mac-Hardware (T1 Step 4, T3 Step 3) · Linux-deb bewusst unangetastet (Global Constraint) ✓.
2. **Placeholder-Scan:** keine TBD; Test- und Impl-Code ausformuliert. ✓
3. **Typkonsistenz:** `verfuegbar_manuell` in `types.ts` (T2) definiert, in `updater.js` gesetzt (T1) und in StatusBar/SettingsPage gelesen (T3). `macUrls`/`istNeuer`/`parseLatestMac` in T1 deklariert, in `main.js` (T2) bzw. `erstellen` genutzt. ✓
4. **Kritischer Order-Hinweis:** T2 Step 1 (darwin aus Typ streichen) und T3 Step 2 (darwin-Text entfernen) MÜSSEN zusammen — sonst ergibt tsc/Render einen Fehler. Im Zweifel T2+T3 in einem Commit.

## Risiko-Notiz für den Review

1. Stellt der Mac-Zweig die Win/Linux-Pfade ein? (frühes `return` nur für `darwin && gepackt`).
2. Bleibt `sollPruefen` korrekt (`verfuegbar_manuell` ausgeschlossen)?
3. Ist die URL echt aus `build.publish` (nicht hartkodiert)? `macUrls`-Test sichert es.
4. Crash-Freiheit bei kaputter YAML / Offline / Fetch-Fehler? (T1 Step 4 Tests).
5. Frontend-Zweig verwechselt `verfuegbar` (Auto-Knopf) nicht mit `verfuegbar_manuell` (Link)? (T3 Step 3 Test).
6. **Mac ungeprüft** (keine Hardware): der Check + Parse sind plattformunabhängig getestet; das `shell.openExternal`-Verhalten am echten Mac bleibt Sichtprüfung (Issue #36).
