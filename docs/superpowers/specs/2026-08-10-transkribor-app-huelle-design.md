# App-Hülle: aus vier Seiten wird ein Programm (Design)

Stand: 2026-08-10 · Ausgangspunkt: master `6009e8b` (v0.9.0)

## Warum

Marcus: „Die UI fühlt sich eher wie eine Webseite an statt wie eine App."

Der Befund dahinter ist messbar und liegt an einer Stelle, nicht an vielen:

```
EditorView.tsx:116   grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]
HomeGallery.tsx:54   mx-auto max-w-5xl p-6 sm:p-8
ProjectWorkspace:74  mx-auto max-w-3xl p-6 sm:p-8
SettingsPage:228     mx-auto max-w-3xl p-6 sm:p-8
electron/main.js:36  width: 1280
```

**Der Editor ist bereits eine App-Hülle; die anderen drei Seiten sind Lesespalten.** Bei
1280 px Fensterbreite und `max-w-3xl` (768 px) bleiben rund 500 px leer — das liest das Auge
sofort als Artikel in einem Fensterrahmen. Dazu vier Vollbild-Routen (ein Projektwechsel räumt
den Bildschirm leer) und genau ein Bildlauf für alles statt fester Zonen.

Das Muster für die Lösung existiert also im Haus. Drei Seiten holen auf, was die vierte kann.

Zweiter, unabhängiger Befund: `electron/main.js` kennt **kein** `setTitle`, **kein**
`setProgressBar`, **keine** `Notification`. Bei einer App, deren Kernaufgabe zwischen Minuten und
einer halben Stunde dauert, ist das der teurere Mangel — Layout entscheidet, wie es beim **ersten
Blick** aussieht, Verhalten entscheidet, ob es sich beim **Benutzen** wie ein Programm anfühlt.

## Was die Electron-Doku dazu beiträgt

Vier Punkte, an einer aktuellen Doku geprüft, nicht erinnert — sie verschieben den Zuschnitt:

| Was | Wie | Folge |
|---|---|---|
| Fenstertitel | `page-title-updated`: Electron übernimmt `document.title` als Fenstertitel, solange niemand `preventDefault()` ruft | **kein IPC** — ein `document.title` bedient Titelzeile, Taskleisten-Text und Alt-Tab |
| Systemmeldung | Die Web-`Notification`-API im Renderer wird zur nativen Meldung | **kein IPC**, und läuft im reinen Browser-Betrieb mit |
| Taskleisten-Fortschritt | `win.setProgressBar(0…1, {mode})`, nur im Hauptprozess | **ein** neuer IPC-Kanal |
| Fensterknöpfe | `titleBarStyle:'hidden'` + `titleBarOverlay` (Windows/Linux), `hiddenInset` (macOS) | Minimieren/Maximieren/Schliessen malt **das Betriebssystem**, nicht wir |

Der letzte Punkt entschärft das Hauptrisiko der rahmenlosen Variante. Die alte Sorge lautete
„eigene Titelzeilen brechen auf jeder Plattform anders" — sie galt dem *Nachbauen der Knöpfe*.
Das entfällt. Übrig bleiben eine Ziehzone und die Farbabstimmung.

## Entscheidungen

### 1. Eine `AppShell` rahmt die Routen

Neue Komponente, eingehängt in `App.tsx` — dieselbe Ebene, auf der schon `ProjektPalette` sitzt,
weil das die oberste Stelle innerhalb des Routers ist.

```
grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]

┌──────────────────────────────────────────────┐  TitleBar   col-span-2, nur Electron
├───────────────┬──────────────────────────────┤
│  Sidebar      │  <Routes>                    │  overflow-auto — der EINZIGE Bildlauf
│  overflow-auto│                              │
├───────────────┴──────────────────────────────┤
│  StatusBar                        col-span-2 │
└──────────────────────────────────────────────┘
```

`EditorView` **gibt sein `grid h-screen` ab** und wird zum reinen Inhalt
(`grid-rows-[auto_1fr_auto]`: Toolbar / Transcript / PlayerDock). Der `PlayerDock` bleibt damit
unter dem Transkript und über der Statuszeile — er gehört zum Editor, nicht zur App: mit zwei
offenen Projekten wäre ein globaler Abspieler ohne Bezug.

