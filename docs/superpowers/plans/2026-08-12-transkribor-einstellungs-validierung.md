# Einstellungs-Validierung (#139) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Beide Einstellungs-PUT-Endpunkte lehnen unbekannte `sprache`/`korrektur`-Werte sofort mit `400` ab, statt sie still nach `projekt.json` zu schreiben und später im Job scheitern zu lassen.

**Architecture:** Ein gemeinsamer Validator `sprachen.pruef_fehler()` (die EINE Quelle für Sprach-/Tiefenwerte), aufgerufen von beiden PUT-Handlern (`projekteinstellungen_speichern`, `dateieinstellungen_speichern`) vor dem Schreiben. Keine Migration bestehender Daten, keine Änderung am GET.

**Tech Stack:** Python/FastAPI, pytest.

**Spec:** `docs/superpowers/specs/2026-08-12-transkribor-einstellungs-validierung-design.md`

## Global Constraints

- **Status-Code `400`** für ungültige Werte (nicht 422) — konsistent mit dem bestehenden `_validate` (Namen-Validierung → 400) in denselben Endpunkten. `detail` nennt das fehlerhafte Feld.
- **Eine Quelle:** der Validator lebt in `webtool/sprachen.py` und wird von **beiden** PUT-Handlern konsumiert — keine zwei Validierungs-Pfade.
- **Gültige Werte:** `sprache` ∈ `SPRACHEN`-Keys (`ch/de/en/fr/it/auto`); `korrektur` ∈ `{TIEFE_DEFAULT} ∪ TIEFEN-IDs` = `auto/voll_dialekt/voll/leicht/zusammenfassung`. **`"auto"` bleibt erlaubt** (es ist `TIEFE_DEFAULT`).
- **`None` erlaubt:** nicht gesendete Felder (Partial-Update) ändern nichts.
- **Keine Migration:** bestehende `projekt.json`-Einträge werden nicht nachträglich geprüft — nur der Schreibpfad wird geschärft.
- **GET unangetastet**, Frontend-Auswahlen unangetastet.
- **Backend-Tests** müssen `TRANSKRIBOR_SETTINGS` setzen (die `client`-Fixture in `webtool/test_api.py:8` tut das). Die Fixture liefert das `Demo`-Projekt mit Datei `S1` (Roh-JSON + `S1.mp3`).
- **Commit-Style:** Conventional Commits (`feat(backend): …` / `fix(backend): …`, deutscher Text), `Co-Authored-By: Claude <noreply@anthropic.com>`. Branch: `fix/einstellungs-validierung-139` (bereits erstellt). venv-python: `.venv\Scripts\python.exe`.
- **CLAUDE.md** bleibt **lokal-only** per #110 (untracked/gitignored) — **niemals** `git add CLAUDE.md` (würde die ganze Datei neu tracken und #110 umkehren). Der CLAUDE.md-Pflege-Eintrag aus Task 3 wird nicht committet.

## File Structure

- **`webtool/sprachen.py`** (modify) — eine neue Funktion `pruef_fehler(sprache=None, korrektur=None) -> str | None`. Die EINE Quelle für Gültigkeit, konsumiert von beiden Endpunkten.
- **`webtool/test_sprachen.py`** (modify) — Unit-Tests für `pruef_fehler` (gültig/ungültig/auto/None, Meldung nennt den Wert).
- **`webtool/app.py`** (modify) — identischer Guard in `projekteinstellungen_speichern` (≈Zeile 242) und `dateieinstellungen_speichern` (≈Zeile 262), je nach `_validate(...)`, vor dem Schreiben.
- **`webtool/test_api.py`** (modify) — 4 API-Tests (2 Endpunkte × 2 Felder → 400) + 1 Test dass `auto` gültig bleibt.
- **`CLAUDE.md`** (modify, **lokal, nicht committet**) — Ein-Satz-Fakt im Einstellungs-Abschnitt.

---

### Task 1: Validator in `sprachen.py` + Unit-Tests

**Files:**
- Modify: `webtool/sprachen.py` (neue Funktion `pruef_fehler`, ans Ende der Datei)
- Test: `webtool/test_sprachen.py` (neue Tests ans Ende)

