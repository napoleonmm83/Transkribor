# Berechtigungs-Sonde (#446) — Aufbau, Kommandos, Rohausgaben

Gemessen am **laufenden** Electron 43.4.1 auf Windows 11, nicht aus dem Code geschlossen.
Anlass: `electron/main.js` behauptet an drei Stellen ein „gemessen"; dieses Dokument ist der
Beleg dazu. Gleiches Muster wie `2026-08-28-transkribor-will-navigate-sonde.md`.

## Aufbau

Electron mit CDP-Port starten, per WebSocket an die Seite hängen, die Berechtigungen im
**echten** Renderer abfragen und danach die Protokolldatei lesen.

```
npx electron . --remote-debugging-port=9222 --user-data-dir=<Wegwerf-Verzeichnis>
```

**Das eigene `--user-data-dir` ist Pflicht, nicht Bequemlichkeit.** Auf diesem Rechner läuft
die installierte `Transkribor.exe`. Windows-Dateinamen sind gross-/kleinschreibungsunabhängig,
`%APPDATA%\Transkribor` (gepackt) und `%APPDATA%\transkribor` (Entwicklung) sind also
**dasselbe Verzeichnis** — die Entwicklungsinstanz bekam `app.requestSingleInstanceLock()` nie
und starb mit Code 0, **ohne ein Fenster zu zeigen**:

```
DevTools listening on ws://127.0.0.1:9222/devtools/browser/<Sitzungskennung>
[exited with code 0]
```

Nebeneffekt derselben Massnahme: die Sonde schreibt nicht in das echte Protokoll des Nutzers.

Die Abfragen laufen mit `Runtime.evaluate`, `awaitPromise: true`, `userGesture: true`. Die
Seite war `file:///…/electron/setup.html` — die React-Oberfläche startet in diesem Klon nicht,
weil seine venv kein torch hat und `setup.status()` die Umgebung deshalb als unfertig meldet.
**Das ist die Grenze dieser Messung** und sie gehört dazu.

## Messung 1 — welche Berechtigungen erreichen den Handler?

Weissliste zu diesem Zeitpunkt: nur `notifications`.

```
Notification.permission (vor) -> granted
requestPermission()           -> granted
Notification.permission (nach)-> granted
getUserMedia(audio)           -> abgelehnt: NotAllowedError
geolocation                   -> abgelehnt: 1
clipboard.writeText           -> FEHLER: NotAllowedError
```

```
[…] Berechtigung abgewiesen (nicht in der Weissliste): media
[…] Berechtigung abgewiesen (nicht in der Weissliste): geolocation
[…] Berechtigung abgewiesen (nicht in der Weissliste): clipboard-sanitized-write
```

**Der Fund:** `clipboard-sanitized-write` läuft durch den **Request**-Handler. Der Plan hatte
es beim *Check*-Handler vermutet und daraus abgeleitet, ein Deny-all sei ungefährlich — mit
dieser Fassung wäre der Knopf „Lizenzschlüssel kopieren" (`SettingsPage.tsx`) still
ausgefallen. Nach Aufnahme in die Weissliste:

```
clipboard.writeText -> OK
[…] Berechtigung abgewiesen (nicht in der Weissliste): media
[…] Berechtigung abgewiesen (nicht in der Weissliste): geolocation
```

## Messung 2 — was steht im vierten Parameter?

`main.js` wurde dafür **vorübergehend** instrumentiert (eine Zeile im Handler, danach
zurückgeschrieben; `git diff` war anschliessend leer):

```
SONDE notifications             :: keys=isMainFrame|requestingUrl :: requestingUrl=file:///E:/…/setup.html :: isMainFrame=true
SONDE clipboard-sanitized-write :: keys=isMainFrame|requestingUrl :: requestingUrl=file:///E:/…/setup.html :: isMainFrame=true
SONDE media                     :: keys=isMainFrame|mediaTypes|requestingUrl|securityOrigin :: requestingUrl=file:///E:/…/setup.html :: isMainFrame=true
```

`requestingUrl` kam bei **allen drei gemessenen** Anfragearten an — `notifications`,
`clipboard-sanitized-write` und `media`. Damit ist die Herkunftsprüfung im Handler für diese
drei gedeckt statt geraten.

**Für andere Berechtigungsarten sagt diese Sonde nichts.** Electrons Typdeklaration führt für
den Request-Handler rund zwanzig; gemessen sind drei. Der Handler ist auf diesen Fall
vorbereitet — fehlt `requestingUrl`, wirft `eigeneHerkunft` nicht, sondern liefert `false`, und
die Anfrage wird abgelehnt. Das ist die richtige Fehlerrichtung (#266), aber es ist eine
Annahme über den ungemessenen Rest, keine Messung.

## Messung 3 — ein Wurf im Handler lehnt still ALLES ab

Der erste Anlauf von Messung 2 schrieb `JSON.stringify(details)` ins Protokoll. Ergebnis:

```
notifications  -> granted
clipboard      -> NotAllowedError      (vorher und nachher: OK)
media          -> NotAllowedError
--- was der Handler als `details` sah ---
  keine SONDE-Zeile im Protokoll
```

**Keine einzige Zeile** — weder die Sondenzeile noch eine Abweisungszeile. Die Serialisierung
warf, die Ausnahme riss den Handler mit, und Chromium lehnte daraufhin jede Anfrage ab. Für
den Leser sieht das aus wie eine bewusste Entscheidung; im Protokoll steht nichts.

**Die Regel daraus:** im Berechtigungs-Handler darf nichts werfen können. `eigeneHerkunft`
fängt sein `new URL` selbst ab, `Set.prototype.has` kann nicht werfen — beides absichtlich.

## Was diese Sonde NICHT sagt

- Sie lief auf `setup.html` (`file:`), nicht auf der React-Oberfläche. Ob dort andere oder
  weitere Berechtigungen anfallen, ist offen — im Quelltext kommen nur
  `Notification.requestPermission` (`useOsFortschritt.ts`) und `navigator.clipboard.writeText`
  (`SettingsPage.tsx`) vor.
- Sie sagt nichts über den **Check**-Handler (#518); der hat eine eigene Berechtigungsmenge
  und braucht eine eigene Messung.
- Sie lief nicht im **gepackten** Lauf.
