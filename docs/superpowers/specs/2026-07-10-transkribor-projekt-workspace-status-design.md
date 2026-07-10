# Transkribor — Projekt-Workspace + Live-Pipeline-Status (Design)

- **Datum:** 2026-07-10
- **Status:** Entwurf genehmigt → bereit für Implementierungsplan
- **Betrifft:** `webtool/` (FastAPI-Backend + React-Frontend), 1 Zeile in `transcribe.py`
- **Vorgänger-Specs:** [`2026-07-06-transkribor-webtool-design.md`](2026-07-06-transkribor-webtool-design.md), [`2026-07-09-transkribor-webtool-redesign.md`](2026-07-09-transkribor-webtool-redesign.md), [`2026-07-09-transkribor-speaker-diarization-design.md`](2026-07-09-transkribor-speaker-diarization-design.md)

## 1 · Problem & Ziel

Zwei Nutzerwünsche, die dieselbe Fläche (Projekt-/Datei-Panel) betreffen und darum gemeinsam entworfen werden:

1. **Live-Pipeline-Status pro Datei.** Während ein `correct`-Job läuft, zeigt die UI stumm den Roh-Fallback („kein Sprecher"), obwohl nur der Verify-Pass noch Minuten dauert. Auslöser des Bugs: das Frontend kennt einen laufenden Job nur über die beim Start zurückgegebene `job_id` — **nach einem Reload ist der Bezug weg**, der Backend-Job läuft aber weiter. Ziel: pro Datei den echten aktuellen Schritt (Diarisieren → Korrigieren → Verifizieren → Anwenden → Fertig) zeigen, reload-robust.

2. **Projekt-Management-UI.** Heute ist die App ein einzelner Editor-Screen mit Sidebar; es gibt keine Startseite, kein Projekt-Anlegen, keinen Drag&Drop-Upload. Ziel: Startseite/Galerie, Projekte anlegen (+ löschen), moderne Multi-File-Upload-UX, kompletter Fluss anlegen → hochladen → transkribieren → korrigieren → exportieren.

**Nicht-Ziele (YAGNI):** Umbenennen, byte-genaue Upload-Progress-Balken, Multi-User, Bearbeiten aus der Projektansicht, Datei-Mehrfachauswahl. Export mit Sprecher-Labels existiert bereits (`render_md.py`) und bleibt unverändert.

## 2 · Informationsarchitektur

`react-router-dom` (`BrowserRouter`, echte URLs) mit drei Routen:

| Route | Ansicht | Komponente |
|---|---|---|
| `/` | Home-Galerie | `HomeGallery` |
| `/p/:project` | Projekt-Arbeitsfläche | `ProjectWorkspace` |
| `/p/:project/:base` | Editor (heutiger Inhalt) | `EditorView` |

`BrowserRouter` braucht einen **SPA-Fallback im Backend**: ein Deep-Link wie `/p/Foo` trifft nach Reload den `StaticFiles`-Mount und würde 404en. Lösung: Catch-all-Route liefert `index.html` für alle Nicht-`/api`-, Nicht-Asset-Pfade (Standard-SPA-Muster auf FastAPI). `HashRouter` (`/#/p/…`) wäre die fallback-freie Alternative — verworfen zugunsten echter URLs.

**Editor-Umzug:** Der heutige `App.tsx`-Inhalt (Grid aus Sidebar/Toolbar/Transcript/PlayerDock) wird zu `EditorView`, gemountet an `/p/:project/:base`. Statt `sel`-State liest er `useParams()`. `openFile` → `navigate(\`/p/${project}/${base}\`)`. Die Editor-**Sidebar bleibt, wird aber projekt-scoped** (nur Dateien des aktuellen Projekts) mit denselben Status-Pillen und einem „‹ zurück"-Link zur Projektansicht.

## 3 · Home-Galerie (`/`)

```
┌───────────────────────────────────────────────┐
│ Transkribor                        [+ Projekt] │
│ ┌───────────┐ ┌───────────┐ ┌───────────┐      │
│ │ Foodfest… │ │ Balaa     │ │    …    ⋯ │      │
│ │ 12 Dateien│ │ 3 Dateien │ │           │      │
│ │ 5 ✓ · 1 ⟳ │ │ 0 ✓       │ │           │      │
│ │ ⟳ Korrig… │ │           │ │           │      │
│ └───────────┘ └───────────┘ └───────────┘      │
└───────────────────────────────────────────────┘
```

- **`ProjectCard`:** Name, Dateizahl, Fertig-Zahl (= Anzahl `has_edit`, also korrigiert/verarbeitet), und **live** „⟳ Korrigieren"/„▶ Transkribieren", wenn `active_job` gesetzt ist. Klick auf Karte → `/p/:project`. `⋯`-Menü → **Löschen**.
- **`NewProjectDialog`** (`[+ Projekt]`): Textfeld Name → `POST /api/projects` → bei Erfolg `navigate` in die neue (leere) Projektansicht.
- **`DeleteProjectDialog`:** Alert-Dialog, der zur Bestätigung das **Eintippen des Projektnamens** verlangt (Guardrail gegen Fehlklick auf unersetzliche lokale Interviewdaten) → `DELETE /api/projects/:project`.
- **Aktualisierung:** Die Galerie pollt die Projektliste alle ~3 s, solange irgendein Projekt ein `active_job` hat (sonst statisch). So bewegt sich die „⟳"-Anzeige ohne manuellen Reload.

## 4 · Projekt-Arbeitsfläche (`/p/:project`)

```
┌───────────────────────────────────────────────┐
│ ‹ Home   Foodfestival-Maienfeld                │
│   [⬆ Dateien] [▶ Transkribieren] [✎ Korrigieren]│
│   ── Glossar wird erstellt… ──         [Abbrechen]│
│   ┌ Audio hierher ziehen / klicken ┐           │
│   C0687   ⟳ Korrigieren…       [öffnen] [✎]     │
│   C0912   ⟳ Verifizieren…                       │
│   C1004   ○ Wartet…                             │
│   C0511   ✓ Fertig             [öffnen] [✎]     │
│   C0777   ↷ Übersprungen                        │
└───────────────────────────────────────────────┘
```

- **Kopf:** „‹ Home", Projektname, Projektaktionen (Upload / Transkribieren alle / Korrigieren alle — bestehende Endpoints).
- **Globaler Status-Banner:** für projektweite Phasen (Diarisieren-alle, Vorbereiten, Glossar) mit **Abbrechen**-Button (`cancelJob`).
- **`UploadDropzone`** (siehe §6).
- **Dateiliste:** pro Datei entweder das **statische Badge** (● Audio / ✓ exportiert / ✎ bearbeitet) **oder** die **Live-Phasen-Pille**, wenn die Datei im aktiven Job steckt. Aktionen: öffnen (→ Editor), „nur diese Datei korrigieren" (bestehendes `startCorrectFile`, mit dem bestehenden „überschreibt bearbeitete Version"-Confirm).

