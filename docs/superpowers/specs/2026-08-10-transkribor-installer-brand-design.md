# Installer und Ersteinrichtung im Brand-Design (Design)

Stand 2026-08-10, nach `v0.7.0`. Betrifft die vier Flächen, die ein Nutzer sieht, **bevor** die
App das erste Mal läuft: das App-Icon, den Windows-Assistenten, das DMG-Fenster und das
Ersteinrichtungs-Fenster.

## Warum

Ausgangsfrage war „kann man den Installer im Brand-Design machen". Beim Nachsehen stand am
Anfang ein grösserer Befund: **es gibt gar kein App-Icon.** `build/` enthält nur den
DMG-Hintergrund, und in `package.json` steht weder `win.icon` noch `mac.icon`. electron-builder
sucht in der Reihenfolge *explizite Angabe → `icon.<format>` → `icon.png` → `icon.svg` →
`icons/`*, findet nichts und nimmt das **Electron-Standardlogo**.

Das steht damit im Startmenü, in der Taskleiste, im Dock — und mitten im sorgfältig gebauten
DMG-Fenster, dessen Pfeil auf genau diese Stelle zeigt.

Der zweite Befund verschiebt die Gewichtung: Die Fläche mit der längsten Verweildauer ist nicht
der Installer, sondern die **Ersteinrichtung**. `electron/main.js` öffnet ihr Fenster bewusst
vor der Prüfung, mit der Begründung „die Ersteinrichtung dauert Minuten; wer auf nichts schaut,
hält die App für kaputt" — laut `setup.html` sind es „mehrere GB, je nach Leitung 10–30
Minuten". Der NSIS-Assistent ist in etwa fünfzehn Sekunden durch.

## Befund je Fläche

| Fläche | Stand vor dieser Arbeit |
|---|---|
| App-Icon | fehlt → Electron-Standardlogo |
| Windows NSIS | Standardgrau. `oneClick:false`, also ein echter Assistent — aber **ohne Willkommensseite**: MUI2 fügt sie nicht von selbst hinzu |
| macOS DMG | gebrandet, aber in **Segoe UI** (einer Windows-Schrift) und mit Akzent `#c2410c` |
| `electron/setup.html` | eigenes Dunkel-only-Design, `system-ui`, Akzent `#7c9cff` — nicht das Indigo `#4F46E5` der App |

## Entscheidungen

### 1. Das Zeichen ist eine Sprechblase mit Tonspur

