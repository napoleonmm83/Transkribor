# Transkribor Web-Tool — Stufe 1.5 (LLM-Seed: segment-ausgerichtete Korrektur) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der LLM-Korrekturschritt wird segment-ausgerichtet und befüllt `<base>.edit.json` vor (korrigierter Text + Sprecher pro Segment), damit der Editor aus Stufe 1 die Datei bereits korrigiert öffnet — statt beim Rohtext zu starten.

**Architecture:** Aufteilung in deterministisches Python und den bestehenden Claude-Workflow. Python (`webtool/correct.py` + neue Funktionen in `edit_model.py`) übernimmt (a) das Vor-Taggen unsicherer Wörter für den LLM und (b) das Zusammenbauen von `edit.json` + `.md` aus einer strukturierten Korrektur. Der Workflow `tools/correct_label.mjs` macht nur noch die eigentliche Sprachkorrektur und liefert pro Datei ein strukturiertes `{context, speakers, segments:[{id,speaker,text}], annotations}` zurück. Ablauf: `correct prep` → Workflow → `correct apply`. Kein API-Key (Korrektur läuft weiter über Claude Code / den Workflow).

**Tech Stack:** Python 3.13 (stdlib: argparse/glob/json/os), pytest; bestehende Stufe-1-Module (`edit_model`, `render_md`, `paths`); Workflow-Orchestrierung (`tools/correct_label.mjs`).

## Global Constraints

