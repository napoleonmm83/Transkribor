# Transkribor Web-Editor Redesign (React + shadcn) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den Vanilla-JS Web-Editor durch eine React-19 + Vite + TypeScript + Tailwind-v4 + shadcn/ui App ersetzen (Layout A „Descript-Stil", Sprecher-Redebeiträge, Studio-Cool-Look), bei voller Funktionsparität und unverändertem Backend.

**Architecture:** Neues Frontend in `webtool/frontend/` (Vite react-ts), baut nach `webtool/static/` (git-ignoriert), das der bestehende FastAPI-Server ausliefert. Die HTTP-API bleibt 1:1. Reine View-Logik (Redebeitrags-Gruppierung, Playback-Puffer, Unsicherheits-Tokenisierung) liegt testbar in `src/lib/*`; Daten/IO in Hooks; UI in fokussierten Komponenten.

**Tech Stack:** React 19, Vite 7+, TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`, CSS-first), shadcn/ui (`npx shadcn@latest`), `@wavesurfer/react` + `wavesurfer.js` v7, sonner, lucide-react, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-09-transkribor-webtool-redesign.md`

## Global Constraints

- **Branch:** Alle Arbeit auf `webtool-react-redesign` (existiert). Pro Task ein Commit. Commit-Message-Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Landung am Ende via PR→Rebase-Merge (CLAUDE.md „GitHub-Management").
- **Frontend-cwd:** Alle npm-Befehle in `webtool/frontend/` (bzw. `npm --prefix webtool/frontend ...`).
- **Node:** v22 (vorhanden). Versionen beim Install mit `npm view <pkg> version` gegenprüfen; kein `@next`-Tag.
- **Tailwind v4 CSS-first:** `@tailwindcss/vite`-Plugin + `@import "tailwindcss";`. **KEINE** `tailwind.config.js`, **kein** `postcss.config.js`/autoprefixer, **keine** `@tailwind base/components/utilities`-Direktiven, **kein** `content[]`. Dark-Mode via `@custom-variant dark (&:where(.dark, .dark *));`, nicht `darkMode:'class'`.
- **shadcn:** immer `npx shadcn@latest` (NIE `shadcn-ui`). Toast = **sonner** (nicht shadcn-`Toast`/`useToast`). Combobox = **Popover + Command** (keine Einzelkomponente). Destruktive Bestätigung = **AlertDialog**.
- **`@`-Alias** muss in `vite.config.ts` **UND** `tsconfig.app.json` stehen (nur `tsconfig.json` reicht bei Vite nicht).
- **wavesurfer:** offizielles `@wavesurfer/react` (`useWavesurfer`-Hook), nicht das alte `wavesurfer-react`, keine v6-APIs. Plugins-Array immer `useMemo`-memoisiert.
- **Editier-Text:** kein `contentEditable`. Anzeige/Edit-Split mit uncontrolled `<textarea>` (State erst bei Blur hochheben).
- **Backend:** unverändert. API-Antworten siehe „Shared Contracts".
- **`webtool/static/`** ist Build-Output → git-ignoriert; nicht von Hand editieren.
- Prinzipien: DRY, YAGNI, TDD (Logik zuerst als Test), kleine Commits.

## Shared Contracts

Diese Signaturen sind für alle Tasks verbindlich. Namen exakt so verwenden.

### API-Antworten (aus `webtool/app.py`, unverändert)
```
GET  /api/projects
     -> { projects: { name: string, files: { base, has_audio, has_raw, has_edit, has_md }[] }[] }
GET  /api/projects/{p}/files/{base}          -> EditDoc
GET  /api/projects/{p}/audio/{base}          -> Audio-Bytes (Range-fähig)
PUT  /api/projects/{p}/files/{base}          -> { ok: true }   (Server setzt human_edited=true)
POST /api/projects/{p}/files/{base}/export   -> { md: string }
POST /api/projects/{p}/transcribe            -> { job_id: string, started: boolean }
POST /api/projects/{p}/correct               -> { job_id, started }
POST /api/projects/{p}/files/{base}/correct?force=<bool> -> { job_id, started }
GET  /api/jobs/{id}                          -> { status: 'running'|'done'|'error'|'cancelled', lines: string[], kind?: string }
POST /api/jobs/{id}/cancel                   -> { cancelled: true }
POST /api/projects/{p}/audio  (multipart 'file') -> { ok, base, file }  | 4xx { detail }
```

### `src/lib/types.ts`
```ts
export type Word = { word: string; start: number | null; end: number | null; probability: number };
export type Flags = { hallucination: boolean; silence: boolean; low_conf: boolean };
export type Segment = {
  id: number; start: number; end: number; speaker: string;
  raw_text: string; text: string; words: Word[]; flags: Flags; note: string;
};
export type EditDoc = {
  base: string; project: string; audio: string; language: string;
  human_edited: boolean; context: string; speakers: string[];
  segments: Segment[]; annotations: string[];
};
export type ProjectFile = { base: string; has_audio: boolean; has_raw: boolean; has_edit: boolean; has_md: boolean };
export type Project = { name: string; files: ProjectFile[] };
export type JobStatus = { status: 'running' | 'done' | 'error' | 'cancelled'; lines: string[]; kind?: string };
export type StartJob = { job_id: string; started: boolean };
export type Thresholds = { yellow: number; red: number };
export type Turn = { key: string; speaker: string; segments: Segment[] };
```

### `src/lib/api.ts` (Signaturen)
```ts
listProjects(): Promise<Project[]>
getDoc(project: string, base: string): Promise<EditDoc>
saveDoc(project: string, base: string, doc: EditDoc): Promise<void>
exportMd(project: string, base: string): Promise<string>
audioUrl(project: string, base: string): string
startTranscribe(project: string): Promise<StartJob>
startCorrect(project: string): Promise<StartJob>
startCorrectFile(project: string, base: string, force: boolean): Promise<StartJob>
getJob(jobId: string): Promise<JobStatus>
cancelJob(jobId: string): Promise<void>
uploadAudio(project: string, file: File): Promise<{ base: string; file: string }>
```

### `src/lib/*` reine Logik
```ts
// grouping.ts
groupIntoTurns(segments: Segment[]): Turn[]
// playback.ts
export const PAD: { in: number; out: number };  // { in: 0.15, out: 0.35 }
playWindow(seg: { start: number; end: number }, duration: number): { from: number; to: number }
// uncertainty.ts
isCorrected(seg: Segment): boolean          // seg.text.trim() !== seg.raw_text.trim()
type Token = { text: string; cls: '' | 'u-yellow' | 'u-red' };
tokenizeUncertain(seg: Segment, thr: Thresholds): Token[]   // nur sinnvoll wenn !isCorrected
```

### Hooks
```ts
useProjects(): { projects: Project[]; loading: boolean; refresh(): void }
useDoc(project: string|null, base: string|null): {
  doc: EditDoc | null; dirty: boolean; loading: boolean;
  updateSegment(id: number, patch: Partial<Segment>): void;
  save(): Promise<void>; exportDownload(): Promise<void>; reload(): void;
}
useJob(): { start(fn: () => Promise<StartJob>, label: string, onDone?: () => void): Promise<void> }
useTheme(): { theme: 'light' | 'dark'; toggle(): void }
useThresholds(): { thr: Thresholds; setThr(t: Thresholds): void }   // localStorage
```

---

### Task 1: Frontend-Scaffold (Vite + TS + Tailwind v4)

**Files:**
- Create: `webtool/frontend/` (via `npm create vite`), insbesondere `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `src/main.tsx`, `src/index.css`, `index.html`
- Modify: `.gitignore` (Build-Output ignorieren)

**Interfaces:**
- Produces: lauffähiges Vite-Dev-Setup mit funktionierendem Tailwind und `@`-Alias; Build schreibt nach `webtool/static/`.

- [ ] **Step 1: Vite-Projekt anlegen**

Run (im Repo-Root):
```bash
npm create vite@latest webtool/frontend -- --template react-ts
npm --prefix webtool/frontend install
```
Expected: `webtool/frontend/` mit React-TS-Template, `npm install` ohne Fehler.

- [ ] **Step 2: Tailwind v4 + Node-Typen installieren**

Run:
```bash
npm --prefix webtool/frontend install tailwindcss @tailwindcss/vite
npm --prefix webtool/frontend install -D @types/node
```

- [ ] **Step 3: `vite.config.ts` schreiben**

`webtool/frontend/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: { outDir: path.resolve(__dirname, '../static'), emptyOutDir: true },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
})
```

- [ ] **Step 4: `@`-Alias in `tsconfig.app.json` ergänzen**

In `webtool/frontend/tsconfig.app.json` unter `compilerOptions` ergänzen (nicht in `tsconfig.json` — Vite splittet):
```json
"baseUrl": ".",
"paths": { "@/*": ["./src/*"] }
```

- [ ] **Step 5: `src/index.css` auf Tailwind v4 CSS-first umstellen**

`webtool/frontend/src/index.css` komplett ersetzen:
```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));
```
Sicherstellen, dass `src/main.tsx` `import './index.css'` enthält (Template tut das). Etwaige `App.css`-Reste entfernen.

- [ ] **Step 6: Smoke — Tailwind wirkt**

`src/App.tsx` vorübergehend:
```tsx
export default function App() {
  return <h1 className="text-2xl font-bold text-indigo-600 p-4">Transkribor</h1>
}
```
Run: `npm --prefix webtool/frontend run dev` → Seite zeigt indigo-fette Überschrift. Danach Dev-Server stoppen.

- [ ] **Step 7: Build-Output ignorieren**

In `.gitignore` (Repo-Root) ergänzen:
```
# React-Build-Output (aus webtool/frontend), von FastAPI ausgeliefert
webtool/static/
```

- [ ] **Step 8: Build prüft outDir**

Run: `npm --prefix webtool/frontend run build`
Expected: Build ok, `webtool/static/index.html` + `assets/` entstehen (überschreibt alte Vanilla-Dateien — gewollt).

- [ ] **Step 9: Commit**

```bash
git add webtool/frontend .gitignore
git commit -m "feat(webtool): Vite+React+TS+Tailwind4 Scaffold"
```

---

### Task 2: shadcn/ui init + Theme (Studio Cool) + Dark-Mode

**Files:**
- Create: `webtool/frontend/components.json`, `src/lib/utils.ts` (via CLI), `src/components/ui/*` (via CLI), `src/components/ThemeProvider.tsx`, `src/hooks/useTheme.ts`, `src/components/ThemeToggle.tsx`
- Modify: `src/index.css` (Theme-Tokens), `src/main.tsx` (ThemeProvider)

**Interfaces:**
- Produces: `useTheme(): { theme, toggle }`; shadcn-Komponenten verfügbar; Indigo-Akzent/kühles Neutral.

- [ ] **Step 1: shadcn init**

Run: `cd webtool/frontend && npx shadcn@latest init`
Antworten: Style **new-york**, Base color **slate**, CSS variables **yes**. Erzeugt `components.json`, `src/lib/utils.ts`, schreibt OKLCH-Variablen + `.dark`-Block in `src/index.css`.
Expected: kein Fehler; bei React-19-Peer-Warnung mit `--force` erneut.

- [ ] **Step 2: Benötigte Komponenten hinzufügen**

Run:
```bash
npx shadcn@latest add button select slider dialog alert-dialog popover command sonner scroll-area tooltip textarea input badge
```
Expected: Dateien unter `src/components/ui/`, Radix-Deps automatisch installiert.

- [ ] **Step 3: Studio-Cool-Akzent auf Indigo tunen**

In `src/index.css` im `:root`- und `.dark`-Block `--primary` (und `--ring`) auf Indigo setzen, Rest (slate-basiert) belassen:
```css
:root { --primary: oklch(0.51 0.23 277); --primary-foreground: oklch(0.98 0 0); --ring: oklch(0.51 0.23 277); }
.dark { --primary: oklch(0.62 0.19 277); --primary-foreground: oklch(0.98 0 0); --ring: oklch(0.62 0.19 277); }
```
(Indigo ≈ hue 277. Werte sind Startpunkt, im Dogfood feinjustierbar.)

- [ ] **Step 4: ThemeProvider + useTheme**

`src/components/ThemeProvider.tsx`:
```tsx
import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'light' | 'dark'
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'dark', toggle: () => {} })

function initial(): Theme {
  const saved = localStorage.getItem('theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('theme', theme)
  }, [theme])
  return <Ctx.Provider value={{ theme, toggle: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')) }}>{children}</Ctx.Provider>
}
export const useTheme = () => useContext(Ctx)
```

- [ ] **Step 5: Toaster + Provider einhängen**

`src/main.tsx`: App in `<ThemeProvider>` wrappen und `<Toaster richColors position="bottom-right" />` (aus `@/components/ui/sonner`) rendern.

- [ ] **Step 6: ThemeToggle**

`src/components/ThemeToggle.tsx`:
```tsx
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/components/ThemeProvider'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return <Button variant="ghost" size="icon" onClick={toggle} aria-label="Theme umschalten">
    {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
  </Button>
}
```

- [ ] **Step 7: Smoke**

In `App.tsx` `<ThemeToggle />` + eine `<Button>` rendern; `npm run dev` → Toggle schaltet Light/Dark (localStorage bleibt). Danach stoppen.

- [ ] **Step 8: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): shadcn/ui init + Studio-Cool-Theme + Dark-Mode-Toggle"
```

---

### Task 3: Typen + API-Client

**Files:**
- Create: `src/lib/types.ts`, `src/lib/api.ts`, `src/lib/api.test.ts`
- Modify: `package.json` (vitest), `vite.config.ts` (test-Config) oder `vitest.config.ts`

**Interfaces:**
- Produces: alle Typen aus „Shared Contracts"; `api.*`-Funktionen.
- Consumes: nichts.

- [ ] **Step 1: Vitest installieren + konfigurieren**

Run:
```bash
npm --prefix webtool/frontend install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```
In `package.json` `"scripts"` ergänzen: `"test": "vitest run"`, `"test:watch": "vitest"`.
`vitest.config.ts` anlegen:
```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/setupTests.ts'] },
})
```
`src/setupTests.ts`: `import '@testing-library/jest-dom'`

- [ ] **Step 2: Typen anlegen**

`src/lib/types.ts` = exakt der Block aus „Shared Contracts → types.ts".

- [ ] **Step 3: Failing test für `audioUrl`**

`src/lib/api.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { audioUrl } from './api'

describe('audioUrl', () => {
  it('encodiert Projekt und base', () => {
    expect(audioUrl('Food Festival', 'C0687/x')).toBe(
      '/api/projects/Food%20Festival/audio/C0687%2Fx')
  })
})
```

- [ ] **Step 4: Test schlägt fehl**

Run: `npm --prefix webtool/frontend test`
Expected: FAIL (`audioUrl` nicht exportiert).

- [ ] **Step 5: `api.ts` implementieren**

`src/lib/api.ts`:
```ts
import type { Project, EditDoc, JobStatus, StartJob } from './types'

const enc = encodeURIComponent
async function jn<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
  return r.json() as Promise<T>
}

export function audioUrl(project: string, base: string) {
  return `/api/projects/${enc(project)}/audio/${enc(base)}`
}
export async function listProjects(): Promise<Project[]> {
  return (await jn<{ projects: Project[] }>(await fetch('/api/projects'))).projects
}
export async function getDoc(project: string, base: string): Promise<EditDoc> {
  return jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`))
}
export async function saveDoc(project: string, base: string, doc: EditDoc): Promise<void> {
  await jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) }))
}
export async function exportMd(project: string, base: string): Promise<string> {
  return (await jn<{ md: string }>(await fetch(
    `/api/projects/${enc(project)}/files/${enc(base)}/export`, { method: 'POST' }))).md
}
const post = (u: string) => fetch(u, { method: 'POST' })
export async function startTranscribe(project: string): Promise<StartJob> {
  return jn(await post(`/api/projects/${enc(project)}/transcribe`))
}
export async function startCorrect(project: string): Promise<StartJob> {
  return jn(await post(`/api/projects/${enc(project)}/correct`))
}
export async function startCorrectFile(project: string, base: string, force: boolean): Promise<StartJob> {
  return jn(await post(`/api/projects/${enc(project)}/files/${enc(base)}/correct${force ? '?force=true' : ''}`))
}
export async function getJob(jobId: string): Promise<JobStatus> {
  return jn(await fetch(`/api/jobs/${enc(jobId)}`))
}
export async function cancelJob(jobId: string): Promise<void> {
  await post(`/api/jobs/${enc(jobId)}/cancel`)
}
export async function uploadAudio(project: string, file: File): Promise<{ base: string; file: string }> {
  const fd = new FormData(); fd.append('file', file)
  return jn(await fetch(`/api/projects/${enc(project)}/audio`, { method: 'POST', body: fd }))
}
```

- [ ] **Step 6: Test grün**

Run: `npm --prefix webtool/frontend test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): TS-Typen + API-Client + Vitest-Setup"
```

---

### Task 4: `lib/grouping.ts` — Sprecher-Redebeiträge (TDD)

**Files:**
- Create: `src/lib/grouping.ts`, `src/lib/grouping.test.ts`

**Interfaces:**
- Consumes: `Segment`, `Turn` (types.ts).
- Produces: `groupIntoTurns(segments): Turn[]`.

- [ ] **Step 1: Failing test**

`src/lib/grouping.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { groupIntoTurns } from './grouping'
import type { Segment } from './types'

const seg = (id: number, speaker: string): Segment => ({
  id, start: id, end: id + 1, speaker, raw_text: '', text: '', words: [],
  flags: { hallucination: false, silence: false, low_conf: false }, note: '',
})

describe('groupIntoTurns', () => {
  it('bündelt aufeinanderfolgende gleiche Sprecher', () => {
    const t = groupIntoTurns([seg(0, 'A'), seg(1, 'A'), seg(2, 'B'), seg(3, 'A')])
    expect(t.map(x => x.speaker)).toEqual(['A', 'B', 'A'])
    expect(t[0].segments.map(s => s.id)).toEqual([0, 1])
    expect(t.map(x => x.key)).toHaveLength(3)
    expect(new Set(t.map(x => x.key)).size).toBe(3) // Keys eindeutig
  })
  it('leerer Sprecher bleibt eigener Block', () => {
    const t = groupIntoTurns([seg(0, ''), seg(1, 'A')])
    expect(t).toHaveLength(2)
    expect(t[0].speaker).toBe('')
  })
  it('leere Eingabe -> leeres Array', () => {
    expect(groupIntoTurns([])).toEqual([])
  })
})
```

- [ ] **Step 2: Test schlägt fehl**

Run: `npm --prefix webtool/frontend test grouping` → FAIL.

- [ ] **Step 3: Implementieren**

`src/lib/grouping.ts`:
```ts
import type { Segment, Turn } from './types'

export function groupIntoTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = []
  for (const s of segments) {
    const last = turns[turns.length - 1]
    if (last && last.speaker === s.speaker) last.segments.push(s)
    else turns.push({ key: `turn-${s.id}`, speaker: s.speaker, segments: [s] })
  }
  return turns
}
```

- [ ] **Step 4: Test grün**

Run: `npm --prefix webtool/frontend test grouping` → PASS.

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/lib/grouping.ts webtool/frontend/src/lib/grouping.test.ts
git commit -m "feat(webtool): groupIntoTurns (Sprecher-Redebeiträge) + Test"
```

---

### Task 5: `lib/playback.ts` — Puffer-Fenster (TDD)

**Files:**
- Create: `src/lib/playback.ts`, `src/lib/playback.test.ts`

**Interfaces:**
- Produces: `PAD`, `playWindow(seg, duration)`.

- [ ] **Step 1: Failing test** (portiert vom bestehenden Node-Check der Vanilla-Version)

`src/lib/playback.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { playWindow } from './playback'

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

describe('playWindow', () => {
  it.each([
    [{ start: 18.36, end: 20.06 }, 60, 18.21, 20.41],
    [{ start: 31.98, end: 42.76 }, 60, 31.83, 43.11],
    [{ start: 0.05, end: 2.0 }, 60, 0.0, 2.35],   // Pre-Roll auf 0 geklemmt
    [{ start: 50.0, end: 59.9 }, 60, 49.85, 60.0], // Post-Roll auf Dauer geklemmt
    [{ start: 5.0, end: 6.0 }, NaN, 4.85, 6.35],   // Dauer unbekannt -> kein oberes Clamp
  ])('bracketet Segment mit Lead-in/out', (seg, dur, ef, et) => {
    const { from, to } = playWindow(seg as any, dur as number)
    expect(near(from, ef)).toBe(true)
    expect(near(to, et)).toBe(true)
  })
})
```

- [ ] **Step 2: Test schlägt fehl**

Run: `npm --prefix webtool/frontend test playback` → FAIL.

- [ ] **Step 3: Implementieren**

`src/lib/playback.ts`:
```ts
export const PAD = { in: 0.15, out: 0.35 }

export function playWindow(seg: { start: number; end: number }, duration: number) {
  const from = Math.max(0, seg.start - PAD.in)
  const end = seg.end + PAD.out
  return { from, to: Number.isFinite(duration) ? Math.min(duration, end) : end }
}
```

- [ ] **Step 4: Test grün** — Run: `npm --prefix webtool/frontend test playback` → PASS.

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/lib/playback.ts webtool/frontend/src/lib/playback.test.ts
git commit -m "feat(webtool): playWindow Lead-in/out-Puffer + Test"
```

---

### Task 6: `lib/uncertainty.ts` — Unsicherheits-Tokenisierung (TDD)

**Files:**
- Create: `src/lib/uncertainty.ts`, `src/lib/uncertainty.test.ts`

**Interfaces:**
- Consumes: `Segment`, `Thresholds`, `Word`.
- Produces: `isCorrected(seg)`, `tokenizeUncertain(seg, thr): Token[]` mit `Token = { text, cls }`.

**Logik:** Bei unkorrigierten Segmenten (`text === raw_text`) werden die `words` in Reihenfolge gerendert; ein Wort bekommt `u-red` wenn `probability < thr.red`, `u-yellow` wenn `< thr.yellow` **und** kein Randwort (erstes/letztes) — Randwörter erst ab Rot (Regel aus der Vanilla-Version). Token enthält die Original-`word`-Strings (inkl. führender Leerzeichen).

- [ ] **Step 1: Failing test**

`src/lib/uncertainty.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { isCorrected, tokenizeUncertain } from './uncertainty'
import type { Segment } from './types'

const w = (word: string, probability: number) => ({ word, start: null, end: null, probability })
const base = (over: Partial<Segment>): Segment => ({
  id: 1, start: 0, end: 1, speaker: '', raw_text: 'a b c', text: 'a b c',
  words: [w('a', 0.9), w(' b', 0.3), w(' c', 0.5)],
  flags: { hallucination: false, silence: false, low_conf: false }, note: '', ...over,
})
const thr = { yellow: 0.6, red: 0.4 }

describe('uncertainty', () => {
  it('isCorrected erkennt geänderten Text', () => {
    expect(isCorrected(base({}))).toBe(false)
    expect(isCorrected(base({ text: 'a B c' }))).toBe(true)
  })
  it('färbt mittleres Wort nach Konfidenz, Ränder geschützt', () => {
    const y = base({ words: [w('a', 0.9), w(' b', 0.5), w(' c', 0.9)] })
    expect(tokenizeUncertain(y, thr).map(x => x.cls)).toEqual(['', 'u-yellow', ''])
    const r = base({ words: [w('a', 0.9), w(' b', 0.3), w(' c', 0.9)] })
    expect(tokenizeUncertain(r, thr).map(x => x.cls)).toEqual(['', 'u-red', ''])
  })
  it('Randwörter (erstes UND letztes) nur ab rot', () => {
    const f = base({ words: [w('a', 0.5), w(' b', 0.9), w(' c', 0.9)] })
    expect(tokenizeUncertain(f, thr)[0].cls).toBe('')            // erstes, gelb-Bereich -> geschützt
    const fr = base({ words: [w('a', 0.3), w(' b', 0.9), w(' c', 0.9)] })
    expect(tokenizeUncertain(fr, thr)[0].cls).toBe('u-red')      // erstes, rot -> gefärbt
    const l = base({ words: [w('a', 0.9), w(' b', 0.9), w(' c', 0.5)] })
    expect(tokenizeUncertain(l, thr)[2].cls).toBe('')            // letztes, gelb-Bereich -> geschützt
    const lr = base({ words: [w('a', 0.9), w(' b', 0.9), w(' c', 0.3)] })
    expect(tokenizeUncertain(lr, thr)[2].cls).toBe('u-red')      // letztes, rot -> gefärbt
  })
  it('behält Token-Text inkl. führender Leerzeichen', () => {
    expect(tokenizeUncertain(base({}), thr).map(x => x.text)).toEqual(['a', ' b', ' c'])
  })
})
```

- [ ] **Step 2: Test schlägt fehl** — Run: `npm --prefix webtool/frontend test uncertainty` → FAIL.

- [ ] **Step 3: Implementieren**

`src/lib/uncertainty.ts`:
```ts
import type { Segment, Thresholds } from './types'

export type Token = { text: string; cls: '' | 'u-yellow' | 'u-red' }

export function isCorrected(seg: Segment): boolean {
  return (seg.text || '').trim() !== (seg.raw_text || '').trim()
}

export function tokenizeUncertain(seg: Segment, thr: Thresholds): Token[] {
  const n = seg.words.length
  return seg.words.map((w, i) => {
    const p = w.probability ?? 1
    const isEdge = i === 0 || i === n - 1
    let cls: Token['cls'] = ''
    if (p < thr.red) cls = 'u-red'
    else if (!isEdge && p < thr.yellow) cls = 'u-yellow'
    return { text: w.word, cls }
  })
}
```

- [ ] **Step 4: Test grün** — Run: `npm --prefix webtool/frontend test uncertainty` → PASS.

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/lib/uncertainty.ts webtool/frontend/src/lib/uncertainty.test.ts
git commit -m "feat(webtool): uncertainty-Tokenisierung + isCorrected + Test"
```

---

### Task 7: Daten-Hooks + App-Shell/Layout

**Files:**
- Create: `src/hooks/useProjects.ts`, `src/hooks/useDoc.ts`, `src/hooks/useThresholds.ts`, `src/components/Toolbar.tsx`, `src/components/PlayerDock.tsx` (Skelett), `src/App.tsx` (Layout)
- Modify: —

**Interfaces:**
- Consumes: `api.*`, Typen.
- Produces: `useProjects`, `useDoc`, `useThresholds`; App-Grid (Sidebar-Slot | Transcript-Slot | PlayerDock).

- [ ] **Step 1: `useThresholds` (localStorage)**

`src/hooks/useThresholds.ts`:
```ts
import { useState } from 'react'
import type { Thresholds } from '@/lib/types'
const KEY = 'thresholds'
const load = (): Thresholds => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || ''); if (v && typeof v.yellow === 'number') return v } catch {}
  return { yellow: 0.6, red: 0.4 }
}
export function useThresholds() {
  const [thr, setThrState] = useState<Thresholds>(load)
  const setThr = (t: Thresholds) => { setThrState(t); localStorage.setItem(KEY, JSON.stringify(t)) }
  return { thr, setThr }
}
```

- [ ] **Step 2: `useProjects`**

`src/hooks/useProjects.ts`:
```ts
import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@/lib/types'
import { listProjects } from '@/lib/api'

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(() => {
    setLoading(true)
    listProjects().then(setProjects).catch(() => setProjects([])).finally(() => setLoading(false))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  return { projects, loading, refresh }
}
```

- [ ] **Step 3: `useDoc`**

`src/hooks/useDoc.ts`:
```ts
import { useCallback, useEffect, useState } from 'react'
import type { EditDoc, Segment } from '@/lib/types'
import { getDoc, saveDoc, exportMd } from '@/lib/api'

export function useDoc(project: string | null, base: string | null) {
  const [doc, setDoc] = useState<EditDoc | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(() => {
    if (!project || !base) { setDoc(null); return }
    setLoading(true)
    getDoc(project, base).then(d => { setDoc(d); setDirty(false) })
      .catch(() => setDoc(null)).finally(() => setLoading(false))
  }, [project, base])
  useEffect(() => { reload() }, [reload])

  const updateSegment = useCallback((id: number, patch: Partial<Segment>) => {
    setDoc(d => d && ({ ...d, segments: d.segments.map(s => s.id === id ? { ...s, ...patch } : s) }))
    setDirty(true)
  }, [])

  const save = useCallback(async () => {
    if (!doc || !project || !base) return
    await saveDoc(project, base, doc); setDirty(false)
  }, [doc, project, base])

  const exportDownload = useCallback(async () => {
    if (!project || !base) return
    const md = await exportMd(project, base)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    a.download = `${base}.md`; a.click()
  }, [project, base])

  return { doc, dirty, loading, updateSegment, save, exportDownload, reload }
}
```

- [ ] **Step 4: Toolbar**

`src/components/Toolbar.tsx`:
```tsx
import { Button } from '@/components/ui/button'
import { ThemeToggle } from './ThemeToggle'

export function Toolbar({ title, dirty, canSave, onSave, onExport, settings }: {
  title: string; dirty: boolean; canSave: boolean;
  onSave: () => void; onExport: () => void; settings: React.ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 border-b px-3 py-2">
      <span className="text-sm font-medium truncate">{title}</span>
      {dirty && <span className="text-xs text-muted-foreground">● ungespeichert</span>}
      <div className="flex-1" />
      {settings}
      <Button size="sm" variant="secondary" disabled={!canSave} onClick={onSave}>Speichern</Button>
      <Button size="sm" variant="secondary" disabled={!canSave} onClick={onExport}>Export .md</Button>
      <ThemeToggle />
    </header>
  )
}
```

- [ ] **Step 5: PlayerDock-Skelett**

`src/components/PlayerDock.tsx`:
```tsx
export function PlayerDock({ children }: { children?: React.ReactNode }) {
  return <footer className="border-t px-3 py-2">{children ?? <div className="h-[72px]" />}</footer>
}
```

- [ ] **Step 6: App-Layout**

`src/App.tsx`:
```tsx
import { useMemo, useState } from 'react'
import { useProjects } from '@/hooks/useProjects'
import { useDoc } from '@/hooks/useDoc'
import { Toolbar } from '@/components/Toolbar'
import { PlayerDock } from '@/components/PlayerDock'

export default function App() {
  const { projects, refresh } = useProjects()
  const [sel, setSel] = useState<{ project: string; base: string } | null>(null)
  const { doc, dirty, updateSegment, save, exportDownload } = useDoc(sel?.project ?? null, sel?.base ?? null)
  const title = useMemo(() => (sel ? `${sel.project} / ${sel.base}` : '— keine Datei —'), [sel])

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]">
      <aside className="row-span-3 border-r overflow-auto">
        {/* Task 8: <Sidebar projects={projects} onOpen={setSel} onRefresh={refresh} active={sel} /> */}
      </aside>
      <div className="col-start-2"><Toolbar title={title} dirty={dirty} canSave={!!doc}
        onSave={save} onExport={exportDownload} settings={null} /></div>
      <main className="col-start-2 overflow-auto">
        {/* Task 10/11: <Transcript doc={doc} updateSegment={updateSegment} ... /> */}
      </main>
      <div className="col-start-2"><PlayerDock /></div>
    </div>
  )
}
```

- [ ] **Step 7: Smoke** — `npm run dev`: leeres 3-Zonen-Layout + Toolbar rendern ohne Fehler (Konsole prüfen). Stoppen.

- [ ] **Step 8: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): Daten-Hooks (useProjects/useDoc/useThresholds) + App-Layout"
```

