# URL-Import (YouTube + Instagram Reels) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** URLs von YouTube und Instagram Reels ins Eingabefeld einfügen → die Tonspuren landen als `.m4a` im Projekt und werden gezielt transkribiert.

**Architecture:** Der Import ist keine neue Pipeline, sondern eine zweite Quelle für den bestehenden Schreibpfad `projekte/<P>/audio/`. Ein neues Modul `webtool/fetch.py` lädt per yt-dlp, leitet aus dem Videotitel einen sicheren Dateinamen ab und ruft danach `transcribe.transcribe_project(..., only=[bases])` auf. Gestartet wird es als gewöhnlicher `jobs.py`-Job mit `kind="transcribe"`, wodurch GPU-Serialisierung, Abbrechen und Reload-Discovery unverändert greifen.

**Tech Stack:** Python 3.13 (`.venv`), yt-dlp, ffmpeg, FastAPI/pydantic, pytest — Frontend: React 19, TypeScript, Tailwind v4, vitest.

**Spec:** `docs/superpowers/specs/2026-08-01-transkribor-url-import-design.md`

## Global Constraints

- Branch ist `feat/url-import` (existiert bereits, Spec-Commit `d546e50`). Nicht auf `master` committen.
- Alle Python-Kommandos mit `E:\Git\Transkribor\.venv\Scripts\python.exe`, ausgeführt im Repo-Root.
- Commit-Messages enden mit `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Nichts unter `projekte\` committen** — Interviewdaten bleiben lokal.
- Erlaubte Hosts, exakt: `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`, `instagram.com`, `www.instagram.com`. Nur `https`.
- Zielformat ist `.m4a` — steht bereits in `AUDIO_EXT` und spielt im Browser-Player.
- Maximal 20 URLs pro Auftrag, maximal 80 Zeichen Basisname.
- Deutschsprachige Meldungen und Kommentare (Repo-Konvention).
- Es gibt **keine** `requirements.txt` — neue Abhängigkeiten werden ins `.venv` installiert und in `CLAUDE.md` dokumentiert.

---

## Datei-Übersicht

| Datei | Rolle |
|---|---|
| `transcribe.py` (ändern) | `find_audio()` bekommt einen `only=`-Filter; `transcribe_project()` reicht ihn durch |
| `webtool/test_transcribe.py` (neu) | Testet den Filter ohne torch/whisper zu laden |
| `webtool/fetch.py` (neu) | URL-Validierung, Titel→Dateiname, Download, anschließende Transkription |
| `webtool/test_fetch.py` (neu) | Reine Helfer + Treiber mit gefälschtem yt-dlp |
| `webtool/app.py` (ändern) | `POST /api/projects/{project}/fetch` |
| `webtool/test_api.py` (ändern) | Endpoint-Validierung |
| `frontend/src/lib/types.ts` (ändern) | `GlobalPhase` um `'download'` erweitern |
| `frontend/src/lib/api.ts` (ändern) | `fetchUrls()` |
| `frontend/src/lib/jobPhases.ts` (ändern) | `[fetch] …`-Zeilen → Phase `download` |
| `frontend/src/components/UrlFetch.tsx` (neu) | Textarea + Button „Holen" |
| `frontend/src/pages/ProjectWorkspace.tsx` (ändern) | Komponente einhängen, Label ergänzen |
| `CLAUDE.md` (ändern) | Feature + yt-dlp-Setup dokumentieren |

---

### Task 1: Datei-Filter in `transcribe.py`

Ohne diesen Filter würde ein importiertes Reel alle offenen Dateien des Projekts mit-transkribieren.

**Abweichung vom Spec §4 (bewusst):** Der Spec zeigt den Filter in `transcribe_project()`. Er kommt stattdessen in `find_audio()` — dieselbe Wirkung, aber `find_audio()` ist eine reine Funktion ohne den `import torch, whisper` am Anfang von `transcribe_project()`. Dadurch ist der Test in Millisekunden statt Sekunden fertig und braucht keine GPU. Der frühe Ausstieg vor `whisper.load_model()` bleibt erhalten, weil der bestehende `if not files`-Guard (`transcribe.py:70`) direkt hinter dem Aufruf steht.

**Files:**
- Modify: `transcribe.py:54-58` (`find_audio`), `transcribe.py:61` (Signatur), `transcribe.py:69` (Aufruf)
- Test: `webtool/test_transcribe.py` (neu)

**Interfaces:**
- Consumes: nichts
- Produces:
  - `find_audio(proj_dir: str, only: list[str] | None = None) -> list[str]`
  - `transcribe_project(name: str, model: str, language: str, only: list[str] | None = None) -> None`

- [ ] **Step 1: Write the failing test**

Create `webtool/test_transcribe.py`:

```python
"""Tests fuer den only=-Filter aus dem URL-Import (kein torch/whisper noetig)."""
import os

import transcribe


def _projekt(tmp_path, *namen):
    adir = tmp_path / "audio"
    adir.mkdir()
    for n in namen:
        (adir / n).write_bytes(b"x")
    return str(tmp_path)


def test_find_audio_ohne_only_liefert_alles(tmp_path):
    proj = _projekt(tmp_path, "a.mp3", "b.m4a", "notiz.txt")
    namen = [os.path.basename(f) for f in transcribe.find_audio(proj)]
    assert namen == ["a.mp3", "b.m4a"]          # .txt ist kein Audio