## 5 · Live-Status (Kern)

### 5.1 Job-Discovery (Root-Cause-Fix)

`GET /api/projects` liefert je Projekt ein Feld `active_job: { id: string, kind: string } | null`, gefüllt aus `jobs.active_for(project)`. Dadurch findet das Frontend nach Reload / in einer frischen Session den laufenden Job wieder — genau der gemeldete „stumme Roh-Fallback"-Fall wird damit behoben, nicht nur der Happy-Path.

### 5.2 Reiner Parser `lib/jobPhases.ts`

Signatur: `parseJobPhases(kind: string, lines: string[]): { global: GlobalPhase | null; active: { base: string; phase: FilePhase } | null; perBase: Record<string, FileState> }`

- `FileState` ∈ `{ 'done', 'skipped', 'failed' }` (terminal) — pro Datei aus den Markern.
- `active` = die **eine** gerade laufende Datei+Phase (der `correct`- und `transcribe`-Treiber verarbeiten Dateien **streng sequentiell** → höchstens eine aktiv).
- `global` ∈ `{ 'diarize', 'prep', 'glossary', null }` — projektweite Vorstufe, solange noch keine Datei in Korrektur ist.

**Ableitung = Einzel-Cursor-Scan** (der `correct`- wie der `transcribe`-Treiber verarbeiten Dateien streng sequentiell → zu jedem Zeitpunkt höchstens **ein** `cursor = {base, phase}` aktiv). Zeilen der Reihe nach durchgehen, dabei `cursor` (start `null`), `global` (start `null`) und `perBase` (Terminal-States) pflegen:

- **Per-Datei-Aktiv-Marker** setzen `cursor`: `→ Diarisiere {b}` → `{b, diarize}` · `→ Korrigiere {b}` → `{b, correct}` · `→ Verifiziere {b}` → `{b, verify}` · `[p] -> transkribiere {b}` → `{b, transcribe}`.
- **Per-Datei-Terminal-Marker** setzen `perBase[b]` **und** löschen `cursor`, falls `cursor.base==b`: `apply: {b} ->` → `done` · `[p] fertig {b}:` → `done` · `↷ SKIP {b}`/`apply: SKIP {b}`/`[p] skip (vorhanden): {b}` → `skipped` · `✗ … {b}`/`apply: FEHLT {b}`/`[p] FEHLER {b}:` → `failed`. (`diarize: SKIP {b}` ist **kein** Korrektur-Fehler — nur „ohne Cluster" — und setzt weder Terminal noch löscht es den Cursor.)
- **Globale Phasen-Marker** (projektweit, ohne Datei) setzen `cursor=null` und `global`: `diarize: N Datei(en) diarisiert` → schließt die Diarisierungs-Vorstufe (`global=null`, bis `prep`) · `prep: … getaggt` → `prep` · `→ Glossar`/`✓ Glossar` → `glossary` · Korrektur-Start (`→ Korrigiere`) räumt `global` implizit weg, da dann `cursor` gesetzt wird.
- **Ergebnis:** `active = cursor`; `global` gilt nur, wenn `cursor==null`. Dateien im Job-Scope (aus der Projektliste) ohne Terminal-State und ≠ `active.base` = „Wartet".

**Marker-Tabelle:**

| Job | Marker (Prefix) | Wirkung |
|---|---|---|
| correct | `→ Diarisiere {b} …` | global=diarize (b kurz „Diarisieren") |
| correct | `diarize: … / prep: …` | global=diarize/prep |
| correct | `→ Glossar …` / `✓ Glossar:` | global=glossary |
| correct | `→ Korrigiere {b} …` | active={b, correct} |
| correct | `→ Verifiziere {b} …` | active={b, verify} |
| correct | `apply: {b} -> edit.json` | b=done |
| correct | `↷ SKIP {b}` / `apply: SKIP {b}` | b=skipped |
| correct | `✗ … {b}` / `apply: FEHLT {b}` | b=failed |
| transcribe | `[p] -> transkribiere {b} …` | active={b, transcribe} |
| transcribe | `[p] fertig {b}:` | b=done |
| transcribe | `[p] skip (vorhanden): {b}` | b=skipped |
| transcribe | `[p] FEHLER {b}:` | b=failed |

### 5.3 Provider `useActiveJob`

Ein App-weiter Provider (React Context) pollt den aktiven Job (1,5 s, `GET /api/jobs/:id`), parst via `parseJobPhases` und stellt `{ kind, status, global, active, perBase }` bereit. Bezugsquelle der `job_id`:
- direkt beim UI-gestarteten Job (Rückgabe von `startTranscribe`/`startCorrect`/`startCorrectFile`), **oder**
- entdeckt aus `active_job` der Projektliste (Reload-Fall).

Bei Job-Ende: Projektliste neu laden (statische Badges aktualisieren), Polling stoppen. Der bestehende `useJob`-Toast schrumpft auf Start/Fertig/Fehler-Bestätigung; das laufende Detail wandert in Pillen + Banner.

## 6 · Upload (Drag & Drop, Multi-File)

`UploadDropzone`: Drag&Drop + Klick-zum-Wählen, `multiple`, Audio-Filter (`AUDIO_EXT`). Client-Schleife über den **bestehenden** `POST /api/projects/:project/audio` (ein Request pro Datei, Nebenläufigkeit ~3), eine Fortschrittszeile pro Datei mit Zuständen *lädt / fertig / existiert bereits (409) / Fehler*. Nach Abschluss Projektliste refreshen. **Kein Backend-Umbau.** *Ponytail: byte-genaue Progress-Balken bewusst weggelassen (lokale Dateien ≈ instant); nachrüsten, falls je große/entfernte Uploads relevant werden.*

## 7 · Backend-Änderungen (klein, additiv)

Alle in `webtool/app.py` + `webtool/jobs.py`, plus 1 Zeile `transcribe.py`.

1. **`POST /api/projects`** — Body `{ name }`; `paths.safe_name(name)`; `os.makedirs(projekte/<name>/audio, exist_ok=False)`; 409 bei `FileExistsError`. Antwort `{ ok, name }`.
2. **`DELETE /api/projects/{project}`** — `_validate(project)`; **409, wenn `jobs.active_for(project)`** (kein Löschen unter laufendem Job); sonst `shutil.rmtree(paths.project_dir(project))`. Antwort `{ ok }`.
3. **`list_projects`** — je Projekt `active_job: jobs.active_for(name)`.
4. **`jobs.active_for(project)`** — `{ id, kind }` des laufenden Jobs für das Projekt (aus `_active` + Status `running`), sonst `None`. Thread-safe unter `_lock`.
5. **SPA-Catch-all** — liefert `index.html` für unbekannte Nicht-API-Pfade (Reihenfolge relativ zum `StaticFiles("/")`-Mount beachten: API-Routen zuerst, Fallback für den Rest).
6. **`transcribe.py`** — vor `m.transcribe(...)` eine Zeile: `print(f"[{name}] -> transkribiere {base} …", flush=True)` (Start-Marker pro Datei, damit die Per-Datei-Pille auch beim Transkribieren funktioniert).

**Trust-Boundary bleibt gewahrt:** `POST`/`DELETE` gehen ausschließlich über `paths.safe_name`; `DELETE` löscht nur innerhalb `projekte/`.

## 8 · Frontend-Änderungen (Übersicht)

- **Deps:** `react-router-dom`.
- **`main.tsx`:** `<BrowserRouter>` + `<Routes>`; `<JobProvider>` oberhalb der Routen.
- **Neue Komponenten:** `HomeGallery`, `ProjectCard`, `NewProjectDialog`, `DeleteProjectDialog`, `ProjectWorkspace`, `UploadDropzone`, `FileStatusPill`.
- **Umbau:** `App.tsx`-Inhalt → `EditorView` (an `:base`-Route, `useParams`), Sidebar projekt-scoped.
- **Neue lib:** `lib/jobPhases.ts` (+ `jobPhases.test.ts`).
- **`lib/api.ts`:** `createProject`, `deleteProject`, Multi-Upload-Helfer (Schleife über bestehendes `uploadAudio`).
- **`lib/types.ts`:** `active_job` an `Project`, `FilePhase`/`GlobalPhase`/`FileState`.
- **Hooks:** `useActiveJob`/`JobProvider`; `useJob`-Toast verschlankt.

## 9 · Tests (Ponytail-Check)

- **`jobPhases.test.ts`** — Parser über repräsentative reale stdout-Zeilen beider Job-Kinds → erwartete `perBase`/`active`/`global` (inkl. Kanten: diarize-SKIP ≠ failed; verify-Rollback bleibt „active/done"; Reuse-Pfad → apply/done; Wartet-Zustand).
- **Backend-pytest** (bestehender Stil) — `POST`/`DELETE /api/projects` (safe_name, 409 vorhanden, 409 bei aktivem Job, rmtree), `active_job` in der Projektliste, `active_for`.

## 10 · Vorgeschlagene Implementierungs-Reihenfolge

1. **Backend** (5 kleine Endpoints/Felder + `active_for` + SPA-Fallback + transcribe-Zeile) mit pytest — isoliert testbar, blockiert nichts.
2. **`jobPhases.ts` + Test** — reiner, testbarer Kern des Status-Features.
3. **Router-Gerüst** — `main.tsx`, `EditorView`-Umzug (Editor muss weiter genau wie heute funktionieren), leere `HomeGallery`/`ProjectWorkspace`.
4. **`JobProvider`/`useActiveJob`** + `FileStatusPill` — Live-Status in Editor-Sidebar (schnell verifizierbar an einem realen Lauf).
5. **`ProjectWorkspace`** (Dateiliste + Banner + Aktionen) + **`UploadDropzone`**.
6. **`HomeGallery`** (Karten + `NewProjectDialog` + `DeleteProjectDialog`).

Jede Stufe ist einzeln lauffähig und verifizierbar; der bestehende Editor bleibt durchgehend funktionsfähig.
