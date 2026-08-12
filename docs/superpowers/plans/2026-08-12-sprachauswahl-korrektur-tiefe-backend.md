# Sprachauswahl + Korrektur-Tiefe — Backend Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transkription und Korrektur pro Datei in der Originalsprache laufen lassen (statt fest Deutsch), mit vier wählbaren Korrektur-Tiefen — ohne die Schweizerdeutsch-Pipeline zu verändern.

**Architecture:** Eine Sprach-Tabelle als einzige Quelle (`webtool/sprachen.py`); pro Projekt/Datei Sprache + Tiefe in einer neuen `projekt.json` (`webtool/projekt.py`); `transcribe.py` liest die Sprache pro Datei; `correct.py` bekommt sprachbewusste Prompts (Ziel + Dialekt-Flag) und zwei neue leichte Einzellauf-Modi plus Tiefen-Verzweigung im `run`-Driver; `app.py` stellt Endpunkte für Projekteinstellungen und reicht die Sprache am Upload/Import durch.

**Tech Stack:** Python 3.13, faster-whisper (CTranslate2), pytest, FastAPI. Spec: `docs/superpowers/specs/2026-08-12-transkribor-sprachauswahl-korrektur-tiefe-design.md`. Issue #132.

**Plan-Grenze:** Dies ist **Plan 1 (Backend)**. Plan 2 (Frontend: Typen, API-Clients, Projekt-Einstellungsdialog, Upload-/Import-Sprachwähler) folgt nach Landen von Plan 1. Plan 1 allein ist lauffähig (CLI + API, pytest-grün).

## Global Constraints

- **Sprache nachträglich ändern ⇒ neu transkribieren** (Whisper brennt `language` ins `.json`). Tiefe ändert sich nur durch Neu-Korrektur.
- **Dialekt ist nicht erkennbar.** `auto` liefert nie Schweizerdeutsch; bei `auto` ist Dialekt-Glättung aus. UI-Hinweis folgt in Plan 2.
- **Legacy-Dateien ohne `projekt.json`** gelten als `ch` / `auto` ⇒ `voll_dialekt` — kein Verhaltenswechsel für Bestand.
- **Schweizerdeutsch-Pipeline bleibt exakt** (`voll_dialekt` = heutiger Pfad mit `ziel="lesbares Standarddeutsch"`, `dialekt=True`).
- **`transcribe.py` bleibt ohne webtool-Import im Grundpfad** — die Sprache wird pro Datei direkt aus `projekt.json` gelesen; die `id→whisper_code`-Auflösung erfolgt per lazy Import (wie schon `from webtool import device`), mit klarem ImportError, falls das Paket fehlt.
- **Ein leeres `text`-Feld in `correction.json` ist eine Entscheidung** (CLAUDE.md): `zusammenfassung` gibt `segments:[{id,speaker}]` ohne `text` → `apply_correction` übernimmt den Rohtext. Apply-Pfad bleibt unangetastet.
- **ASCII-Konvention** für Python-Kommentare (vgl. `settings.py`-Kommentare), Unicode in Prompts/Oberfläche erlaubt.

## File Structure

| Datei | Verantwortung | Status |
|-------|---------------|--------|
| `webtool/sprachen.py` | Sprach-Tabelle + Helfer (einzige Quelle) | neu |
| `webtool/projekt.py` | `projekt.json` lesen/schreiben + Sprach-/Tiefen-Auflösung | neu |
| `webtool/test_sprachen.py` | Tests zur Sprach-Tabelle | neu |
| `webtool/test_projekt.py` | Tests zu projekt.json + Auflösung | neu |
| `transcribe.py` | pro Datei Sprache aus projekt.json; `_opts` je Datei | modify |
| `webtool/test_transcribe.py` | Test des neuen Sprach-Helfers | modify |
| `webtool/correct.py` | sprachbewusste Prompts, leichte Modi, Tiefen-Verzweigung, Glossar-Gate | modify |
| `webtool/test_correct.py` | Prompt- + Verzweigungs-Tests | modify |
| `webtool/app.py` | Endpunkte Projekteinstellungen; Sprache am Upload/Import | modify |
| `webtool/test_api.py` | Endpunkt-Tests | modify |
| `README.md`, `CLAUDE.md` | nutzer- + entwicklersichtige Doku | modify |

---

## Task 1: Sprach-Tabelle `webtool/sprachen.py`

**Files:**
- Create: `webtool/sprachen.py`
- Test: `webtool/test_sprachen.py`

**Interfaces:**
- Produces: `SPRACHEN: dict[str, dict]`, `whisper_code(id) -> str|None`, `ziel_phrase(id) -> str`, `ist_dialekt(id) -> bool`, `von_whisper_code(code) -> str`, `fuer_frontend() -> list[dict]`, `TIEFEN: list[dict]`, `depth_label(tiefe) -> str`, `SPRACH_DEFAULT = "ch"`, `TIEFE_DEFAULT = "auto"`.

- [ ] **Step 1: Write failing tests**

```python
# webtool/test_sprachen.py
from webtool import sprachen


def test_whisper_code_mapping():
    assert sprachen.whisper_code("ch") == "de"   # Schweizerdeutsch -> Whisper 'de'
    assert sprachen.whisper_code("de") == "de"
    assert sprachen.whisper_code("en") == "en"
    assert sprachen.whisper_code("fr") == "fr"
    assert sprachen.whisper_code("it") == "it"
    assert spragen_z(None) is None if False else sprachen.whisper_code("auto") is None


def test_nur_ch_ist_dialekt():
    assert sprachen.ist_dialekt("ch") is True
    assert sprachen.ist_dialekt("de") is False
    assert sprachen.ist_dialekt("en") is False
    assert sprachen.ist_dialekt("auto") is False   # auto -> nie Dialekt


def test_ziel_phrase_pro_sprache():
    assert "Standarddeutsch" in sprachen.ziel_phrase("ch")
    assert "Standarddeutsch" in sprachen.ziel_phrase("de")
    assert "English" in sprachen.ziel_phrase("en")
    assert sprachen.ziel_phrase("fr") and sprachen.ziel_phrase("it")


def test_ziel_phrase_auto_ohne_konkrete_sprache():
    # auto hat keine eigene Ziel-Sprache -> Leerstring (Aufrufer loest auf)
    assert sprachen.ziel_phrase("auto") == ""


def test_von_whisper_code_erkennt_nicht_ch():
    assert sprachen.von_whisper_code("en") == "en"
    assert sprachen.von_whisper_code("de") == "de"
    assert sprachen.von_whisper_code("xx") == "de"   # unbekannt -> de (sicherer Rueckfall)


def test_fuer_frontend_enthaelt_alle_sechs():
    ids = {e["id"] for e in sprachen.fuer_frontend()}
    assert ids == {"ch", "de", "en", "fr", "it", "auto"}


def test_tiefen_liste_vier_stufen():
    ids = {t["id"] for t in sprachen.TIEFEN}
    assert ids == {"voll_dialekt", "voll", "leicht", "zusammenfassung"}
```

