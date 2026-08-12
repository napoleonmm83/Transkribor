# Sprachauswahl + Korrektur-Tiefe — Frontend Implementierungsplan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sprache und Korrektur-Tiefe im Web-Tool wählbar machen — pro Upload/URL-Import und in Projekt-Einstellungen — so dass die (in Plan 1 gebaute) Backend-Logik für den Nutzer erreichbar ist.

**Architecture:** `types.ts` + `api.ts` bekommen Projekt-Einstellungen-Typen und zwei Endpunkt-Funktionen; `uploadAudio`/`fetchUrls` nehmen optionales `sprache` auf. Ein neues `ProjektEinstellungenDialog` (zwei `<Select>`s, kontrollierter Modus) hängt im `ProjektMenue`. `UploadDropzone` und `UrlFetch` bekommen je einen Sprach-`<Select>`, deren Vorgabe das Projekt-Standard aus `ProjectWorkspace` ist. README wird korrekt (war zuvor inkorrekt).

**Tech Stack:** React 19, TypeScript, Tailwind v4, shadcn/ui (Select/Dialog/DropdownMenu/Badge), vitest + @testing-library/react. Spec: `docs/superpowers/specs/2026-08-12-transkribor-sprachauswahl-korrektur-tiefe-design.md`. Issue #132. Baut auf Branch `feat/sprachauswahl-korrektur-tiefe` (Plan 1) auf.

## Global Constraints

- **Backend steht (Plan 1):** `GET/PUT /api/projects/{project}/einstellungen` → `{sprache, korrektur, sprach_choices:[{id,label,hint}], tiefen:[{id,label}]}`; `POST …/audio` nimmt Form-Feld `sprache`; `POST …/fetch` Body nimmt `sprache`. Nichts an Backend/Python ändern.
- **Default = Schweizerdeutsch:** ein Projekt ohne `projekt.json` liefert `sprache="ch"`, `korrektur="auto"`. Nutzer, die den Wähler nicht anfassen, bekommen unverändert die Schweizerdeutsch-Pipeline.
- **Per-Upload-Sprache ändert NICHT den Projekt-Standard** (nur der Einstellungs-Dialog tut das). Der Wähler am Upload ist ein Override für genau diese Datei; er defaultet auf den Projekt-Standard.
- **Korrektur-Tiefe am Upload** bewusst weggelassen (Vorgabe `auto` reicht für 90 %; Tiefe ist im Projekt-Einstellungs-Dialog wählbar). YAGNI.
- **README muss wahr werden:** die heutige Zeile „In den Einstellungen lässt sich jede andere von Whisper unterstützte Sprache wählen" ist falsch (es gab keinen Sprachwähler). Plan 2 ersetzt sie durch die tatsächliche Bedienung.
- Test-Kommandos: vitest one-shot `npm --prefix webtool/frontend run test -- --run`; Typecheck/Build `npm --prefix webtool/frontend run build`. Frontend-Dateien dürfen Umlaute (keine ASCII-Pflicht wie bei Python).

## File Structure

| Datei | Verantwortung | Status |
|------|---------------|--------|
| `webtool/frontend/src/lib/types.ts` | `SprachChoice`, `TiefeChoice`, `ProjectEinstellungen` | modify |
| `webtool/frontend/src/lib/api.ts` | `getProjektEinstellungen`/`saveProjektEinstellungen`; `sprache?` an `uploadAudio`/`fetchUrls` | modify |
| `webtool/frontend/src/lib/api.test.ts` | Tests neue Funktionen + sprache-Durchreichung | modify |
| `webtool/frontend/src/components/ProjektEinstellungenDialog.tsx` | Dialog mit Sprache-+Tiefe-Select, kontrolliert | neu |
| `webtool/frontend/src/components/ProjektEinstellungenDialog.test.tsx` | Dialog-Tests | neu |
| `webtool/frontend/src/components/ProjektMenue.tsx` | Menüeintrag „Sprache & Korrektur" + Dialog-Hosting | modify |
| `webtool/frontend/src/components/UploadDropzone.tsx` | Sprach-`<Select>`; sprache an uploadAudio | modify |
| `webtool/frontend/src/components/UploadDropzone.test.tsx` | Test sprache-Durchreichung | modify |
| `webtool/frontend/src/components/UrlFetch.tsx` | Sprach-`<Select>`; sprache an fetchUrls | modify |
| `webtool/frontend/src/components/UrlFetch.test.tsx` | Test sprache-Durchreichung | modify |
| `webtool/frontend/src/pages/ProjectWorkspace.tsx` | lädt Einstellungen, reicht sprache/choices an Picker, Badge | modify |
| `README.md` | Nutzer-Abschnitt Sprache (wahr machen) | modify |