---

### Task 8: Sidebar — Projekte, Dateien, Upload, Öffnen

**Files:**
- Create: `src/components/Sidebar.tsx`, `src/components/FileRow.tsx`
- Modify: `src/App.tsx` (Sidebar einhängen)

**Interfaces:**
- Consumes: `Project`, `useProjects().refresh`, `uploadAudio`; Job-Start-Funktionen kommen aus Task 12 (hier zunächst als Props durchgereicht/Platzhalter `onTranscribe`/`onCorrect`/`onCorrectFile`).
- Produces: `Sidebar` ruft `onOpen({project, base})`.

- [ ] **Step 1: FileRow**

`src/components/FileRow.tsx`:
```tsx
import { Pencil } from 'lucide-react'
import type { ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function FileRow({ file, active, onOpen, onCorrectFile }: {
  file: ProjectFile; active: boolean;
  onOpen: () => void; onCorrectFile: () => void;
}) {
  const badge = file.has_edit ? '✎' : file.has_md ? '✓' : file.has_audio ? '●' : ''
  return (
    <div onClick={onOpen}
      className={cn('flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer hover:bg-accent',
        active && 'bg-accent')}>
      <span className="flex-1 truncate">{file.base} <span className="text-muted-foreground text-xs">{badge}</span></span>
      <Button size="icon" variant="ghost" className="size-6" title="Nur diese Datei korrigieren"
        onClick={e => { e.stopPropagation(); onCorrectFile() }}><Pencil className="size-3" /></Button>
    </div>
  )
}
```

