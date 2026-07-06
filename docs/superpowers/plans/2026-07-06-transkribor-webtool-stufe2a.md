# Transkribor Web-Tool — Stufe 2a (Transkribieren im Browser: Upload + Job-Infra) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audio im Browser hochladen und `transcribe.py` per Knopfdruck als Hintergrundjob starten, mit Fortschrittsanzeige — statt PowerShell.

**Architecture:** Neue `webtool/jobs.py` (threading + `subprocess.Popen` + modul-globale Job-Registry, gepollt via `GET /api/jobs/{id}`; kein asyncio/Celery/Redis). `webtool/app.py` bekommt drei Endpoints (Upload, Transcribe, Job-Status). Frontend: Upload-Feld + Transkribieren-Button pro Projekt + Fortschritts-Panel, das den Job pollt. Alles deterministisch und mit einem FAKE-Subprozess unit-testbar (kein echter GPU-Lauf im Test).

**Tech Stack:** Python 3.13 (stdlib: threading/subprocess/uuid/time/shutil/sys), FastAPI + `python-multipart` (neu, für Upload), pytest; Vanilla-JS-Frontend (bestehend).

## Global Constraints

- venv: `E:\Git\Transkribor\.venv`; Python immer als `.venv\Scripts\python.exe`. Windows/PowerShell. Bash-Tool für git. `node` verfügbar.
- **Nicht den Event-Loop blockieren:** langlaufende Subprozesse laufen in einem Daemon-Thread; Endpoints kehren sofort zurück und bleiben `def`.
- **Job-Registry ist modul-global + `threading.Lock`-geschützt.** `get()` gibt eine KOPIE zurück (inkl. `list(lines)`), da der Worker-Thread nebenläufig anhängt.
- **Dedupe:** pro Projekt höchstens ein laufender Job (Doppelklick = No-op auf den laufenden Job). Zusätzlich: höchstens EIN `transcribe`-Job gleichzeitig (Einzel-GPU, RTX 5080 — VRAM-Schutz).
- **Encoding:** Child-Env `PYTHONUNBUFFERED=1` + `PYTHONIOENCODING=utf-8`; parent-seitig `text=True, encoding="utf-8", errors="replace"` (Whisper-Umlaute nicht als cp1252 zerbrechen, Reader-Thread nie crashen).
- **Nicht-destruktiv/Trust-Boundary:** `project`/`base` via `paths.safe_name` validieren. Upload: nur bekannte `AUDIO_EXT`, `409` bei Existenz (kein Überschreiben laufender Eingaben).
- Neue Dependency ausschließlich `python-multipart` (für FastAPI-Upload). Sonst keine.
- **Bekannte Betriebseinschränkung dokumentieren:** `uvicorn --reload` killt Daemon-Threads + leert die In-Memory-Registry → „nicht mit `--reload` während Jobs laufen".
- Der Server läuft unter der venv-Python → Subprozesse mit `sys.executable` starten, `cwd = paths.ROOT` (Repo-Wurzel, findet `projekte/` + `transcribe.py`).
- Commit-Trailer an jede Commit-Message: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Design-Entscheidungen (Kontext)

- **Reihenfolge:** Dies ist **2a** (Upload + Transkribieren + Job-Infra + Polling-UI). Der Korrektur-Button (**2b**, headless `claude -p`, geteiltes Glossar + pro Datei, Modell Opus) kommt als separater Plan danach und nutzt DIESELBE `jobs.py` + Endpoint-Form.
- **`transcribe.py` läuft als eigener Job** (GPU, Minuten) — NICHT über `claude -p`.
- **Fortschritt = stdout-Zeilen-Streaming** ins Job-Log; Frontend pollt. Kein stream-json, kein WebSocket.

## Dateistruktur

```
webtool/
  jobs.py           # NEU: Job-Registry (threading + Popen), start()/get()
  app.py            # + POST /audio (Upload), POST /transcribe, GET /api/jobs/{id}
  static/
    index.html      # + Upload/Transkribieren-Controls + #jobstatus-Panel
    app.js          # + Upload-POST, Transcribe-POST, Job-Polling
    style.css       # + Styles für Projekt-Aktionen + Job-Panel
  test_jobs.py      # NEU: Registry/Streaming/Dedupe mit Fake-Subprozess
  test_api.py       # + Endpoint-Tests (jobs.start monkeypatchen; Upload real)
webtool.ps1         # (unverändert; Doku-Hinweis kein --reload)
README.md / CLAUDE.md  # kurzer Hinweis auf Browser-Transkription
```

