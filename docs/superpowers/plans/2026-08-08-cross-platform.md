# Transkribor Cross-Platform — Implementation Plan (Spec 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transkribor läuft auf Windows, macOS (Apple Silicon) und Linux; der Nutzer wählt die Whisper-Qualitätsstufe im Browser und sieht, auf welchem Gerät gerechnet wird; ein Nutzer ohne KI-Anbieter bekommt keine fehlschlagenden Korrektur-Jobs mehr.

**Architektur:** Ein ASR-Backend (`openai-whisper`), pro Plattform die passende torch-Variante. Die Gerätewahl (`cuda`/`mps`/`cpu`) zieht aus zwei duplizierten Stellen in ein gemeinsames Modul `webtool/device.py`. Die Whisper-Einstellungen reisen über den bereits existierenden Weg `settings.job_env()` → `jobs.py` → `transcribe.py`; es kommen nur zwei Schlüssel dazu, keine neue Verdrahtung.

**Tech Stack:** Python 3.13 · FastAPI · openai-whisper · pyannote.audio · React 19 + Vite + TypeScript + Tailwind + shadcn/ui · Electron + electron-builder · pytest · `node:test`

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-08-transkribor-cross-platform-design.md` — bei Widerspruch gewinnt die Spec.
- **Python-Tests laufen mit:** `.venv\Scripts\python.exe -m pytest webtool -q` (cwd = Repo-Root).
- **`TRANSKRIBOR_SETTINGS` MUSS in jedem Test gesetzt werden, der Einstellungen berührt** — sonst entscheidet die echte Einstellungsdatei des Entwicklers über das Testergebnis.
- **torch-Importe bleiben lazy** (innerhalb der Funktion), wie in `webtool/diarize.py` etabliert: ein Modulimport darf nicht den mehrsekündigen torch-Start bezahlen.
- **Kommentare und Nutzertexte auf Deutsch**, ohne Umlaute in Python-Docstrings dort, wo die Datei es bereits so hält (`ue`/`ae`/`oe`); Frontend-Texte mit Umlauten.
- **Kein stiller Rückfall.** Weicht die Ausführung von der Absicht ab (MPS scheitert, Anbieter fehlt), wird das protokolliert oder angezeigt — nie stillschweigend ersetzt.
- **Keine neue Python-Abhängigkeit.** `requirements.txt` bleibt unverändert.
- **Bestandsverhalten auf Windows/NVIDIA muss identisch bleiben.** Default-Modell bleibt `large-v3`.
- Commit-Nachrichten enden mit `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Dateiübersicht

| Datei | Verantwortung | Aufgabe |
|---|---|---|
| `webtool/device.py` *(neu)* | Gerätewahl + Beschreibung, einzige Quelle | 1 |
| `webtool/test_device.py` *(neu)* | Tests dazu | 1 |
| `transcribe.py` | nutzt `device.pick()`, MPS-Rückfall, ffmpeg plattformabhängig | 2, 4 |
| `webtool/diarize.py` | nutzt `device.pick()`, ffmpeg plattformabhängig | 3, 4 |
| `webtool/settings.py` | `whisper_model` / `whisper_lang` + Export nach `job_env()` | 5 |
| `webtool/llm.py` | `available()` — kann überhaupt korrigiert werden? | 7 |
| `webtool/app.py` | `/api/hardware`, `ai_ready`, Auto-Korrektur-Riegel | 6, 8 |
| `webtool/jobs.py` | Prozessbaum-Abbruch auf POSIX | 12 |
| `webtool/frontend/src/lib/types.ts` | Typen für die neuen Felder | 9 |
| `webtool/frontend/src/lib/api.ts` | `getHardware()` | 9 |
| `webtool/frontend/src/pages/SettingsPage.tsx` | Qualitätsstufe, Hardware-Anzeige, Anbieter-Hinweis | 9 |
| `electron/setup.js` | reine `plan()`-Funktion + Plattformzweige | 10 |
| `electron/setup.test.js` *(neu)* | erste JS-Tests im Repo (`node --test`) | 10 |
| `package.json` | `mac`- und `linux`-Build-Targets | 11 |

---

### Task 1: Gemeinsame Gerätewahl (`webtool/device.py`)

**Files:**
- Create: `webtool/device.py`
- Create: `webtool/test_device.py`

**Interfaces:**
- Consumes: nichts
- Produces: `device.pick() -> str` (`"cuda"` | `"mps"` | `"cpu"`), `device.describe() -> dict` mit den Schlüsseln `device: str`, `name: str`, `torch_ok: bool`

- [ ] **Step 1: Write the failing tests**

Create `webtool/test_device.py`:

```python
"""Geraetewahl — mit gefaelschtem torch, damit der Test ohne GPU ueberall laeuft."""
import sys
import types

from webtool import device


def _torch(cuda=False, mps=False, name="Fake GPU"):
    """Minimales torch-Double: nur was device.py anfasst."""
    t = types.ModuleType("torch")
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda,
                                   get_device_name=lambda i: name)
    t.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: mps))
    return t


def test_cuda_gewinnt_vor_mps(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=True, mps=True))
    assert device.pick() == "cuda"


def test_mps_wenn_kein_cuda(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=False, mps=True))
    assert device.pick() == "mps"


def test_cpu_wenn_nichts_da(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=False, mps=False))
    assert device.pick() == "cpu"


def test_alte_torch_version_ohne_mps_backend(monkeypatch):
    """torch < 1.12 kennt torch.backends.mps nicht — darf nicht werfen."""
    t = _torch()
    t.backends = types.SimpleNamespace()
    monkeypatch.setitem(sys.modules, "torch", t)
    assert device.pick() == "cpu"


def test_ohne_torch_kein_absturz(monkeypatch):
    """sys.modules[name] = None laesst `import torch` ein ImportError werfen."""
    monkeypatch.setitem(sys.modules, "torch", None)
    assert device.pick() == "cpu"
    assert device.describe() == {"device": "cpu", "name": "PyTorch nicht installiert",
                                 "torch_ok": False}


def test_describe_nennt_die_gpu(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=True, name="NVIDIA RTX 5080"))
    assert device.describe() == {"device": "cuda", "name": "NVIDIA RTX 5080",
                                 "torch_ok": True}


def test_describe_apple(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(mps=True))
    d = device.describe()
    assert d["device"] == "mps" and d["torch_ok"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_device.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'webtool.device'`

- [ ] **Step 3: Write the implementation**

Create `webtool/device.py`:

```python
"""Welches Rechenwerk nutzen wir — an EINER Stelle.

Bisher stand die Entscheidung zweimal da (transcribe.py, diarize.py) und kannte nur
cuda/cpu. Apple Silicon rechnet ueber "mps"; whisper.load_model waehlt das von sich aus
nie — upstream kennt genau `cuda if torch.cuda.is_available() else cpu`.

Der torch-Import liegt bewusst INNERHALB der Funktionen (lazy, wie in diarize.py): ein
`import webtool.device` soll nicht den mehrsekuendigen torch-Start bezahlen, und die
Einstellungsseite muss auch in einer halben Umgebung ohne torch aufrufbar bleiben.
"""


def pick() -> str:
    """"cuda" | "mps" | "cpu" — das Erste, was verfuegbar ist."""
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    # torch < 1.12 kennt backends.mps nicht; getattr statt hasattr-Kette.
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def describe() -> dict:
    """Fuers Frontend: was laeuft, wie heisst es, ist torch ueberhaupt da.
    Wirft nie — eine kaputte Umgebung darf die Einstellungsseite nicht unbenutzbar machen."""
    try:
        import torch
    except ImportError:
        return {"device": "cpu", "name": "PyTorch nicht installiert", "torch_ok": False}
    d = pick()
    if d == "cuda":
        try:
            name = torch.cuda.get_device_name(0)
        except Exception:
            name = "CUDA-GPU"
    elif d == "mps":
        name = "Apple Silicon (Metal)"
    else:
        name = "CPU"
    return {"device": d, "name": name, "torch_ok": True}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_device.py -q`
Expected: PASS (7 Tests)

- [ ] **Step 5: Commit**