- venv: `E:\Git\Transkribor\.venv`; Python immer als `.venv\Scripts\python.exe`. Windows/PowerShell. Bash-Tool für git.
- **Nicht-destruktiv bleibt:** Roh-`<base>.json` wird NIE geschrieben. `correct apply` schreibt nur `<base>.edit.json` (+ gerenderte `<base>.md`) und respektiert `human_edited` (siehe unten).
- **Mensch hat letztes Wort:** `correct apply` überschreibt eine vorhandene `<base>.edit.json` mit `human_edited=true` NICHT (nur mit `--force`). Neu erzeugte edit.json haben `human_edited=false`.
- **Schreibvorgänge atomar** (`tmp` + `os.replace`) — kein halb-geschriebenes edit.json/md.
- **Treu bleiben** (Korrektur-Regeln aus `CLAUDE.md`): klare ASR-Fehler korrigieren, zu Standarddeutsch normalisieren (Schweizer „ss"), nichts erfinden, Sinn nicht verändern, Unsicheres offenlegen (in `annotations`).
- **Segmentgrenzen erhalten:** Die Korrektur liefert genau einen Eintrag pro Roh-Segment-ID; Segmente werden NICHT zusammengefasst (die Redebeitrags-Bündelung macht erst `render_md` beim Export).
- Keine neuen Python-Abhängigkeiten. Kein API-Key. ASR-Stack unverändert.
- Zwischenartefakte (`<base>.tagged.txt`, `<base>.correction.json`) liegen in `projekte/<P>/transkripte/` und sind über `projekte/` git-ignoriert.
- Commit-Trailer an jede Commit-Message: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Design-Entscheidungen (Kontext für alle Tasks)

1. **Datenfluss:**
   `correct prep <P>` liest jede `<base>.json` → schreibt `<base>.tagged.txt` (Segmente mit Segment-ID; Wörter mit `probability < 0.5` inline als `[[Wort|0.31]]` markiert).
   → Workflow `correct_label.mjs` liest die `tagged.txt`, korrigiert segment-genau, liefert pro Datei `{base, context, speakers, segments:[{id,speaker,text}], annotations}`.
   → Controller schreibt je Datei `<base>.correction.json` und ruft `correct apply <P> <base>` → baut `edit.json` (Timing/Wörter/Flags aus Roh, Text/Sprecher aus Korrektur) + rendert `.md`.
2. **Warum die Aufteilung:** Das Vor-Taggen und das Zusammenbauen sind deterministisch und testbar (Python). Nur die Sprachkorrektur braucht das LLM (Workflow, kein API-Key). Der Workflow bleibt „pur" (liefert Daten), alle Datei-Schreibvorgänge macht deterministisches Python.
3. **Bestehendes bleibt kompatibel:** `edit.json`-Schema unverändert (Stufe 1). `render_md` unverändert. Der Editor (Stufe 1) öffnet die vorbefüllte `edit.json` ohne Änderung.

## Dateistruktur

```
webtool/
  edit_model.py     # + tag_uncertain_segments(), apply_correction()  (bestehende Funktionen unberührt)
  paths.py          # + atomic_write()  (aus app.py hochgezogen, DRY)
  app.py            # nutzt jetzt paths.atomic_write (statt lokalem _atomic_write)
  correct.py        # NEU: CLI  `prep <project>` und `apply <project> <base> [--force]`
  test_edit_model.py# + Tests für tag_uncertain_segments / apply_correction
  test_paths.py     # + Test für atomic_write
  test_correct.py   # NEU: Tests für prep/apply (inkl. human_edited-Schutz)
tools/
  correct_label.mjs # NEU geschrieben: segment-ausgerichtete Korrektur -> strukturierte Korrektur je Datei
CLAUDE.md            # neuer Korrektur-Ablauf (prep -> Workflow -> apply)
```

---

### Task 1: `tag_uncertain_segments` — unsichere Wörter für den LLM inline taggen

**Files:**
- Modify: `webtool/edit_model.py`
- Test: `webtool/test_edit_model.py`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - Konstante `UNCERTAIN_TAG_THRESHOLD = 0.5`.
  - `tag_uncertain_segments(raw: dict, threshold: float = UNCERTAIN_TAG_THRESHOLD) -> list[dict]` → je Roh-Segment `{"id","start","end","tagged_text"}`; Wörter mit `probability < threshold` als `[[Wort|0.pp]]` markiert (führende Leerzeichen erhalten), sonst unverändert; Segment ohne `words` → `tagged_text` = gestrippter Segmenttext.

- [ ] **Step 1: Failing test schreiben**

Append to `webtool/test_edit_model.py`:
```python
def test_tag_uncertain_segments_wraps_low_prob():
    raw = {"segments": [
        {"id": 0, "start": 0.0, "end": 2.0, "text": " Ich fahre nach Chur.",
         "words": [
             {"word": " Ich", "start": 0.0, "end": 0.3, "probability": 0.95},
             {"word": " fahre", "start": 0.3, "end": 0.6, "probability": 0.9},
             {"word": " nach", "start": 0.6, "end": 0.8, "probability": 0.8},
             {"word": " Chur", "start": 0.8, "end": 1.2, "probability": 0.31},
         ]},
    ]}
    segs = em.tag_uncertain_segments(raw)
    assert len(segs) == 1
    s = segs[0]
    assert s["id"] == 0 and s["start"] == 0.0 and s["end"] == 2.0
    # niedrig-prob-Wort markiert, führendes Leerzeichen bleibt vor der Markierung
    assert " [[Chur|0.31]]" in s["tagged_text"]
    # sichere Wörter unverändert
    assert "Ich fahre nach" in s["tagged_text"]
    assert "[[Ich" not in s["tagged_text"] and "[[fahre" not in s["tagged_text"]


def test_tag_uncertain_segments_threshold_and_no_words():
    raw = {"segments": [
        {"id": 1, "start": 2.0, "end": 3.0, "text": " Hallo.", "words": []},
    ]}
    segs = em.tag_uncertain_segments(raw)
    assert segs[0]["tagged_text"] == "Hallo."  # keine words -> gestrippter Text
    # eigener Schwellwert: bei 0.85 wird 0.8 markiert
    raw2 = {"segments": [{"id": 0, "start": 0, "end": 1, "text": "x",
             "words": [{"word": "x", "probability": 0.8}]}]}
    assert "[[x|0.80]]" in em.tag_uncertain_segments(raw2, threshold=0.85)[0]["tagged_text"]
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_edit_model.py -k uncertain -q
```
Expected: FAIL (`AttributeError: module 'webtool.edit_model' has no attribute 'tag_uncertain_segments'`).

- [ ] **Step 3: Implementieren**

Append to `webtool/edit_model.py`:
```python
UNCERTAIN_TAG_THRESHOLD = 0.5


def tag_uncertain_segments(raw: dict, threshold: float = UNCERTAIN_TAG_THRESHOLD) -> list:
    """Pro Roh-Segment ein {id,start,end,tagged_text}; Wörter mit
    probability < threshold inline als [[Wort|0.pp]] markiert (für die LLM-Korrektur)."""
    out = []
    for seg in raw.get("segments", []):
        words = seg.get("words", [])
        if words:
            parts = []
            for w in words:
                word = w.get("word", "")
                prob = w.get("probability", 1.0)
                stripped = word.strip()
                if stripped and prob < threshold:
                    lead = word[: len(word) - len(word.lstrip())]  # führende Leerzeichen erhalten
                    parts.append(f"{lead}[[{stripped}|{prob:.2f}]]")
                else:
                    parts.append(word)
            tagged = "".join(parts).strip()
        else:
            tagged = (seg.get("text") or "").strip()
        out.append({
            "id": seg.get("id"),
            "start": seg.get("start"),
            "end": seg.get("end"),
            "tagged_text": tagged,
        })
    return out
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_edit_model.py -k uncertain -q
```
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```
git add webtool/edit_model.py webtool/test_edit_model.py
git commit -m "feat(webtool): tag_uncertain_segments - unsichere Woerter inline fuer LLM taggen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `apply_correction` — strukturierte Korrektur in edit.json einweben

**Files:**
- Modify: `webtool/edit_model.py`
- Test: `webtool/test_edit_model.py`

**Interfaces:**
- Consumes: `build_edit_doc` (bestehend).
- Produces:
  - `apply_correction(raw: dict, correction: dict, *, base: str, project: str, audio: str) -> dict` → baut das edit.json-Dokument (Timing/Wörter/Flags/`raw_text` aus `raw`), überschreibt pro Segment `text`/`speaker` aus `correction["segments"]` (Zuordnung per `id`), setzt `context`/`speakers`/`annotations` aus `correction`. Segmente ohne Korrektur behalten Rohtext + leeren Sprecher. `human_edited=False`.

- [ ] **Step 1: Failing test schreiben**

Append to `webtool/test_edit_model.py`:
```python
def test_apply_correction_overlays_by_id():
    raw = {"language": "de", "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Ich bin Mathias.",
         "compression_ratio": 1.0, "no_speech_prob": 0.01, "avg_logprob": -0.3,
         "words": [{"word": " Ich", "start": 0.0, "end": 0.5, "probability": 0.4}]},
        {"id": 1, "start": 1.0, "end": 2.0, "text": " Aha.",
         "compression_ratio": 1.0, "no_speech_prob": 0.01, "avg_logprob": -0.3, "words": []},
    ]}
    correction = {
        "base": "B", "context": "Vorstellung.",
        "speakers": ["Interviewer", "Matthias"],
        "segments": [
            {"id": 0, "speaker": "Matthias", "text": "Ich bin Matthias."},
            # id 1 absichtlich NICHT korrigiert
        ],
        "annotations": ["Stelle X unklar."],
    }
    doc = em.apply_correction(raw, correction, base="B", project="P", audio="B.mp3")
    assert doc["context"] == "Vorstellung."
    assert doc["speakers"] == ["Interviewer", "Matthias"]
    assert doc["annotations"] == ["Stelle X unklar."]
    assert doc["human_edited"] is False
    s0 = doc["segments"][0]
    assert s0["text"] == "Ich bin Matthias." and s0["speaker"] == "Matthias"
    assert s0["raw_text"] == "Ich bin Mathias."  # Roh bleibt erhalten
    assert s0["words"][0]["probability"] == 0.4 and s0["flags"] == {"hallucination": False, "silence": False, "low_conf": False}
    s1 = doc["segments"][1]
    assert s1["text"] == "Aha." and s1["speaker"] == ""  # nicht korrigiert -> Rohtext, leerer Sprecher


