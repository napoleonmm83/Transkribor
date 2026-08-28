# Sonde: welches Navigations-Ereignis feuert wann — und wo läuft der Preload? (#434)

**Warum es diese Datei gibt.** Der `will-navigate`/`will-redirect`-Wächter in `electron/main.js`
steht auf sechs Aussagen über Electrons Verhalten, die man dem Code nicht ansieht. Ohne eine
abgelegte Messung wären es Behauptungen — und die Kommentare dort verweisen auf diese Datei
statt Zahlen ohne Herkunft zu tragen.

Gemessen am **2026-08-28**, Electron **43.4.1**, Windows 11, `node_modules/.bin/electron`.

## Aufbau

Zwei Wegwerf-Sonden, beide nach dem Muster der #426-Messung. Kein Netzzugriff nach draussen:
zwei lokale HTTP-Server auf verschiedenen Ports (`server.listen(0, '127.0.0.1')`) sind die zwei
Herkünfte, im Folgenden `{EIGEN}` und `{FREMD}`. `shell.openExternal` wird in keiner Sonde
gerufen — sie protokollieren nur, was der Wächter entschieden **hätte**.

Das Fenster trägt exakt die `webPreferences` des Produktionsfensters und den **echten**
`electron/preload.js`:

```js
new BrowserWindow({ show: false, webPreferences: { preload: PRELOAD, contextIsolation: true } })
```

**Sonde 1** (`navigation.js`) fährt je Fall: eigene Seite laden → Ereignisse
zurücksetzen → Fall im Renderer auslösen (`webContents.executeJavaScript`) → 900 ms warten →
`location.href` und `typeof window.transkribor` abfragen. Mit `--mit-waechter` hängt sie den
Wächter aus `fenster.js` davor und misst dieselben Fälle erneut.

**Sonde 2** (`unterrahmen.js`) beantwortet nur die Rahmenfrage: eine Seite mit einem
`<iframe>`, ein Pfad `/rahmenred`, der mit 302 auf `{FREMD}` umleitet, und derselbe Redirect
einmal im Hauptrahmen. Sie druckt zu jedem Ereignis `e.isMainFrame`.

**Die Sonden liegen daneben und sind lauffähig** — aus dem Repo-Stamm, ohne Vorbereitung:

```
./node_modules/.bin/electron docs/superpowers/specs/2026-08-28-will-navigate-sonde/navigation.js
./node_modules/.bin/electron docs/superpowers/specs/2026-08-28-will-navigate-sonde/navigation.js --mit-waechter
./node_modules/.bin/electron docs/superpowers/specs/2026-08-28-will-navigate-sonde/unterrahmen.js
node docs/superpowers/specs/2026-08-28-will-navigate-sonde/mutationsprobe.js
```

| Datei | was sie tut |
|---|---|
| `2026-08-28-will-navigate-sonde/navigation.js` | Sonde 1, alle Wege; `--mit-waechter` hängt den Fix davor |
| `2026-08-28-will-navigate-sonde/unterrahmen.js` | Sonde 2, iframe vs. Hauptrahmen, druckt `isMainFrame` |
| `2026-08-28-will-navigate-sonde/mutationsprobe.js` | die Mutationsserie (aus dem Repo-Stamm starten) |
| `2026-08-28-will-navigate-sonde/rohausgabe.txt` | die **ungekürzten** Ausgaben aller drei Läufe |

Die Pfade darin sind repo-relativ (`__dirname`), nicht auf diesen Rechner verdrahtet; die
Rohausgabe stammt aus einem Lauf **von genau diesen Dateien**. Die Zitate unten sind Auszüge
daraus.

## Ergebnis 1 — läuft der Preload auf einer zweiten Herkunft?

Das Issue leitete das aus Electrons Dokumentation her. Gemessen:

| Ort | `typeof window.transkribor` | Schlüssel |
|---|---|---|
| `setup.html` (eigen, `file:`) | `object` | 12 |
| Loopback-Server (eigen, `http:`) | `object` | 12 |
| **fremde Herkunft nach Navigation** | **`object`** | **12** |
| **iframe auf fremde Herkunft** | **`undefined`** | **0** |

Die 12 sind die vollständige Brücke: `status`, `einrichten`, `abbrechen`, `logs`,
`protokollOeffnen`, `fehlerbericht`, `projekteOeffnen`, `update`, `on`, `plattform`,
`titelleisteFarbe`, `fortschritt`. Anders als bei #426 (ein einzelner
`shell.openExternal`-Aufruf) ist das **dauerhafter** Zugriff.

Die iframe-Zeile ist der Grund, warum `will-frame-navigate` **nicht** registriert wird: der
einzige Fall, den es allein abdeckt, bekommt den Preload gar nicht.

## Ergebnis 2 — welches Ereignis feuert wann (Ist-Zustand, ohne Wächter)