```bash
git add webtool/device.py webtool/test_device.py
git commit -m "feat(device): gemeinsame Geraetewahl cuda/mps/cpu

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `transcribe.py` nutzt die Gerätewahl und fällt bei MPS laut zurück

**Files:**
- Modify: `transcribe.py:96-101` (Gerätewahl), `transcribe.py:111-121` (Transkriptions-Aufruf)
- Modify: `webtool/test_transcribe.py` (Test anhängen)

**Interfaces:**
- Consumes: `webtool.device.pick()` aus Task 1
- Produces: `transcribe._opts(prompt, language, device) -> dict` — die Whisper-Optionen als Wörterbuch, damit der Rückfall den Aufruf nicht dupliziert

`transcribe.py` liegt im Repo-Root und darf `webtool` importieren: das Skript-Verzeichnis (= Repo-Root) landet beim Start in `sys.path`, und die gepackte App liefert `webtool/` und `transcribe.py` gemeinsam unter `resources/py` aus. Die umgekehrte Richtung (webtool → transcribe) bleibt weiterhin verboten, siehe Kommentar in `diarize.py:34`.

- [ ] **Step 1: Write the failing test**

An `webtool/test_transcribe.py` anhängen:

```python
def test_opts_fp16_nur_bei_cuda():
    """fp16 auf MPS oder CPU wuerde werfen bzw. still falsch rechnen."""
    import transcribe
    assert transcribe._opts("prompt", "de", "cuda")["fp16"] is True
    assert transcribe._opts("prompt", "de", "mps")["fp16"] is False
    assert transcribe._opts("prompt", "de", "cpu")["fp16"] is False


def test_opts_reicht_prompt_und_sprache_durch():
    import transcribe
    o = transcribe._opts("Kontext hier", "en", "cpu")
    assert o["initial_prompt"] == "Kontext hier"
    assert o["language"] == "en"
    assert o["word_timestamps"] is True      # Grundlage fuer die Audio-Synchronisation
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -q -k opts`
Expected: FAIL — `AttributeError: module 'transcribe' has no attribute '_opts'`

- [ ] **Step 3: Write the implementation**

In `transcribe.py` vor `transcribe_project` einfügen:

```python
def _opts(prompt, language, device):
    """Whisper-Optionen an einer Stelle — der MPS-Rueckfall ruft transcribe() ein zweites
    Mal auf und darf die Parameter nicht auseinanderlaufen lassen."""
    return dict(
        language=language, task="transcribe",
        word_timestamps=True, beam_size=5, best_of=5,
        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        condition_on_previous_text=True, initial_prompt=prompt,
        fp16=(device == "cuda"), verbose=False,
    )
```

`transcribe.py:96-101` ersetzen:

```python
    from webtool import device as devicemod
    device = devicemod.pick()
    info = devicemod.describe()
    print(f"[{name}] device={device} ({info['name']})", flush=True)
    print(f"[{name}] Modell {model}, {len(files)} Datei(en)", flush=True)
    m = whisper.load_model(model, device=device)
```

Den `try`-Block in der Schleife (`transcribe.py:111-121`) ersetzen:

```python
        try:
            result = m.transcribe(f, **_opts(prompt, language, device))
        except Exception as e:
            if device == "mps":
                # MPS deckt nicht jede Whisper-Operation ab. Einmal auf CPU wechseln und es
                # LAUT sagen: PYTORCH_ENABLE_MPS_FALLBACK=1 wuerde einzelne Ops still auf die
                # CPU schieben, die Anzeige behauptete weiter "mps", und der Nutzer wunderte
                # sich nur ueber die Laufzeit.
                print(f"[{name}] MPS gescheitert ({e}) — lade Modell erneut auf CPU", flush=True)
                device = "cpu"
                m = whisper.load_model(model, device=device)
                try:
                    result = m.transcribe(f, **_opts(prompt, language, device))
                except Exception as e2:
                    print(f"[{name}] FEHLER {base}: {e2}", flush=True)
                    continue
            else:
                print(f"[{name}] FEHLER {base}: {e}", flush=True)
                continue
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -q`
Expected: PASS

Der Rückfallpfad selbst bekommt **keinen** automatischen Test: er löst nur auf Apple-Hardware aus, und ein Fake-Whisper-Gerüst dafür wäre mehr Code als der Pfad. Er steht stattdessen in der manuellen Prüfliste (Task 13).

- [ ] **Step 5: Commit**

```bash
git add transcribe.py webtool/test_transcribe.py
git commit -m "feat(transcribe): mps nutzen, bei Fehlschlag hoerbar auf CPU zurueck

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `diarize.py` nutzt dieselbe Gerätewahl

**Files:**
- Modify: `webtool/diarize.py:26-27`
- Modify: `webtool/test_diarize.py` (Test anhängen)

**Interfaces:**
- Consumes: `webtool.device.pick()` aus Task 1
- Produces: nichts Neues

- [ ] **Step 1: Write the failing test**

An `webtool/test_diarize.py` anhängen:

```python
def test_pipeline_nutzt_geraetewahl(monkeypatch):
    """Die Diarisierung muss dasselbe Geraet waehlen wie die Transkription —
    sonst rechnet die eine auf der GPU und die andere auf der CPU."""
    import types
    import sys
    from webtool import device, diarize

    gewaehlt = []
    fake_torch = types.ModuleType("torch")
    fake_torch.device = lambda d: f"torchdevice:{d}"
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(device, "pick", lambda: "mps")
    monkeypatch.setenv("HF_TOKEN", "hf_test")

    class FakePipe:
        def to(self, d):
            gewaehlt.append(d)
            return self

    fake_pa = types.ModuleType("pyannote.audio")
    fake_pa.Pipeline = types.SimpleNamespace(from_pretrained=lambda *a, **k: FakePipe())
    monkeypatch.setitem(sys.modules, "pyannote", types.ModuleType("pyannote"))
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_pa)
    monkeypatch.setattr(diarize, "_PIPELINE", None)

    diarize._pipeline()
    assert gewaehlt == ["torchdevice:mps"]
    monkeypatch.setattr(diarize, "_PIPELINE", None)      # Singleton nicht vergiften
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_diarize.py -q -k geraetewahl`
Expected: FAIL — `assert [] == ['torchdevice:mps']` (heute wird `.to()` nur bei CUDA gerufen)

- [ ] **Step 3: Write the implementation**

In `webtool/diarize.py` die Zeilen 26-27 ersetzen:

```python
        from . import device as devicemod
        dev = devicemod.pick()
        if dev != "cpu":
            pipe.to(torch.device(dev))
```

Kommentar direkt darüber ergänzen:

```python
        # Dasselbe Geraet wie die Transkription (webtool/device.py). Scheitert MPS hier,
        # bleibt es beim Best-effort-Verhalten: kein .diar.json, Korrektur laeuft wie vor
        # Stufe 3 weiter — die Sprechertrennung faellt aus, nicht der Lauf.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_diarize.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/diarize.py webtool/test_diarize.py
git commit -m "feat(diarize): Geraetewahl mit der Transkription teilen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: ffmpeg plattformabhängig finden

**Files:**
- Modify: `transcribe.py:23-33` (`ensure_ffmpeg`)
- Modify: `webtool/diarize.py:32-45` (`_ensure_ffmpeg`)
- Modify: `webtool/test_transcribe.py` (Test anhängen)

**Interfaces:**
- Consumes: nichts
- Produces: `transcribe.ensure_ffmpeg() -> bool` (Signatur unverändert)

Warum das kein Schönheitsfehler ist: **GUI-Apps erben auf macOS ein anderes `PATH` als die Shell.** Per `brew` installiertes ffmpeg liegt unter `/opt/homebrew/bin`, ist im Terminal auffindbar — und für die aus dem Dock gestartete App unsichtbar. Ohne diesen Zweig scheitert jede Transkription auf einem korrekt eingerichteten Mac.

- [ ] **Step 1: Write the failing test**

An `webtool/test_transcribe.py` anhängen:

```python
def test_ensure_ffmpeg_findet_homebrew(monkeypatch, tmp_path):
    """macOS: GUI-Apps sehen /opt/homebrew/bin nicht im PATH."""
    import transcribe
    brew = tmp_path / "opt" / "homebrew" / "bin"
    brew.mkdir(parents=True)
    (brew / "ffmpeg").write_text("#!/bin/sh\n")

    monkeypatch.setattr(transcribe, "which", lambda n: None)
    monkeypatch.setattr(transcribe.sys, "platform", "darwin")
    monkeypatch.setattr(transcribe, "POSIX_FFMPEG_DIRS", (str(brew),))
    monkeypatch.setenv("PATH", "")

    assert transcribe.ensure_ffmpeg() is True
    assert str(brew) in os.environ["PATH"]