Die drei Lesespalten-Seiten verlieren `mx-auto max-w-*` und füllen die Spalte. `PageHeader` bleibt
als Bauteil bestehen; es zieht nur in eine volle Breite um.

### 2. Rahmenloses Fenster, aber keine selbstgemalten Knöpfe

`fensterOptionen(platform)` als **reine Funktion** in `electron/main.js`:

| Plattform | `titleBarStyle` | `titleBarOverlay` | Renderer |
|---|---|---|---|
| `win32`, `linux` | `hidden` | `{color, symbolColor, height: 40}` | rechts 140 px freihalten |
| `darwin` | `hiddenInset` | — | links 78 px für die Ampelknöpfe |

Rein und exportiert, damit `node --test` sie ohne Electron prüfen kann — dasselbe Muster wie
`setup.plan(platform, paketmanager)`, das aus demselben Grund so gebaut ist.

Die Titelzeile selbst: 40 px, `app-region: drag`, `user-select: none` (ohne das zweite fängt ein
Ziehversuch an, Text zu markieren). Links Marke + Kontext (`Interview B · audio_02`).
**Interaktive Elemente in der Zeile brauchen `app-region: no-drag`** — sonst zieht ein Klick
darauf das Fenster, statt zu klicken.

`titleBarOverlay` ist eine **feste Farbe im Hauptprozess** und weiss nichts vom Thema. Beim
Umschalten hell/dunkel ruft der Renderer `transkribor.titelleisteFarbe({color, symbolColor})` →
`win.setTitleBarOverlay(...)`. Ohne diesen Kanal stehen im Dunkelmodus schwarze Symbole auf
dunklem Grund.

### 3. Der Browser-Betrieb ist kein Sonderfall, sondern der Normalfall ohne Titelzeile

Dieselbe Oberfläche läuft unter `webtool.ps1` (:8000) und Vite (:5173). Dort gibt es
`window.transkribor` nicht → `AppShell` rendert die Titelzeile nicht, das Raster hat eine Reihe
weniger, alles andere ist identisch. Die Fortschritts-Meldung an die Taskleiste wird zum
No-Op (die Brücke fehlt); Systemmeldung und Fenstertitel funktionieren dort von selbst.

**Prüfung beider Fälle ist Pflicht, nicht Kür:** der Browser-Weg ist der, den niemand versehentlich
öffnet, während man an der App arbeitet — genau darum fällt eine Regression dort erst spät auf.

### 4. Eine Seitenleiste, aufklappbar — nicht zwei nebeneinander

