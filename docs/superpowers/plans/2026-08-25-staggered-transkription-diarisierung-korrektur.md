# Staggered Pipeline (Transkription, Diarisierung, KI-Korrektur) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zeitversetzte Pipeline (Staggered Pipelining) für Mehrfach-Dateiverarbeitung in Transkribor: Jede Datei durchläuft lokal die GPU-Schritte (Whisper-Transkription gefolgt von Pyannote-Diarisierung) und wird unmittelbar danach an die Cloud-KI zur Korrektur übergeben, während die GPU sofort mit der nächsten Datei fortfährt.

**Architecture:** `transcribe.py` orchestriert die GPU-Schleife über die Audiodateien eines Projekts. Nach Abschluss der Transkription einer Datei wird sofort ihre Diarisierung auf der GPU gerechnet und ihr Cluster-Tagging vorbereitet. Danach wird sie direkt an einen `ThreadPoolExecutor` für die Cloud-KI übergeben. Die GPU-Schleife geht sofort zur nächsten Datei über, ohne auf das Netzwerk-LLM zu warten. Neu eintreffende Uploads werden dynamisch aufgenommen.

**Tech Stack:** Python 3.13, faster-whisper / whisper.cpp, pyannote.audio, ThreadPoolExecutor, FastAPI, pytest

---

### Task 1: Tests für die Staggered Pipeline in `webtool/test_transcribe.py` erstellen

**Files:**
- Modify: `webtool/test_transcribe.py`

- [ ] **Step 1: Write failing tests for staggered execution order and dynamic pickup**
  - Testet, dass `transcribe_project` mit `--autocorrect` die Sequenz `Transcribe(D1) -> Diarize(D1) -> Submit(D1) -> Transcribe(D2) -> Diarize(D2) -> Submit(D2)` einhält.
  - Testet, dass während der KI-Korrektur von Datei 1 bereits Datei 2 transkribiert/diarisiert wird.
  - Testet, dass neu eingetroffene Dateien im Ordner dynamisch verarbeitet werden.

- [ ] **Step 2: Run pytest to verify test failures or gaps**
  - Run: `.venv/bin/pytest webtool/test_transcribe.py -k test_staggered -v`

- [ ] **Step 3: Implement minimal code changes in `transcribe.py`**
  - Sicherstellen, dass die Schleife in `transcribe_project` nach der Diarisierung sofort den KI-Future erzeugt, zur nächsten Datei weitergeht und dynamisch neue Dateien erfasst.

- [ ] **Step 4: Run pytest to verify tests pass**
  - Run: `.venv/bin/pytest webtool/test_transcribe.py -v`

---

### Task 2: Robustheit und dynamic queueing in `transcribe.py`

**Files:**
- Modify: `transcribe.py`

- [ ] **Step 1: Write tests for error handling and pool shutdown**
  - Verifiziert, dass Diarisierungsfehler bei Datei 1 die Bearbeitung von Datei 2 nicht abbrechen.
  - Verifiziert, dass `wait(ai_futures)` erst nach allen GPU-Schritten aller Dateien ausgeführt wird.

- [ ] **Step 2: Refactor and refine `transcribe_project` in `transcribe.py`**
  - Dynamisches Wiederholen der Dateiliste (`find_audio`) solange unfertige Dateien vorliegen, bevor der `ai_pool` gewartet wird.

- [ ] **Step 3: Run full backend and frontend test suites**
  - Run: `.venv/bin/pytest webtool/`
  - Run: `npm --prefix webtool/frontend test`

---

### Task 3: Code Review & Verification

- [ ] **Step 1: Run code review across changes**
- [ ] **Step 2: Verification summary and walkthrough**