def test_apply_correction_empty_correction_keeps_raw():
    raw = {"segments": [{"id": 0, "start": 0, "end": 1, "text": " Hallo.", "words": []}]}
    doc = em.apply_correction(raw, {}, base="B", project="P", audio="")
    assert doc["segments"][0]["text"] == "Hallo." and doc["segments"][0]["speaker"] == ""
    assert doc["context"] == "" and doc["speakers"] == [] and doc["annotations"] == []
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_edit_model.py -k apply_correction -q
```
Expected: FAIL (`no attribute 'apply_correction'`).

- [ ] **Step 3: Implementieren**

Append to `webtool/edit_model.py`:
```python
def apply_correction(raw: dict, correction: dict, *, base: str, project: str, audio: str) -> dict:
    """edit.json aus Roh bauen und die segment-genaue Korrektur (Text/Sprecher je id)
    sowie context/speakers/annotations einweben. Nicht korrigierte Segmente behalten Rohtext."""
    doc = build_edit_doc(raw, base=base, project=project, audio=audio)
    doc["context"] = (correction.get("context") or "").strip()
    doc["speakers"] = list(correction.get("speakers") or [])
    doc["annotations"] = [str(a).strip() for a in (correction.get("annotations") or []) if str(a).strip()]
    by_id = {c.get("id"): c for c in (correction.get("segments") or [])}
    for seg in doc["segments"]:
        c = by_id.get(seg["id"])
        if c is not None:
            text = (c.get("text") or "").strip()
            if text:
                seg["text"] = text
            seg["speaker"] = (c.get("speaker") or "").strip()
    return doc
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_edit_model.py -k apply_correction -q
```
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```
git add webtool/edit_model.py webtool/test_edit_model.py
git commit -m "feat(webtool): apply_correction - segment-genaue Korrektur in edit.json einweben

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `atomic_write` nach `paths.py` hochziehen (DRY, für die CLI nutzbar)

**Files:**
- Modify: `webtool/paths.py` (Funktion hinzufügen)
- Modify: `webtool/app.py` (lokales `_atomic_write` entfernen, `paths.atomic_write` nutzen)
- Test: `webtool/test_paths.py`

**Interfaces:**
- Produces: `paths.atomic_write(path: str, text: str) -> None` (schreibt `path + ".tmp"`, dann `os.replace`).
- Consumes (in `app.py`): `paths.atomic_write`.

- [ ] **Step 1: Failing test schreiben**

