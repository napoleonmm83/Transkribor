# Transkribor Web-Tool — Stufe 1 (Editor-Kern) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein lokaler FastAPI-Webeditor, der bestehende Whisper-Transkripte abschnittweise zeigt, per Klick das Audio-Snippet abspielt, Unsicherheiten hervorhebt und manuelle Korrekturen nicht-destruktiv speichert und als `.md` exportiert.

**Architecture:** FastAPI (in vorhandener `.venv`) serviert eine statische `index.html` + Vanilla-JS. Kanonisches Editier-Dokument ist `<base>.edit.json`, aufgebaut aus der immutablen Whisper-Rohausgabe `<base>.json`. Kein Framework, keine DB, kein Docker. Waveform via lokal eingebettetem wavesurfer.js v7.

**Tech Stack:** Python 3.13, FastAPI, uvicorn, Starlette FileResponse (HTTP-Range), pytest + httpx (Tests), Vanilla-JS + wavesurfer.js v7 (vendored).

## Global Constraints

- venv: `E:\Git\Transkribor\.venv`; Python immer als `.venv\Scripts\python.exe` aufrufen. Plattform Windows 11 / PowerShell.
- **Nicht-destruktiv:** `<base>.json` (Whisper-Roh) wird NIE geschrieben/überschrieben. Editier-Zustand ausschließlich in `<base>.edit.json`; `<base>.md` ist reiner Export.
- Neue Abhängigkeiten nur: `fastapi`, `uvicorn[standard]`, `httpx`, `pytest`. Keine DB, kein Docker, kein Frontend-Framework, kein Node-Buildstep.
- **wavesurfer.js lokal einbetten** (`webtool/static/vendor/`), kein CDN-Fetch (CSP-safe, offline).
- Unsicherheits-Schwellen als Konstanten an EINER Stelle, im UI per Regler übersteuerbar — nicht über den Code verstreut.
- Whisper-Segment-Flag-Schwellen (Whisper-Defaults, verbatim): `compression_ratio > 2.4`, `no_speech_prob > 0.6`, `avg_logprob < -1.0`.
- Wort-Unsicherheits-Startwerte (UI-Default, verstellbar): gelb `probability < 0.6`, rot `probability < 0.4`.
- Pfad-Parameter (`project`, `base`) aus URL sind eine Trust-Boundary → immer `safe_name()` validieren (Path-Traversal verhindern).
- `transcribe.py` und `tools/correct_label.mjs` bleiben in Stufe 1 unverändert.
- Branch: `webtool` (bereits ausgecheckt). Häufig committen (ein Commit pro Task).

## Dateistruktur

```
webtool/
  __init__.py          # leer
  paths.py             # Repo-/Projekt-Pfade + safe_name() (Path-Traversal-Schutz)
  edit_model.py        # compute_flags(), build_edit_doc()  (Roh-JSON -> edit.json)
  render_md.py         # render_md()  (edit.json -> Markdown-Export)
  app.py               # FastAPI: Projekte/Datei/Audio/Save/Export-Endpoints
  static/
    index.html         # Editor-UI (eine Seite)
    style.css
    app.js             # Vanilla-JS: laden, rendern, Play, Highlight, Unsicherheit, Save
    vendor/
      wavesurfer.esm.js  # wavesurfer v7, lokal eingebettet
  test_paths.py
  test_edit_model.py
  test_render_md.py
  test_api.py
webtool.ps1            # Launcher (uvicorn + Browser öffnen)
```

Verantwortlichkeiten getrennt: reine Logik (`edit_model`, `render_md`, `paths`) ist ohne Server testbar; `app.py` ist nur HTTP-Verdrahtung; das Frontend ist eine Datei-Gruppe unter `static/`.

---

### Task 1: Pfad-Helfer mit Path-Traversal-Schutz (`paths.py`)

**Files:**
- Create: `webtool/__init__.py` (leer)
- Create: `webtool/paths.py`
- Test: `webtool/test_paths.py`

**Interfaces:**
- Produces:
  - `ROOT: str` — Repo-Wurzel (ein Verzeichnis über `webtool/`).
  - `projekte_root() -> str` — `$TRANSKRIBOR_PROJEKTE` oder `<ROOT>/projekte` (Env macht Tests hermetisch).
  - `safe_name(name: str) -> str` — gibt `name` zurück oder wirft `ValueError` bei Traversal.
  - `project_dir(project) -> str`, `transkripte_dir(project) -> str`, `audio_dir(project) -> str`.

- [ ] **Step 1: pytest installieren**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pip install pytest
```
Expected: „Successfully installed pytest-…" (oder „already satisfied").

- [ ] **Step 2: Failing test schreiben**

Create `webtool/test_paths.py`:
```python
import os
import pytest
from webtool import paths


def test_safe_name_accepts_normal():
    assert paths.safe_name("Foodfestival-Maienfeld") == "Foodfestival-Maienfeld"
    assert paths.safe_name("C0687_01913077") == "C0687_01913077"


@pytest.mark.parametrize("bad", ["../etc", "a/b", "a\\b", "..", "", "x\x00y"])
def test_safe_name_rejects_traversal(bad):
    with pytest.raises(ValueError):
        paths.safe_name(bad)