def test_find_audio_mit_only_filtert_auf_basisnamen(tmp_path):
    proj = _projekt(tmp_path, "a.mp3", "b.m4a", "c.wav")
    got = transcribe.find_audio(proj, only=["b", "c"])
    namen = sorted(os.path.basename(f) for f in got)
    assert namen == ["b.m4a", "c.wav"]


def test_find_audio_mit_leerem_only_liefert_nichts(tmp_path):
    # Wichtig: fuehrt in transcribe_project zum fruehen Ausstieg VOR whisper.load_model()
    proj = _projekt(tmp_path, "a.mp3")
    assert transcribe.find_audio(proj, only=[]) == []


def test_find_audio_only_unbekannter_name_ist_leer(tmp_path):
    proj = _projekt(tmp_path, "a.mp3")
    assert transcribe.find_audio(proj, only=["gibtsnicht"]) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -v`
Expected: FAIL — `TypeError: find_audio() got an unexpected keyword argument 'only'` (die erste Testfunktion ohne `only` läuft bereits durch).

- [ ] **Step 3: Write minimal implementation**

In `transcribe.py`, `find_audio` ersetzen:

```python
def find_audio(proj_dir, only=None):
    """Audiodateien des Projekts. only=[basisnamen] beschraenkt auf genau diese
    (URL-Import: nur das eben Geladene transkribieren, nicht das ganze Projekt)."""
    ad = audio_dir(proj_dir)
    files = [f for f in sorted(glob.glob(os.path.join(ad, "*")))
             if f.lower().endswith(AUDIO_EXT)]
    if only is not None:
        want = set(only)
        files = [f for f in files
                 if os.path.splitext(os.path.basename(f))[0] in want]
    return files
```

In `transcribe_project` die Signatur und den Aufruf anpassen (Zeilen 61 und 69):

```python
def transcribe_project(name, model, language, only=None):
```

```python
    files = find_audio(proj_dir, only)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -v`
Expected: 4 passed

Run: `.venv\Scripts\python.exe -m pytest webtool/ -q`
Expected: alle bestehenden Tests weiterhin grün (`main()` ruft `find_audio` einstellig auf → unverändert).

- [ ] **Step 5: Commit**

```bash
git add transcribe.py webtool/test_transcribe.py
git commit -m "feat(transcribe): only=-Filter fuer gezielte Transkription einzelner Dateien"
```

---

### Task 2: Reine Helfer in `webtool/fetch.py`

Nur Validierung und Namensableitung — kein Netzwerk, kein yt-dlp. Das ist die Trust-Boundary des Features.

**Files:**
- Create: `webtool/fetch.py`
- Test: `webtool/test_fetch.py`

**Interfaces:**
- Consumes: `paths.safe_name`, `paths.project_dir` (aus `webtool/paths.py`), `transcribe.AUDIO_EXT` (Task 1)
- Produces:
  - `ALLOWED_HOSTS: set[str]`
  - `check_url(url: str) -> str` — gibt die getrimmte URL zurück, wirft `ValueError` mit nutzerlesbarer Meldung
  - `safe_base(title: str, fallback: str) -> str`
  - `unique_base(adir: str, base: str) -> str`

- [ ] **Step 1: Write the failing test**

Create `webtool/test_fetch.py`:

```python
import pytest

from webtool import fetch


# --- check_url ---------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=abc123",
    "https://youtu.be/abc123",
    "https://m.youtube.com/watch?v=abc123",
    "https://www.instagram.com/reel/C8xY2pQr/",
    "  https://instagram.com/reel/C8xY2pQr/  ",     # wird getrimmt
])
def test_check_url_erlaubt_youtube_und_instagram(url):
    assert fetch.check_url(url) == url.strip()


@pytest.mark.parametrize("url", [
    "http://www.youtube.com/watch?v=abc123",         # kein https
    "https://vimeo.com/12345",                       # fremde Plattform
    "https://youtube.com.boese.example/watch?v=1",   # Host-Suffix-Trick
    "file:///C:/Windows/System32/drivers/etc/hosts", # kein http(s)
    "nonsens",
])
def test_check_url_lehnt_alles_andere_ab(url):
    with pytest.raises(ValueError):
        fetch.check_url(url)


# --- safe_base ---------------------------------------------------------------

def test_safe_base_transliteriert_umlaute():
    # 'raus' heisst umschreiben, nicht loeschen -- 'Mller' waere unlesbar
    assert fetch.safe_base("Interview mit Hans Müller", "yt-1") == "Interview mit Hans Mueller"
    assert fetch.safe_base("Grüße aus Zürich", "yt-1") == "Gruesse aus Zuerich"
    assert fetch.safe_base("ÄÖÜ Test", "yt-1") == "AeOeUe Test"


def test_safe_base_wirft_emoji_und_akzente_raus():
    assert fetch.safe_base("Reel 🎬 aus Bern", "yt-1") == "Reel aus Bern"
    assert fetch.safe_base("Café Niño", "yt-1") == "Cafe Nino"


def test_safe_base_ergebnis_ist_reines_ascii():
    got = fetch.safe_base("Ø 漢字 Ünter", "yt-1")
    assert got.isascii()