Append to `webtool/test_paths.py`:
```python
def test_atomic_write_creates_file_and_no_tmp(tmp_path):
    target = tmp_path / "out.txt"
    paths.atomic_write(str(target), "hällo\n")
    assert target.read_text(encoding="utf-8") == "hällo\n"
    assert not (tmp_path / "out.txt.tmp").exists()  # tmp wurde umbenannt
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_paths.py -k atomic -q
```
Expected: FAIL (`no attribute 'atomic_write'`).

- [ ] **Step 3: `atomic_write` in `paths.py` ergänzen**

Append to `webtool/paths.py`:
```python
def atomic_write(path: str, text: str) -> None:
    """Schreibe erst in .tmp, dann os.replace() -> nie halb-geschriebene Datei."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)
```

- [ ] **Step 4: `app.py` auf `paths.atomic_write` umstellen**

In `webtool/app.py` das lokale Helferlein ENTFERNEN:
```python
def _atomic_write(path: str, text: str) -> None:
    """Schreibe erst in .tmp, dann os.replace() -> nie halb-geschriebene Datei."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)
```
und in `save_file` die beiden Aufrufe ersetzen:
```python
    _atomic_write(_edit_path(project, base), json.dumps(doc, ensure_ascii=False, indent=1))
    _atomic_write(_md_path(project, base), render_md(doc))
```
durch:
```python
    paths.atomic_write(_edit_path(project, base), json.dumps(doc, ensure_ascii=False, indent=1))
    paths.atomic_write(_md_path(project, base), render_md(doc))
```

- [ ] **Step 5: Volle Suite — alles grün (App-Verhalten unverändert)**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q
```
Expected: PASS (alle; inkl. `test_put_saves_non_destructive`, das das atomare Speichern indirekt abdeckt).

- [ ] **Step 6: Commit**

```
git add webtool/paths.py webtool/app.py webtool/test_paths.py
git commit -m "refactor(webtool): atomic_write nach paths.py (DRY, fuer CLI wiederverwendbar)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `webtool/correct.py` — CLI `prep` + `apply`

**Files:**
- Create: `webtool/correct.py`
- Test: `webtool/test_correct.py`

**Interfaces:**
- Consumes: `paths` (`transkripte_dir`, `audio_dir`, `safe_name`, `atomic_write`), `edit_model.tag_uncertain_segments`, `edit_model.apply_correction`, `render_md.render_md`.
- Produces (Funktionen, damit testbar ohne Subprozess):
  - `bases(project) -> list[str]` (alle `<base>` mit Roh-`.json`, ohne `.edit.json`).
  - `cmd_prep(project) -> int` (schreibt `<base>.tagged.txt` je Datei; gibt Anzahl zurück).
  - `cmd_apply(project, base, force=False) -> str` (baut edit.json+md aus `<base>.correction.json`; respektiert `human_edited`; gibt Status zurück: `"written"` oder `"skipped"`).
  - `main(argv=None)` (argparse-Subcommands `prep`/`apply`).

- [ ] **Step 1: Failing test schreiben**

Create `webtool/test_correct.py`:
```python
import json
import os
import pytest
from webtool import correct


@pytest.fixture
def project(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    t = tmp_path / "Demo" / "transkripte"
    t.mkdir(parents=True)
    (tmp_path / "Demo" / "audio").mkdir()
    (tmp_path / "Demo" / "audio" / "S1.mp3").write_bytes(b"x")
    raw = {"language": "de", "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Ich bin Mathias.",
         "compression_ratio": 1.0, "no_speech_prob": 0.01, "avg_logprob": -0.3,
         "words": [{"word": " Mathias", "start": 0.0, "end": 0.5, "probability": 0.3}]},
    ]}
    (t / "S1.json").write_text(json.dumps(raw), encoding="utf-8")
    return tmp_path, t


def test_prep_writes_tagged(project):
    _root, t = project
    n = correct.cmd_prep("Demo")
    assert n == 1
    tagged = (t / "S1.tagged.txt").read_text(encoding="utf-8")
    assert tagged.startswith("[0] ")
    assert "[[Mathias|0.30]]" in tagged


def test_apply_builds_edit_and_md(project):
    _root, t = project
    (t / "S1.correction.json").write_text(json.dumps({
        "base": "S1", "context": "Test.", "speakers": ["Matthias"],
        "segments": [{"id": 0, "speaker": "Matthias", "text": "Ich bin Matthias."}],
        "annotations": [],
    }), encoding="utf-8")
    status = correct.cmd_apply("Demo", "S1")
    assert status == "written"
    doc = json.loads((t / "S1.edit.json").read_text(encoding="utf-8"))
    assert doc["segments"][0]["text"] == "Ich bin Matthias."
    assert doc["segments"][0]["speaker"] == "Matthias"
    assert doc["human_edited"] is False
    md = (t / "S1.md").read_text(encoding="utf-8")
    assert "**Matthias:** Ich bin Matthias." in md
    # Roh unangetastet
    assert "Mathias" in (t / "S1.json").read_text(encoding="utf-8")


def test_apply_respects_human_edited(project):
    _root, t = project
    (t / "S1.correction.json").write_text(json.dumps(
        {"base": "S1", "segments": [{"id": 0, "speaker": "X", "text": "Neu."}]}), encoding="utf-8")
    (t / "S1.edit.json").write_text(json.dumps(
        {"human_edited": True, "segments": [{"id": 0, "text": "Von Hand."}]}), encoding="utf-8")
    assert correct.cmd_apply("Demo", "S1") == "skipped"
    # unveraendert
    assert "Von Hand." in (t / "S1.edit.json").read_text(encoding="utf-8")
    # --force ueberschreibt
    assert correct.cmd_apply("Demo", "S1", force=True) == "written"
    assert "Neu." in (t / "S1.edit.json").read_text(encoding="utf-8")
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -q
```
Expected: FAIL (`No module named 'webtool.correct'`).

