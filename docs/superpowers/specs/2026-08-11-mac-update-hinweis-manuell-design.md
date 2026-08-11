# Mac-Update-Hinweis (manuell)

**Stand:** 2026-08-11, master `89b5478` (v0.17.0). Issue folgt.

## Problem

Auf macOS ist das Auto-Update tot: Squirrel.Mac verlangt eine echte Signatur, die dmg ist nur
ad-hoc signiert (CLAUDE.md, „Preis der ad-hoc-Lösung"). Daraufhin deaktiviert `nichtMoeglich()`
den Update-Automaten auf Mac *komplett* — es wird nicht einmal geprüft. Der Nutzer sieht in den
Einstellungen einen statischen Text („Auf macOS nicht möglich …") und einen Link „Versionen
ansehen", muss also selbst nachsehen. Eine **aktive Benachrichtigung** bei neuer Version gibt es
nicht. Notarisierung ist nicht in Planung — der Squirrel.Mac-Weg also mittelfristig nicht
verlässlich.

## Lösung (Ansatz 1: eigener HTTP-Check, am Squirrel.Mac vorbei)

Mac bekommt einen **eigenen Prüf-Pfad**, der das Auto-Update nicht berührt (das fürs *Anwenden*
weiter deaktiviert bleibt). Ein HTTP-GET auf die veröffentlichte `latest-mac.yml`, `version:`
parsen, mit der laufenden Version vergleichen. Bei verfügbar → neuer Zustand `verfuegbar_manuell`,
der in Fußzeile und Einstellungen einen **manuellen** Download-Hinweis trägt (Link zur Release-
Seite, kein Auto-Download).

**Warum ein eigener Check und nicht `autoUpdater.checkForUpdates()`:** Mac ist ungeprüft (keine
Hardware, Issue #36). Ob `checkForUpdates` auf ad-hoc-signiertem Mac schon beim Check stolpert
(Squirrel.Mac/ShipIt), ist nicht reproduzierbar. Ein HTTP-GET funktioniert *garantiert* und ist
unabhängig von der Signatur-Infrastruktur — und da Check + Parse plattformunabhängig sind, lassen
sie sich **ohne Mac-Hardware testen**.

## Zustands-Automat (`electron/updater.js`)

- `nichtMoeglich()`: die `darwin`-Zeile **raus** (Mac kann jetzt prüfen — nur nicht anwenden).
  `entwicklung` und `kein-appimage` bleiben unangetastet.
- `erstellen()` zweigt neu anhand `plattform === 'darwin' && gepackt`:
  - **Mac** → baut den **manuellem Automaten** (keine autoUpdater-Listener):
    - `pruefen()`: `hole(latestMacUrl)` → `version:` parsen → `vergleiche(neue, app.getVersion())`.
      Neuer → `setzen({ art: 'verfuegbar_manuell', neue, groesse })`; gleich → `art: 'aktuell'`;
      Fetch- oder Parse-Fehler → `art: 'fehler', text`.
    - `laden()`: öffnet die Release-Seite im Browser via `shell.openExternal(releaseUrl)` —
      **kein** `autoUpdater.downloadUpdate` (würde scheitern).
    - `installieren()`: No-Op.
  - **Win/Linux** → unverändert (autoUpdater-basiert).
- Startzustand Mac: `{ version, art: 'unbekannt' }` (heute `nicht_moeglich/darwin`).
- `hole` und (für Tests) `shell.openExternal` werden **hereingereicht** — dasselbe Muster, das
  `erstellen` schon für `autoUpdater` vorgibt: der Automat läuft im Test ohne Electron.

### `UpdateZustand` (`webtool/frontend/src/lib/types.ts`)

Neue Zustandsart, gleiche Form wie `verfuegbar`:

```ts
| { version: string; art: 'verfuegbar_manuell'; neue: string; groesse: number | null }
```

Das `grund`-Literal `'darwin'` fällt am `nicht_moeglich`-Zweig weg (nicht mehr erzeugt):

```ts
| { version: string; art: 'nicht_moeglich'; grund: 'entwicklung' | 'kein-appimage' }
```

### Weißliste unverändert

`sollPruefen` (`ERNEUT_PRUEFEN = ['unbekannt', 'aktuell', 'fehler']`) bleibt, wie sie ist.
`verfuegbar_manuell` ist (wie `verfuegbar`) **ausgeschlossen**: einmal gefunden, sucht der 6-h-
Zeitgeber nicht neu — sonst überschreibt der Tick genau die Fußzeile, in der das Update steht.
`fehler` bleibt erlaubt (Netzaussetzer ist kein Dauerzustand).

## Feed-URL + Parse

- **URL** aus `build.publish[0]` in `package.json` abgeleitet (`require('../package.json')`):
  `https://github.com/{owner}/{repo}/releases/latest/download/latest-mac.yml`. Eine Wahrheits-
  quelle, nicht hartkodiert. GitHub leitet `/releases/latest` auf das jüngste **Nicht-Prerelease**
  weiter — funktioniert, weil `modelle-v1` als Prerelease markiert ist (CLAUDE.md), so dass die
  App-Release „Latest" bleibt.
- **Parse:** `version:` als erste Zeile via einfachem Regex/Split (kein YAML-Dependency). `groesse`
  aus der `size:`-Zeile (Bytes) falls vorhanden, sonst `null` — dieselbe „unbekannt statt 0 MB"-
  Regel wie bei `verfuegbar`. Kaputte YAML → `fehler`, kein Crash.
- **Vergleich:** `vergleiche(a, b)` — semver à la `split('.')`, numerisch; reicht für `0.x.y`.
  Gleichstand → `aktuell` (kein „verfügbar" bei identischer Version).

## Frontend

- **`StatusBar.tsx` (`updateHinweis`):** `verfuegbar_manuell` → ``Update ${neue} verfügbar``
  (dieselbe Zeile wie `verfuegbar`). Schon beim ersten Check sichtbar — ohne Klick.
- **`SettingsPage.tsx`:**
  - Neuer Zweig für `art === 'verfuegbar_manuell'`: „Update {neue} verfügbar" + Hinweis „Auf
    macOS ist Auto-Update ohne Notarisierung nicht möglich" + Link „Manuell herunterladen"
    (→ `{releaseUrl}`, öffnet im Browser). Die `groesse` zeigt die MB falls bekannt.
  - Der `nicht_moeglich`-Block verliert den `darwin`-Eintrag (Text „Auf macOS nicht möglich …"
    fällt weg — Mac zeigt jetzt den echten Stand). `GRUENDE['darwin']` wird entfernt.
  - Der „Nach Updates suchen"-Knopf funktioniert auf Mac (löst `pruefen` → HTTP-Check aus).
- `releaseUrl` = `https://github.com/{owner}/{repo}/releases/latest` (die Seite, nicht der
  direkte .dmg-Download — Nutzer sieht Versionshinweise). Owner/Repo analog Feed-URL aus
  `package.json` (oder ein gemeinsamer Helfer).

## Tests (ohne Mac-Hardware)

Genau der Punkt von Ansatz 1: `updater.js` ist schon Electron-frei (`autoUpdater`/`hole`/
`shell.openExternal` werden hereingereicht).

- **Mac-Automat (`erstellen` mit `darwin`+`gepackt`, Fake-`hole`):**
  - neuere `latest-mac.yml` → `verfuegbar_manuell` mit korrekter `neue`/`groesse`.
  - gleiche Version → `aktuell`.
  - `hole` lehnt ab → `fehler` (kein throw, kein Hängen).
  - kaputte YAML (keine `version:`-Zeile) → `fehler`.
  - `laden()` ruft `shell.openExternal` mit der Release-URL (nicht `downloadUpdate`).
- **`vergleiche`:** `0.17.0 > 0.16.0`, gleich → `aktuell`, Build-Suffixe (z. B. `0.17.0-beta`)
  toleriert oder definiert ignoriert (in der Spec festlegen: nur `X.Y.Z`, sonst `fehler`).
- **Frontend:** StatusBar zeigt Hinweis für `verfuegbar_manuell`; SettingsPage zeigt den
  Manuelldownload-Link (nicht den Auto-Download-Knopf aus dem `verfuegbar`-Zweig).
- **`nichtMoeglich`:** liefert für `darwin` weiterhin `''`? **Nein** — Test sichert, dass Mac
  *nicht* mehr `nicht_moeglich` liefert (sonst käme nie ein Check zustande). `entwicklung` und
  `kein-appimage` weiter wie bisher.

## Randbedingungen

- **Offline:** der bestehende `net.isOnline()`-Riegel im 6-h-Zeitgeber greift unverändert; erst
  gar kein Fetch, kein „Prüfung fehlgeschlagen"-Flackern.
- **`fetch`/`openExternal` im Main-Prozess:** Node 20 / Electron haben globales `fetch`;
  `shell.openExternal` aus `electron`. Beide für den Test injectbar.
- **Rate-Limiting:** GitHub liefert Release-Assets unauthentifiziert (privates Repo würde Token
  brauchen — CLAUDE.md nennt das als offenen Punkt für private Repos; das Repo ist derzeit
  öffentlich, Assets sowieso). Ein GET alle 6 h ist vernachlässigbar.
- **macOS-Auto-Update bleibt tot:** der `main.js`-Kommentar dazu bleibt korrekt; nur dass Mac
  jetzt *dennoch* benachrichtigt. ggf. Kommentar nachziehen („prüft manuell, wendet nicht an").

## Bewusste Nicht-Entscheidungen

- **Linux-`deb`** (anderer `nicht_moeglich`-Fall, `kein-appimage`) bleibt unverändert — keine
  manuelle Prüfung. Ließe sich später analog nachziehen (derselbe HTTP-Pfad, nur `latest-linux.yml`
  und ein `deb`-Hinweis). Nicht beauftragt.
- **Direkter .dmg-Download** als Link-Ziel bewusst **nicht** (Release-Seite gibt Kontext/
  Versionshinweise; ein Klick mehr, dafür klarer).
- Keine Notarisierung, keine echte Signatur in diesem Issue — der manuelle Pfad ist die
  dauerhafte Lösung, kein Übergang.

## Review-Hinweis

Vor dem Review die Angriffspunkte aufschreiben (CLAUDE.md-Disziplin):
1. Kann der Mac-Check die Win/Linux-Pfade verstellen? (Zweig sauber an `darwin`+`gepackt`.)
2. Bleibt `sollPruefen` korrekt (kein Neu-Suchen bei `verfuegbar_manuell`)?
3. Ist die URL echt aus `build.publish` abgeleitet (nicht hartkodiert, nicht kaputt bei
   Repository-Umzug im Spec-Text)?
4. Crash-Freiheit bei kaputter `latest-mac.yml` und bei Offline (echt getestet, nicht behauptet)?
5. Frontend-Zweig verwechselt `verfuegbar` (Auto-Knopf) nicht mit `verfuegbar_manuell` (Link)?