def test_projekte_root_respects_env(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    assert paths.projekte_root() == str(tmp_path)


def test_project_dir_joins(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    assert paths.project_dir("P") == os.path.join(str(tmp_path), "P")
```

- [ ] **Step 3: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_paths.py -q
```
Expected: FAIL (`ModuleNotFoundError: No module named 'webtool'` bzw. `paths`).

- [ ] **Step 4: `webtool/__init__.py` (leer) und `webtool/paths.py` anlegen**

Create `webtool/__init__.py`: (leere Datei)

Create `webtool/paths.py`:
```python
"""Pfade + Namensvalidierung (Trust-Boundary: project/base kommen aus der URL)."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def projekte_root() -> str:
    return os.environ.get("TRANSKRIBOR_PROJEKTE") or os.path.join(ROOT, "projekte")


def safe_name(name: str) -> str:
    if not name or "/" in name or "\\" in name or ".." in name or "\x00" in name:
        raise ValueError(f"unsicherer Name: {name!r}")
    return name


def project_dir(project: str) -> str:
    return os.path.join(projekte_root(), safe_name(project))


def transkripte_dir(project: str) -> str:
    return os.path.join(project_dir(project), "transkripte")


def audio_dir(project: str) -> str:
    d = os.path.join(project_dir(project), "audio")
    return d if os.path.isdir(d) else project_dir(project)
```

- [ ] **Step 5: Test laufen lassen — muss bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_paths.py -q
```
Expected: PASS (4 passed).

- [ ] **Step 6: Commit**

```
git add webtool/__init__.py webtool/paths.py webtool/test_paths.py
git commit -m "feat(webtool): Pfad-Helfer mit Path-Traversal-Schutz"
```

---

### Task 2: `edit.json` aus Whisper-Roh bauen + Flags (`edit_model.py`)

**Files:**
- Create: `webtool/edit_model.py`
- Test: `webtool/test_edit_model.py`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - Konstanten `COMPRESSION_RATIO_THRESHOLD = 2.4`, `NO_SPEECH_THRESHOLD = 0.6`, `LOGPROB_THRESHOLD = -1.0`.
  - `compute_flags(segment: dict) -> dict` → `{"hallucination": bool, "silence": bool, "low_conf": bool}`.
  - `build_edit_doc(raw: dict, *, base: str, project: str, audio: str) -> dict` → edit.json-Dokument (Schema siehe Spec §4.2).

- [ ] **Step 1: Failing test schreiben**

Create `webtool/test_edit_model.py`:
```python
from webtool import edit_model as em


def test_compute_flags_hallucination():
    seg = {"compression_ratio": 2.5, "no_speech_prob": 0.1, "avg_logprob": -0.3}
    assert em.compute_flags(seg) == {"hallucination": True, "silence": False, "low_conf": False}


def test_compute_flags_silence_needs_both():
    seg = {"compression_ratio": 1.0, "no_speech_prob": 0.7, "avg_logprob": -1.5}
    f = em.compute_flags(seg)
    assert f["silence"] is True and f["low_conf"] is True
    # hoher no_speech_prob allein (avg_logprob gut) ist KEINE Stille
    seg2 = {"compression_ratio": 1.0, "no_speech_prob": 0.7, "avg_logprob": -0.2}
    assert em.compute_flags(seg2)["silence"] is False


def test_compute_flags_low_conf_only():
    seg = {"compression_ratio": 1.0, "no_speech_prob": 0.1, "avg_logprob": -1.2}
    f = em.compute_flags(seg)
    assert f == {"hallucination": False, "silence": False, "low_conf": True}


def test_build_edit_doc_shape():
    raw = {
        "language": "de",
        "segments": [
            {"id": 0, "start": 5.28, "end": 13.5, "text": " Ich bin da. ",
             "compression_ratio": 1.1, "no_speech_prob": 0.01, "avg_logprob": -0.4,
             "words": [{"word": " Ich", "start": 5.28, "end": 6.0, "probability": 0.13}]},
        ],
    }
    doc = em.build_edit_doc(raw, base="B", project="P", audio="B.mp3")
    assert doc["base"] == "B" and doc["project"] == "P" and doc["audio"] == "B.mp3"
    assert doc["language"] == "de" and doc["human_edited"] is False
    assert doc["speakers"] == [] and doc["annotations"] == []
    seg = doc["segments"][0]
    assert seg["raw_text"] == "Ich bin da." and seg["text"] == "Ich bin da."
    assert seg["speaker"] == "" and seg["note"] == ""
    assert seg["words"][0]["probability"] == 0.13
    assert seg["flags"] == {"hallucination": False, "silence": False, "low_conf": False}
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_edit_model.py -q
```
Expected: FAIL (`No module named 'webtool.edit_model'`).

- [ ] **Step 3: `webtool/edit_model.py` implementieren**

Create `webtool/edit_model.py`:
```python
"""Whisper-Rohausgabe (<base>.json) -> kanonisches edit.json-Dokument."""

COMPRESSION_RATIO_THRESHOLD = 2.4
NO_SPEECH_THRESHOLD = 0.6
LOGPROB_THRESHOLD = -1.0


def compute_flags(segment: dict) -> dict:
    cr = segment.get("compression_ratio", 0.0)
    nsp = segment.get("no_speech_prob", 0.0)
    alp = segment.get("avg_logprob", 0.0)
    return {
        "hallucination": cr > COMPRESSION_RATIO_THRESHOLD,
        "silence": nsp > NO_SPEECH_THRESHOLD and alp < LOGPROB_THRESHOLD,
        "low_conf": alp < LOGPROB_THRESHOLD,
    }


def build_edit_doc(raw: dict, *, base: str, project: str, audio: str) -> dict:
    segments = []
    for seg in raw.get("segments", []):
        text = (seg.get("text") or "").strip()
        segments.append({
            "id": seg.get("id"),
            "start": seg.get("start"),
            "end": seg.get("end"),
            "speaker": "",
            "raw_text": text,
            "text": text,
            "words": [
                {"word": w.get("word", ""), "start": w.get("start"),
                 "end": w.get("end"), "probability": w.get("probability", 1.0)}
                for w in seg.get("words", [])
            ],
            "flags": compute_flags(seg),
            "note": "",
        })
    return {
        "base": base,
        "project": project,
        "audio": audio,
        "language": raw.get("language", "de"),
        "human_edited": False,
        "context": "",
        "speakers": [],
        "segments": segments,
        "annotations": [],
    }
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_edit_model.py -q
```
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```
git add webtool/edit_model.py webtool/test_edit_model.py
git commit -m "feat(webtool): edit.json aus Whisper-Roh bauen + Segment-Flags"
```

---

### Task 3: Markdown-Export rendern (`render_md.py`)

**Files:**
- Create: `webtool/render_md.py`
- Test: `webtool/test_render_md.py`

**Interfaces:**
- Consumes: edit.json-Dokument (aus Task 2).
- Produces: `render_md(doc: dict) -> str`.

Render-Regeln (Spec §7.1): Titel `# Interview <base>`; optional `**Kontext:** …`; `---`; maximale Läufe gleichen Sprechers zu einem Redebeitrag verbinden (Texte mit Leerzeichen); leerer Sprecher → „Befragte Person"; `## Anmerkungen` nur wenn `annotations` oder nicht-leere `note`s existieren.

- [ ] **Step 1: Failing test schreiben**

Create `webtool/test_render_md.py`:
```python
from webtool.render_md import render_md


def _seg(id, spk, text, note=""):
    return {"id": id, "speaker": spk, "text": text, "note": note}


def test_groups_consecutive_same_speaker():
    doc = {"base": "B", "context": "", "annotations": [], "segments": [
        _seg(0, "Interviewer", "Frage eins?"),
        _seg(1, "Hans", "Antwort A."),
        _seg(2, "Hans", "Und noch B."),
        _seg(3, "Interviewer", "Frage zwei?"),
    ]}
    md = render_md(doc)
    assert "# Interview B" in md
    assert "**Interviewer:** Frage eins?" in md
    assert "**Hans:** Antwort A. Und noch B." in md
    assert md.index("Frage eins?") < md.index("Antwort A.") < md.index("Frage zwei?")


def test_context_and_empty_speaker():
    doc = {"base": "B", "context": "Worum es geht.", "annotations": [],
           "segments": [_seg(0, "", "Hallo.")]}
    md = render_md(doc)
    assert "**Kontext:** Worum es geht." in md
    assert "**Befragte Person:** Hallo." in md


def test_annotations_only_when_present():
    doc0 = {"base": "B", "context": "", "annotations": [], "segments": [_seg(0, "A", "x")]}
    assert "## Anmerkungen" not in render_md(doc0)
    doc1 = {"base": "B", "context": "", "annotations": ["Unsichere Stelle."],
            "segments": [_seg(0, "A", "x", note="Segment-Notiz.")]}
    md = render_md(doc1)
    assert "## Anmerkungen" in md
    assert "- Unsichere Stelle." in md and "- Segment-Notiz." in md
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_render_md.py -q
```
Expected: FAIL (`No module named 'webtool.render_md'`).

- [ ] **Step 3: `webtool/render_md.py` implementieren**

Create `webtool/render_md.py`:
```python
"""edit.json-Dokument -> Markdown-Export (<base>.md)."""


def render_md(doc: dict) -> str:
    segs = doc.get("segments", [])
    lines = [f"# Interview {doc.get('base', '')}", ""]
    if doc.get("context"):
        lines += [f"**Kontext:** {doc['context']}", ""]
    lines += ["---", ""]

    i = 0
    while i < len(segs):
        speaker = (segs[i].get("speaker") or "").strip() or "Befragte Person"
        texts = []
        j = i
        while j < len(segs) and ((segs[j].get("speaker") or "").strip() or "Befragte Person") == speaker:
            t = (segs[j].get("text") or "").strip()
            if t:
                texts.append(t)
            j += 1
        lines += [f"**{speaker}:** {' '.join(texts)}", ""]
        i = j

    notes = [n.strip() for n in doc.get("annotations", []) if n.strip()]
    notes += [(s.get("note") or "").strip() for s in segs if (s.get("note") or "").strip()]
    if notes:
        lines += ["## Anmerkungen"]
        lines += [f"- {n}" for n in notes]
        lines += [""]

    return "\n".join(lines).rstrip() + "\n"
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_render_md.py -q
```
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```
git add webtool/render_md.py webtool/test_render_md.py
git commit -m "feat(webtool): Markdown-Export aus edit.json rendern"
```

---

### Task 4: FastAPI-App — Projekte auflisten + Datei laden (GET)

**Files:**
- Create: `webtool/app.py`
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `paths` (Task 1), `edit_model.build_edit_doc` (Task 2).
- Produces (App-Verhalten):
  - `app: FastAPI`
  - Helfer `find_audio(project, base) -> str | None`, `load_or_build_doc(project, base) -> dict`.
  - `GET /api/projects` → `{"projects": [{"name": str, "files": [{"base","has_audio","has_raw","has_edit","has_md"}]}]}`.
  - `GET /api/projects/{project}/files/{base}` → edit.json-Dokument (aus `.edit.json` oder frisch gebaut). 404 wenn kein Roh-JSON.

- [ ] **Step 1: FastAPI + Test-Abhängigkeiten installieren**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pip install fastapi "uvicorn[standard]" httpx
```
Expected: „Successfully installed fastapi-… uvicorn-… httpx-…".

- [ ] **Step 2: Failing test schreiben (mit hermetischer Fixture)**

Create `webtool/test_api.py`:
```python
import json
import os
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    proj = tmp_path / "Demo"
    (proj / "audio").mkdir(parents=True)
    (proj / "transkripte").mkdir()
    (proj / "audio" / "S1.mp3").write_bytes(b"ID3fakeaudio")
    raw = {"language": "de", "text": "Hallo Welt.", "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Hallo Welt. ",
         "compression_ratio": 1.1, "no_speech_prob": 0.01, "avg_logprob": -0.3,
         "words": [{"word": " Hallo", "start": 0.0, "end": 0.5, "probability": 0.9}]}]}
    (proj / "transkripte" / "S1.json").write_text(json.dumps(raw), encoding="utf-8")
    from webtool.app import app
    return TestClient(app)