**Interfaces:**
- Consumes: `SPRACHEN`, `TIEFEN`, `TIEFE_DEFAULT` (in `sprachen.py`, vorhanden).
- Produces: `pruef_fehler(sprache: str | None = None, korrektur: str | None = None) -> str | None` — liefert eine Fehlermeldung (mit Feldname + Wert) bei ungültigem Wert, sonst `None`. Task 2 ruft diese Funktion.

- [ ] **Step 1: Schreibe die fehlschlagenden Unit-Tests**

Ans Ende von `webtool/test_sprachen.py` anfügen:

```python
def test_pruef_fehler_gueltig():
    # None-Argumente (Partial-Update) sind erlaubt — ändern nichts.
    assert sprachen.pruef_fehler() is None
    assert sprachen.pruef_fehler(sprache="ch") is None
    assert sprachen.pruef_fehler(sprache="auto") is None
    assert sprachen.pruef_fehler(korrektur="voll") is None
    assert sprachen.pruef_fehler(korrektur="auto") is None      # TIEFE_DEFAULT bleibt erlaubt
    assert sprachen.pruef_fehler(sprache="en", korrektur="leicht") is None


def test_pruef_fehler_unbekannte_sprache():
    msg = sprachen.pruef_fehler(sprache="enm")
    assert msg is not None and "enm" in msg and "Sprache" in msg


def test_pruef_fehler_unbekannte_tiefe():
    msg = sprachen.pruef_fehler(korrektur="galaktisch")
    assert msg is not None and "galaktisch" in msg and "Tiefe" in msg
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_sprachen.py -k pruef_fehler -q`
Expected: FAIL (`AttributeError: module 'webtool.sprachen' has no attribute 'pruef_fehler'`).

- [ ] **Step 3: Implementiere den Validator**

Ans Ende von `webtool/sprachen.py` anfügen:

```python
def pruef_fehler(sprache: str | None = None, korrektur: str | None = None) -> str | None:
    """Liefert eine Fehlermeldung, wenn ``sprache``/``korrektur`` kein bekannter Wert ist, sonst None.

    None-Argumente (nicht gesendete Felder) sind erlaubt — ein PUT ist ein Partial-Update.
    Die EINE Quelle fuer Gueltigkeit, konsumiert von beiden Einstellungs-Endpunkten (s. app.py);
    eine zweite Pruefung dort wuerde von dieser Tabelle wegdriften.
    """
    if sprache is not None and sprache not in SPRACHEN:
        return f"unbekannte Sprache: {sprache!r} (erlaubt: {', '.join(SPRACHEN)})"
    gueltige_tiefen = {TIEFE_DEFAULT} | {t["id"] for t in TIEFEN}
    if korrektur is not None and korrektur not in gueltige_tiefen:
        return f"unbekannte Korrektur-Tiefe: {korrektur!r} (erlaubt: {', '.join(sorted(gueltige_tiefen))})"
    return None
```

- [ ] **Step 4: Tests laufen lassen — sie müssen durch**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_sprachen.py -q`
Expected: PASS (alle, inkl. der 3 neuen).

- [ ] **Step 5: Commit**

```bash
git add webtool/sprachen.py webtool/test_sprachen.py
git commit -m "feat(sprachen): pruef_fehler validiert sprache/korrektur gegen SPRACHEN/TIEFEN (#139)"
```

---

### Task 2: Guards in beiden PUT-Handlern + API-Tests

**Files:**
- Modify: `webtool/app.py` — Guard in `projekteinstellungen_speichern` (≈Zeile 245, nach `_validate(project)`) und in `dateieinstellungen_speichern` (≈Zeile 270, nach `_validate(project, base)`).
- Test: `webtool/test_api.py` — 5 neue Tests (4 × 400 + 1 × auto bleibt 200).

**Interfaces:**
- Consumes: `_sprachen.pruef_fehler(...)` aus Task 1; `_validate`, `EinstellungenBody`, `_projekt` (alle vorhanden). `_sprachen` ist bereits als Modul importiert (oben in `app.py`).
- Produces: beide PUT-Endpunkte antworten `400` mit Feldname im `detail` auf unbekannte `sprache`/`korrektur`.

- [ ] **Step 1: Schreibe die fehlschlagenden API-Tests**

Ans Ende von `webtool/test_api.py` anfügen:

```python
# --- Einstellungs-Validierung: unbekannte Werte sofort 400 (#139) ------------