def test_safe_base_entfernt_pfad_und_windows_zeichen():
    got = fetch.safe_base('Best of: Bern/2024 <live> | "Teil 1"?', "yt-1")
    for verboten in '\\/:*?"<>|':
        assert verboten not in got
    assert "Bern" in got and "2024" in got


def test_safe_base_entfernt_punkte():
    # '..' waere von paths.safe_name verboten; einzelne Punkte wuerden splitext stoeren
    got = fetch.safe_base("Folge 2.1 ... Finale", "yt-1")
    assert "." not in got


def test_safe_base_kuerzt_auf_80_zeichen():
    got = fetch.safe_base("A" * 200, "yt-1")
    assert len(got) == 80


def test_safe_base_faellt_bei_leerem_ergebnis_zurueck():
    assert fetch.safe_base("🎬🎬🎬", "youtube-dQw4w9WgXcQ") == "youtube-dQw4w9WgXcQ"
    assert fetch.safe_base("", "youtube-dQw4w9WgXcQ") == "youtube-dQw4w9WgXcQ"


def test_safe_base_ergebnis_ueberlebt_safe_name():
    from webtool import paths
    got = fetch.safe_base("../../etc/passwd", "yt-1")
    assert paths.safe_name(got) == got


# --- unique_base -------------------------------------------------------------

def test_unique_base_ohne_kollision(tmp_path):
    assert fetch.unique_base(str(tmp_path), "Talk") == "Talk"


def test_unique_base_zaehlt_hoch(tmp_path):
    (tmp_path / "Talk.m4a").write_bytes(b"x")
    (tmp_path / "Talk-2.mp3").write_bytes(b"x")     # andere Endung zaehlt auch als belegt
    assert fetch.unique_base(str(tmp_path), "Talk") == "Talk-3"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_fetch.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'webtool.fetch'`

- [ ] **Step 3: Write minimal implementation**

Create `webtool/fetch.py`:

```python
"""URL-Import: YouTube-/Instagram-Audio in ein Projekt laden und transkribieren.

    python -m webtool.fetch <projekt> <url> [<url> ...]

Laedt je URL die beste Tonspur als .m4a nach projekte/<projekt>/audio/ und
transkribiert anschliessend GENAU diese Dateien (transcribe.py, only=).
`cwd` muss das Repo-Root sein (wie bei webtool.correct) -> `import transcribe`.
"""
import os
import re
import unicodedata
from urllib.parse import urlparse

import transcribe

from . import paths

# Trust-Boundary: die URL kommt aus dem Browser. Gleichzeitig der Feature-Scope.
ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
    "instagram.com", "www.instagram.com",
}
MAX_BASE = 80
# Pfadtrenner, unter Windows verbotene Zeichen und Steuerzeichen
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
# Dateinamen bleiben ASCII (Entscheidung Marcus): umschreiben statt loeschen.
_UMLAUTE = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
                          "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"})


def check_url(url: str) -> str:
    """Getrimmte URL, wenn erlaubt. Sonst ValueError mit nutzerlesbarer Meldung."""
    url = (url or "").strip()
    u = urlparse(url)
    if u.scheme != "https":
        raise ValueError(f"nur https-URLs werden unterstützt: {url!r}")
    if (u.hostname or "").lower() not in ALLOWED_HOSTS:
        raise ValueError(f"nicht unterstützte Plattform: {u.hostname or url!r} "
                         f"(erlaubt sind YouTube und Instagram)")
    return url


def safe_base(title: str, fallback: str) -> str:
    """Videotitel -> ASCII-Dateiname, der paths.safe_name() ueberlebt.

    Umlaute werden umgeschrieben (Mueller, nicht Mller), alles uebrige Nicht-ASCII
    (Emoji, Akzente, fremde Schriften) faellt weg. Hart auf MAX_BASE gekuerzt.
    """
    s = unicodedata.normalize("NFC", title or "").translate(_UMLAUTE)
    # NFKD zerlegt é -> e+Akzent, 'ignore' wirft den Akzent und alles Uebrige weg.
    # MUSS nach dem translate stehen, sonst wuerde ü ueber u+Trema zu 'u' statt 'ue'.
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = _BAD.sub(" ", s)          # ersetzen statt loeschen -> keine Wortverklebung
    s = s.replace(".", " ")       # '..' verbietet safe_name; einzelne Punkte stoeren splitext
    s = re.sub(r"\s+", " ", s).strip(" -")
    s = s[:MAX_BASE].strip(" -")  # harter Schnitt, danach erneut trimmen
    return paths.safe_name(s or fallback)   # letzte Instanz; wirft nur bei einem Bug