def test_list_projects(client):
    r = client.get("/api/projects")
    assert r.status_code == 200
    projs = r.json()["projects"]
    demo = next(p for p in projs if p["name"] == "Demo")
    f = next(x for x in demo["files"] if x["base"] == "S1")
    assert f["has_raw"] and f["has_audio"] and not f["has_edit"]


def test_get_file_builds_doc(client):
    r = client.get("/api/projects/Demo/files/S1")
    assert r.status_code == 200
    doc = r.json()
    assert doc["base"] == "S1" and doc["audio"] == "S1.mp3"
    assert doc["segments"][0]["text"] == "Hallo Welt."


def test_get_missing_file_404(client):
    assert client.get("/api/projects/Demo/files/nope").status_code == 404
```

- [ ] **Step 3: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -q
```
Expected: FAIL (`No module named 'webtool.app'`).

- [ ] **Step 4: `webtool/app.py` implementieren (GET-Teil)**

Create `webtool/app.py`:
```python
"""FastAPI-Backend für den Transkribor-Editor (Stufe 1)."""
import glob
import json
import os

from fastapi import FastAPI, HTTPException

from . import paths
from .edit_model import build_edit_doc

app = FastAPI(title="Transkribor Editor")

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")


def _bases(project: str):
    tdir = paths.transkripte_dir(project)
    if not os.path.isdir(tdir):
        return []
    return sorted({os.path.splitext(os.path.basename(p))[0]
                   for p in glob.glob(os.path.join(tdir, "*.json"))
                   if not p.endswith(".edit.json")})


def find_audio(project: str, base: str):
    adir = paths.audio_dir(project)
    for ext in AUDIO_EXT:
        cand = os.path.join(adir, base + ext)
        if os.path.exists(cand):
            return cand
    return None


def _raw_path(project, base):
    return os.path.join(paths.transkripte_dir(project), base + ".json")


def _edit_path(project, base):
    return os.path.join(paths.transkripte_dir(project), base + ".edit.json")


def _md_path(project, base):
    return os.path.join(paths.transkripte_dir(project), base + ".md")


def load_or_build_doc(project: str, base: str) -> dict:
    epath = _edit_path(project, base)
    if os.path.exists(epath):
        with open(epath, encoding="utf-8") as fh:
            return json.load(fh)
    rpath = _raw_path(project, base)
    if not os.path.exists(rpath):
        raise HTTPException(status_code=404, detail=f"kein Roh-Transkript: {base}")
    with open(rpath, encoding="utf-8") as fh:
        raw = json.load(fh)
    audio = find_audio(project, base)
    return build_edit_doc(raw, base=base, project=project,
                          audio=os.path.basename(audio) if audio else "")


@app.get("/api/projects")
def list_projects():
    root = paths.projekte_root()
    out = []
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            if not os.path.isdir(os.path.join(root, name)):
                continue
            files = []
            for base in _bases(name):
                files.append({
                    "base": base,
                    "has_audio": find_audio(name, base) is not None,
                    "has_raw": os.path.exists(_raw_path(name, base)),
                    "has_edit": os.path.exists(_edit_path(name, base)),
                    "has_md": os.path.exists(_md_path(name, base)),
                })
            out.append({"name": name, "files": files})
    return {"projects": out}


@app.get("/api/projects/{project}/files/{base}")
def get_file(project: str, base: str):
    try:
        paths.safe_name(project); paths.safe_name(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    return load_or_build_doc(project, base)
```