| Weg | `will-navigate` | `will-frame-navigate` | `will-redirect` | gelandet |
|---|---|---|---|---|
| `location.href = {FREMD}` | JA (fremd) | JA | – | **FREMD** |
| Link ohne `target`, geklickt | JA (fremd) | JA | – | **FREMD** |
| `<form method=get>` | JA (fremd) | JA | – | **FREMD** |
| `<form method=post>` | JA (fremd) | JA | – | **FREMD** |
| **302-Redirect eigen → fremd** | JA (**eigen**) | JA (eigen) | **JA (fremd)** | **FREMD** |
| `\0` vor der URL | JA (fremd, **kanonisiert**) | JA | – | **FREMD** |
| `location.reload()` | JA (eigen) | JA | – | eigen |
| eigene Herkunft, anderer Pfad | JA (eigen) | JA | – | eigen |
| `location.reload()` auf `setup.html` | JA (**`file:`**) | JA | – | eigen |
| `loadFile`/`loadURL` aus dem Hauptprozess | **KEINES** | KEINES | – | eigen |
| iframe auf fremde Herkunft | nein | JA | – | (im Rahmen) |

**Vier Entwurfsentscheidungen hängen an dieser Tabelle:**

1. **`will-navigate` allein deckt den Redirect-Weg nicht.** Es sieht dort die *eigene* URL, die
   der Wächter zu Recht durchlässt; die fremde kommt erst mit `will-redirect`. Genau der vierte
   der vier im Issue genannten Wege wäre sonst offen geblieben.
2. **Der Wächter kann sich nicht selbst aussperren** — programmatisches Laden feuert nichts.
3. **Der `file:`-Arm trägt trotzdem eine echte Bedienung:** `location.reload()` auf
   `setup.html` feuert mit der `file:`-URL, und „Ctrl+R lädt `setup.html` mitten im Lauf neu"
   ist in `electron/CLAUDE.md` als Nutzerweg dokumentiert.
4. **Die `\0`-Zeile widerlegt eine Behauptung im Bestand.** `fenster.js` sagte, der
   Rohform-Zweig von `externesZiel` werde „erreichbar beim ZWEITEN Aufrufer, und der ist mit
   dem `will-navigate`-Wächter aus #434 schon vorgeschlagen". Chromium kanonisiert vor
   **beiden** Ereignissen; die Bauform bleibt richtig, ihr Status wechselt von „bald gedeckt"
   zu „Vorsorge".

## Ergebnis 3 — Unterrahmen (Sonde 2, Rohausgabe)

```
── iframe navigiert auf einen Pfad, der 302 auf FREMD umleitet
  will-frame-navigate  isMainFrame=false     {EIGEN}/rahmenred
  will-redirect        isMainFrame=false     {FREMD}/aus-dem-iframe

── zum Vergleich: derselbe Redirect im HAUPTRAHMEN
  will-frame-navigate  isMainFrame=true      {EIGEN}/topred
  will-navigate        isMainFrame=true      {EIGEN}/topred
  will-redirect        isMainFrame=true      {FREMD}/aus-dem-hauptrahmen
```

**`will-navigate` ist hauptrahmen-only, `will-redirect` nicht.** Ohne
`if (e.isMainFrame === false) return` erreichte ein umleitendes iframe den Wächter und löste
`shell.openExternal` aus — ohne Skript, ohne Nutzergeste. Das ist eine Fähigkeit, die es vor
dem Fix nicht gab, und sie widersprach der eigenen Begründung für das Weglassen von
`will-frame-navigate`.

Aus derselben Zeile folgt die zweite Trennung: bei einer **Umleitung** wählt ein SERVER das
Ziel, nicht der Nutzer. Deshalb öffnet nur `will-navigate` den Browser (`extern`), während
`will-redirect` abweist und protokolliert. Heute nicht auslösbar — gemessen kommen
`RedirectResponse` und explizite 3xx in `webtool/` nicht vor, nur Starlettes
Schrägstrich-Umleitung auf dieselbe Herkunft —, aber eine Fähigkeit ohne Nutzer lässt man nicht
offen (dieselbe Begründung, mit der `mailto:` in `externesZiel` fehlt).

## Ergebnis 3b — wo die Angaben stehen (Vertrag, nicht Sonde)

`node_modules/electron/electron.d.ts:17606` (und `:17737` für `will-redirect`):

```ts
on(event: 'will-navigate', listener: (details: Event<WebContentsWillNavigateEventParams>,
                                      /** @deprecated */ url: string,
                                      /** @deprecated */ isInPlace: boolean, …
```

`WebContentsWillNavigateEventParams` (`:24400`) trägt `url`, `isSameDocument` und
`isMainFrame`; `WebContentsWillRedirectEventParams` (`:24429`) dieselbe Form. **Das erste
Argument ist das Details-Ereignis, nicht die URL** — `e.isMainFrame` liest also richtig, und
Ergebnis 3 wäre andernfalls gar nicht messbar gewesen. Die positionalen Parameter dahinter sind
ausdrücklich `@deprecated`, werden aber weiter übergeben; der Wächter nimmt deshalb
`e.url ?? urlVeraltet` — heute liefern beide dasselbe, aber nur eines ist der zugesagte Weg.

