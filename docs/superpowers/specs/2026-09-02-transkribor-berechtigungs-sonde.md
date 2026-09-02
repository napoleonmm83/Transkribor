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
  und brauchte eine eigene Messung — sie steht unten als Messung 4.
- Sie lief nicht im **gepackten** Lauf.

## Messung 4 — der Check-Handler (#518)

Eigene Sonde, weil der Check-Handler eine andere Signatur und eine andere Berechtigungsmenge
hat: `docs/superpowers/specs/2026-09-02-berechtigungs-check-sonde/check.js` — ein **eigener
Electron-Hauptprozess** nach dem Muster von `2026-08-28-will-navigate-sonde/navigation.js`,
mit eigenem `userData` (sonst hält die installierte `Transkribor.exe` den Ordner und die Sonde
schreibt ins echte Protokoll), demselben `preload.js`/`contextIsolation` wie `fenster()` und
einem Check-Handler, der **protokolliert statt abzulehnen**. Drei Herkünfte nacheinander:
`file:` (`setup.html`), ein lokaler HTTP-Server als Statthalter für `backend.url()` und ein
zweiter als fremde Herkunft. Rohausgaben: `rohausgabe.txt` (ohne Wächter),
`rohausgabe-waechter.txt` (mit).

### Was auflief

**111 Prüfungen gegen 18 Anfragen** — der Check-Handler trägt die sechsfache Last. Je Art:

```
 24 media                  6 storage-access          6 clipboard-sanitized-write
 18 notifications          6 screen-wake-lock         6 clipboard-read
  9 geolocation            6 persistent-storage       3 web-app-installation
  6 window-management      6 midi                     3 speaker-selection
  6 local-fonts            6 idle-detection
```

Beim **Request**-Handler dagegen nur fünf Arten: `clipboard-read`,
`clipboard-sanitized-write`, `geolocation`, `media`, `notifications`.

### Drei Funde, die man nicht aus der Typdeklaration liest

**(1) `electron.d.ts` ist unvollständig.** Sie führt für den Check 19 Arten; **sechs der
gemessenen stehen dort nicht**: `web-app-installation`, `speaker-selection`,
`window-management`, `screen-wake-lock`, `local-fonts`, `persistent-storage`. Eine Weissliste
aus der Typdeklaration wäre eine Liste über einen Teil der Wirklichkeit. Weil der Handler
ablehnt, was nicht in der Weissliste steht, ist die Richtung trotzdem richtig — aber wer aus
der Union eine *Verbotsliste* bauen wollte, hätte sechs Lücken.

**(2) Vier Prüfungen laufen vor jeder Seiteninteraktion auf, mit LEERER Herkunft:**

```
CHECK media                :: herkunft= :: requestingUrl= :: isMainFrame=true
CHECK media                :: herkunft= :: requestingUrl= :: isMainFrame=true
CHECK web-app-installation :: herkunft= :: requestingUrl= :: isMainFrame=true
CHECK geolocation          :: herkunft= :: requestingUrl= :: isMainFrame=true
```