- [ ] **Step 5: Test laufen lassen — muss bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -q
```
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```
git add webtool/app.py webtool/test_api.py
git commit -m "feat(webtool): FastAPI GET Projekte + Datei laden (edit.json on-the-fly)"
```

---

### Task 5: Audio-Range-Stream + nicht-destruktives Speichern + Export

**Files:**
- Modify: `webtool/app.py` (Endpoints ergänzen)
- Modify: `webtool/test_api.py` (Tests ergänzen)

**Interfaces:**
- Consumes: `render_md.render_md` (Task 3), Helfer aus Task 4.
- Produces:
  - `GET /api/projects/{project}/audio/{base}` → `FileResponse` (HTTP-Range-fähig, fürs Seeking).
  - `PUT /api/projects/{project}/files/{base}` (Body = edit.json-Dokument) → schreibt `.edit.json` mit `human_edited=true`, rendert `.md`; **rührt `.json` nicht an**. Antwort `{"ok": true}`.
  - `POST /api/projects/{project}/files/{base}/export` → rendert `.md` neu, Antwort `{"md": <text>}`.

- [ ] **Step 1: Failing tests ergänzen**

Add to `webtool/test_api.py`:
```python
def test_audio_range_206(client):
    r = client.get("/api/projects/Demo/audio/S1", headers={"Range": "bytes=0-3"})
    assert r.status_code == 206
    assert r.content == b"ID3f"


def test_put_saves_non_destructive(client, tmp_path):
    doc = client.get("/api/projects/Demo/files/S1").json()
    doc["segments"][0]["speaker"] = "Interviewer"
    doc["segments"][0]["text"] = "Hallo, Welt!"
    r = client.put("/api/projects/Demo/files/S1", json=doc)
    assert r.status_code == 200 and r.json()["ok"] is True

    tdir = tmp_path / "Demo" / "transkripte"
    saved = (tdir / "S1.edit.json").read_text(encoding="utf-8")
    assert '"human_edited": true' in saved
    assert "Interviewer" in saved
    md = (tdir / "S1.md").read_text(encoding="utf-8")
    assert "**Interviewer:** Hallo, Welt!" in md
    # Roh-JSON unangetastet
    raw = (tdir / "S1.json").read_text(encoding="utf-8")
    assert "Hallo Welt." in raw and "Hallo, Welt!" not in raw


