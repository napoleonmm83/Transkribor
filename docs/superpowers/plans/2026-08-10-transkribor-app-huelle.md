# App-Hülle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aus vier Vollbild-Seiten wird ein Programm — feste Zonen, eine dauerhafte Seitenleiste, eigene Titelzeile und die drei fehlenden Betriebssystem-Funktionen (Fenstertitel, Systemmeldung, Taskleisten-Fortschritt).

**Architecture:** Eine `AppShell` rahmt die Routen und besitzt Raster, Seitenleiste, Titelzeile und Statuszeile. `EditorView` gibt sein `h-screen`-Raster und seine `<aside>` **ab**, statt dass die anderen Seiten ein zweites bekommen — danach gibt es genau eine Stelle, an der das Fenster aufgeteilt wird. Projekt- und Dateidaten wandern in einen Provider, damit die dauerhafte Leiste keine zweite Abrufschleife auslöst.

**Tech Stack:** React 19, TypeScript, Tailwind v4, shadcn/ui, react-router-dom v7, Vitest + Testing Library, Electron (`node --test`).

**Spec:** `docs/superpowers/specs/2026-08-10-transkribor-app-huelle-design.md`

## Global Constraints

- **Sprache:** Bezeichner, Kommentare und Oberflächentexte auf Deutsch, wie im ganzen Repo. Kommentare erklären das **Warum**, nicht das Was.
- **Kein Backend.** Keine Datei unter `webtool/*.py` wird angefasst. Alle Daten kommen aus `GET /api/projects`, `GET /api/projects/{p}`, `GET /api/jobs/{id}`, `GET /api/hardware`.
- **Der Browser-Betrieb ist gleichrangig.** `window.transkribor` fehlt unter `webtool.ps1` (:8000) und Vite (:5173). Jede Electron-Funktion prüft die Brücke und ist ohne sie ein No-Op — nie ein Fehler.
- **Der Datenfluss aus PR #67 bleibt:** Zusammenfassung (`GET /api/projects`) für Listen, Dateiliste (`GET /api/projects/{p}`) nur für **ein** Projekt. Kein Aufruf, der Dateien aller Projekte zieht.
- **Testbefehle:** Frontend `npm --prefix webtool/frontend test`, Electron `npm run test:electron`, Typen `npm --prefix webtool/frontend run build`, Lint `npm --prefix webtool/frontend run lint`.
- **Branch:** `feat/app-huelle`. Commit-Präfixe wie im Repo (`feat:`, `refactor:`, `fix:`, `docs:`).
- **Kein Umlaut-Verlust in Commit-Nachrichten:** wie bisher `ue/oe/ae/ss` in Commits, Umlaute im Code und in Oberflächentexten.

---

## File Structure

| Datei | Verantwortung | Task |
|---|---|---|
| `src/components/StatusBar.tsx` | **neu** — Fusszeile: laufende Läufe, Rechenwerk, Version | 1 |
| `src/components/AppShell.tsx` | **neu** — Fensterraster; besitzt Titelzeile, Leiste, Statuszeile | 2, 5, 8 |
| `src/hooks/useProjektDaten.tsx` | **neu** — EIN Provider für Projektliste + Dateien des offenen Projekts | 3 |
| `src/components/Sidebar.tsx` | alle Projekte, Suche, aufklappbar (heute: Dateien eines Projekts) | 4 |
| `src/components/TitleBar.tsx` | **neu** — eigene Titelzeile, nur unter Electron | 8 |
| `src/hooks/useDokumentTitel.ts` | **neu** — `document.title` aus Route + Laufzustand | 9 |
| `src/hooks/useOsFortschritt.ts` | **neu** — Systemmeldung + Taskleisten-Fortschritt | 10 |
| `src/App.tsx` | `AppShell` um die Routen | 2 |
| `src/pages/EditorView.tsx` | gibt Raster (T2), `<aside>` (T4) und Titel (T9) ab | 2, 4, 9 |
| `src/pages/HomeGallery.tsx` | Liste raus, Übersicht bleibt | 6 |
| `src/pages/ProjectWorkspace.tsx`, `SettingsPage.tsx` | `mx-auto max-w-*` raus | 2 |
| `src/components/ProjektPalette.tsx` | liest die geteilte Liste | 3 |
| `src/components/Toolbar.tsx` | gibt den Dateinamen ab (steht in Titelzeile bzw. Tab-Titel) | 9 |
| `src/components/ThemeProvider.tsx` | schiebt die Overlay-Farbe an den Hauptprozess | 8 |
| `electron/main.js` | `fensterOptionen(platform)`, IPC `fortschritt` + `titelleisteFarbe` | 7, 8, 10 |
| `electron/preload.js` | `plattform`, `fortschritt`, `titelleisteFarbe` | 8, 10 |

---

# Phase 1 — Das Fenster füllen

### Task 1: Statuszeile

**Files:**
- Create: `webtool/frontend/src/components/StatusBar.tsx`
- Test: `webtool/frontend/src/components/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `useActiveJob()` aus `@/hooks/useActiveJob` (liefert `{jobs: Job[]}`, `Job = {id, project, kind, status, phases}`); `useUpdate()` aus `@/hooks/useUpdate` (liefert `{zustand: UpdateZustand | null}`); `getHardware()` aus `@/lib/api` (liefert `Hardware = {device, name, torch_ok, asr, asr_engine?}`); `KIND_LABEL` aus `@/lib/jobPhases`.
- Produces: `<StatusBar />` — keine Props. Wird in Task 2 unten in `AppShell` eingehängt.

- [ ] **Step 1: Test schreiben**

`webtool/frontend/src/components/StatusBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

function zeigen() {
  return render(<JobProvider><StatusBar /></JobProvider>)
}