- [ ] **Step 2: Sidebar**

`src/components/Sidebar.tsx`:
```tsx
import { useRef } from 'react'
import { Upload, Play, Pencil } from 'lucide-react'
import type { Project } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { FileRow } from './FileRow'

type Sel = { project: string; base: string } | null
export function Sidebar({ projects, active, onOpen, onUpload, onTranscribe, onCorrect, onCorrectFile }: {
  projects: Project[]; active: Sel;
  onOpen: (s: { project: string; base: string }) => void;
  onUpload: (project: string, file: File) => void;
  onTranscribe: (project: string) => void;
  onCorrect: (project: string) => void;
  onCorrectFile: (project: string, base: string, hasEdit: boolean) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingProject = useRef<string>('')
  return (
    <div className="p-3">
      <h1 className="mb-3 text-lg font-semibold">Transkribor</h1>
      <input ref={fileInput} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(pendingProject.current, f); e.target.value = '' }} />
      {projects.map(p => (
        <div key={p.name} className="mb-3">
          <div className="flex items-center gap-1">
            <span className="flex-1 font-medium text-sm">{p.name}</span>
            <Button size="icon" variant="ghost" className="size-6" title="Audio hochladen"
              onClick={() => { pendingProject.current = p.name; fileInput.current?.click() }}><Upload className="size-3.5" /></Button>
            <Button size="icon" variant="ghost" className="size-6" title="Transkribieren"
              onClick={() => onTranscribe(p.name)}><Play className="size-3.5" /></Button>
            <Button size="icon" variant="ghost" className="size-6" title="Korrigieren + Sprecher"
              onClick={() => onCorrect(p.name)}><Pencil className="size-3.5" /></Button>
          </div>
          {p.files.map(f => (
            <FileRow key={f.base} file={f}
              active={active?.project === p.name && active?.base === f.base}
              onOpen={() => onOpen({ project: p.name, base: f.base })}
              onCorrectFile={() => onCorrectFile(p.name, f.base, f.has_edit)} />
          ))}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: In App einhängen (temporäre Job-Handler)**

In `src/App.tsx` `<Sidebar .../>` im `<aside>` rendern. Vorläufige Handler bis Task 12:
```tsx
import { uploadAudio } from '@/lib/api'
// ...
const onUpload = async (project: string, file: File) => { await uploadAudio(project, file); refresh() }
const noop = () => {}
// <Sidebar projects={projects} active={sel} onOpen={setSel} onUpload={onUpload}
//   onTranscribe={noop} onCorrect={noop} onCorrectFile={noop} />
```

- [ ] **Step 4: Smoke-Test (RTL)**

`src/components/Sidebar.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'