`Sidebar.tsx` zeigt heute die Dateien **eines** Projekts (auf das offene gefiltert, mit
„← Projekte"). Eine zusätzliche globale Projektleiste stünde daneben: 520 px Navigation bei
1280 px Fenster.

Stattdessen wird dasselbe Bauteil erweitert: Suchfeld oben, darunter alle Projekte, das geöffnete
aufgeklappt mit seinen Dateien.

```
┌───────────────┐
│ Suche…        │
│ ▸ Interview A │
│ ▾ Interview B │   ← offen
│    ✓ audio_01 │
│    ▪ audio_02 │
│ ▸ Interview C │
│ [+ Neu]       │
└───────────────┘
```

`FileRow` und `FileStatusPill` bleiben unverändert — die Live-Phasen aus `jobPhases.ts`
funktionieren damit in der Leiste sofort, ohne neue Verdrahtung.

**Der Datenfluss aus PR #67 bleibt erhalten und darf nicht rückgängig gemacht werden:**
`useProjects` (Zusammenfassung, 4-s-Poll) füttert die Liste, `useProjectFiles` lädt Dateien **nur
für das aufgeklappte** Projekt. Eine Leiste, die alle Dateien aller Projekte zieht, wäre exakt der
Zustand, den die Galerie-Skalierung abgeschafft hat (13 691 Zugriffe, 394 KB).

### 5. `/` wird eine Übersicht, keine zweite Liste

Mit der Liste in der Leiste wäre dieselbe Liste auf `/` doppelt auf dem Schirm. `HomeGallery`
wird geteilt:

- **in die Leiste:** dichte Zeilenliste, Suchfeld, Sortierung
- **bleibt auf `/`:** laufende Läufe als Karten, „zuletzt geändert", `[+ Neues Projekt]`,
  Löschen-Dialog

`Ctrl+K` (`ProjektPalette`) bleibt unverändert an seiner Stelle in `App.tsx`.

### 6. Statuszeile zeigt nur, was ohnehin bekannt ist

24 px, drei Quellen — alle vorhanden, keine neue Abfrage:

| Stelle | Inhalt | Quelle |
|---|---|---|
| links | `2 Läufe · Interview B: Korrigiere 3/8` | `useActiveJob` |
| rechts | Rechenwerk (`cuda`) | `GET /api/hardware` |
| rechts | Version + Update-Hinweis | `useUpdate` |

Anzeige, kein Zustand. Fällt eine Quelle aus, bleibt ihr Feld leer statt einen Fehler zu zeigen —
eine Statuszeile, die Fehlermeldungen trägt, ist eine Statuszeile, die man ausblendet.

### 7. Die drei OS-Funktionen, und wo ihre Fallen liegen

**Fenstertitel** — Hook `useDokumentTitel()` setzt `document.title` aus Route und Laufzustand:

```
Transkribor
Interview B — Transkribor
Interview B · audio_02 — Transkribor
Korrigiere 3/8 · Interview B — Transkribor
```

Electron zieht per `page-title-updated` nach. Taskleiste und Alt-Tab sind damit mitversorgt.

**Systemmeldung** — `new Notification('Interview B fertig', {body: '8 Dateien'})` in einem
`onSettled`-Hörer.

> **Falle:** `onSettled` feuert bei *jedem* Poll-Tick, in dem irgendein Job terminal ist — nicht
> einmal je Lauf. Ohne Riegel meldet die App im Sekundentakt dasselbe. Ein `Set<job.id>` der
> bereits gemeldeten Läufe löst das. Es ist dieselbe Klasse Fehler wie in PR #54: ein Poll ist
> grob aber vollständig, ein Ereignis fein aber wiederholt sich — wer den Rückruf für „passiert
> einmal" hält, baut den Fehler ein.

**Taskleisten-Fortschritt** — `transkribor.fortschritt(anteil)` → `win.setProgressBar`.
Anteil = fertige Dateien / alle Dateien des Laufs. `mode: 'error'` bei gescheitertem Lauf,
`-1` (Balken weg), wenn nichts mehr läuft. Ohne das letzte bleibt der Balken für immer stehen.

`preload.js` wächst um genau drei Einträge: `plattform`, `fortschritt(n)`,
`titelleisteFarbe({color, symbolColor})`. Sie ist die Vertrauensgrenze — jede Zeile dort ist etwas,
das Renderer-Code darf, und dieser Renderer verarbeitet Transkripttext aus URL-Importen.

### 8. Projektliste und Dateiliste gehören der Hülle, nicht den Seiten

*Beim Schreiben des Umsetzungsplans aufgefallen, nicht vorher.*

`useProjects` wird heute an **vier** Stellen instanziiert (`HomeGallery`, `ProjectWorkspace`,
`EditorView`, `ProjektPalette`), `useProjectFiles` an zweien. Solange nur eine Seite zur Zeit
gerendert wird, ist das je ein Abruf. Eine **dauerhafte** Seitenleiste ist die fünfte Instanz und
läuft gleichzeitig mit der Seite — `GET /api/projects` liefe damit doppelt so oft wie in PR #67
gemessen. Der Umbau darf die Ersparnis nicht wieder ausgeben.

Deshalb: ein `ProjektDatenProvider` in der `AppShell`, zwei Hooks (`useProjekte`, `useDateien`).
Zwei Nebenwirkungen, die für sich schon zählen:

- Der **Summenpoll-Wächter** (lade die Dateiliste nach, wenn sich `dateien`/`fertig` ändern) steht
  heute **wortgleich** in `EditorView.tsx:42-48` und `ProjectWorkspace.tsx:43-49`. Er wandert an
  eine Stelle.
- Das **aufgeklappte Projekt der Seitenleiste ist das Projekt aus der URL** — kein eigener
  Zustand. Ein zweiter Begriff von „offen" wäre eine zweite Wahrheit, die synchron zu halten wäre.
  Ein Klick auf ein anderes Projekt navigiert; ein Klick auf das offene klappt zu und landet
  auf `/`.

Der Provider steht **in** der `AppShell` und nicht in `main.tsx`, weil er `useMatch` braucht und
damit innerhalb des Routers liegen muss.

## Was sich ändert

| Datei | Änderung |
|---|---|
| `webtool/frontend/src/components/AppShell.tsx` | **neu** — Raster, Titelzeile, Statuszeile |
| `webtool/frontend/src/hooks/useProjektDaten.tsx` | **neu** — ein Provider für Projektliste + Dateien (Entscheidung 8) |
| `webtool/frontend/src/components/TitleBar.tsx` | **neu** — nur unter Electron gerendert |
| `webtool/frontend/src/components/StatusBar.tsx` | **neu** |
| `webtool/frontend/src/hooks/useDokumentTitel.ts` | **neu** |
| `webtool/frontend/src/hooks/useOsFortschritt.ts` | **neu** — Fortschritt + Systemmeldung |
| `App.tsx` | `AppShell` um die Routen |
| `Sidebar.tsx` | alle Projekte, Suche, aufklappbar |
| `HomeGallery.tsx` | Liste raus, Karten + „zuletzt geändert" bleiben |
| `ProjectWorkspace.tsx`, `SettingsPage.tsx` | `mx-auto max-w-*` raus |
| `EditorView.tsx` | `h-screen`-Raster ab an `AppShell` |
| `electron/main.js` | `fensterOptionen(platform)`, IPC `fortschritt`, `titelleisteFarbe` |
| `electron/preload.js` | drei Einträge |

## Prüfungen

| Was | Warum genau das |
|---|---|
| `AppShell` rendert `TitleBar` mit `window.transkribor` — und **nicht** ohne | Der Browser-Betrieb ist die Regressionsgefahr |
| `fensterOptionen('win32'\|'linux'\|'darwin')` (`node --test`) | Ohne Electron prüfbar; macOS/Linux sind ungeprüfte Plattformen (Issue #36) |
| Sidebar: Suche filtert, Aufklappen lädt Dateien; die Leiste fragt Dateien **nur für ein** Projekt ab | Sonst kehrt die Zugriffslast aus PR #67 zurück |
| Zwei Leser der Projektliste → **ein** `GET /api/projects` (Entscheidung 8) | Der Kern des Provider-Umbaus; ohne Gegenprobe misst der Test nichts |
| Zwei Ticks mit demselben terminalen Job → **eine** Meldung | Die Falle aus Entscheidung 7 |
| `setProgressBar(-1)`, wenn kein Lauf mehr aktiv ist | Sonst bleibt der Balken stehen |

Gegenprobe für die beiden Fallen-Tests: den Riegel entfernen, Test muss rot werden. Ein Test, der
auch ohne den Fix grün ist, prüft etwas anderes als er behauptet.

## Nicht-Ziele

- **Kein neues Backend.** Keine neue Route, kein neues Feld. Alles, was Statuszeile und
  Fortschritt brauchen, liefern `GET /api/projects`, `GET /api/jobs/{id}` und `GET /api/hardware`
  bereits.
- **Kein Menü, kein „zuletzt geöffnet", keine Tabs.** Getrennte Vorhaben.
- **Keine Änderung an der Korrektur-Pipeline.** Diese Arbeit fasst `webtool/*.py` nicht an.
- **Kein Virtualisieren der Seitenleiste.** Bei 300 Projekten war die Liste in PR #67 gemessen
  unkritisch; erst messen, dann optimieren.

## Offen / Risiko

- **macOS und Linux sind aus dem gebauten Paket nie gestartet worden** (Issue #36). Die
  Plattformweiche ist per `node --test` abgedeckt, das tatsächliche Fensterverhalten (Ziehzone,
  Vollbild, Ampelknopf-Einzug) ist es nicht. Marcus hat das Risiko gesehen und die Stufe bestätigt.
- **`titleBarOverlay`-Höhe und unsere 40 px müssen zusammenpassen** — zwei Zahlen an zwei Orten
  (`electron/main.js` und `TitleBar.tsx`), wie die DMG-Symbolpositionen, die doppelt in
  `package.json` und `build/marke.py` stehen. Jede der beiden Stellen braucht einen Kommentar,
  der auf die andere zeigt.
- **Der Zuschnitt ist gross** (Raster, Seitenleiste, Galerie-Teilung, Electron, OS-Integration).
  Der Umsetzungsplan phasiert das: erst Hülle + Seiten füllen (in sich lauffähig), dann
  Seitenleiste + Galerie-Teilung, dann Titelzeile, dann OS-Integration. Jede Phase ist einzeln
  benutzbar — bricht eine ab, steht trotzdem etwas Ganzes da.
