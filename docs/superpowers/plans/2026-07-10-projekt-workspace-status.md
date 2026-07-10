# Projekt-Workspace + Live-Pipeline-Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine Home-Galerie + Projekt-Arbeitsfläche (react-router) plus reload-robuster Live-Pipeline-Status pro Datei, abgeleitet aus dem Job-stdout.

**Architecture:** Backend bleibt fast unverändert — 5 kleine additive Endpoints/Felder + SPA-Fallback + 1 Zeile in `transcribe.py`. Das Frontend wird auf `react-router-dom` umgestellt (`/`, `/p/:project`, `/p/:project/:base`); der Editor zieht nur in die `:base`-Route um. Der Live-Status kommt aus einem reinen Parser (`parseJobPhases`, Einzel-Cursor-Scan über die stdout-Zeilen des Jobs), gespeist über einen `JobProvider`, der den aktiven Job pollt. Der Job wird nach Reload über ein neues `active_job`-Feld in der Projektliste wiedergefunden.

**Tech Stack:** FastAPI + pytest (Backend); React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui + react-router-dom + vitest/@testing-library (Frontend).

**Spec:** [`docs/superpowers/specs/2026-07-10-transkribor-projekt-workspace-status-design.md`](../specs/2026-07-10-transkribor-projekt-workspace-status-design.md)

## Global Constraints

- **Branch:** Alle Tasks committen auf `feat/projekt-workspace-status` (bereits erstellt, enthält die Spec). Nicht auf `master`.
- **Trust-Boundary:** Jeder `project`/`base` aus URL/Body geht über `paths.safe_name` (Endpoint-Helfer `_validate`). `DELETE` löscht ausschließlich innerhalb `paths.projekte_root()`.
- **Editor unverändert:** `edit_model.py`, `render_md.py`, `correct.py`-Treiber, `jobs.py`-Kern (start/run/cancel/get) und die Diarisierung bleiben inhaltlich unangetastet. Der Editor-Screen funktioniert nach jedem Task weiter.
- **Dependencies:** Kein neues Backend-Paket. Frontend fügt genau **`react-router-dom`** hinzu (kompatibel mit React 19, v7).
- **Status-Quelle:** Der Live-Status wird rein aus den Job-stdout-Zeilen abgeleitet (`parseJobPhases`, Einzel-Cursor-Scan). **Kein** neuer Job-Schritt-State im Backend.
- **Tests:** Backend-pytest in `webtool/test_*.py`; Frontend-vitest als `*.test.ts(x)` neben der Quelle. UI-Texte auf Deutsch.
- **Test-Kommandos (Repo-Root `E:\Git\Transkribor`):**
  - Backend: `.venv/Scripts/python.exe -m pytest webtool/test_api.py -q`
  - Frontend (eine Datei): `npm --prefix webtool/frontend run test -- src/lib/jobPhases.test.ts`
  - Frontend-Build-Check: `npm --prefix webtool/frontend run build`

---

## Phase A — Backend (isoliert, blockiert nichts)

### Task 1: `jobs.active_for(project)`

**Files:**
- Modify: `webtool/jobs.py` (nach `get()`, ~Zeile 118)
- Test: `webtool/test_jobs.py`

**Interfaces:**
- Produces: `active_for(project: str) -> dict | None` — `{"id": str, "kind": str}` des laufenden Jobs für das Projekt, sonst `None`. Thread-safe unter `_lock`.

- [ ] **Step 1: Failing test**

In `webtool/test_jobs.py` anhängen:

```python
def test_active_for_running_then_none():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    assert jobs.active_for("P_af") is None
    jid, started = jobs.start("P_af", slow, cwd=None, kind="correct")
    assert started is True
    assert jobs.active_for("P_af") == {"id": jid, "kind": "correct"}
    _wait(jid)
    assert jobs.active_for("P_af") is None
```

- [ ] **Step 2: Run test, verify it fails**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_jobs.py::test_active_for_running_then_none -q`
Expected: FAIL — `AttributeError: module 'webtool.jobs' has no attribute 'active_for'`

- [ ] **Step 3: Implement**

In `webtool/jobs.py` nach der `get()`-Funktion einfügen:

```python
def active_for(project: str):
    """{'id','kind'} des laufenden Jobs fuer das Projekt, sonst None."""
    with _lock:
        jid = _active.get(project)
        if jid is None:
            return None
        r = _jobs.get(jid)
        if r is None or r["status"] != "running":
            return None
        return {"id": r["id"], "kind": r["kind"]}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_jobs.py -q`
Expected: PASS (alle jobs-Tests grün)

- [ ] **Step 5: Commit**

```bash
git add webtool/jobs.py webtool/test_jobs.py
git commit -m "feat(jobs): active_for(project) -> laufender Job je Projekt"
```

---

### Task 2: `active_job` in `list_projects`

**Files:**
- Modify: `webtool/app.py:92` (`out.append({...})` in `list_projects`)
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `jobs.active_for` (Task 1)
- Produces: `GET /api/projects` → jedes Projekt hat zusätzlich `"active_job": {"id","kind"} | null`.

- [ ] **Step 1: Failing test**

In `webtool/test_api.py` anhängen:

```python
def test_list_projects_active_job_default_none(client):
    demo = next(p for p in client.get("/api/projects").json()["projects"] if p["name"] == "Demo")
    assert demo["active_job"] is None


def test_list_projects_active_job_reported(client, monkeypatch):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "active_for",
                        lambda name: {"id": "j9", "kind": "correct"} if name == "Demo" else None)
    demo = next(p for p in client.get("/api/projects").json()["projects"] if p["name"] == "Demo")
    assert demo["active_job"] == {"id": "j9", "kind": "correct"}
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py::test_list_projects_active_job_default_none -q`
Expected: FAIL — `KeyError: 'active_job'`

- [ ] **Step 3: Implement**

In `webtool/app.py`, in `list_projects`, die `out.append(...)`-Zeile ersetzen:

```python
            out.append({"name": name, "files": files, "active_job": jobs.active_for(name)})
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): active_job je Projekt in /api/projects"
```

---

### Task 3: `POST /api/projects` (Projekt anlegen)

**Files:**
- Modify: `webtool/app.py` (Import `pydantic.BaseModel`; neue Route bei den anderen `/api/projects`-Routen, z.B. nach `list_projects`)
- Test: `webtool/test_api.py`

**Interfaces:**
- Produces: `POST /api/projects` Body `{"name": str}` → `{"ok": true, "name": str}`; 400 bei ungültigem/leerem Namen; 409 wenn Projekt existiert.

- [ ] **Step 1: Failing test**

In `webtool/test_api.py` anhängen:

```python
def test_create_project_ok_and_duplicate_409(client, tmp_path):
    r = client.post("/api/projects", json={"name": "Neu"})
    assert r.status_code == 200 and r.json() == {"ok": True, "name": "Neu"}
    assert (tmp_path / "Neu" / "audio").is_dir()
    assert client.post("/api/projects", json={"name": "Neu"}).status_code == 409
    assert client.post("/api/projects", json={"name": "Demo"}).status_code == 409


def test_create_project_invalid_name_400(client):
    assert client.post("/api/projects", json={"name": "a/b"}).status_code == 400
    assert client.post("/api/projects", json={"name": ""}).status_code == 400
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py::test_create_project_ok_and_duplicate_409 -q`
Expected: FAIL — 405 Method Not Allowed (Route fehlt)

- [ ] **Step 3: Implement**

In `webtool/app.py` oben zu den Imports ergänzen:

```python
from pydantic import BaseModel
```

Und eine Route hinzufügen (unter `list_projects`):

```python
class NewProject(BaseModel):
    name: str


@app.post("/api/projects")
def create_project(body: NewProject):
    try:
        name = paths.safe_name(body.name.strip())
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    pdir = paths.project_dir(name)
    if os.path.exists(pdir):
        raise HTTPException(status_code=409, detail="Projekt existiert bereits")
    os.makedirs(os.path.join(pdir, "audio"))
    return {"ok": True, "name": name}
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): POST /api/projects legt leeres Projekt an"
```

---

### Task 4: `DELETE /api/projects/{project}` (Projekt löschen, blockiert bei laufendem Job)

**Files:**
- Modify: `webtool/app.py` (neue Route)
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `jobs.active_for` (Task 1)
- Produces: `DELETE /api/projects/{project}` → `{"ok": true}`; 400 ungültiger Name; 409 wenn ein Job läuft; 404 wenn kein Projekt.

- [ ] **Step 1: Failing test**

In `webtool/test_api.py` anhängen:

```python
def test_delete_project_ok(client, tmp_path):
    assert (tmp_path / "Demo").is_dir()
    r = client.delete("/api/projects/Demo")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert not (tmp_path / "Demo").exists()