## Ergebnis 4 — Bilanz vorher/nachher (Sonde 1, beide Läufe)

```
Fall                                     will-navigate  gelandet(vorher)  gelandet(nachher)
(b1) location.href = FREMD               JA             FREMD             eigen
(b2) Link ohne target, geklickt          JA             FREMD             eigen
(b3) form action, GET                    JA             FREMD             eigen
(b4) form action, POST                   JA             FREMD             eigen
(b5) 302-Redirect EIGEN -> FREMD         JA             FREMD             eigen
(e)  Steuerzeichen vor der URL           JA             FREMD             eigen
(c)  location.reload() im Renderer       JA             eigen             eigen
(c)  eigene Herkunft, anderer Pfad       JA             eigen             eigen
(c2) Ctrl+R auf setup.html               JA             eigen             eigen
(d)  iframe auf fremde Herkunft          nein           (im Rahmen)       (im Rahmen)
```

Die letzten vier Zeilen sind die **Negativkontrolle**: hätte der Wächter zu breit gegriffen,
wären sie ebenfalls blockiert.

## Ergebnis 5 — Randfälle, die geschlossen ausfallen

Nicht in der Sonde, sondern direkt gegen `eigeneHerkunft` gemessen
(`node -e`, `EIGEN = ['file:///E:/Git/Transkribor/electron/setup.html', 'http://127.0.0.1:8000/']`):

| Eingabe | Ergebnis | warum |
|---|---|---|
| `http://127.0.0.1:0/` als eigene Herkunft | origin bleibt `http://127.0.0.1:0` | Port `0` kollabiert **nicht** auf 80 — vor dem Serverstart geht nur eine unerreichbare Adresse durch |
| `file://evil.example.com/E:/…/setup.html` | `false` | UNC auf fremden Rechner, gleicher Pfadteil — deshalb wird der **Host** mitverglichen |
| `file://localhost/E:/…/setup.html` | `true` | der Parser normalisiert `localhost` auf leeren Host |
| `blob:http://127.0.0.1:8000/abc` | `true` | Blob erbt die Herkunft des Erzeugers; **muss** durch, sonst brechen die Export-Downloads |
| `blob:https://example.org/abc` | `false` | fremde innere Herkunft |
| `blob:file:///E:/x` | `false` | innere Herkunft ist `'null'` |
| `data:`, `about:blank` | `false` | keine echte Herkunft |
| `http://127.0.0.1:8000@example.org/` | `false` | der Wirt ist `example.org`, nicht der Benutzername |
| `http://localhost:8000/` | `false` | die App lädt ausschliesslich `127.0.0.1` |

## Zählregel für die Testzahl

`node --test electron/*.test.js` zählt **alle** Tests aller `electron/*.test.js`-Dateien, nicht
nur die neuen. Die im PR genannten Zahlen sind die Zeile `# tests` dieses Laufs:
**168 vor** dem Fix (Stand `094de8d`), **183 danach**. Die Differenz von 15 sind 11 Tests aus
der ersten Fassung plus 4 aus den beiden Reviewrunden.

## Mutationsprobe

`2026-08-28-will-navigate-sonde/mutationsprobe.js` — je Mutation anwenden, Suite fahren, **Namen** der roten Tests
melden, zurückspielen. **18 Mutationen, 0 unbewacht** (Stand `rohausgabe.txt`; die Zahl waechst mit jeder Reviewrunde — massgeblich ist der Lauf, nicht diese Zeile). Zwei Fallen dabei, die allgemein gelten:

- **Die Dateien haben CRLF.** Ein Anker mit `\n` findet nichts, und ohne die
  Anker-Eindeutigkeitsprüfung im Läufer wäre daraus ein grüner Lauf geworden, der „unbewacht"
  meldet, ohne je etwas mutiert zu haben.
- **Zwei Sicherungszeilen können sich gegenseitig decken.** Der `file:`-Zweig und der
  `'null'`-Wächter fangen dieselbe URL; jede Mutation **einzeln** liess den Test
  *„`file:` hat KEINE Herkunft"* grün. Erst ohne **beide** gilt `calc.exe` als `setup.html`.
- **Ein ausdrücklich übergebenes `undefined` löst den Vorgabewert eines Parameters aus.** Der
  Test für „das Feld `isMainFrame` fehlt ganz" bekam damit `true` und mass den Fall nie —
  aufgefallen erst an der Mutation `=== false` → `!`, die grün blieb. Testhilfen für solche
  Fälle nehmen ein **Objekt**, keinen Parameter mit Vorgabewert.
