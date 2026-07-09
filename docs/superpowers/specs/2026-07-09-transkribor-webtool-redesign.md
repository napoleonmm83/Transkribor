# Transkribor Web-Editor — Redesign auf React + shadcn/ui

**Datum:** 2026-07-09
**Status:** Entwurf zur Freigabe
**Ersetzt (UI-Teil):** `docs/superpowers/specs/2026-07-06-transkribor-webtool-design.md` (Backend/Flows bleiben gültig)

## 1. Ziel & Kontext

Der bestehende Web-Editor (`webtool/static/`: ein `index.html`, ~300 Zeilen Vanilla-JS `app.js`, ~43 Zeilen `style.css`, hand-vendored wavesurfer) ist funktional, aber optisch rudimentär. Dieses Redesign baut das **Frontend** auf React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui neu, mit einem **größeren UX-Redesign** (Layout und Flows neu gedacht) bei **voller Funktionsparität**. Das **Backend** (`webtool/app.py`, `correct.py`, `jobs.py`, `edit_model.py`, `render_md.py`) und die HTTP-API bleiben **unverändert**.

Nicht-Ziel: neue fachliche Features (Diarization, Notizen-UI, etc.). Nur Optik/UX + Stack.

## 2. Entscheidungen (aus dem Brainstorming)

| Aspekt | Wahl |
|---|---|
| Stack | React 19 + Vite + **TypeScript** + Tailwind v4 + shadcn/ui |
| Layout | **A — Descript-Stil**: Transkript zentral, Audio-Player unten fest angedockt, Dateien links, Schwellen-Regler ins ⚙-Popover |
| Transkript | **Sprecher-Redebeiträge** (chat-artig, ein Block pro Sprecherwechsel); die ASR-Segmente bleiben Edit-/Play-Einheit |
| Unsicherheit | **inline**, gepunktete Markierung, Hover = Roh-Wort + Konfidenz (Nuance siehe §7.3) |
| Look | **Studio Cool**: durchgehend Sans, kühles Zinc/Slate-Neutral, Indigo-Akzent |
| Betrieb/Build | FastAPI serviert gebautes Bundle; `npm run dev` (Vite + Proxy) zum Entwickeln; Node nur für Build/Dev |
| Dark-Mode | System folgen + manueller Umschalter (localStorage) |

## 3. Architektur

### 3.1 Verzeichnis-Layout
```
webtool/
  app.py, correct.py, jobs.py, edit_model.py, render_md.py   # unverändert
  static/            # BUILD-OUTPUT (git-ignored), von FastAPI ausgeliefert
  frontend/          # NEU: Vite-React-TS-Quellen
    index.html
    vite.config.ts
    tsconfig.json, tsconfig.app.json, tsconfig.node.json
    components.json                  # shadcn
    package.json, package-lock.json
    src/
      main.tsx, App.tsx, index.css
      lib/            api.ts, utils.ts, types.ts, grouping.ts, uncertainty.ts, playback.ts
      hooks/          useProjects.ts, useDoc.ts, useJob.ts, useTheme.ts
      components/
        ui/           # shadcn-generierte Komponenten
        Sidebar.tsx, ProjectList.tsx, FileRow.tsx
        Toolbar.tsx, ThemeToggle.tsx, ThresholdPopover.tsx
        PlayerDock.tsx, Waveform.tsx
        Transcript.tsx, SpeakerTurn.tsx, SegmentView.tsx, SegmentEditor.tsx
        SpeakerCombobox.tsx, UncertainWord.tsx
```