- [ ] **Step 3: `webtool/correct.py` implementieren**

Create `webtool/correct.py`:
```python
"""CLI für den Korrektur-Ablauf (Stufe 1.5).

  python -m webtool.correct prep  <project>            -> <base>.tagged.txt je Datei
  python -m webtool.correct apply <project> <base>     -> <base>.edit.json + <base>.md
                                            [--force]     (aus <base>.correction.json)

Der eigentliche LLM-Korrekturschritt liegt dazwischen (Workflow tools/correct_label.mjs).
"""
import argparse
import glob
import json
import os

from . import paths
from .edit_model import tag_uncertain_segments, apply_correction
from .render_md import render_md

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")


def bases(project: str) -> list:
    tdir = paths.transkripte_dir(project)
    if not os.path.isdir(tdir):
        return []
    return sorted({os.path.splitext(os.path.basename(p))[0]
                   for p in glob.glob(os.path.join(tdir, "*.json"))
                   if not p.endswith(".edit.json")})


def _audio_name(project: str, base: str) -> str:
    adir = paths.audio_dir(project)
    for ext in AUDIO_EXT:
        cand = os.path.join(adir, base + ext)
        if os.path.exists(cand):
            return os.path.basename(cand)
    return ""


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def cmd_prep(project: str) -> int:
    tdir = paths.transkripte_dir(project)
    n = 0
    for base in bases(project):
        raw = _load(os.path.join(tdir, base + ".json"))
        segs = tag_uncertain_segments(raw)
        text = "\n".join(f"[{s['id']}] {s['tagged_text']}" for s in segs) + "\n"
        paths.atomic_write(os.path.join(tdir, base + ".tagged.txt"), text)
        n += 1
    print(f"prep: {n} Datei(en) getaggt in {tdir}")
    return n


def cmd_apply(project: str, base: str, force: bool = False) -> str:
    tdir = paths.transkripte_dir(project)
    epath = os.path.join(tdir, base + ".edit.json")
    if os.path.exists(epath) and not force:
        try:
            if _load(epath).get("human_edited"):
                print(f"apply: SKIP {base} (human_edited=true; --force zum Ueberschreiben)")
                return "skipped"
        except json.JSONDecodeError:
            pass  # korrupte edit.json -> darf ueberschrieben werden
    raw = _load(os.path.join(tdir, base + ".json"))
    correction = _load(os.path.join(tdir, base + ".correction.json"))
    doc = apply_correction(raw, correction, base=base, project=project,
                           audio=_audio_name(project, base))
    paths.atomic_write(epath, json.dumps(doc, ensure_ascii=False, indent=1))
    paths.atomic_write(os.path.join(tdir, base + ".md"), render_md(doc))
    print(f"apply: {base} -> edit.json + md ({len(doc['segments'])} Segmente)")
    return "written"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Transkribor Korrektur-CLI (Stufe 1.5)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prep"); p.add_argument("project")
    a = sub.add_parser("apply"); a.add_argument("project"); a.add_argument("base")
    a.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    paths.safe_name(args.project)
    if args.cmd == "prep":
        cmd_prep(args.project)
    else:
        paths.safe_name(args.base)
        cmd_apply(args.project, args.base, args.force)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -q
```
Expected: PASS (3 passed).

- [ ] **Step 5: Volle Suite als Regressionskontrolle**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q
```
Expected: PASS (alle).

- [ ] **Step 6: Commit**

```
git add webtool/correct.py webtool/test_correct.py
git commit -m "feat(webtool): correct-CLI (prep taggt, apply baut edit.json+md aus correction.json)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Workflow `tools/correct_label.mjs` auf segment-ausgerichtete Korrektur umstellen

**Files:**
- Modify: `tools/correct_label.mjs` (vollständig ersetzen)

