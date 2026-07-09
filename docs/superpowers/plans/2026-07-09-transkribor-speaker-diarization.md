# Sprecher-Erkennung (Speaker Diarization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatische akustische Sprecher-Trennung (pyannote) als Prep-Schritt im
`correct`-Ablauf; die anonymen Cluster (`Sprecher 1/2/…`) werden von Claude benannt. Editierbar
über die bestehende Combobox — keine Frontend-Änderung.

**Architecture:** Hybrid. Ein neues `webtool/diarize.py` (pyannote lazy importiert) liefert
Sprecher-Turns; `assign_clusters` ordnet jedem Whisper-Segment per max. Überlappung ein
`Sprecher N`-Label zu. `cmd_diarize` schreibt best-effort ein `<base>.diar.json`-Sidecar;
`cmd_prep` webt das Cluster-Präfix in `<base>.tagged.txt`; der Korrektur-Prompt weist Claude an,
pro Cluster einen konsistenten Namen zu vergeben. Fehlt pyannote/HF_TOKEN → Sidecar fehlt →
Korrektur läuft wie heute (Text-Raten). Der `edit.json`/`md`-Vertrag und das Frontend bleiben
unverändert.

**Tech Stack:** Python 3.13, pyannote.audio 4.0.7 (Modell `speaker-diarization-community-1`),
torch 2.11+cu128 (vorhanden) + torchaudio + torchcodec, pytest.

## Global Constraints

- **Engine/Modell:** `pyannote.audio==4.0.7`, Modell `pyannote/speaker-diarization-community-1` (HF-gated).
- **HF-Token:** über Env `HF_TOKEN` (kein Committen). Fehlt er → best-effort-Skip.
- **Sprecheranzahl:** `min_speakers=2`, kein Max-Cap (Über-Segmentierung heilt der LLM, Unter-Segmentierung wird verhindert).
- **Cluster-Label:** `"Sprecher N"` (1-basig, nach erster zeitlicher Erscheinung des Clusters).
- **Aktivierung:** Default **an**; `TRANSKRIBOR_DIARIZE` ∈ {`0`,`false`,`no`} schaltet server-weit ab.
- **Sidecar:** `<base>.diar.json` unter `projekte/<NAME>/transkripte/` (git-ignoriert), idempotent (frischer als `<base>.json` → Skip).
- **Lazy-Import-Regel:** `webtool/diarize.py` importiert torch/pyannote/whisper NUR innerhalb von Funktionen — `import webtool.diarize` muss ohne installiertes pyannote gelingen (Tests + Fallback).
- **Audio-Laden (Windows-torchcodec-Bypass, im Spike bestätigt):** pyannotes eingebautes File-Decoding (torchcodec) lädt auf Windows NICHT (`libtorchcodec_core*.dll` fehlt/inkompatibel; nur eine Warnung beim Import, kein harter Fehler). Audio daher **in-memory** an die Pipeline geben: `whisper.load_audio(path)` (ffmpeg, 16 kHz mono float32) → `{"waveform": (1,time)-float32-Tensor, "sample_rate": 16000}`. ffmpeg via `_ensure_ffmpeg` (winget Gyan.FFmpeg, spiegelt `transcribe.ensure_ffmpeg`) auf PATH bringen. torchcodec bleibt installiert (pyannote-Hard-Dep), wird aber nicht zum Decoden benutzt.
- **Best-effort-Regel:** jeder pyannote-Fehler in `cmd_diarize` wird geloggt + übersprungen; er darf die Korrektur NIE abbrechen.
- **Frontend + `edit.json`/`md`-Schema:** unverändert.
- Trust-Boundary neuer Pfade weiterhin über `paths.safe_name` (schon in `main()` vorhanden).
- Commit-Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `feat/speaker-diarization` (existiert bereits, Spec liegt drauf).

---

### Task 1: De-Risk-Spike — pyannote auf dem Blackwell-Rechner zum Laufen bringen

**Ziel:** Vor jeglicher Verdrahtung beweisen, dass pyannote 4.0.7 auf dieser Maschine (RTX 5080,
torch 2.11+cu128, Py3.13) lädt, GPU nutzt und plausible Cluster liefert. **Kein Produktivcode** —
ein Wegwerf-Smoke im Scratchpad. Blockt Task 2–7, falls der Install scheitert (dann Fallback
sherpa-onnx, siehe Ende).

**Status (Controller, 2026-07-09):** Install ✅ (`torch 2.11.0+cu128`, cuda True — KEIN Downgrade;
`pyannote.audio 4.0.7` importiert). ⚠️ **torchcodec lädt auf Windows nicht** → In-Memory-Audio-Bypass
(siehe Global Constraints + Task 2 `_load_waveform`), im Spike bestätigt (whisper.load_audio → (1,time)
float32). **Offen: eigentlicher Modell-Run** (braucht `HF_TOKEN` — User) → wird beim E2E (Task 7)
mitverifiziert. Step 1/3/4 unten sind damit erledigt bzw. durch den In-Memory-Pfad ersetzt; nur
Step 2 (Token/Bedingungen) bleibt offen.

**Files:**
- Wegwerf: `%SCRATCHPAD%\diar_spike.py` (nicht committen)

- [ ] **Step 1: Abhängigkeiten ins `.venv` installieren**