const projects = [{ name: 'P', files: [{ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }] }]

describe('Sidebar', () => {
  it('öffnet Datei bei Klick', () => {
    const onOpen = vi.fn()
    render(<Sidebar projects={projects} active={null} onOpen={onOpen} onUpload={vi.fn()}
      onTranscribe={vi.fn()} onCorrect={vi.fn()} onCorrectFile={vi.fn()} />)
    fireEvent.click(screen.getByText(/^a/))
    expect(onOpen).toHaveBeenCalledWith({ project: 'P', base: 'a' })
  })
})
```

- [ ] **Step 5: Tests grün** — Run: `npm --prefix webtool/frontend test` → PASS.

- [ ] **Step 6: Dogfood** — mit laufendem `uvicorn` (:8000) `npm run dev`: Projektliste lädt, Datei öffnet (Titel in Toolbar wechselt). Stoppen.

- [ ] **Step 7: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): Sidebar (Projekte/Dateien/Upload/Öffnen)"
```

---

### Task 9: Waveform + Segment-Playback

**Files:**
- Create: `src/components/Waveform.tsx`, `src/hooks/usePlayer.ts`
- Modify: `src/components/PlayerDock.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: `@wavesurfer/react`, `playWindow`, `audioUrl`, `useTheme`.
- Produces: `Waveform` mit `ref`-API `{ playSegment(seg), playTurn(segs) }`; `currentTime` nach oben für Highlight.

- [ ] **Step 1: Deps**

Run: `npm --prefix webtool/frontend install wavesurfer.js @wavesurfer/react`

- [ ] **Step 2: Waveform-Komponente**

`src/components/Waveform.tsx`:
```tsx
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useWavesurfer } from '@wavesurfer/react'
import { playWindow } from '@/lib/playback'
import { useTheme } from '@/components/ThemeProvider'
import type { Segment } from '@/lib/types'