def unique_base(adir: str, base: str) -> str:
    """base, base-2, base-3 … bis im Verzeichnis keine Audiodatei so heisst."""
    cand, n = base, 1
    while any(os.path.exists(os.path.join(adir, cand + e)) for e in transcribe.AUDIO_EXT):
        n += 1
        cand = f"{base}-{n}"
    return cand
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_fetch.py -v`
Expected: alle passed

- [ ] **Step 5: Commit**

```bash
git add webtool/fetch.py webtool/test_fetch.py
git commit -m "feat(fetch): URL-Whitelist und Titel-zu-Dateiname-Ableitung"
```

---

### Task 3: Download-Treiber in `webtool/fetch.py`

**Files:**
- Modify: `webtool/fetch.py` (Ergänzungen)
- Test: `webtool/test_fetch.py` (Ergänzungen)

**Interfaces:**
- Consumes: `check_url`, `safe_base`, `unique_base` (Task 2); `transcribe.transcribe_project(name, model, language, only=…)` und `transcribe.ensure_ffmpeg()` (Task 1)
- Produces:
  - `download_one(project: str, url: str) -> str` — liefert den Basisnamen der geschriebenen Datei
  - `main(argv: list[str] | None = None) -> None` — Exit 1, wenn **keine** URL geladen werden konnte

- [ ] **Step 1: yt-dlp installieren**

Run: `.venv\Scripts\python.exe -m pip install yt-dlp`
Expected: „Successfully installed yt-dlp-…"

Run: `.venv\Scripts\python.exe -c "import yt_dlp; print(yt_dlp.version.__version__)"`
Expected: eine Versionsnummer

- [ ] **Step 2: Write the failing test**

An `webtool/test_fetch.py` anhängen:

```python
# --- Treiber (yt-dlp gefaelscht, kein Netzwerk) ------------------------------

class _FakeYDL:
    """Minimalersatz fuer yt_dlp.YoutubeDL. Klassenattribute steuern das Verhalten."""
    title = "Mein Interview"
    video_id = "vid123"
    fehler = None          # Exception-Instanz -> wird beim Download geworfen

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=False):
        if download:
            if _FakeYDL.fehler is not None:
                raise _FakeYDL.fehler
            pfad = self.opts["outtmpl"].replace("%(ext)s", "m4a")
            with open(pfad, "wb") as fh:
                fh.write(b"fake-m4a")
        return {"title": _FakeYDL.title, "id": _FakeYDL.video_id, "ext": "m4a"}


class _FakeYtDlp:
    YoutubeDL = _FakeYDL