**Interfaces:**
- Consumes: `args = { dir, bases:[...], context? }`. Liest `<dir>\<base>.tagged.txt` (von `correct prep`) und `<dir>\<base>.raw.txt` / `<dir>\<base>.segments.txt`.
- Produces (Rückgabewert): `{ glossary, corrections: [{ base, context, speakers, segments:[{id,speaker,text}], annotations, summary }] }`. **Schreibt selbst keine Dateien** — die `correction.json`-Erzeugung + Assembly macht der Controller via `webtool.correct apply`.

**Hinweis für den Implementierer:** Dies ist ein Workflow-Orchestrierungsskript (kein pytest). Es wird NICHT hier ausgeführt — die End-to-End-Validierung übernimmt der Controller (Task 6-Äquivalent nach dem Plan). Ersetze die Datei 1:1 mit folgendem Inhalt. Achte auf die Segment-ID-Treue (jede Roh-ID genau einmal).

- [ ] **Step 1: `tools/correct_label.mjs` vollständig ersetzen**

Ersetze den GESAMTEN Inhalt von `tools/correct_label.mjs` durch:
```js
export const meta = {
  name: 'transkribor-correct-label',
  description: 'Segment-ausgerichtete Kontext-Korrektur + Sprecher-Labeling (liefert strukturierte Korrektur je Datei; Assembly zu edit.json/md via `python -m webtool.correct apply`)',
  phases: [
    { title: 'Glossar', detail: 'Gemeinsame Eigennamen/Kontext aus allen Roh-Transkripten' },
    { title: 'Korrektur+Labeling', detail: 'Pro Datei: segment-genaue Korrektur + Sprecher aus <base>.tagged.txt' },
    { title: 'Verifikation', detail: 'Pro Datei: Treue-Check gegen Rohtranskript' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args
const DIR = String(A.dir)
const BASES = A.bases
const CONTEXT = (A.context && String(A.context).trim())
  || 'Interviews (gesprochene Sprache oft Schweizerdeutsch/Dialekt), von Whisper large-v3 nach Standarddeutsch transkribiert. Es gibt ASR-Fehler, v.a. bei Eigennamen und Dialektbegriffen.'

const GLOSSARY_SCHEMA = {
  type: 'object',
  properties: {
    context_summary: { type: 'string' },
    proper_nouns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          correct: { type: 'string' },
          variants: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['correct'],
      },
    },
    likely_corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { wrong: { type: 'string' }, right: { type: 'string' }, why: { type: 'string' } },
        required: ['wrong', 'right'],
      },
    },
  },
  required: ['context_summary', 'proper_nouns', 'likely_corrections'],
}

const CORRECTION_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    context: { type: 'string' },
    speakers: { type: 'array', items: { type: 'string' } },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          speaker: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'speaker', 'text'],
      },
    },
    annotations: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['base', 'segments', 'summary'],
}

// ---- Phase 0: gemeinsames Glossar (Barrier: braucht alle Dateien) ----
phase('Glossar')
const rawList = BASES.map((b) => `${DIR}\\${b}.raw.txt`).join('\n')
const glossary = await agent(
  `Du bereitest ein GEMEINSAMES Glossar vor, mit dem anschliessend einzelne Transkripte konsistent korrigiert werden.

Projekt-Kontext: ${CONTEXT}

Lies ALLE folgenden Roh-Transkripte vollständig:
${rawList}

Erstelle daraus ein JSON-Glossar für KONSISTENTE Korrekturen:
- context_summary: 3–6 Sätze, worum es geht.
- proper_nouns: wiederkehrende Namen/Orte/Betriebe/Marken als {correct, variants:[so falsch gehört], note}. Nur mit vernünftiger Sicherheit. ERFINDE KEINE Namen.
- likely_corrections: wiederkehrende Nicht-Eigenname-Fehler als {wrong, right, why}. Konservativ.

Lieber wenige sichere Einträge als viele geratene.`,
  { schema: GLOSSARY_SCHEMA, effort: 'high', label: 'glossar', phase: 'Glossar' }
)
log(`Glossar: ${glossary.proper_nouns?.length || 0} Eigennamen, ${glossary.likely_corrections?.length || 0} Korrekturen`)
const gjson = JSON.stringify(glossary, null, 1)

// ---- Phase 1+2: pro Datei Korrektur → Verifikation (Pipeline) ----
phase('Korrektur+Labeling')

const correctPrompt = (base) => `Du korrigierst EIN Interview-Transkript SEGMENT FÜR SEGMENT.

Projekt-Kontext: ${CONTEXT}

Die Rohsegmente liegen (mit Segment-ID pro Zeile im Format "[<id>] <text>") in:
${DIR}\\${base}.tagged.txt
Lies diese Datei vollständig. Unsichere Wörter sind inline als [[Wort|Wahrscheinlichkeit]] markiert (niedrige Whisper-Wahrscheinlichkeit).

Gemeinsames Glossar (für konsistente Korrekturen — nutze es):
${gjson}