---

### Task 1: `webtool/jobs.py` — Job-Registry mit Fake-Subprozess getestet

**Files:**
- Create: `webtool/jobs.py`
- Test: `webtool/test_jobs.py`

**Interfaces:**
- Produces:
  - `start(project: str, cmd: list, cwd: str, kind: str) -> tuple[str, bool]` — legt Job an, startet Worker-Thread; `(job_id, True)` neu gestartet, `(vorhandene_job_id, False)` wenn Projekt schon einen laufenden Job hat oder (bei `kind=="transcribe"`) schon ein Transcribe-Job läuft.
  - `get(job_id: str) -> dict | None` — Kopie des Job-Records (`id, project, kind, status[running|done|error], lines[list], returncode, pid`) oder `None`.

- [ ] **Step 1: Failing test schreiben**

Create `webtool/test_jobs.py`:
```python
import sys
import time
from webtool import jobs


def _wait(job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = jobs.get(job_id)
        if r and r["status"] != "running":
            return r
        time.sleep(0.02)
    return jobs.get(job_id)


def _echo_cmd(n=3):
    # druckt n Zeilen inkl. Umlaut (Encoding-Check), mit flush
    code = "import sys\n" + f"for i in range({n}):\n    print(f'zeile {{i}} ä', flush=True)\n"
    return [sys.executable, "-c", code]


def test_start_streams_lines_and_completes():
    jid, started = jobs.start("P_stream", _echo_cmd(3), cwd=None, kind="transcribe")
    assert started is True
    r = _wait(jid)
    assert r["status"] == "done" and r["returncode"] == 0
    assert r["lines"] == ["zeile 0 ä", "zeile 1 ä", "zeile 2 ä"]
    assert r["kind"] == "transcribe" and r["project"] == "P_stream"


def test_error_status_on_nonzero_exit():
    jid, _ = jobs.start("P_err", [sys.executable, "-c", "import sys; sys.exit(3)"], cwd=None, kind="correct")
    r = _wait(jid)
    assert r["status"] == "error" and r["returncode"] == 3


def test_dedupe_same_project():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jid1, s1 = jobs.start("P_dupe", slow, cwd=None, kind="correct")
    jid2, s2 = jobs.start("P_dupe", slow, cwd=None, kind="correct")
    assert s1 is True and s2 is False and jid1 == jid2
    _wait(jid1)


def test_only_one_transcribe_at_a_time():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jidA, sA = jobs.start("ProjA", slow, cwd=None, kind="transcribe")
    jidB, sB = jobs.start("ProjB", slow, cwd=None, kind="transcribe")
    assert sA is True and sB is False and jidB == jidA  # zweiter Transcribe abgewiesen
    _wait(jidA)


def test_get_unknown_returns_none():
    assert jobs.get("doesnotexist") is None
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_jobs.py -q
```
Expected: FAIL (`No module named 'webtool.jobs'`).

- [ ] **Step 3: `webtool/jobs.py` implementieren**