export type WaveHandle = { playSegment: (s: Segment) => void; playTurn: (s: Segment[]) => void }

export const Waveform = forwardRef<WaveHandle, { url: string; onTime: (t: number) => void }>(
  function Waveform({ url, onTime }, ref) {
    const container = useRef<HTMLDivElement>(null)
    const { theme } = useTheme()
    const { wavesurfer } = useWavesurfer({
      container, url, height: 72, barWidth: 2, barGap: 1,
      waveColor: theme === 'dark' ? '#3f4657' : '#b9c6d6',
      progressColor: theme === 'dark' ? '#7b86f0' : '#4f5bd3',
    })
    useEffect(() => {
      if (!wavesurfer) return
      const off = wavesurfer.on('timeupdate', (t: number) => onTime(t))
      return () => off()
    }, [wavesurfer, onTime])
    useEffect(() => { wavesurfer?.setOptions({
      waveColor: theme === 'dark' ? '#3f4657' : '#b9c6d6',
      progressColor: theme === 'dark' ? '#7b86f0' : '#4f5bd3' }) }, [theme, wavesurfer])

    useImperativeHandle(ref, () => ({
      playSegment(s) {
        if (!wavesurfer) return
        const { from, to } = playWindow(s, wavesurfer.getDuration())
        wavesurfer.play(from, to)
      },
      playTurn(segs) {
        if (!wavesurfer || !segs.length) return
        const dur = wavesurfer.getDuration()
        const from = playWindow(segs[0], dur).from
        const to = playWindow(segs[segs.length - 1], dur).to
        wavesurfer.play(from, to)
      },
    }), [wavesurfer])

    return <div ref={container} />
  })