def test_ensure_ffmpeg_kein_winget_glob_auf_posix(monkeypatch):
    """Der winget-Pfad ist Windows-spezifisch und darf auf POSIX nicht angefasst werden."""
    import transcribe
    monkeypatch.setattr(transcribe, "which", lambda n: None)
    monkeypatch.setattr(transcribe.sys, "platform", "linux")
    monkeypatch.setattr(transcribe, "POSIX_FFMPEG_DIRS", ())

    def explodiere(*a, **k):
        raise AssertionError("glob darf auf POSIX nicht laufen")

    monkeypatch.setattr(transcribe.glob, "glob", explodiere)
    assert transcribe.ensure_ffmpeg() is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -q -k ffmpeg`
Expected: FAIL — `AttributeError: module 'transcribe' has no attribute 'POSIX_FFMPEG_DIRS'`

- [ ] **Step 3: Write the implementation**

In `transcribe.py` neben die anderen Konstanten (nach `AUDIO_EXT`):

```python
# Homebrew-Pfade: GUI-Apps erben auf macOS ein anderes PATH als die Shell — per brew
# installiertes ffmpeg ist im Terminal da und fuer die App unsichtbar.
POSIX_FFMPEG_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin")
```

`ensure_ffmpeg()` ersetzen:

```python
def ensure_ffmpeg():
    """ffmpeg auf PATH sicherstellen (Whisper braucht das Binary)."""
    if which("ffmpeg"):
        return True
    if sys.platform == "win32":
        for d in glob.glob(os.path.expandvars(
                r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg*\bin")):
            if os.path.exists(os.path.join(d, "ffmpeg.exe")):
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                return True
        print("WARN: ffmpeg nicht gefunden. Installiere: winget install Gyan.FFmpeg",
              file=sys.stderr)
        return False
    for d in POSIX_FFMPEG_DIRS:
        if os.path.exists(os.path.join(d, "ffmpeg")):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return True
    hinweis = ("brew install ffmpeg" if sys.platform == "darwin"
               else "sudo apt install ffmpeg")
    print(f"WARN: ffmpeg nicht gefunden. Installiere: {hinweis}", file=sys.stderr)
    return False
```

`glob` wird bereits auf Modulebene importiert (`transcribe.py:15`) — der Test greift über `transcribe.glob.glob` darauf zu.

In `webtool/diarize.py` `_ensure_ffmpeg()` spiegelbildlich anpassen (die Duplikation ist Absicht, siehe Kommentar dort):

```python
def _ensure_ffmpeg():
    """ffmpeg auf PATH sicherstellen (whisper.load_audio ruft es via subprocess).
    Bewusst dupliziert (mirror von transcribe.ensure_ffmpeg), um webtool nicht ans
    Root-Skript transcribe.py zu koppeln."""
    import glob
    import sys
    from shutil import which
    if which("ffmpeg"):
        return
    if sys.platform == "win32":
        for d in glob.glob(os.path.expandvars(
                r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg*\bin")):
            if os.path.exists(os.path.join(d, "ffmpeg.exe")):
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                return
        return
    for d in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"):
        if os.path.exists(os.path.join(d, "ffmpeg")):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool -q`
Expected: PASS (gesamte Suite, keine Regression)

- [ ] **Step 5: Commit**

```bash
git add transcribe.py webtool/diarize.py webtool/test_transcribe.py
git commit -m "fix(ffmpeg): Homebrew-Pfade auf macOS/Linux, winget-Glob nur auf Windows

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Whisper-Modell und -Sprache in den Einstellungen

**Files:**
- Modify: `webtool/settings.py:26-30` (`DEFAULTS`), `:33-43` (`load`), `:66-71` (`public`), `:74-78` (`job_env`)
- Create: `webtool/test_settings.py`

**Interfaces:**
- Consumes: nichts
- Produces: `settings.WHISPER_CHOICES: tuple[dict]` (je `{"id": str, "label": str, "hint": str}`), `settings.KNOWN_WHISPER_MODELS: tuple[str]`, erweitertes `settings.public()` um `whisper_model` / `whisper_lang`, erweitertes `settings.job_env()` um `WHISPER_MODEL` / `WHISPER_LANG`

- [ ] **Step 1: Write the failing tests**

Create `webtool/test_settings.py`:

```python
"""Einstellungen — TRANSKRIBOR_SETTINGS zeigt IMMER in tmp_path, sonst entscheidet
die echte Datei des Entwicklers ueber das Testergebnis."""
import json

import pytest

from webtool import settings


@pytest.fixture(autouse=True)
def eigene_datei(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    for name in ("WHISPER_MODEL", "WHISPER_LANG", "HF_TOKEN"):
        monkeypatch.delenv(name, raising=False)


def test_default_bleibt_large_v3():
    """Bestandsnutzer duerfen von der neuen Einstellung nichts merken."""
    assert settings.load()["whisper_model"] == "large-v3"
    assert settings.load()["whisper_lang"] == "de"


def test_speichern_und_lesen():
    settings.save({"whisper_model": "turbo"})
    assert settings.load()["whisper_model"] == "turbo"


def test_unbekanntes_modell_faellt_auf_default(tmp_path):
    """Ein handverdrehter Wert darf whisper.load_model nicht zum Absturz bringen."""
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"whisper_model": "gibt-es-nicht"}), encoding="utf-8")
    assert settings.load()["whisper_model"] == "large-v3"


def test_handverdrehtes_aber_echtes_modell_bleibt(tmp_path):
    """'base' steht nicht in der Auswahlliste, ist aber ein gueltiges Whisper-Modell."""
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"whisper_model": "base"}), encoding="utf-8")
    assert settings.load()["whisper_model"] == "base"


def test_job_env_exportiert_die_einstellung():
    settings.save({"whisper_model": "medium", "whisper_lang": "en"})
    env = settings.job_env()
    assert env["WHISPER_MODEL"] == "medium"
    assert env["WHISPER_LANG"] == "en"


def test_echte_umgebungsvariable_gewinnt(monkeypatch):
    """Wer WHISPER_MODEL gesetzt hat (webtool.ps1 aus der .env, CI), behaelt es."""
    settings.save({"whisper_model": "tiny"})
    monkeypatch.setenv("WHISPER_MODEL", "large-v3")
    assert "WHISPER_MODEL" not in settings.job_env()


def test_public_zeigt_modell_aber_kein_geheimnis():
    settings.save({"whisper_model": "turbo", "api_key": "sk-geheim"})
    pub = settings.public()
    assert pub["whisper_model"] == "turbo"
    assert pub["has_key"] is True
    assert "api_key" not in pub


def test_auswahlliste_ist_vollstaendig_gueltig():
    for c in settings.WHISPER_CHOICES:
        assert c["id"] in settings.KNOWN_WHISPER_MODELS
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_settings.py -q`
Expected: FAIL — `KeyError: 'whisper_model'`

- [ ] **Step 3: Write the implementation**

In `webtool/settings.py` nach den Importen einfügen:

```python
# Alle Namen, die whisper.load_model akzeptiert. Ein handverdrehtes "base" soll
# funktionieren, ein vertipptes "larg-v3" aber nicht erst beim Modell-Laden auffallen.
KNOWN_WHISPER_MODELS = (
    "tiny.en", "tiny", "base.en", "base", "small.en", "small", "medium.en", "medium",
    "large-v1", "large-v2", "large-v3", "large", "large-v3-turbo", "turbo",
)

# Was die Einstellungsseite anbietet. Die .en-Varianten sind fuer deutschsprachige
# Interviews sinnlos, large-v1/v2 sind von v3 ueberholt — 14 Namen zur Auswahl zu
# stellen hiesse, dem Nutzer eine Recherche aufzuhalsen.
WHISPER_CHOICES = (
    {"id": "tiny", "label": "Sehr schnell", "hint": "grobe Fehler, nur zum Ausprobieren"},
    {"id": "small", "label": "Schnell", "hint": "brauchbar bei klarem Hochdeutsch"},
    {"id": "medium", "label": "Ausgewogen", "hint": ""},
    {"id": "turbo", "label": "Schnell und gut", "hint": "nahe large-Qualitaet, deutlich schneller"},
    {"id": "large-v3", "label": "Beste Qualitaet", "hint": "langsamste, bester Dialekt"},
)
```

`DEFAULTS` erweitern:

```python
DEFAULTS = {"provider": "claude-cli", "model": "", "base_url": "", "api_key": "",
            "hf_token": "",
            # Whisper-Stufe und -Sprache. large-v3/de ist das bisherige Verhalten —
            # eine Verhaltensaenderung fuer Bestandsnutzer waere unnoetig.
            "whisper_model": "large-v3", "whisper_lang": "de"}
```

In `load()` vor dem `return` die Prüfung einziehen:

```python
    cfg = {**DEFAULTS, **{k: v for k, v in data.items()
                          if k in DEFAULTS and isinstance(v, str)}}
    if cfg["whisper_model"] not in KNOWN_WHISPER_MODELS:
        cfg["whisper_model"] = DEFAULTS["whisper_model"]
    return cfg
```

`public()` erweitern:

```python
    return {"provider": cfg["provider"], "model": cfg["model"],
            "base_url": cfg["base_url"], "has_key": bool(cfg["api_key"]),
            "has_hf_token": bool(cfg["hf_token"]),
            "whisper_model": cfg["whisper_model"], "whisper_lang": cfg["whisper_lang"]}
```

`job_env()` ersetzen:

```python
def job_env() -> dict:
    """Was die Job-Subprozesse aus den Einstellungen brauchen. Eine echte Umgebungsvariable
    gewinnt immer — wer HF_TOKEN oder WHISPER_MODEL gesetzt hat (webtool.ps1 aus der .env,
    CI), soll sie behalten."""
    cfg = load()
    paare = (("HF_TOKEN", "hf_token"), ("WHISPER_MODEL", "whisper_model"),
             ("WHISPER_LANG", "whisper_lang"))
    return {env: cfg[key] for env, key in paare
            if cfg[key] and not os.environ.get(env)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_settings.py webtool/test_jobs.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/settings.py webtool/test_settings.py
git commit -m "feat(settings): Whisper-Modell und -Sprache einstellbar

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `GET /api/hardware` und Whisper-Felder im Settings-Endpoint

**Files:**
- Modify: `webtool/app.py:15` (Import), `:249-255` (`SettingsBody`), `:257-262` (`get_settings`), neuer Endpoint
- Modify: `webtool/test_api.py` (Tests anhängen)

**Interfaces:**
- Consumes: `webtool.device.describe()` (Task 1), `settings.WHISPER_CHOICES` (Task 5)
- Produces: `GET /api/hardware` → `{"device": str, "name": str, "torch_ok": bool}`; `GET /api/settings` zusätzlich mit `whisper_model`, `whisper_lang`, `whisper_choices`

- [ ] **Step 1: Write the failing tests**

An `webtool/test_api.py` anhängen (Fixture-Namen der Datei übernehmen — dort heißt der Testclient `client`):

```python
def test_hardware_endpoint(client, monkeypatch):
    from webtool import app as appmod
    from webtool import device
    monkeypatch.setattr(appmod, "_HARDWARE", None)
    monkeypatch.setattr(device, "describe",
                        lambda: {"device": "cuda", "name": "RTX 5080", "torch_ok": True})
    r = client.get("/api/hardware")
    assert r.status_code == 200
    assert r.json()["device"] == "cuda"


def test_hardware_wird_gecacht(client, monkeypatch):
    """Der torch-Import kostet Sekunden — genau einmal pro Serverlauf."""
    from webtool import app as appmod
    from webtool import device
    rufe = []
    monkeypatch.setattr(appmod, "_HARDWARE", None)
    monkeypatch.setattr(device, "describe",
                        lambda: (rufe.append(1),
                                 {"device": "cpu", "name": "CPU", "torch_ok": True})[1])
    client.get("/api/hardware")
    client.get("/api/hardware")
    assert len(rufe) == 1


def test_settings_liefert_whisper_auswahl(client):
    r = client.get("/api/settings")
    body = r.json()
    assert body["whisper_model"] == "large-v3"
    assert any(c["id"] == "turbo" for c in body["whisper_choices"])


def test_settings_speichert_whisper_modell(client):
    r = client.put("/api/settings", json={"whisper_model": "turbo"})
    assert r.status_code == 200
    assert r.json()["whisper_model"] == "turbo"


def test_settings_lehnt_unbekanntes_whisper_modell_ab(client):
    r = client.put("/api/settings", json={"whisper_model": "gibt-es-nicht"})
    assert r.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -q -k "hardware or whisper"`
Expected: FAIL — 404 für `/api/hardware`, `KeyError: 'whisper_choices'`

- [ ] **Step 3: Write the implementation**

In `webtool/app.py` den Import erweitern (Zeile 15):

```python
from . import device, llm, paths, settings
```

(Die bestehende Importzeile beibehalten und `device` ergänzen — nicht die vorhandenen Importe umsortieren.)

Modulebene, neben die anderen Zustandsvariablen:

```python
# Einmal pro Serverlauf ermittelt: der torch-Import kostet Sekunden, und die Antwort
# aendert sich zur Laufzeit nicht — eine neue GPU erfordert ohnehin einen Neustart.
_HARDWARE = None
```

`SettingsBody` erweitern:

```python
class SettingsBody(BaseModel):
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None          # weggelassen = gespeicherten Key behalten
    hf_token: str | None = None         # fuer die Sprecher-Diarisierung (pyannote)
    whisper_model: str | None = None    # Qualitaetsstufe der Transkription
    whisper_lang: str | None = None
```

`get_settings` erweitern:

```python
@app.get("/api/settings")
def get_settings():
    """Nie den Key ausliefern — nur, OB einer hinterlegt ist."""
    return {**settings.public(), "providers": llm.provider_list(),
            "env_key": llm.env_key_hint(),
            "whisper_choices": list(settings.WHISPER_CHOICES)}
```

In `put_settings` nach der Anbieter-Prüfung ergänzen:

```python
    if "whisper_model" in patch and patch["whisper_model"] not in settings.KNOWN_WHISPER_MODELS:
        raise HTTPException(status_code=400,
                            detail=f"unbekanntes Whisper-Modell: {patch['whisper_model']}")
```

Neuen Endpoint neben die anderen Settings-Endpoints setzen:

```python
@app.get("/api/hardware")
def hardware():
    """Worauf gerechnet wird. 'Warum dauert das so lange' ist die haeufigste Frage —
    wer sieht, dass 'cpu' laeuft, hat die Antwort ohne Support."""
    global _HARDWARE
    if _HARDWARE is None:
        _HARDWARE = device.describe()
    return _HARDWARE
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): /api/hardware und Whisper-Stufe ueber die Einstellungen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `llm.available()` — kann überhaupt korrigiert werden?

**Files:**
- Modify: `webtool/llm.py` (neue Funktion nach `use_api`)
- Modify: `webtool/test_llm.py` (Tests anhängen)

**Interfaces:**
- Consumes: `llm._cfg()`, `llm._base_url()` (beide vorhanden)
- Produces: `llm.available() -> tuple[bool, str]` — `(nutzbar, Begründung)`; die Begründung ist leer, wenn nutzbar

Geprüft wird **Fähigkeit, nicht Absicht**: Ein frisch installierter Nutzer hat `claude-cli` als Voreinstellung (`_cfg()` fällt bei unbekanntem Anbieter sogar aktiv darauf zurück, `needs_key: False`), aber kein `claude`-Binary. Eine Default-Umstellung würde eine Migration für Bestandsnutzer erfordern; die Fähigkeitsprüfung braucht keine.

- [ ] **Step 1: Write the failing tests**

An `webtool/test_llm.py` anhängen:

```python
def test_available_abo_ohne_claude_binary(monkeypatch, tmp_path):
    """Der Erstnutzer-Fall: claude-cli ist Default, claude ist nicht installiert."""
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    monkeypatch.setattr(llm.shutil, "which", lambda n: None)
    ok, grund = llm.available()
    assert ok is False
    assert "Claude Code" in grund


def test_available_abo_mit_claude_binary(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    monkeypatch.setattr(llm.shutil, "which", lambda n: "C:/claude.cmd")
    assert llm.available() == (True, "")


def test_available_api_ohne_key(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    settings.save({"provider": "openai", "model": "gpt-4o"})
    ok, grund = llm.available()
    assert ok is False and "API-Key" in grund


def test_available_api_ohne_modell(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    settings.save({"provider": "openai", "api_key": "sk-x", "model": ""})
    ok, grund = llm.available()
    assert ok is False and "Modell" in grund


def test_available_api_vollstaendig(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    settings.save({"provider": "openai", "api_key": "sk-x", "model": "gpt-4o"})
    assert llm.available() == (True, "")


def test_available_custom_ohne_basis_url(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    settings.save({"provider": "custom", "model": "llama3", "base_url": ""})
    ok, grund = llm.available()
    assert ok is False and "Basis-URL" in grund
```

Am Kopf von `webtool/test_llm.py` sicherstellen, dass `settings` importiert ist (`from webtool import llm, settings`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_llm.py -q -k available`
Expected: FAIL — `AttributeError: module 'webtool.llm' has no attribute 'available'`

- [ ] **Step 3: Write the implementation**

In `webtool/llm.py` `import shutil` zu den Importen hinzufügen (der Test greift über `llm.shutil.which` darauf zu, deshalb das Modul importieren, nicht die Funktion).

Nach `use_api()` einfügen:

```python
def available() -> tuple:
    """(nutzbar, Begruendung) — prueft die FAEHIGKEIT zu korrigieren, nicht die Absicht.

    Ein frisch installierter Nutzer hat "claude-cli" als Voreinstellung und kein
    claude-Binary. Ohne diese Pruefung startet nach jedem Upload automatisch eine
    Korrektur, die scheitert — das waere der erste Eindruck der App. Ueber die
    Faehigkeit statt ueber einen anderen Default zu gehen erspart eine Migration:
    wer claude installiert hat, merkt nichts.
    """
    cfg, prov = _cfg()
    if prov["shape"] == "cli":
        if shutil.which("claude"):
            return True, ""
        return False, "Claude Code ist auf diesem Rechner nicht installiert."
    if prov["needs_key"] and not cfg["api_key"]:
        return False, f"Kein API-Key fuer {prov['label']} hinterlegt."
    if not _base_url(cfg, prov):
        return False, "Keine Basis-URL eingestellt."
    if not cfg["model"]:
        return False, "Kein Modell ausgewaehlt."
    return True, ""
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_llm.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/llm.py webtool/test_llm.py
git commit -m "feat(llm): available() prueft, ob ueberhaupt korrigiert werden kann

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Auto-Korrektur startet nicht ohne nutzbaren Anbieter

**Files:**
- Modify: `webtool/app.py:180-186` (`_autocorrect`), `:257-262` (`get_settings`)
- Modify: `webtool/test_api.py` (Tests anhängen)

**Interfaces:**
- Consumes: `llm.available()` aus Task 7
- Produces: `GET /api/settings` zusätzlich mit `ai_ready: bool`, `ai_reason: str`

- [ ] **Step 1: Write the failing tests**

An `webtool/test_api.py` anhängen:

```python
def test_autocorrect_startet_nicht_ohne_anbieter(client, monkeypatch):
    """Sonst scheitert nach jedem Upload ein Korrektur-Job — der erste Eindruck der App."""
    from webtool import app as appmod
    gestartet = []
    monkeypatch.setattr(appmod.llm, "available", lambda: (False, "kein claude"))
    monkeypatch.setattr(appmod.jobs, "request",
                        lambda *a, **k: gestartet.append(a) or ("id", True))
    appmod._autocorrect("Testprojekt")
    assert gestartet == []


def test_autocorrect_startet_mit_anbieter(client, monkeypatch):
    from webtool import app as appmod
    gestartet = []
    monkeypatch.setattr(appmod.llm, "available", lambda: (True, ""))
    monkeypatch.setattr(appmod.jobs, "request",
                        lambda *a, **k: gestartet.append(a) or ("id", True))
    appmod._autocorrect("Testprojekt")
    assert len(gestartet) == 1


def test_settings_meldet_ai_ready(client, monkeypatch):
    from webtool import app as appmod
    monkeypatch.setattr(appmod.llm, "available", lambda: (False, "kein claude"))
    body = client.get("/api/settings").json()
    assert body["ai_ready"] is False
    assert body["ai_reason"] == "kein claude"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -q -k "autocorrect or ai_ready"`
Expected: FAIL — `KeyError: 'ai_ready'`, und die Auto-Korrektur startet trotz fehlendem Anbieter

- [ ] **Step 3: Write the implementation**

`_autocorrect` in `webtool/app.py` ersetzen:

```python
def _autocorrect(project: str) -> None:
    """Korrektur nach der Transkription. Laeuft im Job-Thread, nicht im Browser — ein
    geschlossener Tab darf die Kette nicht unterbrechen. `correct run` ist idempotent, holt
    also genau die neu transkribierten Dateien nach."""
    if not _autocorrect_enabled():
        return
    ok, grund = llm.available()
    if not ok:
        # Kein Job statt eines Jobs, der scheitert: die Transkription ist fertig und
        # nutzbar, es fehlt nur die Korrektur. Eine Zeile ins Log, kein Fehlerzustand.
        print(f"[autocorrect] uebersprungen — {grund}", flush=True)
        return
    jobs.request(project, [sys.executable, "-m", "webtool.correct", "run", project],
                 paths.ROOT, "correct")
```

`get_settings` erweitern (auf dem Stand aus Task 6 aufsetzen):

```python
@app.get("/api/settings")
def get_settings():
    """Nie den Key ausliefern — nur, OB einer hinterlegt ist."""
    ai_ready, ai_reason = llm.available()
    return {**settings.public(), "providers": llm.provider_list(),
            "env_key": llm.env_key_hint(),
            "whisper_choices": list(settings.WHISPER_CHOICES),
            "ai_ready": ai_ready, "ai_reason": ai_reason}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool -q`
Expected: PASS (gesamte Suite)

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "fix(autocorrect): keinen Korrektur-Job starten, der sicher scheitert

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Einstellungsseite — Qualitätsstufe, Hardware, Anbieter-Hinweis

**Files:**
- Modify: `webtool/frontend/src/lib/types.ts:24-28`
- Modify: `webtool/frontend/src/lib/api.ts` (Funktion anhängen)
- Modify: `webtool/frontend/src/pages/SettingsPage.tsx`
- Modify: `webtool/frontend/src/pages/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/settings` (Tasks 6 + 8), `GET /api/hardware` (Task 6)
- Produces: nichts für spätere Tasks

- [ ] **Step 1: Write the failing test**

Die Datei hat bereits `BASIS` und `zeige()` — **beide erweitern statt eine neue Hilfe zu bauen.**

`BASIS` um die neuen Pflichtfelder ergänzen (sonst schlägt die Typprüfung in allen bestehenden Tests fehl):

```tsx
const BASIS: Settings = {
  provider: 'claude-cli', model: '', base_url: '', has_key: false, has_hf_token: false, env_key: '',
  whisper_model: 'large-v3', whisper_lang: 'de',
  whisper_choices: [
    { id: 'turbo', label: 'Schnell und gut', hint: 'nahe large-Qualität' },
    { id: 'large-v3', label: 'Beste Qualität', hint: 'bester Dialekt' },
  ],
  ai_ready: true, ai_reason: '',
  providers: [
    { id: 'claude-cli', label: 'Claude Code Abo (kein Key)', needs_key: false, base: '', default_model: '', keys_url: '', hint: 'Nutzt das Abo.' },
    { id: 'anthropic', label: 'Anthropic (Claude)', needs_key: true, base: 'https://api.anthropic.com/v1', default_model: 'claude-opus-5', keys_url: 'https://x', hint: '' },
  ],
}
```

`zeige()` um die Hardware-Antwort erweitern:

```tsx
const zeige = (s: Partial<Settings> = {}, hw: Hardware = { device: 'cuda', name: 'NVIDIA RTX 5080', torch_ok: true }) => {
  vi.mocked(api.getSettings).mockResolvedValue({ ...BASIS, ...s })
  vi.mocked(api.getHardware).mockResolvedValue(hw)
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>)
}
```

Import in der Testdatei ergänzen: `import type { Hardware, Settings } from '@/lib/types'`

Neue Tests anhängen:

```tsx
  it('zeigt die Whisper-Qualitätsstufe und das aktive Gerät', async () => {
    zeige()
    expect(await screen.findByText(/Qualität der Transkription/i)).toBeInTheDocument()
    expect(await screen.findByText(/NVIDIA RTX 5080/)).toBeInTheDocument()
  })

  it('warnt, wenn kein KI-Anbieter nutzbar ist', async () => {
    zeige({ ai_ready: false, ai_reason: 'Claude Code ist auf diesem Rechner nicht installiert.' })
    expect(await screen.findByText(/nicht installiert/)).toBeInTheDocument()
  })

  it('warnt bei large-v3 auf der CPU', async () => {
    zeige({ whisper_model: 'large-v3' }, { device: 'cpu', name: 'CPU', torch_ok: true })
    expect(await screen.findByText(/auf der CPU sehr lange/i)).toBeInTheDocument()
  })

  it('zeigt keine CPU-Warnung, wenn eine GPU rechnet', async () => {
    zeige({ whisper_model: 'large-v3' })
    await screen.findByText(/NVIDIA RTX 5080/)
    expect(screen.queryByText(/auf der CPU sehr lange/i)).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix webtool/frontend test -- SettingsPage`
Expected: FAIL — `getHardware` existiert nicht / Text nicht gefunden

- [ ] **Step 3: Write the implementation**

`webtool/frontend/src/lib/types.ts` — `Settings` erweitern und `Hardware` ergänzen:

```ts
export type WhisperChoice = { id: string; label: string; hint: string };
export type Hardware = { device: string; name: string; torch_ok: boolean };
export type Settings = {
  provider: string; model: string; base_url: string; has_key: boolean;
  has_hf_token: boolean; providers: ProviderInfo[]; env_key: string;
  whisper_model: string; whisper_lang: string; whisper_choices: WhisperChoice[];
  ai_ready: boolean; ai_reason: string;
};
```

`webtool/frontend/src/lib/api.ts` — neben `getSettings` ergänzen. Die Datei nutzt den Helfer `jn<T>(r: Response)`, der `!r.ok` in einen Fehler mit `detail` übersetzt:

```ts
export async function getHardware(): Promise<Hardware> {
  return jn(await fetch('/api/hardware'))
}
```

Den Typ-Import am Dateikopf um `Hardware` erweitern.

`SettingsPage.tsx` — Import erweitern:

```tsx
import { getHardware, getSettings, listModels, saveSettings, testSettings } from '@/lib/api'
import type { Hardware, ModelInfo, ProviderInfo, Settings } from '@/lib/types'
```

Zustand und Laden ergänzen (nach `const [testet, setTestet] = useState(false)`):

```tsx
  const [hw, setHw] = useState<Hardware | null>(null)

  useEffect(() => { getHardware().then(setHw).catch(() => setHw(null)) }, [])
```

Direkt unter der einleitenden `<p>` (nach Zeile 66) den Whisper-Block einfügen:

```tsx
      <div className="mb-8 rounded-md border p-4">
        <label className="mb-1 block text-sm font-medium">Qualität der Transkription</label>
        <Select value={s.whisper_model} onValueChange={m => speichern({ whisper_model: m })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {s.whisper_choices.map(c => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}{c.hint && ` — ${c.hint}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-2 text-xs text-muted-foreground">
          {hw
            ? <>Rechnet auf: <span className="font-medium">{hw.name}</span></>
            : 'Gerät wird ermittelt …'}
          {hw?.device === 'cpu' && (
            <span className="block text-amber-600 dark:text-amber-500">
              {s.whisper_model.startsWith('large')
                ? 'Ohne GPU braucht „Beste Qualität" auf der CPU sehr lange — für längere Interviews besser „Schnell und gut" wählen. '
                : ''}
              Wenn dieser Rechner eine NVIDIA-Grafikkarte hat, wurde PyTorch ohne CUDA
              installiert — dann die Umgebung neu einrichten.
            </span>
          )}
        </p>
      </div>

      {!s.ai_ready && (
        <div className="mb-6 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <span className="font-medium">Korrektur ist nicht eingerichtet.</span>{' '}
          {s.ai_reason} Die Transkription funktioniert trotzdem — nur die Korrektur und
          Sprecher-Zuordnung brauchen ein Sprachmodell.
        </div>
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix webtool/frontend test -- SettingsPage`
Expected: PASS

Dann den Build prüfen: `npm --prefix webtool/frontend run build`
Expected: kein TypeScript-Fehler

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src
git commit -m "feat(ui): Qualitaetsstufe, aktives Geraet und Anbieter-Hinweis

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Plattformabhängige Einrichtung (`electron/setup.js`)

**Files:**
- Modify: `electron/setup.js:17` (Konstante), `:104-156` (`einrichten`), `:87-98` (`status`)
- Create: `electron/setup.test.js`

**Interfaces:**
- Consumes: nichts
- Produces: `setup.plan(platform, paketmanager) -> {torchIndex: string|null, autoInstall: boolean, hinweis: string}`

**Warum auf macOS/Linux nicht automatisch installiert wird:** beides bräuchte `sudo` bzw. ein vorhandenes Homebrew. Eine GUI-App, die einen Passwort-Prompt für eine Systeminstallation öffnet oder ungefragt einen Paketmanager nachzieht, ist zu viel Magie. Auf Windows bleibt winget automatisch — er läuft ohne Adminrechte und ist dort die etablierte Erwartung.

- [ ] **Step 1: Write the failing test**

Create `electron/setup.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { plan } = require('./setup')

test('Windows: winget automatisch, torch aus dem CUDA-Index', () => {
  const p = plan('win32', '')
  assert.strictEqual(p.autoInstall, true)
  assert.match(p.torchIndex, /cu128/)
})

test('macOS: kein Automatismus, torch vom PyPI-Standardrad (bringt MPS mit)', () => {
  const p = plan('darwin', '')
  assert.strictEqual(p.autoInstall, false)
  assert.strictEqual(p.torchIndex, null)
  assert.match(p.hinweis, /brew install/)
})

test('Linux: erkannter Paketmanager steht im Hinweis', () => {
  assert.match(plan('linux', 'apt').hinweis, /apt install/)
  assert.match(plan('linux', 'dnf').hinweis, /dnf install/)
  assert.match(plan('linux', 'pacman').hinweis, /pacman -S/)
})

test('Linux ohne erkannten Paketmanager nennt trotzdem die Pakete', () => {
  const p = plan('linux', '')
  assert.strictEqual(p.autoInstall, false)
  assert.match(p.hinweis, /python3.*ffmpeg/s)
})

test('Linux zieht cu128 ohne vorherige NVIDIA-Erkennung', () => {
  assert.match(plan('linux', 'apt').torchIndex, /cu128/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/setup.test.js`
Expected: FAIL — `TypeError: plan is not a function`

- [ ] **Step 3: Write the implementation**

In `electron/setup.js` die Konstante `TORCH_INDEX` behalten und `plan` daneben ergänzen:

```js
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'

const LINUX_PAKETE = {
  apt: 'sudo apt install python3 python3-venv ffmpeg',
  dnf: 'sudo dnf install python3 ffmpeg',
  pacman: 'sudo pacman -S python ffmpeg',
}

/**
 * Was auf dieser Plattform zu tun ist — reine Funktion, damit die Entscheidung ohne
 * laufendes Electron pruefbar ist.
 *
 * Auf macOS/Linux installieren wir NICHT selbst: beides braeuchte sudo bzw. ein
 * vorhandenes Homebrew, und eine GUI-App, die dafuer einen Passwort-Prompt aufmacht,
 * ist zu viel Magie. Stattdessen zeigt die Statusseite den Befehl zum Kopieren.
 *
 * torch: macOS bekommt das normale PyPI-Rad — es bringt MPS mit, ein CUDA-Index
 * existiert dort gar nicht. Linux zieht cu128 ohne vorherige NVIDIA-Erkennung: die
 * Raeder installieren auch ohne Karte und fallen zur Laufzeit auf CPU zurueck.
 */
function plan(platform, paketmanager) {
  if (platform === 'win32') {
    return { torchIndex: TORCH_INDEX, autoInstall: true, hinweis: '' }
  }
  if (platform === 'darwin') {
    return {
      torchIndex: null,
      autoInstall: false,
      hinweis: 'Bitte einmalig installieren:  brew install python ffmpeg',
    }
  }
  const befehl = LINUX_PAKETE[paketmanager]
    || 'Bitte python3 (>= 3.10), python3-venv und ffmpeg ueber die Paketverwaltung installieren.'
  return { torchIndex: TORCH_INDEX, autoInstall: false, hinweis: `Bitte einmalig installieren:  ${befehl}` }
}

/** Welcher Paketmanager liegt auf diesem Linux? Leerstring, wenn keiner erkannt wird. */
async function paketmanager() {
  if (process.platform !== 'linux') return ''
  for (const p of ['apt', 'dnf', 'pacman']) {
    if (await ausgabe('which', [p])) return p
  }
  return ''
}
```

In `einrichten()` die Windows-Annahmen hinter den Plan hängen. Die Python-Installation (Zeilen 108-116) ersetzen:

```js
  const pm = await paketmanager()
  const pl = plan(process.platform, pm)

  if (!py && pl.autoInstall) {
    onSchritt('Python installieren')
    onLine('Python nicht gefunden — installiere Python 3.13 ueber winget …')
    const code = await lauf('winget', ['install', '-e', '--id', 'Python.Python.3.13',
      '--accept-package-agreements', '--accept-source-agreements'], onLine)
    if (code !== 0) return { ok: false, fehler: 'Python konnte nicht installiert werden. Bitte von python.org installieren und Transkribor neu starten.' }
    py = await findePython()
    if (!py) return { ok: false, fehler: 'Python wurde installiert, ist aber noch nicht im PATH. Bitte Transkribor neu starten.' }
  }
  if (!py) return { ok: false, fehler: `Kein Python >= 3.10 gefunden. ${pl.hinweis}` }
  schritte.push(`Python: ${py.version}`)
```

Den ffmpeg-Block (Zeilen 120-127) ersetzen:

```js
  if (!(await ausgabe(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']))) {
    if (pl.autoInstall) {
      onSchritt('ffmpeg installieren')
      onLine('ffmpeg nicht gefunden — installiere ueber winget …')
      // Nicht abbrechen wenn es scheitert: transcribe.ensure_ffmpeg() findet auch den winget-Pfad
      // ausserhalb des PATH, und ohne ffmpeg laeuft immerhin noch das Bearbeiten vorhandener Transkripte.
      await lauf('winget', ['install', '-e', '--id', 'Gyan.FFmpeg',
        '--accept-package-agreements', '--accept-source-agreements'], onLine)
    } else {
      onLine(`ffmpeg nicht gefunden. ${pl.hinweis}`)
    }
  }
```

Den torch-Block (Zeilen 140-146) ersetzen:

```js
  onSchritt(pl.torchIndex ? 'PyTorch mit CUDA laden (mehrere GB, dauert)'
                          : 'PyTorch laden (mehrere GB, dauert)')
  const torchArgs = ['-m', 'pip', 'install', 'torch']
  if (pl.torchIndex) torchArgs.push('--index-url', pl.torchIndex)
  let code = await lauf(vpy, torchArgs, onLine)
  if (code !== 0 && pl.torchIndex) {
    onLine('CUDA-Variante fehlgeschlagen — versuche die CPU-Variante (Transkription wird dann langsam).')
    code = await lauf(vpy, ['-m', 'pip', 'install', 'torch'], onLine)
  }
  if (code !== 0) return { ok: false, fehler: 'PyTorch konnte nicht installiert werden.' }
```

`status()` um den Hinweis erweitern, damit die Statusseite ihn anzeigen kann:

```js
async function status() {
  const py = await findePython()
  const ff = await ausgabe(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'])
  const pl = plan(process.platform, await paketmanager())
  return {
    python: py ? `Python ${py.version}` : '',
    ffmpeg: ff ? ff.split(/\r?\n/)[0].trim() : '',
    venv: await venvVollstaendig(),
    winget: process.platform === 'win32' ? (await ausgabe('winget', ['--version'])) || '' : '',
    venvPfad: P.venv,
    projektePfad: P.projekte,
    hinweis: (py && ff) ? '' : pl.hinweis,
  }
}
```

Export erweitern:

```js
module.exports = { status, einrichten, venvVollstaendig, findePython, plan }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test electron/setup.test.js`
Expected: PASS (5 Tests)

`electron/setup.js` lädt `./paths`, das `electron` importiert. Wirft der Require im Test, den `paths`-Import in `setup.js` **nicht** verschieben, sondern im Test vorab stubben:

```js
const Module = require('node:module')
const echt = Module._load
Module._load = (req, ...rest) =>
  req === 'electron' ? { app: { isPackaged: false, getPath: () => '/tmp' } } : echt(req, ...rest)
```

- [ ] **Step 5: Commit**

```bash
git add electron/setup.js electron/setup.test.js
git commit -m "feat(setup): Plattformzweige fuer macOS und Linux, plan() testbar

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Build-Targets für macOS und Linux

**Files:**
- Modify: `package.json` (`build`-Block), `"scripts"`

**Interfaces:**
- Consumes: nichts
- Produces: nichts

- [ ] **Step 1: Konfiguration ergänzen**

Im `build`-Block nach `"win"` einfügen:

```json
    "mac": {
      "target": [{ "target": "dmg", "arch": ["arm64"] }],
      "category": "public.app-category.productivity",
      "artifactName": "${productName}-${version}-${arch}.${ext}"
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "category": "AudioVideo",
      "artifactName": "${productName}-${version}.${ext}"
    },
```

Nur `arm64` für macOS: Intel-Macs haben weder CUDA noch Metal-tauglichen Whisper-Pfad und fallen damit ohnehin aus der Systemvoraussetzung.

- [ ] **Step 2: Test-Skript ergänzen**

In `"scripts"` aufnehmen, damit die JS-Tests einen Aufruf haben:

```json
    "test:electron": "node --test electron/",
```

- [ ] **Step 3: Konfiguration prüfen**

Run: `npx electron-builder --help > /dev/null && node -e "JSON.parse(require('fs').readFileSync('package.json')); console.log('package.json ist gueltiges JSON')"`
Expected: `package.json ist gueltiges JSON`

Run: `npm run test:electron`
Expected: PASS

- [ ] **Step 4: Windows-Build als Regression bauen**

Run: `npm run dist`
Expected: `dist\Transkribor-Setup-0.1.0.exe` entsteht weiterhin

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "build: dmg (arm64) und AppImage/deb als Ziele

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Prozessbaum-Abbruch auf macOS und Linux

**Files:**
- Modify: `webtool/jobs.py:126-130` (`Popen`), `:158-166` (`_kill_tree`)
- Modify: `webtool/test_jobs.py` (Test anhängen)

**Interfaces:**
- Consumes: nichts
- Produces: nichts

**Warum das dazugehört:** `_kill_tree` ruft auf POSIX nur `proc.terminate()` — das killt den direkten Python-Prozess, während Whisper- und `claude`-Kinder als Waisen mit belegter GPU weiterlaufen. Genau das verhindert `taskkill /T` auf Windows. Auf einer Plattform abbrechen zu können und auf der anderen nicht, ist für eine Cross-Platform-Freigabe kein haltbarer Zustand. Der vorhandene `ponytail:`-Kommentar in `jobs.py:165` benennt die Lösung bereits.

- [ ] **Step 1: Write the failing test**

An `webtool/test_jobs.py` anhängen:

```python
def test_popen_startet_eigene_sitzung_auf_posix(monkeypatch):
    """Ohne eigene Prozessgruppe erreicht der Abbruch die Kinder nicht."""
    import webtool.jobs as jobs
    monkeypatch.setattr(jobs.os, "name", "posix")
    assert jobs._popen_kwargs()["start_new_session"] is True


def test_popen_ohne_sitzung_auf_windows(monkeypatch):
    import webtool.jobs as jobs
    monkeypatch.setattr(jobs.os, "name", "nt")
    assert jobs._popen_kwargs().get("start_new_session", False) is False


def test_kill_tree_posix_nutzt_prozessgruppe(monkeypatch):
    import webtool.jobs as jobs
    getoetet = []

    class FakeProc:
        pid = 4711
        def terminate(self):
            getoetet.append("terminate")

    monkeypatch.setattr(jobs.os, "name", "posix")
    monkeypatch.setattr(jobs.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(jobs.os, "killpg", lambda pgid, sig: getoetet.append(("killpg", pgid)))
    jobs._kill_tree(FakeProc())
    assert getoetet == [("killpg", 4711)]


def test_kill_tree_posix_faellt_auf_terminate_zurueck(monkeypatch):
    """Prozess schon weg oder keine Rechte — nicht werfen, der Abbruch muss durchlaufen."""
    import webtool.jobs as jobs
    getoetet = []

    class FakeProc:
        pid = 4711
        def terminate(self):
            getoetet.append("terminate")

    def explodiere(*a):
        raise ProcessLookupError()

    monkeypatch.setattr(jobs.os, "name", "posix")
    monkeypatch.setattr(jobs.os, "getpgid", explodiere)
    jobs._kill_tree(FakeProc())
    assert getoetet == ["terminate"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_jobs.py -q -k "popen or kill_tree"`
Expected: FAIL — `AttributeError: module 'webtool.jobs' has no attribute '_popen_kwargs'`

- [ ] **Step 3: Write the implementation**

In `webtool/jobs.py` `import signal` zu den Importen hinzufügen und neben `_CREATE_NO_WINDOW` ergänzen:

```python
def _popen_kwargs() -> dict:
    """Auf POSIX eine eigene Prozessgruppe — nur so erreicht der Abbruch spaeter auch die
    Kinder (whisper, claude). Auf Windows leistet das taskkill /T, siehe _kill_tree."""
    return {} if os.name == "nt" else {"start_new_session": True}
```

Den `Popen`-Aufruf (Zeile 126-130) um `**_popen_kwargs()` erweitern:

```python
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=_CREATE_NO_WINDOW, env=env, **_popen_kwargs(),
        )
```

(Die vorhandenen Argumente unverändert lassen — nur `**_popen_kwargs()` anhängen.)

`_kill_tree` ersetzen:

```python
def _kill_tree(proc):
    if os.name == "nt":
        # /T killt den ganzen Prozessbaum (python -> [claude.cmd] -> claude/node -> MCP-Kinder);
        # ein blosses terminate() liesse den claude-Subtree verwaisen (vgl. correct.py:147-149).
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                       capture_output=True, creationflags=_CREATE_NO_WINDOW)  # exit!=0 (schon weg) ist ok
        return
    # Dasselbe auf POSIX: die Prozessgruppe aus _popen_kwargs() abraeumen. Ein blosses
    # terminate() liesse whisper/claude als Waisen mit belegter GPU zurueck.
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        proc.terminate()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool -q`
Expected: PASS (gesamte Suite)

- [ ] **Step 5: Commit**

```bash
git add webtool/jobs.py webtool/test_jobs.py
git commit -m "fix(jobs): Prozessbaum auch auf macOS/Linux abbrechen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Dokumentation und manuelle Prüfung auf allen drei Plattformen

**Files:**
- Modify: `CLAUDE.md` (Abschnitte „Umgebung (Fakten)" und „Desktop-App (Electron)")
- Modify: `README.md`

**Interfaces:**
- Consumes: alles Vorherige
- Produces: nichts

- [ ] **Step 1: `CLAUDE.md` nachziehen**

Im Abschnitt „Umgebung (Fakten)" ergänzen:

```markdown
- **Gerätewahl liegt in `webtool/device.py`** (`pick()` → cuda | mps | cpu), genutzt von
  `transcribe.py` und `webtool/diarize.py`. Upstream-Whisper kennt **kein MPS** — es wählt nur
  `cuda if torch.cuda.is_available() else cpu`. Scheitert MPS mitten in der Transkription,
  lädt `transcribe.py` das Modell **einmal** auf CPU neu und schreibt das ins Log;
  `PYTORCH_ENABLE_MPS_FALLBACK=1` setzen wir bewusst NICHT (schöbe einzelne Ops still auf die
  CPU, während die Anzeige weiter „mps" behauptet).
- **Whisper-Stufe und -Sprache stehen in den Einstellungen** (`whisper_model`, `whisper_lang`)
  und reisen über `settings.job_env()` → `jobs.py` → `transcribe.py`. Eine echte
  Umgebungsvariable `WHISPER_MODEL`/`WHISPER_LANG` gewinnt (wie bei `HF_TOKEN`). Default bleibt
  `large-v3`/`de`. Auswahl im Browser: tiny / small / medium / turbo / large-v3.
- **ffmpeg auf macOS:** GUI-Apps erben dort ein anderes `PATH` als die Shell — per `brew`
  installiertes ffmpeg liegt unter `/opt/homebrew/bin` und ist für die App sonst unsichtbar
  (`POSIX_FFMPEG_DIRS` in `transcribe.py`).
- **`llm.available()`** prüft, ob überhaupt korrigiert werden kann (claude auf dem PATH bzw.
  Key + Modell). Die Auto-Korrektur startet ohne nutzbaren Anbieter **gar nicht**, statt einen
  Job zu starten, der scheitert; `GET /api/settings` liefert `ai_ready`/`ai_reason` fürs
  Frontend. Geprüft wird die Fähigkeit, nicht die Einstellung — das erspart eine Migration.
- **`GET /api/hardware`** meldet das aktive Rechenwerk (einmal pro Serverlauf ermittelt).
```

Im Abschnitt „Desktop-App (Electron)" ergänzen:

```markdown
- `electron/setup.js` — `plan(platform, paketmanager)` entscheidet, was die Plattform braucht:
  Windows installiert Python/ffmpeg automatisch per winget, **macOS und Linux zeigen nur den
  Befehl zum Kopieren** (beides bräuchte sudo bzw. vorhandenes Homebrew — eine GUI-App, die
  dafür einen Passwort-Prompt öffnet, ist zu viel Magie). torch: cu128 auf Windows/Linux,
  PyPI-Standardrad auf macOS (bringt MPS mit; einen CUDA-Index gibt es dort nicht).
  Tests: `npm run test:electron` (`node --test`, keine Framework-Abhängigkeit).
- Build-Ziele: `nsis` (Windows), `dmg` arm64 (macOS), `AppImage`+`deb` (Linux).
```

- [ ] **Step 2: `README.md` um die Systemvoraussetzungen ergänzen**

```markdown
## Systemvoraussetzungen

Die Transkription läuft lokal auf deinem Rechner. Empfohlen:

- **Windows / Linux:** NVIDIA-GPU mit aktuellem Treiber
- **macOS:** Apple Silicon (M1 oder neuer)
- **Ohne GPU** läuft alles ebenfalls, aber deutlich langsamer — dann in den Einstellungen
  eine kleinere Qualitätsstufe als „Beste Qualität" wählen.

Die Korrektur und Sprecher-Zuordnung brauchen zusätzlich ein Sprachmodell (eigener API-Key,
lokales Modell über einen OpenAI-kompatiblen Endpunkt wie Ollama, oder ein Claude-Code-Abo).
**Ohne Sprachmodell funktioniert die Transkription vollständig** — nur die Korrektur entfällt.
```

- [ ] **Step 3: Gesamte Testsuite laufen lassen**

Run: `.venv\Scripts\python.exe -m pytest webtool -q`
Run: `npm --prefix webtool/frontend test`
Run: `npm run test:electron`
Expected: alles PASS

- [ ] **Step 4: Manuelle Prüfung — je Plattform ein vollständiger Lauf**

Diese Punkte sind **nicht automatisierbar** und müssen von Hand belegt werden. Ergebnisse hier notieren:

- [ ] **Windows + RTX 5080 (Regression):** Upload → Transkription → Korrektur wie bisher; `/api/hardware` meldet `cuda`; Abbrechen beendet den Prozessbaum (Task-Manager prüfen).
- [ ] **Apple Silicon:** Ersteinrichtung ab frischer venv; `/api/hardware` meldet `mps`; vollständige Transkription; Diarisierung; Abbrechen hinterlässt keine Waisen (`ps aux | grep -E "whisper|python"`).
- [ ] **Apple Silicon — Messung fürs Gate:** dieselbe Datei mit `large-v3` und `turbo`, je `mps` und `cpu`. Laufzeiten hier eintragen. Das Ergebnis entscheidet, ob `whisper.cpp`/Metal als zweites Backend nötig wird.
- [ ] **Linux-VM:** Ersteinrichtung; der Hinweis mit dem Paketbefehl erscheint statt eines stillen Fehlschlags; CPU-Transkription läuft durch.
- [ ] **Frischer Nutzer ohne Sprachmodell (beliebige Plattform):** Upload startet die Transkription, **kein** fehlschlagender Korrektur-Job; Einstellungsseite zeigt den `ai_reason`-Hinweis.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: Cross-Platform-Fakten und Systemvoraussetzungen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Nach dem Plan

Ist Task 13 belegt, geht es weiter mit **Spec 2 („Kommt bei Nutzern an")**: `LICENSE`, Repo öffentlich, CI-Matrix-Build, Notarisierung. Die Messung aus Task 13 entscheidet separat über ein zweites ASR-Backend — ohne Zahl wird es nicht gebaut.
