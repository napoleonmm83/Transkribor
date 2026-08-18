# OSV-Scanner in die CI — Implementation Plan (Issue #284)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dependenz-Schwachstellen automatisch per OSV (osv.dev) in der CI erkennen — gegen das *aufgelöste* Abbild, nicht gegen das ungepinnte Manifest.

**Architecture:** Ein neuer Workflow `.github/workflows/osv.yml` mit drei Jobs: `resolve-python` (löst den Python-Baum per `pip --dry-run --report` ohne Wheel-Download auf, merge mit cu128-Regel, Wächter ≥ 100 Pakete), `osv-pr` (Google-Reusable-Workflow, diff-basiert, nur die zwei npm-Lockfiles) und `osv-voll` (geplant + master-Push, alles drei, SARIF → Security-Tab, `fail-on-vuln: false`).

**Tech Stack:** GitHub Actions, `google/osv-scanner-action@v2.5.1` (Reusable Workflows), `pip install --dry-run --report` (PEP-658-Metadaten).

**Spec:** Issue #284 (trägt die fünf offenen Fragen) + die Messungen und drei Entscheidungen unten — es gibt keine separate Spec-Datei; dieser Plan ist beides.

## Die Messungen, die dieses Design tragen (2026-08-18, osv-scanner v2.5.1 lokal)

Wer diesen Plan ändert, misst zuerst nach — dieselbe Regel wie bei `TRANSKRIBOR_MIX_SCHWELLE`.

| # | Was gescannt | Ergebnis |
|---|---|---|
| 1 | `requirements.txt` als **Manifest** | 12 Pakete, **44 Funde** — aber gegen deps.dev-Versionen (`torch 2.9.1`, `pillow 9.5.0`), die kein Nutzer fährt (echte venv: torch 2.11.0+cu128, pillow 12.3.0). **38 von 44 Funden wären False Positives.** |
| 2 | `pip freeze` der echten venv (135 Pakete) | **12 echte Funde**: aiohttp 3.14.1 (6), lightning 2.6.5 (1), setuptools 70.2.0 (4), **torch 2.11.0+cu128 → GHSA-rrmf-rvhw-rf47** (memory corruption via `torch.jit.script`). torch-Abdeckung ist keine Dekoration. |
| 3 | beide npm-Lockfiles | **0 Funde.** Das shadcn-Rauschen (`@modelcontextprotocol/sdk`, dev-only) ist prospektiv. |
| 4 | `pip install --dry-run --ignore-installed --report` | torch-Baum (cu128-Index) in **3,4 s**, requirements in **9,7 s** aufgelöst — **ohne einen Wheel-Download** (PEP-658-Metadaten). Ein 3-GB-CI-Install ist unnötig. |