```

- [ ] **Step 3: PlayerDock nutzt Waveform**

`PlayerDock.tsx` erweitern, sodass es `url` bekommt und `<Waveform>` samt `ref` rendert (Play/Pause-Button via `wavesurfer.playPause()` optional). App reicht `audioUrl(project, base)` + einen `waveRef` durch, wenn eine Datei offen ist.

- [ ] **Step 4: Highlight-State**

In `App.tsx` `currentTime` als State halten (`onTime`), an `<Transcript>` (Task 10) durchreichen; das aktive Segment ist das mit `start <= t < end`.

- [ ] **Step 5: Dogfood** — Datei öffnen, Wellenform lädt; ein Testaufruf `waveRef.current?.playSegment(seg)` spielt mit Puffer (Anfang/Ende nicht abgeschnitten). Theme-Wechsel färbt Wellenform um. Stoppen.

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): wavesurfer-React Waveform + Segment/Turn-Playback mit Puffer"
```

---

### Task 10: Transcript — Redebeiträge, Segment-Anzeige, Unsicherheit, Schwellen

**Files:**
- Create: `src/components/Transcript.tsx`, `src/components/SpeakerTurn.tsx`, `src/components/SegmentView.tsx`, `src/components/UncertainWord.tsx`, `src/components/ThresholdPopover.tsx`
- Modify: `src/index.css` (`.u-yellow`/`.u-red`), `src/App.tsx`

**Interfaces:**
- Consumes: `groupIntoTurns`, `tokenizeUncertain`, `isCorrected`, `useThresholds`, `WaveHandle`, `Segment`, `Turn`.
- Produces: `Transcript` rendert Turns; ruft `wave.playSegment/playTurn`; markiert aktives Segment via `currentTime`.

- [ ] **Step 1: Unsicherheits-CSS**

`src/index.css` ergänzen:
```css
.u-yellow { text-decoration: underline dotted 2px; text-underline-offset: 3px; color: var(--color-amber-600, #d9a300); }
.u-red { text-decoration: underline dotted 2px; text-underline-offset: 3px; color: var(--color-red-500, #d05a5a); background: color-mix(in srgb, currentColor 9%, transparent); }
```

- [ ] **Step 2: UncertainWord**

`src/components/UncertainWord.tsx`:
```tsx
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Word } from '@/lib/types'

export function UncertainWord({ word, cls }: { word: Word; cls: 'u-yellow' | 'u-red' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={cls}>{word.word}</span></TooltipTrigger>
      <TooltipContent>Roh: „{word.word.trim()}" · {(word.probability ?? 1).toFixed(2)}</TooltipContent>
    </Tooltip>
  )
}
```

- [ ] **Step 3: SegmentView (read-only + Play + Unsicherheit)**

`src/components/SegmentView.tsx`:
```tsx
import { Play } from 'lucide-react'
import type { Segment, Thresholds } from '@/lib/types'
import { isCorrected, tokenizeUncertain } from '@/lib/uncertainty'
import { UncertainWord } from './UncertainWord'

function fmt(t: number) { const s = Math.max(0, t | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}` }

export function SegmentView({ seg, thr, active, onPlay, onEdit }: {
  seg: Segment; thr: Thresholds; active: boolean; onPlay: () => void; onEdit: () => void;
}) {
  const flags = [seg.flags.hallucination && '⚠', seg.flags.silence && '🔇', seg.flags.low_conf && '~'].filter(Boolean).join(' ')
  const body = !isCorrected(seg)
    ? tokenizeUncertain(seg, thr).map((t, i) => t.cls
        ? <UncertainWord key={i} word={seg.words[i]} cls={t.cls} />
        : <span key={i}>{t.text}</span>)
    : seg.text
  return (
    <div className={`group relative rounded px-2 py-1 ${active ? 'bg-primary/10' : ''}`}>
      <button onClick={onPlay} title="Abspielen"
        className="absolute -left-5 top-1.5 opacity-0 group-hover:opacity-100 text-primary text-xs">▶</button>
      <span className="mr-2 align-top text-[10px] text-muted-foreground select-none">{fmt(seg.start)} {flags}</span>
      <span onClick={onEdit} className="cursor-text leading-relaxed">{body}</span>
    </div>
  )
}
```
*(`Play`-Import optional; hier ▶ als Textglyph für Kompaktheit.)*

- [ ] **Step 4: SpeakerTurn (Block-Kopf + Segmente)**

`src/components/SpeakerTurn.tsx`:
```tsx
import type { Segment, Thresholds, Turn } from '@/lib/types'
import { SegmentView } from './SegmentView'