def test_export_returns_md(client):
    client.get("/api/projects/Demo/files/S1")
    r = client.post("/api/projects/Demo/files/S1/export")
    assert r.status_code == 200 and r.json()["md"].startswith("# Interview S1")
```

- [ ] **Step 2: Tests laufen lassen — neue müssen fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -q
```
Expected: 3 neue FAIL (404/405 auf audio/put/export), 3 alte PASS.

- [ ] **Step 3: Endpoints in `webtool/app.py` ergänzen**

Add imports oben in `webtool/app.py` (zur bestehenden Importzeile):
```python
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from .render_md import render_md
```

Append to `webtool/app.py`:
```python
@app.get("/api/projects/{project}/audio/{base}")
def get_audio(project: str, base: str):
    try:
        paths.safe_name(project); paths.safe_name(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    audio = find_audio(project, base)
    if not audio:
        raise HTTPException(status_code=404, detail="kein Audio")
    return FileResponse(audio)  # Starlette FileResponse unterstützt HTTP-Range


@app.put("/api/projects/{project}/files/{base}")
async def save_file(project: str, base: str, request: Request):
    try:
        paths.safe_name(project); paths.safe_name(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    doc = await request.json()
    doc["human_edited"] = True
    tdir = paths.transkripte_dir(project)
    os.makedirs(tdir, exist_ok=True)
    with open(_edit_path(project, base), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    with open(_md_path(project, base), "w", encoding="utf-8") as fh:
        fh.write(render_md(doc))
    return {"ok": True}


@app.post("/api/projects/{project}/files/{base}/export")
def export_file(project: str, base: str):
    try:
        paths.safe_name(project); paths.safe_name(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    doc = load_or_build_doc(project, base)
    md = render_md(doc)
    with open(_md_path(project, base), "w", encoding="utf-8") as fh:
        fh.write(md)
    return {"md": md}
```

- [ ] **Step 4: Tests laufen lassen — alle müssen bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q
```
Expected: PASS (alle, inkl. Tasks 1–4).

- [ ] **Step 5: Commit**

```
git add webtool/app.py webtool/test_api.py
git commit -m "feat(webtool): Audio-Range-Stream, nicht-destruktives Speichern, Export"
```

---

### Task 6: Frontend-Shell + Launcher (Navigation, Edit, Save, Export)

**Files:**
- Create: `webtool/static/index.html`
- Create: `webtool/static/style.css`
- Create: `webtool/static/app.js`
- Create: `webtool.ps1`
- Modify: `webtool/app.py` (StaticFiles + `GET /` mounten)

**Interfaces:**
- Consumes: alle GET/PUT/POST-Endpoints (Tasks 4–5).
- Produces: bedienbares UI (Projektliste → Datei → Segmentblöcke editierbar → Speichern/Export). Audio + Unsicherheit kommen in Tasks 7–8.

- [ ] **Step 1: Static-Mount in `webtool/app.py` ergänzen**

Add import:
```python
from fastapi.staticfiles import StaticFiles
```
Append ans Ende von `webtool/app.py`:
```python
_STATIC = os.path.join(os.path.dirname(__file__), "static")
app.mount("/", StaticFiles(directory=_STATIC, html=True), name="static")
```
(Mount als LETZTES, damit `/api/...` Vorrang hat.)

- [ ] **Step 2: `webtool/static/index.html` anlegen**

```html
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Transkribor Editor</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <aside id="sidebar">
    <h1>Transkribor</h1>
    <div id="projects">lade…</div>
  </aside>
  <main id="main">
    <header id="toolbar">
      <span id="current">— keine Datei —</span>
      <span class="spacer"></span>
      <label class="thr">gelb&lt; <input id="thrYellow" type="range" min="0" max="1" step="0.05" value="0.6"><b id="thrYellowV">0.60</b></label>
      <label class="thr">rot&lt; <input id="thrRed" type="range" min="0" max="1" step="0.05" value="0.4"><b id="thrRedV">0.40</b></label>
      <button id="save" disabled>Speichern</button>
      <button id="export" disabled>Export .md</button>
      <span id="status"></span>
    </header>
    <div id="player"></div>
    <section id="segments"></section>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: `webtool/static/style.css` anlegen**

```css
* { box-sizing: border-box; }
body { margin: 0; display: flex; height: 100vh; font: 15px/1.5 system-ui, sans-serif; color: #1a1a1a; }
#sidebar { width: 240px; flex: none; border-right: 1px solid #ddd; padding: 12px; overflow: auto; background: #fafafa; }
#sidebar h1 { font-size: 18px; margin: 0 0 12px; }
#projects .proj { font-weight: 600; margin-top: 10px; }
#projects .file { cursor: pointer; padding: 3px 6px; border-radius: 4px; color: #333; }
#projects .file:hover { background: #eee; }
#projects .file.active { background: #d7e8ff; }
#projects .file .badge { color: #888; font-size: 12px; }
#main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #ddd; }
#toolbar .spacer { flex: 1; }
#toolbar .thr { font-size: 12px; color: #555; display: flex; align-items: center; gap: 4px; }
#toolbar .thr input { width: 80px; }
#player { padding: 8px 12px; }
#segments { flex: 1; overflow: auto; padding: 12px; }
.seg { display: grid; grid-template-columns: 180px 1fr; gap: 10px; padding: 8px; border-left: 3px solid transparent; border-radius: 4px; }
.seg:hover { background: #f6f6f6; }
.seg.active { background: #fff7e0; border-left-color: #f0a800; }
.seg .meta { font-size: 13px; color: #666; }
.seg .meta input { width: 100%; font-size: 13px; }
.seg .meta .time { cursor: pointer; color: #06c; text-decoration: underline; }
.seg .flag { font-size: 13px; }
.seg .text { outline: none; }
.seg .text:focus { background: #fffef5; box-shadow: 0 0 0 2px #f0e0a0; border-radius: 3px; }
</style>
```
(Hinweis: schließendes `</style>` NICHT mit in die `.css` schreiben — es steht hier nur versehentlich; die Datei enthält nur CSS-Regeln bis `box-shadow…`.)