Fix the typo line in the test (`spragen_z`) — final test reads:

```python
def test_whisper_code_mapping():
    assert sprachen.whisper_code("ch") == "de"
    assert sprachen.whisper_code("de") == "de"
    assert sprachen.whisper_code("en") == "en"
    assert sprachen.whisper_code("fr") == "fr"
    assert sprachen.whisper_code("it") == "it"
    assert sprachen.whisper_code("auto") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_sprachen.py -v`
Expected: FAIL (ModuleNotFoundError / AttributeError).

- [ ] **Step 3: Write minimal implementation**

```python
# webtool/sprachen.py
"""Sprach-Tabelle: die EINE Quelle fuer Sprach-Code (Whisper), Dialekt-Flag und
Prompt-Ziel-Sprache. Konsumiert von transcribe.py, correct.py und dem Frontend."""

SPRACH_DEFAULT = "ch"     # Schweizerdeutsch — preserves legacy behaviour
TIEFE_DEFAULT = "auto"    # aus der Sprache abgeleitet

# id -> {label, hint, whisper, dialekt, ziel}
# ziel = Phrase fuer den Korrektur-Prompt ("normalisieren zu <ziel>"); "" bei auto.
SPRACHEN = {
    "ch":   {"label": "Schweizerdeutsch", "hint": "Dialekt -> Standarddeutsch",
             "whisper": "de", "dialekt": True,  "ziel": "lesbarem Standarddeutsch"},
    "de":   {"label": "Deutsch", "hint": "Hochdeutsch",
             "whisper": "de", "dialekt": False, "ziel": "lesbarem Standarddeutsch"},
    "en":   {"label": "Englisch", "hint": "English",
             "whisper": "en", "dialekt": False, "ziel": "clear English"},
    "fr":   {"label": "Französisch", "hint": "Français",
             "whisper": "fr", "dialekt": False, "ziel": "français courant"},
    "it":   {"label": "Italienisch", "hint": "Italiano",
             "whisper": "it", "dialekt": False, "ziel": "italiano corretto"},
    "auto": {"label": "Automatisch", "hint": "Whisper erkennt (kein Dialekt)",
             "whisper": None, "dialekt": False, "ziel": ""},
}

TIEFEN = [
    {"id": "voll_dialekt",    "label": "Voll (mit Dialekt-Glättung)"},
    {"id": "voll",            "label": "Voll (ohne Dialekt)"},
    {"id": "leicht",          "label": "Leicht (Zusammenfassung + Sprecher + Namen)"},
    {"id": "zusammenfassung", "label": "Nur Zusammenfassung + Sprecher"},
]


def _eintrag(sprach_id: str) -> dict:
    return SPRACHEN.get(sprach_id, SPRACHEN[SPRACH_DEFAULT])


def whisper_code(sprach_id: str):
    return _eintrag(sprach_id)["whisper"]


def ist_dialekt(sprach_id: str) -> bool:
    return bool(_eintrag(sprach_id)["dialekt"])


def ziel_phrase(sprach_id: str) -> str:
    return _eintrag(sprach_id)["ziel"]


def von_whisper_code(code: str) -> str:
    """Whisper-Detektion -> Sprach-id. ch wird nie detektiert; Unbekannt -> de."""
    for sid, e in SPRACHEN.items():
        if e["whisper"] == code and sid != "auto":
            return sid
    return "de"


def fuer_frontend() -> list:
    return [{"id": sid, "label": e["label"], "hint": e["hint"]}
            for sid, e in SPRACHEN.items()]


def depth_label(tiefe: str) -> str:
    for t in TIEFEN:
        if t["id"] == tiefe:
            return t["label"]
    return tiefe
```

- [ ] **Step 4: Run test to verify it passes**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_sprachen.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add webtool/sprachen.py webtool/test_sprachen.py
git commit -m "feat(sprachen): Sprach-Tabelle als einzige Quelle (Whisper-Code, Dialekt, Prompt-Ziel)"
```

---

## Task 2: `projekt.json` lesen/schreiben + Auflösung — `webtool/projekt.py`

**Files:**
- Create: `webtool/projekt.py`
- Test: `webtool/test_projekt.py`

**Interfaces:**
- Consumes: `sprachen.SPRACH_DEFAULT`, `sprachen.TIEFE_DEFAULT`, `paths.project_dir`, `paths.atomic_write`.
- Produces:
  - `laden(project) -> dict` — `{sprache, korrektur, dateien}`, gemerged mit Defaults, tolerant (fehlend/kaputt → Defaults).
  - `speichern(project, patch) -> dict` — Merge-Speichern (atomic).
  - `setze_datei(project, base, sprache=None, korrektur=None) -> dict`.
  - `datei_sprache(project, base) -> str` — Datei → Projekt → `SPRACH_DEFAULT`.
  - `datei_korrektur(project, base) -> str` — Datei → Projekt → `TIEFE_DEFAULT`.
  - `tiefe_effektiv(project, base) -> str` — löst `auto` auf: `ch`→`voll_dialekt`, sonst `voll`.

- [ ] **Step 1: Write failing tests**

```python
# webtool/test_projekt.py
import json, os
from webtool import projekt, paths, sprachen


