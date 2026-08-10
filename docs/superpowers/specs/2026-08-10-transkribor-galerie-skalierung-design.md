# Projekt-Galerie für hunderte Projekte (Design)

Stand 2026-08-10, nach `v0.8.0`. Betrifft die Startseite (`/`), den Endpunkt `GET /api/projects`
und die beiden Seiten, die sich denselben Hook teilen.

## Warum

Die Galerie ist für zehn Projekte entworfen: ein dreispaltiges Kartenraster, alphabetisch
sortiert, ohne Suche. Bei dreihundert Projekten bricht das an drei Stellen gleichzeitig — und
alle drei haben **dieselbe Ursache**: eine Datenform, die alles über alle liefert.

`GET /api/projects` läuft über jedes Projekt, listet jede Datei und macht je Datei drei
`os.path.exists`. `useProjects` ruft das alle vier Sekunden auf — und **drei Seiten** teilen sich
den Hook (Galerie, Arbeitsfläche, Editor). Zwei davon brauchen die Dateiliste wirklich, aber nur
die **eines** Projekts. `HomeGallery` benutzt vom ganzen Dateiblock genau zwei Zahlen:
`files.length` und wie viele `has_edit` haben.

## Messung

300 Attrappen-Projekte, 3 963 Aufnahmen, realistische Streuung (Median klein, Ausreisser mit 60
und 198 Dateien). Kein HTTP-Server, `TRANSKRIBOR_PROJEKTE` auf einen Wegwerf-Ordner,
`list_projects()` direkt aufgerufen, Minimum aus fünf Läufen, Dateisystem-Zugriffe durch
Umhüllen von `os.path.exists`/`listdir`/`scandir`/`stat` gezählt.

| | heute | nur Zusammenfassung | Faktor |
|---|---:|---:|---:|
| Dauer je Aufruf | 310,1 ms | 67,7 ms | 4,6× |
| Dateisystem-Zugriffe | 13 691 | 602 | 22,7× |
| JSON-Nutzlast | 393,9 KB | 33,2 KB | 11,9× |

Alle vier Sekunden sind das heute **3 423 Zugriffe/s und 98,5 KB/s** im Leerlauf. Gegenprobe:
beide Wege zählen dieselben 3 963 Aufnahmen.

**Der wichtigste Einzelbefund ist die Diskrepanz:** die Zugriffe fallen um 22,7×, die Zeit nur um
4,6×. Die Zeit steckt im Lesen der Verzeichnisse, nicht in der Zahl der Aufrufe — das muss auch
der schlanke Weg tun. Der Umbau lohnt also **wegen der Nutzlast**, nicht wegen der Serverzeit.

## Entscheidungen

### 1. `GET /api/projects` liefert eine Zusammenfassung

`{name, dateien, fertig, geaendert, active_jobs}` statt der vollen Dateiliste. Pro Projekt ein
`os.scandir` über `transkripte/` und eines über `audio/` statt 3N Einzelabfragen.

**`geaendert` ist das Maximum der Datei-mtimes, NICHT die mtime eines Ordners.** Gemessen, weil
die naheliegende Lösung falsch gewesen wäre:

| Ereignis | mtime Projektordner | mtime `transkripte/` |
|---|---|---|
| Datei **im Unterordner** angelegt | **bewegt sich nicht** | bewegt sich |
| Datei direkt im Projektordner angelegt | bewegt sich | — |
| vorhandene Datei **inhaltlich geändert** | **bewegt sich nicht** | **bewegt sich nicht** |

Verzeichnis-mtime verfolgt Einträge, nicht Inhalte. Die zweite Zeile trifft den Kern: Wer im
Editor arbeitet, **überschreibt** `<base>.edit.json`. Eine Sortierung nach Ordner-mtime hätte
genau die Arbeit nicht abgebildet, um die es geht.

Der Preis ist gemessen und klein: `DirEntry.stat()` kostet auf Windows **keinen zusätzlichen
Zugriff** — `scandir` bringt die Metadaten aus dem Verzeichnislisting mit (301 Zugriffe mit wie
ohne). Über 300 Projekte mit ~4 700 Dateien: **31,8 ms → 37,7 ms**. Auf POSIX kostet
`DirEntry.stat()` einen Syscall; die absoluten Zahlen bleiben klein, gemessen ist es dort nicht.

### 2. Die Dateiliste zieht auf `GET /api/projects/{project}`

Arbeitsfläche und Editor holen die Dateien **ihres** Projekts. Das ist die eigentliche Korrektur:
drei Seiten teilten sich einen Endpunkt, weil zwei von ihnen Daten brauchten, die die dritte
wegwirft.

### 3. Zeilen für die Masse, Karten nur für „läuft gerade"

Karten tragen bis etwa zwanzig Elemente; bei dreihundert zwingt ein Dreispalten-Raster das Auge
in ein Z über hundert Reihen, während eine linksbündige Spalte in einem senkrechten Zug gelesen
wird. Die reichhaltige Karte bleibt dort, wo ihre Reichhaltigkeit gelesen wird: bei den ein bis
zwei Projekten, die gerade rechnen. Die stehen oben, angeheftet — es ist der einzige
zeitkritische Zustand, und heute muss man ihn im Raster suchen.