```powershell
# torchaudio passend zu torch 2.11 (cu128) — torch 2.11 ist bereits installiert
E:\Git\Transkribor\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cu128 "torchaudio==2.11.*"
# torchcodec (ABI-Match zu torch 2.11) + pyannote
E:\Git\Transkribor\.venv\Scripts\python.exe -m pip install "torchcodec" "pyannote.audio==4.0.7"
```
Erwartung: Installation ohne Downgrade von `torch`. Prüfen:
```powershell
E:\Git\Transkribor\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```
Erwartet: `2.11...+cu128 True`. **Zeigt es `False` oder wurde torch downgraded → STOP, Fallback-Pfad (Ende) erwägen.**

- [ ] **Step 2: HF-Token setzen + Modellbedingungen akzeptieren**

Auf https://huggingface.co/pyannote/speaker-diarization-community-1 einloggen und die
User-Conditions akzeptieren. Dann Token (Read) erzeugen und in der Session setzen:
```powershell
$env:HF_TOKEN = "hf_..."
```

- [ ] **Step 3: Smoke-Skript schreiben** (`%SCRATCHPAD%\diar_spike.py`)

```python
import os, sys, time, torch
from pyannote.audio import Pipeline

audio = sys.argv[1]
t0 = time.time()
pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=os.environ["HF_TOKEN"])
print("pipeline geladen:", pipe is not None)
if torch.cuda.is_available():
    pipe.to(torch.device("cuda"))
dia = pipe(audio, min_speakers=2)
turns = [(round(t.start, 1), round(t.end, 1), spk) for t, _, spk in dia.itertracks(yield_label=True)]
print(f"{len(turns)} Turns, Cluster: {sorted(set(s for *_ , s in turns))}, {time.time()-t0:.0f}s")
for row in turns[:15]:
    print(row)
```

- [ ] **Step 4: Auf einer echten Aufnahme laufen lassen**

```powershell
E:\Git\Transkribor\.venv\Scripts\python.exe $env:TEMP\...\diar_spike.py "E:\Git\Transkribor\projekte\Foodfestival-Maienfeld\audio\<eine-datei>.<ext>"
```
Erwartet: `pipeline geladen: True`, ~2 Cluster (`SPEAKER_00`, `SPEAKER_01`), Turns mit
plausiblen Zeiten, Laufzeit im Minutenbereich (GPU). **Notiere die exakten API-Details, die
Task 2 braucht:** heisst der Kwarg wirklich `token=` (nicht `use_auth_token=`)? Stimmt der
Modellname? Liefert `itertracks(yield_label=True)` die drei Werte?

- [ ] **Step 5: Entscheidungs-Gate**