@pytest.fixture
def projekt(monkeypatch, tmp_path):
    """Leeres Projekt 'Demo' + gefaelschtes yt-dlp; setzt die Fake-Steuerung zurueck."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    (tmp_path / "Demo" / "audio").mkdir(parents=True)
    monkeypatch.setattr(fetch, "yt_dlp", _FakeYtDlp)
    _FakeYDL.title, _FakeYDL.video_id, _FakeYDL.fehler = "Mein Interview", "vid123", None
    return tmp_path


def test_download_one_legt_m4a_unter_titelnamen_ab(projekt):
    base = fetch.download_one("Demo", "https://youtu.be/vid123")
    assert base == "Mein Interview"
    assert (projekt / "Demo" / "audio" / "Mein Interview.m4a").exists()


def test_download_one_weicht_bei_kollision_aus(projekt):
    (projekt / "Demo" / "audio" / "Mein Interview.m4a").write_bytes(b"alt")
    base = fetch.download_one("Demo", "https://youtu.be/vid123")
    assert base == "Mein Interview-2"
    assert (projekt / "Demo" / "audio" / "Mein Interview.m4a").read_bytes() == b"alt"


def test_download_one_ohne_yt_dlp_meldet_klar(projekt, monkeypatch):
    monkeypatch.setattr(fetch, "yt_dlp", None)
    with pytest.raises(RuntimeError, match="yt-dlp"):
        fetch.download_one("Demo", "https://youtu.be/vid123")


def test_main_transkribiert_nur_die_geladenen(projekt, monkeypatch):
    gerufen = {}
    monkeypatch.setattr(transcribe_mod, "transcribe_project",
                        lambda name, model, lang, only=None: gerufen.update(name=name, only=only))
    monkeypatch.setattr(transcribe_mod, "ensure_ffmpeg", lambda: True)
    fetch.main(["Demo", "https://youtu.be/vid123"])
    assert gerufen["name"] == "Demo"
    assert gerufen["only"] == ["Mein Interview"]


def test_main_ohne_erfolg_exit_1_und_ohne_whisper(projekt, monkeypatch):
    _FakeYDL.fehler = RuntimeError("ERROR: Sign in to confirm you are not a bot")
    monkeypatch.setattr(transcribe_mod, "transcribe_project",
                        lambda *a, **k: pytest.fail("Whisper darf ohne Datei nicht starten"))
    with pytest.raises(SystemExit) as exc:
        fetch.main(["Demo", "https://youtu.be/vid123"])
    assert exc.value.code == 1


def test_main_teilerfolg_transkribiert_den_rest(projekt, monkeypatch, capsys):
    gerufen = {}
    monkeypatch.setattr(transcribe_mod, "transcribe_project",
                        lambda name, model, lang, only=None: gerufen.update(only=only))
    monkeypatch.setattr(transcribe_mod, "ensure_ffmpeg", lambda: True)
    # zweite URL ist eine fremde Plattform -> scheitert an check_url, erste laeuft durch
    fetch.main(["Demo", "https://youtu.be/vid123", "https://vimeo.com/1"])
    assert gerufen["only"] == ["Mein Interview"]
    assert "FEHLER" in capsys.readouterr().out


def test_login_fehler_wird_uebersetzt(projekt, capsys):
    _FakeYDL.fehler = RuntimeError("ERROR: Requested content is not available, login required")
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://www.instagram.com/reel/C8xY2pQr/"])
    assert "nicht öffentlich abrufbar" in capsys.readouterr().out
```

Dazu ganz oben in `webtool/test_fetch.py` den Import ergänzen (neben den bestehenden):

```python
import transcribe as transcribe_mod
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_fetch.py -v`
Expected: FAIL — `AttributeError: module 'webtool.fetch' has no attribute 'yt_dlp'` bzw. `has no attribute 'download_one'`

- [ ] **Step 4: Write minimal implementation**

In `webtool/fetch.py` die Imports ergänzen:

```python
import argparse
import sys
```

Nach den Konstanten einfügen:

```python
try:
    import yt_dlp
except ImportError:            # Feature ist optional -> Server und Tests laufen trotzdem
    yt_dlp = None

_PIP_HINWEIS = r".venv\Scripts\python.exe -m pip install -U yt-dlp"
# Instagram/YouTube melden Login-Zwang in vielen Formulierungen; hier grob abgedeckt.
_LOGIN_RE = re.compile(r"login|log in|sign in|private|not available|rate.?limit|cookies|bot", re.I)


def _human_error(exc: Exception) -> str:
    """yt-dlp-Rauschen -> ein Satz, der Marcus sagt, was zu tun ist."""
    roh = str(exc).strip()
    msg = roh.splitlines()[-1] if roh else exc.__class__.__name__
    if _LOGIN_RE.search(msg):
        return "Video ist nicht öffentlich abrufbar (Login nötig)"
    return f"{msg} — bei Instagram hilft oft: {_PIP_HINWEIS}"


def _ydl_opts(outtmpl: str) -> dict:
    return {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": outtmpl,
        # m4a steht in AUDIO_EXT und spielt im Browser; YouTubes Default waere Opus-in-.webm
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
        "noplaylist": True,        # ?list=… nicht als ganze Playlist auffassen
        "quiet": True, "no_warnings": True, "noprogress": True, "retries": 3,
    }


def download_one(project: str, url: str) -> str:
    """Laedt die Tonspur nach projekte/<project>/audio/. Liefert den Basisnamen."""
    if yt_dlp is None:
        raise RuntimeError(f"yt-dlp ist nicht installiert — {_PIP_HINWEIS}")
    adir = os.path.join(paths.project_dir(project), "audio")
    os.makedirs(adir, exist_ok=True)

    # ponytail: zwei yt-dlp-Aufrufe (Metadaten, dann Download) — kostet einen Roundtrip,
    # dafuer steht der Dateiname VOR dem Download fest und Kollisionen sind sauber loesbar.
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    plattform = "youtube" if "youtu" in (urlparse(url).hostname or "") else "instagram"
    base = unique_base(adir, safe_base(info.get("title") or "",
                                       f"{plattform}-{info.get('id') or 'video'}"))

    print(f"[fetch] lade {base} …", flush=True)
    with yt_dlp.YoutubeDL(_ydl_opts(os.path.join(adir, base + ".%(ext)s"))) as ydl:
        ydl.extract_info(url, download=True)
    print(f"[fetch] fertig {base}", flush=True)
    return base


def main(argv=None):
    try:  # Umlaute/… auch bei umgeleitetem stdout auf non-UTF-8-Windows nicht crashen
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description="URL-Import (YouTube/Instagram) fuer ein Projekt")
    ap.add_argument("project")
    ap.add_argument("urls", nargs="+")
    args = ap.parse_args(argv)
    paths.safe_name(args.project)

    geladen = []
    for url in args.urls:
        try:
            geladen.append(download_one(args.project, check_url(url)))
        except Exception as e:
            print(f"[fetch] FEHLER {url}: {_human_error(e)}", flush=True)
    print(f"[fetch] {len(geladen)} von {len(args.urls)} geladen", flush=True)
    if not geladen:
        raise SystemExit(1)      # Job-Status 'error'; Whisper wird gar nicht erst geladen

    transcribe.ensure_ffmpeg()
    transcribe.transcribe_project(args.project,
                                  os.environ.get("WHISPER_MODEL", "large-v3"),
                                  os.environ.get("WHISPER_LANG", "de"),
                                  only=geladen)


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_fetch.py -v`
Expected: alle passed

- [ ] **Step 6: Commit**

```bash
git add webtool/fetch.py webtool/test_fetch.py
git commit -m "feat(fetch): Download-Treiber mit gezielter Transkription der geladenen Dateien"
```

---

### Task 4: Endpoint `POST /api/projects/{project}/fetch`

**Files:**
- Modify: `webtool/app.py` (Import oben, neuer Endpoint nach `correct_file`, ~Zeile 188)
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `fetch.check_url` (Task 2), `jobs.start` (bestehend)
- Produces: `POST /api/projects/{project}/fetch` mit Body `{"urls": [str, …]}` → `{"job_id": str, "started": bool}`

- [ ] **Step 1: Write the failing test**

An `webtool/test_api.py` anhängen:

```python
def test_fetch_startet_job(client, monkeypatch):
    from webtool import jobs
    gestartet = {}
    monkeypatch.setattr(jobs, "start",
                        lambda project, cmd, cwd, kind: gestartet.update(cmd=cmd, kind=kind) or ("j1", True))
    r = client.post("/api/projects/Demo/fetch", json={"urls": ["https://youtu.be/abc123"]})
    assert r.status_code == 200 and r.json() == {"job_id": "j1", "started": True}
    assert gestartet["kind"] == "transcribe"          # erbt GPU-Serialisierung + Dedupe
    assert gestartet["cmd"][-2:] == ["Demo", "https://youtu.be/abc123"]


def test_fetch_lehnt_fremde_plattform_ab(client):
    r = client.post("/api/projects/Demo/fetch", json={"urls": ["https://vimeo.com/1"]})
    assert r.status_code == 400
    assert "vimeo.com" in r.json()["detail"]


def test_fetch_ohne_url_400(client):
    assert client.post("/api/projects/Demo/fetch", json={"urls": ["  "]}).status_code == 400


def test_fetch_zu_viele_urls_400(client):
    urls = [f"https://youtu.be/v{i}" for i in range(21)]
    r = client.post("/api/projects/Demo/fetch", json={"urls": urls})
    assert r.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -k fetch -v`
Expected: FAIL — 404 statt 200/400 (Endpoint existiert nicht; die SPA-Catch-all-Route greift nicht für POST)

- [ ] **Step 3: Write minimal implementation**

In `webtool/app.py` bei den Imports ergänzen:

```python
from . import fetch as fetch_mod
```

Konstante neben `AUDIO_EXT` (Zeile 19) ergänzen:

```python
MAX_FETCH_URLS = 20
```

Nach `correct_file` (nach Zeile 187) einfügen:

```python
class FetchBody(BaseModel):
    urls: list[str]


@app.post("/api/projects/{project}/fetch")
def fetch_urls(project: str, body: FetchBody):
    """URL-Import: laedt Audio von YouTube/Instagram und transkribiert genau diese Dateien."""
    _validate(project)
    urls = [u.strip() for u in body.urls if u.strip()]
    if not urls:
        raise HTTPException(status_code=400, detail="keine URL angegeben")
    if len(urls) > MAX_FETCH_URLS:
        raise HTTPException(status_code=400,
                            detail=f"maximal {MAX_FETCH_URLS} URLs pro Auftrag")
    try:
        urls = [fetch_mod.check_url(u) for u in urls]   # zweite Instanz: fetch.py prueft erneut
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    cmd = [sys.executable, "-m", "webtool.fetch", project, *urls]
    job_id, started = jobs.start(project, cmd, paths.ROOT, "transcribe")
    return {"job_id": job_id, "started": started}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest webtool/ -q`
Expected: alle passed

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): POST /api/projects/{project}/fetch fuer den URL-Import"
```

---

### Task 5: Frontend-Anbindung (Typen, API, Phasenparser)

**Files:**
- Modify: `frontend/src/lib/types.ts:20`, `frontend/src/lib/api.ts`, `frontend/src/lib/jobPhases.ts:20-26`
- Test: `frontend/src/lib/jobPhases.test.ts`

Alle Pfade relativ zu `webtool/frontend/`.

**Interfaces:**
- Consumes: `POST …/fetch` (Task 4)
- Produces:
  - `fetchUrls(project: string, urls: string[]): Promise<StartJob>`
  - `GlobalPhase` enthält zusätzlich `'download'`

- [ ] **Step 1: Write the failing test**

An `webtool/frontend/src/lib/jobPhases.test.ts` anhängen:

```ts
describe('URL-Import', () => {
  it('meldet Herunterladen und danach die Transkription', () => {
    const p = parseJobPhases('transcribe', [
      '[fetch] lade Mein Interview …',
    ])
    expect(p.global).toBe('download')
    expect(p.active).toBeNull()
  })

  it('beendet die Download-Phase nach der Bilanzzeile', () => {
    const p = parseJobPhases('transcribe', [
      '[fetch] lade Mein Interview …',
      '[fetch] fertig Mein Interview',
      '[fetch] 1 von 1 geladen',
      '[Demo] -> transkribiere Mein Interview …',
    ])
    expect(p.global).toBeNull()
    expect(p.active).toEqual({ base: 'Mein Interview', phase: 'transcribe' })
  })

  it('haelt eine fetch-FEHLER-Zeile aus der perBase-Auswertung heraus', () => {
    // '[fetch] FEHLER <url>: …' darf NICHT als Datei-Fehlschlag gelesen werden
    const p = parseJobPhases('transcribe', [
      '[fetch] FEHLER https://youtu.be/x: Video ist nicht öffentlich abrufbar (Login nötig)',
      '[fetch] 0 von 1 geladen',
    ])
    expect(p.perBase).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix webtool/frontend run test -- jobPhases`
Expected: FAIL — `global` ist `null` statt `'download'`; der dritte Test schlägt fehl, weil `perBase` einen Eintrag mit der URL als Basisnamen enthält.

- [ ] **Step 3: Write the implementation**

In `webtool/frontend/src/lib/types.ts` Zeile 20 ersetzen:

```ts
export type GlobalPhase = 'diarize' | 'prep' | 'glossary' | 'download';
```

In `webtool/frontend/src/lib/jobPhases.ts` im `kind === 'transcribe'`-Block **als erste Prüfung** einfügen (vor der `-> transkribiere`-Zeile):

```ts
    if (kind === 'transcribe') {
      // MUSS vor den Regexen unten stehen: '[fetch] FEHLER <url>: …' wuerde sonst von
      // /^\[.+?\] FEHLER (.+?): / als Datei-Fehlschlag mit der URL als Basisnamen gelesen.
      if (l.startsWith('[fetch] ')) {
        if (/^\[fetch\] \d+ von \d+ geladen$/.test(l)) global = null
        else { active = null; global = 'download' }
        continue
      }
      if ((m = l.match(/^\[.+?\] -> transkribiere (.+) …$/))) { active = { base: m[1], phase: 'transcribe' }; global = null }
```

In `webtool/frontend/src/lib/api.ts` ergänzen:

```ts
export async function fetchUrls(project: string, urls: string[]): Promise<StartJob> {
  return jn(await fetch(`/api/projects/${enc(project)}/fetch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls }),
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix webtool/frontend run test`
Expected: alle passed

Run: `npm --prefix webtool/frontend run build`
Expected: TypeScript kompiliert fehlerfrei

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/lib
git commit -m "feat(web): fetchUrls-Client und download-Phase im Job-Parser"
```

---

### Task 6: Eingabefeld `UrlFetch` in der Arbeitsfläche

**Files:**
- Create: `webtool/frontend/src/components/UrlFetch.tsx`, `webtool/frontend/src/components/UrlFetch.test.tsx`
- Modify: `webtool/frontend/src/pages/ProjectWorkspace.tsx:13` (Label) und `:59-61` (Einbau)

**Interfaces:**
- Consumes: `fetchUrls` (Task 5), `StartJob` (`lib/types.ts`)
- Produces: `<UrlFetch project={string} onStart={(res: StartJob) => void} />` — `onStart` wird nur bei erfolgreicher Antwort gerufen

- [ ] **Step 1: Write the failing test**

Create `webtool/frontend/src/components/UrlFetch.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UrlFetch } from './UrlFetch'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('UrlFetch', () => {
  it('schickt mehrere Zeilen als URL-Liste und meldet den Start', async () => {
    vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j1', started: true })
    const onStart = vi.fn()
    render(<UrlFetch project="Demo" onStart={onStart} />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), {
      target: { value: 'https://youtu.be/a\n\n  https://www.instagram.com/reel/b/  \n' },
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalledWith(
      'Demo', ['https://youtu.be/a', 'https://www.instagram.com/reel/b/']))  // Leerzeilen raus, getrimmt
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ job_id: 'j1', started: true }))
  })

  it('zeigt die Serverbegruendung und ruft onStart nicht', async () => {
    vi.mocked(api.fetchUrls).mockRejectedValue(new Error('nicht unterstützte Plattform: vimeo.com'))
    const onStart = vi.fn()
    render(<UrlFetch project="Demo" onStart={onStart} />)
    fireEvent.change(screen.getByLabelText('Video-URLs'), { target: { value: 'https://vimeo.com/1' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /holen/i })) })
    await waitFor(() => expect(screen.getByText(/nicht unterstützte Plattform/)).toBeInTheDocument())
    expect(onStart).not.toHaveBeenCalled()
  })

  it('bleibt ohne Eingabe untaetig', () => {
    render(<UrlFetch project="Demo" onStart={vi.fn()} />)
    expect(screen.getByRole('button', { name: /holen/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix webtool/frontend run test -- UrlFetch`
Expected: FAIL — `Failed to resolve import "./UrlFetch"`

- [ ] **Step 3: Write the implementation**

Create `webtool/frontend/src/components/UrlFetch.tsx`:

```tsx
import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { fetchUrls } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { StartJob } from '@/lib/types'

export function UrlFetch({ project, onStart }: { project: string; onStart: (res: StartJob) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const urls = text.split('\n').map(u => u.trim()).filter(Boolean)

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const res = await fetchUrls(project, urls)
      setText('')
      onStart(res)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded border p-3">
      <label htmlFor="url-fetch" className="mb-1 block text-sm text-muted-foreground">
        Video-URLs
      </label>
      <textarea
        id="url-fetch" aria-label="Video-URLs" rows={2} value={text} disabled={busy}
        onChange={e => setText(e.target.value)}
        placeholder="YouTube- oder Instagram-Reel-Links, eine URL pro Zeile"
        className="w-full resize-y rounded border bg-background p-2 text-sm"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={!urls.length || busy} onClick={submit}>
          <Link2 className="size-4" /> {busy ? 'startet…' : 'Holen'}
        </Button>
        {urls.length > 1 && (
          <span className="text-xs text-muted-foreground">{urls.length} URLs</span>
        )}
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix webtool/frontend run test -- UrlFetch`
Expected: 3 passed

- [ ] **Step 5: In die Arbeitsfläche einhängen**

In `webtool/frontend/src/pages/ProjectWorkspace.tsx`:

Import ergänzen:

```tsx
import { UrlFetch } from '@/components/UrlFetch'
```

Zeile 13 ersetzen:

```tsx
const GLOBAL_LABEL = { diarize: 'Diarisieren…', prep: 'Vorbereiten…', glossary: 'Glossar wird erstellt…', download: 'Herunterladen…' } as const
```

Den Upload-Block (Zeilen 59-61) ersetzen:

```tsx
      <div className="mb-4 space-y-3">
        <UploadDropzone project={project!} onDone={refresh} />
        <UrlFetch project={project!} onStart={res => {
          if (!res.started) { toast.warning('Es läuft bereits ein Job für dieses Projekt.'); return }
          adopt(res.job_id, project!, 'transcribe')
          toast.success('Herunterladen gestartet')
        }} />
      </div>
```

Die Leerzustands-Zeile (vormals Zeile 64) an die neue Quelle anpassen:

```tsx
        <p className="text-sm text-muted-foreground">Noch keine Dateien — lade Audio hoch, füge eine Video-URL ein und transkribiere.</p>
```

- [ ] **Step 6: Run the full frontend suite**

Run: `npm --prefix webtool/frontend run test`
Expected: alle passed (auch `ProjectWorkspace.test.tsx`)

Run: `npm --prefix webtool/frontend run build`
Expected: kompiliert fehlerfrei

- [ ] **Step 7: Commit**

```bash
git add webtool/frontend/src
git commit -m "feat(web): URL-Eingabefeld in der Projekt-Arbeitsflaeche"
```

---

### Task 7: End-to-End-Verifikation und Dokumentation

Erst hier wird echtes Netzwerk benutzt. Vorher nie.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Server starten**

Run: `.\webtool.ps1`
Expected: Frontend wird gebaut (falls nötig), uvicorn lauscht auf `:8000`, Browser öffnet sich.
**Wichtig:** immer über `webtool.ps1` starten — nur dort wird `.env` (u.a. `HF_TOKEN`) geladen.

- [ ] **Step 2: YouTube-Import prüfen**

Im Browser ein Testprojekt anlegen, eine kurze, öffentliche YouTube-URL einfügen, „Holen" klicken.

Erwartet:
1. Pille „Herunterladen…" erscheint
2. Datei taucht mit lesbarem Titel in der Liste auf
3. Status wechselt zu „transkribiert" — und **keine** andere Datei des Projekts wird angefasst
4. `projekte\<Test>\audio\<Titel>.m4a` existiert und ist im Editor abspielbar

- [ ] **Step 3: Instagram-Reel prüfen**

Öffentliches Reel einfügen. Erwartet: identischer Ablauf.
Bei Fehlschlag im Job-Log prüfen, ob die Meldung verständlich ist. Bricht der Extraktor, ist `.venv\Scripts\python.exe -m pip install -U yt-dlp` der erste Versuch.

- [ ] **Step 4: Fehlerfall prüfen**

Eine private/gelöschte Instagram-URL einfügen. Erwartet: Job endet als Fehler, Log enthält „Video ist nicht öffentlich abrufbar (Login nötig)", Whisper startet nicht.

- [ ] **Step 5: `CLAUDE.md` ergänzen**

Unter „Umgebung (Fakten)" als neuen Punkt:

```markdown
- URL-Import (YouTube/Instagram): `webtool/fetch.py` (yt-dlp) lädt die Tonspur als `.m4a`
  nach `projekte\<NAME>\audio\` und transkribiert anschliessend **nur** diese Dateien
  (`transcribe.find_audio(..., only=[...])`). Start im Web-Tool über das Feld „Video-URLs"
  (mehrere URLs, eine pro Zeile) oder per CLI:
  `python -m webtool.fetch "<NAME>" <url> [<url> ...]` (cwd = Repo-Root).
  Endpoint: `POST /api/projects/{p}/fetch` `{urls:[...]}` → Job mit `kind="transcribe"`
  (teilt sich damit GPU-Serialisierung und Ein-Job-pro-Projekt-Dedupe). Nur `https` und nur
  YouTube/Instagram (Whitelist in `webtool/fetch.py:ALLOWED_HOSTS`); Login-pflichtige
  Inhalte werden bewusst nicht unterstützt. **Einmal-Setup:** `.venv\Scripts\python.exe -m
  pip install yt-dlp`. **Gotcha:** Instagram-Extraktoren brechen häufig — `pip install -U
  yt-dlp` ist der übliche Fix.
```

- [ ] **Step 6: Volle Testsuite**

Run: `.venv\Scripts\python.exe -m pytest webtool/ -q`
Run: `npm --prefix webtool/frontend run test`
Expected: beide grün

- [ ] **Step 7: Commit und PR**

```bash
git add CLAUDE.md
git commit -m "docs(claude): URL-Import dokumentieren"
git push -u origin feat/url-import
gh pr create --base master --title "feat: URL-Import fuer YouTube und Instagram Reels" --body "..."
```

Danach CI/Mergeability prüfen, `gh pr merge <#> --rebase --delete-branch`, lokal `master` per Fast-Forward nachziehen.

---

## Selbstprüfung des Plans

**Spec-Abdeckung:** §2 → Tasks 3+4 · §3 → Tasks 2+3 · §3.1 → Task 2 · §3.2 → Task 3 · §4 → Task 1 · §5 → Task 4 · §6 → Tasks 5+6 · §7 → Task 3 Step 1 + Task 7 Step 5 · §8 → Tasks 1-4 · §9 (Weggelassenes) → kein Task, korrekt · §10 → Task-Reihenfolge.

**Bekannte Abweichungen vom Spec (bewusst, begründet im jeweiligen Task):**
1. Filter in `find_audio()` statt in `transcribe_project()` — testbar ohne torch (Task 1).
2. Kein `requirements.txt` — existiert im Repo nicht; Spec §7 wurde entsprechend korrigiert.

**Namenskonsistenz geprüft:** `check_url` / `safe_base` / `unique_base` / `download_one` / `main` (Python) und `fetchUrls` / `UrlFetch` / `onStart` / `'download'` (TypeScript) werden in allen Tasks identisch verwendet.