function color(speaker: string) { // stabile Farbe je Name (Interviewer/Befragte unterscheidbar)
  let h = 0; for (const c of speaker) h = (h * 31 + c.charCodeAt(0)) % 360
  return `oklch(0.65 0.15 ${h})`
}
export function SpeakerTurn({ turn, thr, activeId, onPlaySeg, onPlayTurn, onEdit }: {
  turn: Turn; thr: Thresholds; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void; onEdit: (id: number) => void;
}) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 border-l-2 py-2 pl-3"
      style={{ borderColor: turn.speaker ? color(turn.speaker) : 'transparent' }}>
      <button onClick={() => onPlayTurn(turn.segments)} className="text-left text-sm font-semibold"
        style={{ color: turn.speaker ? color(turn.speaker) : undefined }}>
        {turn.speaker || '(kein Sprecher)'} <span className="opacity-50">▶</span>
      </button>
      <div>
        {turn.segments.map(s => (
          <SegmentView key={s.id} seg={s} thr={thr} active={activeId === s.id}
            onPlay={() => onPlaySeg(s)} onEdit={() => onEdit(s.id)} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Transcript**

`src/components/Transcript.tsx`:
```tsx
import { useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { EditDoc, Segment, Thresholds } from '@/lib/types'
import { groupIntoTurns } from '@/lib/grouping'
import { SpeakerTurn } from './SpeakerTurn'

export function Transcript({ doc, thr, currentTime, onPlaySeg, onPlayTurn, onEdit }: {
  doc: EditDoc | null; thr: Thresholds; currentTime: number;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void; onEdit: (id: number) => void;
}) {
  const turns = useMemo(() => (doc ? groupIntoTurns(doc.segments) : []), [doc])
  const activeId = useMemo(() => doc?.segments.find(s => currentTime >= s.start && currentTime < s.end)?.id ?? null, [doc, currentTime])
  if (!doc) return <div className="p-8 text-center text-muted-foreground">Keine Datei geöffnet.</div>
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl p-4">
        {turns.map(t => (
          <SpeakerTurn key={t.key} turn={t} thr={thr} activeId={activeId}
            onPlaySeg={onPlaySeg} onPlayTurn={onPlayTurn} onEdit={onEdit} />
        ))}
        {doc.annotations.length > 0 && (
          <section className="mt-8 border-t pt-4">
            <h2 className="mb-2 text-sm font-semibold">Anmerkungen</h2>
            <ul className="list-disc pl-5 text-sm text-muted-foreground">{doc.annotations.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
```

- [ ] **Step 6: ThresholdPopover**

`src/components/ThresholdPopover.tsx`:
```tsx
import { Settings } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import type { Thresholds } from '@/lib/types'

export function ThresholdPopover({ thr, setThr }: { thr: Thresholds; setThr: (t: Thresholds) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild><Button size="icon" variant="ghost" aria-label="Einstellungen"><Settings className="size-4" /></Button></PopoverTrigger>
      <PopoverContent className="w-64 space-y-4">
        <div><div className="mb-1 flex justify-between text-xs"><span>gelb &lt;</span><span>{thr.yellow.toFixed(2)}</span></div>
          <Slider min={0} max={1} step={0.05} value={[thr.yellow]} onValueChange={([v]) => setThr({ ...thr, yellow: v })} /></div>
        <div><div className="mb-1 flex justify-between text-xs"><span>rot &lt;</span><span>{thr.red.toFixed(2)}</span></div>
          <Slider min={0} max={1} step={0.05} value={[thr.red]} onValueChange={([v]) => setThr({ ...thr, red: v })} /></div>
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **Step 7: In App verdrahten** — `useThresholds` in App; `<Transcript>` in `<main>`, `settings={<ThresholdPopover .../>}` in Toolbar; `onPlaySeg/onPlayTurn` → `waveRef.current`.

- [ ] **Step 8: Smoke-Test (RTL)**

`src/components/Transcript.test.tsx`: rendert ein Doc mit 2 Segmenten (A, B) und prüft, dass zwei Sprecher-Labels erscheinen und unkorrigierte unsichere Wörter eine `.u-red`-Klasse tragen.

- [ ] **Step 9: Tests grün + Dogfood** — `npm test` PASS; im Dev echtes Transkript: Redebeiträge, Unsicherheit inline, Klick spielt Segment/Redebeitrag, aktives Segment hervorgehoben, Schwellen-Popover ändert Färbung.

- [ ] **Step 10: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): Transcript/Redebeiträge + Unsicherheit inline + Schwellen-Popover"
```

---

### Task 11: Segment-Editor (textarea-Split) + Sprecher-Combobox

**Files:**
- Create: `src/components/SegmentEditor.tsx`, `src/components/SpeakerCombobox.tsx`
- Modify: `src/components/SegmentView.tsx` (Edit-Umschaltung), `src/components/SpeakerTurn.tsx` (Sprecher pro Segment), `src/index.css` (field-sizing utility optional)

**Interfaces:**
- Consumes: `updateSegment`, `Segment`, Vorschlagsliste (Sprecher).
- Produces: `SegmentEditor` (uncontrolled textarea, `onCommit(text)`); `SpeakerCombobox` (Freitext + Vorschläge, `onChange(value)`).

- [ ] **Step 1: SegmentEditor (uncontrolled, auto-grow)**

`src/components/SegmentEditor.tsx`:
```tsx
import { useRef } from 'react'
import { Textarea } from '@/components/ui/textarea'

export function SegmentEditor({ initial, onCommit, onCancel }: {
  initial: string; onCommit: (text: string) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <Textarea ref={ref} defaultValue={initial} autoFocus
      style={{ fieldSizing: 'content' } as React.CSSProperties}
      className="min-h-0 resize-none leading-relaxed"
      onBlur={e => onCommit(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(e.currentTarget.value) }
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }} />
  )
}
```
**Wichtig:** `defaultValue` (uncontrolled) — den Wert NIE pro Keystroke aus dem State neu setzen (Cursor-Sprung). Commit nur bei Blur/⌘Enter.

- [ ] **Step 2: SegmentView Edit-Umschaltung**

`SegmentView` bekommt einen lokalen `editing`-State: Klick auf den Text setzt `editing=true` und rendert `<SegmentEditor initial={seg.text} onCommit={t => { updateSegment(seg.id,{text:t}); setEditing(false) }} onCancel={() => setEditing(false)} />` statt des read-only-Bodys. `updateSegment` als Prop durchreichen.

- [ ] **Step 3: SpeakerCombobox (Popover + Command, Freitext erlaubt)**

`src/components/SpeakerCombobox.tsx`:
```tsx
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'

export function SpeakerCombobox({ value, options, onChange }: {
  value: string; options: string[]; onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const commit = (v: string) => { onChange(v); setOpen(false) }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-1 text-xs font-normal text-muted-foreground">
          {value || 'Sprecher…'}</Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Sprecher…" value={query} onValueChange={setQuery}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim()) { e.preventDefault(); commit(query.trim()) } }} />
          <CommandList>
            <CommandGroup>
              {query.trim() && !options.includes(query.trim()) &&
                <CommandItem value={query} onSelect={() => commit(query.trim())}>„{query.trim()}" übernehmen</CommandItem>}
              {options.map(o => <CommandItem key={o} value={o} onSelect={() => commit(o)}>{o}</CommandItem>)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **Step 4: Sprecher pro Segment einbauen**

In `SpeakerTurn`: Vorschlagsliste = Union aus `doc.speakers` + allen `seg.speaker` (als Prop `speakerOptions` reingeben). Der Block-Kopf zeigt den Sprecher des ersten Segments; pro Segment im read-only-View eine kompakte `<SpeakerCombobox value={seg.speaker} options={speakerOptions} onChange={v => updateSegment(seg.id,{speaker:v})} />` (z.B. links neben/über dem Segmenttext, dezent). Da Sprecher pro Segment editierbar ist, teilt sich der Block bei der nächsten `groupIntoTurns`-Berechnung automatisch neu.

- [ ] **Step 5: RTL-Test**

`SegmentEditor.test.tsx`: rendert Editor mit `initial='hallo'`, ändert Wert, feuert `blur`, erwartet `onCommit('hallo welt')`. `SpeakerCombobox.test.tsx`: Freitext eingeben + Enter → `onChange` mit dem Freitext.

- [ ] **Step 6: Tests grün + Dogfood** — `npm test` PASS; im Dev: Segmenttext editierbar ohne Cursor-Sprung, Speichern-Button aktiv (dirty), Sprecher als Combobox mit Freitext + Vorschlägen; Sprecherwechsel teilt/verbindet Blöcke.

- [ ] **Step 7: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): Segment-Editor (textarea-Split) + Sprecher-Combobox (Freitext)"
```

---

### Task 12: Jobs — Toasts, Cancel, Transkribieren/Korrigieren

**Files:**
- Create: `src/hooks/useJob.ts`
- Modify: `src/App.tsx` (Job-Handler statt noop), `src/components/Sidebar.tsx` (Force-Bestätigung via AlertDialog)

**Interfaces:**
- Consumes: `getJob`, `cancelJob`, `startTranscribe`, `startCorrect`, `startCorrectFile`, sonner `toast`.
- Produces: `useJob().start(fn, label, onDone)`.

- [ ] **Step 1: useJob (Polling + Sonner-Toast + Cancel)**

`src/hooks/useJob.ts`:
```ts
import { toast } from 'sonner'
import { getJob, cancelJob } from '@/lib/api'
import type { StartJob } from '@/lib/types'

export function useJob() {
  async function start(fn: () => Promise<StartJob>, label: string, onDone?: () => void) {
    let res: StartJob
    try { res = await fn() } catch (e) { toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`); return }
    if (!res.started) { toast.warning('Es läuft bereits ein Job für dieses Projekt.'); return }
    const id = toast.loading(`${label}…`, {
      duration: Infinity,
      action: { label: 'Abbrechen', onClick: () => { cancelJob(res.job_id) } },
    })
    const tick = async () => {
      let j
      try { j = await getJob(res.job_id) } catch { toast.error(`${label}: Job nicht gefunden`, { id }); return }
      const tail = j.lines.slice(-3).join('\n')
      if (j.status === 'running') { toast.loading(`${label}\n${tail}`, { id, duration: Infinity,
        action: { label: 'Abbrechen', onClick: () => { cancelJob(res.job_id) } } }); setTimeout(tick, 1500) }
      else {
        if (j.status === 'done') toast.success(`${label} fertig`, { id, duration: 4000 })
        else if (j.status === 'cancelled') toast.warning(`${label} abgebrochen`, { id, duration: 4000 })
        else toast.error(`${label} — Fehler\n${tail}`, { id, duration: 8000 })
        onDone?.()
      }
    }
    tick()
  }
  return { start }
}
```

- [ ] **Step 2: App-Handler verdrahten**

In `App.tsx`:
```tsx
import { useJob } from '@/hooks/useJob'
import { startTranscribe, startCorrect, startCorrectFile } from '@/lib/api'
// ...
const { start } = useJob()
const onTranscribe = (p: string) => start(() => startTranscribe(p), `Transkribieren ${p}`, refresh)
const onCorrect = (p: string) => start(() => startCorrect(p), `Korrigieren ${p}`, refresh)
const onCorrectFile = (p: string, base: string, force: boolean) =>
  start(() => startCorrectFile(p, base, force), `Korrigieren ${base}`, () => { refresh(); if (sel?.base === base) /* reload */ null })