- [ ] **Step 4: `webtool/static/app.js` anlegen**

```js
const $ = (s, r = document) => r.querySelector(s);
const state = { project: null, base: null, doc: null, dirty: false };

async function loadProjects() {
  const { projects } = await (await fetch("/api/projects")).json();
  const el = $("#projects");
  el.innerHTML = "";
  for (const p of projects) {
    const h = document.createElement("div");
    h.className = "proj"; h.textContent = p.name; el.appendChild(h);
    for (const f of p.files) {
      const d = document.createElement("div");
      d.className = "file";
      const badge = f.has_edit ? "✎" : (f.has_md ? "✓" : (f.has_audio ? "●" : ""));
      d.innerHTML = `${f.base} <span class="badge">${badge}</span>`;
      d.onclick = () => openFile(p.name, f.base, d);
      el.appendChild(d);
    }
  }
}

async function openFile(project, base, node) {
  if (state.dirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
  document.querySelectorAll(".file.active").forEach(n => n.classList.remove("active"));
  if (node) node.classList.add("active");
  state.project = project; state.base = base;
  state.doc = await (await fetch(`/api/projects/${project}/files/${base}`)).json();
  state.dirty = false;
  $("#current").textContent = `${project} / ${base}`;
  $("#save").disabled = false; $("#export").disabled = false;
  renderSegments();
  window.dispatchEvent(new CustomEvent("file-loaded"));  // Tasks 7/8 hängen sich hier ein
}

function fmt(t) {
  t = Math.max(0, t | 0); const m = (t / 60) | 0, s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderSegments() {
  const box = $("#segments"); box.innerHTML = "";
  state.doc.segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "seg"; row.dataset.i = i;
    const spk = document.createElement("input");
    spk.value = seg.speaker || ""; spk.placeholder = "Sprecher…";
    spk.oninput = () => { seg.speaker = spk.value; markDirty(); };
    const time = document.createElement("span");
    time.className = "time"; time.textContent = `[${fmt(seg.start)}]`;
    time.onclick = () => window.dispatchEvent(new CustomEvent("play-seg", { detail: i }));
    const flag = document.createElement("span");
    flag.className = "flag";
    flag.textContent = [seg.flags?.hallucination && "⚠", seg.flags?.silence && "🔇",
                        seg.flags?.low_conf && "~"].filter(Boolean).join(" ");
    const meta = document.createElement("div");
    meta.className = "meta"; meta.append(spk, document.createElement("br"), time, " ", flag);
    const text = document.createElement("div");
    text.className = "text"; text.contentEditable = "true"; text.textContent = seg.text;
    text.oninput = () => { seg.text = text.textContent; markDirty(); };
    row.append(meta, text); box.appendChild(row);
  });
}

function markDirty() { state.dirty = true; $("#status").textContent = "● ungespeichert"; }

async function save() {
  await fetch(`/api/projects/${state.project}/files/${state.base}`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.doc) });
  state.dirty = false; $("#status").textContent = "gespeichert";
}

async function exportMd() {
  const { md } = await (await fetch(
    `/api/projects/${state.project}/files/${state.base}/export`, { method: "POST" })).json();
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${state.base}.md`; a.click();
}

$("#save").onclick = save;
$("#export").onclick = exportMd;
window.addEventListener("beforeunload", e => { if (state.dirty) e.preventDefault(); });
loadProjects();
```

- [ ] **Step 5: `webtool.ps1` (Launcher) anlegen**

Create `webtool.ps1`:
```powershell
# Startet den Transkribor-Editor lokal und öffnet den Browser.
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
Start-Process "http://127.0.0.1:8000/"
& $py -m uvicorn webtool.app:app --host 127.0.0.1 --port 8000
```

- [ ] **Step 6: Server starten und manuell prüfen (Akzeptanz Stufe-1-Shell)**

Run (Hintergrund):
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m uvicorn webtool.app:app --port 8000
```
Dann `http://127.0.0.1:8000/` öffnen und prüfen:
- Projektliste zeigt `Foodfestival-Maienfeld` mit Dateien.
- Klick auf eine Datei rendert die Segmente; Sprecher-Feld + Text sind editierbar.
- „Speichern" schreibt `<base>.edit.json` + `<base>.md` in `transkripte\`; `<base>.json` bleibt unverändert.
- „Export .md" lädt die `.md` herunter.

Erwartet: alle vier Punkte erfüllt.

- [ ] **Step 7: Commit**

```
git add webtool/app.py webtool/static/index.html webtool/static/style.css webtool/static/app.js webtool.ps1
git commit -m "feat(webtool): Frontend-Shell (Navigation, Inline-Edit, Save, Export) + Launcher"
```

---

### Task 7: Audio-Wiedergabe — wavesurfer-Waveform, Klick→Play, Segment-Highlight

**Files:**
- Create: `webtool/static/vendor/wavesurfer.esm.js` (vendored)
- Modify: `webtool/static/app.js`

**Interfaces:**
- Consumes: `GET /api/projects/{p}/audio/{base}`, Events `file-loaded` und `play-seg` (aus Task 6).
- Produces: Waveform im `#player`, Klick auf Zeitmarke/Segment spielt `[start,end]`, aktives Segment bekommt `.active`.

- [ ] **Step 1: wavesurfer.js v7 lokal einbetten**