Der Fortschrittsbalken fällt aus der Zeile: dreihundert Balken sind Rauschen, „14 Dateien ·
14 fertig" trägt dasselbe in Text, den man ohnehin liest.

### 4. Standardsortierung „zuletzt geändert"

Heute sortiert das Backend mit `sorted(os.listdir())`. Bei dreihundert Projekten steht das, an
dem man vor zehn Minuten gearbeitet hat, irgendwo in der Mitte. Nach der Suche ist das die
grösste Einzelverbesserung. Umschaltbar auf Name.

### 5. Suche im Kopf, `Ctrl+K` als Palette

Bei dieser Menge ist Finden die Hauptaktion, nicht Blättern. Ein klebendes Suchfeld filtert
sofort über den Namen, ohne Enter.

Zusätzlich eine **Befehlspalette** über `Ctrl+K` — dieselbe Suche, aber von überall erreichbar,
auch aus dem Editor. Gebaut mit shadcns `Command`; `cmdk` liegt **bereits** als Abhängigkeit im
Frontend, es kommt also keine dazu. Die Skill-Datenbank ist an dieser Stelle eindeutig
(„Command component for searchable lists and palettes — nicht: Input mit eigenem Dropdown"), und
es ist die verbreitete Antwort auf hunderte Elemente.

Die leere Trefferliste ist ein **eigener Zustand**, kein leerer Bildschirm: „Keine Projekte für
»x«" plus zwei Auswege — Suche leeren, oder ein Projekt mit genau diesem Namen anlegen.

### 6. Kein SSE, kein Cache, kein Virtualisieren

Alle drei wären plausibel und werden durch die Messung abgeräumt:

- **SSE** kann FastAPI inzwischen nativ (`fastapi.sse.EventSourceResponse`). Es würde 1,7 %
  Auslastung sparen und dafür Verbindungslebensdauer, Wiederverbindung und Mehrfach-Tabs
  einführen. Ausserdem müsste der Server *wissen*, wann sich etwas ändert — Job-Ereignisse kennt
  er, eine von Hand in `projekte\` gelegte Datei nicht; die fängt heute der Poll mit ab.
- **mtime-Cache**: 67,7 ms alle vier Sekunden sind 1,7 % Auslastung. Ein Cache löst ein Problem,
  das die Messung nicht zeigt — und bringt Invalidierungslogik mit.
- **Virtualisierung**: bei 33 KB und dreihundert Zeilen ist das DOM nicht die Grenze.
  `react-window` wäre eine Abhängigkeit auf Verdacht.

Ohne die Messung hätte ich vermutlich alle drei eingeplant.

### 7. Barrierefreiheit ist Teil der Anforderung, nicht Politur

- Das Suchfeld bekommt ein **echtes Label** (`sr-only` genügt), keinen blossen Platzhalter.
- Zeilen sind mit der Tastatur erreichbar und tragen `focus-visible:ring-2 focus-visible:ring-ring`
  — das Designsystem schreibt das für `div[tabIndex]` bereits vor, weil solche Elemente sonst nur
  den Standardring des Browsers bekommen.
- Zeilenhöhe **44 px**: erfüllt Touch-Mindestmass und Dichte in einem.
- Die Trefferzahl wird mit `aria-live="polite"` gemeldet, sonst bleibt das Filtern für
  Screenreader stumm.

## Was sich ändert

- `webtool/app.py` — `list_projects()` auf Zusammenfassung; neu `GET /api/projects/{project}`
- `webtool/frontend/src/hooks/useProjects.ts` — neue Form; neuer Hook für ein Projekt
- `webtool/frontend/src/pages/HomeGallery.tsx` — Suche, „läuft gerade", dichte Zeilen, Sortierung
- `webtool/frontend/src/pages/ProjectWorkspace.tsx`, `EditorView.tsx` — holen ihre Dateien selbst
- neu `webtool/frontend/src/components/ProjektPalette.tsx` — `Ctrl+K`
- Tests auf beiden Seiten, inklusive einer Messung, die die Zusammenfassung gegen die alte
  Zählung stellt (die Gegenprobe aus dieser Spec als Test)

## Nicht-Ziele

- **Keine Volltextsuche über Transkriptinhalte.** Das ist eine eigene Arbeit (steht als Idee
  geparkt) und braucht einen Index; hier wird über Projektnamen gesucht.
- Keine Gruppierung nach Zeitraum („Heute / Diese Woche"). Sie fügt Struktur hinzu, die gegen die
  Suche arbeitet, und die Sortierung leistet dasselbe.
- Kein Paginieren. Seiten zerschneiden das Scannen und lohnen nur gegen Netzwerklatenz, die es
  lokal nicht gibt.
- Keine Änderung am Job-Modell oder an den Pipeline-Phasen.

## Offen

- Die Messung lief auf **einer** Maschine mit NTFS und warmem Cache. Auf einer langsamen Platte
  oder über ein Netzlaufwerk wären beide Zahlen grösser — das Verhältnis dürfte bleiben, gemessen
  ist es nicht.
- Ein Projekt **ohne jede Datei** hat kein `max(mtime)`. Rückfall auf die mtime des
  Projektordners (die beim Anlegen gesetzt wurde), damit ein frisch angelegtes leeres Projekt
  oben steht und nicht unten.