- Läuft es → weiter zu Task 2, `webtool/diarize.py` exakt an die in Step 4 bestätigte API anpassen.
- Scheitert der Install hartnäckig (torch-Downgrade, sm_120-CPU-Fallback, torchcodec unlösbar)
  → **Fallback sherpa-onnx** (siehe „Fallback-Pfad" am Ende): nur `diarize_file` in Task 2 tauscht
  die Interna; `assign_clusters`, Sidecar, prep-Injektion, Prompt, Guard (Task 3–7) bleiben 1:1.

- [ ] **Step 6: Kein Commit** (Wegwerf-Skript liegt im Scratchpad). Deps sind im `.venv` (git-ignoriert).

---

### Task 2: `webtool/diarize.py` — Turns + `assign_clusters` (TDD auf der reinen Zuordnung)

**Files:**
- Create: `webtool/diarize.py`
- Test: `webtool/test_diarize.py`

**Interfaces:**
- Produces:
  - `diarize_file(audio_path: str, min_speakers: int = 2) -> list[dict]` — Turns `[{"start": float, "end": float, "cluster": str}]`, zeitlich sortiert. Importiert pyannote/torch lazy INNEN.
  - `assign_clusters(raw: dict, turns: list) -> dict[int, str]` — `{seg_id: "Sprecher N"}`, rein (kein pyannote), unit-getestet.

- [ ] **Step 1: Failing tests schreiben** (`webtool/test_diarize.py`)

```python
from webtool import diarize     # muss OHNE installiertes pyannote importierbar sein (lazy imports)


def _raw(segs):
    return {"language": "de", "segments": [
        {"id": i, "start": s, "end": e, "text": "x", "words": []} for i, (s, e) in enumerate(segs)]}


def test_assign_two_speakers_by_max_overlap():
    raw = _raw([(0.0, 2.0), (2.0, 4.0)])
    turns = [{"start": 0.0, "end": 2.0, "cluster": "SPEAKER_00"},
             {"start": 2.0, "end": 4.0, "cluster": "SPEAKER_01"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1", 1: "Sprecher 2"}


def test_numbering_follows_first_appearance_not_raw_label():
    # SPEAKER_01 spricht zuerst -> muss "Sprecher 1" werden
    raw = _raw([(0.0, 1.0), (1.0, 2.0)])
    turns = [{"start": 0.0, "end": 1.0, "cluster": "SPEAKER_01"},
             {"start": 1.0, "end": 2.0, "cluster": "SPEAKER_00"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1", 1: "Sprecher 2"}


def test_segment_straddling_boundary_takes_bigger_overlap():
    # Segment 1.5–4.0: 0.5s bei SPEAKER_00, 2.0s bei SPEAKER_01 -> SPEAKER_01
    raw = _raw([(1.5, 4.0)])
    turns = [{"start": 0.0, "end": 2.0, "cluster": "SPEAKER_00"},
             {"start": 2.0, "end": 4.0, "cluster": "SPEAKER_01"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 2"}


def test_no_overlap_inherits_previous():
    raw = _raw([(0.0, 2.0), (10.0, 11.0)])       # zweites Segment ausserhalb aller Turns
    turns = [{"start": 0.0, "end": 2.0, "cluster": "SPEAKER_00"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1", 1: "Sprecher 1"}


def test_over_segmentation_yields_three_labels():
    raw = _raw([(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)])
    turns = [{"start": 0.0, "end": 1.0, "cluster": "A"},
             {"start": 1.0, "end": 2.0, "cluster": "B"},
             {"start": 2.0, "end": 3.0, "cluster": "C"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1", 1: "Sprecher 2", 2: "Sprecher 3"}
```

- [ ] **Step 2: Tests laufen — müssen fehlschlagen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_diarize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'webtool.diarize'`.

- [ ] **Step 3: `webtool/diarize.py` implementieren**

```python
"""Akustische Sprecher-Diarisierung (Stufe 3): Audio -> Sprecher-Cluster pro Zeitspanne.

pyannote.audio (community-1) liefert anonyme Cluster; die Zuordnung Segment->Cluster per
grösster zeitlicher Überlappung (`assign_clusters`) ist reines, unit-getestetes Python.
Die torch/pyannote-Importe liegen bewusst INNERHALB der Funktionen (lazy) — `import
webtool.diarize` bleibt leicht und ohne installiertes pyannote lauffähig (Best-effort-Fallback
im Aufrufer)."""
import os

DIAR_MODEL = "pyannote/speaker-diarization-community-1"
_PIPELINE = None


def _pipeline():
    """Lazy-Singleton der pyannote-Pipeline (Modell-Download beim 1. Aufruf; GPU falls vorhanden)."""
    global _PIPELINE
    if _PIPELINE is None:
        import torch
        from pyannote.audio import Pipeline
        token = os.environ.get("HF_TOKEN")
        if not token:
            raise RuntimeError("HF_TOKEN fehlt — pyannote-Modell ist gated (Token einmalig setzen)")
        pipe = Pipeline.from_pretrained(DIAR_MODEL, token=token)
        if pipe is None:
            raise RuntimeError(f"pyannote-Pipeline nicht geladen ({DIAR_MODEL}) — Modellbedingungen akzeptiert?")
        if torch.cuda.is_available():
            pipe.to(torch.device("cuda"))
        _PIPELINE = pipe
    return _PIPELINE


def _ensure_ffmpeg():
    """ffmpeg auf PATH sicherstellen (whisper.load_audio ruft es via subprocess).
    Bewusst dupliziert (mirror von transcribe.ensure_ffmpeg), um webtool nicht ans
    Root-Skript transcribe.py zu koppeln."""
    import glob
    from shutil import which
    if which("ffmpeg"):
        return
    for d in glob.glob(os.path.expandvars(
            r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg*\bin")):
        if os.path.exists(os.path.join(d, "ffmpeg.exe")):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return


def _load_waveform(audio_path: str) -> dict:
    """Audio -> {'waveform': (1,time) float32-Tensor, 'sample_rate': 16000} via
    whisper.load_audio (ffmpeg, 16 kHz mono). Umgeht das auf Windows kaputte
    torchcodec-Decoding von pyannote."""
    import torch
    import whisper
    _ensure_ffmpeg()
    samples = whisper.load_audio(audio_path)            # float32 numpy, 16 kHz mono
    return {"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": 16000}


def diarize_file(audio_path: str, min_speakers: int = 2) -> list:
    """Diarisiert eine Audiodatei -> [{'start','end','cluster'}] (zeitlich sortiert).
    'cluster' ist das rohe pyannote-Label (z.B. 'SPEAKER_00'). Audio wird in-memory
    geladen (torchcodec-Bypass, siehe _load_waveform)."""
    diarization = _pipeline()(_load_waveform(audio_path), min_speakers=min_speakers)
    turns = [{"start": float(t.start), "end": float(t.end), "cluster": spk}
             for t, _, spk in diarization.itertracks(yield_label=True)]
    turns.sort(key=lambda t: (t["start"], t["end"]))
    return turns


def assign_clusters(raw: dict, turns: list) -> dict:
    """Ordne jeder Roh-Segment-ID ein 'Sprecher N'-Label zu (N nach erster zeitlicher
    Erscheinung des Clusters). Zuordnung per grösster Gesamt-Überlappung; Segmente ohne
    Überlappung erben das vorige Label (bzw. den frühesten Cluster)."""
    order = {}                                   # cluster -> 1-basige Nummer nach erster Erscheinung
    for t in sorted(turns, key=lambda t: (t["start"], t["end"])):
        order.setdefault(t["cluster"], len(order) + 1)
    label = {c: f"Sprecher {n}" for c, n in order.items()}
    earliest = min(order, key=order.get) if order else None

    out, prev = {}, None
    for seg in raw.get("segments", []):
        s, e = seg.get("start"), seg.get("end")
        by_cluster = {}
        for t in turns:
            ov = max(0.0, min(e, t["end"]) - max(s, t["start"]))
            if ov > 0:
                by_cluster[t["cluster"]] = by_cluster.get(t["cluster"], 0.0) + ov
        if by_cluster:
            spk = label[max(by_cluster, key=by_cluster.get)]
        else:
            spk = prev if prev is not None else (label[earliest] if earliest else "Sprecher 1")
        out[seg.get("id")] = spk
        prev = spk
    return out
```

- [ ] **Step 4: Tests laufen — müssen bestehen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_diarize.py -v`
Expected: PASS (5 Tests).

- [ ] **Step 5: Commit**

```powershell
git add webtool/diarize.py webtool/test_diarize.py
git commit -m @'
feat(diarize): pyannote-Diarisierung + Cluster-Zuordnung (Stufe 3)

diarize_file (pyannote lazy) + assign_clusters (rein, max-Overlap,
Sprecher-N nach erster Erscheinung). assign_clusters unit-getestet.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 3: `cmd_diarize` + Sidecar-Schreiben in `webtool/correct.py`

**Files:**
- Modify: `webtool/correct.py` (`_audio_name` refactoren + `_audio_path`, `_diarize_enabled`, `cmd_diarize` NEU)
- Test: `webtool/test_correct.py` (neue Tests)

**Interfaces:**
- Consumes: `diarize.diarize_file`, `diarize.assign_clusters` (Task 2).
- Produces: `cmd_diarize(project: str) -> int` schreibt `<base>.diar.json`
  `{base, audio, min_speakers, turns[], segments:[{id, speaker}]}`; best-effort, idempotent.

- [ ] **Step 1: Failing tests schreiben** (an `webtool/test_correct.py` anhängen)

```python
# ---- Stufe 3: Diarisierung (pyannote gefälscht über webtool.diarize.diarize_file) ----

def _fake_turns(prompt=None):
    # zwei Sprecher, passend zum project-Fixture (S1.json hat 1 Segment 0.0–1.0)
    return [{"start": 0.0, "end": 1.0, "cluster": "SPEAKER_00"}]


def test_cmd_diarize_writes_sidecar(project, monkeypatch):
    _root, t = project
    import webtool.diarize as diar
    monkeypatch.setattr(diar, "diarize_file", lambda audio, min_speakers=2: _fake_turns())
    assert correct.cmd_diarize("Demo") == 1
    side = json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))
    assert side["segments"] == [{"id": 0, "speaker": "Sprecher 1"}]
    assert side["turns"] and side["audio"] == "S1.mp3"


def test_cmd_diarize_disabled_by_env(project, monkeypatch):
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "0")
    import webtool.diarize as diar
    called = {"n": 0}
    monkeypatch.setattr(diar, "diarize_file", lambda *a, **k: called.__setitem__("n", called["n"] + 1) or [])
    assert correct.cmd_diarize("Demo") == 0
    assert called["n"] == 0 and not (t / "S1.diar.json").exists()