def test_delete_project_blocked_when_active_409(client, tmp_path, monkeypatch):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "active_for", lambda name: {"id": "j", "kind": "correct"})
    assert client.delete("/api/projects/Demo").status_code == 409
    assert (tmp_path / "Demo").is_dir()  # nicht gelöscht


def test_delete_project_unknown_404(client):
    assert client.delete("/api/projects/Nope").status_code == 404


def test_delete_project_invalid_name_400(client):
    assert client.delete("/api/projects/a:b").status_code == 400
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py::test_delete_project_ok -q`
Expected: FAIL — 405 (Route fehlt)

- [ ] **Step 3: Implement**

In `webtool/app.py` hinzufügen (bei den `/api/projects`-Routen):

```python
@app.delete("/api/projects/{project}")
def delete_project(project: str):
    _validate(project)
    if jobs.active_for(project):
        raise HTTPException(status_code=409, detail="Job läuft — erst abbrechen")
    pdir = paths.project_dir(project)
    if not os.path.isdir(pdir):
        raise HTTPException(status_code=404, detail="kein Projekt")
    shutil.rmtree(pdir)
    return {"ok": True}
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): DELETE /api/projects/{project} (blockiert bei laufendem Job)"
```

---

### Task 5: SPA-Fallback (BrowserRouter-Deep-Links überleben Reload)

**Files:**
- Modify: `webtool/app.py` (Ende der Datei: `StaticFiles`-Mount durch Catch-all ersetzen; `StaticFiles`-Import entfernen)
- Test: `webtool/test_api.py`

**Interfaces:**
- Produces: `GET /<beliebig>` (nicht `/api/...`) → existierende Datei aus `webtool/static/` **oder** `index.html`; unbekannte `/api/...`-Pfade → 404.

- [ ] **Step 1: Failing test**

In `webtool/test_api.py` anhängen:

```python
def test_unknown_api_path_404(client):
    assert client.get("/api/nope").status_code == 404


def test_spa_serves_index_for_deep_link(client):
    from webtool import app as app_mod
    idx = app_mod._INDEX
    created = not os.path.exists(idx)
    if created:
        os.makedirs(app_mod._STATIC, exist_ok=True)
        with open(idx, "w", encoding="utf-8") as fh:
            fh.write("<!doctype html><div id=root></div>")
    try:
        r = client.get("/p/Demo/S1")
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]
    finally:
        if created:
            os.remove(idx)
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py::test_unknown_api_path_404 -q`
Expected: FAIL — StaticFiles liefert 404 als Text ohne unsere Semantik / bzw. AttributeError `_INDEX`

- [ ] **Step 3: Implement**

In `webtool/app.py` den Import entfernen:

```python
from fastapi.staticfiles import StaticFiles
```

Und die letzten drei Zeilen (`_STATIC = ...; os.makedirs(...); app.mount(...)`) ersetzen durch:

```python
_STATIC = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(_STATIC, exist_ok=True)  # Build-loser Checkout: Verzeichnis muss existieren
_INDEX = os.path.join(_STATIC, "index.html")


@app.get("/{full_path:path}")
def spa(full_path: str):
    # Unbekannte API-Pfade -> echtes 404 (nicht das SPA-HTML zurueckgeben).
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="kein Endpoint")
    # Existierende statische Datei ausliefern, aber nur INNERHALB von _STATIC
    # (Path-Traversal-Schutz: realpath darf _STATIC nicht verlassen).
    if full_path:
        target = os.path.realpath(os.path.join(_STATIC, full_path))
        if target.startswith(os.path.realpath(_STATIC) + os.sep) and os.path.isfile(target):
            return FileResponse(target)
    # Sonst index.html -> der Client-Router (BrowserRouter) uebernimmt die Route.
    if os.path.isfile(_INDEX):
        return FileResponse(_INDEX)
    raise HTTPException(status_code=404, detail="Frontend nicht gebaut")
```

*(Hinweis: `httpx`/TestClient normalisiert `..` im Pfad vor dem Senden, darum kein HTTP-Traversal-Test — der `realpath`-Guard ist Defense-in-Depth. Die FastAPI-Built-ins `/docs`/`/openapi.json` werden vor Nutzer-Routen registriert und bleiben erreichbar.)*

- [ ] **Step 4: Run, verify pass**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py -q`
Expected: PASS (alle bisherigen API-Tests weiterhin grün)

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): SPA-Fallback liefert index.html fuer Deep-Links"
```

---

### Task 6: Start-Marker pro Datei in `transcribe.py`

**Files:**
- Modify: `webtool/transcribe.py:97` (vor `t0 = time.time()`)

**Interfaces:**
- Produces: stdout-Zeile `[<projekt>] -> transkribiere <base> …` pro Datei vor der Whisper-Transkription (für die Per-Datei-Pille beim Transkribieren; vom `parseJobPhases`-Transkribier-Zweig konsumiert, Task 7).

*Kein Unit-Test: `transcribe_project` importiert `torch`/`whisper` lazy und braucht die GPU. Abgedeckt durch die Transkribier-Fälle in `jobPhases.test.ts` (Task 7) und den Live-E2E-Check am Ende. Trivialer 1-Zeilen-Marker.*

- [ ] **Step 1: Implement**

In `webtool/transcribe.py`, in der `for f in files:`-Schleife, zwischen dem `skip`-Block und `t0 = time.time()`:

```python
        if os.path.exists(out_json):
            print(f"[{name}] skip (vorhanden): {base}", flush=True)
            continue
        print(f"[{name}] -> transkribiere {base} …", flush=True)
        t0 = time.time()
```

- [ ] **Step 2: Verify (Smoke)**

Run: `.venv/Scripts/python.exe -c "import ast; ast.parse(open('webtool/transcribe.py', encoding='utf-8').read()); print('ok')"`
Expected: `ok` (Syntax intakt)

- [ ] **Step 3: Commit**

```bash
git add webtool/transcribe.py
git commit -m "feat(transcribe): Start-Marker je Datei fuer Live-Status"
```

---

## Phase B — Frontend: reiner Status-Kern + API-Client

### Task 7: `parseJobPhases` (Einzel-Cursor-Scan) + Phasen-Typen

**Files:**
- Modify: `webtool/frontend/src/lib/types.ts` (Phasen-Typen)
- Create: `webtool/frontend/src/lib/jobPhases.ts`
- Test: `webtool/frontend/src/lib/jobPhases.test.ts`

**Interfaces:**
- Produces (types.ts): `FilePhase = 'diarize'|'correct'|'verify'|'transcribe'`; `GlobalPhase = 'diarize'|'prep'|'glossary'`; `FileState = 'done'|'skipped'|'failed'`; `JobPhases = { global: GlobalPhase|null; active: {base:string; phase:FilePhase}|null; perBase: Record<string, FileState> }`.
- Produces (jobPhases.ts): `parseJobPhases(kind: string, lines: string[]): JobPhases`.

- [ ] **Step 1: Phasen-Typen ergänzen**

In `webtool/frontend/src/lib/types.ts` ans Ende anhängen:

```ts
export type FilePhase = 'diarize' | 'correct' | 'verify' | 'transcribe';
export type GlobalPhase = 'diarize' | 'prep' | 'glossary';
export type FileState = 'done' | 'skipped' | 'failed';
export type JobPhases = {
  global: GlobalPhase | null;
  active: { base: string; phase: FilePhase } | null;
  perBase: Record<string, FileState>;
};
```

- [ ] **Step 2: Failing test**

`webtool/frontend/src/lib/jobPhases.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseJobPhases } from './jobPhases'

describe('parseJobPhases — correct', () => {
  it('aktive Datei + Phase, sequentiell', () => {
    const p = parseJobPhases('correct', [
      "run: 3 Datei(en) in Projekt 'Demo'",
      '→ Diarisiere A …', '→ Diarisiere B …', 'diarize: 2 Datei(en) diarisiert',
      'prep: 3 Datei(en) getaggt in /x',
      '→ Glossar (gemeinsame Namen/Begriffe) …', '✓ Glossar: 4 Eigennamen, 2 Korrekturen',
      '→ Korrigiere A …', 'apply: A -> edit.json + md (12 Segmente)',
      '→ Korrigiere B …', '→ Verifiziere B (Treue gegen Roh) …',
    ])
    expect(p.active).toEqual({ base: 'B', phase: 'verify' })
    expect(p.perBase).toEqual({ A: 'done' })
    expect(p.global).toBeNull()
  })
  it('Vorstufe: global=glossary, kein active', () => {
    const p = parseJobPhases('correct', ['→ Glossar (…) …'])
    expect(p.active).toBeNull()
    expect(p.global).toBe('glossary')
  })
  it('diarize-SKIP ist kein Fehler', () => {
    const p = parseJobPhases('correct', ['diarize: SKIP A (kein Audio gefunden)', '→ Korrigiere A …'])
    expect(p.perBase.A).toBeUndefined()
    expect(p.active).toEqual({ base: 'A', phase: 'correct' })
  })
  it('SKIP human_edited + FEHLT -> terminal', () => {
    const p = parseJobPhases('correct', [
      '↷ SKIP A (human_edited=true; --force zum Neu-Korrigieren)',
      '✗ FEHLT/ungültig: B.correction.json — überspringe',
    ])
    expect(p.perBase).toEqual({ A: 'skipped', B: 'failed' })
    expect(p.active).toBeNull()
  })
  it('reuse -> apply -> done', () => {
    const p = parseJobPhases('correct', [
      '↷ nutze vorhandene A.correction.json', 'apply: A -> edit.json + md (3 Segmente)',
    ])
    expect(p.perBase).toEqual({ A: 'done' })
  })
})