### 3.2 Build & Auslieferung
- `frontend/vite.config.ts`: `base: '/'`, `build.outDir: path.resolve(__dirname,'../static')`, `build.emptyOutDir: true`, `plugins: [react(), tailwindcss()]`, `resolve.alias { '@': ./src }`, `server.proxy { '/api': 'http://127.0.0.1:8000' }` (Audio läuft unter `/api/.../audio`, ist damit abgedeckt).
- `npm run build` schreibt `index.html` + `assets/*` nach `webtool/static/` (überschreibt die alten Vanilla-Dateien vollständig).
- **`webtool/static/` wird git-ignoriert** (Build-Artefakt). `webtool.ps1` baut das Frontend, falls `static/index.html` fehlt, und startet dann uvicorn. Node ist auf der Maschine vorhanden (v22.23.1). → „nur Python zum Benutzen" gilt nach dem ersten Build; keine committeten Bundle-Diffs.
- FastAPI-Auslieferung: der bestehende Mount am Dateiende (`app.mount('/', StaticFiles(directory=static, html=True))`) bleibt die **letzte** Route; alle `/api`-Routen stehen davor und gewinnen. Kein SPA-Router → **kein** SPA-Fallback-Subclass nötig (eine einzige View, keine Deep-Links).

### 3.3 Dev-Loop
`uvicorn webtool.app:app --port 8000` **und** `npm --prefix webtool/frontend run dev` (Vite :5173). Im Browser :5173 öffnen → HMR; `/api` wird an :8000 durchgereicht (inkl. HTTP-Range fürs Audio). `static/` wird im Dev nicht angefasst → das alte Tool bleibt bis zum finalen Cutover-Build lauffähig.

## 4. Backend-Änderungen (minimal)
- Keine API-Änderung. Endpunkte bleiben: `GET /api/projects`, `GET/PUT /api/projects/{p}/files/{base}`, `GET /api/projects/{p}/audio/{base}`, `POST .../transcribe|correct`, `POST .../files/{base}/correct`, `GET /api/jobs/{id}` (+`/cancel`), `POST .../files/{base}/export`, `POST /api/projects/{p}/audio` (Upload).
- Einziger möglicher Eingriff: sicherstellen, dass der StaticFiles-Mount auf `webtool/static/` zeigt (ist schon so). Kein `/vendor`-Mount mehr nötig.

## 5. Informationsarchitektur / Layout (A)

```
┌───────────────────────────────────────────────────────────┐
│ Toolbar: Dateiname · [Speichern] [Export] · ⚙ · ◐ (Theme)  │
├───────────┬───────────────────────────────────────────────┤
│ Sidebar   │  Transcript (scroll)                           │
│ Projekte  │   ▸ Redebeitrag (Sprecher farbig | Segmente)   │
│  ▸ Datei  │   ▸ Redebeitrag …                              │
│  ⬆ ▶ ✎    │                                                │
│ (Jobs →   │                                                │
│  Toasts)  │                                                │
├───────────┴───────────────────────────────────────────────┤
│ PlayerDock (fix unten): ▶  ~~~Waveform~~~  0:34 / 3:12      │
└───────────────────────────────────────────────────────────┘
```
- **Sidebar**: Projekte mit Aktionen Upload (⬆), Transkribieren (▶), Korrigieren (✎); je Datei Zeile mit Badge (✎/✓/●) + Per-Datei-Korrektur-Button. Aktive Datei hervorgehoben.
- **Toolbar**: aktueller Pfad, Speichern/Export, ⚙-Popover (Schwellen), Theme-Toggle. Speicher-Status als dezenter Indikator + Sonner-Toast.
- **PlayerDock**: persistente Wellenform + Transport unten; immer sichtbar beim Editieren.
- **Transcript**: die Hauptfläche; Redebeiträge als Blöcke.

## 6. Datenmodell & Datenfluss

### 6.1 Typen (TS, spiegeln `edit.json`)
```ts
type Word = { word: string; start: number|null; end: number|null; probability: number };
type Flags = { hallucination: boolean; silence: boolean; low_conf: boolean };
type Segment = { id: number; start: number; end: number; speaker: string;
                 raw_text: string; text: string; words: Word[]; flags: Flags; note: string };
type EditDoc = { base: string; project: string; audio: string; language: string;
                 human_edited: boolean; context: string; speakers: string[];
                 segments: Segment[]; annotations: string[] };
```
Kanonisch bleibt `edit.json` **pro Segment**. Keine Persistenz-Änderung: PUT schickt dasselbe Doc zurück wie heute.