def test_cmd_diarize_best_effort_on_error(project, monkeypatch):
    _root, t = project
    import webtool.diarize as diar
    def boom(*a, **k):
        raise RuntimeError("pyannote kaputt")
    monkeypatch.setattr(diar, "diarize_file", boom)
    assert correct.cmd_diarize("Demo") == 0            # Fehler geschluckt, kein Crash
    assert not (t / "S1.diar.json").exists()


def test_cmd_diarize_idempotent_skip(project, monkeypatch):
    _root, t = project
    # frisches Sidecar (neuer als S1.json) -> diarize_file darf nicht laufen
    (t / "S1.diar.json").write_text(json.dumps({"segments": [{"id": 0, "speaker": "Sprecher 1"}]}), encoding="utf-8")
    j_mtime = (t / "S1.json").stat().st_mtime
    os.utime(t / "S1.diar.json", (j_mtime + 10, j_mtime + 10))
    import webtool.diarize as diar
    called = {"n": 0}
    monkeypatch.setattr(diar, "diarize_file", lambda *a, **k: called.__setitem__("n", called["n"] + 1) or [])
    assert correct.cmd_diarize("Demo") == 0
    assert called["n"] == 0
```

- [ ] **Step 2: Tests laufen — müssen fehlschlagen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -k diarize -v`
Expected: FAIL — `AttributeError: module 'webtool.correct' has no attribute 'cmd_diarize'`.

- [ ] **Step 3: `webtool/correct.py` erweitern** — `_audio_name` refactoren + neue Funktionen einfügen

`_audio_name` (Zeilen 40–46) durch `_audio_path` + dünnes `_audio_name` ersetzen:

```python
def _audio_path(project: str, base: str) -> str:
    adir = paths.audio_dir(project)
    for ext in AUDIO_EXT:
        cand = os.path.join(adir, base + ext)
        if os.path.exists(cand):
            return cand
    return ""


def _audio_name(project: str, base: str) -> str:
    p = _audio_path(project, base)
    return os.path.basename(p) if p else ""
```

Direkt nach `cmd_prep` (vor `cmd_apply`) einfügen:

```python
def _diarize_enabled() -> bool:
    return os.environ.get("TRANSKRIBOR_DIARIZE", "1").strip().lower() not in ("0", "false", "no")


def cmd_diarize(project: str) -> int:
    """Akustische Diarisierung je Datei -> <base>.diar.json (best-effort, idempotent).
    Fehlt pyannote/HF_TOKEN oder scheitert die Diarisierung, wird die Datei übersprungen
    (kein Sidecar) — die Korrektur läuft dann ohne Cluster (Text-Raten wie bisher)."""
    if not _diarize_enabled():
        print("↷ Diarisierung deaktiviert (TRANSKRIBOR_DIARIZE=0)", flush=True)
        return 0
    tdir = paths.transkripte_dir(project)
    n = 0
    for base in bases(project):
        dpath = os.path.join(tdir, base + ".diar.json")
        raw_json = os.path.join(tdir, base + ".json")
        try:
            if os.path.exists(dpath) and os.path.getmtime(dpath) >= os.path.getmtime(raw_json):
                print(f"↷ nutze vorhandene {base}.diar.json", flush=True)
                continue
            audio = _audio_path(project, base)
            if not audio:
                print(f"diarize: SKIP {base} (kein Audio gefunden)", flush=True)
                continue
            from . import diarize                       # lazy: zieht torch/pyannote erst hier
            raw = _load(raw_json)
            print(f"→ Diarisiere {base} …", flush=True)
            turns = diarize.diarize_file(audio)
            if not turns:
                print(f"diarize: SKIP {base} (keine Sprecher erkannt)", flush=True)
                continue
            seg_speakers = diarize.assign_clusters(raw, turns)
            doc = {"base": base, "audio": os.path.basename(audio), "min_speakers": 2,
                   "turns": turns,
                   "segments": [{"id": sid, "speaker": spk} for sid, spk in seg_speakers.items()]}
            paths.atomic_write(dpath, json.dumps(doc, ensure_ascii=False, indent=1))
            n += 1
        except (OSError, json.JSONDecodeError) as e:
            print(f"diarize: SKIP {base} (Roh-JSON unlesbar: {e})", flush=True)
        except Exception as e:                          # pyannote/Token/GPU-Fehler dürfen NIE den Lauf killen
            print(f"diarize: SKIP {base} ({type(e).__name__}: {e}) — Korrektur ohne Cluster", flush=True)
    print(f"diarize: {n} Datei(en) diarisiert", flush=True)
    return n
```

- [ ] **Step 4: Tests laufen — müssen bestehen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -k diarize -v`
Expected: PASS (4 Tests).

- [ ] **Step 5: Commit**

```powershell
git add webtool/correct.py webtool/test_correct.py
git commit -m @'
feat(correct): cmd_diarize schreibt <base>.diar.json (best-effort, idempotent)

pyannote lazy via webtool.diarize; TRANSKRIBOR_DIARIZE-Toggle; Fehler
werden geschluckt (Korrektur laeuft ohne Cluster weiter). _audio_path
refactoring (Vollpfad fuer die Audiodatei).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 4: `cmd_prep` webt das Cluster-Präfix in `tagged.txt`

**Files:**
- Modify: `webtool/correct.py` (`_load_diar_clusters` NEU, `cmd_prep` Zeilen 54–67)
- Test: `webtool/test_correct.py`

**Interfaces:**
- Consumes: `<base>.diar.json` (Task 3).
- Produces: `tagged.txt`-Zeilen `[<id>] (Sprecher N) <text>` wenn diarisiert, sonst `[<id>] <text>`.

- [ ] **Step 1: Failing tests schreiben** (an `webtool/test_correct.py` anhängen)

```python
def test_prep_injects_cluster_prefix(project):
    _root, t = project
    (t / "S1.diar.json").write_text(json.dumps(
        {"base": "S1", "segments": [{"id": 0, "speaker": "Sprecher 2"}]}), encoding="utf-8")
    assert correct.cmd_prep("Demo") == 1
    tagged = (t / "S1.tagged.txt").read_text(encoding="utf-8")
    assert tagged.startswith("[0] (Sprecher 2) ")
    assert "[[Mathias|0.30]]" in tagged                # Unsicherheits-Tagging bleibt erhalten


def test_prep_without_diar_has_no_prefix(project):
    _root, t = project
    assert correct.cmd_prep("Demo") == 1
    tagged = (t / "S1.tagged.txt").read_text(encoding="utf-8")
    assert tagged.startswith("[0] ")
    assert "(Sprecher" not in tagged                   # kein Sidecar -> kein Präfix (Fallback)
```

- [ ] **Step 2: Tests laufen — müssen fehlschlagen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -k "prep_injects or prep_without_diar" -v`
Expected: FAIL — `test_prep_injects_cluster_prefix` (tagged startet mit `[0] ` ohne Präfix).

- [ ] **Step 3: `webtool/correct.py` anpassen**

`_load_diar_clusters` direkt vor `cmd_prep` einfügen:

```python
def _load_diar_clusters(tdir: str, base: str) -> dict:
    """{seg_id: 'Sprecher N'} aus <base>.diar.json, oder {} wenn keins/ungültig."""
    try:
        segs = _load(os.path.join(tdir, base + ".diar.json")).get("segments") or []
    except (OSError, json.JSONDecodeError):
        return {}
    return {s.get("id"): s.get("speaker") for s in segs if s.get("speaker")}