Run (lädt einmalig die ESM-Build-Datei in `vendor/`):
```
E:\Git\Transkribor\.venv\Scripts\python.exe -c "import urllib.request,os; os.makedirs('webtool/static/vendor',exist_ok=True); urllib.request.urlretrieve('https://unpkg.com/wavesurfer.js@7.12.8/dist/wavesurfer.esm.js','webtool/static/vendor/wavesurfer.esm.js'); print('ok', os.path.getsize('webtool/static/vendor/wavesurfer.esm.js'))"
```
Expected: `ok <größe>` (> 50000). Danach wird die Datei lokal ausgeliefert — kein CDN zur Laufzeit.

- [ ] **Step 2: `app.js` um Audio/Waveform erweitern**

Ergänze oben in `webtool/static/app.js` (nach der `$`-Zeile) den Import + Player-State:
```js
import WaveSurfer from "/vendor/wavesurfer.esm.js";
let ws = null, stopAt = null;
```

Ersetze den `file-loaded`-Dispatch-Kommentar in `openFile` durch echten Aufbau — füge ans Ende von `openFile` (vor der schließenden Klammer) hinzu:
```js
  setupPlayer();
```

Füge diese Funktionen ans Ende von `webtool/static/app.js` an:
```js
function setupPlayer() {
  if (ws) { ws.destroy(); ws = null; }
  $("#player").innerHTML = "";
  ws = WaveSurfer.create({
    container: "#player", height: 72, waveColor: "#b9c6d6", progressColor: "#4f7fbf",
    url: `/api/projects/${state.project}/audio/${state.base}`,
  });
  ws.on("timeupdate", (t) => {
    if (stopAt != null && t >= stopAt) { ws.pause(); stopAt = null; }
    highlightAt(t);
  });
}

function playSeg(i) {
  const seg = state.doc.segments[i];
  if (!ws) return;
  stopAt = seg.end;
  ws.setTime(seg.start);
  ws.play();
}

function highlightAt(t) {
  const segs = state.doc.segments;
  let idx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (t >= segs[i].start && t < segs[i].end) { idx = i; break; }
  }
  document.querySelectorAll(".seg.active").forEach(n => n.classList.remove("active"));
  if (idx >= 0) {
    const row = document.querySelector(`.seg[data-i="${idx}"]`);
    if (row) row.classList.add("active");
  }
}

window.addEventListener("play-seg", (e) => playSeg(e.detail));
```

(Zusätzlich: In `renderSegments` macht ein Klick auf die ganze Zeile das Segment abspielbar — ergänze in `renderSegments`, direkt nach `row.dataset.i = i;`:)
```js
    row.ondblclick = () => window.dispatchEvent(new CustomEvent("play-seg", { detail: i }));
```

- [ ] **Step 3: Manuell prüfen (Akzeptanz Audio)**

Server läuft (Task 6, Step 6). Seite neu laden, Datei öffnen:
- Waveform erscheint im Player-Bereich.
- Klick auf `[m:ss]` (oder Doppelklick auf ein Segment) spielt genau dieses Snippet und stoppt am Segmentende.
- Während der Wiedergabe wandert das `.active`-Highlight mit dem aktuellen Abschnitt.

Erwartet: alle drei Punkte erfüllt. (Falls Wort-Timing zu grob wirkt: laut Spec §11 akzeptiert; Segment-Ebene ist Ziel.)

- [ ] **Step 4: Commit**

```
git add webtool/static/vendor/wavesurfer.esm.js webtool/static/app.js
git commit -m "feat(webtool): Waveform + Klick-zum-Abspielen + Segment-Highlight (wavesurfer vendored)"
```

---

### Task 8: Unsicherheit sichtbar machen — 🔍 Roh-Wörter farbcodiert + Schwellen-Regler

**Files:**
- Modify: `webtool/static/app.js`
- Modify: `webtool/static/style.css`

**Interfaces:**
- Consumes: `seg.words[].probability` aus dem edit.json, Schwellen-Regler `#thrYellow`/`#thrRed` (aus Task 6 HTML).
- Produces: pro Segment ein 🔍-Toggle, der die Roh-Wörter mit prob-basierter Einfärbung ein-/ausblendet; Regler ändern die Färbung live.

- [ ] **Step 1: CSS für Wort-Färbung ergänzen**

Append an `webtool/static/style.css`:
```css
.seg .toggle { cursor: pointer; user-select: none; }
.raw-words { grid-column: 2; margin-top: 4px; font-size: 13px; color: #444; }
.raw-words.hidden { display: none; }
.w-yellow { background: #fff2b0; border-radius: 2px; }
.w-red { background: #ffc2c2; border-radius: 2px; }
```

- [ ] **Step 2: `app.js` — Regler-State + Wort-Rendering + Toggle**

Ergänze oben in `webtool/static/app.js` (bei den `state`-Feldern):
```js
const thr = { yellow: 0.6, red: 0.4 };
```

Füge nach den `$("#save").onclick…`-Zeilen (Ende der Datei-Verdrahtung) hinzu:
```js
function wireThresholds() {
  const y = $("#thrYellow"), r = $("#thrRed");
  const upd = () => {
    thr.yellow = +y.value; thr.red = +r.value;
    $("#thrYellowV").textContent = thr.yellow.toFixed(2);
    $("#thrRedV").textContent = thr.red.toFixed(2);
    document.querySelectorAll(".raw-words:not(.hidden)").forEach(el => paintWords(el));
  };
  y.oninput = upd; r.oninput = upd; upd();
}

function wordClass(w, isEdge) {
  const p = w.probability ?? 1;
  if (p < thr.red) return "w-red";
  if (!isEdge && p < thr.yellow) return "w-yellow";  // Randwort nur ab roter Schwelle färben
  return "";
}

function paintWords(el) {
  const seg = state.doc.segments[+el.dataset.i];
  el.innerHTML = "";
  const n = seg.words.length;
  seg.words.forEach((w, k) => {
    const span = document.createElement("span");
    const isEdge = (k === 0 || k === n - 1);
    span.className = wordClass(w, isEdge);
    span.textContent = w.word;
    el.appendChild(span);
  });
}

wireThresholds();
```