---

## Task 1: Typen + API-Client

**Files:** Modify `lib/types.ts`, `lib/api.ts`, `lib/api.test.ts`.

**Interfaces:**
- Produces: `SprachChoice`/`TiefeChoice`/`ProjectEinstellungen` (types.ts); `getProjektEinstellungen(project)`, `saveProjektEinstellungen(project, patch)` (api.ts); `uploadAudio(project, file, sprache?)`, `fetchUrls(project, urls, sprache?)`.

- [ ] **Step 1: Failing tests (`lib/api.test.ts`)**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as api from './api'

afterEach(() => vi.unstubAllGlobals())

describe('ProjektEinstellungen', () => {
  it('getProjektEinstellungen GETt den codierten Pfad', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'ch', korrektur: 'auto', sprach_choices: [], tiefen: [] }) })
    vi.stubGlobal('fetch', fm)
    await api.getProjektEinstellungen('Food Festival')
    expect(fm).toHaveBeenCalledWith('/api/projects/Food%20Festival/einstellungen')
  })

  it('saveProjektEinstellungen PUTt JSON und gibt die Antwort zurück', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'en', korrektur: 'auto', sprach_choices: [], tiefen: [] }) })
    vi.stubGlobal('fetch', fm)
    const r = await api.saveProjektEinstellungen('p', { sprache: 'en' })
    expect(fm).toHaveBeenCalledWith('/api/projects/p/einstellungen',
      expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/json' } }))
    expect(r.sprache).toBe('en')
  })

  it('uploadAudio hängt sprache an, wenn gesetzt', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ base: 'x', file: 'x.mp3' }) })
    vi.stubGlobal('fetch', fm)
    await api.uploadAudio('p', new File(['a'], 'x.mp3'), 'en')
    const body = fm.mock.calls[0][1].body as FormData
    expect(body.get('sprache')).toBe('en')
  })

  it('uploadAudio ohne sprache setzt kein sprache-Feld', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ base: 'x', file: 'x.mp3' }) })
    vi.stubGlobal('fetch', fm)
    await api.uploadAudio('p', new File(['a'], 'x.mp3'))
    const body = fm.mock.calls[0][1].body as FormData
    expect(body.get('sprache')).toBeNull()
  })

  it('fetchUrls nimmt sprache in den Body auf', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job_id: 'j', started: true }) })
    vi.stubGlobal('fetch', fm)
    await api.fetchUrls('p', ['https://youtu.be/x'], 'en')
    const body = JSON.parse(fm.mock.calls[0][1].body)
    expect(body).toEqual({ urls: ['https://youtu.be/x'], sprache: 'en' })
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`npm --prefix webtool/frontend run test -- --run src/lib/api.test.ts`).

- [ ] **Step 3: Implement**

`types.ts` (neu, neben `WhisperChoice`):
```ts
export type SprachChoice = { id: string; label: string; hint: string }
export type TiefeChoice = { id: string; label: string }
export type ProjectEinstellungen = {
  sprache: string
  korrektur: string
  sprach_choices: SprachChoice[]
  tiefen: TiefeChoice[]
}
```

`api.ts`:
```ts
export async function getProjektEinstellungen(project: string): Promise<ProjectEinstellungen> {
  return get(`/api/projects/${enc(project)}/einstellungen`)
}
export async function saveProjektEinstellungen(project: string, patch: Partial<ProjectEinstellungen>): Promise<ProjectEinstellungen> {
  return jn(await fetch(`/api/projects/${enc(project)}/einstellungen`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }))
}
```
`uploadAudio(project, file, sprache?)`: `if (sprache) fd.append('sprache', sprache)` vorm fetch.
`fetchUrls(project, urls, sprache?)`: Body `{ urls, ...(sprache ? { sprache } : {}) }`.

- [ ] **Step 4: Run — expect PASS.** Then `npm --prefix webtool/frontend run build` (typecheck sauber).

- [ ] **Step 5: Commit** `feat(frontend): Typen + API-Client für Projekt-Einstellungen und sprache-Durchreichung`.

---

## Task 2: `ProjektEinstellungenDialog`

**Files:** Create `components/ProjektEinstellungenDialog.tsx` (+ `.test.tsx`).

**Interfaces:**
- Consumes: `getProjektEinstellungen`, `saveProjektEinstellungen`, `ProjectEinstellungen`.
- Produces: `ProjektEinstellungenDialog({ project, offen, onOpenChange, onGeaendert? })` — kontrollierter Modus (spiegelt `DeleteProjectDialog`-Konvention: `gesteuert` aus `offen!==undefined`, sonst eigener State).