Aus vier Entwürfen gewählt (Welle-wird-Zeile, Sprechblase, Wortmarke „T", Redebeiträge), alle
aus dem bestehenden System: Indigo `#4F46E5`, geometrisch, schattenlos.

Ausschlaggebend war die **Silhouette bei 16 px**. Dort rendert Windows rund 256 Pixel gesamt;
jedes Element frisst mehrere Prozent der Fläche. Die Blase hat eine geschlossene Aussenform, die
das Auge erkennt, bevor es den Inhalt liest — die drei anderen Entwürfe zerfallen dort in
Striche. Der Preis ist bekannt und akzeptiert: Sprechblasen hat jede Chat-App, das Eigene steckt
nur in den Balken darin.

### 2. Das Zeichen lebt als PIL-Code, nicht als SVG

Es besteht aus drei Grundformen: abgerundetes Quadrat, abgerundetes Rechteck plus Dreieck (die
Blase mit Fahne), vier abgerundete Balken. `ImageDraw.rounded_rectangle` und `polygon` bilden das
exakt ab.

Damit entfällt der SVG-Rasterizer — cairosvg zieht auf Windows Cairo nach — und es gibt **eine**
Quelle statt zweier, die auseinanderlaufen. Eine `zeichen.svg` daneben wäre ein zweiter
Wahrheitsstand ohne Verbraucher: die Weboberfläche führt heute kein Logo.

Gerendert wird mit dem Supersampling-Faktor `S`, den `hintergrund.py` bereits benutzt (PIL
zeichnet ohne Kantenglättung).

### 3. `build/hintergrund.py` geht in `build/marke.py` auf

Ein Modul kennt das Zeichen und schreibt alle abgeleiteten Dateien:

```
.venv\Scripts\python.exe build\marke.py
  → build/icon.png              1024×1024
  → build/installerSidebar.bmp   164×314   24-bit
  → build/installerHeader.bmp    150×57    24-bit
  → build/background.png         540×380
  → build/background@2x.png     1080×760
```

Die Ausgaben werden **committet** — dieselbe Begründung wie bisher: die CI-Runner haben weder PIL
noch die Schriften. Der vorhandene Abbruch bei überlaufender Textzeile bleibt erhalten.

`uninstallerSidebar` zeigt in `package.json` auf **dieselbe** `installerSidebar.bmp`. Ein
eigenes Bild für den Deinstallationsvorgang wäre eine Datei mehr für eine Fläche, die niemand
gestaltet sehen will.

**`marke.py` wird nur einmal angefasst:** PR 1 erzeugt und committet alle fünf Dateien, auch die
beiden BMP. PR 2 verdrahtet sie dann nur noch. Ein bis dahin unbenutztes Bild im Repo ist
harmloser als ein Renderer, der in zwei PRs wächst.

Für das App-Icon genügt `build/icon.png`: electron-builder findet es über die oben genannte
Suchreihenfolge und leitet `.ico`, `.icns` und die Linux-Grössen selbst ab. Ein Eintrag in
`package.json` ist dafür **nicht** nötig.

### 4. Die Schriften liegen zweimal — absichtlich

Zwei Verbraucher, zwei Formate:

- **`build/fonts/*.ttf`** (Space Grotesk + DM Sans, SIL OFL, ~200 KB): nur zur Renderzeit, liegt
  in `build/` und damit **nicht** im Installer. PIL kann `.woff2` nicht laden — genau deshalb
  rendert `hintergrund.py` heute in Segoe UI. Nebeneffekt: die fest verdrahteten
  `C:/Windows/Fonts/…`-Pfade fallen weg, das Skript läuft nicht mehr nur auf Windows.
- **`electron/fonts/*.woff2`** (59 KB): für `setup.html`, wird über `electron/**/*` mitgeliefert.

Ein `{from,to}`-Mapping in `build.files` statt der echten Kopie wäre kürzer, greift aber **nur im
gepackten Lauf**: in der Entwicklung fiele `setup.html` still auf `system-ui` zurück und der
Entwickler sähe etwas anderes als der Nutzer. Dieselbe Klasse Fehler wie der macOS-GUI-PATH in
CLAUDE.md, und der Grund, warum die Kopie die kleinere Lösung ist.

### 5. Die Willkommensseite ist der einzige nicht-kosmetische Teil

`build/installer.nsh` — von electron-builder am Standardpfad selbst gefunden, kein
`include`-Eintrag nötig:

```nsis
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Willkommen bei Transkribor"
  !define MUI_WELCOMEPAGE_TEXT "Dieser Assistent installiert Transkribor auf deinem Rechner. \
Das dauert etwa eine Minute.$\r$\n$\r$\nDanach passiert noch etwas: Beim ersten Start lädt \
Transkribor die Spracherkennung herunter — mehrere Gigabyte, je nach Leitung 10 bis 30 Minuten. \
Das ist einmalig. Danach läuft alles offline auf deinem Rechner, ohne Konto und ohne Cloud."
  !insertmacro MUI_PAGE_WELCOME
!macroend
```

Der Text kündigt an, dass **nach** der Installation noch ein grosser Download kommt. Das ist die
Stelle, an der Leute die App für kaputt halten, und der Installer ist die letzte Fläche davor.
Erwartung ist billiger als jede Fortschrittsanzeige.

Der Schlusssatz („offline, ohne Konto und ohne Cloud") steht dort nicht als Werbung: er ist der
Grund, warum der Download so gross ist. Ohne ihn liest sich die Ankündigung nur als Zumutung.

Die Seite ist zugleich die Voraussetzung dafür, dass der 164×314-Streifen überhaupt Wirkung hat:
ohne sie erscheint er nur auf der Abschlussseite.

Nicht gebaut wird eine eigene `nsDialogs`-Seite. Das Dialog-Gehäuse von NSIS (Knöpfe, Schrift,
Fensterfarbe) ist Windows-nativ; es frei zu gestalten kostet echtes NSIS-Scripting für eine
Fläche von fünfzehn Sekunden.

### 6. Der DMG-Hinweis wird Indigo statt `#c2410c`

Das dreht eine dokumentierte Entscheidung um: der Kommentar in `hintergrund.py` nennt das
gedeckte Orange „Aufmerksamkeit, kein Alarm". Der Grund für die Umkehr ist die Regel aus dem
Designsystem — **Bernstein und Rot sind inhaltlich belegt**, sie markieren im Editor unsichere
Wörter, und keine neue Fläche darf in diesen Bereich laufen. Die Gatekeeper-Meldung ist ausserdem
ein Hinweis, kein Fehler. Der Verlust an Signalwirkung wird in Kauf genommen; die Karte behält
ihren farbigen Streifen und ihre Position.

### 7. Geprüft werden die committeten Dateien, nicht der Renderer

`build/test_bilder.py` liest die Kopfdaten mit `struct` aus der Standardbibliothek — **ohne PIL**:
BMP-DIB-Header (Breite, Höhe, Bittiefe) und PNG-IHDR (Breite, Höhe). Erwartet werden die fünf
Dateien in exakt den Massen aus Entscheidung 3, die beiden BMP mit **24 bit**.

Ein Test gegen den Renderer bräuchte PIL und liefe im CI-Python-Job nicht — der fährt bewusst
ohne schwere Abhängigkeiten und hat in seinem ersten Lauf sechs Tests gefunden, die sich
Werkzeuge vom Entwicklerrechner borgten. Der Header-Test prüft ausserdem das, was tatsächlich
ausgeliefert wird.

Das ist die Stelle, an der es sonst **still** bricht: eine 32-bit-BMP oder eine um einen Pixel
falsche Grösse nimmt NSIS wortlos hin und zeigt Müll.

Dazu in `electron/konfig.test.js`: die drei `nsis`-Bildpfade und `build/installer.nsh` müssen
existieren.

## Was sich ändert

**PR 1 — Zeichen, Icon, Ersteinrichtung**

- neu `build/marke.py` (ersetzt `build/hintergrund.py`), `build/fonts/*.ttf`
- neu `build/icon.png`, `build/installerSidebar.bmp`, `build/installerHeader.bmp`;
  `build/background.png` + `@2x` neu gerendert
- neu `build/test_bilder.py`
- neu `electron/fonts/*.woff2`
- geändert `electron/setup.html`: Zeichen im Kopf, Akzent `#7c9cff` → `#4F46E5` (dunkel `#818CF8`),
  `system-ui` → Space Grotesk (Überschriften) + DM Sans, Radius 8 px, **Hell- und Dunkelmodus**
  statt `color-scheme: dark`
- geändert `CLAUDE.md` (der Absatz über `build/hintergrund.py`)

**PR 2 — Windows-Assistent**

- neu `build/installer.nsh`
- geändert `package.json`: `installerSidebar`, `installerHeader`, `uninstallerSidebar`
  (letzteres auf dieselbe Datei)
- geändert `electron/konfig.test.js`

Das DMG-Bild entsteht schon in PR 1 — es hängt am Zeichen, nicht am Assistenten.

## Nicht-Ziele

- Keine eigene `nsDialogs`-Seite (siehe Entscheidung 5).
- Keine Signatur und keine Notarisierung. SmartScreen und Gatekeeper warnen weiterhin; das ist
  eine eigene Arbeit und hängt an einem Zertifikat, nicht an Gestaltung.
- Kein Logo für die Weboberfläche. Dort gibt es heute keines, und diese Arbeit erfindet keinen
  Verbraucher dafür.
- Keine Änderung am Ablauf der Ersteinrichtung — nur an ihrem Aussehen.

## Offen

- **Umlaute in `installer.nsh`.** NSIS liest `.nsh` im Unicode-Modus je nach BOM unterschiedlich;
  „Willkommen bei Transkribor" könnte als Mojibake ankommen. Das ist das Spiegelbild des
  PowerShell-Fundes in CLAUDE.md (`.ps1` *ohne* BOM wird als CP1252 gelesen). **Am gebauten
  Installer nachsehen, nicht annehmen.**
- **Das DMG-Fenster kann hier niemand anschauen** — kein Mac vorhanden. Prüfbar sind nur die
  Kopfdaten der Datei und ein durchlaufender Bau; der Blick darauf hängt an Issue #36.
- Ob der Streifen bei 164×314 die angedeutete Tonspur verträgt, entscheidet sich erst am
  gebauten Assistenten. Zur Not fällt sie weg.