### 6.2 Sprecher-Redebeiträge (reine View-Logik)
`lib/grouping.ts`: `groupIntoTurns(segments) → Turn[]`, wobei ein `Turn = { speaker: string; segments: Segment[] }` aus **aufeinanderfolgenden** Segmenten gleichen `speaker` gebildet wird. Rein zur Darstellung; Editieren/Speichern bleibt segmentweise. Sprecher leer ⇒ eigener Block „(kein Sprecher)".

### 6.3 State
- `useProjects()` — lädt `/api/projects`, Refresh nach Jobs/Upload.
- `useDoc(project, base)` — lädt/hält das `EditDoc`, `dirty`-Flag, `updateSegment(id, patch)`, `save()` (PUT), `exportMd()`. Unsaved-Guard beim Dateiwechsel/`beforeunload`.
- `useJob(jobId)` — pollt `/api/jobs/{id}` (1,5 s), liefert Zeilen-Tail + Status, `cancel()`.
- `useTheme()` — `.dark` auf `<html>`, localStorage, Default = `matchMedia('(prefers-color-scheme: dark)')`.
- Kein externer Store (Zustand/Redux) — Hooks + Props reichen für ein Ein-Dokument-Tool.

## 7. Kern-Interaktionen

### 7.1 Segment-Playback (mit Puffer)
`@wavesurfer/react` `useWavesurfer`-Hook in `Waveform.tsx`. `lib/playback.ts` behält die verifizierte Puffer-Logik:
```ts
const PAD = { in: 0.15, out: 0.35 };
function playWindow(seg, duration) {
  const from = Math.max(0, seg.start - PAD.in);
  const end = seg.end + PAD.out;
  return { from, to: Number.isFinite(duration) ? Math.min(duration, end) : end };
}
```
Abspielen primär nativ: `ws.play(from, to)`. Fallback (falls rAF-Auto-Stop überschießt): `ws.setTime(from); ws.play();` + `ws.on('timeupdate', t => { if (t >= to) ws.pause(); })`. Klick auf Segment-Zeit/▶ spielt das Segment; Klick auf Sprecher-Label spielt den ganzen Redebeitrag (erstes `from` bis letztes `to`). Laufendes Segment wird via `timeupdate` hervorgehoben.