AUFGABE:
1) KORRIGIEREN: Verbessere klare ASR-Fehler mit Kontext + Glossar. Konzentriere dich PRIMÄR auf die [[...]]-markierten unsicheren Wörter; unmarkierte nur ändern, wenn im Kontext eindeutig falsch. Normalisiere zu lesbarem Standarddeutsch (Schweizer "ss"). Bleib TREU: nichts erfinden, Sinn NICHT verändern, nicht über das Nötige hinaus glätten. Fülltext (äh, ähm) darf dezent bereinigt werden. Gib normalen Text zurück (OHNE [[...]]-Markierungen).
2) PRO SEGMENT: Gib für JEDE Segment-ID aus der Datei GENAU EINEN Eintrag {id, speaker, text} zurück (keine ID auslassen, keine Segmente zusammenfassen — die Redebeitrags-Bündelung passiert später).
3) SPRECHER: Meist zwei — Interviewer (stellt Fragen) und die befragte Person (Name/Betrieb falls im Gespräch genannt, z.␣B. "Hans Müller", sonst "Befragte Person"). Ordne jedem Segment den passenden Sprecher zu.
4) UNSICHER: Wirklich unklare Stellen im Original belassen und in annotations (Freitext) vermerken — nichts still erfinden.

Gib das JSON-Objekt gemäss Schema zurück: base="${base}", context (1–2 Sätze zum Gespräch), speakers (Liste der vorkommenden Sprecher-Labels), segments ([{id,speaker,text}] für ALLE IDs), annotations, summary.`

const verifyPrompt = (base, corr) => `Du prüfst eine bereits erstellte SEGMENT-GENAUE Korrektur auf TREUE gegen das Rohtranskript und gibst die (ggf. korrigierte) Fassung zurück.

Rohtranskript (mit Zeitstempeln): ${DIR}\\${base}.segments.txt  — lies es vollständig.

Zu prüfende Korrektur (JSON):
${JSON.stringify(corr, null, 1)}

Prüfe kritisch:
1) HALLUZINATION/DRIFT: Wurde Inhalt hinzugefügt/weggelassen/im Sinn verändert, der nicht im Roh steht? Übermässiges Umschreiben? → näher ans Original zurück.
2) VOLLSTÄNDIGKEIT: Ist für JEDE Roh-Segment-ID genau ein Eintrag vorhanden? Fehlende ergänzen (Text nah am Roh), überzählige/zusammengefasste auftrennen.
3) SPRECHER: Plausibel und konsistent (Interviewer stellt Fragen; Antworten korrekt zugeordnet)? Korrigiere Fehlzuordnungen.
4) RESTFEHLER: Offensichtliche verbleibende ASR-Fehler (konservativ, nur wenn klar).

Gib das VOLLSTÄNDIGE, geprüfte Korrektur-Objekt gemäss Schema zurück (base, context, speakers, segments, annotations, summary). Ändere NUR, was wirklich nötig ist; unproblematische Segmente unverändert übernehmen. Ergänze in summary knapp, was du geändert hast (oder "keine Änderung").`

const corrections = await pipeline(
  BASES,
  (base) => agent(correctPrompt(base), { label: `korr:${base}`, phase: 'Korrektur+Labeling', schema: CORRECTION_SCHEMA, effort: 'high' }),
  (corr, base) => agent(verifyPrompt(base, corr), { label: `verify:${base}`, phase: 'Verifikation', schema: CORRECTION_SCHEMA, effort: 'high' })
)

return { glossary, corrections: corrections.filter(Boolean) }
```

- [ ] **Step 2: Syntax-Check (nur Parsebarkeit; NICHT ausführen)**

Run:
```
node --check tools/correct_label.mjs
```
Expected: exit 0 (keine Ausgabe). (Der Workflow selbst wird vom Controller end-to-end validiert, nicht hier.)

- [ ] **Step 3: Commit**