Create `webtool/jobs.py`:
```python
"""Minimale In-Memory-Job-Registry für langlaufende Subprozesse (Transkription u.a.).

threading + subprocess.Popen; kein asyncio/Celery/Redis. Ein einzelner lokaler Nutzer.
Fortschritt = stdout-Zeilen im Job-Log; via GET /api/jobs/{id} gepollt.
"""
import os
import subprocess
import threading
import time
import uuid

_jobs = {}                 # job_id -> record
_active = {}               # project -> job_id (Dedupe: ein Job pro Projekt)
_lock = threading.Lock()

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_PRUNE_AGE = 3600          # fertige Jobs nach 1h vergessen


def _prune_locked():
    now = time.time()
    dead = [jid for jid, r in _jobs.items()
            if r["status"] in ("done", "error") and r.get("ended") and now - r["ended"] > _PRUNE_AGE]
    for jid in dead:
        _jobs.pop(jid, None)


def start(project: str, cmd: list, cwd, kind: str):
    with _lock:
        _prune_locked()
        if project in _active:
            return _active[project], False
        if kind == "transcribe":
            running_t = [jid for jid, r in _jobs.items()
                         if r["kind"] == "transcribe" and r["status"] == "running"]
            if running_t:
                return running_t[0], False  # Einzel-GPU: nur ein Transcribe-Job
        jid = uuid.uuid4().hex[:12]
        _jobs[jid] = {"id": jid, "project": project, "kind": kind, "status": "running",
                      "lines": [], "returncode": None, "started": time.time(),
                      "ended": None, "pid": None}
        _active[project] = jid
    threading.Thread(target=_run, args=(jid, cmd, cwd), daemon=True).start()
    return jid, True


def _run(jid, cmd, cwd):
    try:
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=_CREATE_NO_WINDOW, env=env,
        )
        with _lock:
            _jobs[jid]["pid"] = proc.pid
        for line in proc.stdout:
            with _lock:
                _jobs[jid]["lines"].append(line.rstrip("\n"))
        proc.wait()
        with _lock:
            _jobs[jid]["returncode"] = proc.returncode
            _jobs[jid]["status"] = "done" if proc.returncode == 0 else "error"
            _jobs[jid]["ended"] = time.time()
    except Exception as e:  # Launch-Fehler etc. -> kein Zombie 'running'
        with _lock:
            _jobs[jid]["lines"].append(f"JOB-FEHLER: {e}")
            _jobs[jid]["status"] = "error"
            _jobs[jid]["ended"] = time.time()
    finally:
        with _lock:
            proj = _jobs[jid]["project"]
            if _active.get(proj) == jid:
                _active.pop(proj, None)


def get(job_id: str):
    with _lock:
        r = _jobs.get(job_id)
        if r is None:
            return None
        snap = dict(r)
        snap["lines"] = list(r["lines"])
        return snap
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_jobs.py -q
```
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```
git add webtool/jobs.py webtool/test_jobs.py
git commit -m "feat(webtool): jobs.py - In-Memory-Job-Registry (threading+Popen) mit Fortschritt/Dedupe

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Endpoints `POST /transcribe` + `GET /api/jobs/{id}`

**Files:**
- Modify: `webtool/app.py`
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `jobs.start`, `jobs.get` (Task 1), `paths.ROOT`, `paths.safe_name`.
- Produces:
  - `POST /api/projects/{project}/transcribe` → `{"job_id": str, "started": bool}` (startet `transcribe.py` als Job).
  - `GET /api/jobs/{job_id}` → Job-Record oder 404.

- [ ] **Step 1: Failing tests schreiben (jobs.start monkeypatchen — kein echter Subprozess)**

Add to `webtool/test_api.py`:
```python
def test_transcribe_starts_job(client, monkeypatch):
    calls = {}
    def fake_start(project, cmd, cwd, kind):
        calls["project"] = project; calls["kind"] = kind; calls["cmd"] = cmd
        return "job123", True
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "start", fake_start)
    r = client.post("/api/projects/Demo/transcribe")
    assert r.status_code == 200
    assert r.json() == {"job_id": "job123", "started": True}
    assert calls["kind"] == "transcribe" and calls["project"] == "Demo"
    assert calls["cmd"][-1] == "Demo" and calls["cmd"][1].endswith("transcribe.py")


def test_transcribe_invalid_name_400(client):
    assert client.post("/api/projects/a:b/transcribe").status_code == 400


def test_job_status_and_404(client, monkeypatch):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "get", lambda jid: {"id": jid, "status": "running", "lines": ["x"]} if jid == "j1" else None)
    assert client.get("/api/jobs/j1").json()["status"] == "running"
    assert client.get("/api/jobs/nope").status_code == 404
```

- [ ] **Step 2: Tests laufen lassen — neue müssen fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -k "transcribe or job_status" -q
```
Expected: FAIL (404/405 — Routen fehlen).

- [ ] **Step 3: Endpoints in `webtool/app.py` ergänzen**

Ergänze die Importzeile oben in `webtool/app.py` (aktuell `import glob`/`json`/`os` — `glob` wurde in 1.5 entfernt; aktuell `import json`, `import os`). Füge hinzu:
```python
import sys
```
und bei den lokalen Imports:
```python
from . import jobs
```