- [ ] **Step 1: Failing test (`ProjektEinstellungenDialog.test.tsx`)** — lädt Einstellungen beim Öffnen, zwei Selects, Speichern PUTtet + schliesst:

```ts
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import * as api from '@/lib/api'
import { ProjektEinstellungenDialog } from './ProjektEinstellungenDialog'

const BASIS = { sprache: 'ch', korrektur: 'auto',
  sprach_choices: [{ id: 'ch', label: 'Schweizerdeutsch', hint: '' }, { id: 'en', label: 'Englisch', hint: '' }],
  tiefen: [{ id: 'voll_dialekt', label: 'Voll' }, { id: 'leicht', label: 'Leicht' }] }

describe('ProjektEinstellungenDialog', () => {
  it('lädt beim Öffnen und speichert die Sprache', async () => {
    vi.mock('@/lib/api', () => ({
      getProjektEinstellungen: vi.fn().mockResolvedValue(BASIS),
      saveProjektEinstellungen: vi.fn().mockResolvedValue({ ...BASIS, sprache: 'en' }),
    }))
    const { container } = render(<ProjektEinstellungenDialog project="p" offen onOpenChange={() => {}} />)
    await waitFor(() => expect(screen.getByText('Schweizerdeutsch')).toBeInTheDocument())
    // shadcn Select öffnen + Englisch wählen via Trigger
    fireEvent.click(container.querySelector('[role="combobox"]')!)
    fireEvent.click(await screen.findByText('Englisch'))
    fireEvent.click(screen.getByText('Speichern'))
    await waitFor(() => expect(api.saveProjektEinstellungen).toHaveBeenCalledWith('p', expect.objectContaining({ sprache: 'en' })))
  })
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — `Dialog` (nicht `AlertDialog`), `gesteuert`-Flag aus `offen !== undefined`, zwei `Select` (Sprache, Tiefe) im Stil `SettingsPage.tsx:238-248` (`<label id=…>` + `<Select value onValueChange>` + `map`), `Speichern`-Knopf → `saveProjektEinstellungen(project, { sprache, korrektur })` → `onGeaendert?.()` + schliessen. Beim Öffnen (`offen` true→) `getProjektEinstellungen` laden. Toast bei Fehler (`sonner`). Umlaute erlaubt.

- [ ] **Step 4: Run — expect PASS** + build.

- [ ] **Step 5: Commit** `feat(frontend): ProjektEinstellungenDialog (Sprache + Korrektur-Tiefe)`.

---

## Task 3: `ProjektMenue` — Eintrag + Dialog-Hosting

**Files:** Modify `components/ProjektMenue.tsx`.

**Interfaces:** Consumes F2's dialog. Adds `<DropdownMenuItem onSelect={() => setZeige('einstellungen')}>` (Icon `Languages`/`Settings` aus lucide), erweitert `zeige`-Union um `'einstellungen'`, rendert den Dialog kontrolliert neben den anderen (ausserhalb des Menüs — sonst hängt der Dialog beim Schliessen aus, gleicher Grund wie bei Umbenennen/Löschen).

- [ ] **Step 1: Failing test** — Eintrag vorhanden, Klick öffnet den Dialog (mock api). Test lädt `ProjektMenue`, findet Menü-Trigger, öffnet, prüft „Sprache & Korrektur"-Item, klickt, erwartet Dialog (z. B. Speichern-Knopf sichtbar).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — `zeige`-Union + Item + kontrollierten Dialog (mit `onGeaendert`, das ein Projekt-Daten-Reload im Workspace anstösst — via Prop-Callback `onEinstellungenGeaendert?`, die `ProjectWorkspace` durchreicht).

- [ ] **Step 4: Run — expect PASS** + build.

- [ ] **Step 5: Commit** `feat(frontend): ProjektMenue-Eintrag 'Sprache & Korrektur'`.

---

## Task 4: Sprach-`<Select>` am Upload und URL-Import

**Files:** Modify `components/UploadDropzone.tsx` (+ test), `components/UrlFetch.tsx` (+ test).

**Interfaces:** Beide bekommen Props `sprache: string`, `sprachChoices: SprachChoice[]`, `onSpracheChange: (id: string) => void`. Rendern einen `Select` (Stil SettingsPage) und reichen `sprache` an `uploadAudio`/`fetchUrls` durch.

- [ ] **Step 1: Failing tests** — bestehende Tests erweitern: nach Setzen der Sprache über den Select wird `uploadAudio`/`fetchUrls` **mit dem sprache-Arg** gerufen. Pattern aus `UploadDropzone.test.tsx`/`UrlFetch.test.tsx` (`vi.mock('@/lib/api')`, `waitFor(() => expect(api.uploadAudio).toHaveBeenCalledWith('p', expect.any(File), 'en'))`).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — Prop-Destructuring, `<Select value={sprache} onValueChange={onSpracheChange}>` über `sprachChoices` mappen; `uploadAudio(project, f, sprache)` bzw. `fetchUrls(project, urls, sprache)`.

- [ ] **Step 4: Run — expect PASS** + build.

- [ ] **Step 5: Commit** `feat(frontend): Sprachwähler am Upload und URL-Import`.

---

## Task 5: `ProjectWorkspace` — Einstellungen laden, reichen, Badge

**Files:** Modify `pages/ProjectWorkspace.tsx` (+ ggf. Test).

**Interfaces:** Consumes F1 (`getProjektEinstellungen`), F3 (`onEinstellungenGeaendert`-Reload), F4 (Picker-Props). Lädt beim Mount die Einstellungen, hält lokalen `sprache`-State (Vorgabe = Einstellungen.sprache), reicht `sprache`/`sprachChoices`/`onSpracheChange` an `UploadDropzone`+`UrlFetch`. Ein `<Badge>` im `PageHeader`-Children-Slot zeigt die Projekt-Standardsprache (Label aus `sprachChoices`). Bei `onEinstellungenGeaendert` Einstellungen neu laden (und lokalen `sprache`-Reset auf neuen Standard, sofern der Nutzer am Upload-Wähler noch nichts verstellt hat — zweckmässig: einfach neu laden und `sprache` auf Einstellungen.sprache setzen).

- [ ] **Step 1: Failing test** — Workspace rendert mit getmockten Einstellungen; Badge zeigt „Schweizerdeutsch"; nach Upload-Auswahl wird der Sprach-Override durchgereicht (ggf. Komponenten gemockt, um Props zu prüfen).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — `useEffect` lädt `getProjektEinstellungen(project)`; State `einstellungen` + `sprache` (init aus einstellungen); Props an die Picker; Badge; Reload-Callback ans `ProjektMenue`.

- [ ] **Step 4: Run — expect PASS** + build.

- [ ] **Step 5: Commit** `feat(frontend): ProjectWorkspace lädt Einstellungen, Sprach-Badge`.

---

## Task 6: README korrekt machen

**Files:** Modify `README.md` (kein Code, kein Test).

- [ ] **Step 1:** Ersetze den unzutreffenden Absatz (README:136-138 „Welche Sprachen? … In den Einstellungen lässt sich jede andere … Sprache wählen.") durch eine wahrheitsgemässe Nutzer-Anleitung in Nutzer-Worten: pro Upload oder Video-URL wählt man die Sprache (Schweizerdeutsch, Deutsch, Englisch, Französisch, Italienisch, Automatisch); Schweizerdeutsch wird wie gehabt vollständig korrigiert (Dialekt → Standarddeutsch), bei sauberen Sprachen bleibt die Originalsprache erhalten; in den **Projekt-Einstellungen** (⋯-Menü) legt man die Standard-Sprache und die Korrektur-Tiefe fest. Kein Changelog-Ton; unter dem passenden Abschnitt; technisch korrekt.

- [ ] **Step 2:** Commit `docs(readme): Sprachauswahl und Korrektur-Tiefe (Nutzer-Einleitung)`.

---

## Self-Review

**Spec-Abdeckung:** Sprache pro Upload/URL (F4) ✓; Projekt-Einstellungen Sprache+Tiefe (F2/F3) ✓; Vorgabe aus Projekt-Standard (F5) ✓; Schweizerdeutsch-Default unverändert (Global Constraint) ✓; README wahr (F6) ✓. **Bewusst nicht in Plan 2:** Sprache pro bereits liegender Datei ändern (Folge-Issue, siehe Spec); Korrektur-Tiefe am Upload-Wähler (YAGNI); globaler „Neu-Projekt-Default" in den Einstellungen (Projekt-Standard reicht).

**Platzhalter:** keiner; jede Aufgabe enthält lauffähigen Code/Test. F3/F5-Tests sind als klare Anweisung + zu kopierendes Pattern gegeben (Menü-Öffnen + Komponenten-Props prüfen), nicht als unvollständiger Stub.

**Typkonsistenz:** `ProjectEinstellungen` (F1) → konsumiert von F2 (Dialog), F5 (Workspace); `sprache`-Prop-Drilling F5→F4 konsistent; `saveProjektEinstellungen(project, patch: Partial<ProjectEinstellungen>)` (F1) → F2 ruft mit `{sprache, korrektur}`.

**Risiko:** shadcn-Select-Tests sind etwas fummelig (Radix rendert ins Portal); ggf. `findByText` + `container.querySelector('[role="combobox"]')` wie im Muster. Build (`tsc -b`) ist strenger als `tsc --noEmit` — ungenutzte Imports vermeiden.