describe('StatusBar', () => {
  beforeEach(() => vi.resetAllMocks())

  it('sagt "Bereit", wenn nichts laeuft', async () => {
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cuda', name: 'RTX 5080', torch_ok: true, asr: 'cuda' })
    zeigen()
    expect(screen.getByText('Bereit')).toBeInTheDocument()
  })

  it('nennt das Rechenwerk aus /api/hardware', async () => {
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cuda', name: 'RTX 5080', torch_ok: true, asr: 'cuda' })
    zeigen()
    await waitFor(() => expect(screen.getByText('cuda')).toBeInTheDocument())
  })

  it('bleibt stehen, wenn /api/hardware nicht antwortet', async () => {
    // Eine Statuszeile, die bei einer fehlenden Nebeninformation die App abschiesst, ist
    // schlimmer als eine, die das Feld leer laesst.
    vi.mocked(api.getHardware).mockRejectedValue(new Error('weg'))
    zeigen()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Bereit')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- StatusBar`
Expected: FAIL — `Failed to resolve import "./StatusBar"`

- [ ] **Step 3: Komponente schreiben**

`webtool/frontend/src/components/StatusBar.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useActiveJob } from '@/hooks/useActiveJob'
import { useUpdate } from '@/hooks/useUpdate'
import { getHardware } from '@/lib/api'
import { KIND_LABEL } from '@/lib/jobPhases'

/**
 * Die Fusszeile der App. Sie zeigt ausschliesslich, was ohnehin schon bekannt ist —
 * kein eigener Zustand, keine eigene Abfrageschleife: laufende Jobs kommen aus dem
 * JobProvider, die Version aus der Electron-Bruecke, das Rechenwerk einmalig beim Start.
 *
 * Faellt eine der drei Quellen aus, bleibt ihr Feld LEER statt einen Fehler zu tragen.
 * Eine Statuszeile, in der Fehlermeldungen stehen, ist eine, die man ausblendet.
 */
export function StatusBar() {
  const { jobs } = useActiveJob()
  const { zustand } = useUpdate()
  const [rechenwerk, setRechenwerk] = useState('')

  // Einmal je Serverlauf ermittelt (GET /api/hardware ist auf der Backend-Seite gecacht) —
  // ein Poll waere hier sinnlos, die Grafikkarte wechselt nicht zur Laufzeit.
  useEffect(() => { getHardware().then(h => setRechenwerk(h.asr)).catch(() => {}) }, [])

  const laufend = jobs.filter(j => j.status === 'running')
  const text = laufend.length === 0
    ? 'Bereit'
    : `${laufend.length} ${laufend.length === 1 ? 'Lauf' : 'Läufe'} · ` +
      laufend.map(j => `${j.project}: ${KIND_LABEL[j.kind] ?? j.kind}`).join(' · ')

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-background px-3 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" aria-live="polite">{text}</span>
      {rechenwerk && <span className="shrink-0">{rechenwerk}</span>}
      {zustand && (
        <span className="shrink-0 tabular-nums">
          v{zustand.version}{zustand.art === 'verfuegbar' ? ' · Update verfügbar' : ''}
        </span>
      )}
    </footer>
  )
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npm --prefix webtool/frontend test -- StatusBar`
Expected: PASS — 3 Tests

- [ ] **Step 5: Committen**

```bash
git add webtool/frontend/src/components/StatusBar.tsx webtool/frontend/src/components/StatusBar.test.tsx
git commit -m "feat(huelle): Statuszeile mit laufenden Laeufen, Rechenwerk und Version"
```

---

### Task 2: Raster — die Seiten füllen das Fenster

**Files:**
- Create: `webtool/frontend/src/components/AppShell.tsx`
- Test: `webtool/frontend/src/components/AppShell.test.tsx`
- Modify: `webtool/frontend/src/App.tsx`
- Modify: `webtool/frontend/src/pages/EditorView.tsx:116` (`h-screen` → `h-full`)
- Modify: `webtool/frontend/src/pages/HomeGallery.tsx:54`, `ProjectWorkspace.tsx:74`, `SettingsPage.tsx:223,228`

**Interfaces:**
- Consumes: `<StatusBar />` aus Task 1.
- Produces: `<AppShell>{children}</AppShell>` — `children` ist der `<Routes>`-Baum. In Task 5 kommt die Seitenleisten-Spalte dazu, in Task 8 die Titelzeile.

- [ ] **Step 1: Test schreiben**

`webtool/frontend/src/components/AppShell.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppShell } from './AppShell'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('AppShell', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cpu', name: 'CPU', torch_ok: false, asr: 'cpu' })
  })

  it('zeigt den Inhalt und GENAU eine Statuszeile', () => {
    render(
      <MemoryRouter>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    expect(screen.getByText('Inhalt')).toBeInTheDocument()
    // contentinfo = <footer>. Zwei davon hiesse: eine Seite bringt ihre eigene mit.
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1)
  })

  it('setzt den Bildlauf beim Routenwechsel zurueck', () => {
    // jsdom implementiert Element.scrollTo nicht — die Attrappe am Prototyp ist der einzige
    // Weg, den Aufruf hier zu sehen. Gemessen wird der Aufruf, nicht die Wirkung.
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: scrollTo, configurable: true, writable: true })
    function Springen() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/einstellungen')}>weiter</button>
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><Springen /></AppShell></JobProvider>
      </MemoryRouter>,
    )
    scrollTo.mockClear()                  // der erste Lauf des Effekts zaehlt nicht
    fireEvent.click(screen.getByText('weiter'))
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
  })
})
```

Importe im Testkopf ergänzen: `fireEvent` aus `@testing-library/react`, `useNavigate` aus `react-router-dom`.

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- AppShell`
Expected: FAIL — `Failed to resolve import "./AppShell"`

- [ ] **Step 3: `AppShell` schreiben**

`webtool/frontend/src/components/AppShell.tsx`:

```tsx
import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { StatusBar } from './StatusBar'

/**
 * Das Fensterraster der App. Es gibt GENAU eine Stelle, an der das Fenster aufgeteilt wird,
 * und das ist diese — vorher brachte der Editor sein eigenes `h-screen`-Raster mit, waehrend
 * die drei anderen Seiten Lesespalten (`mx-auto max-w-3xl`) waren und bei 1280 px Fenster
 * rund 500 px leer liessen.
 *
 * `min-h-0` an der Inhaltszelle ist nicht schmueckend: eine Grid-Zeile hat `min-height:auto`,
 * womit `1fr` von ihrem Inhalt aufgeblaeht wird und das `overflow-auto` nie greift — die
 * Statuszeile wandert dann unter den unteren Fensterrand.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const inhalt = useRef<HTMLDivElement>(null)
  // Kehrseite des EINEN Bildlaufbehaelters: der Versatz ueberlebt den Routenwechsel. Aus
  // einem langen Transkript zurueck zur Uebersicht landete man sonst mitten in der Seite.
  // React Router setzt das absichtlich nicht selbst zurueck — es weiss nicht, welches
  // Element scrollt. `?.` an scrollTo, weil jsdom Element.scrollTo nicht kennt.
  useEffect(() => { inhalt.current?.scrollTo?.({ top: 0 }) }, [pathname])
  return (
    <div className="grid h-screen grid-rows-[1fr_auto]">
      <div ref={inhalt} className="min-h-0 overflow-auto">{children}</div>
      <StatusBar />
    </div>
  )
}
```

- [ ] **Step 4: In `App.tsx` einhängen**

`webtool/frontend/src/App.tsx` — `<Routes>` in `<AppShell>` wickeln, `ProjektPalette` bleibt daneben:

```tsx
import { Routes, Route } from 'react-router-dom'
import { HomeGallery } from '@/pages/HomeGallery'
import { ProjectWorkspace } from '@/pages/ProjectWorkspace'
import { EditorView } from '@/pages/EditorView'
import { SettingsPage } from '@/pages/SettingsPage'
import { ProjektPalette } from '@/components/ProjektPalette'
import { AppShell } from '@/components/AppShell'

export default function App() {
  // ProjektPalette hier, nicht in HomeGallery: das ist die oberste Stelle, an der der
  // Router rahmt -- Ctrl+K muss auch im Editor greifen, wo es kein Suchfeld gibt.
  return (
    <>
      <ProjektPalette />
      <AppShell>
        <Routes>
          <Route path="/" element={<HomeGallery />} />
          <Route path="/einstellungen" element={<SettingsPage />} />
          <Route path="/p/:project" element={<ProjectWorkspace />} />
          <Route path="/p/:project/:base" element={<EditorView />} />
        </Routes>
      </AppShell>
    </>
  )
}
```

- [ ] **Step 5: `EditorView` gibt sein Raster ab**

`webtool/frontend/src/pages/EditorView.tsx:116` — `h-screen` → `h-full`, dazu der Grund als Kommentar:

```tsx
    // h-full, nicht h-screen: das Fenster teilt seit der AppShell nur noch EINE Stelle auf.
    // Mit h-screen waere der Editor so hoch wie das Fenster PLUS Statuszeile — die Zeile
    // stuende dann unter dem unteren Rand, und die Shell-Zelle bekaeme eine zweite Bildlaufleiste.
    <div className="grid h-full grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]">
```

- [ ] **Step 6: Die drei Lesespalten füllen die Zelle**

Jeweils die äussere Klasse ersetzen — `mx-auto max-w-*` raus, Innenabstand bleibt:

- `HomeGallery.tsx:54`: `<div className="mx-auto max-w-5xl p-6 sm:p-8">` → `<div className="p-6 sm:p-8">`
- `ProjectWorkspace.tsx:74`: `<div className="mx-auto max-w-3xl p-6 sm:p-8">` → `<div className="p-6 sm:p-8">`
- `SettingsPage.tsx:223`: `<div className="mx-auto max-w-3xl p-6 sm:p-8 text-sm text-muted-foreground">` → `<div className="p-6 sm:p-8 text-sm text-muted-foreground">`
- `SettingsPage.tsx:226-228`: den Kommentar über der Zeile ersetzen, weil seine Begründung (Breitengleichheit mit der Arbeitsfläche) mit der Shell entfällt:

```tsx
    // Volle Breite wie alle Seiten seit der AppShell. Die Formularreihen begrenzen sich
    // selbst (max-w an den Eingabefeldern) — eine Lesespalte um die ganze Seite wuerde
    // stattdessen wieder den Fensterrand leer lassen.
    <div className="p-6 sm:p-8">
```

- [ ] **Step 7: Alle Tests laufen lassen**

Run: `npm --prefix webtool/frontend test`
Expected: PASS — inklusive der bestehenden `HomeGallery`-, `ProjectWorkspace`- und `EditorView`-Tests. Schlägt einer fehl, weil er `mx-auto` erwartet, ist der Test anzupassen, nicht die Klasse zurückzuholen.

Run: `npm --prefix webtool/frontend run build`
Expected: PASS (Typen)

- [ ] **Step 8: Sichtprüfung — das ist der eigentliche Test dieser Aufgabe**

jsdom misst kein Layout; die zwei Fehlerbilder dieser Änderung sind nur im Fenster sichtbar.

Run: `.\webtool.ps1`, dann im Browser:
1. `/` — Inhalt reicht bis zum rechten Rand, Statuszeile klebt unten.
2. `/p/<projekt>/<datei>` — **genau eine** Bildlaufleiste im Transkript, keine zweite am Fensterrand; der `PlayerDock` steht über der Statuszeile und wandert beim Scrollen nicht weg.

- [ ] **Step 9: Committen**

```bash
git add webtool/frontend/src/components/AppShell.tsx webtool/frontend/src/components/AppShell.test.tsx \
        webtool/frontend/src/App.tsx webtool/frontend/src/pages/
git commit -m "feat(huelle): AppShell rahmt die Routen, die Seiten fuellen das Fenster"
```

---

# Phase 2 — Daten einmal, Leiste einmal

### Task 3: Projektliste und Dateien einmal für die ganze App

**Files:**
- Create: `webtool/frontend/src/hooks/useProjektDaten.tsx`
- Test: `webtool/frontend/src/hooks/useProjektDaten.test.tsx`
- Modify: `webtool/frontend/src/components/AppShell.tsx` (Provider einziehen)
- Modify: `webtool/frontend/src/pages/HomeGallery.tsx:36`, `ProjectWorkspace.tsx:22-23,43-49`, `EditorView.tsx:20-21,42-48`, `components/ProjektPalette.tsx:24`

**Interfaces:**
- Consumes: `useProjects(pollMs)` aus `@/hooks/useProjects` → `{projects, loading, fehler, refresh}`; `useProjectFiles(project)` aus `@/hooks/useProjectFiles` → `{files, loading, fehler, refresh}`; `useMatch` aus `react-router-dom`.
- Produces:
  - `<ProjektDatenProvider>{children}</ProjektDatenProvider>`
  - `useProjekte(): { projects: Project[]; loading: boolean; fehler: boolean; refresh: () => void }`
  - `useDateien(): { projekt: string | null; files: ProjectFile[]; loading: boolean; fehler: boolean; refresh: () => void }`

**Warum diese Aufgabe:** `useProjects` wird heute an vier Stellen instanziiert, `useProjectFiles` an zwei — solange nur eine Seite zur Zeit gerendert wird, ist das je ein Abruf. Die dauerhafte Seitenleiste (Task 5) käme als weitere Instanz dazu und würde `GET /api/projects` **verdoppeln**, also genau die Last wieder aufbauen, die PR #67 gemessen abgebaut hat. Nebenbei verschwindet der wortgleich kopierte „Summenpoll-Wächter" aus `EditorView.tsx:42-48` und `ProjectWorkspace.tsx:43-49`.

- [ ] **Step 1: Test schreiben**

`webtool/frontend/src/hooks/useProjektDaten.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ProjektDatenProvider, useProjekte, useDateien } from './useProjektDaten'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

function Verbraucher({ name }: { name: string }) {
  const { projects } = useProjekte()
  return <span>{name}:{projects.length}</span>
}
function Dateien() {
  const { projekt, files } = useDateien()
  return <span>dateien:{projekt ?? '-'}:{files.length}</span>
}

describe('ProjektDatenProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'P', dateien: 2, fertig: 1, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({
      name: 'P', files: [{ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }],
    })
  })
  afterEach(() => vi.useRealTimers())

  it('ruft /api/projects EINMAL, egal wie viele Verbraucher lesen', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <ProjektDatenProvider><Verbraucher name="a" /><Verbraucher name="b" /></ProjektDatenProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('a:1')).toBeInTheDocument())
    expect(screen.getByText('b:1')).toBeInTheDocument()
    // Der Kern der Aufgabe: zwei Leser, ein Abruf. Vorher waeren es zwei gewesen.
    expect(api.listProjects).toHaveBeenCalledTimes(1)
  })

  it('laedt die Dateien des Projekts aus der URL', async () => {
    render(
      <MemoryRouter initialEntries={['/p/P/a']}>
        <ProjektDatenProvider><Dateien /></ProjektDatenProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('dateien:P:1')).toBeInTheDocument())
    expect(api.getProjectFiles).toHaveBeenCalledWith('P')
  })

  it('laedt die Dateiliste nach, wenn der Summenpoll eine Aenderung meldet', async () => {
    // Der Waechter aus EditorView/ProjectWorkspace, jetzt an EINER Stelle: aendert sich
    // dateien/fertig, hat sich auf der Platte etwas getan -- dann und nur dann neu laden.
    vi.useFakeTimers()
    render(
      <MemoryRouter initialEntries={['/p/P']}>
        <ProjektDatenProvider><Dateien /></ProjektDatenProvider>
      </MemoryRouter>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.getProjectFiles).toHaveBeenCalledTimes(1)

    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'P', dateien: 3, fertig: 1, geaendert: 0 }])
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(api.getProjectFiles).toHaveBeenCalledTimes(2)
  })

  it('laedt NICHT nach, wenn die Zahlen gleich bleiben', async () => {
    vi.useFakeTimers()
    render(
      <MemoryRouter initialEntries={['/p/P']}>
        <ProjektDatenProvider><Dateien /></ProjektDatenProvider>
      </MemoryRouter>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(api.getProjectFiles).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- useProjektDaten`
Expected: FAIL — `Failed to resolve import "./useProjektDaten"`

- [ ] **Step 3: Provider schreiben**

`webtool/frontend/src/hooks/useProjektDaten.tsx`:

```tsx
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { useMatch } from 'react-router-dom'
import { useProjects } from './useProjects'
import { useProjectFiles } from './useProjectFiles'
import type { Project, ProjectFile } from '@/lib/types'

type Projekte = { projects: Project[]; loading: boolean; fehler: boolean; refresh: () => void }
type Dateien = { projekt: string | null; files: ProjectFile[]; loading: boolean; fehler: boolean; refresh: () => void }
const Ctx = createContext<{ projekte: Projekte; dateien: Dateien } | null>(null)

/**
 * EINE Projektliste und EINE Dateiliste fuer die ganze App.
 *
 * Vorher rief jede Seite `useProjects` selbst (vier Stellen) — solange nur eine Seite zur
 * Zeit gerendert wurde, war das ein Abruf alle 4 s. Mit der dauerhaften Seitenleiste waeren
 * es zwei parallele geworden: Leiste UND Seite. Das ist genau die Verdopplung, die die
 * Aufteilung in Zusammenfassung und Dateiliste (PR #67) abgeschafft hat.
 *
 * Die Dateiliste haengt am Projekt aus der URL, nicht an einem eigenen Zustand: das
 * aufgeklappte Projekt der Seitenleiste IST das geoeffnete. Ein zweiter Begriff von "offen"
 * waere eine zweite Wahrheit, die man synchron halten muss.
 */
export function ProjektDatenProvider({ children, pollMs = 4000 }: { children: ReactNode; pollMs?: number }) {
  const projekte = useProjects(pollMs)
  // Zwei Aufrufe statt eines optionalen Parameters: `useMatch('/p/:project/:base?')` waere
  // kuerzer, faellt aber je nach Router-Version auf die Nase — zwei Muster sind eindeutig.
  const mitDatei = useMatch('/p/:project/:base')
  const nurProjekt = useMatch('/p/:project')
  const projekt = (mitDatei ?? nurProjekt)?.params.project ?? null
  const datei = useProjectFiles(projekt ?? '')

  // Der billige Waechter ueber die Dateiliste: aendern sich `dateien`/`fertig` in der
  // Zusammenfassung, hat sich auf der Platte etwas getan (ein Job mittendrin, oder eine von
  // Hand hineinkopierte Datei) — dann und nur dann neu laden. Ohne ihn bliebe eine fertig
  // transkribierte Datei bis zum Laufende deaktiviert, weil `has_raw` nur ueber diesen Abruf
  // hereinkommt und `onSettled` erst am Ende des GANZEN Jobs feuert.
  //
  // NICHT beim allerersten Eintreffen feuern: der Sprung von "unbekannt" auf die erste Zahl
  // ist keine Aenderung auf der Platte, und den ersten Abruf erledigt useProjectFiles selbst.
  //
  // Stand vorher wortgleich in EditorView.tsx UND ProjectWorkspace.tsx.
  const p = projekte.projects.find(x => x.name === projekt)
  const letzteZahlen = useRef<{ projekt: string; dateien: number; fertig: number } | null>(null)
  useEffect(() => {
    if (!p || !projekt) { letzteZahlen.current = null; return }
    const vorher = letzteZahlen.current
    letzteZahlen.current = { projekt, dateien: p.dateien, fertig: p.fertig }
    // Projektwechsel ist kein Anlass: die neue Liste holt useProjectFiles ohnehin selbst.
    if (vorher && vorher.projekt === projekt &&
        (vorher.dateien !== p.dateien || vorher.fertig !== p.fertig)) datei.refresh()
  }, [projekt, p?.dateien, p?.fertig])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Ctx.Provider value={{ projekte, dateien: { projekt, ...datei } }}>{children}</Ctx.Provider>
  )
}

function ctx() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useProjekte/useDateien ausserhalb ProjektDatenProvider')
  return c
}
export function useProjekte(): Projekte { return ctx().projekte }
export function useDateien(): Dateien { return ctx().dateien }
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npm --prefix webtool/frontend test -- useProjektDaten`
Expected: PASS — 4 Tests

- [ ] **Step 5: Provider in `AppShell` einziehen**

`AppShell.tsx` — der Provider gehört hierher und nicht in `main.tsx`, weil er `useMatch` braucht und damit **innerhalb** des Routers stehen muss.

> **Folge, die Task 2 noch nicht sehen konnte:** `ProjektPalette` ruft `useProjekte()`
> **unbedingt** und ist auf jeder Seite gemountet. Sie muss deshalb ab hier **Kind** der
> `AppShell` sein — als Geschwister wirft sie beim Start und reisst die ganze App mit. Der
> ursprüngliche Grund, sie daneben zu stellen („ein Dialog gehört nicht in eine Rasterzelle
> mit `overflow-auto`"), trägt nicht: Radix portiert den Dialoginhalt nach `document.body`,
> die Position im Baum ist für die Darstellung folgenlos.

```tsx
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ProjektDatenProvider>
      <Rahmen>{children}</Rahmen>
    </ProjektDatenProvider>
  )
}
```

Das bisherige Raster wandert dabei in ein `Rahmen`-Bauteil **innerhalb** des Providers — Hooks
wie `useDateien()` stehen einem Bauteil erst zur Verfügung, wenn es unter dem Provider gerendert
wird. Ab Task 5 braucht `Rahmen` das:

```tsx
function Rahmen({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const inhalt = useRef<HTMLDivElement>(null)
  useEffect(() => { inhalt.current?.scrollTo?.({ top: 0 }) }, [pathname])
  return (
    <div className="grid h-screen grid-rows-[1fr_auto]">
      <div ref={inhalt} className="min-h-0 overflow-auto">{children}</div>
      <StatusBar />
    </div>
  )
}
```

- [ ] **Step 6: Die fünf Verbraucher umstellen**

Jeweils Import und Aufruf ersetzen; **keine** weitere Logik ändern.

- `HomeGallery.tsx:4,36`: `import { useProjekte } from '@/hooks/useProjektDaten'` und `const { projects, refresh, loading, fehler } = useProjekte()`
- `ProjektPalette.tsx:3,24`: `const { projects } = useProjekte()` — der `open ? 4000 : 0`-Trick entfällt ersatzlos: die geteilte Liste pollt ohnehin für die Seitenleiste, ein zweiter Schalter dafür wäre wirkungslos.
- `ProjectWorkspace.tsx:5-6,22-23`:
  ```tsx
  import { useProjekte, useDateien } from '@/hooks/useProjektDaten'
  ...
  const { projects, refresh } = useProjekte()
  const { files: dateien, refresh: refreshFiles, loading: dateienLaden, fehler: dateienFehler } = useDateien()
  ```
  Dazu den Wächter-Block `ProjectWorkspace.tsx:43-49` (`letzteZahlen`-Ref + `useEffect`) **löschen** — er steht jetzt im Provider — und den `useRef`-Import prüfen (fällt weg, wenn er sonst ungenutzt ist).
- `EditorView.tsx:3-4,20-21`: dieselbe Umstellung; Wächter-Block `EditorView.tsx:42-48` löschen.

- [ ] **Step 7: Ganze Suite + Typen + Lint**

Run: `npm --prefix webtool/frontend test`
Expected: PASS. Die Tests in `EditorView.test.tsx:75` und `ProjectWorkspace.test.tsx:135` erwarten heute den Poll aus der Seite selbst — sie müssen ihren Baum in `<ProjektDatenProvider>` wickeln (im `MemoryRouter`, nicht darum herum). Der Kommentar „sonst legt useProjects sein setInterval auf den echten Timer" gilt unverändert weiter.

Run: `npm --prefix webtool/frontend run build && npm --prefix webtool/frontend run lint`
Expected: PASS

- [ ] **Step 8: Gegenprobe**

Im ersten Test `expect(api.listProjects).toHaveBeenCalledTimes(1)` auf `2` ändern → Test muss **rot** werden. Danach zurückändern. Ein Test, der beide Zahlen akzeptiert, misst nicht, was er behauptet.

- [ ] **Step 9: Committen**

```bash
git add webtool/frontend/src/hooks/useProjektDaten.tsx webtool/frontend/src/hooks/useProjektDaten.test.tsx \
        webtool/frontend/src/components/AppShell.tsx webtool/frontend/src/pages/ webtool/frontend/src/components/ProjektPalette.tsx
git commit -m "refactor(huelle): Projektliste und Dateien einmal fuer die ganze App

Vier useProjects-Instanzen und zwei useProjectFiles-Instanzen werden zu je
einer. Die dauerhafte Seitenleiste braucht dieselben Daten wie die Seite --
ohne diesen Schritt waere GET /api/projects doppelt so oft gelaufen wie vor
PR #67 gemessen. Der wortgleich kopierte Summenpoll-Waechter aus EditorView
und ProjectWorkspace steht jetzt an einer Stelle."
```

---

### Task 4: Seitenleiste zeigt alle Projekte, aufklappbar

**Files:**
- Modify: `webtool/frontend/src/components/Sidebar.tsx` (vollständig ersetzt)
- Modify: `webtool/frontend/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `FileRow` aus `./FileRow` (Props: `file, active, onOpen, onCorrectFile, phase, state, jobRunning, aiReason`); Typen `ActiveJob, JobPhases, ProjectFile` aus `@/lib/types`; `Button` aus `@/components/ui/button`.
- Produces: neue `Sidebar`-Props (ersetzen die bisherigen vollständig):

```ts
type SidebarProjekt = { name: string; dateien: number; active_jobs?: ActiveJob[] }
{
  projekte: SidebarProjekt[]; loading?: boolean; fehler?: boolean
  /** Aufgeklapptes Projekt = das aus der URL. null: keines offen. */
  offen: string | null
  dateien: ProjectFile[]; dateienLaden?: boolean
  /** Klick auf eine Projektzeile. null = das offene wieder zuklappen. */
  onWaehlen: (name: string | null) => void
  active: { project: string; base: string } | null
  onOpen: (s: { project: string; base: string }) => void
  onUpload: (project: string, file: File) => void
  onTranscribe: (project: string) => void
  onCorrect: (project: string) => void
  onCorrectFile: (project: string, base: string, force: boolean) => void
  phases?: JobPhases; jobRunning?: boolean; aiReason?: string
}
```

- [ ] **Step 1: Tests schreiben**

`webtool/frontend/src/components/Sidebar.test.tsx` — vollständig ersetzen:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'

const PROJEKTE = [
  { name: 'Alpha', dateien: 2 },
  { name: 'Beta', dateien: 1 },
]
const DATEIEN = [
  { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false },
  { base: 'b', has_audio: true, has_raw: false, has_edit: false, has_md: false },
]

function zeigen(extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    projekte: PROJEKTE, offen: null, dateien: [], onWaehlen: vi.fn(),
    active: null, onOpen: vi.fn(), onUpload: vi.fn(), onTranscribe: vi.fn(),
    onCorrect: vi.fn(), onCorrectFile: vi.fn(), ...extra,
  }
  render(<Sidebar {...props} />)
  return props
}