Füge VOR der `app.mount(...)`-Zeile (die MUSS letzte bleiben) hinzu:
```python
@app.post("/api/projects/{project}/transcribe")
def transcribe(project: str):
    try:
        paths.safe_name(project)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    cmd = [sys.executable, os.path.join(paths.ROOT, "transcribe.py"), project]
    job_id, started = jobs.start(project, cmd, paths.ROOT, "transcribe")
    return {"job_id": job_id, "started": started}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    r = jobs.get(job_id)
    if r is None:
        raise HTTPException(status_code=404, detail="kein Job")
    return r
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -q
```
Expected: PASS (alle, inkl. neue).

- [ ] **Step 5: Commit**

```
git add webtool/app.py webtool/test_api.py
git commit -m "feat(webtool): POST /transcribe (startet transcribe.py als Job) + GET /api/jobs/{id}

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Audio-Upload `POST /api/projects/{project}/audio`

**Files:**
- Modify: `webtool/app.py`
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `paths.safe_name`, `paths.project_dir`, `AUDIO_EXT`.
- Produces: `POST /api/projects/{project}/audio` (multipart `file`) → `{"ok": true, "base": str, "file": str}`; 400 bei unbekannter Endung/ungültigem Namen, 409 wenn Zieldatei existiert. Speichert nach `projekte/<project>/audio/<base><ext>`.

- [ ] **Step 1: `python-multipart` installieren**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pip install python-multipart
```
Expected: „Successfully installed python-multipart-…".

- [ ] **Step 2: Failing tests schreiben**

Add to `webtool/test_api.py`:
```python
def test_upload_ok_and_duplicate_409(client, tmp_path):
    files = {"file": ("Neu.mp3", b"ID3audio", "audio/mpeg")}
    r = client.post("/api/projects/Demo/audio", files=files)
    assert r.status_code == 200 and r.json()["base"] == "Neu"
    assert (tmp_path / "Demo" / "audio" / "Neu.mp3").read_bytes() == b"ID3audio"
    # zweiter Upload derselben Datei -> 409
    r2 = client.post("/api/projects/Demo/audio", files={"file": ("Neu.mp3", b"x", "audio/mpeg")})
    assert r2.status_code == 409


def test_upload_bad_extension_400(client):
    r = client.post("/api/projects/Demo/audio", files={"file": ("schad.txt", b"x", "text/plain")})
    assert r.status_code == 400
```
(Die `client`-Fixture in `test_api.py` legt bereits ein `Demo`-Projekt unter `tmp_path` an.)