**OSV-Exit-Codes** (Doku „Output“): `0` = sauber, `1` = Funde, `127` = allgemeiner Fehler, `128` = *keine Pakete gefunden* — 128 ist der unterscheidbare „nichts gescannt“-Zustand, den Issue-Punkt 5 verlangt. Bekannte Grenze: [osv-scanner-action#71](https://github.com/google/osv-scanner-action/issues/71) — Scan-Fehler failen denReusable-Workflow-Job nicht still; der Wächter im Resolve-Job + der SARIF-Nachweis im Security-Tab sind die Gegenmassnahmen.

## Getroffene Entscheidungen (Marcus, 2026-08-18)

1. **Gate-Strenge:** *Neue Funden im PR → rot* (`fail-on-vuln: true` im PR-Scan; kein Merge-Zwang, es gibt keine Branch Protection); *Altlasten → gelb* (`fail-on-vuln: false` im Vollscan, SARIF in den Security-Tab). Ein dauerrotes master bei unfixed Befunden (torch cu128 hat die Fixversion evtl. nicht) würde nur trainieren, Rot zu ignorieren — dieselbe Begründung wie `.coderabbit.yaml: pre_merge_checks = warning`.
2. **Python im PR-Scan: nein.** PR-Scan = die zwei npm-Lockfiles (kommittiert, exakt, diff-bar — Renovate-PRs, die auf eine verwundbare Version ziehen, werden sofort sichtbar). Das Python-Abbild läuft nur im Vollscan (master-Push + wöchentlich) — nach dem Merge sofort geprüft. Grund: das Reusable-PR-Workflow vergleicht Base gegen Head; ein CI-generiertes Artifact bekämen beide Seiten identisch (Python-Diff niemals „neu“) — oder Base ohne Artifact (jeder Python-Fund „neu“). Beides schlechter als der Weg über den Vollscan.
3. **Pinning: Tag `@v2.5.1`** (offizieller Weg, Renovate aktualisiert bei Releases; bewusst NICHT `@main`/`@nightly` — Issue-Text).

## Verifizierte Workflow-Annahmen (gegen die Reusable-Quelle von `google/osv-scanner-action@main`, 2026-08-18)

Wer den Workflow ändert, weiss sonst nicht, dass diese drei Fakten einmal belegt wurden:

1. **`download-artifact` landet im Wurzel-Workspace:** Die Quelle (osv-scanner-reusable.yml, Schritt „Download custom artifact") nutzt `actions/download-artifact` mit `path: "./"` — `--lockfile=requirements.txt:./requirements-resolved.txt` findet das Artifact also. Der Input existiert **nur** im Vollscan-Workflow (nicht in der PR-Variante) — der Plan nutzt ihn entsprechend nur dort.
2. **Eigene `scan-args` ERSETZEN den Default `-r ./`:** Der Default steht als Workflow-Input-Default; wer eigene Args übergibt, hat sie substituiert — kein Verzeichnis-Lauf, `requirements.txt` wird nicht als Manifest mitgenommen. Gegenprobe am echten Lauf: Task 3, Step 2.
3. **Das Repo ist ÖFFENTLICH** (`napoleonmm83/Transkribor`, `isPrivate: false`, gemessen 2026-08-18): SARIF-Upload in den Security-Tab ist frei verfügbar, GHAS wäre nur bei privaten Repos nötig.
4. **Deckelungsregel (bei der Umsetzung GEMESSEN, Bisektion über 4 Läufe):** Der Aufrufer eines Reusable-Workflows muss mindestens die Rechte gewähren, die dieser intern deklariert — `google/osv-scanner-action` deklariert `security-events: write`, also braucht der PR-Job die Zeile trotz `upload-sarif: false`, sonst `startup_failure` **ohne jede Annotation**. Der erste Plan-Entwurf (und Codex) hatten das Recht gestrichen — die Messung widerlegte es.
5. **Symlink-Risiko des PR-Workflows** ([osv-scanner-action#136](https://github.com/google/osv-scanner-action/issues/136), CodeRabbit-Major): feste Ausgabenamen + PR-steuerte Dateien. Kein gefixtes Release zum Pinnen — Abhärtung ist der Fork-Ausschluss in der `if:`-Bedingung; Fork-Beiträge laufen nach dem Merge durch den master-Vollscan.

## Global Constraints

- **Niemals `--recursive ./` als scan-args** — das nähme `requirements.txt` als Manifest mit (Messung 1: False-Positive-Maschine). Immer die drei `--lockfile=`-Pfade explizit.
- **Python wird nur gegen das aufgelöste Abbild gescannt** (`requirements-resolved.txt`, CI-generiert, nie kommittiert — es driftet sonst und lügt über Frische).
- **cu128-Regel:** torch-Familie gewinnt aus dem cu128-Report — Erkennungsmerkmal ist das lokale Versionssuffix (`+cu128`), denn nur der externe Index erzeugt eines. Dies bildet die Installationsreihenfolge aus `electron/setup.js` ab (torch zuerst aus cu128, danach `-r requirements.txt`).
- **Kein präventives `osv-scanner.toml`** — heute gibt es nichts zu ignorieren (Messung 3). Erst bei einem echten Fund: `[[PackageOverrides]]` mit `reason` (und `ignoreUntil`, wenn befristet). Leere Ignore-Listen laden zum Wegsehen ein.
- `security-events: write` nur an den zwei Scan-Jobs, nicht workflow-global.
- Der Workflow trägt `workflow_dispatch` — der Trockenlauf von einem Branch ist der lokale Funktionstest dieser Fläche.

---

### Task 1: `scripts/osv_freeze.py` — Auflösen, mergen, wächten (TDD)

**Files:**
- Create: `scripts/osv_freeze.py`
- Create: `scripts/test_osv_freeze.py`
- Modify: `.github/workflows/test.yml` (ein Schritt im Job `python`, nach `pip install`)
- Modify: `.gitignore` (drei Artefakt-Zeilen, Plan-Review D1)

**Interfaces:**
- Produces: `scripts/osv_freeze.py` mit `haupt()` (CLI: keine Argumente, schreibt `requirements-resolved.txt` ins aktuelle Verzeichnis, Exit 0/1) sowie `lies_report`, `verschmelze`, `normalisiere` (rein, für Tests).
- Konsumiert von Task 2: Der Workflow ruft `python scripts/osv_freeze.py` und lädt `requirements-resolved.txt` als Artifact `osv-python-freeze` hoch.

**Warum ein Skript und kein YAML-Inline:** Der Merge (zwei Reports → ein Abbild, cu128-Regel) und der Wächter (≥ 100 Pakete) sind Logik mit Fehlerrichtung — nach Repo-Regel mutationsgeprüft testbar. Test-Ort nach dem Vorbild `scripts/versionshoehe.test.sh`: direkt daneben, als eigener CI-Schritt (`python -m pytest` sammelt `scripts/` nicht).

- [ ] **Step 1: Failing tests schreiben**

```python
# scripts/test_osv_freeze.py
"""Tests fuer osv_freeze.py — laeuft als eigener CI-Schritt (python scripts/test_osv_freeze.py),
pytest sammelt scripts/ nicht (norecursedirs). Vorbild: scripts/versionshoehe.test.sh.
Assert-basiert ohne Framework: das Skript ist CI-Werkzeug, kein App-Code."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import osv_freeze as of


def _report_datei(eintraege):
    """Baut eine pip-Report-Datei im minimalen Schema; gibt Pfad zurueck (tempfile, nicht
    neben dem Skript — sonst landet Muell im Baum und der naechste Commit nimmt ihn mit)."""
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump({"install": [{"metadata": {"name": n, "version": v}} for n, v in eintraege]},
              handle)
    handle.close()
    return handle.name


def test_pep503_normalisierung():
    # pip freeze schreibt Bindestriche, der Report Punkte/Unterstriche (pyannote.audio
    # gegen pyannote-audio). OSV matcht auf die freeze-Form.
    assert of.normalisiere("pyannote.audio") == "pyannote-audio"
    assert of.normalisiere("torch_pitch_shift") == "torch-pitch-shift"
    assert of.normalisiere("PyCryptodomeX") == "pycryptodomex"


def test_report_lesen():
    pfad = _report_datei([("pyannote.audio", "4.0.7"), ("torch", "2.13.0")])
    assert of.lies_report(pfad) == {"pyannote-audio": "4.0.7", "torch": "2.13.0"}


def test_nur_lokale_suffixe_gewinnen_aus_cu128():
    # torch==2.11.0+cu128 ueberschreibt PyPIs 2.13.0 (setup.js-Reihenfolge);
    # setuptools 78.1.0 OHNE Suffix tut es NICHT — pip loeste das dort gegen
    # denselben PyPI-Bestand, die PyPI-Aufloesung ist frischer.
    pypi = {"torch": "2.13.0", "setuptools": "78.3.0", "fastapi": "0.139.0"}
    cu128 = {"torch": "2.11.0+cu128", "torchaudio": "2.11.0+cu128", "setuptools": "78.1.0",
             "nur-im-cu128-baum": "1.2.3"}
    ergebnis = of.verschmelze(pypi, cu128)
    assert ergebnis["torch"] == "2.11.0+cu128"
    assert ergebnis["torchaudio"] == "2.11.0+cu128"
    assert ergebnis["setuptools"] == "78.3.0"   # PyPI gewinnt: kein Suffix
    assert ergebnis["fastapi"] == "0.139.0"
    assert ergebnis["nur-im-cu128-baum"] == "1.2.3"  # Union-Fallback: PyPI kennt es nicht


def test_waechter_schlaegt_unter_100_an():
    # Der Wächter unterscheidet "nichts aufgeloest" (Manifest-Laenge ~12) von
    # "aufgeloest" (~127). Ohne ihn wäre ein leerer Report ein grüner Scan über
    # nichts — der "pass heisst nicht geschaut"-Fehler aus den CodeRabbit-Limits.
    try:
        of.pruefe_anzahl(12)
    except SystemExit as e:
        assert e.code == 1
    else:
        raise AssertionError("Wächter hat 12 Pakete durchgelassen")
    of.pruefe_anzahl(127)  # wirft nicht


def _alle():
    for name in sorted(globals()):
        if name.startswith("test_") and callable(globals()[name]):
            globals()[name]()
            print(f"ok {name}")


if __name__ == "__main__":
    _alle()
    print("alle Tests gruen")
```

- [ ] **Step 2: Rot laufen lassen**

Run: `python scripts/test_osv_freeze.py`
Expected: FAIL mit `ModuleNotFoundError: No module named 'osv_freeze'` (das Skript existiert noch nicht — das ist der rot-Zustand)

- [ ] **Step 3: Implementation**

```python
#!/usr/bin/env python3
"""Erzeugt das AUFGELOESTE Python-Abbild fuer den OSV-Scan (Issue #284).

WARUM: requirements.txt ist bewusst ungepinnt — ein Manifest-Scan loest via
deps.dev auf und meldet dann Versionen, die niemand faehrt. Gemessen 2026-08-18
(osv-scanner 2.5.1): Manifest-Scan 44 Funde, davon 38 gegen Phantom-Versionen
(torch 2.9.1 statt 2.11.0+cu128, pillow 9.5.0 statt 12.3.0); der Scan gegen das
echte Abbild meldete 12 echte Funde. Also: Abbild scannen, nie das Manifest.

WIE: zwei Dry-Run-Reports (PEP-658-Metadaten — kein Wheel-Download, gemessen
3,4 s bzw. 9,7 s statt eines 3-GB-Installationslaufs):
  1. -r requirements.txt          ueber PyPI
  2. torch torchaudio             ueber den cu128-Index (electron/setup.js-Ordnung)
Merge-Regel: nur Eintraege mit lokalem Suffix (+cu128) gewinnen aus dem cu128-Report
— nur der externe Index erzeugt solche Suffixe, alles andere hat pip dort gegen
denselben Bestand geloest.

WÄCHTER: < 100 Pakete ist kein Abbild (echtes ~127, Manifest ~12) -> Exit 1.
Ein leerer Report wuerde sonst als grüner Scan ueber nichts durchgehen.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

CU128_INDEX = "https://download.pytorch.org/whl/cu128"
MIN_PAKETE = 100  # echtes Abbild 2026-08-18: 117 (PyPI) + torch-Baum; Manifest: 12
ZIEL = "requirements-resolved.txt"


def normalisiere(name: str) -> str:
    """PEP 503 — pip freeze und OSV rechnen mit Bindestrich-Form."""
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def lies_report(pfad: str) -> dict:
    with open(pfad, encoding="utf-8") as f:
        daten = json.load(f)
    return {normalisiere(i["metadata"]["name"]): i["metadata"]["version"]
            for i in daten.get("install", [])}


def verschmelze(pypi: dict, cu128: dict) -> dict:
    """Installations-Reihenfolge aus electron/setup.js: torch zuerst aus dem
    cu128-Index, danach -r requirements.txt (pip behaelte das installierte torch).
    Erkennungsmerkmal des Overrides: das lokale Versionssuffix. Suffix-lose
    cu128-Einträge gewinnen NICHT (pip loeste sie dort gegen denselben Bestand,
    die PyPI-Aufloesung ist frischer) — aber sie werden uebernommen, wenn der
    PyPI-Report sie gar nicht liefert (Union-Fallback, Aussenstimme-Fund: ein
    Paket, das NUR im cu128-Baum steht, fiele sonst durchs Raster)."""
    ergebnis = dict(pypi)
    for name, version in cu128.items():
        if "+" in version:
            ergebnis[name] = version
        else:
            ergebnis.setdefault(name, version)
    return ergebnis


def pruefe_anzahl(n: int) -> None:
    if n < MIN_PAKETE:
        # Nicht nur die Zahl nennen: benennen, was wahrscheinlich passiert ist —
        # die Fehlermeldung ist der einzige Unterschied zu einem stillen Ausfall.
        print(f"NUR {n} PAKETE aufgeloest (Erwartung >= {MIN_PAKETE}) — vermutlich "
              f"das Manifest statt des Baums oder ein leerer pip-Report. "
              f"Scan abgebrochen: gruen ueber nichts ist schlimmer als rot.", file=sys.stderr)
        raise SystemExit(1)


def _pip_report(ziel: str, *argumente: str) -> None:
    """Dry-Run-Report erzeugen; wirft bei pip-Fehler (subprocess.CalledProcessError)."""
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--dry-run", "--quiet",
         "--ignore-installed", f"--report={ziel}", *argumente],
        check=True)


def haupt() -> None:
    _pip_report("req-report.json", "-r", "requirements.txt")
    _pip_report("torch-report.json", "torch", "torchaudio",
                "--index-url", CU128_INDEX)
    abbild = verschmelze(lies_report("req-report.json"), lies_report("torch-report.json"))
    pruefe_anzahl(len(abbild))
    zeilen = sorted(f"{name}=={version}" for name, version in abbild.items())
    Path(ZIEL).write_text("\n".join(zeilen) + "\n", encoding="utf-8")
    print(f"{ZIEL}: {len(zeilen)} Pakete")


if __name__ == "__main__":
    haupt()
```

- [ ] **Step 4: Grün laufen lassen**

Run: `python scripts/test_osv_freeze.py`
Expected: `alle Tests grün`

- [ ] **Step 5: Mutationsproben (je eine, dann sauber zurückspielen; vorher committen!)**

  1. In `verschmelze`: `if "+" in version` → `if False` UND `setdefault` → `pass` → `test_nur_lokale_suffixe_gewinnen_aus_cu128` muss rot sein (sonst prüft er nichts — die Zeile prüft Override UND Fallback).
  2. In `pruefe_anzahl`: `n < MIN_PAKETE` → `n < 0` → `test_waechter_schlaegt_unter_100_an` muss rot sein.
  3. In `normalisiere`: `.replace(".", "-")`-los (Regex raus, `return name`) → `test_pep503_normalisierung` muss rot sein.
  Nach jeder Mutation zurückspielen und GRÜN bestätigen. Kein `pytest | tail && …` — Lauf für sich.

- [ ] **Step 6: Realer Durchlauf lokal (Funktionstest dieser Fläche)**

Run: `cd /e/Git/Transkribor && .venv/Scripts/python.exe scripts/osv_freeze.py && head -3 requirements-resolved.txt && grep -c . requirements-resolved.txt && grep '^torch==' requirements-resolved.txt`
Expected: `requirements-resolved.txt: ~127 Pakete`; `torch==2.11.0+cu128` (nicht 2.13.0).
Danach prüfen: `grep -c '==' requirements-resolved.txt` ≥ 100.

**.gitignore erweitern** (Plan-Review D1, 2026-08-18) — das Skript schreibt seine drei Artefakte
ins Wurzelverzeichnis, lokal wie im CI-Checkout; ohne Eintrag committet sie irgendwann jemand
(der Hook sperrt nur `git add -A`), und `requirements-resolved.txt` driftet ohnehin (Constraint
oben):

```
requirements-resolved.txt
req-report.json
torch-report.json
```

- [ ] **Step 7: CI-Schritt in `test.yml` (Job `python`, nach `pip install …`)**

```yaml
      # osv_freeze-Tests: pytest sammelt scripts/ nicht — eigener Schritt,
      # Vorbild scripts/versionshoehe.test.sh im Job electron.
      - run: python scripts/test_osv_freeze.py
```

- [ ] **Step 8: Commit**

```bash
git add scripts/osv_freeze.py scripts/test_osv_freeze.py .github/workflows/test.yml .gitignore
git commit -m "feat(ci): osv_freeze — aufgeloestes Python-Abbild fuer OSV (#284)"
```

---

### Task 2: `.github/workflows/osv.yml` — der Workflow

**Files:**
- Create: `.github/workflows/osv.yml`

**Interfaces:**
- Consumes: Task 1 (`scripts/osv_freeze.py`, Artifact `osv-python-freeze` → `requirements-resolved.txt`).
- Produces: PR-Check „OSV / pr“ (rot nur bei NEUEN npm-Funden) + wöchentlicher Vollscan mit SARIF im Security-Tab.

- [ ] **Step 1: Workflow-Datei schreiben**

```yaml
name: OSV

# Issue #284: Schwachstellen in Abhaengigkeiten wurden bislang VON HAND verfolgt
# (CVE-Boden in requirements.txt). Zwei Laufe, bewusst unterschiedlich:
#   - PR: diff-basiert, nur die zwei npm-Lockfiles (kommittiert und exakt —
#     ein Renovate-PR, der auf eine verwundbare Version zieht, wird sofort rot).
#     fail-on-vuln true: NUR neue Funde; kein Merge-Zwang (keine Branch Protection).
#   - Vollscan: master-Push + woechentlich + von Hand. ALLES inkl. des aufgelösten
#     Python-Abbilds; fail-on-vuln FALSE — Altlasten (z.B. torch cu128 ohne Fix-
#     version) gehoeren in den Security-Tab, nicht als dauerrotes master.
#     Der woechentliche Lauf ist der Punkt: Luecken werden veroeffentlicht, ohne
#     dass sich unser Code aendert (Renovate haelt Fassungen aktuell, sagt aber
#     nicht, ob eine Fassung eine bekannte Luecke hat).
# Python im PR-Scan: bewusst NEIN — das Reusable-PR-Workflow vergleicht Base gegen
# Head; ein CI-generiertes Artifact bekäme entweder beide Seiten identisch (Python-
# Diff nie "neu") oder Base ohne Artifact (jeder Fund "neu"). Entscheidung 2026-08-18.
on:
  pull_request:
  push:
    branches: [master]
  schedule:
    - cron: '37 5 * * 1'   # montags 05:37 UTC — nicht :00/:30, niemand braucht Sync-Spitzen
  # ACHTUNG: workflow_dispatch registriert GitHub nur, sobald die Datei auf dem Default-
  # Branch liegt — ein Dispatch vom Feature-Branch scheitert für einen NEUEN Workflow mit
  # "workflow not found". Der erste Vollscan läuft daher über den master-Push nach dem
  # Merge (Task 3, Etappe 2); ab dann ist Dispatch der Trockenlauf-Weg.
  workflow_dispatch: {}

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

# security-events: write bewusst NUR an den Scan-Jobs (SARIF-Upload), nicht global.
permissions:
  contents: read
  actions: read

jobs:
  # Löst den Python-Baum OHNE Wheel-Download auf (PEP-658-Metadaten, gemessen
  # ~13 s) und merged nach der Installationsordnung aus electron/setup.js.
  # Der Wächter im Skript unterscheidet "nichts aufgeloest" von "aufgeloest".
  resolve-python:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: '3.13'
      - run: python scripts/osv_freeze.py
      - uses: actions/upload-artifact@v5
        with:
          name: osv-python-freeze
          path: requirements-resolved.txt
          retention-days: 7

  osv-pr:
    # Fork-PRs werden UEBERSPRUNGEN (Symlink-Risiko, osv-scanner-action#136 — s. Kommentar
    # in der echten Workflow-Datei); merge_group feuert erst mit einer Merge-Queue.
    if: github.event_name == 'merge_group' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork == false)
    permissions:
      contents: read
      actions: read
      # security-events: write ist NOETIG, obwohl upload-sarif false bleibt: der aufgerufene
      # Workflow deklariert das Recht intern, und der Aufrufer darf nicht WENIGER gewaehren
      # (Deckelungsregel — ohne die Zeile startup_failure, per Bisektion GEMESSEN 2026-08-18;
      # der Plan behauptete hier zuerst das Gegenteil, CodeRabbit fand den Widerspruch).
      # Der Fork-Schutz steckt im deaktivierten Upload-Step, das Recht wird nie eingelöst.
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@v2.5.1
    with:
      upload-sarif: false
      # BEWUSST kein --recursive ./ — das nähme requirements.txt als Manifest mit
      # (44 Funde, 38 gegen Phantom-Versionen; Messung im Plan). Nur die zwei
      # kommittierten Lockfiles, explizit.
      scan-args: |-
        --lockfile=package-lock.json:./package-lock.json
        --lockfile=package-lock.json:./webtool/frontend/package-lock.json

  osv-voll:
    if: github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    permissions:
      contents: read
      actions: read
      security-events: write
    needs: resolve-python
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.5.1
    with:
      download-artifact: osv-python-freeze
      scan-args: |-
        --lockfile=package-lock.json:./package-lock.json
        --lockfile=package-lock.json:./webtool/frontend/package-lock.json
        --lockfile=requirements.txt:./requirements-resolved.txt
      fail-on-vuln: false
```

- [ ] **Step 2: YAML-Validierung**

Run: `python -m pip install -q pyyaml && python -c "import yaml; yaml.safe_load(open('.github/workflows/osv.yml',encoding='utf-8')); print('yaml ok')"` (PyYAML-Präfix nötig — sonst schlägt die Prüfung an fehlendem Werkzeug fehl, nicht an YAML; Aussenstimme-Fund)
Expected: `yaml ok` (Syntaxfehler in Actions-YAML fallen sonst erst im Lauf auf).

- [ ] **Step 3: Commit + Branch + pushen (der PR öffnet sich erst in Task 3, nach dem Trockenlauf — erst dann stehen die echten Zahlen für den PR-Text fest)**

```bash
git checkout -b feat/osv-ci
git add .github/workflows/osv.yml
git commit -m "feat(ci): OSV-Scan — PR-Diff (npm) + Vollscan mit aufgeloestem Python-Abbild (#284)"
git push -u origin feat/osv-ci
```

---

### Task 3: Verifikation in zwei Etappen (der Funktionstest dieser Fläche)

**Files:** keine neuen — verifiziert Task 1+2 gegen die echte Welt.

**Interfaces:**
- Consumes: Branch `feat/osv-ci` aus Task 2, der Merge nach master.

**Warum zwei Etappen:** `workflow_dispatch` registriert GitHub nur für Workflows, die auf dem **Default-Branch** existieren — `gh workflow run osv.yml --ref feat/osv-ci` scheitert für einen NEUEN Workflow mit „workflow not found" (verifiziert an der GitHub-Doku-Registrierung, nicht geraten). Deshalb: Etappe 1 verifiziert den PR-Pfad am offenen PR, Etappe 2 den Vollscan-Pfad am master-Push nach dem Merge. Ab dann steht `workflow_dispatch` für alle künftigen Trockenläufe bereit.

- [ ] **Step 1: PR öffnen — osv-pr läuft automatisch**

```bash
gh pr create --base master --head feat/osv-ci \
  --title "OSV-Scanner in die CI (#284)" \
  --body "Fixes #284 — Details folgen nach dem Review." 
```
(PR-Text wird vor dem Merge durch die Messzahlen ersetzt, s. Step 6.)

- [ ] **Step 2: osv-pr am echten PR verifizieren**

Run: `gh run list --workflow=osv.yml --branch feat/osv-ci` dann `gh run view <id> --job <job-id> --log | grep -iE "lockfile|scanned.*packages"`
Expected: Job grün (npm heute sauber, Messung 3); als Quellen genau `package-lock.json` (Wurzel) und `webtool/frontend/package-lock.json` — **requirements.txt darf NICHT als Quelle auftauchen** (sonst greift der False-Positive-Pfad; dann scan-args-Form prüfen). Beleg: Die Reusable-Quelle zeigt, dass unsere `scan-args` den Default `-r ./` ERSETZEN (Input-Substitution) — ein Verzeichnis-Lauf findet nicht statt; das ist hier die Gegenprobe am echten Lauf.

- [ ] **Step 3: Abbild lokal fertig verifizieren (falls Task 1 Step 6 noch nicht komplett)**

Run: `.venv/Scripts/python.exe scripts/osv_freeze.py && grep -E '^(torch|sympy|networkx|fsspec)==' requirements-resolved.txt && grep -c '==' requirements-resolved.txt`
Expected: `torch==2.11.0+cu128`; sympy/networkx/fsspec vorhanden (Beweis, dass das Verwerfen der suffix-losen cu128-Einträge nichts verliert — sie kommen über die pyannote-Kette in den PyPI-Report); ≥ 100.
Optional mit Beleg: lokaler osv-scanner-Lauf gegen die Datei (Binary liegt nach der Messung unter %TEMP%/osv-test) muss dasselbe Fundbild wie Messung 2 liefern.

- [ ] **Step 4: Merge — und den master-Push-Lauf verifizieren (Etappe 2)**

Normale Repo-Kette vor dem Merge: Review-Subagent zuerst, CodeRabbit CLI (`--base-commit`), dann Bot; README NICHT nachgezogen — der Scan ist für Nutzer unsichtbar (README-Regel: interne Absicherung, kein neues Können).
Nach dem Rebase-Merge löst der Push den ersten echten Vollscan aus:

Run: `gh run list --workflow=osv.yml --branch master --limit 1` → `gh run view <id> --log | grep -E "requirements-resolved|PAKETE|torch=="` 
Expected: `resolve-python`: `requirements-resolved.txt: ~127 Pakete`, Wächter still, `torch==2.11.0+cu128` (nicht 2.13.0). `osv-voll`: grün trotz Funden (`fail-on-vuln: false`); im Log/Artifact drei Quellen, darunter das Abbild mit ~127 Paketen — **nicht** 12 (sonst hat der Artifact-Download ein anderes File geliefert als scan-args erwartet).

- [ ] **Step 5: SARIF/Security-Tab verifizieren**

Run: `gh api "repos/napoleonmm83/Transkribor/code-scanning/alerts?per_page=10" --jq '.[].rule.id'`
Expected: Alerts aus Abbild-Quellen (z. B. GHSA-rrmf-rvhw-rf47 an torch — der Fund, der die torch-Abdeckung rechtfertigt). Das Repo ist ÖFFENTLICH (isPrivate false, gemessen 2026-08-18) — der SARIF-Upload in den Security-Tab ist damit frei verfügbar, kein GHAS nötig. Ein 404 „no analysis found" vor dem ersten Lauf ist normal.

- [ ] **Step 6: Wächter-Negativkontrolle (lokal, einmalig)**

Run: `python -c "import sys; sys.path.insert(0,'scripts'); import osv_freeze as o; o.MIN_PAKETE=200; o.pruefe_anzahl(127)"`
Expected: Exit 1 mit der Wächtermeldung („NUR 127 PAKETE"). Beweist, dass der Wächter den Lauf wirklich stoppen kann — dieselbe Regel wie die Mutationsprobe am Test, ohne einen CI-Lauf zu verbiegen.

- [ ] **Step 7: PR-Text finalisieren + Aufräumen**

PR-Text (vor dem Merge, Ton der README, kein Changelog): was der Scan tut (PR rot bei neuen npm-Funden; Security-Tab für Altlasten), die Messung 44-vs-12 als Begründung fürs Abbild, `Fixes #284`. Nach dem Merge: Branch gelöscht (gh pr merge --delete-branch), `requirements-resolved.txt`/`*-report.json` lokal löschen (nie committet), Issue #284 durch `Fixes` geschlossen prüfen.

---

## Nach dem Merge (ausserhalb des PR, Pflichten dieser Repo)

- **Lokale CLAUDE.md** (gitignoriert, #110): kurzer Abschnitt „OSV-Scan in der CI“ mit den vier Fakten, die man nicht aus dem Diff liest: (1) Abbild statt Manifest + Messung 44/12, (2) cu128-Suffix-Regel, (3) warnen/strenge-Teilung, (4) `osv-scanner.toml` erst bei echtem Fund. Kurz halten — das Plan-Dokument bleibt die ausführliche Quelle.
- **MEMORY.md**: #284 als erledigt; neue offene Punkte (z. B. torch GHSA-rrmf ohne Fixversion auf cu128 → beobachten) als Issue, falls sinnvoll.
- **Issue für den torch-Fund prüfen:** GHSA-rrmf-rvhw-rf47 an torch 2.11.0+cu128 ist ein echtes, offenes stehendes Finding. Wenn cu128 keine Fixfassung liefert, ist das ein bewusst getragenes Restrisiko → Issue anlegen (Fundstelle, warum es zählt, wie gefunden).

## Was bewusst NICHT gebaut wird

- **Release-Gating** (Google-Doku zeigt einen Scan im Release-Workflow): unser Release ist manuell (`workflow_dispatch` auf release.yml) und master wird ohnehin bei jedem Push gescannt — Doppelstruktur ohne Gewinn.
- **`pip freeze` aus der echten venv committieren** und **kein kommittierter Lockfile** (Aussenstimme schlug beides vor, 2026-08-18 — widerlegt am Produkt): der Installer installiert beim ersten App-Start bewusst **ungepinnt frisch** (`electron/setup.js` + der `requirements`-Stempel zieht bei App-Updates nach). Ein Lockfile scannte den Stand des Commits — nicht das, was ein Nutzer nächsten Monat tatsächlich installiert bekommt. Das Dry-Run-Abbild ist das ehrlichere Modell der echten Installation; beides driftet ausserdem zwischen Renovate-PRs. Die wöchentliche Neuauflösung ist der Punkt des Scheduled-Scans.
- **Scorecard/andere Security-Scans**: nicht bestellt (YAGNI).

## Bekannte Grenzen (dokumentiert, bewusst getragen)

- **Bewegter Base-Vergleich im PR-Scan** (Aussenstimme-Fund, an der v2.5.1-Quelle bestätigt): das Reusable-PR-Workflow checkt `$GITHUB_BASE_REF` aus, nicht den Merge-Base-SHA — rückt master während eines Laufs, kann die Neu-Alt-Einordnung im Grenzfall kippen. Nicht aufrufseitig behebbar; der Vollscan auf master korrigiert jede Fehleinordnung spätestens beim Merge.
- **Das Abbild ist eine Näherung**: zwei Auflösungen + Merge-Regel statt einer echten Installation. Das sicherheitsrelevante Paar (torch/torchaudio, +cu128) ist exakt; suffix-lose Transitiven können vom realen Install abweichen. Die Alternative (echte 3-GB-Installation in der CI) wäre exakter und massiv teurer — bewusst nicht gewählt.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architektur & Tests | 1 | CLEAR (PLAN) | 1 Issue (D1 .gitignore, angenommen), 0 kritische Gaps |
| Outside Voice | codex (Plan-Review) | Unabhängige Gegenprobe | 1 | issues_found | 10 Funde: 3 ratifiziert (D3/D4/D5), 2 als bekannte Grenzen dokumentiert, 5 triagiert |
| Subagent-Review | Repo-Konvention (vorgeschaltet) | Eigens gebauter Kontext | 2 | FEHLGESCHLAGEN | 2× an Kontextgrenze gestorben; Verifikation stattdessen selbst an v2.5.1-Quellen mit Zitaten |

- **UNRESOLVED:** 0
- **VERDICT:** ENG + AUSSENSTIMME CLEARED — bereit zur Umsetzung.

*(Review 2026-08-18: Messungen 1–4 und die fünf ratifizierten Entscheidungen D1–D5 sind oben im Plan dokumentiert.)*