describe('Sidebar', () => {
  it('listet alle Projekte', () => {
    zeigen()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('zeigt die Dateien NUR des offenen Projekts', () => {
    zeigen({ offen: 'Alpha', dateien: DATEIEN })
    expect(screen.getByText(/^a/)).toBeInTheDocument()
    // Beta ist zu -- seine Dateien duerfen nicht erscheinen, und die Leiste fragt sie
    // auch nicht ab (die Dateiliste kommt fuer genau EIN Projekt herein).
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('waehlt bei Klick auf eine geschlossene Zeile das Projekt', () => {
    const { onWaehlen } = zeigen({ offen: 'Alpha', dateien: DATEIEN })
    fireEvent.click(screen.getByText('Beta'))
    expect(onWaehlen).toHaveBeenCalledWith('Beta')
  })

  it('klappt das offene Projekt bei erneutem Klick zu', () => {
    const { onWaehlen } = zeigen({ offen: 'Alpha', dateien: DATEIEN })
    fireEvent.click(screen.getByText('Alpha'))
    expect(onWaehlen).toHaveBeenCalledWith(null)
  })

  it('filtert nach dem Suchbegriff', () => {
    zeigen()
    fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'bet' } })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('nennt einen leeren Suchtreffer beim Namen statt leer zu bleiben', () => {
    zeigen()
    fireEvent.change(screen.getByLabelText('Projekte durchsuchen'), { target: { value: 'zzz' } })
    expect(screen.getByText(/zzz/)).toBeInTheDocument()
  })

  it('unterscheidet "laedt" von "keine Projekte"', () => {
    // Dieselbe Regel wie in der Galerie: eine leere Liste hat drei Gruende und darf nicht
    // waehrend des Ladens behaupten, es gaebe nichts.
    render(<Sidebar projekte={[]} loading offen={null} dateien={[]} onWaehlen={vi.fn()}
      active={null} onOpen={vi.fn()} onUpload={vi.fn()} onTranscribe={vi.fn()}
      onCorrect={vi.fn()} onCorrectFile={vi.fn()} />)
    expect(screen.queryByText(/Noch keine Projekte/)).not.toBeInTheDocument()
  })

  it('sperrt Korrigieren ohne KI-Anbieter und nennt den Grund', () => {
    const grund = 'Claude Code ist nicht installiert. Unter „Einstellungen" einrichten.'
    zeigen({ offen: 'Alpha', dateien: DATEIEN, aiReason: grund })
    expect(screen.getByLabelText('Korrigieren + Sprecher')).toBeDisabled()
    expect(screen.getByLabelText('Nur „a" korrigieren')).toBeDisabled()
    expect(screen.getByLabelText('Transkribieren')).not.toBeDisabled()   // nur die Korrektur
  })

  it('öffnet eine Datei bei Klick', () => {
    const { onOpen } = zeigen({ offen: 'Alpha', dateien: DATEIEN })
    fireEvent.click(screen.getByText(/^a/))
    expect(onOpen).toHaveBeenCalledWith({ project: 'Alpha', base: 'a' })
  })
})
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- Sidebar`
Expected: FAIL — die alten Props (`projects` mit `files`) passen nicht auf die neuen Testaufrufe

- [ ] **Step 3: `Sidebar.tsx` neu schreiben**

```tsx
import { useMemo, useRef, useState } from 'react'
import { ChevronRight, Loader2, Pencil, Play, Search, Upload } from 'lucide-react'
import type { ActiveJob, JobPhases, ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { FileRow } from './FileRow'

type Sel = { project: string; base: string } | null
/** Nur die Zusammenfassung: die Leiste zeigt alle Projekte, aber Dateien nur fuer das
 *  aufgeklappte — die Dateiliste kommt getrennt herein (GET /api/projects/{p}). */
type SidebarProjekt = { name: string; dateien: number; active_jobs?: ActiveJob[] }

export function Sidebar({
  projekte, loading, fehler, offen, dateien, dateienLaden, onWaehlen,
  active, onOpen, onUpload, onTranscribe, onCorrect, onCorrectFile,
  phases, jobRunning, aiReason,
}: {
  projekte: SidebarProjekt[]; loading?: boolean; fehler?: boolean
  offen: string | null
  dateien: ProjectFile[]; dateienLaden?: boolean
  onWaehlen: (name: string | null) => void
  active: Sel
  onOpen: (s: { project: string; base: string }) => void
  onUpload: (project: string, file: File) => void
  onTranscribe: (project: string) => void
  onCorrect: (project: string) => void
  onCorrectFile: (project: string, base: string, force: boolean) => void
  phases?: JobPhases; jobRunning?: boolean
  /** Nicht leer = kein nutzbarer KI-Anbieter: Korrigieren deaktiviert, Text als Tooltip. */
  aiReason?: string
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [suche, setSuche] = useState('')
  const treffer = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return q ? projekte.filter(p => p.name.toLowerCase().includes(q)) : projekte
  }, [projekte, suche])

  return (
    <div className="flex h-full flex-col">
      {/* Das Suchfeld scrollt nicht mit: bei hunderten Projekten ist es sonst nach drei
          Zeilen weg, und die Leiste hat keinen zweiten Weg zu einem Projekt. */}
      <div className="shrink-0 p-2">
        <label htmlFor="leiste-suche" className="sr-only">Projekte durchsuchen</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input id="leiste-suche" type="search" value={suche} onChange={e => setSuche(e.target.value)}
            placeholder="Projekte durchsuchen…"
            className="h-8 w-full rounded-md border border-input bg-transparent py-1 pl-8 pr-2 text-sm
                       outline-none placeholder:text-muted-foreground
                       focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
        </div>
      </div>

      <input ref={fileInput} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { const f = e.target.files?.[0]; if (f && offen) onUpload(offen, f); e.target.value = '' }} />

      <nav className="min-h-0 flex-1 overflow-auto px-1 pb-2" aria-label="Projekte">
        {projekte.length === 0 && loading && <p className="px-2 py-1 text-sm text-muted-foreground">lädt…</p>}
        {projekte.length === 0 && !loading && fehler && (
          <p className="px-2 py-1 text-sm text-muted-foreground">Projekte konnten nicht geladen werden.</p>
        )}
        {projekte.length === 0 && !loading && !fehler && (
          <p className="px-2 py-1 text-sm text-muted-foreground">Noch keine Projekte.</p>
        )}
        {projekte.length > 0 && treffer.length === 0 && (
          <p className="px-2 py-1 text-sm text-muted-foreground">Kein Projekt passt zu „{suche}".</p>
        )}

        {treffer.map(p => {
          const auf = offen === p.name
          return (
            <div key={p.name}>
              {/* Klick auf das offene Projekt klappt zu (onWaehlen(null)) — sonst gaebe es
                  keinen Weg zurueck zur Uebersicht ausser ueber die Adresszeile. */}
              <button type="button" onClick={() => onWaehlen(auf ? null : p.name)}
                aria-expanded={auf}
                className={cn('flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm outline-none',
                  'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                  auf && 'font-medium')}>
                <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform',
                  auf && 'rotate-90')} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {(p.active_jobs?.length ?? 0) > 0
                  ? <Loader2 className="size-3 shrink-0 animate-spin text-primary" aria-label="läuft" />
                  : <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{p.dateien}</span>}
              </button>

              {auf && (
                <div className="mb-1 pl-4">
                  {/* Die Aktionen haengen am offenen Projekt, nicht an jeder Zeile: drei
                      Knoepfe je Zeile machen aus einer Liste eine Werkzeugleiste. */}
                  <div className="flex items-center gap-1 py-1">
                    <Button size="icon" variant="ghost" className="size-7" title="Audio hochladen"
                      aria-label="Audio hochladen" onClick={() => fileInput.current?.click()}>
                      <Upload className="size-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-7" title="Transkribieren"
                      aria-label="Transkribieren" onClick={() => onTranscribe(p.name)}>
                      <Play className="size-3.5" />
                    </Button>
                    {/* title am Wrapper: ein deaktivierter Knopf hat pointer-events:none
                        und zeigt seinen eigenen Tooltip nie. */}
                    <span title={aiReason || undefined} className="inline-flex">
                      <Button size="icon" variant="ghost" className="size-7" title="Korrigieren + Sprecher"
                        aria-label="Korrigieren + Sprecher" disabled={!!aiReason}
                        onClick={() => onCorrect(p.name)}>
                        <Pencil className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                  {dateienLaden && dateien.length === 0 && (
                    <p className="px-2 py-1 text-sm text-muted-foreground">lädt…</p>
                  )}
                  {dateien.map(f => (
                    <FileRow key={f.base} file={f}
                      active={active?.project === p.name && active?.base === f.base}
                      onOpen={() => onOpen({ project: p.name, base: f.base })}
                      onCorrectFile={force => onCorrectFile(p.name, f.base, force)}
                      phase={jobRunning ? phases?.active[f.base]?.phase : undefined}
                      state={jobRunning ? phases?.perBase[f.base] : undefined}
                      jobRunning={jobRunning} aiReason={aiReason} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>
    </div>
  )
}
```

- [ ] **Step 4: Tests laufen lassen, Erfolg bestätigen**

Run: `npm --prefix webtool/frontend test -- Sidebar`
Expected: PASS — 9 Tests

- [ ] **Step 5: `EditorView` gibt seine Leiste ab — im selben Commit**

Die neuen Props passen nicht mehr zum alten Aufruf in `EditorView`. Ein Commit mit rotem
TypeScript-Build ist keine Option, also geht die alte Verdrahtung hier weg statt erst in Task 5.

In `EditorView.tsx` entfernen: den `Sidebar`-Import, das `sidebarProjects`-Memo (`:51-54`), die
`<aside>`-Zelle (`:117-123`), die Handler `openFile`, `onUpload`, `onTranscribe`, `onCorrect`,
`onCorrectFile` (`:101-113`) und die dadurch ungenutzten Importe (`uploadAudio`,
`startTranscribe`, `startCorrect`, `startCorrectFile`, `useJob`, `useNavigate`). Das Raster wird
einspaltig:

```tsx
    // Nur noch der Inhalt: die Projektnavigation zieht in die AppShell (Task 5).
    <div className="grid h-full grid-rows-[auto_1fr_auto]">
      <Toolbar title={title} dirty={dirty} canSave={!!doc} onSave={save} onExport={exportDownload} />
      <main className="min-h-0 overflow-auto">
        <Transcript doc={doc} loading={docLoading} activeId={activeId}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          updateSegment={updateSegment} renameSpeaker={renameSpeaker} />
      </main>
      <PlayerDock url={sel ? audioUrl(sel.project, sel.base) : undefined} onTime={onTime} waveRef={waveRef} />
    </div>
```

In `EditorView.test.tsx` die Fälle entfernen, die die Leiste prüfen — sie ist nicht mehr Teil des
Editors; `Sidebar.test.tsx` deckt sie ab.

> **Bewusster Zwischenzustand für genau einen Commit:** nach diesem Schritt hat der Editor keine
> Projektnavigation mehr (Task 5 hängt sie in die Shell). Build und Tests sind grün, die App
> läuft — sie kann eine Weile nur nicht aus dem Editor heraus die Datei wechseln. Die Alternative
> wäre ein roter Build über zwei Commits, und die ist schlechter.

- [ ] **Step 6: Tests + Typen + Lint**

Run: `npm --prefix webtool/frontend test && npm --prefix webtool/frontend run build && npm --prefix webtool/frontend run lint`
Expected: PASS — alles grün, kein „wird in Task 5 grün".

- [ ] **Step 7: Committen**

```bash
git add webtool/frontend/src/components/Sidebar.tsx webtool/frontend/src/components/Sidebar.test.tsx \
        webtool/frontend/src/pages/EditorView.tsx webtool/frontend/src/pages/EditorView.test.tsx
git commit -m "feat(huelle): Seitenleiste zeigt alle Projekte mit Suche und klappt auf"
```

---

### Task 5: Die Leiste zieht in die Shell

**Files:**
- Modify: `webtool/frontend/src/components/AppShell.tsx`
- Modify: `webtool/frontend/src/components/StatusBar.tsx` (`col-span-1 md:col-span-2`)
- Modify: `webtool/frontend/src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: `Sidebar` (Props aus Task 4); `useProjekte()`, `useDateien()` (Task 3); `useActiveJob()`, `mergePhases`; `useAiReady()`; `useJob()` → `{start}`; `uploadAudio, startTranscribe, startCorrect, startCorrectFile` aus `@/lib/api`.
- Produces: `AppShell` mit Zwei-Spalten-Raster. `EditorView` rendert ab jetzt **nur noch** Toolbar / Transcript / PlayerDock.

- [ ] **Step 1: Test erweitern**

In `AppShell.test.tsx` ergänzen:

```tsx
  it('zeigt die Seitenleiste mit den Projekten', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Alpha', dateien: 1, fertig: 0, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: [] })
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Projekte' })).toBeInTheDocument())
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('bietet einen Sprunglink VOR der Leiste', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    const sprung = screen.getByRole('link', { name: 'Zum Inhalt' })
    expect(sprung).toHaveAttribute('href', '#inhalt')
    // Reihenfolge im DOM ist hier die ganze Aussage: hinter der Leiste waere der Link
    // wertlos, weil man ihn erst nach dreihundert Knoepfen erreicht.
    const leiste = screen.getByRole('navigation', { name: 'Projekte' })
    expect(sprung.compareDocumentPosition(leiste) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
```

`waitFor` und die übrigen `api`-Mocks (`listProjects`, `getProjectFiles`, `getAiReady` falls von `useAiReady` benutzt) im `beforeEach` ergänzen.

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- AppShell`
Expected: FAIL — `Unable to find role="navigation"`

- [ ] **Step 3: `AppShell` um die Spalte erweitern**

```tsx
import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation, useMatch, useNavigate } from 'react-router-dom'
import { ProjektDatenProvider, useProjekte, useDateien } from '@/hooks/useProjektDaten'
import { mergePhases, useActiveJob } from '@/hooks/useActiveJob'
import { useAiReady } from '@/hooks/useAiReady'
import { useJob } from '@/hooks/useJob'
import { uploadAudio, startTranscribe, startCorrect, startCorrectFile } from '@/lib/api'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

/** Getrennt von AppShell, weil sie die Hooks des Providers braucht — die stehen einem
 *  Bauteil erst zur Verfuegung, wenn es INNERHALB des Providers gerendert wird. */
function Leiste() {
  const navigate = useNavigate()
  const { projects, loading, fehler, refresh } = useProjekte()
  const { projekt, files, loading: dateienLaden, refresh: refreshFiles } = useDateien()
  const { jobs, adopt } = useActiveJob()
  const { start } = useJob()
  const aiReason = useAiReady()

  const meine = jobs.filter(j => j.project === projekt && j.status === 'running')
  const phases = mergePhases(meine)     // nur eigenes Projekt, s. mergePhases

  const nachladen = () => { refresh(); refreshFiles() }
  return (
    <Sidebar
      projekte={projects} loading={loading} fehler={fehler}
      offen={projekt} dateien={files} dateienLaden={dateienLaden}
      onWaehlen={n => navigate(n ? `/p/${encodeURIComponent(n)}` : '/')}
      active={null}
      onOpen={s => navigate(`/p/${encodeURIComponent(s.project)}/${encodeURIComponent(s.base)}`)}
      onUpload={(p, f) => uploadAudio(p, f).then(nachladen)}
      onTranscribe={p => start(() => startTranscribe(p), `Transkribieren ${p}`, nachladen)}
      onCorrect={p => start(() => startCorrect(p), `Korrigieren ${p}`, nachladen)}
      onCorrectFile={(p, b, force) => start(
        () => startCorrectFile(p, b, force).then(res => { if (res.started) adopt(res.job_id, p, 'correct'); return res }),
        `Korrigieren ${b}`, nachladen)}
      phases={phases} jobRunning={meine.length > 0} aiReason={aiReason} />
  )
}

function Rahmen({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const inhalt = useRef<HTMLDivElement>(null)
  useEffect(() => { inhalt.current?.scrollTo?.({ top: 0 }) }, [pathname])
  return (
    <>
      {/* Erstes fokussierbares Element der Seite. Die Leiste steht seit dieser Aenderung VOR
          dem Inhalt im DOM — ohne Sprunglink laeuft Tab bei dreihundert Projekten durch
          dreihundert Knoepfe, bevor es im Transkript ankommt. `tabIndex={-1}` am Ziel, damit
          der Sprung den Fokus wirklich mitnimmt und nicht nur die Bildlaufposition. */}
      <a href="#inhalt"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50
                   focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2
                   focus:text-sm focus:ring-2 focus:ring-ring">
        Zum Inhalt
      </a>
      {/* Unter `md` faellt die Leiste weg. Das Electron-Fenster wird nie so schmal
          (minWidth: 900) — gemeint ist ein verkleinertes Browser-Fenster. Ein Telefon ist
          KEIN Fall: der Server bindet auf 127.0.0.1, von aussen erreicht ihn niemand.
          Darum hier nur ausblenden statt einer einklappbaren Leiste mit gemerktem Zustand:
          auf schmal bleiben die Uebersicht und Ctrl+K als Weg zum Projekt. */}
      <div className="grid h-screen grid-rows-[1fr_auto] md:grid-cols-[260px_1fr]">
        <aside className="hidden min-h-0 border-r md:block"><Leiste /></aside>
        <div id="inhalt" tabIndex={-1} ref={inhalt}
          className="min-h-0 overflow-auto outline-none">{children}</div>
        <StatusBar />
      </div>
    </>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  return <ProjektDatenProvider><Rahmen>{children}</Rahmen></ProjektDatenProvider>
}
```

**Achtung `StatusBar`:** sie muss auf breiten Fenstern beide Spalten überspannen, auf schmalen die eine. In `StatusBar.tsx` das `<footer>` um `col-span-1 md:col-span-2` ergänzen — sonst steht sie nur unter der Leiste und die Inhaltsspalte reicht bis zum Fensterrand.

- [ ] **Step 4: Aktive Datei markieren**

`EditorView` hat seine Leiste bereits in Task 4 abgegeben — hier kommt sie in der Shell wieder an.
In `Leiste()` das `active` aus der Route ziehen, statt `null` zu übergeben:

```tsx
  const imEditor = useMatch('/p/:project/:base')
  const active = imEditor?.params.project && imEditor?.params.base
    ? { project: imEditor.params.project, base: imEditor.params.base }
    : null
```

und `active={active}` übergeben.

- [ ] **Step 5: Die zweite Hälfte der Zusammenlegung — `onSettled` gehört auch in den Provider**

*Beim Ausführen von Task 4 aufgefallen.* Nach Task 3 steht dieser Block **wortgleich** in
`EditorView.tsx` und `ProjectWorkspace.tsx`:

```tsx
useEffect(() => onSettled(() => { refresh(); refreshFiles() }), [onSettled, refresh, refreshFiles])
```

Das ist dieselbe Kopie-in-zwei-Dateien, die Task 3 beim Summenpoll-Wächter beseitigt hat — und
seit dem Provider frischen beide denselben **globalen** Zustand auf. Zieh den Effekt in
`ProjektDatenProvider` (`useProjektDaten.tsx`) und entferne ihn aus beiden Seiten:

```tsx
  // Zweiter Anlass neben dem Summenpoll-Waechter: wird ein Job dieses Prozesses terminal, ist
  // die Dateiliste veraltet (eine frisch geschriebene edit.json sieht der Summenpoll erst beim
  // naechsten Durchlauf). Stand vorher wortgleich in EditorView UND ProjectWorkspace — seit die
  // Daten geteilt sind, ist das eine globale Angelegenheit und keine der einzelnen Seite.
  useEffect(() => onSettled(() => { projekte.refresh(); datei.refresh() }), [onSettled, projekte.refresh, datei.refresh])
```

Der Provider braucht dafür `useActiveJob()`. **`JobProvider` steht in `main.tsx` über dem
`BrowserRouter`** — die Reihenfolge passt also bereits; prüfe es, bevor du baust.

Die Tests in `EditorView.test.tsx` und `ProjectWorkspace.test.tsx`, die diesen Weg prüfen
(„onSettled muss refreshFiles auslösen"), wandern nach `useProjektDaten.test.tsx` — sie prüfen
weiterhin dasselbe Verhalten, nur an seiner neuen Stelle. **Nicht löschen.**

- [ ] **Step 6: Alle Tests + Typen + Lint**

Run: `npm --prefix webtool/frontend test && npm --prefix webtool/frontend run build && npm --prefix webtool/frontend run lint`
Expected: PASS

- [ ] **Step 7: Sichtprüfung**

Run: `.\webtool.ps1`
1. Leiste steht auf allen vier Routen, Projektwechsel räumt den Bildschirm nicht.
2. Ein Projekt aufklappen → Dateien erscheinen; erneuter Klick klappt zu und landet auf `/`.
3. Ein Lauf starten → Phasenpille erscheint in der Leiste **und** in der Arbeitsfläche.
4. **Tab von ganz oben** → erstes Ziel ist „Zum Inhalt"; Eingabe springt ins Transkript.
5. **Fenster auf ~600 px verkleinern** → Leiste weg, Inhalt füllt die Breite, Statuszeile bleibt
   ganz unten (kein waagrechter Bildlauf).
6. In einem langen Transkript nach unten scrollen, dann zurück zur Übersicht → sie beginnt oben.

- [ ] **Step 8: Committen**

```bash
git add webtool/frontend/src/components/ webtool/frontend/src/hooks/ webtool/frontend/src/pages/
git commit -m "feat(huelle): Seitenleiste dauerhaft in der Shell, Sprunglink, schmale Fenster"
```

---

### Task 6: Startseite wird Übersicht

**Files:**
- Modify: `webtool/frontend/src/pages/HomeGallery.tsx`
- Modify: `webtool/frontend/src/pages/HomeGallery.test.tsx`

**Interfaces:**
- Consumes: `useProjekte()` (Task 3), `NewProjectDialog`, `DeleteProjectDialog`, `PageHeader`, `KIND_LABEL`.
- Produces: keine — Endpunkt der Kette.

- [ ] **Step 1: Tests anpassen**

In `HomeGallery.test.tsx` die Fälle für Suchfeld, Sortierung und die dichte Zeilenliste **entfernen** (sie leben jetzt in `Sidebar.test.tsx`) und ergänzen:

```tsx
  it('zeigt laufende Projekte als Karten', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Alpha', dateien: 8, fertig: 3, geaendert: 0, active_jobs: [{ id: '1', kind: 'correct' }] },
    ])
    zeigen()
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')
  })

  it('listet die Projekte NICHT nochmal als Zeilen — die stehen in der Seitenleiste', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Ruhig', dateien: 2, fertig: 2, geaendert: 0 },
    ])
    zeigen()
    await waitFor(() => expect(screen.getByText(/Zuletzt geändert/)).toBeInTheDocument())
    expect(screen.queryByLabelText('Projekte durchsuchen')).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- HomeGallery`
Expected: FAIL — das Suchfeld ist noch da

- [ ] **Step 3: `HomeGallery` umbauen**

Entfernen: `suche`/`sort`-State, das klebende Suchfeld (`:99-114`), der Abschnitt „Alle" mit der Zeilenliste (`:173-231`), der Suchtreffer-Leerzustand, die Importe `Search`, `X`, `useState`.

Behalten und umbenennen: `laufende` bleibt („Läuft gerade"), darunter kommt „Zuletzt geändert" mit den fünf jüngsten Projekten als Zeilen (`relativeTime` und `vergleichen` bleiben in Gebrauch), Kopf wird `rubrik="Transkribor" titel="Übersicht"`. Die Leerzustände (lädt / Fehler / noch keine Projekte) bleiben **unverändert** — sie sind der erste Eindruck der App.

```tsx
  const laufende = useMemo(
    () => projects.filter(p => (p.active_jobs?.length ?? 0) > 0).sort((a, b) => vergleichen(a, b, 'geaendert')),
    [projects])
  // Fuenf, nicht alle: die vollstaendige Liste steht in der Seitenleiste. Diese Seite
  // beantwortet "woran war ich dran", nicht "was gibt es alles".
  const juengste = useMemo(
    () => [...projects].sort((a, b) => vergleichen(a, b, 'geaendert')).slice(0, 5),
    [projects])
```

Der Abschnitt „Läuft gerade" bleibt wortgleich stehen (Karten, Fortschrittsbalken,
`DeleteProjectDialog`). Der Abschnitt „Alle" wird ersetzt durch:

```tsx
          <section>
            <h2 className="rubrik mb-3">Zuletzt geändert</h2>
            <ul className="blatt divide-y divide-border overflow-hidden">
              {juengste.map(p => (
                <li key={p.name} className="group flex items-center hover:bg-muted/60">
                  <Link to={`/p/${encodeURIComponent(p.name)}`}
                    className="flex h-11 min-w-0 flex-1 items-center gap-3 px-3 outline-none
                               focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                    <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                      {p.dateien} Datei{p.dateien === 1 ? '' : 'en'}
                      {p.dateien > 0 && ` · ${p.fertig} fertig`}
                    </span>
                    <time dateTime={new Date(p.geaendert * 1000).toISOString()}
                      className="w-24 shrink-0 text-right text-sm text-muted-foreground">
                      {relativeTime(p.geaendert)}
                    </time>
                  </Link>
                  {/* Geschwister des Links, nicht sein Kind: ein <button> in einem <a> ist
                      ungueltiges HTML und der Klick landete zusaetzlich im Link. */}
                  <div className="shrink-0 px-3 opacity-0 transition-opacity
                                  group-hover:opacity-100 focus-within:opacity-100">
                    <DeleteProjectDialog project={p.name} onDeleted={refresh} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
```

- [ ] **Step 4: Tests laufen lassen, Erfolg bestätigen**

Run: `npm --prefix webtool/frontend test -- HomeGallery`
Expected: PASS

- [ ] **Step 5: Ganze Suite + Typen + Lint**

Run: `npm --prefix webtool/frontend test && npm --prefix webtool/frontend run build && npm --prefix webtool/frontend run lint`
Expected: PASS

- [ ] **Step 6: Committen**

```bash
git add webtool/frontend/src/pages/HomeGallery.tsx webtool/frontend/src/pages/HomeGallery.test.tsx
git commit -m "feat(huelle): Startseite wird Uebersicht, die Projektliste steht in der Leiste"
```

---

# Phase 3 — Titelzeile

### Task 7: Fensteroptionen je Plattform

**Files:**
- Modify: `electron/main.js`
- Create: `electron/fenster.test.js`

**Interfaces:**
- Produces: `module.exports.fensterOptionen(platform: string) => { titleBarStyle: string, titleBarOverlay?: {color, symbolColor, height} }` — exportiert aus `electron/main.js`, verwendet in `fenster()`.

**Warum rein:** `main.js` lädt `electron`; ein Test dagegen bräuchte einen Electron-Prozess. Dieselbe Lösung wie bei `setup.plan(platform, paketmanager)` — die Entscheidung ist eine reine Funktion, der Rest ist Verdrahtung. macOS und Linux sind aus dem gebauten Paket nie gestartet worden (Issue #36); die Plattformweiche ist das Einzige daran, was sich ohne diese Hardware prüfen lässt.

- [ ] **Step 1: Test schreiben**

`electron/fenster.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { fensterOptionen, TITELLEISTE_HOEHE } = require('./main')

test('Windows und Linux bekommen ein Overlay mit nativen Knoepfen', () => {
  for (const p of ['win32', 'linux']) {
    const o = fensterOptionen(p)
    assert.strictEqual(o.titleBarStyle, 'hidden', p)
    assert.ok(o.titleBarOverlay, `${p}: ohne Overlay malt niemand die Fensterknoepfe`)
    // Muss zur Hoehe der TitleBar-Komponente passen, sonst sitzen die Knoepfe versetzt.
    assert.strictEqual(o.titleBarOverlay.height, TITELLEISTE_HOEHE, p)
  }
})

test('macOS behaelt seine Ampelknoepfe und bekommt KEIN Overlay', () => {
  const o = fensterOptionen('darwin')
  assert.strictEqual(o.titleBarStyle, 'hiddenInset')
  // titleBarOverlay ist auf macOS wirkungslos; gesetzt zu lassen taeuscht den Leser.
  assert.strictEqual(o.titleBarOverlay, undefined)
})
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm run test:electron`
Expected: FAIL — `fensterOptionen is not a function`

- [ ] **Step 3: In `main.js` implementieren**

Über `fenster()` einfügen:

```js
/** Muss mit der Hoehe in webtool/frontend/src/components/TitleBar.tsx uebereinstimmen —
 *  das Overlay wird vom Betriebssystem ueber unsere Zeile gelegt, nicht daneben. */
const TITELLEISTE_HOEHE = 40

/**
 * Rahmenloses Fenster, aber die Fensterknoepfe malt weiterhin das Betriebssystem:
 * 'hidden' + titleBarOverlay auf Windows/Linux, 'hiddenInset' auf macOS (Ampelknoepfe
 * bleiben nativ, nur eingerueckt). Selbst gezeichnete Knoepfe waeren das eine Stueck,
 * das auf jeder Plattform anders bricht — und macOS/Linux sind hier ungeprueft.
 *
 * Farben sind Startwerte: der Renderer schiebt beim Themenwechsel per 'titelleisteFarbe'
 * nach, sonst stuenden im Dunkelmodus schwarze Symbole auf dunklem Grund.
 */
function fensterOptionen(platform) {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0B0B0F', symbolColor: '#FAFAFA', height: TITELLEISTE_HOEHE },
  }
}
```

In `fenster()` einsetzen (`nativeTheme` bestimmt die Startfarbe wie schon bei `backgroundColor`):

```js
function fenster() {
  const dunkel = nativeTheme.shouldUseDarkColors
  const opt = fensterOptionen(process.platform)
  if (opt.titleBarOverlay) {
    opt.titleBarOverlay.color = dunkel ? '#0B0B0F' : '#FAFAFA'
    opt.titleBarOverlay.symbolColor = dunkel ? '#FAFAFA' : '#0B0B0F'
  }
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: dunkel ? '#0B0B0F' : '#FAFAFA',
    show: true,
    ...opt,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })
  ...
}
```

Am Dateiende ergänzen (`main.js` hat heute kein `module.exports`):

```js
// Nur fuer die Tests: die Plattformweiche ist die einzige Entscheidung in dieser Datei,
// die sich ohne laufenden Electron-Prozess pruefen laesst.
module.exports = { fensterOptionen, TITELLEISTE_HOEHE }
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npm run test:electron`
Expected: PASS — inklusive der bestehenden Tests.

> Lädt `require('./main')` beim Test Electron-Module und bricht ab, wandert `fensterOptionen` samt `TITELLEISTE_HOEHE` in ein eigenes `electron/fenster.js` (kein `require('electron')`), das `main.js` einbindet. Das ist die gleiche Aufteilung, die `updater.js` schon hat: Automat ohne Electron, Verdrahtung mit.

- [ ] **Step 5: Committen**

```bash
git add electron/main.js electron/fenster.test.js
git commit -m "feat(huelle): rahmenloses Fenster, Fensterknoepfe malt das Betriebssystem"
```

---

### Task 8: Titelzeile im Renderer

**Files:**
- Create: `webtool/frontend/src/components/TitleBar.tsx`
- Test: `webtool/frontend/src/components/TitleBar.test.tsx`
- Modify: `webtool/frontend/src/components/AppShell.tsx`, `electron/preload.js`, `electron/main.js`, `webtool/frontend/src/components/ThemeProvider.tsx`

**Interfaces:**
- Consumes: `window.transkribor?.plattform: string | undefined`, `window.transkribor?.titelleisteFarbe(f: {color: string; symbolColor: string}): Promise<void>`.
- Produces: `<TitleBar titel={string} />` — rendert `null` ohne Electron-Brücke.

- [ ] **Step 1: Test schreiben**

`webtool/frontend/src/components/TitleBar.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TitleBar } from './TitleBar'

function bruecke(plattform: string) {
  ;(window as unknown as { transkribor: unknown }).transkribor = { plattform, titelleisteFarbe: async () => {} }
}

describe('TitleBar', () => {
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('erscheint im normalen Browser GAR NICHT', () => {
    // Dieselbe Oberflaeche laeuft unter webtool.ps1 (:8000) und Vite (:5173). Dort gibt es
    // kein rahmenloses Fenster -- eine Zeile mit Fensterknoepfen waere dort schlicht falsch.
    const { container } = render(<TitleBar titel="Alpha" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('zeigt den Titel unter Electron', () => {
    bruecke('win32')
    render(<TitleBar titel="Alpha · audio_02" />)
    expect(screen.getByText('Alpha · audio_02')).toBeInTheDocument()
  })

  it('haelt links Platz fuer die Ampelknoepfe auf macOS', () => {
    bruecke('darwin')
    render(<TitleBar titel="Alpha" />)
    expect(screen.getByRole('banner')).toHaveClass('pl-[78px]')
  })
})
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- TitleBar`
Expected: FAIL — `Failed to resolve import "./TitleBar"`

- [ ] **Step 3: Komponente schreiben**

`webtool/frontend/src/components/TitleBar.tsx`:

```tsx
import { cn } from '@/lib/utils'

/** Vorhanden = wir laufen unter Electron. Im Browser (webtool.ps1 :8000, Vite :5173) fehlt
 *  das Objekt, und dann gibt es weder ein rahmenloses Fenster noch etwas zu zeichnen. */
function plattform(): string | null {
  const w = window as unknown as { transkribor?: { plattform?: string } }
  return w.transkribor?.plattform ?? null
}

/**
 * Die eigene Titelzeile. Sie zeichnet NUR Text — Minimieren/Maximieren/Schliessen legt das
 * Betriebssystem als Overlay darueber (Windows/Linux) bzw. laesst seine Ampelknoepfe stehen
 * (macOS, 'hiddenInset'). Darum die Rand-Reserven: links auf macOS, rechts sonst.
 *
 * app-region: drag macht die Zeile zum Ziehgriff; ohne user-select:none faengt ein
 * Ziehversuch stattdessen an, den Titel zu markieren.
 */
export function TitleBar({ titel }: { titel: string }) {
  const p = plattform()
  if (!p) return null
  const mac = p === 'darwin'
  return (
    <header role="banner"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      className={cn(
        'col-span-2 flex h-10 shrink-0 select-none items-center border-b bg-background',
        // Reserve fuer die Knoepfe, die NICHT wir malen. Ohne sie liegt der Titel darunter.
        mac ? 'pl-[78px] pr-3' : 'pl-3 pr-[140px]',
      )}>
      <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-muted-foreground">
        {titel}
      </span>
    </header>
  )
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npm --prefix webtool/frontend test -- TitleBar`
Expected: PASS — 3 Tests

- [ ] **Step 5: Brücke erweitern**

`electron/preload.js` — zwei Einträge in `exposeInMainWorld('transkribor', {...})`:

```js
  // Fuer die Rand-Reserven der eigenen Titelzeile: die Fensterknoepfe stehen auf macOS
  // links, sonst rechts. process.platform gibt es im Renderer nicht (contextIsolation).
  plattform: process.platform,
  titelleisteFarbe: f => ipcRenderer.invoke('titelleisteFarbe', f),
```

`electron/main.js` — Kanal dazu:

```js
// Das Overlay ist eine feste Farbe im Hauptprozess und weiss nichts vom Thema der Seite.
// Ohne diesen Weg stuenden im Dunkelmodus schwarze Fensterknoepfe auf dunklem Grund.
ipcMain.handle('titelleisteFarbe', (_e, f) => {
  if (!win || win.isDestroyed() || process.platform === 'darwin') return
  win.setTitleBarOverlay({ color: f.color, symbolColor: f.symbolColor, height: TITELLEISTE_HOEHE })
})
```

- [ ] **Step 6: Farbe beim Themenwechsel nachschieben**

`ThemeProvider.tsx:14-17` — der vorhandene Effekt wird um den dritten Empfänger erweitert:

```tsx
  useEffect(() => {
    const dunkel = theme === 'dark'
    document.documentElement.classList.toggle('dark', dunkel)
    localStorage.setItem('theme', theme)
    // Dritter Empfaenger des Themas: die eigene Titelzeile faerbt sich per CSS mit, das
    // Fensterknopf-Overlay des Betriebssystems DARUEBER nicht — das kann nur der
    // Hauptprozess. Ohne Bruecke (normaler Browser) faellt der Aufruf weg.
    // Die Werte spiegeln --background aus index.css; laufen sie auseinander, sieht man
    // eine Kante zwischen unserer Zeile und den Fensterknoepfen.
    const w = window as unknown as {
      transkribor?: { titelleisteFarbe?: (f: { color: string; symbolColor: string }) => Promise<void> }
    }
    w.transkribor?.titelleisteFarbe?.(dunkel
      ? { color: '#0B0B0F', symbolColor: '#FAFAFA' }
      : { color: '#FAFAFA', symbolColor: '#0B0B0F' })?.catch?.(() => {})
  }, [theme])
```

- [ ] **Step 7: In `AppShell` einhängen**

Die Zeile ist die erste Rasterreihe und überspannt die Spalten. In `Rahmen` (Task 5):

```tsx
      <div className="grid h-screen grid-rows-[auto_1fr_auto] md:grid-cols-[260px_1fr]">
        <TitleBar titel={projekt ?? 'Transkribor'} />
        <aside className="hidden min-h-0 border-r md:block"><Leiste /></aside>
        <div id="inhalt" tabIndex={-1} ref={inhalt}
          className="min-h-0 overflow-auto outline-none">{children}</div>
        <StatusBar />
      </div>
```

`projekt` kommt aus `useDateien()`; `Rahmen` liegt bereits im Provider. Die `col-span-2` in
`TitleBar.tsx` gilt nur ab `md` — auf schmalen Fenstern gibt es nur eine Spalte. Die Klasse dort
entsprechend als `col-span-1 md:col-span-2` schreiben.

> Der Titel ist hier bewusst nur ein Zwischenstand — Task 9 ersetzt ihn durch `useDokumentTitel()`, das zusätzlich Datei und Laufzustand trägt.

- [ ] **Step 8: Alle Tests + Electron-Tests + Typen**

Run: `npm --prefix webtool/frontend test && npm run test:electron && npm --prefix webtool/frontend run build`
Expected: PASS. `electron/preload.test.js` prüft die Liste der freigegebenen Namen — die zwei neuen dort ergänzen.

- [ ] **Step 9: Sichtprüfung im gebauten Fenster**

Run: `npm start`
1. Fenster hat keine Systemtitelzeile, aber Minimieren/Maximieren/Schliessen funktionieren.
2. Ziehen an der Zeile bewegt das Fenster; Doppelklick maximiert.
3. Thema umschalten → Fensterknöpfe wechseln die Farbe mit.
4. Dann `.\webtool.ps1` im Browser: **keine** Titelzeile, Layout unverändert.

- [ ] **Step 10: Committen**

```bash
git add webtool/frontend/src/components/ electron/preload.js electron/main.js
git commit -m "feat(huelle): eigene Titelzeile, Farbe folgt dem Thema"
```

---

# Phase 4 — Betriebssystem-Integration

### Task 9: Fenstertitel folgt der Arbeit

**Files:**
- Create: `webtool/frontend/src/hooks/useDokumentTitel.ts`
- Test: `webtool/frontend/src/hooks/useDokumentTitel.test.tsx`
- Modify: `webtool/frontend/src/components/AppShell.tsx`
- Modify: `webtool/frontend/src/components/Toolbar.tsx:8-16`, `webtool/frontend/src/pages/EditorView.tsx:59`

**Interfaces:**
- Consumes: `useDateien()` (Projekt), `useMatch('/p/:project/:base')` (Datei), `useActiveJob()` → `{jobs}`, `mergePhases` aus `@/hooks/useActiveJob`, `describePhases(p: JobPhases): string` aus `@/lib/jobPhases`.
- Produces:
  - `fensterTitel(ort: string, lauf: string): string` — reine Funktion, für sich testbar
  - `useDokumentTitel(): string` — setzt `document.title` als Seiteneffekt **und** gibt ihn zurück, damit `TitleBar` denselben Text ohne zweite Quelle zeigt

- [ ] **Step 1: Test schreiben**

`webtool/frontend/src/hooks/useDokumentTitel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ProjektDatenProvider } from './useProjektDaten'
import { JobProvider } from './useActiveJob'
import { useDokumentTitel } from './useDokumentTitel'
import * as api from '@/lib/api'

vi.mock('@/lib/api')
function Probe() { useDokumentTitel(); return null }
function zeigen(pfad: string) {
  render(
    <MemoryRouter initialEntries={[pfad]}>
      <JobProvider><ProjektDatenProvider><Probe /></ProjektDatenProvider></JobProvider>
    </MemoryRouter>,
  )
}

describe('useDokumentTitel', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: [] })
  })

  it('nennt nur die App auf der Startseite', async () => {
    zeigen('/')
    await waitFor(() => expect(document.title).toBe('Transkribor'))
  })

  it('nennt das Projekt', async () => {
    zeigen('/p/Alpha')
    await waitFor(() => expect(document.title).toBe('Alpha — Transkribor'))
  })

  it('nennt Projekt und Datei im Editor', async () => {
    zeigen('/p/Alpha/audio_02')
    await waitFor(() => expect(document.title).toBe('Alpha · audio_02 — Transkribor'))
  })
})

describe('fensterTitel', () => {
  it('stellt den Laufzustand VOR den Ort', () => {
    // Taskleiste und Alt-Tab zeigen nur die ersten Zeichen -- "laeuft es noch?" muss
    // dort stehen, nicht der Projektname.
    expect(fensterTitel('Alpha · audio_02', 'Korrigiere audio_02 · 38%'))
      .toBe('Korrigiere audio_02 · 38% — Alpha · audio_02 — Transkribor')
  })
  it('laesst leere Teile weg statt Trennzeichen zu haeufen', () => {
    expect(fensterTitel('Alpha', '')).toBe('Alpha — Transkribor')
    expect(fensterTitel('', '')).toBe('Transkribor')
  })
})
```

Import im Testkopf: `import { fensterTitel, useDokumentTitel } from './useDokumentTitel'`.

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- useDokumentTitel`
Expected: FAIL — `Failed to resolve import "./useDokumentTitel"`

- [ ] **Step 3: Hook schreiben**

```ts
import { useEffect } from 'react'
import { useMatch } from 'react-router-dom'
import { useDateien } from './useProjektDaten'
import { mergePhases, useActiveJob } from './useActiveJob'
import { describePhases } from '@/lib/jobPhases'

const APP = 'Transkribor'

/**
 * Der Laufzustand steht VORNE, der Ort dahinter: in der Taskleiste und im Alt-Tab-Umschalter
 * sieht man nur die ersten Zeichen — und genau die Frage ("laeuft es noch?") ist der Grund,
 * warum diese App ueberhaupt einen sprechenden Fenstertitel braucht. Ihre Laeufe dauern
 * Minuten bis eine halbe Stunde; wer waehrenddessen etwas anderes tut, soll nicht das
 * Fenster hervorholen muessen.
 *
 * Rein und exportiert, damit die Zusammensetzung ohne Job-Verdrahtung pruefbar ist.
 */
export function fensterTitel(ort: string, lauf: string): string {
  const vorn = [lauf, ort].filter(Boolean).join(' · ')
  return vorn ? `${vorn} — ${APP}` : APP
}

/**
 * Setzt `document.title` — und damit unter Electron auch den Fenstertitel: BrowserWindow
 * folgt dem Dokumenttitel ueber sein 'page-title-updated'-Ereignis, solange niemand
 * preventDefault() ruft. Ein IPC-Kanal dafuer waere ueberfluessig.
 *
 * Der Titel ist gleichzeitig der Text der eigenen Titelzeile — darum gibt der Hook ihn
 * zurueck: `document.title` zu lesen loest kein Rerender aus, ein Rueckgabewert schon.
 */
export function useDokumentTitel(): string {
  const { projekt } = useDateien()
  const { jobs } = useActiveJob()
  const imEditor = useMatch('/p/:project/:base')
  const datei = imEditor?.params.base ?? null

  // NUR die Jobs dieses Projekts: Basisnamen wiederholen sich ueber Projekte hinweg, und
  // mergePhases ist nach Basisnamen indiziert (siehe dessen Kommentar).
  const meine = jobs.filter(j => j.project === projekt && j.status === 'running')
  const lauf = meine.length ? describePhases(mergePhases(meine)) : ''
  const ort = !projekt ? '' : datei ? `${projekt} · ${datei}` : projekt

  const titel = fensterTitel(ort, lauf)
  useEffect(() => { document.title = titel }, [titel])
  return titel
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npm --prefix webtool/frontend test -- useDokumentTitel`
Expected: PASS — 3 Tests

- [ ] **Step 5: In `Rahmen` verdrahten**

In `AppShell.tsx` ersetzt der Hook den Zwischenstand aus Task 8:

```tsx
function Rahmen({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const inhalt = useRef<HTMLDivElement>(null)
  const titel = useDokumentTitel()
  useEffect(() => { inhalt.current?.scrollTo?.({ top: 0 }) }, [pathname])
  return (
    <>
      <a href="#inhalt" className="sr-only focus:not-sr-only …">Zum Inhalt</a>
      <div className="grid h-screen grid-rows-[auto_1fr_auto] md:grid-cols-[260px_1fr]">
        <TitleBar titel={titel} />
        <aside className="hidden min-h-0 border-r md:block"><Leiste /></aside>
        <div id="inhalt" tabIndex={-1} ref={inhalt}
          className="min-h-0 overflow-auto outline-none">{children}</div>
        <StatusBar />
      </div>
    </>
  )
}
```

- [ ] **Step 6: Der Dateiname steht nur noch einmal**

`Toolbar` und `TitleBar` zeigten beide `Projekt / Datei` bzw. `Projekt · Datei` — direkt
übereinander, in zwei Schreibweisen. Die Toolbar gibt ihn ab:

- `Toolbar.tsx:8-16`: `title` aus den Props streichen und die Zeile
  `<span className="min-w-0 truncate text-sm font-medium">{title}</span>` entfernen. Das
  `dirty`-Abzeichen rückt damit an den linken Rand — dort gehört es hin, es ist der Zustand
  **dieser** Datei.
- `EditorView.tsx:59`: das `title`-Memo löschen und die Prop nicht mehr übergeben.
- Falls `Toolbar.test.tsx` den Titel prüft: den Fall entfernen.

> **Warum das auch im Browser trägt:** ohne Electron gibt es keine `TitleBar` — dort zeigt der
> **Tab-Titel** dieselbe Angabe, weil `useDokumentTitel` `document.title` setzt. Beide
> Betriebsarten nennen die Datei also weiterhin, nur nie zweimal auf einmal.

- [ ] **Step 7: Alle Tests + Typen**

Run: `npm --prefix webtool/frontend test && npm --prefix webtool/frontend run build`
Expected: PASS

- [ ] **Step 8: Committen**

```bash
git add webtool/frontend/src/hooks/useDokumentTitel.ts webtool/frontend/src/hooks/useDokumentTitel.test.tsx \
        webtool/frontend/src/components/AppShell.tsx webtool/frontend/src/components/Toolbar.tsx \
        webtool/frontend/src/pages/EditorView.tsx
git commit -m "feat(os): Fenstertitel traegt Lauf, Projekt und Datei -- Toolbar gibt ihn ab"
```

---

### Task 10: Systemmeldung und Taskleisten-Fortschritt

**Files:**
- Create: `webtool/frontend/src/hooks/useOsFortschritt.ts`
- Test: `webtool/frontend/src/hooks/useOsFortschritt.test.tsx`
- Modify: `webtool/frontend/src/components/AppShell.tsx`, `electron/preload.js`, `electron/main.js`, `electron/preload.test.js`

**Interfaces:**
- Consumes: `useActiveJob()` → `{jobs, onSettled}`; `useProjekte()` → `{projects}`; `window.transkribor?.fortschritt(anteil: number): Promise<void>`; globale `Notification`.
- Produces: `useOsFortschritt(): void` — reiner Seiteneffekt, in `Rahmen` aufgerufen.

- [ ] **Step 1: Test schreiben**

`webtool/frontend/src/hooks/useOsFortschritt.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { JobProvider, useActiveJob } from './useActiveJob'
import { ProjektDatenProvider } from './useProjektDaten'
import { useOsFortschritt } from './useOsFortschritt'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

const meldungen: string[] = []
class MeldungAttrappe {
  static permission = 'granted'
  constructor(titel: string) { meldungen.push(titel) }
  static requestPermission = vi.fn().mockResolvedValue('granted')
}

function Probe() {
  useOsFortschritt()
  const { adopt } = useActiveJob()
  ;(globalThis as unknown as { __adopt: typeof adopt }).__adopt = adopt
  return null
}

function zeigen() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <JobProvider intervalMs={10}><ProjektDatenProvider><Probe /></ProjektDatenProvider></JobProvider>
    </MemoryRouter>,
  )
}

describe('useOsFortschritt', () => {
  const fortschritt = vi.fn()
  beforeEach(() => {
    meldungen.length = 0
    vi.resetAllMocks()
    vi.mocked(api.listProjects).mockResolvedValue([])
    ;(globalThis as unknown as { Notification: unknown }).Notification = MeldungAttrappe
    ;(window as unknown as { transkribor: unknown }).transkribor = { fortschritt }
  })
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('meldet einen fertigen Lauf GENAU EINMAL', async () => {
    // onSettled feuert bei JEDEM Poll-Tick, in dem irgendein Job terminal ist -- nicht
    // einmal je Lauf. Ohne Riegel meldet die App im Sekundentakt dasselbe.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', lines: [], kind: 'correct' })
    zeigen()
    const adopt = (globalThis as unknown as { __adopt: (i: string, p: string, k: string) => void }).__adopt
    await act(async () => { adopt('j1', 'Alpha', 'correct') })
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    expect(meldungen).toHaveLength(1)
    expect(meldungen[0]).toContain('Alpha')
  })

  it('raeumt den Taskleisten-Balken ab, wenn nichts mehr laeuft', async () => {
    zeigen()
    await act(async () => { await Promise.resolve() })
    // -1 heisst bei Electron "Balken weg". Ohne das bliebe er fuer immer stehen.
    expect(fortschritt).toHaveBeenLastCalledWith(-1)
  })

  it('faellt im Browser ohne Bruecke nicht um', async () => {
    delete (window as unknown as { transkribor?: unknown }).transkribor
    zeigen()
    await act(async () => { await Promise.resolve() })
    expect(true).toBe(true)     // kein Wurf ist die Zusicherung
  })
})
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- useOsFortschritt`
Expected: FAIL — `Failed to resolve import "./useOsFortschritt"`

- [ ] **Step 3: Hook schreiben**

> **Der Code unten ist der Entwurf, nicht der Endstand.** Umgesetzt wurde der `Set`-Riegel
> gegen Doppelmeldungen NICHT: `onSettled` traegt seit Task 10 seine Nutzlast (`beendet: Job[]`,
> nur die in DIESEM Tick terminal gewordenen Laeufe), womit die Einmaligkeit aus der Quelle
> kommt statt aus einem Merkzettel im Verbraucher — der Riegel war danach tot und ist raus.
> Der Stand von heute steht in `webtool/frontend/src/hooks/useOsFortschritt.ts` und
> `useActiveJob.tsx`.


```ts
import { useEffect, useRef } from 'react'
import { useActiveJob } from './useActiveJob'
import { useProjekte } from './useProjektDaten'
import { KIND_LABEL } from '@/lib/jobPhases'

function bruecke() {
  const w = window as unknown as { transkribor?: { fortschritt?: (a: number) => Promise<void> } }
  return w.transkribor?.fortschritt ?? null
}

/**
 * Die zwei Dinge, die eine App tut und eine Webseite nicht: Bescheid geben, wenn eine
 * halbe Stunde Rechnen vorbei ist, und den Fortschritt am Symbol in der Taskleiste zeigen.
 *
 * Beide sind im Browser wirkungslos, aber nicht kaputt: `Notification` gibt es dort auch
 * (nur mit Erlaubnisfrage), `fortschritt` fehlt und wird uebersprungen.
 */
export function useOsFortschritt(): void {
  const { jobs, onSettled } = useActiveJob()
  const { projects } = useProjekte()
  // Welche Laeufe schon gemeldet wurden. onSettled feuert bei JEDEM Tick, in dem ein Job
  // terminal ist -- ohne diesen Riegel meldet die App im Poll-Takt dasselbe noch einmal.
  const gemeldet = useRef(new Set<string>())

  useEffect(() => onSettled(() => {
    for (const j of jobs) {
      if (j.status === 'running' || gemeldet.current.has(j.id)) continue
      gemeldet.current.add(j.id)
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') continue
      const was = KIND_LABEL[j.kind] ?? j.kind
      new Notification(
        j.status === 'done' ? `${j.project}: ${was} fertig` : `${j.project}: ${was} fehlgeschlagen`,
        { body: j.status === 'done' ? 'Das Ergebnis liegt im Projekt.' : 'Details stehen im Protokoll.' },
      )
    }
  }), [onSettled, jobs])

  // Erlaubnis EINMAL erfragen, nicht bei jedem Lauf: unter Electron ist sie ohnehin
  // erteilt, im Browser waere eine wiederholte Frage aufdringlich.
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  const laufend = jobs.filter(j => j.status === 'running')
  const projekt = projects.find(p => p.name === laufend[0]?.project)
  // -1 raeumt den Balken ab. Ohne das bleibt er nach dem letzten Lauf fuer immer stehen.
  const anteil = laufend.length === 0 || !projekt || projekt.dateien === 0
    ? -1 : projekt.fertig / projekt.dateien
  useEffect(() => { bruecke()?.(anteil)?.catch?.(() => {}) }, [anteil])
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npm --prefix webtool/frontend test -- useOsFortschritt`
Expected: PASS — 3 Tests

- [ ] **Step 5: Gegenprobe für den Riegel**

`gemeldet.current.has(j.id)` in der Bedingung entfernen → der erste Test muss **rot** werden (mehr als eine Meldung). Danach zurück. Ohne diese Gegenprobe prüft der Test nur, dass überhaupt gemeldet wird.

- [ ] **Step 6: Brücke + Hauptprozess**

`electron/preload.js`:

```js
  fortschritt: a => ipcRenderer.invoke('fortschritt', a),
```

`electron/main.js`:

```js
// Anteil 0..1 zeigt den Balken, <0 raeumt ihn ab, >1 waere unbestimmt. Der Renderer
// schickt -1, sobald nichts mehr laeuft — sonst bleibt der Balken nach dem letzten
// Lauf am Symbol stehen und behauptet Arbeit, die es nicht gibt.
ipcMain.handle('fortschritt', (_e, anteil) => {
  if (win && !win.isDestroyed()) win.setProgressBar(typeof anteil === 'number' ? anteil : -1)
})
```

`electron/preload.test.js` um die neuen Namen ergänzen.

- [ ] **Step 7: In `Rahmen` aufrufen**

```tsx
function Rahmen({ children }: { children: ReactNode }) {
  const titel = useDokumentTitel()
  useOsFortschritt()
  ...
```

- [ ] **Step 8: Alles laufen lassen**

Run: `npm --prefix webtool/frontend test && npm run test:electron && npm --prefix webtool/frontend run build && npm --prefix webtool/frontend run lint`
Expected: PASS

- [ ] **Step 9: Sichtprüfung im gebauten Fenster**

Run: `npm start` — ein Projekt mit mehreren Dateien transkribieren lassen:
1. Balken erscheint am Taskleistensymbol und wächst.
2. Am Ende **eine** Systemmeldung, nicht mehrere.
3. Balken verschwindet, sobald nichts mehr läuft.

- [ ] **Step 10: Committen**

```bash
git add webtool/frontend/src/hooks/useOsFortschritt.ts webtool/frontend/src/hooks/useOsFortschritt.test.tsx \
        webtool/frontend/src/components/AppShell.tsx electron/preload.js electron/preload.test.js electron/main.js
git commit -m "feat(os): Systemmeldung am Laufende und Fortschritt in der Taskleiste"
```

---

## Abschluss

- [ ] **CLAUDE.md ergänzen** — ein Abschnitt „App-Hülle" mit den drei Dingen, die man nicht aus dem Diff liest: dass es genau **eine** Stelle mit `h-screen` gibt, dass `window.transkribor` die Weiche zwischen App- und Browser-Betrieb ist, und dass `onSettled` je Tick feuert (der Riegel in `useOsFortschritt`).
- [ ] **PR öffnen** gegen `master`, CI abwarten, CodeRabbit-Befunde abarbeiten, rebase-mergen.

## Nicht in diesem Plan

- **Die Arbeitsfläche `/p/:project` eindampfen.** Ihre Dateiliste und ihre Projekt-Aktionen stehen
  ab Task 5 auch in der Leiste. Falsch wird die Seite dadurch nicht, teilweise doppelt schon.
  Sie auf Hochladen + URL-Import + Laufsteuerung zu reduzieren wäre folgerichtig — ist aber eine
  eigene Entscheidung, die man besser trifft, nachdem man die Leiste eine Weile benutzt hat.
- **Anklickbare Systemmeldung** (`notification.onclick` → Fenster nach vorn, zum Projekt
  springen). Naheliegend, aber die Fokus-Übernahme verhält sich je Plattform anders — und
  macOS/Linux sind hier ungeprüft (Issue #36).
- Menü, „zuletzt geöffnet", Tabs.
- Einklappbare Seitenleiste (`Ctrl+B`) — bewusst verworfen, kostet einen persistenten Zustand ohne belegten Nutzen. Unter `md` verschwindet sie ohnehin ohne Schalter.
- Virtualisierung der Seitenleiste. Bei 300 Projekten war die Liste in PR #67 gemessen unkritisch.
- macOS/Linux aus dem gebauten Paket starten — das ist Issue #36 und bleibt offen.