- [ ] **Step 3: Tests laufen lassen — neue müssen fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -k upload -q
```
Expected: FAIL (405/404 — Route fehlt).

- [ ] **Step 4: Upload-Endpoint + Imports in `webtool/app.py` ergänzen**

Ergänze die FastAPI-Importzeile (aktuell `from fastapi import FastAPI, HTTPException, Request`) um `File, UploadFile`:
```python
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
```
und oben bei den Standard-Imports:
```python
import shutil
```

Füge VOR der `app.mount(...)`-Zeile hinzu:
```python
@app.post("/api/projects/{project}/audio")
async def upload_audio(project: str, file: UploadFile = File(...)):
    try:
        paths.safe_name(project)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Projektname")
    name = os.path.basename(file.filename or "")           # vom Browser mitgesendete Pfade entfernen
    base, ext = os.path.splitext(name)
    ext = ext.lower()
    try:
        paths.safe_name(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Dateiname")
    if ext not in AUDIO_EXT:
        raise HTTPException(status_code=400, detail=f"nicht unterstützte Endung: {ext or '(keine)'}")
    adir = os.path.join(paths.project_dir(project), "audio")
    os.makedirs(adir, exist_ok=True)
    dest = os.path.join(adir, base + ext)
    if os.path.exists(dest):
        raise HTTPException(status_code=409, detail="Datei existiert bereits")
    with open(dest, "wb") as out:
        shutil.copyfileobj(file.file, out)
    return {"ok": True, "base": base, "file": base + ext}
```

- [ ] **Step 5: Tests laufen lassen — müssen bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q
```
Expected: PASS (alle).

- [ ] **Step 6: Commit**

```
git add webtool/app.py webtool/test_api.py
git commit -m "feat(webtool): POST /audio - Upload nach projekte/<P>/audio (safe_name, AUDIO_EXT, 409)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — Upload + Transkribieren-Button + Job-Polling

**Files:**
- Modify: `webtool/static/index.html`
- Modify: `webtool/static/app.js`
- Modify: `webtool/static/style.css`

**Interfaces:**
- Consumes: `POST /api/projects/{p}/audio`, `POST /api/projects/{p}/transcribe`, `GET /api/jobs/{id}`, `GET /api/projects` (Neuladen nach Job).
- Produces: pro Projektzeile ein Upload-Feld (⬆) + Transkribieren-Button (▶); ein `#jobstatus`-Panel zeigt die letzten Job-Log-Zeilen und pollt bis `done`/`error`, dann Projektliste neu.

- [ ] **Step 1: `#jobstatus`-Panel in `index.html` ergänzen**

Füge in `webtool/static/index.html` unmittelbar nach `<div id="projects">lade…</div>` (noch innerhalb `<aside id="sidebar">`) ein:
```html
    <div id="jobstatus" class="hidden"></div>
```

- [ ] **Step 2: CSS in `style.css` ergänzen**

Append an `webtool/static/style.css`:
```css
#projects .proj { display: flex; align-items: center; gap: 6px; }
#projects .proj .grow { flex: 1; }
#projects .proj button, #projects .proj label.up { font-size: 12px; cursor: pointer; border: 1px solid #ccc; background: #fff; border-radius: 4px; padding: 1px 5px; }
#projects .proj button:disabled { opacity: .5; cursor: default; }
#jobstatus { margin-top: 10px; padding: 8px; background: #111; color: #b8e0b8; font: 11px/1.35 ui-monospace, monospace; border-radius: 4px; white-space: pre-wrap; max-height: 180px; overflow: auto; }
#jobstatus.hidden { display: none; }
```

- [ ] **Step 3: `app.js` — Projekt-Controls + Job-Polling ergänzen**

Ersetze in `webtool/static/app.js` die `for (const p of projects)`-Schleife in `loadProjects` (die aktuell nur den Projekt-Header `h` mit `textContent` setzt) so, dass der Header Controls bekommt. Konkret: die bestehende Zeile
```js
    const h = document.createElement("div");
    h.className = "proj"; h.textContent = p.name; el.appendChild(h);
```
ersetzen durch:
```js
    const h = document.createElement("div");
    h.className = "proj";
    const name = document.createElement("span");
    name.className = "grow"; name.textContent = p.name;
    const up = document.createElement("label");
    up.className = "up"; up.textContent = "⬆"; up.title = "Audio hochladen";
    const upInput = document.createElement("input");
    upInput.type = "file"; upInput.accept = "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4";
    upInput.style.display = "none";
    upInput.onchange = () => uploadAudio(p.name, upInput.files[0]);
    up.appendChild(upInput);
    const tr = document.createElement("button");
    tr.textContent = "▶"; tr.title = "Transkribieren";
    tr.onclick = () => startTranscribe(p.name, tr);
    h.append(name, up, tr);
    el.appendChild(h);
```

Füge diese Funktionen ans Ende von `webtool/static/app.js` an:
```js
async function uploadAudio(project, fileObj) {
  if (!fileObj) return;
  const fd = new FormData();
  fd.append("file", fileObj);
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/audio`,
    { method: "POST", body: fd });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    showJob(`Upload fehlgeschlagen: ${msg.detail || res.status}`);
    return;
  }
  showJob(`Hochgeladen: ${(await res.json()).file}`);
  loadProjects();
}