### 7.2 Text-Editieren (Anzeige/Edit-Split, kein contenteditable)
- **Anzeige** (`SegmentView`): read-only Markup; Text als Fragmente, unsichere Wörter als `UncertainWord`-Span (gepunktete Unterstreichung, shadcn-`Tooltip` mit „Roh: X · 0.pp").
- **Edit** (`SegmentEditor`): Klick aktiviert eine **uncontrolled** auto-wachsende `<textarea>` (shadcn-`Textarea` + `field-sizing: content`, Fallback scrollHeight). `defaultValue` = Segment-Text; `onBlur`/⌘Enter hebt den Wert in `useDoc.updateSegment` → `dirty`. **Niemals** den Textarea-Wert pro Keystroke aus dem globalen State neu setzen (das erzeugt Cursor-Sprünge). Keine Editor-Library.

### 7.3 Unsicherheit inline (Nuance)
Wort-Konfidenzen liegen auf `words` (Roh-ASR). Nach Korrektur weicht `text` von der Roh-Wortfolge ab → Offsets sind nicht mehr sicher abbildbar. Regel:
- Segment **unkorrigiert** (`text === raw_text`): `lib/uncertainty.ts` tokenisiert `text`, mappt Wörter auf `words` und markiert `probability < Schwelle` inline (gelb/rot). Immer sichtbar.
- Segment **korrigiert/ediert**: gilt als „reviewed" → keine Inline-Marker (Text ist bereinigt). Die Roh-Wörter + Konfidenzen bleiben über einen dezenten „🔍 Roh"-Reveal pro Segment einsehbar (wie heute).
- Schwellen (gelb/rot) global im ⚙-Popover (`Slider`), localStorage-persistiert; Randwörter erst ab Rot färben (heutige Logik).

### 7.4 Sprecher (`SpeakerCombobox`)
Freitext **mit** Vorschlägen: shadcn-`Popover` + `Command` (Combobox-Muster), Vorschlagsliste = Union aus `doc.speakers` + allen gesetzten `seg.speaker`. **Freitext-Eingabe muss erlaubt sein** (Command wählt normalerweise nur) — neuer Wert wird committed und als Vorschlag ergänzt. Pro Redebeitrag ein Sprecher-Feld (setzt `speaker` auf allen Segmenten des Blocks); Sprecher-Farbe konsistent pro Name (Interviewer/Befragte visuell unterscheidbar).

### 7.5 Jobs & Status (Sonner)
Transkribieren/Korrigieren/Per-Datei-Korrektur/Cancel über die bestehenden Endpunkte. Fortschritt als **Sonner-Toast** mit Live-Tail der Job-Zeilen; **Cancel** als Toast-Action (`POST /api/jobs/{id}/cancel`). Dedupe „ein Job pro Projekt" respektieren (Server liefert `started:false`). Nach Abschluss Projektliste refreshen. Destruktive Bestätigungen (Neu-Korrektur einer editierten Datei) via `AlertDialog`.

### 7.6 Speichern/Export & Dark-Mode
- Speichern: PUT (wie heute); Toast + Status. Export: POST `.../export` → Markdown-Download.
- Dark-Mode: minimaler `ThemeProvider` (kein next-themes nötig), toggelt `.dark` auf `<html>`, merkt localStorage, Default = System.

## 8. Technisches Setup (aktueller Stand, recherchiert)

### 8.1 Versionen
Tailwind `4.3.2` + `@tailwindcss/vite 4.3.2` (gekoppelt) · shadcn-CLI v3.x (`npx shadcn@latest`) · React 19.x · Vite 7/8 · `@wavesurfer/react` 1.0.x + `wavesurfer.js` 7.x · lucide-react · Node 22. Beim Umsetzen jeweils `@latest`/`npm view` gegenprüfen.

### 8.2 Setup-Schritte
1. `npm create vite@latest frontend -- --template react-ts` (in `webtool/`), `npm i`.
2. `npm i tailwindcss @tailwindcss/vite` (ohne `@next`), `npm i -D @types/node`.
3. `src/index.css` = **eine** Zeile `@import "tailwindcss";` + `@custom-variant dark (&:where(.dark, .dark *));`.
4. `vite.config.ts`: `plugins:[react(), tailwindcss()]`, `base:'/'`, `build.outDir:'../static'`, `emptyOutDir:true`, `resolve.alias {'@':'./src'}`, `server.proxy {'/api':'http://127.0.0.1:8000'}`.
5. `@`-Alias **auch** in `tsconfig.app.json` (`baseUrl:'.'`, `paths {'@/*':['./src/*']}`) — häufigster Fehler, wenn nur `tsconfig.json`.
6. `npx shadcn@latest init` (new-york, baseColor neutral, cssVariables) → schreibt `components.json`, `src/lib/utils.ts`, v4-CSS-Variablen inkl. `.dark`-Block.
7. `npx shadcn@latest add button select slider dialog alert-dialog popover command sonner scroll-area tooltip textarea`.
8. `npm i wavesurfer.js @wavesurfer/react`.
9. Studio-Cool-Tuning: eingebaute zinc/slate (Neutral) + indigo (`--primary`) nutzen; nur die shadcn-Semantik-Tokens in `:root`/`.dark` anpassen. **Keine** komplette Eigenpalette.

### 8.3 Veraltet — nicht verwenden
`@tailwind base/components/utilities`; `tailwind.config.js`/`content[]`/`postcss.config.js`/autoprefixer; `darkMode:'class'` in JS-Config; `npx shadcn-ui@latest` (alter Name); shadcn-`Toast`/`useToast` (→ Sonner); Combobox als Einzelkomponente (→ Popover+Command); altes `wavesurfer-react`-Paket, v6-APIs (`backend:'MediaElement'`, `responsive`, `wavesurfer.addRegion`); controlled contenteditable; Draft.js. wavesurfer-Plugins-Array **memoisieren** (`useMemo`), sonst Init-Fehler.

## 9. Teststrategie
- **Frontend**: Vitest + React Testing Library, Fokus auf reine Logik: `grouping.groupIntoTurns`, `playback.playWindow` (inkl. Rand-Clamps, portiert vom bestehenden Node-Check), `uncertainty`-Tokenisierung/Mapping. Dazu ein Smoke-Test je Kernkomponente (Transcript rendert Turns, SegmentEditor hebt bei Blur). Kein E2E-Framework.
- **Backend**: bestehende 84 pytest bleiben grün (API unangetastet).
- **Manuell/Dogfood**: gegen echtes Projekt (Foodfestival-Maienfeld) via `npm run dev`, danach ein Prod-Build-Durchlauf + `.\webtool.ps1`.

## 10. Funktionsparität (Checkliste, muss erhalten bleiben)
Projekt-/Dateiliste + Badges · Upload · Transkribieren · Korrigieren (Projekt + Per-Datei, force-Bestätigung) · Job-Polling + **Cancel** · Wellenform + Segment-Play **mit Puffer** · Segment-Text editierbar · Sprecher (Freitext + Vorschläge) · Unsicherheits-Färbung + Schwellen-Regler · Roh-Wörter-Reveal · `human_edited`-Schutz · Speichern (PUT) · Export `.md` · Flags-Anzeige (⚠/🔇/~) · Annotations.

## 11. Umsetzung in Phasen (für den späteren Plan)
1. Scaffold: Vite+TS+Tailwind v4+shadcn init, vite.config/tsconfig, App-Shell + Theme.
2. Datenschicht: Typen, `api.ts`, `useProjects`/`useDoc`, Sidebar + Dateiliste.
3. Layout: Toolbar, Transcript-Gerüst, PlayerDock.
4. Player: `@wavesurfer/react` + `playback.ts` + Segment-/Turn-Play + Highlight.
5. Transkript: Redebeitrags-Gruppierung, SegmentView/Editor (textarea-Split), SpeakerCombobox.
6. Unsicherheit: `uncertainty.ts`, UncertainWord + Tooltip, ⚙-Schwellen-Popover, Roh-Reveal.
7. Jobs: Sonner-Toasts + Cancel + AlertDialog; Upload/Transkribieren/Korrigieren.
8. Speichern/Export/Dirty-Guard; Politur (Empty-States, Fokus/Hover, Tastatur).
9. Cutover: Prod-Build nach `static/`, `webtool.ps1`-Build-Guard, alte Vanilla-Dateien entfernen, Dogfood, PR.

## 12. Nicht im Scope (YAGNI)
Diarization/Stufe 3 · Notizen-UI (3B) · Mehrbenutzer/Auth · client-seitiges Routing · Server-Rendering · i18n · Committen des Build-Bundles.

## 13. Offene Review-Punkte
1. **Build-Artefakt**: `static/` git-ignoriert + Build-Guard in `webtool.ps1` (Empfehlung) — oder Bundle doch committen, damit ein frischer Clone ohne Node läuft?
2. **Unsicherheit bei korrigierten Segmenten** (§7.3): Inline nur für unkorrigierte + „🔍 Roh"-Reveal für korrigierte — passt das, oder Marker-Verhalten anders gewünscht?
3. **Sprecher pro Redebeitrag vs. pro Segment**: Feld pro Block (setzt alle Segmente) — ok? (Heute pro Segment.)