describe('parseJobPhases — transcribe', () => {
  it('aktive + fertige + skip', () => {
    const p = parseJobPhases('transcribe', [
      '[Demo] Modell large-v3, 3 Datei(en)',
      '[Demo] -> transkribiere A …', '[Demo] fertig A: 12s, 40 Segmente, Audio 2:00, 10.0x',
      '[Demo] skip (vorhanden): B', '[Demo] -> transkribiere C …',
    ])
    expect(p.active).toEqual({ base: 'C', phase: 'transcribe' })
    expect(p.perBase).toEqual({ A: 'done', B: 'skipped' })
  })
  it('FEHLER -> failed', () => {
    expect(parseJobPhases('transcribe', ['[Demo] FEHLER A: broken pipe']).perBase).toEqual({ A: 'failed' })
  })
})
```

- [ ] **Step 3: Run, verify fail**

Run: `npm --prefix webtool/frontend run test -- src/lib/jobPhases.test.ts`
Expected: FAIL — Modul `./jobPhases` nicht gefunden

- [ ] **Step 4: Implement**

`webtool/frontend/src/lib/jobPhases.ts`:

```ts
import type { FilePhase, FileState, GlobalPhase, JobPhases } from './types'

// Der correct- wie der transcribe-Treiber verarbeiten Dateien STRENG SEQUENTIELL
// -> zu jedem Zeitpunkt hoechstens EIN aktiver {base, phase}-Cursor. Wir scannen die
// stdout-Zeilen der Reihe nach und pflegen cursor/global/perBase.
export function parseJobPhases(kind: string, lines: string[]): JobPhases {
  const perBase: Record<string, FileState> = {}
  let active: { base: string; phase: FilePhase } | null = null
  let global: GlobalPhase | null = null

  const terminal = (base: string, state: FileState) => {
    perBase[base] = state
    if (active?.base === base) active = null
  }

  for (const rawLine of lines) {
    const l = rawLine.trim()
    let m: RegExpMatchArray | null

    if (kind === 'transcribe') {
      if ((m = l.match(/^\[.+?\] -> transkribiere (.+) …$/))) { active = { base: m[1], phase: 'transcribe' }; global = null }
      else if ((m = l.match(/^\[.+?\] fertig (.+?): /))) terminal(m[1], 'done')
      else if ((m = l.match(/^\[.+?\] skip \(vorhanden\): (.+)$/))) terminal(m[1], 'skipped')
      else if ((m = l.match(/^\[.+?\] FEHLER (.+?): /))) terminal(m[1], 'failed')
      continue
    }

    // kind === 'correct'
    if ((m = l.match(/^→ Diarisiere (.+) …$/))) { active = { base: m[1], phase: 'diarize' }; global = 'diarize' }
    else if ((m = l.match(/^→ Korrigiere (.+) …$/))) { active = { base: m[1], phase: 'correct' }; global = null }
    else if ((m = l.match(/^→ Verifiziere (.+) \(Treue gegen Roh\) …$/))) { active = { base: m[1], phase: 'verify' }; global = null }
    else if ((m = l.match(/^apply: (.+) -> edit\.json/))) terminal(m[1], 'done')
    else if ((m = l.match(/^apply: SKIP (.+?) \(/))) terminal(m[1], 'skipped')
    else if ((m = l.match(/^↷ SKIP (.+?) \(/))) terminal(m[1], 'skipped')
    else if ((m = l.match(/^apply: FEHLT (.+?)\.correction\.json/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^✗ FEHLT\/ungültig: (.+?)\.correction\.json/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^✗ Fehler bei (.+?): /))) terminal(m[1], 'failed')
    else if (/^diarize: \d+ Datei/.test(l)) { if (active?.phase === 'diarize') active = null; if (global === 'diarize') global = null }
    else if (/^prep: \d+ Datei/.test(l)) { active = null; global = 'prep' }
    else if (/^(→ Glossar|✓ Glossar|↷ nutze vorhandenes _glossar)/.test(l)) { active = null; global = 'glossary' }
    // reuse / diarize-SKIP / prep-SKIP / "Diarisierung deaktiviert" -> bewusst ignoriert
  }

  return { global: active ? null : global, active, perBase }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `npm --prefix webtool/frontend run test -- src/lib/jobPhases.test.ts`
Expected: PASS (7 Tests)

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend/src/lib/types.ts webtool/frontend/src/lib/jobPhases.ts webtool/frontend/src/lib/jobPhases.test.ts
git commit -m "feat(web): parseJobPhases + Phasen-Typen (reiner Status-Parser)"
```

---

### Task 8: API-Client `createProject`/`deleteProject` + `active_job` an `Project`

**Files:**
- Modify: `webtool/frontend/src/lib/types.ts` (`ActiveJob`, `Project.active_job`)
- Modify: `webtool/frontend/src/lib/api.ts`
- Test: `webtool/frontend/src/lib/api.test.ts`

**Interfaces:**
- Produces (types): `ActiveJob = { id: string; kind: string }`; `Project` erhält `active_job?: ActiveJob | null`.
- Produces (api): `createProject(name: string): Promise<{ ok: boolean; name: string }>`; `deleteProject(project: string): Promise<void>`.

- [ ] **Step 1: Failing test**

In `webtool/frontend/src/lib/api.test.ts` ergänzen (Importzeile erweitern + neue Suite):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { audioUrl, createProject, deleteProject } from './api'

afterEach(() => { vi.unstubAllGlobals() })

describe('createProject / deleteProject', () => {
  it('createProject POSTet JSON und liefert die Antwort', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, name: 'Neu' }) })
    vi.stubGlobal('fetch', fetchMock)
    expect(await createProject('Neu')).toEqual({ ok: true, name: 'Neu' })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ method: 'POST' }))
  })
  it('deleteProject schickt DELETE mit encodiertem Namen', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    await deleteProject('Food Festival')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/Food%20Festival', expect.objectContaining({ method: 'DELETE' }))
  })
})
```

*(Der bestehende `audioUrl`-Test bleibt; nur die Importzeile wird erweitert.)*

- [ ] **Step 2: Run, verify fail**

Run: `npm --prefix webtool/frontend run test -- src/lib/api.test.ts`
Expected: FAIL — `createProject` nicht exportiert

- [ ] **Step 3: Implement**

In `webtool/frontend/src/lib/types.ts` ergänzen und `Project` anpassen:

```ts
export type ActiveJob = { id: string; kind: string };
```

`Project` ändern zu:

```ts
export type Project = { name: string; files: ProjectFile[]; active_job?: ActiveJob | null };
```

In `webtool/frontend/src/lib/api.ts` ans Ende:

```ts
export async function createProject(name: string): Promise<{ ok: boolean; name: string }> {
  return jn(await fetch('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }))
}
export async function deleteProject(project: string): Promise<void> {
  await jn(await fetch(`/api/projects/${enc(project)}`, { method: 'DELETE' }))
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm --prefix webtool/frontend run test -- src/lib/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/lib/types.ts webtool/frontend/src/lib/api.ts webtool/frontend/src/lib/api.test.ts
git commit -m "feat(web): createProject/deleteProject + active_job-Typ"
```

---

## Phase C — Router-Gerüst + Job-Provider + Status-Pille

### Task 9: react-router-Gerüst + Editor-Umzug in `:base`-Route

**Files:**
- Modify: `webtool/frontend/package.json` (Dep `react-router-dom`)
- Modify: `webtool/frontend/src/main.tsx` (BrowserRouter)
- Rewrite: `webtool/frontend/src/App.tsx` (Routes)
- Create: `webtool/frontend/src/pages/EditorView.tsx` (bisheriger App-Inhalt, param-basiert)
- Create: `webtool/frontend/src/pages/HomeGallery.tsx` (Stub)
- Create: `webtool/frontend/src/pages/ProjectWorkspace.tsx` (Stub)
- Test: `webtool/frontend/src/pages/ProjectWorkspace.test.tsx`

**Interfaces:**
- Produces: Routen `/` → `HomeGallery`, `/p/:project` → `ProjectWorkspace`, `/p/:project/:base` → `EditorView`. `EditorView` liest `useParams()` statt `sel`-State und navigiert per `useNavigate`.

- [ ] **Step 1: Dependency installieren**

Run: `npm --prefix webtool/frontend install react-router-dom`
Expected: `react-router-dom` erscheint in `package.json` → `dependencies`.

- [ ] **Step 2: `main.tsx` mit BrowserRouter umschließen**

`webtool/frontend/src/main.tsx` ersetzen durch:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './components/ThemeProvider.tsx'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
```

- [ ] **Step 3: `EditorView` anlegen (bisheriger App-Inhalt, param-basiert)**

`webtool/frontend/src/pages/EditorView.tsx` (aus dem alten `App.tsx` übernommen; Änderungen: `useParams`/`useNavigate`, `sel` aus Params, `openFile` navigiert):

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useProjects } from '@/hooks/useProjects'
import { useDoc } from '@/hooks/useDoc'
import { useThresholds } from '@/hooks/useThresholds'
import { useJob } from '@/hooks/useJob'
import { uploadAudio, audioUrl, startTranscribe, startCorrect, startCorrectFile } from '@/lib/api'
import { Sidebar } from '@/components/Sidebar'
import { Toolbar } from '@/components/Toolbar'
import { Transcript } from '@/components/Transcript'
import { ThresholdPopover } from '@/components/ThresholdPopover'
import { PlayerDock } from '@/components/PlayerDock'
import type { WaveHandle } from '@/components/Waveform'

export function EditorView() {
  const { project, base } = useParams<{ project: string; base: string }>()
  const navigate = useNavigate()
  const { projects, loading: projectsLoading, refresh } = useProjects()
  const sel = project && base ? { project, base } : null
  const { doc, dirty, loading: docLoading, updateSegment, save, exportDownload, reload } = useDoc(sel?.project ?? null, sel?.base ?? null)
  const { thr, setThr } = useThresholds()
  const { start } = useJob()
  const title = useMemo(() => (sel ? `${sel.project} / ${sel.base}` : '— keine Datei —'), [sel])
  const waveRef = useRef<WaveHandle>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const onTime = useCallback((t: number) => {
    const id = doc?.segments.find(s => t >= s.start && t < s.end)?.id ?? null
    setActiveId(prev => prev === id ? prev : id)
  }, [doc])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const openFile = (s: { project: string; base: string }) => {
    const same = sel?.project === s.project && sel?.base === s.base
    if (!same && dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return
    navigate(`/p/${encodeURIComponent(s.project)}/${encodeURIComponent(s.base)}`)
  }

  const onUpload = async (p: string, file: File) => { await uploadAudio(p, file); refresh() }
  const onTranscribe = (p: string) => start(() => startTranscribe(p), `Transkribieren ${p}`, refresh)
  const onCorrect = (p: string) => start(() => startCorrect(p), `Korrigieren ${p}`, refresh)
  const onCorrectFile = (p: string, b: string, force: boolean) =>
    start(() => startCorrectFile(p, b, force), `Korrigieren ${b}`,
      () => { refresh(); if (sel?.project === p && sel?.base === b) reload() })

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]">
      <aside className="row-span-3 border-r overflow-auto">
        <Sidebar projects={projects} loading={projectsLoading} active={sel} onOpen={openFile} onUpload={onUpload}
          onTranscribe={onTranscribe} onCorrect={onCorrect} onCorrectFile={onCorrectFile} />
      </aside>
      <div className="col-start-2"><Toolbar title={title} dirty={dirty} canSave={!!doc}
        onSave={save} onExport={exportDownload} settings={<ThresholdPopover thr={thr} setThr={setThr} />} /></div>
      <main className="col-start-2 overflow-auto">
        <Transcript doc={doc} loading={docLoading} thr={thr} activeId={activeId}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          updateSegment={updateSegment} />
      </main>
      <div className="col-start-2">
        <PlayerDock url={sel ? audioUrl(sel.project, sel.base) : undefined} onTime={onTime} waveRef={waveRef} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Stub-Seiten anlegen**

`webtool/frontend/src/pages/HomeGallery.tsx`:

```tsx
import { Link } from 'react-router-dom'
import { useProjects } from '@/hooks/useProjects'

export function HomeGallery() {
  const { projects } = useProjects()
  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Transkribor</h1>
      <ul className="space-y-1">
        {projects.map(p => (
          <li key={p.name}><Link className="underline" to={`/p/${encodeURIComponent(p.name)}`}>{p.name}</Link></li>
        ))}
      </ul>
    </div>
  )
}
```

`webtool/frontend/src/pages/ProjectWorkspace.tsx`:

```tsx
import { Link, useParams } from 'react-router-dom'
import { useProjects } from '@/hooks/useProjects'

export function ProjectWorkspace() {
  const { project } = useParams<{ project: string }>()
  const { projects } = useProjects()
  const p = projects.find(x => x.name === project)
  return (
    <div className="p-6">
      <Link className="text-sm underline" to="/">‹ Home</Link>
      <h1 className="my-3 text-xl font-semibold">{project}</h1>
      <ul className="space-y-1">
        {p?.files.map(f => (
          <li key={f.base}>
            <Link className="underline" to={`/p/${encodeURIComponent(project!)}/${encodeURIComponent(f.base)}`}>{f.base}</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 5: `App.tsx` zu Routes umschreiben**

`webtool/frontend/src/App.tsx` ersetzen durch:

```tsx
import { Routes, Route } from 'react-router-dom'
import { HomeGallery } from '@/pages/HomeGallery'
import { ProjectWorkspace } from '@/pages/ProjectWorkspace'
import { EditorView } from '@/pages/EditorView'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeGallery />} />
      <Route path="/p/:project" element={<ProjectWorkspace />} />
      <Route path="/p/:project/:base" element={<EditorView />} />
    </Routes>
  )
}
```

- [ ] **Step 6: Smoke-Test für die Stub-Seite**

`webtool/frontend/src/pages/ProjectWorkspace.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProjectWorkspace } from './ProjectWorkspace'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('ProjectWorkspace (Stub)', () => {
  it('listet Dateien des Projekts mit Links', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }], active_job: null },
    ])
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: 'S1' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: Run tests + Build**

Run: `npm --prefix webtool/frontend run test -- src/pages/ProjectWorkspace.test.tsx`
Expected: PASS
Run: `npm --prefix webtool/frontend run build`
Expected: Build erfolgreich (tsc + vite)

- [ ] **Step 8: Commit**

```bash
git add webtool/frontend/package.json webtool/frontend/package-lock.json webtool/frontend/src/main.tsx webtool/frontend/src/App.tsx webtool/frontend/src/pages/
git commit -m "feat(web): react-router-Geruest, Editor in :base-Route, Stub-Seiten"
```

---

### Task 10: `JobProvider` / `useActiveJob` (Polling + Discovery-Hook)

**Files:**
- Create: `webtool/frontend/src/hooks/useActiveJob.tsx`
- Modify: `webtool/frontend/src/main.tsx` (Provider einhängen)
- Test: `webtool/frontend/src/hooks/useActiveJob.test.tsx`

**Interfaces:**
- Consumes: `getJob` (api), `parseJobPhases` (Task 7)
- Produces: `JobProvider({ children, intervalMs? })`; `useActiveJob(): { job: Job|null; phases: JobPhases; adopt(id,project,kind): void; onSettled(fn): () => void }` mit `Job = { id, project, kind, status, lines }`.

- [ ] **Step 1: Failing test**

`webtool/frontend/src/hooks/useActiveJob.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { JobProvider, useActiveJob } from './useActiveJob'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

function Probe() {
  const { job, phases, adopt } = useActiveJob()
  return (
    <div>
      <button onClick={() => adopt('j1', 'Demo', 'correct')}>go</button>
      <span data-testid="active">{phases.active ? `${phases.active.base}:${phases.active.phase}` : '-'}</span>
      <span data-testid="status">{job?.status ?? 'none'}</span>
    </div>
  )
}

describe('useActiveJob', () => {
  it('adoptiert, pollt und parst bis Terminal', async () => {
    vi.mocked(api.getJob)
      .mockResolvedValueOnce({ status: 'running', lines: ['→ Korrigiere A …'] })
      .mockResolvedValueOnce({ status: 'done', lines: ['apply: A -> edit.json + md (2 Segmente)'] })
    render(<JobProvider intervalMs={5}><Probe /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('A:correct'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'))
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npm --prefix webtool/frontend run test -- src/hooks/useActiveJob.test.tsx`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: Implement**

`webtool/frontend/src/hooks/useActiveJob.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getJob } from '@/lib/api'
import { parseJobPhases } from '@/lib/jobPhases'
import type { JobPhases } from '@/lib/types'

type Job = { id: string; project: string; kind: string; status: string; lines: string[] }
type Ctx = {
  job: Job | null
  phases: JobPhases
  adopt: (id: string, project: string, kind: string) => void
  onSettled: (fn: () => void) => () => void
}
const EMPTY: JobPhases = { global: null, active: null, perBase: {} }
const JobContext = createContext<Ctx | null>(null)

export function JobProvider({ children, intervalMs = 1500 }: { children: ReactNode; intervalMs?: number }) {
  const [job, setJob] = useState<Job | null>(null)
  const [phases, setPhases] = useState<JobPhases>(EMPTY)
  const jobRef = useRef<Job | null>(null)
  jobRef.current = job
  const listeners = useRef(new Set<() => void>())

  const adopt = useCallback((id: string, project: string, kind: string) => {
    if (jobRef.current?.id === id) return
    setPhases(EMPTY)
    setJob({ id, project, kind, status: 'running', lines: [] })
  }, [])

  const onSettled = useCallback((fn: () => void) => {
    listeners.current.add(fn)
    return () => { listeners.current.delete(fn) }
  }, [])

  const jobId = job?.id
  const jobKind = job?.kind
  const running = job?.status === 'running'
  useEffect(() => {
    if (!jobId || !running) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      let j
      try { j = await getJob(jobId) } catch { if (alive) setJob(null); return }
      if (!alive) return
      setPhases(parseJobPhases(jobKind!, j.lines))
      if (j.status === 'running') { timer = setTimeout(tick, intervalMs) }
      else {
        setJob(prev => prev ? { ...prev, status: j.status, lines: j.lines } : prev)
        listeners.current.forEach(fn => fn())
      }
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [jobId, jobKind, running, intervalMs])

  return <JobContext.Provider value={{ job, phases, adopt, onSettled }}>{children}</JobContext.Provider>
}

export function useActiveJob(): Ctx {
  const c = useContext(JobContext)
  if (!c) throw new Error('useActiveJob ausserhalb JobProvider')
  return c
}
```

- [ ] **Step 4: Provider in `main.tsx` einhängen**

In `webtool/frontend/src/main.tsx` den Import ergänzen und `<BrowserRouter>` in `<JobProvider>` wickeln:

```tsx
import { JobProvider } from '@/hooks/useActiveJob'
```

```tsx
        <JobProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </JobProvider>
```

*(Der `<Toaster>` bleibt wie in Task 9 innerhalb `<TooltipProvider>`, hier direkt nach `</JobProvider>`.)*

- [ ] **Step 5: Run, verify pass**

Run: `npm --prefix webtool/frontend run test -- src/hooks/useActiveJob.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend/src/hooks/useActiveJob.tsx webtool/frontend/src/hooks/useActiveJob.test.tsx webtool/frontend/src/main.tsx
git commit -m "feat(web): JobProvider/useActiveJob (Polling + Phasen-Parsing)"
```

---

### Task 11: `FileStatusPill` (präsentational)

**Files:**
- Create: `webtool/frontend/src/components/FileStatusPill.tsx`
- Test: `webtool/frontend/src/components/FileStatusPill.test.tsx`

**Interfaces:**
- Consumes: `FilePhase`, `FileState`, `ProjectFile` (types)
- Produces: `<FileStatusPill file={ProjectFile} active?={FilePhase} state?={FileState} jobRunning?={boolean} />`. Priorität: `state` (Terminal) → `active` (Spinner+Label) → `jobRunning` (○ Wartet) → statisches Badge (✎/✓/●).

- [ ] **Step 1: Failing test**

`webtool/frontend/src/components/FileStatusPill.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileStatusPill } from './FileStatusPill'
import type { ProjectFile } from '@/lib/types'

const f = (over: Partial<ProjectFile> = {}): ProjectFile => ({
  base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...over,
})

describe('FileStatusPill', () => {
  it('aktive Phase mit Label', () => {
    render(<FileStatusPill file={f()} active="verify" jobRunning />)
    expect(screen.getByText(/Verifizieren/)).toBeInTheDocument()
  })
  it('Terminal-Status', () => {
    render(<FileStatusPill file={f()} state="done" />)
    expect(screen.getByText(/Fertig/)).toBeInTheDocument()
  })
  it('Wartet, wenn Job laeuft aber Datei noch nicht dran', () => {
    render(<FileStatusPill file={f()} jobRunning />)
    expect(screen.getByText(/Wartet/)).toBeInTheDocument()
  })
  it('statisches Badge ohne Job', () => {
    render(<FileStatusPill file={f({ has_edit: true })} />)
    expect(screen.getByText('✎')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npm --prefix webtool/frontend run test -- src/components/FileStatusPill.test.tsx`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: Implement**

`webtool/frontend/src/components/FileStatusPill.tsx`:

```tsx
import { Loader2 } from 'lucide-react'
import type { FilePhase, FileState, ProjectFile } from '@/lib/types'

const PHASE_LABEL: Record<FilePhase, string> = {
  diarize: 'Diarisieren', correct: 'Korrigieren', verify: 'Verifizieren', transcribe: 'Transkribieren',
}
const STATE_LABEL: Record<FileState, string> = { done: 'Fertig', skipped: 'Übersprungen', failed: 'Fehler' }
const STATE_ICON: Record<FileState, string> = { done: '✓', skipped: '↷', failed: '✗' }

export function FileStatusPill({ file, active, state, jobRunning }: {
  file: ProjectFile; active?: FilePhase; state?: FileState; jobRunning?: boolean
}) {
  if (state) return <span className="text-xs text-muted-foreground">{STATE_ICON[state]} {STATE_LABEL[state]}</span>
  if (active) return (
    <span className="inline-flex items-center gap-1 text-xs text-primary">
      <Loader2 className="size-3 animate-spin" />{PHASE_LABEL[active]}…
    </span>
  )
  if (jobRunning) return <span className="text-xs text-muted-foreground">○ Wartet…</span>
  const badge = file.has_edit ? '✎' : file.has_md ? '✓' : file.has_audio ? '●' : ''
  return <span className="text-xs text-muted-foreground">{badge}</span>
}
```

*(Falls `Loader2` in der genutzten lucide-react-Version fehlt: `Loader` verwenden — gleiche Nutzung.)*

- [ ] **Step 4: Run, verify pass**

Run: `npm --prefix webtool/frontend run test -- src/components/FileStatusPill.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/FileStatusPill.tsx webtool/frontend/src/components/FileStatusPill.test.tsx
git commit -m "feat(web): FileStatusPill (Live-Phase/Terminal/statisch)"
```

---

## Phase D — Projekt-Arbeitsfläche + Upload

### Task 12: `UploadDropzone` (Drag & Drop, Multi-File)

**Files:**
- Create: `webtool/frontend/src/components/UploadDropzone.tsx`
- Test: `webtool/frontend/src/components/UploadDropzone.test.tsx`

**Interfaces:**
- Consumes: `uploadAudio` (api)
- Produces: `<UploadDropzone project={string} onDone?={() => void} />` — nimmt Drop/Datei-Auswahl, filtert Audio-Endungen, lädt sequentiell hoch, zeigt Pro-Datei-Status; ruft `onDone` nach Abschluss.

- [ ] **Step 1: Failing test**

`webtool/frontend/src/components/UploadDropzone.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UploadDropzone } from './UploadDropzone'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('UploadDropzone', () => {
  it('laedt nur Audio hoch und meldet Duplikate', async () => {
    vi.mocked(api.uploadAudio)
      .mockResolvedValueOnce({ base: 'a', file: 'a.mp3' })
      .mockRejectedValueOnce(new Error('Datei existiert bereits'))
    const onDone = vi.fn()
    render(<UploadDropzone project="Demo" onDone={onDone} />)
    const input = screen.getByTestId('upload-input') as HTMLInputElement
    const files = [new File(['x'], 'a.mp3'), new File(['y'], 'b.txt'), new File(['z'], 'c.wav')]
    await act(async () => { fireEvent.change(input, { target: { files } }) })
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledTimes(2)) // b.txt gefiltert
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(screen.getByText(/existiert bereits/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npm --prefix webtool/frontend run test -- src/components/UploadDropzone.test.tsx`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: Implement**

`webtool/frontend/src/components/UploadDropzone.tsx`:

```tsx
import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { uploadAudio } from '@/lib/api'
import { cn } from '@/lib/utils'

const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|mp4)$/i
type Status = 'uploading' | 'done' | 'exists' | 'error'
type Item = { name: string; status: Status; msg?: string }

export function UploadDropzone({ project, onDone }: { project: string; onDone?: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const patch = (name: string, p: Partial<Item>) =>
    setItems(prev => prev.map(it => it.name === name ? { ...it, ...p } : it))

  const upload = async (files: File[]) => {
    const audio = files.filter(f => AUDIO_RE.test(f.name))
    if (!audio.length) return
    setItems(audio.map(f => ({ name: f.name, status: 'uploading' as Status })))
    // ponytail: sequentiell statt Pool — lokale Uploads sind quasi instant; Pool nachruesten bei Bedarf
    for (const f of audio) {
      try { await uploadAudio(project, f); patch(f.name, { status: 'done' }) }
      catch (e) {
        const msg = (e as Error).message
        patch(f.name, { status: /existiert bereits/.test(msg) ? 'exists' : 'error', msg })
      }
    }
    onDone?.()
  }

  return (
    <div>
      <div
        role="button" tabIndex={0} aria-label="Audio hochladen"
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); upload(Array.from(e.dataTransfer.files)) }}
        className={cn('flex items-center justify-center gap-2 rounded border border-dashed p-6 text-sm text-muted-foreground cursor-pointer',
          over && 'border-primary bg-accent')}
      >
        <Upload className="size-4" /> Audio hierher ziehen oder klicken
      </div>
      <input ref={inputRef} data-testid="upload-input" type="file" hidden multiple
        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      {items.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {items.map(it => (
            <li key={it.name} className="flex justify-between gap-2">
              <span className="truncate">{it.name}</span>
              <span className="text-muted-foreground">
                {it.status === 'uploading' && 'lädt…'}
                {it.status === 'done' && '✓'}
                {it.status === 'exists' && 'existiert bereits'}
                {it.status === 'error' && `Fehler: ${it.msg ?? ''}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm --prefix webtool/frontend run test -- src/components/UploadDropzone.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/UploadDropzone.tsx webtool/frontend/src/components/UploadDropzone.test.tsx
git commit -m "feat(web): UploadDropzone (Drag&Drop, Multi-File, sequentiell)"
```

---

### Task 13: `ProjectWorkspace` (voll) — Dateiliste + Live-Status + Aktionen + Upload

**Files:**
- Rewrite: `webtool/frontend/src/pages/ProjectWorkspace.tsx`
- Modify: `webtool/frontend/src/pages/ProjectWorkspace.test.tsx` (erweitern)

**Interfaces:**
- Consumes: `useProjects`, `useActiveJob`, `FileStatusPill`, `UploadDropzone`, api (`startTranscribe`, `startCorrect`, `startCorrectFile`, `cancelJob`)
- Produces: vollständige `/p/:project`-Ansicht mit Kopf-Aktionen, globalem Banner, Drop-Zone, Dateiliste mit Live-Pillen; adoptiert `active_job` bei Discovery und beim Job-Start.

- [ ] **Step 1: Failing test (Live-Pille erscheint)**

In `webtool/frontend/src/pages/ProjectWorkspace.test.tsx` einen zweiten Test in der Suite ergänzen (Importzeile oben um `waitFor` erweitern):

```tsx
  it('zeigt Live-Phase, wenn ein Job fuer das Projekt laeuft', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: false, has_md: false }],
        active_job: { id: 'j1', kind: 'correct' } },
    ])
    vi.mocked(api.getJob).mockResolvedValue({ status: 'running', lines: ['→ Verifiziere S1 (Treue gegen Roh) …'] })
    const { JobProvider } = await import('@/hooks/useActiveJob')
    render(
      <MemoryRouter initialEntries={['/p/Demo']}>
        <JobProvider intervalMs={5}>
          <Routes><Route path="/p/:project" element={<ProjectWorkspace />} /></Routes>
        </JobProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/Verifizieren/)).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run, verify fail**

Run: `npm --prefix webtool/frontend run test -- src/pages/ProjectWorkspace.test.tsx`
Expected: FAIL — kein „Verifizieren"-Text (Stub kennt keine Pillen)

- [ ] **Step 3: Implement (Stub ersetzen)**

`webtool/frontend/src/pages/ProjectWorkspace.tsx` komplett ersetzen:

```tsx
import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Play, Pencil, X } from 'lucide-react'
import { useProjects } from '@/hooks/useProjects'
import { useActiveJob } from '@/hooks/useActiveJob'
import { FileStatusPill } from '@/components/FileStatusPill'
import { UploadDropzone } from '@/components/UploadDropzone'
import { Button } from '@/components/ui/button'
import { startTranscribe, startCorrect, startCorrectFile, cancelJob } from '@/lib/api'
import type { StartJob } from '@/lib/types'

const GLOBAL_LABEL = { diarize: 'Diarisieren…', prep: 'Vorbereiten…', glossary: 'Glossar wird erstellt…' } as const

export function ProjectWorkspace() {
  const { project } = useParams<{ project: string }>()
  const navigate = useNavigate()
  const { projects, refresh } = useProjects()
  const { job, phases, adopt, onSettled } = useActiveJob()
  const p = projects.find(x => x.name === project)
  const running = !!job && job.status === 'running' && job.project === project

  useEffect(() => onSettled(() => refresh()), [onSettled, refresh])
  // Discovery: laufenden Job nach Reload/aus der Liste adoptieren
  useEffect(() => {
    if (p?.active_job && job?.id !== p.active_job.id) adopt(p.active_job.id, project!, p.active_job.kind)
  }, [p?.active_job?.id, job?.id, project, adopt, p?.active_job])

  const startJob = async (fn: () => Promise<StartJob>, kind: string, label: string) => {
    let res: StartJob
    try { res = await fn() } catch (e) { toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`); return }
    if (!res.started) { toast.warning('Es läuft bereits ein Job für dieses Projekt.'); return }
    adopt(res.job_id, project!, kind)
    toast.success(`${label} gestartet`)
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center gap-3">
        <Link className="text-sm text-muted-foreground hover:underline" to="/">‹ Home</Link>
        <h1 className="text-xl font-semibold">{project}</h1>
      </div>
      <div className="mb-4 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => startJob(() => startTranscribe(project!), 'transcribe', 'Transkribieren')}>
          <Play className="size-4" /> Transkribieren
        </Button>
        <Button variant="outline" size="sm" onClick={() => startJob(() => startCorrect(project!), 'correct', 'Korrigieren')}>
          <Pencil className="size-4" /> Korrigieren
        </Button>
      </div>

      {running && !phases.active && phases.global && (
        <div className="mb-3 flex items-center justify-between rounded bg-accent px-3 py-2 text-sm">
          <span>{GLOBAL_LABEL[phases.global]}</span>
          <Button variant="ghost" size="sm" onClick={() => job && cancelJob(job.id)}><X className="size-4" /> Abbrechen</Button>
        </div>
      )}

      <div className="mb-4">
        <UploadDropzone project={project!} onDone={refresh} />
      </div>

      {p && p.files.length === 0 && (
        <p className="text-sm text-muted-foreground">Noch keine Dateien — lade Audio hoch und transkribiere.</p>
      )}
      <ul className="divide-y rounded border">
        {p?.files.map(f => {
          const active = running && phases.active?.base === f.base ? phases.active.phase : undefined
          const state = running ? phases.perBase[f.base] : undefined
          return (
            <li key={f.base} className="flex items-center gap-3 px-3 py-2">
              <button className="flex-1 truncate text-left text-sm hover:underline"
                onClick={() => navigate(`/p/${encodeURIComponent(project!)}/${encodeURIComponent(f.base)}`)}>
                {f.base}
              </button>
              <FileStatusPill file={f} active={active} state={state} jobRunning={running} />
              <Button size="icon" variant="ghost" className="size-6" title="Nur diese Datei korrigieren"
                onClick={() => startJob(() => startCorrectFile(project!, f.base, false), 'correct', `Korrigieren ${f.base}`)}>
                <Pencil className="size-3.5" />
              </Button>
            </li>
          )
        })}
      </ul>
      {!p && <p className="text-sm text-muted-foreground">Projekt nicht gefunden.</p>}
    </div>
  )
}
```

*(Der Header nutzt kein separates Upload-Button-Icon — die Drop-Zone übernimmt den Upload.)*

- [ ] **Step 4: Run, verify pass**

Run: `npm --prefix webtool/frontend run test -- src/pages/ProjectWorkspace.test.tsx`
Expected: PASS (beide Tests)

- [ ] **Step 5: Lint + Build**

Run: `npm --prefix webtool/frontend run lint`
Expected: keine Fehler (ggf. ungenutzten `Upload`-Import entfernen)
Run: `npm --prefix webtool/frontend run build`
Expected: erfolgreich

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend/src/pages/ProjectWorkspace.tsx webtool/frontend/src/pages/ProjectWorkspace.test.tsx
git commit -m "feat(web): ProjectWorkspace mit Live-Status, Aktionen, Upload"
```

---

## Phase E — Home-Galerie + Dialoge + Editor-Rail

### Task 14: `HomeGallery` (voll) + `NewProjectDialog` + `DeleteProjectDialog`

**Files:**
- Rewrite: `webtool/frontend/src/pages/HomeGallery.tsx`
- Create: `webtool/frontend/src/components/NewProjectDialog.tsx`
- Create: `webtool/frontend/src/components/DeleteProjectDialog.tsx`
- Test: `webtool/frontend/src/pages/HomeGallery.test.tsx`

**Interfaces:**
- Consumes: `useProjects`, `createProject`, `deleteProject` (api), `Dialog`/`AlertDialog` (ui)
- Produces: Galerie mit Projekt-Karten (Name, Dateizahl, Fertig-Zahl = `has_edit`, Live-„⟳ läuft"), „+ Projekt"-Dialog, Löschen-Dialog mit Namens-Bestätigung. Pollt die Projektliste alle 3 s, solange ein `active_job` existiert.

- [ ] **Step 1: Failing test**

`webtool/frontend/src/pages/HomeGallery.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HomeGallery } from './HomeGallery'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

const renderHome = () =>
  render(<MemoryRouter><HomeGallery /></MemoryRouter>)

describe('HomeGallery', () => {
  it('zeigt Karten mit Dateizahl', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { name: 'Demo', files: [{ base: 'S1', has_audio: true, has_raw: true, has_edit: true, has_md: true }], active_job: null },
    ])
    renderHome()
    expect(await screen.findByText('Demo')).toBeInTheDocument()
    expect(screen.getByText(/1 Datei/)).toBeInTheDocument()
  })

  it('legt ein Projekt an und navigiert (createProject aufgerufen)', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.createProject).mockResolvedValue({ ok: true, name: 'Neu' })
    renderHome()
    fireEvent.click(await screen.findByText('+ Projekt'))
    fireEvent.change(screen.getByLabelText('Projektname'), { target: { value: 'Neu' } })
    fireEvent.click(screen.getByText('Anlegen'))
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('Neu'))
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npm --prefix webtool/frontend run test -- src/pages/HomeGallery.test.tsx`
Expected: FAIL — `+ Projekt` fehlt (Stub)

- [ ] **Step 3: Implement `NewProjectDialog`**

`webtool/frontend/src/components/NewProjectDialog.tsx`:

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { createProject } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'

export function NewProjectDialog({ onCreated }: { onCreated: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const submit = async () => {
    const n = name.trim()
    if (!n) return
    try { await createProject(n) } catch (e) { toast.error(`Anlegen fehlgeschlagen: ${(e as Error).message}`); return }
    setOpen(false); setName(''); onCreated(n)
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">+ Projekt</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Neues Projekt</DialogTitle></DialogHeader>
        <label className="text-sm" htmlFor="np-name">Projektname</label>
        <Input id="np-name" aria-label="Projektname" value={name} autoFocus
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Abbrechen</Button>
          <Button onClick={submit}>Anlegen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Implement `DeleteProjectDialog`**

`webtool/frontend/src/components/DeleteProjectDialog.tsx`:

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { deleteProject } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

export function DeleteProjectDialog({ project, onDeleted }: { project: string; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState('')
  const del = async () => {
    try { await deleteProject(project) } catch (e) { toast.error(`Löschen fehlgeschlagen: ${(e as Error).message}`); return }
    onDeleted()
  }
  return (
    <AlertDialog onOpenChange={() => setConfirm('')}>
      <AlertDialogTrigger asChild>
        <Button size="icon" variant="ghost" className="size-6" title="Projekt löschen" aria-label={`Projekt ${project} löschen`}>
          <Trash2 className="size-3.5" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Projekt „{project}" löschen?</AlertDialogTitle>
          <AlertDialogDescription>
            Löscht alle Audio- und Transkript-Dateien unwiderruflich. Zum Bestätigen den Projektnamen eintippen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input aria-label="Projektname bestätigen" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={project} />
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction disabled={confirm !== project} onClick={del}>Löschen</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

- [ ] **Step 5: Implement `HomeGallery`**

`webtool/frontend/src/pages/HomeGallery.tsx` ersetzen:

```tsx
import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useProjects } from '@/hooks/useProjects'
import { NewProjectDialog } from '@/components/NewProjectDialog'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'

export function HomeGallery() {
  const { projects, refresh } = useProjects()
  const navigate = useNavigate()

  // Solange irgendein Projekt einen laufenden Job hat, die Liste periodisch nachladen.
  const anyActive = projects.some(p => p.active_job)
  useEffect(() => {
    if (!anyActive) return
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [anyActive, refresh])

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Transkribor</h1>
        <NewProjectDialog onCreated={name => navigate(`/p/${encodeURIComponent(name)}`)} />
      </div>
      {projects.length === 0 && <p className="text-sm text-muted-foreground">Noch keine Projekte. Lege eins an.</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map(p => {
          const done = p.files.filter(f => f.has_edit).length
          return (
            <div key={p.name} className="group relative rounded-lg border p-4 hover:bg-accent">
              <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100">
                <DeleteProjectDialog project={p.name} onDeleted={refresh} />
              </div>
              <Link to={`/p/${encodeURIComponent(p.name)}`} className="block">
                <div className="mb-1 font-medium">{p.name}</div>
                <div className="text-sm text-muted-foreground">
                  {p.files.length} Datei{p.files.length === 1 ? '' : 'en'} · {done} ✓
                </div>
                {p.active_job && (
                  <div className="mt-2 inline-flex items-center gap-1 text-xs text-primary">
                    <Loader2 className="size-3 animate-spin" />
                    {p.active_job.kind === 'transcribe' ? 'Transkribieren…' : 'Korrigieren…'}
                  </div>
                )}
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Run, verify pass**

Run: `npm --prefix webtool/frontend run test -- src/pages/HomeGallery.test.tsx`
Expected: PASS

- [ ] **Step 7: Lint + Build**

Run: `npm --prefix webtool/frontend run lint`
Expected: keine Fehler
Run: `npm --prefix webtool/frontend run build`
Expected: erfolgreich

- [ ] **Step 8: Commit**

```bash
git add webtool/frontend/src/pages/HomeGallery.tsx webtool/frontend/src/pages/HomeGallery.test.tsx webtool/frontend/src/components/NewProjectDialog.tsx webtool/frontend/src/components/DeleteProjectDialog.tsx
git commit -m "feat(web): HomeGallery mit Karten, Anlegen- und Loeschen-Dialog"
```

---

### Task 15: Editor-Sidebar projekt-scoped + Live-Pillen + „‹ zurück"

**Files:**
- Modify: `webtool/frontend/src/components/Sidebar.tsx` (optionaler `backTo`-Link + `phases`/`jobRunning` an die Zeilen; auf ein Projekt gefiltert)
- Modify: `webtool/frontend/src/components/FileRow.tsx` (Live-Pille statt/ergänzend zum statischen Badge)
- Modify: `webtool/frontend/src/pages/EditorView.tsx` (nur aktuelles Projekt an Sidebar; `useActiveJob` einspeisen; Per-Datei-Correct adoptiert Job)
- Test: `webtool/frontend/src/components/FileRow.test.tsx` (erweitern/prüfen)

**Interfaces:**
- Consumes: `useActiveJob`, `FileStatusPill`
- Produces: Editor zeigt nur die Dateien des aktuellen Projekts mit denselben Live-Pillen wie die Arbeitsfläche und einem „‹ zurück"-Link zu `/p/:project`.

- [ ] **Step 1: `FileRow` um Live-Pille erweitern (Test zuerst)**

An die **bestehende** `webtool/frontend/src/components/FileRow.test.tsx` diesen `describe`-Block **anhängen** (nicht überschreiben). Die vorhandenen Imports (`render`, `screen`, `vi`, `FileRow`) wiederverwenden; falls `ProjectFile` noch nicht importiert ist, `import type { ProjectFile } from '@/lib/types'` oben ergänzen:

```tsx
describe('FileRow Live-Status', () => {
  const live: ProjectFile = { base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false }
  it('zeigt aktive Phase statt statischem Badge', () => {
    render(<FileRow file={live} active={false} onOpen={vi.fn()} onCorrectFile={vi.fn()} phase="correct" jobRunning />)
    expect(screen.getByText(/Korrigieren/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npm --prefix webtool/frontend run test -- src/components/FileRow.test.tsx`
Expected: FAIL — `FileRow` akzeptiert `phase`/`jobRunning` noch nicht

- [ ] **Step 3: `FileRow` implementieren**

In `webtool/frontend/src/components/FileRow.tsx` Props + Rendering erweitern. Der Kopf wird zu:

```tsx
import { Pencil } from 'lucide-react'
import type { FilePhase, FileState, ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { FileStatusPill } from '@/components/FileStatusPill'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'

export function FileRow({ file, active, onOpen, onCorrectFile, phase, state, jobRunning }: {
  file: ProjectFile; active: boolean;
  onOpen: () => void; onCorrectFile: (force: boolean) => void;
  phase?: FilePhase; state?: FileState; jobRunning?: boolean;
}) {
```

Danach im JSX den bisherigen statischen `badge`-Span durch die Pille ersetzen. Konkret die Zeile

```tsx
      <span className="flex-1 truncate">{file.base} <span className="text-muted-foreground text-xs">{badge}</span></span>
```

ersetzen durch:

```tsx
      <span className="flex-1 truncate">{file.base}</span>
      <FileStatusPill file={file} active={phase} state={state} jobRunning={jobRunning} />
```

und die nun ungenutzte `const badge = …`-Zeile entfernen.

- [ ] **Step 4: Run, verify pass**

Run: `npm --prefix webtool/frontend run test -- src/components/FileRow.test.tsx`
Expected: PASS

- [ ] **Step 5: `Sidebar` auf ein Projekt + Pillen + Back-Link**

In `webtool/frontend/src/components/Sidebar.tsx` die Props um optionalen `backTo` und die Live-Status-Quelle erweitern. Am Kopf (unter `<h1>`) einen Back-Link ergänzen, und beim `FileRow`-Aufruf die Live-Props durchreichen. Signatur erweitern:

```tsx
import { Link } from 'react-router-dom'
import type { JobPhases } from '@/lib/types'
```

Props ergänzen: `backTo?: string; phases?: JobPhases; jobRunning?: boolean;`. Direkt nach `<h1 …>Transkribor</h1>` einfügen:

```tsx
      {backTo && <Link to={backTo} className="mb-2 block text-sm text-muted-foreground hover:underline">‹ zurück</Link>}
```

Und den `FileRow`-Aufruf erweitern:

```tsx
            <FileRow key={f.base} file={f}
              active={active?.project === p.name && active?.base === f.base}
              onOpen={() => onOpen({ project: p.name, base: f.base })}
              onCorrectFile={force => onCorrectFile(p.name, f.base, force)}
              phase={jobRunning && phases?.active?.base === f.base ? phases.active.phase : undefined}
              state={jobRunning ? phases?.perBase[f.base] : undefined}
              jobRunning={jobRunning} />
```

- [ ] **Step 6: `EditorView` verdrahten (projekt-scoped + Provider)**

In `webtool/frontend/src/pages/EditorView.tsx`:
- Import ergänzen: `import { useActiveJob } from '@/hooks/useActiveJob'`
- Im Body: `const { job, phases, adopt } = useActiveJob()`
- `const running = !!job && job.status === 'running' && job.project === project`
- Nur das aktuelle Projekt an die Sidebar geben und Back-Link + Live-Props setzen. Den `<Sidebar … />`-Aufruf ersetzen durch:

```tsx
        <Sidebar projects={projects.filter(p => p.name === project)} loading={projectsLoading}
          active={sel} onOpen={openFile} onUpload={onUpload}
          onTranscribe={onTranscribe} onCorrect={onCorrect} onCorrectFile={onCorrectFile}
          backTo={project ? `/p/${encodeURIComponent(project)}` : '/'} phases={phases} jobRunning={running} />
```

- Den Per-Datei-Correct-Handler so ändern, dass er den Job adoptiert (Live-Status auch im Editor):

```tsx
  const onCorrectFile = (p: string, b: string, force: boolean) =>
    start(() => startCorrectFile(p, b, force).then(res => { if (res.started) adopt(res.job_id, p, 'correct'); return res }),
      `Korrigieren ${b}`,
      () => { refresh(); if (sel?.project === p && sel?.base === b) reload() })
```

- [ ] **Step 7: Bestehende Tests + Build**

Run: `npm --prefix webtool/frontend run test`
Expected: PASS (inkl. `useJob.test.tsx` — der `Sidebar` bekommt `backTo`/`phases`/`jobRunning` optional, bestehende Aufrufe ohne diese Props kompilieren weiter)
Run: `npm --prefix webtool/frontend run lint && npm --prefix webtool/frontend run build`
Expected: erfolgreich

- [ ] **Step 8: Commit**

```bash
git add webtool/frontend/src/components/Sidebar.tsx webtool/frontend/src/components/FileRow.tsx webtool/frontend/src/components/FileRow.test.tsx webtool/frontend/src/pages/EditorView.tsx
git commit -m "feat(web): Editor-Sidebar projekt-scoped mit Live-Pillen + zurueck-Link"
```

---

## Task 16: Live-E2E-Verifikation + Doku

**Files:**
- Modify: `CLAUDE.md` (Web-Editor-Abschnitt: Home/Workspace-Routen + Live-Status kurz erwähnen)

**Interfaces:** keine — reine Verifikation an der laufenden App.

- [ ] **Step 1: Gesamttests grün**

Run: `.venv/Scripts/python.exe -m pytest webtool -q`
Expected: PASS (alle Backend-Tests)
Run: `npm --prefix webtool/frontend run test`
Expected: PASS (alle Frontend-Tests)

- [ ] **Step 2: App starten und dogfooden**

Run: `./webtool.ps1` (baut Frontend, startet uvicorn :8000, öffnet Browser)
Prüfen:
1. `/` zeigt die Projekt-Galerie; „+ Projekt" legt eins an → landet in `/p/<neu>`.
2. In einem Projekt mit Audio: „Korrigieren" starten → Datei-Zeile zeigt live `⟳ Korrigieren…` → `⟳ Verifizieren…` → `✓ Fertig`; globaler Banner „Glossar wird erstellt…" währenddessen.
3. Browser-Reload während des Laufs → Status ist **weiterhin** sichtbar (Discovery über `active_job`).
4. Editor öffnen (`/p/<projekt>/<base>`): Sidebar zeigt nur dieses Projekt + Live-Pillen + „‹ zurück".
5. Löschen-Dialog: erst nach Eintippen des Projektnamens aktiv.

- [ ] **Step 3: CLAUDE.md kurz nachziehen**

Im Web-Editor-Abschnitt ergänzen, dass das Frontend jetzt Router-basiert ist (`/` Galerie, `/p/:project` Arbeitsfläche, `/p/:project/:base` Editor), Projekte in der UI angelegt/gelöscht werden können und der Live-Pipeline-Status pro Datei aus dem Job-stdout kommt (reload-robust über `active_job`).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): Router-UI + Live-Pipeline-Status im Web-Editor"
```

---

## Self-Review (durchgeführt)

**Spec-Abdeckung:**
- IA/Router (§2) → Task 9. SPA-Fallback (§2) → Task 5.
- Home-Galerie + Anlegen + Löschen (§3) → Task 14 (+ Endpoints Task 3/4).
- Projekt-Arbeitsfläche + Banner + Aktionen (§4) → Task 13.
- Live-Status: Discovery `active_job` (§5.1) → Task 1/2 + Adoption in Task 13/15. Parser (§5.2) → Task 7. Provider (§5.3) → Task 10. Pille → Task 11/15.
- Upload (§6) → Task 12/13.
- Backend-Änderungen (§7) → Task 1–6.
- Editor projekt-scoped (§2/§7) → Task 15.
- Tests (§9) → in jedem Task; `jobPhases.test.ts` Task 7, Backend-pytest Task 1–5.
- Bau-Reihenfolge (§10) → Phasen A–E.

**Platzhalter:** keine — jeder Code-Schritt zeigt vollständigen Code.

**Typ-Konsistenz:** `FilePhase`/`GlobalPhase`/`FileState`/`JobPhases` (Task 7) werden identisch in `jobPhases.ts`, `useActiveJob.tsx`, `FileStatusPill.tsx`, `FileRow.tsx`, `ProjectWorkspace.tsx`, `Sidebar.tsx` verwendet. `parseJobPhases(kind, lines)`, `adopt(id, project, kind)`, `onSettled(fn)`, `createProject(name)`, `deleteProject(project)`, `active_for(project)` durchgängig gleich benannt.