```
git add tools/correct_label.mjs
git commit -m "feat(workflow): correct_label liefert segment-ausgerichtete Korrektur (id/speaker/text) statt Prosa-md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `CLAUDE.md` auf den neuen Korrektur-Ablauf aktualisieren

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** keine (Doku).

Der bestehende „Schritt 2"-Abschnitt in `CLAUDE.md` beschreibt den alten Ablauf (Workflow schreibt `.md`). Er wird auf den 3-Schritt-Ablauf (prep → Workflow → apply) aktualisiert.

- [ ] **Step 1: Den Workflow-Aufruf-Block in `CLAUDE.md` ersetzen**

Suche in `CLAUDE.md` den Abschnitt „### Schritt 2 — Kontext-Korrektur + Sprecher-Labeling" und ersetze die nummerierte Anleitung (Punkte 1–3 mit dem `Workflow({...})`-Block) durch:
```markdown
1. Sammle die Basisnamen: alle `*.segments.txt` in `projekte\<NAME>\transkripte\` (Dateiname ohne Endung).
2. Lies `projekte\<NAME>\kontext.md` falls vorhanden → `context`.
3. **Vor-Taggen** (unsichere Wörter für den LLM markieren):
   ```
   E:\Git\Transkribor\.venv\Scripts\python.exe -m webtool.correct prep "<NAME>"
   ```
   (erzeugt `<base>.tagged.txt` je Datei)
4. **Korrektur-Workflow** (segment-genaue Korrektur + Sprecher):
   ```
   Workflow({ scriptPath: "E:\\Git\\Transkribor\\tools\\correct_label.mjs",
              args: { dir: "E:\\Git\\Transkribor\\projekte\\<NAME>\\transkripte",
                      bases: [ ...basenames... ],
                      context: "<Inhalt von kontext.md oder kurze Beschreibung>" } })
   ```
   Der Workflow liefert `{ glossary, corrections: [{ base, context, speakers, segments, annotations, summary }] }`.
   (Ist die Workflow-Funktion nicht verfügbar, führe die Korrektur **inline** aus — dieselben Regeln, siehe unten — und erzeuge dieselbe Korrektur-Struktur.)
5. **Assemblieren**: pro Datei die zurückgegebene Korrektur nach `projekte\<NAME>\transkripte\<base>.correction.json` schreiben, dann:
   ```
   E:\Git\Transkribor\.venv\Scripts\python.exe -m webtool.correct apply "<NAME>" "<base>"
   ```
   (baut `<base>.edit.json` + `<base>.md`; überschreibt `edit.json` mit `human_edited=true` nicht — dafür `--force`).

Ergebnis: `projekte\<NAME>\transkripte\<base>.edit.json` (Editor-Dokument, im Web-Tool bearbeitbar) + `<base>.md` (Export).
```

- [ ] **Step 2: Verifizieren, dass die Datei konsistent ist**

Run:
```
E:\Git\Transkribor\.venv\Scripts\python.exe -c "import pathlib; t=pathlib.Path('CLAUDE.md').read_text(encoding='utf-8'); assert 'webtool.correct prep' in t and 'webtool.correct apply' in t and 'correction.json' in t; print('CLAUDE.md ok')"
```
Expected: `CLAUDE.md ok`.

- [ ] **Step 3: Commit**

```
git add CLAUDE.md
git commit -m "docs: Korrektur-Ablauf auf prep -> Workflow -> apply (segment-ausgerichtete edit.json)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec-Abdeckung** (Spec §7 „Korrekturschritt wird segment-ausgerichtet" + Stufenplan §9 „Stufe 1.5"):
- „liefert künftig `edit.json` (korrigierter Text + Sprecher pro Segment)" → Task 2 (`apply_correction`) + Task 4 (`correct apply`) ✓
- „unsichere Wörter inline getaggt (`[[Chur|0.31]]`)" → Task 1 (`tag_uncertain_segments`) + Task 5 (Workflow-Prompt nutzt sie) ✓
- „gezielte Korrektur statt Blind-Rewrite" → Task 5 Prompt („PRIMÄR die markierten Wörter") ✓
- „die `.md` ist der gerenderte Export" → Task 4 rendert `.md` via bestehendes `render_md` ✓
- „Mensch hat letztes Wort / `human_edited`-Flag schützt" → Task 4 (`cmd_apply` SKIP bei human_edited) ✓
- Segment-ID-Treue (keine Zusammenfassung) → Task 5 Prompt + Verify-Vollständigkeitsprüfung ✓
- Ablaufänderung dokumentiert → Task 6 (CLAUDE.md) ✓

**2. Placeholder-Scan:** keine „TBD/TODO/handle edge cases"; alle Code-Schritte enthalten vollständigen Code; Tests mit echten Assertions. Task 5 (Workflow) ist bewusst NICHT pytest-getestet (Orchestrierung) — `node --check` prüft Parsebarkeit, End-to-End validiert der Controller.

**3. Typ-/Namens-Konsistenz:** `tag_uncertain_segments` / `apply_correction` (edit_model) ↔ Nutzung in `correct.py` (Task 4) stimmen überein. Korrektur-Struktur `{base, context, speakers, segments:[{id,speaker,text}], annotations, summary}` ist in Task 4 (Test-Fixture + apply), Task 5 (CORRECTION_SCHEMA + Prompts) und Task 6 (CLAUDE.md-Doku) identisch. `paths.atomic_write` (Task 3) wird von `correct.py` (Task 4) und `app.py` (Task 3) genutzt. `bases()` in `correct.py` spiegelt `_bases()` aus `app.py` (bewusste kleine Dopplung, da anderes Modul; keine Import-Kopplung app↔correct).

Keine offenen Lücken. Nach der Ausführung: End-to-End-Validierung durch den Controller (prep → Workflow am echten Projekt → apply → im Browser prüfen, dass die edit.json vor-korrigiert öffnet und `human_edited` schützt) — mit vorherigem Backup der bestehenden `.md`.