def test_projekteinstellungen_lehnt_unbekannte_sprache_ab(client, tmp_projekt):
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"sprache": "enm"})
    assert r.status_code == 400
    assert "Sprache" in r.json()["detail"]


def test_projekteinstellungen_lehnt_unbekannte_tiefe_ab(client, tmp_projekt):
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"korrektur": "galaktisch"})
    assert r.status_code == 400
    assert "Tiefe" in r.json()["detail"]


def test_dateieinstellungen_lehnt_unbekannte_sprache_ab(client, tmp_projekt):
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprache": "enm"})
    assert r.status_code == 400
    assert "Sprache" in r.json()["detail"]


def test_dateieinstellungen_lehnt_unbekannte_tiefe_ab(client, tmp_projekt):
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"korrektur": "galaktisch"})
    assert r.status_code == 400
    assert "Tiefe" in r.json()["detail"]


def test_einstellungen_auto_tiefe_bleibt_gueltig(client, tmp_projekt):
    # "auto" ist TIEFE_DEFAULT und muss am PUT akzeptiert bleiben (Regressionsschutz).
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"korrektur": "auto"})
    assert r.status_code == 200
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -k "lehnt_unbekannte or auto_tiefe_bleibt" -q`
Expected: FAIL (die vier `lehnt_unbekannte_*`-Tests: Status ist `200`, nicht `400`, weil der Wert noch still geschrieben wird). Der `auto_tiefe_bleibt`-Test kann schon grün sein (Vorab-Bestätigung).

- [ ] **Step 3: Guard in `projekteinstellungen_speichern` einbauen**

In `webtool/app.py`, in `projekteinstellungen_speichern`, die Zeile `_validate(project)` um den Guard ergänzen. Aus

```python
@app.put("/api/projects/{project}/einstellungen")
def projekteinstellungen_speichern(project: str, body: EinstellungenBody):
    _validate(project)
    # speichern() ueberspringt None-Werte (isinstance-Check auf str) -> leerer Body ist sicher.
    d = _projekt.speichern(project, {"sprache": body.sprache, "korrektur": body.korrektur})
    return {"sprache": d["sprache"], "korrektur": d["korrektur"]}
```

wird

```python
@app.put("/api/projects/{project}/einstellungen")
def projekteinstellungen_speichern(project: str, body: EinstellungenBody):
    _validate(project)
    fehler = _sprachen.pruef_fehler(sprache=body.sprache, korrektur=body.korrektur)
    if fehler:
        raise HTTPException(status_code=400, detail=fehler)
    # speichern() ueberspringt None-Werte (isinstance-Check auf str) -> leerer Body ist sicher.
    d = _projekt.speichern(project, {"sprache": body.sprache, "korrektur": body.korrektur})
    return {"sprache": d["sprache"], "korrektur": d["korrektur"]}
```

- [ ] **Step 4: Guard in `dateieinstellungen_speichern` einbauen**

In `webtool/app.py`, in `dateieinstellungen_speichern`, die Zeile `_validate(project, base)` um den Guard ergänzen. Aus

```python
    _validate(project, base)
    _projekt.setze_datei(project, base, sprache=body.sprache, korrektur=body.korrektur)
```

wird

```python
    _validate(project, base)
    fehler = _sprachen.pruef_fehler(sprache=body.sprache, korrektur=body.korrektur)
    if fehler:
        raise HTTPException(status_code=400, detail=fehler)
    _projekt.setze_datei(project, base, sprache=body.sprache, korrektur=body.korrektur)
```

- [ ] **Step 5: Tests laufen lassen — sie müssen durch**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -k "lehnt_unbekannte or auto_tiefe_bleibt" -q`
Expected: PASS (5 Tests).