Ergänze in `renderSegments` (innerhalb der `forEach`, vor `box.appendChild(row)`), den Toggle + Container:
```js
    const toggle = document.createElement("span");
    toggle.className = "toggle"; toggle.textContent = "🔍"; toggle.title = "Roh-Wörter / Unsicherheit";
    flag.after(toggle);
    const raw = document.createElement("div");
    raw.className = "raw-words hidden"; raw.dataset.i = i;
    toggle.onclick = () => {
      raw.classList.toggle("hidden");
      if (!raw.classList.contains("hidden")) paintWords(raw);
    };
    row.append(raw);
```

- [ ] **Step 3: Manuell prüfen (Akzeptanz Unsicherheit)**

Seite neu laden, Datei öffnen (z. B. `C0687_01913077`, dessen erstes Wort `probability` 0.13 hat):
- 🔍 an einem Segment blendet die Roh-Wörter ein.
- Niedrig-prob-Wörter sind rot (`<0.4`) bzw. gelb (`<0.6`); das allererste Wort wird erst ab der roten Schwelle gefärbt.
- Regler „gelb<"/„rot<" verschieben → Färbung aktualisiert sich live.
- Segment-Flags (⚠/🔇/~) erscheinen an den entsprechenden Segmenten.

Erwartet: alle vier Punkte erfüllt.

- [ ] **Step 4: Commit**

```
git add webtool/static/app.js webtool/static/style.css
git commit -m "feat(webtool): Unsicherheit sichtbar (Roh-Wort-Färbung + Schwellen-Regler)"
```

---

### Task 9: Dokumentation aktualisieren

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:** keine (nur Doku).

- [ ] **Step 1: README ergänzen**

Füge in `README.md` nach dem Korrektur-Abschnitt einen neuen Abschnitt an:
```markdown
## Editieren im Browser (Web-Tool, Stufe 1)

Lokaler Editor zum abschnittweisen Prüfen/Korrigieren mit Klick-zum-Abspielen:

```powershell
.\webtool.ps1        # startet http://127.0.0.1:8000/ und öffnet den Browser
```

- Zeigt vorhandene Transkripte pro Projekt, spielt je Abschnitt das Audio-Snippet,
  hebt unsichere Wörter hervor (Whisper-`probability`, Schwellen verstellbar).
- Korrekturen werden **nicht-destruktiv** in `<base>.edit.json` gespeichert; die
  Roh-`<base>.json` bleibt unangetastet; `<base>.md` wird als Export daraus erzeugt.
```

- [ ] **Step 2: CLAUDE.md ergänzen**

Füge in `CLAUDE.md` unter „Umgebung (Fakten)" eine Zeile an:
```markdown
- Web-Editor (Stufe 1): `.\webtool.ps1` → FastAPI (`webtool/app.py`) + `webtool/static/`.
  Kanonisches Editier-Dokument `<base>.edit.json` (aus Roh-`<base>.json`), Export `<base>.md`.
  Spec: `docs/superpowers/specs/2026-07-06-transkribor-webtool-design.md`.
```

- [ ] **Step 3: Volle Testsuite als Schlusskontrolle**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q
```
Expected: PASS (alle Tests aus Tasks 1–5).

- [ ] **Step 4: Commit**

```
git add README.md CLAUDE.md
git commit -m "docs(webtool): Web-Editor Stufe 1 in README + CLAUDE.md"
```

---

## Self-Review

**1. Spec-Abdeckung** (Spec §§ → Tasks):
- §4.2/§4.3 edit.json-Modell + Aufbau aus Roh → Task 2 ✓
- §5.1 Endpoints (projects/file/audio/put/export) → Tasks 4–5 ✓; Upload/transcribe/correct/jobs sind **Stufe 2** (nicht in diesem Plan, korrekt) ✓
- §5.2 Frontend (Klick→Play ohne Lib, rAF/timeupdate-Highlight, wavesurfer vendored, contenteditable, Sprecher-Dropdown) → Tasks 6–7 ✓
- §6 Unsicherheit (Wort-Färbung + Regler, Randwort-Begnadigung, Segment-Flags; `avg_logprob` nicht allein) → Tasks 2 (Flags) + 8 (UI) ✓
- §7.1 .md-Render-Regel → Task 3 ✓
- §8 Layout (Sidebar, Toolbar, Segmentblöcke) → Task 6 ✓
- Nicht-destruktiv (§1/§4) → Task 5 Test `test_put_saves_non_destructive` ✓
- Trust-Boundary-Validierung (Global Constraints) → Task 1 `safe_name` + Nutzung in allen Endpoints ✓
- Diarization/1.5/2/3 → bewusst außerhalb dieses Plans (eigene Pläne) ✓

**2. Placeholder-Scan:** keine „TBD/TODO/handle edge cases"; alle Code-Schritte enthalten vollständigen Code; Test-Schritte enthalten echte Assertions. Ein Hinweis in Task 6 Step 3 stellt klar, dass `</style>` nicht in die CSS-Datei gehört. ✓

**3. Typ-/Namens-Konsistenz:** `build_edit_doc`, `compute_flags`, `render_md`, `load_or_build_doc`, `find_audio`, `_edit_path/_md_path/_raw_path`, Event-Namen `file-loaded`/`play-seg`, `state.doc.segments[].{start,end,speaker,text,words[].probability,flags}` — durchgängig gleich in Backend, Tests und Frontend. Endpoints in Tasks 4/5 stimmen mit `fetch`-Aufrufen in Tasks 6–8 überein. ✓

Gefundene Lücken: keine offenen. Stufe-2-Features sind absichtlich ausgeklammert und als solche markiert.