async function startTranscribe(project, btn) {
  btn.disabled = true;
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/transcribe`, { method: "POST" });
  if (!res.ok) { showJob(`Start fehlgeschlagen: ${res.status}`); btn.disabled = false; return; }
  const { job_id } = await res.json();
  pollJob(job_id, () => { btn.disabled = false; loadProjects(); });
}

function showJob(text) {
  const box = $("#jobstatus");
  box.classList.remove("hidden");
  box.textContent = text;
  box.scrollTop = box.scrollHeight;
}

function pollJob(jobId, onDone) {
  const tick = async () => {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!res.ok) { showJob("Job nicht gefunden."); return; }
    const j = await res.json();
    showJob((j.lines || []).slice(-12).join("\n") || `Status: ${j.status}`);
    if (j.status === "running") { setTimeout(tick, 1500); }
    else { showJob(((j.lines || []).slice(-12).join("\n")) + `\n[${j.status}]`); if (onDone) onDone(); }
  };
  tick();
}
```

- [ ] **Step 4: `node --check` + manuelle Akzeptanz (Controller-validiert)**

Run:
```
node --check webtool/static/app.js
```
Expected: exit 0.

Manuelle Akzeptanz (vom Controller, mit Fake-`transcribe.py`-Ersatz oder echtem kleinen Audio): Server starten, Seite laden → jede Projektzeile hat ⬆ + ▶. ⬆ lädt eine Audiodatei hoch (Projektliste aktualisiert, Datei erscheint in `audio/`). ▶ startet den Job; `#jobstatus` zeigt live die Log-Zeilen und endet mit `[done]`/`[error]`, danach Projektliste neu. (Voll interaktive/GPU-Validierung ist DEFERRED an den Controller.)

- [ ] **Step 5: Commit**

```
git add webtool/static/index.html webtool/static/app.js webtool/static/style.css
git commit -m "feat(webtool): Frontend - Upload + Transkribieren-Button + Job-Fortschritt-Polling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Dokumentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:** keine (Doku).

- [ ] **Step 1: README ergänzen**

Füge in `README.md` im Abschnitt „## Editieren im Browser (Web-Tool, Stufe 1)" nach der Aufzählung an:
```markdown

**Transkribieren im Browser (Stufe 2a):** In der Projektliste lädt ⬆ Audio in
`projekte\<NAME>\audio\` hoch und ▶ startet `transcribe.py` als Hintergrundjob;
der Fortschritt erscheint live im Panel. Hinweis: **nicht mit `uvicorn --reload`
starten, während Jobs laufen** — ein Reload killt laufende Jobs und die Job-Liste.
```

- [ ] **Step 2: CLAUDE.md ergänzen**

Füge in `CLAUDE.md` unter „## Umgebung (Fakten)" an die Web-Editor-Zeile anschließend an:
```markdown
- Stufe 2a (Browser-Transkription): `POST /audio` (Upload), `POST /transcribe`
  (startet `transcribe.py` via `webtool/jobs.py`-Job), `GET /api/jobs/{id}` (Polling).
  Job-Registry ist in-memory (threading+Popen) — kein `--reload` während Jobs.
```

- [ ] **Step 3: Volle Suite als Schlusskontrolle**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q
```
Expected: PASS (alle).

- [ ] **Step 4: Commit**

```
git add README.md CLAUDE.md
git commit -m "docs(webtool): Browser-Transkription (Stufe 2a) in README + CLAUDE.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec-Abdeckung** (Spec §5.1 Endpoints Stufe 2 + §9 Stufe 2 + De-Risking-Synthese):
- `POST /audio` (Upload, UploadFile, AUDIO_EXT, safe_name, 409) → Task 3 ✓
- `POST /transcribe` (transcribe.py als Job) → Task 2 ✓
- `GET /api/jobs/{id}` (Polling) → Task 2 ✓
- Job-Infra (threading+Popen, Dedupe, Einzel-GPU, Encoding) → Task 1 ✓
- Frontend (Upload + Transcribe-Button + Fortschritt) → Task 4 ✓
- `--reload`-Betriebshinweis dokumentiert → Task 5 ✓
- Korrektur-Button (`POST /correct` via `claude -p`) → **Stufe 2b, eigener Plan** (bewusst ausgeklammert) ✓

**2. Placeholder-Scan:** keine „TBD/TODO/handle edge cases"; alle Code-Schritte vollständig; Tests mit echten Assertions. Task 4 (Frontend) hat konkrete manuelle Akzeptanz + `node --check` (kein pytest — keine sinnvolle Unit-Test-Fläche ohne Browser).

**3. Typ-/Namens-Konsistenz:** `jobs.start(project, cmd, cwd, kind) -> (job_id, started)` / `jobs.get(job_id) -> dict|None` (Task 1) ↔ Nutzung in Endpoints (Task 2) ↔ monkeypatch in Tests. Job-Record-Felder (`id,project,kind,status,lines,returncode,pid`) konsistent zwischen `jobs.py`, `get()`-Test und Frontend-Polling (`j.lines`, `j.status`). Endpoints (`/audio`, `/transcribe`, `/api/jobs/{id}`) stimmen mit den `fetch`-Aufrufen im Frontend überein. `AUDIO_EXT` (bestehende Konstante in app.py) von Upload wiederverwendet.

Keine offenen Lücken. Nach der Ausführung: Controller-End-to-End-Validierung (Upload + echter kleiner Transcribe-Lauf ODER Fake-transcribe.py im Browser) — Reihenfolge/Encoding/Live-Fortschritt.