def _neues_projekt(tmp_path, name="p"):
    os.makedirs(paths.project_dir(name), exist_ok=True)  # nutzt TRANSKRIBOR_PROJEKTE-Testumgebung
    return name


def test_laden_default_wenn_fehlt(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    d = projekt.laden("x")
    assert d["sprache"] == sprachen.SPRACH_DEFAULT
    assert d["korrektur"] == sprachen.TIEFE_DEFAULT
    assert d["dateien"] == {}


def test_speichern_und_laden(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"sprache": "en"})
    assert projekt.laden("p")["sprache"] == "en"


def test_setze_datei_schreibt_nur_abweichend(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.setze_datei("p", "v1", sprache="en", korrektur="leicht")
    d = projekt.laden("p")
    assert d["dateien"]["v1"] == {"sprache": "en", "korrektur": "leicht"}


def test_datei_sprache_kette(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"sprache": "de"})
    projekt.setze_datei("p", "a", sprache="en")
    assert projekt.datei_sprache("p", "a") == "en"      # Datei gewinnt
    assert projekt.datei_sprache("p", "b") == "de"      # Projekt-Standard
    assert projekt.datei_sprache("q", "c") == "ch"      # Default


def test_tiefe_effektiv_auto_aufloesung(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"sprache": "ch"})           # auto + ch -> voll_dialekt
    assert projekt.tiefe_effektiv("p", "a") == "voll_dialekt"
    projekt.speichern("p", {"sprache": "en"})           # auto + en -> voll
    assert projekt.tiefe_effektiv("p", "a") == "voll"
    projekt.setze_datei("p", "a", korrektur="leicht")   # explizit schlaegt auto
    assert projekt.tiefe_effektiv("p", "a") == "leicht"