`eigeneHerkunft('')` wirft darauf nicht, sondern liefert `false` — abgelehnt, richtige
Fehlerrichtung (#266).

**Und sie kommen ein zweites Mal, mit der Seiten-URL.** Der gegnerische Prüfer hat den
Handler wortgleich in eine Sonde gehängt, die den Ablauf der App nachfährt (`setup.html`,
dann die gebaute Oberfläche): dieselbe Dreiergruppe läuft **je geladenem Dokument** noch
einmal auf, diesmal mit `requestingUrl` = Seiten-URL, also als **eigene** Herkunft. Nach
einem App-Start stehen deshalb vier Zeilen im Protokoll — `media`,
`web-app-installation`, `geolocation`, `background-sync` —, nicht null. Was das Schweigen
beim Startdokument spart, ist das falsche Etikett, nicht die Zeile.

**(3) Bei `file:` ist die Herkunft `file:///` — ohne Pfad.**

```
CHECK notifications :: herkunft=file:/// :: requestingUrl=file:///E:/…/electron/setup.html
```

Der dritte Parameter kann die Statusseite also von *jeder* anderen lokalen Datei nicht
unterscheiden; `requestingUrl` im vierten trägt den vollen Pfad. **Entschieden wird deshalb an
`requestingUrl`**, genau wie beim Request-Handler; die Herkunft liefert nur den Namen fürs
Protokoll, wenn `requestingUrl` fehlt (die Typdeklaration nennt dafür den Unterrahmen fremder
Herkunft).

### Was die App braucht — und was ein Deny-all gekostet hätte

`notifications` und `clipboard-sanitized-write`, **dieselben zwei wie beim Request-Handler**.
Der Grund ist beim ersten schärfer als erwartet: schon das blosse **Lesen** von
`Notification.permission` läuft durch diesen Handler, und `useOsFortschritt.ts:30` liest es vor
jeder Fertigmeldung. Ein Deny-all hätte die Fertigmeldung abgeschaltet, **ohne dass der
Request-Handler je gefragt worden wäre**.

### Vorher / nachher (`--mit-waechter`), eigene Herkunft

| | ohne Wächter | mit Wächter |
|---|---|---|
| `Notification.permission` | granted | **granted** |
| `new Notification` | OK | **OK** |
| `clipboard.writeText` | OK | **OK** |
| `permissions.query notifications` | granted | **granted** |
| `permissions.query clipboard-write` | granted | **granted** |
| `permissions.query camera` | granted | **denied** |
| `permissions.query geolocation` | granted | **denied** |

Kopierknopf und OS-Fertigmeldung sind damit nachweislich weiter benutzbar, und die Auskunft an
die Seite deckt sich jetzt mit der Entscheidung, die der Request-Handler fällen würde.

**Der Wächter der Sonde entscheidet dabei zeichengleich wie der in `main.js`** — dieselbe
Weissliste, dieselbe Herkunftsprüfung an `requestingUrl`, kein Rückfall auf die Herkunft. Die
erste Fassung hatte einen solchen Rückfall; auf den aufgezeichneten Eingaben fiel beides gleich
aus, aber eine Sonde, die einen anderen Wächter misst als den ausgelieferten, belegt die
falsche Sache (Befund des kalten Lesers). Die Tabelle oben ist mit der angeglichenen Fassung
gefahren.

**110 Prüfungen in einem einzigen Sondenlauf, davon 94 Abweisungen** (16 erlaubt) — deshalb
meldet der Handler in `main.js` nur den **ersten** Fall je Art und Seite. Ungebremst wäre der
gemeinsame Abweisungs-Deckel (#426) nach Sekunden voll, und der entscheidet, was von einem
Fehlerbericht übrig bleibt (#506). (Hier stand zuerst „110 Abweisungen"; die Zahl war die der
Prüfungen. Nachgezählt vom gegnerischen Prüfer an derselben Rohausgabe.)

### Messung 5 — die echte Oberfläche steuert eine 15. Art bei

Der gegnerische Prüfer hat die Grenze „geht hier nicht" widerlegt, die unten stand: die
**gebaute** Oberfläche (`webtool/static`) lässt sich mit einem gewöhnlichen node-HTTP-Server
ausliefern — SPA-Rückfall, `/api/*` auf 404 —, ganz ohne venv und torch. `AppShell.tsx` lädt
dann echt, und damit auch `useOsFortschritt`.

Dabei kam eine Art auf, die in **keiner** der beiden Rohausgaben oben vorkommt:
**`background-sync`** — ausgelöst von einem gewöhnlichen `fetch()` (Variantensonde: eine Seite
nur mit `fetch` ja; leere Seite, nur `localStorage`, nur `<script>`, nur `<input type=file>`
nein), und sie erscheint **ausschliesslich** beim Check-Handler. Sie steht damit auch nicht in
den 19 Arten der Typdeklaration.

**Nichts bricht daran** (ebenfalls gemessen): `<audio>.play()`, `decodeAudioData`,
`localStorage`, ein `blob:`-Download und `Notification.permission === 'granted'` laufen bei
abgelehntem `media` und `background-sync` unverändert. Im Frontend gibt es keine weiteren
Auslöser — kein Fullscreen, kein Wake-Lock, kein `navigator.storage`, kein
`permissions.query`, kein Service Worker, kein Manifest, kein `<iframe>`.

### Was auch diese Sonde NICHT sagt

- Sie lief auf `setup.html` und zwei lokalen HTTP-Servern, **nicht** im **gepackten** Lauf —
  dieselbe Grenze wie bei den Messungen 1–3. Die React-Oberfläche war bis Messung 5 ebenfalls
  aussen vor; die dortige Begründung („die venv dieses Klons hat kein torch") galt für den
  Server, nicht für die Oberfläche, und ist damit widerlegt.
- Der Request-Handler der Sonde erlaubt **alles** (er protokolliert nur). Dass
  `clipboard.readText` im Wächterlauf durchging, sagt deshalb nichts über die echte App: dort
  lehnt der Request-Handler `clipboard-read` ab.
- Die elf nie gesehenen Arten (`fullscreen`, `hid`, `mediaKeySystem`, `midiSysex`,
  `openExternal`, `pointerLock`, `serial`, `top-level-storage-access`, `usb`,
  `deprecated-sync-clipboard-read`, `fileSystem`) sind ungemessen, nicht ausgeschlossen — sie
  fallen unter dieselbe Ablehnung wie alles andere ausserhalb der Weissliste.