```
Diese an `<Sidebar>` statt der `noop` übergeben.

- [ ] **Step 3: Force-Bestätigung (AlertDialog) bei bereits editierter Datei**

In `Sidebar`/`FileRow`: ist `file.has_edit`, öffnet der Per-Datei-✎ zuerst einen `AlertDialog` („‚{base}' neu korrigieren? Überschreibt die (ggf. handbearbeitete) Version."). Bei Bestätigung `onCorrectFile(project, base, true)`, sonst nichts. Ohne `has_edit` direkt `onCorrectFile(project, base, false)`.

- [ ] **Step 4: RTL-Test**

`useJob.test.tsx` (oder Integration): `startCorrectFile` gemockt (`vi.mock('@/lib/api')`), Klick auf ✎ bei `has_edit=true` zeigt AlertDialog; Bestätigen ruft `startCorrectFile(_,_,true)`.

- [ ] **Step 5: Tests grün + Dogfood** — `npm test` PASS; im Dev echte Transkription/Korrektur: Sonner-Toast mit Live-Tail, Abbrechen-Action bricht ab (Status „abgebrochen"), Liste refresht nach Abschluss.

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): Jobs als Sonner-Toasts + Cancel + Force-AlertDialog"
```

---

### Task 13: Dirty-Guard, Reload nach Korrektur, Politur

**Files:**
- Modify: `src/App.tsx`, `src/components/SegmentView.tsx` (Roh-Reveal), diverse

**Interfaces:**
- Consumes: `useDoc().reload`, `dirty`.

- [ ] **Step 1: beforeunload + Dateiwechsel-Guard**

In `App.tsx`: `useEffect` registriert `beforeunload`, wenn `dirty`. Beim Öffnen einer anderen Datei bei `dirty` ein `confirm('Ungespeicherte Änderungen verwerfen?')` (oder AlertDialog); nur bei OK `setSel` ändern.

- [ ] **Step 2: Reload nach Per-Datei-Korrektur**

`onCorrectFile`-`onDone`: wenn die gerade offene Datei korrigiert wurde, `reload()` aus `useDoc` aufrufen, damit der neue Text erscheint.

- [ ] **Step 3: Roh-Wörter-Reveal für korrigierte Segmente**

In `SegmentView`: bei `isCorrected(seg)` einen dezenten 🔍-Toggle zeigen, der die Roh-Wörter (`seg.words`) mit `tokenizeUncertain`-Färbung unterhalb einblendet (read-only), damit Unsicherheit auch nach Korrektur einsehbar bleibt (Spec §7.3).

- [ ] **Step 4: Politur**

Empty-States (kein Projekt/keine Datei), Flags-Legende als Tooltip, konsistente Fokus-Ringe (`ring`-Token), Cancel-Toast-Disable beim Klick. Keine neuen Features.

- [ ] **Step 5: Test + Dogfood** — `npm test` bleibt grün; im Dev: Dirty-Guard greift, Reveal zeigt Roh-Wörter, Korrektur-Reload aktualisiert Text.

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend
git commit -m "feat(webtool): Dirty-Guard, Korrektur-Reload, Roh-Reveal, Politur"
```

---

### Task 14: Cutover — Build nach static/, webtool.ps1-Guard, alte Dateien entfernen

**Files:**
- Modify: `webtool.ps1`
- Delete (git): `webtool/static/app.js`, `webtool/static/index.html`, `webtool/static/style.css`, `webtool/static/vendor/`

**Interfaces:** —

- [ ] **Step 1: Alte Vanilla-Dateien aus Git entfernen**

Run:
```bash
git rm -r webtool/static/app.js webtool/static/index.html webtool/static/style.css webtool/static/vendor
```
(Sie sind ab jetzt Build-Output und git-ignoriert.)

- [ ] **Step 2: Prod-Build**

Run: `npm --prefix webtool/frontend run build`
Expected: `webtool/static/index.html` + `assets/` frisch gebaut (nicht getrackt, weil ignoriert).

- [ ] **Step 3: webtool.ps1 mit Build-Guard**

`webtool.ps1` ersetzen:
```powershell
# Startet den Transkribor-Editor lokal und öffnet den Browser.
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$index = Join-Path $PSScriptRoot "webtool\static\index.html"
if (-not (Test-Path $index)) {
  Write-Host "Frontend-Build fehlt — baue (npm)..."
  npm --prefix (Join-Path $PSScriptRoot "webtool\frontend") install
  npm --prefix (Join-Path $PSScriptRoot "webtool\frontend") run build
}
Start-Process "http://127.0.0.1:8000/"
& $py -m uvicorn webtool.app:app --host 127.0.0.1 --port 8000
```

- [ ] **Step 4: End-to-End-Dogfood (Prod-Pfad)**

Run: `.\webtool.ps1` → Browser öffnet :8000, die React-App lädt aus `static/`, ein echtes Projekt (Foodfestival-Maienfeld) öffnen: Redebeiträge, Playback mit Puffer, Editieren, Speichern, Export, Theme-Toggle, ein Korrektur-Job mit Toast+Cancel. Server stoppen.

- [ ] **Step 5: Backend-Tests unverändert grün**

Run: `.venv\Scripts\python.exe -m pytest webtool -q`
Expected: 84 passed (API unangetastet).

- [ ] **Step 6: Commit**

```bash
git add webtool.ps1
git rm --cached -r webtool/static/app.js webtool/static/index.html webtool/static/style.css webtool/static/vendor 2>/dev/null
git commit -m "feat(webtool): Cutover auf React-Build (static/), webtool.ps1 Build-Guard, alte Vanilla-UI entfernt"
```

- [ ] **Step 7: PR + Rebase-Merge (CLAUDE.md-Regel)**

```bash
git push -u origin webtool-react-redesign
gh pr create --base master --title "feat(webtool): Editor-Redesign auf React + shadcn/ui" --body "<Zusammenfassung + Spec-Link>"
# nach grüner Mergeability:
gh pr merge <#> --rebase --delete-branch
```
Danach lokal `master` per Fast-Forward nachziehen + verifizieren.

---

## Self-Review

**Spec-Coverage (§ → Task):** §3.1 Verzeichnis→T1/T2; §3.2 Build/Serve→T1/T14; §3.3 Dev-Loop→T1; §5 Layout→T7/T8/T9/T10; §6.1 Typen→T3; §6.2 Redebeiträge→T4/T10; §6.3 State/Hooks→T7/T11/T12; §7.1 Playback→T5/T9; §7.2 Editier-Split→T11; §7.3 Unsicherheit inline+Reveal→T6/T10/T13; §7.4 Sprecher pro Segment→T11; §7.5 Jobs/Sonner/Cancel→T12; §7.6 Speichern/Export/Dark→T2/T7/T13; §8 Setup→T1/T2; §9 Tests→T3–T13 + T14; §10 Funktionsparität→abgedeckt (Liste unten); §11 Phasen→T1–T14; §13 Entscheidungen→umgesetzt. **Keine Lücke.**

**Funktionsparität-Check:** Projektliste/Badges(T8) · Upload(T8) · Transkribieren(T12) · Korrigieren Projekt+Datei+force(T12) · Job-Polling+Cancel(T12) · Waveform+Segment-Play+Puffer(T9) · Text editierbar(T11) · Sprecher Freitext+Vorschläge(T11) · Unsicherheit+Schwellen(T6/T10) · Roh-Reveal(T13) · human_edited-Schutz(Server, unverändert) · Speichern(T7) · Export(T7) · Flags-Anzeige(T10) · Annotations(T10). ✓

**Platzhalter-Scan:** keine TBD/TODO; alle Code-Schritte mit vollständigem Code. (T9-Step3/T10-Step7/T11-Step2/T11-Step4 beschreiben gezielte Modifikationen an bereits vollständig gezeigten Komponenten — bewusst als Änderungsanweisung, nicht als vager Platzhalter.)

**Typ-Konsistenz:** `Segment/EditDoc/Turn/Thresholds/StartJob/JobStatus` einheitlich aus `types.ts`; `playWindow`, `groupIntoTurns`, `tokenizeUncertain/isCorrected`, `WaveHandle{playSegment,playTurn}`, `useDoc.updateSegment`, `useJob.start(fn,label,onDone)`, `api.*` überall gleich benannt. ✓