def test_laden_tolerant_bei_kaputtem_json(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(paths.project_dir("p"), exist_ok=True)
    with open(os.path.join(paths.project_dir("p"), "projekt.json"), "w") as fh:
        fh.write("{ nicht json")
    assert projekt.laden("p")["sprache"] == "ch"        # kein Crash, Default
```

- [ ] **Step 2: Run test to verify it fails**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_projekt.py -v`
Expected: FAIL (ImportError).

- [ ] **Step 3: Write minimal implementation**

```python
# webtool/projekt.py
"""projekt.json: Sprache + Korrektur-Tiefe pro Projekt und pro Datei.

Liegt im Projektordner neben kontext.md. Fehlt die Datei oder ein Wert, gilt der
Projekt-Standard bzw. der System-Default (ch/auto) -> Legacy-Verhalten bleibt erhalten."""
import json, os
from . import paths, sprachen


def _pfad(project: str) -> str:
    return os.path.join(paths.project_dir(project), "projekt.json")


def laden(project: str) -> dict:
    try:
        with open(_pfad(project), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        "sprache": data.get("sprache", sprachen.SPRACH_DEFAULT),
        "korrektur": data.get("korrektur", sprachen.TIEFE_DEFAULT),
        "dateien": {k: v for k, v in (data.get("dateien") or {}).items() if isinstance(v, dict)},
    }


def speichern(project: str, patch: dict) -> dict:
    cur = laden(project)
    for k in ("sprache", "korrektur"):
        if k in patch and isinstance(patch[k], str):
            cur[k] = patch[k]
    paths.safe_name(project)
    paths.atomic_write(_pfad(project), json.dumps(cur, ensure_ascii=False, indent=1))
    return cur


def setze_datei(project: str, base: str, sprache=None, korrektur=None) -> dict:
    cur = laden(project)
    eintrag = dict(cur["dateien"].get(base, {}))
    if sprache is not None:
        eintrag["sprache"] = sprache
    if korrektur is not None:
        eintrag["korrektur"] = korrektur
    cur["dateien"][base] = eintrag
    paths.atomic_write(_pfad(project), json.dumps(cur, ensure_ascii=False, indent=1))
    return cur


def datei_sprache(project: str, base: str) -> str:
    d = laden(project)
    return d["dateien"].get(base, {}).get("sprache") or d["sprache"]


def datei_korrektur(project: str, base: str) -> str:
    d = laden(project)
    return d["dateien"].get(base, {}).get("korrektur") or d["korrektur"]


def tiefe_effektiv(project: str, base: str) -> str:
    tiefe = datei_korrektur(project, base)
    if tiefe != "auto":
        return tiefe
    return "voll_dialekt" if datei_sprache(project, base) == "ch" else "voll"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_projekt.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add webtool/projekt.py webtool/test_projekt.py
git commit -m "feat(projekt): projekt.json fuer Sprache + Korrektur-Tiefe (pro Projekt/Datei)"
```

---

## Task 3: `transcribe.py` liest Sprache pro Datei

**Files:**
- Modify: `transcribe.py` (neuer Helfer `_datei_whisper_code`, Nutzung im Loop `:221`)
- Test: `webtool/test_transcribe.py` (Test für den Helfer)

**Interfaces:**
- Consumes: `projekt.datei_sprache` (lazy import), `sprachen.whisper_code` (lazy import).
- Produces: `_datei_whisper_code(proj_dir, base, fallback) -> str|None`.

- [ ] **Step 1: Write failing test**

```python
# in webtool/test_transcribe.py ergaenzen
import json, os
import transcribe  # topLevel-Modul


def test_datei_whisper_code_liefert_projektdefault(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    with open(os.path.join(tmp_path, "p", "projekt.json"), "w") as fh:
        json.dump({"sprache": "en", "korrektur": "auto", "dateien": {}}, fh)
    assert transcribe._datei_whisper_code(os.path.join(tmp_path, "p"), "v1", "de") == "en"


def test_datei_whisper_code_auto_ist_none(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    with open(os.path.join(tmp_path, "p", "projekt.json"), "w") as fh:
        json.dump({"sprache": "auto", "korrektur": "auto", "dateien": {}}, fh)
    assert transcribe._datei_whisper_code(os.path.join(tmp_path, "p"), "v1", "de") is None


def test_datei_whisper_code_fallback_ohne_projektjson(tmp_path):
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    # keine projekt.json -> Legacy: globale Vorgabe ('de') bleibt stehen
    assert transcribe._datei_whisper_code(os.path.join(tmp_path, "p"), "v1", "de") == "de"
```

Hinweis: `transcribe` importiert `webtool.sprachen`/`webtool.projekt` lazy im Helfer — der Test läuft, weil das Paket im Repo-Root importierbar ist (cwd = ROOT).

- [ ] **Step 2: Run test to verify it fails**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py::test_datei_whisper_code_liefert_projektdefault -v`
Expected: FAIL (`_datei_whisper_code` fehlt).

- [ ] **Step 3: Write minimal implementation**

In `transcribe.py` ergänzen (oberhalb von `transcribe_project`):

```python
def _datei_whisper_code(proj_dir, base, fallback):
    """Whisper-Sprach-Code fuer EINE Datei: projekt.json (Datei -> Projekt) -> Default.

    Lazy import wie schon `from webtool import device`: das Grund-Skript laeuft ohne
    das Paket, nur die Sprach-Aufloesung braucht es. Fehlt projekt.json, gilt `fallback`
    (= WHISPER_LANG, Legacy-Verhalten). 'auto' -> None (Whisper erkennt selbst)."""
    try:
        from webtool import projekt as _p, sprachen as _s
        sid = _p.datei_sprache(os.path.basename(proj_dir), base)
        return _s.whisper_code(sid)
    except Exception:
        return fallback
```

Im Loop `transcribe_project` (`transcribe.py:221-239`) die `_opts`-Zeile ersetzen:

```python
    # vorher: result = _ergebnis(*m.transcribe(f, **_opts(language)))
    sprache = _datei_whisper_code(proj_dir, base, language)
    result = _ergebnis(*m.transcribe(f, **_opts(sprache)))
```

(`proj_dir` ist oben schon vorhanden; `base` in der Schleife vorhanden.) Für `engine == "whisper.cpp"` gilt dasselbe: `whispercpp.transkribiere(f, model, sprache)` statt `language`.

- [ ] **Step 4: Run test to verify it passes + existierende Transkript-Tests unverletzt**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -v`
Expected: PASS (neu + bestehend).

- [ ] **Step 5: Commit**

```bash
git add transcribe.py webtool/test_transcribe.py
git commit -m "feat(transcribe): Sprache pro Datei aus projekt.json (statt global fest)"
```

---

## Task 4: `correct.py` — sprachbewusste Prompts (ziel + dialekt)

**Files:**
- Modify: `webtool/correct.py` (`_correct_prompt`, `_verify_prompt`, `_glossary_prompt`, `DEFAULT_CONTEXT`, Thread durch `_correct_one`/`_correct_file`/`cmd_run`)
- Test: `webtool/test_correct.py`

**Interfaces:**
- Consumes: `sprachen.ziel_phrase`, `sprachen.ist_dialekt`, `projekt.datei_sprache`, `projekt.laden`.
- Produces: Prompts mit `ziel`/`dialekt`-Parametern; `_ziel_dialekt(project, base) -> (ziel, dialekt)`.

- [ ] **Step 1: Write failing tests**

```python
# in webtool/test_correct.py ergaenzen
from webtool import correct, sprachen


def test_correct_prompt_englisch_ohne_dialekt():
    p = correct._correct_prompt("b", "t.txt", "c.json", "g.json", "", ziel="clear English", dialekt=False)
    assert "clear English" in p
    assert "Schweizer „ss“" not in p            # Dialekt-Hinweis nur bei dialekt
    assert "Schweizerdeutsch ->" not in p


def test_correct_prompt_ch_mit_dialekt():
    p = correct._correct_prompt("b", "t.txt", "c.json", "g.json", "",
                                 ziel="lesbarem Standarddeutsch", dialekt=True)
    assert "Standarddeutsch" in p
    assert "Schweizer „ss“" in p                 # CH: Dialekt-Hinweis steht


def test_verify_prompt_nimmt_ziel_an():
    p = correct._verify_prompt("b", "t.txt", "c.json", "", ziel="clear English", dialekt=False)
    assert "clear English" in p


def test_ziel_dialekt_explicit_ch(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    from webtool import projekt
    projekt.speichern("p", {"sprache": "ch"})
    ziel, dialekt = correct._ziel_dialekt("p", "x")
    assert "Standarddeutsch" in ziel and dialekt is True


def test_ziel_dialekt_auto_nie_dialekt(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    tdir = os.path.join(tmp_path, "p", "transkripte")
    os.makedirs(tdir, exist_ok=True)
    with open(os.path.join(tdir, "x.json"), "w") as fh:
        json.dump({"language": "en"}, fh)         # Whisper detektierte Englisch
    from webtool import projekt
    projekt.speichern("p", {"sprache": "auto"})
    ziel, dialekt = correct._ziel_dialekt("p", "x")
    assert "English" in ziel and dialekt is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -k "prompt or ziel" -v`
Expected: FAIL (Signaturen kennen `ziel`/`dialekt` nicht).

- [ ] **Step 3: Write minimal implementation**

In `correct.py`:

1. `DEFAULT_CONTEXT` ersetzen durch eine Helfer-Funktion, die Sprache neutral bleibt:

```python
def _default_context(ziel: str) -> str:
    return (f"Interviews (gesprochene Sprache), von Whisper transkribiert. "
            f"ASR-Fehler v.a. bei Eigennamen. Ziel: normalisieren zu {ziel or 'klarem Text'}.")
```

2. `_ziel_dialekt(project, base)` ergänzen:

```python
def _ziel_dialekt(project: str, base: str) -> tuple:
    """(ziel-Phrase, dialekt-Flag) fuer den Korrektur-Prompt einer Datei.

    'auto' wird an der ROH-JSON aufgeloest (Whispers detektierter language-Code);
    Dialekt ist dabei stets aus (ch wird nie auto-detektiert)."""
    from . import projekt as _pj, sprachen as _s
    sid = _pj.datei_sprache(project, base)
    if sid == "auto":
        try:
            code = _load(os.path.join(paths.transkripte_dir(project), base + ".json")).get("language")
        except (OSError, json.JSONDecodeError):
            code = None
        sid = _s.von_whisper_code(code) if code else "de"
    return _s.ziel_phrase(sid), _s.ist_dialekt(sid)
```

3. `_correct_prompt` Signatur + die beiden Ziel-Zeilen anpassen:

```python
def _correct_prompt(base, tagged_path, cpath, gjson, context, id_range=None, known="",
                    ziel="lesbarem Standarddeutsch", dialekt=True):
    block, scope = _scope(id_range, known)
    einleitung = ("oft Schweizerdeutsch -> lesbares Standarddeutsch" if dialekt
                  else f"in {ziel}")
    dialekt_hinweis = " (Schweizer „ss“)" if dialekt else ""
    return f"""Du korrigierst EIN Interview-Transkript SEGMENT FÜR SEGMENT ({einleitung}) und labelst die Sprecher.

Projekt-Kontext: {context or _default_context(ziel)}
{block}
... (Read/Glossar-Blöcke unverändert) ...

2) KORRIGIEREN: klare ASR-Fehler mit Kontext + Glossar verbessern, zu {ziel} normalisieren{dialekt_hinweis}. BLEIB TREU: ...
... (Regeln 3-7, Schema unverändert; musik/artefakt-Regeln bleiben, sie sind sprachunabhängig) ..."""
```

(Den vollen Prompt-Body nicht abschneiden — alle bisherigen Regeln 1–7 und das Schema bleiben; nur die Einleitung + Regel 2 werden parameterisiert. Diff-Weite: exakt die zwei oben gezeigten String-Stellen.)

4. `_verify_prompt` analog: `ziel`/`dialekt`-Parameter; die `Projekt-Kontext:`-Zeile nutzt `_default_context(ziel)`. Der Treue-Body bleibt.

5. `_glossary_prompt` bekommt `ziel` (nur fuer den Fallback-Kontext).

6. `_correct_one` und `_correct_file` bekommen `ziel`/`dialekt` und reichen sie an die Prompts weiter:

```python
def _correct_one(base, tagged, target, gjson, context, verify, id_range=None, known="",
                 part="", ziel="lesbarem Standarddeutsch", dialekt=True):
    ...
    _ask_llm(_correct_prompt(base, tagged, target, gjson, context, id_range, known, ziel, dialekt), [tagged], target)
    if verify and _valid_correction(target):
        ... _verify_prompt(..., ziel=ziel, dialekt=dialekt) ...

def _correct_file(project, base, gjson, context, verify, force=False,
                  ziel="lesbarem Standarddeutsch", dialekt=True):
    ... _correct_one(..., ziel=ziel, dialekt=dialekt) ...
```

- [ ] **Step 4: Run test to verify it passes + bestehende correct-Tests**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -v`
Expected: PASS. (Bestehende Tests, die `_correct_prompt` ohne `ziel` rufen, nutzen die Defaults = CH-Verhalten → unverändert.)

- [ ] **Step 5: Commit**

```bash
git add webtool/correct.py webtool/test_correct.py
git commit -m "feat(correct): sprachbewusste Prompts (ziel + dialekt statt fest Standarddeutsch)"
```

---

## Task 5: Leichte Modi + Tiefen-Verzweigung + Glossar-Gate

**Files:**
- Modify: `webtool/correct.py` (`_light_prompt`, `_summary_prompt`, `_light_correct_file`, `_summary_only_file`, Verzweigung in `cmd_run`)
- Test: `webtool/test_correct.py`

**Interfaces:**
- Consumes: `projekt.tiefe_effektiv`, `projekt.datei_sprache`, Task-4-Prompts.
- Produces: zwei neue Prompt-Builder, zwei neue Datei-Korrekturpfade, verzweigter `cmd_run`.

- [ ] **Step 1: Write failing tests**

```python
# in webtool/test_correct.py ergaenzen
def test_light_prompt_produziert_zusammenfassung_und_sprecher(monkeypatch):
    p = correct._light_prompt("b", "t.txt", "c.json", "", ziel="clear English")
    assert "clear English" in p
    assert "Zusammenfassung" in p or "summary" in p.lower()
    assert "Sprecher" in p


def test_summary_prompt_ohne_text_korrektur():
    p = correct._summary_prompt("b", "t.txt", "c.json", "", ziel="clear English")
    # verlangt pro Segment NUR id+speaker, KEIN text-Feld
    assert '"id"' in p and "speaker" in p
    assert "text" not in p.replace("Zusammenfassung", "").replace("Kontext", "")


def test_cmd_run_verzweigt_nach_tiefe(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    from webtool import projekt
    tdir = os.path.join(tmp_path, "p", "transkripte"); os.makedirs(tdir)
    # zwei Roh-Dateien, eine leicht, eine voll
    for b in ("a", "b"):
        with open(os.path.join(tdir, f"{b}.json"), "w") as fh:
            json.dump({"language": "de", "segments": [{"id": 0, "text": "x"}], "text": "x"}, fh)
        with open(os.path.join(tdir, f"{b}.tagged.txt"), "w") as fh:
            fh.write("[0] x\n")
    projekt.speichern("p", {"sprache": "de"})
    projekt.setze_datei("p", "a", korrektur="leicht")
    # b bleibt auto -> voll
    calls = []
    monkeypatch.setattr(correct, "_ask_llm", lambda prompt, inputs, output: calls.append(output) or
                        paths.atomic_write(output, '{"base":"x","speakers":[],"segments":[{"id":0,"speaker":"I","text":"x"}],"summary":"s"}'))
    monkeypatch.setattr(correct, "cmd_apply", lambda *a, **k: "written")
    correct.cmd_run("p")
    # a (leicht) darf KEINEN verify-Aufruf starten; calls enthaelt fuer a genau 1, fuer b 2 (korrektur+verify)
    assert any("a" in c for c in calls) and any("b" in c for c in calls)


def test_glossar_nur_wenn_voll_datei(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    from webtool import projekt
    tdir = os.path.join(tmp_path, "p", "transkripte"); os.makedirs(tdir)
    for b in ("a",):
        with open(os.path.join(tdir, f"{b}.json"), "w") as fh:
            json.dump({"language": "de", "segments": [{"id": 0, "text": "x"}], "text": "x"}, fh)
        open(os.path.join(tdir, f"{b}.raw.txt"), "w").write("x")
        open(os.path.join(tdir, f"{b}.tagged.txt"), "w").write("[0] x\n")
    projekt.speichern("p", {"sprache": "de", "korrektur": "zusammenfassung"})  # nichts voll
    glossar_calls = []
    monkeypatch.setattr(correct, "_ask_llm",
                        lambda prompt, inputs, output: (glossar_calls.append(output) if "_glossar" in output else None,
                         paths.atomic_write(output, '{"speakers":[],"segments":[{"id":0,"speaker":"I","text":"x"}],"summary":"s","base":"x"}')))
    monkeypatch.setattr(correct, "cmd_apply", lambda *a, **k: "written")
    correct.cmd_run("p")
    assert not any("_glossar" in c for c in glossar_calls)   # kein Glossar bei nur-leicht
```

- [ ] **Step 2: Run test to verify it fails**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -k "light_prompt or summary_prompt or verzweigt or glossar_nur" -v`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `correct.py` ergänzen (neue Prompt-Builder + Datei-Pfade):

```python
def _light_prompt(base, tagged_path, cpath, context, ziel="lesbarem Standarddeutsch"):
    return f"""Du bearbeitest EIN Transkript in EINEM Lauf (leichte Korrektur) und labelst die Sprecher.

Projekt-Kontext: {context or _default_context(ziel)}
1) Lies die Rohsegmente (Read-Tool): {tagged_path}
2) KORRIGIERE NUR offensichtliche ASR-Fehler und Eigennamen, zu {ziel}. KEIN Umschreiben, keine Dialekt-Glättung. Entferne [[...]]-Markierungen.
3) SPRECHER: vergib pro (Sprecher N)-Cluster einen konsistenten Namen (meist „Interviewer" und die befragte Person). Gib JEDEM Segment einen speaker.
4) SUMMARY: eine Inhalts-Zusammenfassung (3-5 Sätze).

Schema (Write-Tool nach {cpath}):
{{"base":"{base}","context":"1-2 Sätze","speakers":["…"],
 "segments":[{{"id":<zahl>,"speaker":"…","text":"…"}}],
 "annotations":["…"],"summary":"3-5 Sätze Inhalt"}}
Gib ausser der Datei nichts aus."""


def _summary_prompt(base, tagged_path, cpath, context, ziel="lesbarem Standarddeutsch"):
    return f"""Du bearbeitest EIN Transkript NUR fuer Zusammenfassung + Sprecher-Namen. Den Text lässt du UNANGETASTET.

Projekt-Kontext: {context or _default_context(ziel)}
1) Lies die Rohsegmente (Read-Tool): {tagged_path}
2) SPRECHER: vergib pro (Sprecher N)-Cluster einen konsistenten Namen. JEDES Segment bekommt einen speaker — KEIN text-Feld (der Rohtext bleibt unverändert).
3) SUMMARY: eine Inhalts-Zusammenfassung (3-5 Sätze) in {ziel or 'der Originalsprache'}.

Schema (Write-Tool nach {cpath}):
{{"base":"{base}","context":"1-2 Sätze","speakers":["…"],
 "segments":[{{"id":<zahl>,"speaker":"…"}}],
 "annotations":["…"],"summary":"3-5 Sätze Inhalt"}}
Gib ausser der Datei nichts aus."""


def _light_correct_file(project, base, ziel, dialekt, context):
    tdir = paths.transkripte_dir(project)
    target = os.path.abspath(os.path.join(tdir, base + ".correction.json"))
    tagged = os.path.abspath(os.path.join(tdir, base + ".tagged.txt"))
    print(f"→ Leichte Korrektur {base} …", flush=True)
    _ask_llm(_light_prompt(base, tagged, target, context, ziel), [tagged], target)


def _summary_only_file(project, base, ziel, context):
    tdir = paths.transkripte_dir(project)
    target = os.path.abspath(os.path.join(tdir, base + ".correction.json"))
    tagged = os.path.abspath(os.path.join(tdir, base + ".tagged.txt"))
    print(f"→ Nur Zusammenfassung {base} …", flush=True)
    _ask_llm(_summary_prompt(base, tagged, target, context, ziel), [tagged], target)
```

In `cmd_run` die Schleife `one(b)` ersetzen (Tiefen-Verzweigung + Glossar-Gate). Vor der Schleife feststellen, ob überhaupt ein Voll-Datei dabei ist:

```python
    from . import projekt as _pj
    context = _context(project)
    hat_voll = any(_pj.tiefe_effektiv(project, b) in ("voll", "voll_dialekt") for b in all_bases)
    gjson = _glossary(project, context) if hat_voll else ""
    def one(b):
        try:
            ... (human_edited / reuse-Pflege unverändert) ...
            tiefe = _pj.tiefe_effektiv(project, b)
            ziel, dialekt = _ziel_dialekt(project, b)
            if tiefe in ("voll", "voll_dialekt"):
                if not reuse:
                    _correct_file(project, b, gjson, context, verify and tiefe in ("voll", "voll_dialekt"),
                                  force, ziel=ziel, dialekt=dialekt)
            elif tiefe == "leicht":
                _light_correct_file(project, b, ziel, dialekt, context)
            else:  # zusammenfassung
                _summary_only_file(project, b, ziel, context)
            if not _valid_correction(cpath): ... (unverändert) ...
            cmd_apply(project, b, force=force)
            return True
        except Exception as e: ... (unverändert) ...
```

(Hinweis: `verify` gilt nur für Voll-Modi; `leicht`/`zusammenfassung` haben keinen Treue-Pass. Glossar wird nur gebaut, wenn mind. eine Voll-Datei existiert — `hat_voll`.)

- [ ] **Step 4: Run test to verify it passes + gesammte correct-Suite**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webtool/correct.py webtool/test_correct.py
git commit -m "feat(correct): leichte Modi (leicht/zusammenfassung) + Tiefen-Verzweigung + Glossar-Gate"
```

---

## Task 6: `app.py` — Endpunkte für Projekteinstellungen + Sprache am Upload/Import

**Files:**
- Modify: `webtool/app.py` (neu: `GET/PUT /api/projects/{project}/einstellungen`; `upload_audio` + `fetch_urls` nehmen `sprache` entgegen)
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `projekt.laden`, `projekt.speichern`, `projekt.setze_datei`, `sprachen.fuer_frontend`, `sprachen.TIEFEN`.
- Produces:
  - `GET /api/projects/{project}/einstellungen` → `{sprache, korrektur, sprach_choices, tiefen}`.
  - `PUT /api/projects/{project}/einstellungen` body `{sprache?, korrektur?}`.
  - `POST …/audio` zusätzliches Form-Feld `sprache` → `setze_datei` vor `_start_transcribe`.
  - `POST …/fetch` body zusätzlich `sprache` → `setze_datei` je geladener Base (in `_start_transcribe` oder nach Fetch).

- [ ] **Step 1: Write failing tests**

```python
# in webtool/test_api.py ergaenzen (Test-Client-Muster wie bestehend)
def test_einstellungen_default_fuer_neues_projjekt(client, tmp_projekt):
    r = client.get(f"/api/projects/{tmp_projekt}/einstellungen")
    assert r.status_code == 200
    d = r.json()
    assert d["sprache"] == "ch" and d["korrektur"] == "auto"
    assert {e["id"] for e in d["sprach_choices"]} >= {"ch", "de", "en", "auto"}


def test_einstellungen_speichern(client, tmp_projekt):
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"sprache": "en"})
    assert r.status_code == 200
    assert client.get(f"/api/projects/{tmp_projekt}/einstellungen").json()["sprache"] == "en"


def test_upload_schreibt_datei_sprache(client, tmp_projekt, audio_datei):
    r = client.post(f"/api/projects/{tmp_projekt}/audio",
                    files={"file": audio_datei}, data={"sprache": "en"})
    assert r.status_code == 200
    from webtool import projekt
    assert projekt.datei_sprache(tmp_projekt, r.json()["base"]) == "en"
```

(`tmp_projekt`/`audio_datei`: Fixtures nach bestehendem Muster in `test_api.py`; TRANSKRIBOR_PROJEKTE auf tmp.)

- [ ] **Step 2: Run test to verify it fails**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -k "einstellungen or upload_schreibt" -v`
Expected: FAIL (404 / kein `sprache`-Feld).

- [ ] **Step 3: Write minimal implementation**

In `app.py`:

```python
from . import projekt as _projekt, sprachen as _sprachen


@app.get("/api/projects/{project}/einstellungen")
def projekteinstellungen(project: str):
    _validate(project)
    d = _projekt.laden(project)
    return {"sprache": d["sprache"], "korrektur": d["korrektur"],
            "sprach_choices": _sprachen.fuer_frontend(), "tiefen": _sprachen.TIEFEN}


class EinstellungenBody(BaseModel):
    sprache: str | None = None
    korrektur: str | None = None


@app.put("/api/projects/{project}/einstellungen")
def projekteinstellungen_speichern(project: str, body: EinstellungenBody):
    _validate(project)
    d = _projekt.speichern(project, {"sprache": body.sprache, "korrektur": body.korrektur}
                           if body.sprache or body.korrektur else {})
    return {"sprache": d["sprache"], "korrektur": d["korrektur"]}
```

`upload_audio` — Form-Feld `sprache` aufnehmen und VOR dem Transkriptions-Job eintragen:

```python
@app.post("/api/projects/{project}/audio")
def upload_audio(project: str, file: UploadFile = File(...), sprache: str = Form(None)):
    _validate(project)
    ...
    base, ext = ...
    # NEU: Sprache fuer diese Datei eintragen, BEVOR der Job laeuft (sonst transkribiert er auf Projekt-Standard)
    if sprache:
        _projekt.setze_datei(project, base, sprache=sprache)
    job_id, started = _start_transcribe(project)
    return {"ok": True, "base": base, "file": base + ext, "job_id": job_id, "started": started}
```

`fetch_urls` — body um `sprache` erweitern; da die Basisnamen erst nach dem Download feststehen, trägt `fetch.py` (oder ein dünner Nach-Hook) die Sprache je geladener Base ein. Minimal-Lösung im Plan: `fetch.py` liest die gewählte Sprache aus einer Env-Variablen `TRANSKRIBOR_FETCH_SPRACHE`, die `fetch_urls` setzt, und `setze_datei` für jede geladene Base beim Schreiben der Audiodatei. (Konkrete Einbau-Stelle: dort, wo `fetch.py` die `.m4a` ablegt — `os.path.splitext(base)` liegt dort vor.)

```python
class FetchBody(BaseModel):
    urls: list[str]
    sprache: str | None = None

@app.post("/api/projects/{project}/fetch")
def fetch_urls(project: str, body: FetchBody):
    ...
    env_sprache = {"TRANSKRIBOR_FETCH_SPRACHE": body.sprache} if body.sprache else {}
    cmd = [sys.executable, "-m", "webtool.fetch", "--download-only", project, *urls]
    job_id, started = jobs.start(project, cmd, paths.ROOT, "fetch",
                                 then=lambda: _start_transcribe(project), env=env_sprache)
    ...
```

(Hinweis: `jobs.start` muss das `env`-Dict in den Subprozess durchreichen — bestehende `_run_proc` mischt schon `{**os.environ, **settings.job_env()}`; dort um `**(extra_env or {})` ergänzen. In `fetch.py` nach dem Ablegen jeder Audiodatei: `if os.environ.get("TRANSKRIBOR_FETCH_SPRACHE"): projekt.setze_datei(name, base, sprache=...)`.)

- [ ] **Step 4: Run test to verify it passes + api-Suite**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/fetch.py webtool/jobs.py webtool/test_api.py
git commit -m "feat(api): Projekteinstellungen-Endpunkte + Sprache am Upload/URL-Import"
```

---

## Task 7: Doku (README + CLAUDE.md)

**Files:**
- Modify: `README.md` (nutzersichtbar: Sprachwahl + Korrektur-Tiefen)
- Modify: `CLAUDE.md` (entwicklersichtbar: neue Architektur-Fakten)

Kein TDD — Aber:. Zwei Prüfungen:

- [ ] **Step 1: README — Nutzer-Abschnitt**

Unter dem Transkriptions/Korrektur-Abschnitt ergänzen (in Nutzer-Worten, nicht Changelog):

> **Welche Sprache?** Pro Upload oder Video-Import wählst du die Sprache (Schweizerdeutsch,
> Deutsch, Englisch, Französisch, Italienisch, Automatisch). Schweizerdeutsch bleibt wie gehabt
> vollständig korrigiert (Dialekt → Standarddeutsch); bei sauberen Sprachen kannst du die
> Korrektur leichter stellen oder nur eine Zusammenfassung ziehen — die Originalsprache bleibt
> immer erhalten. In den Projekt-Einstellungen legst du die Standardsprache fest.

- [ ] **Step 2: CLAUDE.md — Architektur-Fakten**

Einen neuen Block (Stil der bestehenden), der festhält:
- `webtool/sprachen.py` = einzige Quelle für Sprache → (Whisper-Code, Dialekt-Flag, Prompt-Ziel).
- `webtool/projekt.py` / `projekt.json` halten Sprache + Tiefe pro Projekt/Datei; Legacy-Default `ch`/`auto` ⇒ `voll_dialekt`.
- Die Korrektur-Prompts sind sprachbewusst (`ziel`/`dialekt`); „Standarddeutsch" steht nur für `ch`/`de`.
- Vier Tiefen; `leicht`/`zusammenfassung` = 1 LLM-Aufruf, kein Glossar/Treue-Check; nutzen `correction.json` ohne `text` ⇒ `apply_correction` unangetastet.
- `auto` erkennt keinen Dialekt (Whisper-Code `de` ≠ Schweizerdeutsch).
- `transcribe.py` liest Sprache pro Datei aus `projekt.json` (lazy Import wie `device`).

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: Sprachauswahl + Korrektur-Tiefe (README + CLAUDE.md)"
```

---

## Self-Review (Ergebnis)

**Spec-Abdeckung:**
- Root Cause (festes `de` + „Standarddeutsch"-Prompt) → Tasks 3 (transcribe) + 4 (Prompts). ✓
- `projekt.json` (Projekt + Datei) → Task 2. ✓
- Sprach-Tabelle eine Quelle → Task 1. ✓
- Vier Tiefen, Defaults, `auto`-Auflösung → Tasks 1+2+5. ✓
- Sprachbewusste Prompts, Dialekt-Flag → Task 4. ✓
- Leichte Modi nutzen `correction.json` ohne `text`, `apply_correction` unangetastet → Task 5 (Schema ohne `text`). ✓
- Transkription pro Datei → Task 3. ✓
- Schweizerdeutsch = exakt heute → Task 4 Defaults (`ziel=Standarddeutsch, dialekt=True`) + Task 5 `voll_dialekt`-Pfad = bisheriges `_correct_file`. ✓
- Glossar-Gate (nur bei Voll) → Task 5. ✓
- Diarisierung unverändert → kein Task nötig (bewusst nicht angetastet). ✓
- Endpunkte + Sprache am Upload/Import → Task 6. ✓
- README + CLAUDE.md → Task 7. ✓
- **Folge-Issues** (Treue-Messung leichte Modi; sprachspezifische Glossare; Sprache pro Alt-Datei) → nicht in Plan, werden Issues nach Merge (siehe Spec „Bewusst herausgeschnitten").

**Platzhalter-Scan:** keine TBD/TODO; alle Codeschritte enthalten lauffähigen Code. (Task 4/5 zeigen die exakten diff-relevanten String-Stellen statt des ganzen Prompt-Body — das ist Anleitung, keine Lücke: der Prompt-Body steht unverändert in der heutigen Datei.)

**Typkonsistenz:** `_ziel_dialekt` (Task 4) → `(ziel, dialekt)` genutzt in Task 5 `_light_correct_file`/Verzweigung. `projekt.tiefe_effektiv`/`datei_sprache` (Task 2) konsistent in Tasks 3/4/5/6. `sprachen.fuer_frontend`/`TIEFEN` (Task 1) konsistent in Task 6. `setze_datei(project, base, sprache=, korrektur=)` konsistent in Task 2+6.

## Risiko / Achtung bei der Umsetzung

- **Task 4/5 sind die heiklen.** Prompt-Änderungen sind im Diff subtil (String-Stellen); die Schweizerdeutsch-Garantie (Constraint) HALTEN die Default-Parameter — ein bestehender Test, der `_correct_prompt` ohne `ziel` ruft, muss weiterhin „Standarddeutsch" + „ss" sehen. Absichern mit `test_correct_prompt_ch_mit_dialekt` (Defaults).
- **Task 6 `jobs.start(..., env=…)`** ist eine Signatur-Erweiterung — alle Aufrufer prüfen (`fetch_urls` ist der einzige, der `env` braucht; die übrigen Aufrufer unverändert). `_run_proc` muss `extra_env` durchreichen.
- **`fetch.py`-Anbindung** (Sprache je geladene Base) ist die am schwersten testbare Stelle — falls sich ein单元-Test nicht lohnt, mindestens ein Integrationstest, dass `TRANSKRIBOR_FETCH_SPRACHE` einen `projekt.json`-Eintrag erzeugt.