```

`cmd_prep` (Zeilen 54–67) ersetzen — die tagged-Zeile bekommt das Cluster-Präfix:

```python
def cmd_prep(project: str) -> int:
    tdir = paths.transkripte_dir(project)
    n = 0
    for base in bases(project):
        try:  # eine kaputte/gesperrte Roh-JSON darf den Batch nicht stoppen
            raw = _load(os.path.join(tdir, base + ".json"))
            segs = tag_uncertain_segments(raw)
            clusters = _load_diar_clusters(tdir, base)      # {} wenn nicht diarisiert
            lines = []
            for s in segs:
                spk = clusters.get(s["id"])
                prefix = f"({spk}) " if spk else ""
                lines.append(f"[{s['id']}] {prefix}{s['tagged_text']}")
            paths.atomic_write(os.path.join(tdir, base + ".tagged.txt"), "\n".join(lines) + "\n")
            n += 1
        except (OSError, json.JSONDecodeError) as e:
            print(f"prep: SKIP {base} (Roh-JSON unlesbar: {e})", flush=True)
    print(f"prep: {n} Datei(en) getaggt in {tdir}")
    return n
```

- [ ] **Step 4: Tests laufen — neue + bestehende prep-Tests müssen bestehen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -k prep -v`
Expected: PASS (inkl. bestehendem `test_prep_writes_tagged`).

- [ ] **Step 5: Commit**

```powershell
git add webtool/correct.py webtool/test_correct.py
git commit -m @'
feat(correct): cmd_prep webt (Sprecher N)-Cluster-Praefix in tagged.txt

Aus <base>.diar.json; ohne Sidecar unveraendert (Fallback). Unsicherheits-
Tagging bleibt erhalten.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 5: `cmd_run` diarisiert vor prep + Prompt-Instruktionen für Cluster-Benennung

**Files:**
- Modify: `webtool/correct.py` (`cmd_run` Zeile ~286; `_correct_prompt` Zeilen 187–197; `_verify_prompt` Zeilen 219–228)
- Test: `webtool/test_correct.py`

**Interfaces:**
- Consumes: `cmd_diarize` (Task 3), cluster-fähiges `cmd_prep` (Task 4).
- Produces: end-to-end Cluster-Fluss ins `tagged.txt`; Prompt-Text weist Claude an, pro Cluster einen konsistenten Namen zu vergeben.

- [ ] **Step 1: Failing test schreiben** (an `webtool/test_correct.py` anhängen)

```python
def test_run_diarizes_before_prep_and_injects(project, monkeypatch):
    _root, t = project
    import webtool.diarize as diar
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2: [{"start": 0.0, "end": 1.0, "cluster": "SPEAKER_00"}])
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    assert (t / "S1.diar.json").exists()                        # diarisiert
    assert (t / "S1.tagged.txt").read_text(encoding="utf-8").startswith("[0] (Sprecher 1) ")  # Präfix im Prep
    assert any("(Sprecher N)" in c and ".tagged.txt" in c for c in calls)  # Korrektur-Prompt erklärt das Präfix
```

- [ ] **Step 2: Test laufen — muss fehlschlagen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py::test_run_diarizes_before_prep_and_injects -v`
Expected: FAIL — kein `S1.diar.json` (cmd_run ruft cmd_diarize noch nicht) / Präfix fehlt.

- [ ] **Step 3a: `cmd_run` — Diarisierung vor prep einhängen**

In `cmd_run` die Zeile `cmd_prep(project)` (Zeile 286) ersetzen durch:

```python
    cmd_diarize(project)                               # -> <base>.diar.json (best-effort, GPU)
    cmd_prep(project)                                  # -> <base>.tagged.txt (Cluster-Präfix falls diarisiert)
```

- [ ] **Step 3b: `_correct_prompt` — Zeilenformat + Sprecher-Regel**

In `_correct_prompt` die Read-Formatzeile (Zeile 189) ersetzen:

```python
   Jede Zeile: "[<id>] (Sprecher N) <text>" — das Präfix (Sprecher N) ist die AKUSTISCH erkannte Sprecher-Gruppe (Diarisierung); fehlt es, gibt es keine akustische Info. Unsichere Wörter sind inline als [[Wort|Wahrscheinlichkeit]] markiert (niedrige Whisper-Konfidenz) — dort besonders genau hinsehen.
```

und Punkt 4 (Zeile 196) ersetzen:

```python
4) SPRECHER: Das akustische (Sprecher N)-Präfix ist die WAHRHEIT, WER spricht — vergib pro Cluster GENAU EINEN konsistenten Namen: meist „Interviewer" (stellt Fragen) und die befragte Person (Name/Betrieb falls genannt, sonst „Befragte Person"). Du DARFST zwei Cluster demselben Namen zuordnen, wenn klar dieselbe Person. Eine Cluster-Grenze nur überschreiben, wenn sie offensichtlich falsch ist (z.B. ein einzelnes Rückkanal-Wort). Fehlt das Präfix, ordne nach Inhalt zu (wie bisher). Gib JEDEM Segment einen Sprecher.
```

- [ ] **Step 3c: `_verify_prompt` — Zeilenformat + Cluster-Konsistenz**

In `_verify_prompt` die Read-Formatzeile (Zeile 221) ersetzen:

```python
   Jede Zeile: "[<id>] (Sprecher N) <text>" — das (Sprecher N)-Präfix ist die akustische Sprecher-Gruppe (falls vorhanden); unsichere Wörter inline als [[Wort|Wahrscheinlichkeit]] markiert.
```

und die SPRECHER-Prüfzeile (Zeile 228) ersetzen:

```python
- SPRECHER: konsistent pro akustischem (Sprecher N)-Cluster und plausibel (Interviewer stellt Fragen; Antworten korrekt zugeordnet)? Fehlzuordnungen korrigieren.
```

- [ ] **Step 4: Neuer Test + GESAMTE correct-Suite müssen bestehen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -v`
Expected: PASS — der neue Test grün UND alle bestehenden (inkl. `test_run_full_flow`: Diarisierung
no-op't ohne pyannote → `len(calls) == 3` unverändert).

- [ ] **Step 5: Commit**

```powershell
git add webtool/correct.py webtool/test_correct.py
git commit -m @'
feat(correct): cmd_run diarisiert vor prep; Prompt benennt Cluster

cmd_diarize laeuft vor cmd_prep; Korrektur-/Verify-Prompt erklaeren das
(Sprecher N)-Praefix und lassen pro Cluster genau einen Namen vergeben.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 6: GPU-Guard in `webtool/jobs.py` auf `correct` ausweiten

**Files:**
- Modify: `webtool/jobs.py` (`start`, Zeilen 33–37)
- Test: `webtool/test_jobs.py`

**Interfaces:**
- Produces: nur EIN GPU-Job (`transcribe` ODER `correct`) zugleich; Cross-Projekt.

- [ ] **Step 1: Failing tests schreiben** (an `webtool/test_jobs.py` anhängen)

```python
def test_correct_blocks_transcribe():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jidC, sC = jobs.start("ProjC", slow, cwd=None, kind="correct")
    jidT, sT = jobs.start("ProjD", slow, cwd=None, kind="transcribe")
    assert sC is True and sT is False and jidT == jidC   # transcribe wartet auf laufende correct-GPU
    _wait(jidC)


def test_transcribe_blocks_correct():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jidT, sT = jobs.start("ProjE", slow, cwd=None, kind="transcribe")
    jidC, sC = jobs.start("ProjF", slow, cwd=None, kind="correct")
    assert sT is True and sC is False and jidC == jidT
    _wait(jidT)
```

- [ ] **Step 2: Tests laufen — müssen fehlschlagen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_jobs.py -k "blocks" -v`
Expected: FAIL — beide gestartet (`sT`/`sC` True), weil `correct` heute nicht GPU-serialisiert ist.

- [ ] **Step 3: `webtool/jobs.py` anpassen** — Modul-Konstante + Guard verallgemeinern

Nach den Modul-Globals (nach Zeile 17, `_PRUNE_AGE`) einfügen:

```python
# ponytail: beide Kinds belegen die eine GPU (correct diarisiert via pyannote) -> serialisieren.
# Grob: serialisiert auch ein correct OHNE Diarisierung; fuer ein Ein-Nutzer-Tool ok.
GPU_KINDS = ("transcribe", "correct")
```

Den `transcribe`-Block (Zeilen 33–37) ersetzen:

```python
        if kind in GPU_KINDS:
            running_gpu = [jid for jid, r in _jobs.items()
                           if r["kind"] in GPU_KINDS and r["status"] == "running"]
            if running_gpu:
                return running_gpu[0], False  # Einzel-GPU: nur ein GPU-Job (transcribe|correct) zugleich
```

- [ ] **Step 4: Tests laufen — neue + bestehende jobs-Tests müssen bestehen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_jobs.py -v`
Expected: PASS (inkl. `test_only_one_transcribe_at_a_time`, `test_dedupe_same_project`).

- [ ] **Step 5: Commit**

```powershell
git add webtool/jobs.py webtool/test_jobs.py
git commit -m @'
feat(jobs): GPU-Guard auf correct ausweiten (Diarisierung nutzt GPU)

Nur ein GPU-Job (transcribe|correct) zugleich, cross-Projekt — verhindert
konkurrierende GPU-Last (Whisper vs. pyannote).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 7: Doku (CLAUDE.md) + End-to-End-Verifikation auf echtem Projekt

**Files:**
- Modify: `CLAUDE.md` (Abschnitt „Umgebung (Fakten)")

- [ ] **Step 1: Volle Test-Suite grün**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -v`
Expected: PASS (alle bestehenden + neuen; keine Regression).

- [ ] **Step 2: `CLAUDE.md` — Env-Overrides + Stufe-3-Zeile ergänzen**

In der Zeile der Env-Overrides `HF_TOKEN` und `TRANSKRIBOR_DIARIZE` ergänzen, z.B.:

```markdown
- Env-Overrides: `WHISPER_MODEL` (default large-v3), `WHISPER_LANG` (default de), `TRANSKRIBOR_VERIFY` (default 1; …), `TRANSKRIBOR_DIARIZE` (default 1; `0`/`false`/`no` schaltet die akustische Sprecher-Diarisierung server-weit ab), `HF_TOKEN` (für pyannote-Diarisierung, gated-Modell).
```

Unter „Umgebung (Fakten)" eine Stufe-3-Zeile ergänzen:

```markdown
- Stufe 3 (Sprecher-Diarisierung): `webtool/diarize.py` (pyannote.audio 4.0.7, Modell `speaker-diarization-community-1`, GPU) läuft als **Prep-Schritt im `correct run`** (vor `prep`), schreibt best-effort `<base>.diar.json` (Turns + `{id, "Sprecher N"}` je Segment, idempotent). `cmd_prep` webt das `(Sprecher N)`-Präfix in `<base>.tagged.txt`; der Korrektur-Prompt lässt Claude pro Cluster einen konsistenten Namen vergeben (Hybrid: Akustik trennt, LLM benennt). Fehlt pyannote/`HF_TOKEN` oder scheitert die GPU → kein Sidecar → Korrektur wie bisher (Text-Raten). Modell-Cache `~/.cache/huggingface`. `jobs.py` serialisiert `transcribe`+`correct` auf der einen GPU.
```

- [ ] **Step 3: End-to-End-Smoke auf echtem Projekt** (Skill `verify`)

`HF_TOKEN` gesetzt, dann auf einem echten Projekt (nur nicht-`projekte/`-Code ist committet —
die Interviewdaten bleiben lokal):
```powershell
$env:HF_TOKEN = "hf_..."
E:\Git\Transkribor\.venv\Scripts\python.exe -m webtool.correct run "Foodfestival-Maienfeld"
```
Prüfen: `<base>.diar.json` entstanden (Turns + Segmente), `<base>.tagged.txt` enthält
`(Sprecher N)`-Präfixe, `<base>.edit.json`/`.md` haben benannte Sprecher (Interviewer +
befragte Person). Im Web-Editor (`.\webtool.ps1`) die Sprecher-Redebeiträge + Combobox
gegenchecken.

- [ ] **Step 4: Commit + PR**

```powershell
git add CLAUDE.md
git commit -m @'
docs(claude): Stufe 3 Diarisierung + HF_TOKEN/TRANSKRIBOR_DIARIZE

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```
Dann PR gegen `master` (Standard-Flow aus CLAUDE.md): `gh pr create --base master`,
CI/Mergeability prüfen, Rebase-Merge, `master` per Fast-Forward nachziehen.

---

## Self-Review (gegen die Spec)

- **§2 Hybrid** → Task 2 (`diarize_file`+`assign_clusters`), Task 5 (Prompt benennt Cluster). ✓
- **§2 Prep-Slot** → Task 3 (`cmd_diarize`), Task 5 (in `cmd_run` vor `prep`). ✓
- **§2 min_speakers=2** → Global Constraints + `cmd_diarize` (default) / `diarize_file`. ✓
- **§2 pyannote 4.0.7 community-1** → Task 1 Install, Task 2 `DIAR_MODEL`. ✓
- **§2 Frontend unverändert** → keine Frontend-Datei im Plan. ✓
- **§2 TRANSKRIBOR_DIARIZE default-an** → Task 3 `_diarize_enabled`, Task 7 Doku. ✓
- **§4.1 Sidecar-Schema** → Task 3 `doc = {...}` mit `turns`+`segments[{id,speaker}]`. ✓
- **§4.2 Prompt-Kleber** → Task 5 Steps 3b/3c. ✓
- **§4.1 Idempotenz** → Task 3 mtime-Skip + Test `test_cmd_diarize_idempotent_skip`. ✓
- **§5 apply/edit/md/Frontend unverändert** → nicht angefasst; `test_run_full_flow` bleibt grün. ✓
- **§6 Fallback/Best-effort** → Task 3 try/except + Tests; Task 4 „ohne Sidecar unverändert". ✓
- **§6 GPU-Exklusivität** → Task 6. ✓
- **§7 Deps/HF_TOKEN/Cache** → Task 1, Task 7 Doku. ✓
- **§8 Tests** (assign_clusters, Fallback) → Task 2 + Task 4 `test_prep_without_diar_has_no_prefix`. ✓
- **§9 Spike zuerst** → Task 1. ✓

**Typ-Konsistenz:** `diarize_file(audio_path, min_speakers=2)`, `assign_clusters(raw, turns)`,
Sidecar-`segments`=`[{id, speaker}]`, `_load_diar_clusters -> {id: speaker}`, `_audio_path` →
Vollpfad — über Task 2–5 durchgängig. ✓

## Fallback-Pfad (falls Task-1-Spike pyannote nicht zum Laufen bringt)

Auf **sherpa-onnx** wechseln — nur `diarize_file` (Task 2, Step 3) tauscht die Interna:
`pip install sherpa-onnx`, Segmentierungs-/Embedding-Modelle aus den k2-fsa GitHub-Releases
(ungated, kein HF-Token), `sherpa_onnx.OfflineSpeakerDiarization(...)` mit
`FastClusteringConfig(min_num_clusters=2)`; `.process(samples).sort_by_start_time()` liefert
`{speaker:int, start, end}` → auf `{"start","end","cluster"}` mappen. `assign_clusters`, Sidecar,
prep-Injektion, Prompt und GPU-Guard bleiben **unverändert** (das Design ist engine-agnostisch;
`HF_TOKEN`/`TRANSKRIBOR_DIARIZE`-Doku dann anpassen: Token entfällt).