- [ ] **Step 6: Volle Backend-Suite (Regression)**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py webtool/test_sprachen.py -q`
Expected: PASS (insb. die bestehenden `einstellungen_speichern`-/`dateieinstellungen_speichern_*`-Tests, die gültige Werte senden, bleiben grün — der Guard lässt gültige Werte durch).

- [ ] **Step 7: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "fix(backend): Einstellungs-PUT lehnt unbekannte sprache/korrektur mit 400 ab (#139)"
```

---

### Task 3: CLAUDE.md-Pflege (lokal, nicht committet)

**Files:**
- Modify: `CLAUDE.md` (lokal, **gitignored per #110 — NICHT committen**, nicht `git add`)

**Interfaces:** keine (Doku).

- [ ] **Step 1: CLAUDE.md-Fakt ergänzen**

In `CLAUDE.md`, im Abschnitt „Sprachauswahl + Korrektur-Tiefe (pro Datei)" (dort wo auch die `Endpunkte:`- und die `Datei-Einstellungen nachträglich (#135)`-Einträge stehen), einen Ein-Satz-Fakt anfügen, sinngemäß (im gemessenen Engineering-Ton der Nachbarn):

> - **Einstellungs-Validierung (#139):** beide PUT-Endpunkte (`…/einstellungen` und `…/files/{base}/einstellungen`) lehnen unbekannte `sprache`/`korrektur`-Werte mit **400** ab, geprüft via `sprachen.pruef_fehler` (die EINE Quelle; erlaubt `sprache` ∈ SPRACHEN und `korrektur` ∈ `{auto} ∪ TIEFEN`). `400` (nicht 422) wg. Konsistenz mit `_validate`. Bestehende `projekt.json`-Einträge werden nicht nachträglich geprüft — nur der Schreibpfad ist geschärft.

- [ ] **Step 2: NICHT committen**

CLAUDE.md ist untracked/gitignored (#110). Der Eintrag bleibt lokal. **Kein `git add`, kein Commit** — das würde die ganze Datei neu tracken und #110 umkehren. (Siehe Lerneintrag [[gitignorierte-datei-ueberlebt-rebase-nicht]].)

- [ ] **Step 3: Verifizieren, dass CLAUDE.md nicht im Branch gelandet ist**

Run: `git status --short` und `git log --oneline master..HEAD`
Expected: kein `CLAUDE.md`-Eintrag in `git status` (gitignored) und kein CLAUDE.md-Commit im Branch.

---

## Self-Review (vor Übergabe)

**1. Spec-Abdeckung:**
- Validator in `sprachen.py`, von beiden Endpunkten → Task 1 (Funktion) + Task 2 (Guards). ✓
- `sprache` ∈ SPRACHEN, `korrektur` ∈ `{auto} ∪ TIEFEN`, `None` erlaubt → Task 1 (`pruef_fehler`) + Task-1-Test `test_pruef_fehler_gueltig`. ✓
- `400` mit Feldname → Task 2 (Guards heben `HTTPException(status_code=400)`); API-Tests prüfen `"Sprache"`/`"Tiefe"` im `detail`. ✓
- `"auto"` bleibt gültig → Task-1-Test (`korrektur="auto" is None`) + Task-2-Test (`auto_tiefe_bleibt_gueltig` → 200). ✓
- Keine Migration, GET unangetastet → Plan berührt nur PUT-Handler + Validator. ✓
- CLAUDE.md lokal-only → Task 3 (kein Commit). ✓

**2. Placeholder-Scan:** alle Schritte enthalten vollständigen Code/Test-Code; keine TBD/TODO. ✓

**3. Typ-/Namens-Konsistenz:** `pruef_fehler(sprache=None, korrektur=None) -> str | None` — gleich in Task 1 (Definition) und Task 2 (Aufruf `_sprachen.pruef_fehler(sprache=body.sprache, korrektur=body.korrektur)`). Detail-Strings enthalten „Sprache"/„Tiefe" — passend zu den API-Test-Assertionen (`"Sprache" in detail`, `"Tiefe" in detail`). ✓
