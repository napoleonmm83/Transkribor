# Mehrsprachige Transkription (Teil A) — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine Aufnahme, in der mehrere Sprachen gesprochen werden, wird so transkribiert, dass jede Passage in ihrer eigenen Sprache im Transkript steht.

**Architecture:** Der Nutzer markiert eine Datei als mehrsprachig; die gewählte Sprache wird damit zur **Ankersprache**. Für solche Dateien fährt faster-whisper mit `multilingual=True` **und** `condition_on_previous_text=False` (nur beides zusammen wirkt — Messung in der Spec), und ein delegierender Proxy um das ct2-Modell klemmt unsichere Spracherkennungen auf den Anker. Korrektur- und Treue-Prompt bekommen je eine Regelzeile, damit der Verify-Lauf die Fremdsprache nicht als Untreue zurückdreht.

**Tech Stack:** Python 3.13, faster-whisper 1.2.1 (CTranslate2), FastAPI/pydantic, pytest · React 19 + TypeScript + Tailwind v4, vitest

**Spec:** `docs/superpowers/specs/2026-08-13-transkribor-mehrsprachige-transkription-design.md`

## Global Constraints

- **`multilingual=True` und `condition_on_previous_text=False` sind untrennbar.** Einzeln ist jedes ein Rückschritt: allein `multilingual` erkennt Englisch korrekt (p=0,938) und gibt es trotzdem auf Deutsch zurück. Nie eines ohne das andere setzen.
- **Beides gilt NUR für als mehrsprachig markierte Dateien.** Auf einsprachigem Material messbar schlechter (206 → 89 identische Segmenttexte).
- **Schwellenvorgabe `TRANSKRIBOR_MIX_SCHWELLE` = `0.7`.** Geraten auf drei Messpunkten (0,289 / 0,432 falsch, 0,938 richtig) — im Code als Stellschraube kommentieren, nicht als Kalibrierung ausgeben.
- **Vorgabewert von `mehrsprachig` ist `False`** auf Projekt- und Dateiebene. Bestehende Projekte dürfen ihr Verhalten nicht ändern.
- **Bool-Rückfall NIE über `or`.** `datei_sprache` tut das für Strings; für einen bool wäre ein bewusst gesetztes `False` falsy und fiele auf den Projektwert zurück. Immer auf **Anwesenheit des Schlüssels** prüfen.
- **Sprachbezogene Prompt-Phrasen stehen in `webtool/sprachen.py`** — die EINE Quelle. Kein Literal in `correct.py`.
- **Kommentare und Prompts auf Deutsch**, im Ton des Repos: begründen, was man nicht aus dem Diff liest.
- **Tests werden mutationsgeprüft:** Logik entfernen → genau dieser Test rot. Ein Test, der ohne den Fix grün bleibt, ist Dekoration.
- Testlauf Python: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q`
- Testlauf Frontend: `npm --prefix webtool/frontend run test -- --run`

---

### Task 1: `mehrsprachig` in Projekt- und Datei-Einstellungen

**Files:**
- Modify: `webtool/sprachen.py` (Konstante + `pruef_fehler`)
- Modify: `webtool/projekt.py:65-124` (`laden`, `speichern`, `setze_datei`, neu `datei_mehrsprachig`)
- Test: `webtool/test_sprachen.py`, `webtool/test_projekt.py`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `sprachen.ZIEL_MEHRSPRACHIG: str` — Regeltext für die Prompts (Task 5)
  - `sprachen.pruef_fehler(sprache=None, korrektur=None, mehrsprachig=None) -> str | None`
  - `projekt.setze_datei(project, base, sprache=None, korrektur=None, mehrsprachig=None) -> dict`
  - `projekt.datei_mehrsprachig(project: str, base: str) -> bool`
  - `projekt.laden(project)["mehrsprachig"] -> bool`

- [ ] **Step 1: Die Tests schreiben**

In `webtool/test_projekt.py` ergänzen (die Datei benutzt bereits eine `tmp_path`-Fixture mit `TRANSKRIBOR_PROJEKTE`; dasselbe Muster übernehmen):

```python
def test_laden_setzt_mehrsprachig_auf_false(projekt_root):
    assert projekt.laden("p")["mehrsprachig"] is False


def test_laden_ignoriert_falschen_typ_bei_mehrsprachig(projekt_root):
    projekt._write("p", {"mehrsprachig": "ja"})
    assert projekt.laden("p")["mehrsprachig"] is False


def test_speichern_nimmt_bool_auf(projekt_root):
    d = projekt.speichern("p", {"mehrsprachig": True})
    assert d["mehrsprachig"] is True
    assert projekt.laden("p")["mehrsprachig"] is True


def test_setze_datei_schreibt_mehrsprachig(projekt_root):
    projekt.setze_datei("p", "a", mehrsprachig=True)
    assert projekt.datei_mehrsprachig("p", "a") is True


def test_datei_mehrsprachig_faellt_auf_projekt_zurueck(projekt_root):
    projekt.speichern("p", {"mehrsprachig": True})
    assert projekt.datei_mehrsprachig("p", "unbekannt") is True


def test_datei_false_schlaegt_projekt_true(projekt_root):
    """Der Kern: ein bewusst abgewaehltes False ist falsy. Loest der Rueckfall wie
    `datei_sprache` ueber `or` auf, gewinnt der Projektwert und der Haken laesst sich
    pro Datei nie wieder abwaehlen. Geprueft wird die Anwesenheit des SCHLUESSELS."""
    projekt.speichern("p", {"mehrsprachig": True})
    projekt.setze_datei("p", "a", mehrsprachig=False)
    assert projekt.datei_mehrsprachig("p", "a") is False
```

In `webtool/test_sprachen.py` ergänzen:

```python
def test_pruef_fehler_lehnt_nicht_bool_ab():
    assert sprachen.pruef_fehler(mehrsprachig="ja") is not None


def test_pruef_fehler_erlaubt_bool_und_none():
    assert sprachen.pruef_fehler(mehrsprachig=True) is None
    assert sprachen.pruef_fehler(mehrsprachig=False) is None
    assert sprachen.pruef_fehler(mehrsprachig=None) is None
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_projekt.py webtool/test_sprachen.py -q`
Expected: FAIL — `KeyError: 'mehrsprachig'` bzw. `AttributeError: module 'webtool.projekt' has no attribute 'datei_mehrsprachig'`

- [ ] **Step 3: `webtool/sprachen.py` ergänzen**

Nach dem `TIEFEN`-Block einfügen:

```python
# Regeltext fuer die Korrektur-Prompts bei mehrsprachigen Aufnahmen. Steht HIER und nicht
# in correct.py: sprachbezogene Prompt-Phrasen haben eine Quelle (wie `ziel`), sonst driften
# Korrektur- und Treue-Prompt auseinander -- genau der Fehler, an dem die [Musik]-Regel hing.
ZIEL_MEHRSPRACHIG = (
    "Die Aufnahme enthält mehrere Sprachen. Belasse jede Passage in der Sprache, in der sie "
    "gesprochen wurde — übersetze nichts. Innerhalb einer Passage gelten die Korrekturregeln "
    "ihrer eigenen Sprache."
)
```

`pruef_fehler` erweitern (Signatur und Rückgabe wie gehabt, ein Block dazu):

```python
def pruef_fehler(sprache: str | None = None, korrektur: str | None = None,
                 mehrsprachig=None) -> str | None:
    ...
    # (bestehende sprache-/korrektur-Pruefungen unveraendert davor)
    if mehrsprachig is not None and not isinstance(mehrsprachig, bool):
        return f"mehrsprachig muss true oder false sein, nicht {mehrsprachig!r}"
    return None
```

Den Docstring um einen Satz ergänzen: `mehrsprachig` ist ein bool, `None` bleibt frei (Partial-Update).

- [ ] **Step 4: `webtool/projekt.py` ergänzen**

In `laden()` (bei den anderen `data.get`-Zeilen):

```python
    mehrsprachig = data.get("mehrsprachig")
```

und im zurückgegebenen dict:

```python
        "mehrsprachig": mehrsprachig if isinstance(mehrsprachig, bool) else False,
```

In `speichern()` **nach** der bestehenden String-Schleife:

```python
        # Eigener Zweig: die Schleife darueber filtert auf isinstance(str) -- ein bool
        # faellt dort durch und waere still verworfen worden (das Kaestchen liesse sich
        # setzen, ohne dass etwas passiert).
        if isinstance(patch.get("mehrsprachig"), bool):
            cur["mehrsprachig"] = patch["mehrsprachig"]
```

In `setze_datei()` Signatur `mehrsprachig=None` ergänzen und:

```python
        if mehrsprachig is not None:
            eintrag["mehrsprachig"] = bool(mehrsprachig)
```

Neue Funktion nach `datei_korrektur`:

```python
def datei_mehrsprachig(project: str, base: str) -> bool:
    """Enthaelt die Datei mehrere Sprachen? Datei-Override, sonst Projekt-Standard.

    Der Rueckfall geht ueber die ANWESENHEIT des Schluessels, nicht ueber `or` wie bei
    datei_sprache: ein bewusst gesetztes False ist falsy: mit `or` gewaenne der
    Projektwert und der Haken liesse sich pro Datei nie wieder abwaehlen. Dasselbe
    Prinzip wie `"text": ""` in apply_correction -- der Schluessel entscheidet, nicht der Wert.
    """
    d = laden(project)
    e = d["dateien"].get(base, {})
    if "mehrsprachig" in e:
        return bool(e["mehrsprachig"])
    return bool(d["mehrsprachig"])
```

- [ ] **Step 5: Tests laufen lassen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_projekt.py webtool/test_sprachen.py -q`
Expected: PASS

- [ ] **Step 6: Mutationsprobe**

`datei_mehrsprachig` versuchsweise auf `return bool(e.get("mehrsprachig") or d["mehrsprachig"])` umstellen und erneut laufen lassen.
Expected: `test_datei_false_schlaegt_projekt_true` **rot**. Danach zurückändern.

Ebenso: den `isinstance(..., bool)`-Zweig in `speichern` entfernen → `test_speichern_nimmt_bool_auf` rot. Zurückändern.

- [ ] **Step 7: Commit**

```bash
git add webtool/sprachen.py webtool/projekt.py webtool/test_projekt.py webtool/test_sprachen.py
git commit -m "feat(sprachen): mehrsprachig-Flag pro Projekt und Datei"
```

---

### Task 2: `_opts` schaltet beide Decoder-Parameter

**Files:**
- Modify: `transcribe.py:84-123` (`_opts`)
- Test: `webtool/test_transcribe.py`

**Interfaces:**
- Consumes: nichts
- Produces: `transcribe._opts(language, mehrsprachig: bool = False) -> dict`

- [ ] **Step 1: Die Tests schreiben**

In `webtool/test_transcribe.py`:

```python
def test_opts_vorgabe_ist_unveraendert():
    """Constraint-Test: die einsprachige Pipeline muss byte-identisch bleiben.
    Ohne ihn faellt eine versehentliche Umstellung der Vorgaben niemandem auf --
    das Ergebnis waere weiterhin plausibler Text, nur schlechter."""
    o = transcribe._opts("de")
    assert o["condition_on_previous_text"] is True
    assert "multilingual" not in o


def test_opts_mehrsprachig_setzt_multilingual():
    assert transcribe._opts("de", mehrsprachig=True)["multilingual"] is True


def test_opts_mehrsprachig_schaltet_kontext_ab():
    """Zwei getrennte Tests, weil es zwei getrennte Fehlermoeglichkeiten sind.
    Nur multilingual: Whisper erkennt Englisch korrekt (p=0.938 gemessen) und gibt es
    trotzdem auf Deutsch zurueck, weil der deutsche Kontext als Prompt mitreist."""
    assert transcribe._opts("de", mehrsprachig=True)["condition_on_previous_text"] is False
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -q -k opts`
Expected: FAIL — `TypeError: _opts() got an unexpected keyword argument 'mehrsprachig'`

- [ ] **Step 3: `_opts` umbauen**

Den bestehenden Docstring **vollständig behalten** (er trägt die `initial_prompt`-Messung) und einen Absatz anhängen:

```
    `mehrsprachig=True` setzt ZWEI Parameter, und die gehoeren zusammen: multilingual=True
    laesst faster-whisper die Sprache pro 30-s-Fenster neu erkennen, aber ohne
    condition_on_previous_text=False bleibt es wirkungslos -- der deutsche Vorlauf reist als
    Prompt mit und schlaegt das <|en|>-Token, Whisper uebersetzt dann. Gemessen an echtem
    Audio mit 40 s englischem Einschub: nur multilingual -> "Ich kam hier aus Manchester mit
    meinem Klub."; beides -> "I came here from Manchester with my club." Nur fuer als
    mehrsprachig markierte Dateien: auf einsprachigem Material ist es messbar schlechter.
```

Rumpf:

```python
def _opts(language, mehrsprachig=False):
    o = dict(
        language=language, task="transcribe",
        word_timestamps=True, beam_size=5, best_of=5,
        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        condition_on_previous_text=True,
        vad_filter=False, log_progress=True,
    )
    if mehrsprachig:
        o["multilingual"] = True
        o["condition_on_previous_text"] = False
    return o
```

- [ ] **Step 4: Tests laufen lassen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -q`
Expected: PASS (inkl. `test_opts_gibt_whisper_KEINEN_initial_prompt`)

- [ ] **Step 5: Mutationsprobe**

Je eine der beiden Zeilen im `if mehrsprachig`-Block entfernen und erneut laufen lassen.
Expected: jeweils **genau einer** der beiden neuen Tests rot. Danach zurückändern.

- [ ] **Step 6: Commit**

```bash
git add transcribe.py webtool/test_transcribe.py
git commit -m "feat(transcribe): _opts schaltet multilingual + Kontext-aus gemeinsam"
```

---

### Task 3: Der Schwellenproxy

**Files:**
- Modify: `transcribe.py` (Konstante bei den anderen Env-Werten, Klasse neben `_opts`)
- Test: `webtool/test_transcribe.py`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `transcribe.MIX_SCHWELLE: float`
  - `transcribe._Sprachschwelle(echt, anker: str | None, schwelle: float)` mit `.detect_language(enc)`, `.fenster: list[list]` und Attribut `_echt`

- [ ] **Step 1: Die Tests schreiben**

```python
class _FakeCt2:
    """Nachbau des ct2-Modells: liefert vorgegebene Erkennungen der Reihe nach.
    Gegen das echte Modell zu testen hiesse, 3 GB zu laden und Audio zu brauchen --
    geprueft wird hier die Klemm-Logik, nicht Whisper."""
    def __init__(self, folge):
        self.folge = list(folge)
    def detect_language(self, enc):
        code, p = self.folge.pop(0)
        return [[(f"<|{code}|>", p)]]


def _code(ergebnis):
    return ergebnis[0][0][0][2:-2]


def test_schwelle_klemmt_unsicheren_wechsel_auf_den_anker():
    """Gemessen: 0.289 und 0.432 waren Falschmeldungen auf einem rein deutschen Video,
    0.938 war die einzige echte Erkennung."""
    p = transcribe._Sprachschwelle(_FakeCt2([("en", 0.29)]), "de", 0.7)
    assert _code(p.detect_language(None)) == "de"


def test_schwelle_laesst_sicheren_wechsel_durch():
    p = transcribe._Sprachschwelle(_FakeCt2([("en", 0.938)]), "de", 0.7)
    assert _code(p.detect_language(None)) == "en"


def test_schwelle_klemmt_nicht_bei_gleicher_sprache():
    """Unsicheres Deutsch bleibt Deutsch -- es gibt nichts zu klemmen. Ohne die
    Bedingung wuerde der Proxy auch hier eingreifen und das Protokoll verfaelschen."""
    p = transcribe._Sprachschwelle(_FakeCt2([("de", 0.4)]), "de", 0.7)
    assert _code(p.detect_language(None)) == "de"
    assert p.fenster[0][2] == "de"


def test_schwelle_ohne_anker_nimmt_die_erste_sichere_erkennung():
    """Sprache 'auto': der Anker steht beim Start nicht fest. Die erste sichere
    Erkennung wird er; alles davor laeuft ungeklemmt durch."""
    p = transcribe._Sprachschwelle(_FakeCt2([("fr", 0.3), ("en", 0.95), ("de", 0.2)]), None, 0.7)
    assert _code(p.detect_language(None)) == "fr"
    assert _code(p.detect_language(None)) == "en"
    assert _code(p.detect_language(None)) == "en"


def test_schwelle_protokolliert_jedes_fenster():
    p = transcribe._Sprachschwelle(_FakeCt2([("en", 0.29), ("de", 0.99)]), "de", 0.7)
    p.detect_language(None)
    p.detect_language(None)
    assert p.fenster == [["en", 0.29, "de"], ["de", 0.99, "de"]]


def test_schwelle_reicht_unbekannte_attribute_durch():
    echt = _FakeCt2([])
    echt.is_multilingual = True
    assert transcribe._Sprachschwelle(echt, "de", 0.7).is_multilingual is True
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -q -k schwelle`
Expected: FAIL — `AttributeError: module 'transcribe' has no attribute '_Sprachschwelle'`

- [ ] **Step 3: Konstante und Klasse schreiben**

Zu den übrigen Env-Auswertungen oben in `transcribe.py`:

```python
try:
    # ponytail: 0.7 ist GERATEN, nicht kalibriert -- drei Messpunkte (0.289 und 0.432 waren
    # Falschmeldungen auf rein deutschem Material, 0.938 die einzige echte Erkennung).
    # Darum eine Stellschraube. Tippfehler in der .env darf den Lauf nicht killen.
    MIX_SCHWELLE = float(os.environ.get("TRANSKRIBOR_MIX_SCHWELLE") or 0.7)
except ValueError:
    MIX_SCHWELLE = 0.7
```

Klasse neben `_opts`:

```python
class _Sprachschwelle:
    """Delegierender Proxy um das ct2-Modell: klemmt unsichere Sprachwechsel auf die
    Ankersprache.

    faster-whisper nimmt bei multilingual=True die beste Erkennung UNGEPRUEFT
    (faster_whisper/transcribe.py:1192) -- eine Schwelle gibt es dort nicht;
    `language_detection_threshold` gilt nur der einmaligen Erkennung am Anfang.
    Auf einem rein deutschen Video schaltete es dadurch bei p=0.289 auf Englisch um und
    schob einen Satz ein, den niemand gesagt hat.

    Anker None (Sprache 'auto'): die erste SICHERE Erkennung wird zum Anker; davor wird
    nichts geklemmt, weil es noch nichts gibt, worauf man klemmen koennte.
    """

    def __init__(self, echt, anker, schwelle):
        self._echt, self._anker, self._schwelle = echt, anker, schwelle
        self.fenster = []            # [[erkannt, p, benutzt], ...] in Reihenfolge

    def detect_language(self, enc):
        r = self._echt.detect_language(enc)
        tok, p = r[0][0]
        code = tok[2:-2]
        if self._anker is None:
            if p >= self._schwelle:
                self._anker = code
        elif code != self._anker and p < self._schwelle:
            self.fenster.append([code, round(p, 3), self._anker])
            return [[(f"<|{self._anker}|>", 1.0)]]
        self.fenster.append([code, round(p, 3), code])
        return r

    def __getattr__(self, name):
        return getattr(self._echt, name)
```

- [ ] **Step 4: Tests laufen lassen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -q`
Expected: PASS

- [ ] **Step 5: Mutationsprobe**

`code != self._anker` aus der Bedingung entfernen → `test_schwelle_klemmt_nicht_bei_gleicher_sprache` rot.
`p < self._schwelle` entfernen → `test_schwelle_laesst_sicheren_wechsel_durch` rot.
Danach beides zurückändern.

- [ ] **Step 6: Commit**

```bash
git add transcribe.py webtool/test_transcribe.py
git commit -m "feat(transcribe): Konfidenzschwelle fuer Sprachwechsel pro Fenster"
```

---

### Task 4: Verdrahtung im Transkriptionslauf

**Files:**
- Modify: `transcribe.py:176-188` (`_datei_whisper_code` → `_datei_sprachwahl`)
- Modify: `transcribe.py:240-255` (Schleifenrumpf in `transcribe_project`)
- Test: `webtool/test_transcribe.py`

**Interfaces:**
- Consumes: `projekt.datei_mehrsprachig` (Task 1), `_opts(language, mehrsprachig)` (Task 2), `_Sprachschwelle`, `MIX_SCHWELLE`, `_Sprachschwelle._echt` (Task 3)
- Produces:
  - `transcribe._datei_sprachwahl(proj_dir, base, fallback) -> tuple[str | None, bool]`
  - `transcribe._transkribiere_datei(m, engine, f, sprache, mehr, model) -> tuple[dict, object]` — zweiter Rückgabewert ist das (ggf. erst hier geladene) Modell
  - `<base>.json` enthält bei gemischten Dateien `window_languages`

- [ ] **Step 1: Die Tests schreiben**

```python
def test_sprachwahl_liefert_code_und_flag(projekt_root, monkeypatch):
    from webtool import projekt
    projekt.setze_datei("p", "a", sprache="en", mehrsprachig=True)
    code, mehr = transcribe._datei_sprachwahl(
        os.path.join(projekt_root, "p"), "a", "de")
    assert (code, mehr) == ("en", True)


def test_sprachwahl_faellt_ohne_projektdatei_zurueck(tmp_path):
    """Das Grund-Skript laeuft ohne das webtool-Paket bzw. ohne projekt.json --
    dann gilt das globale --language und nicht mehrsprachig."""
    code, mehr = transcribe._datei_sprachwahl(str(tmp_path / "fehlt"), "a", "de")
    assert (code, mehr) == ("de", False)
```

Der Schleifenrumpf wird dafür in eine eigene Funktion gezogen (siehe Step 4) —
`transcribe_project` ist schon heute an der Grenze dessen, was man am Stück liest, und
gegen die ganze Funktion zu testen hiesse, echte Audiodateien und ein 3-GB-Modell
aufzubauen, um eine Verzweigung zu prüfen.

```python
class _FakeModell:
    """Nachbau von WhisperModel: merkt sich die Optionen, liefert ein leeres Ergebnis."""
    def __init__(self):
        self.model = types.SimpleNamespace(name="ct2")
        self.gesehen = []

    def transcribe(self, f, **opts):
        self.gesehen.append(opts)
        return iter(()), types.SimpleNamespace(language="de")


def test_datei_lauf_haengt_den_proxy_wieder_aus():
    """Der Proxy darf NICHT haengen bleiben: das Modell wird pro Projektlauf einmal
    geladen und von allen Dateien geteilt -- die naechste, einsprachige Datei bekaeme
    sonst die Klemmung auf eine fremde Ankersprache ab."""
    m = _FakeModell()
    echt = m.model
    _, m2 = transcribe._transkribiere_datei(m, "faster-whisper", "a.m4a", "de", True, "large-v3")
    assert m2 is m
    assert m.model is echt
    assert m.gesehen[0]["multilingual"] is True


def test_datei_lauf_haengt_auch_nach_fehler_wieder_aus(monkeypatch):
    """Rueckbau im finally, nicht am Ende: eine kaputte Datei ueberspringt der Lauf und
    macht weiter -- mit einem haengengebliebenen Proxy am geteilten Modell."""
    m = _FakeModell()
    echt = m.model
    def kaputt(f, **opts):
        raise RuntimeError("kaputte Datei")
    m.transcribe = kaputt
    with pytest.raises(RuntimeError):
        transcribe._transkribiere_datei(m, "faster-whisper", "a.m4a", "de", True, "large-v3")
    assert m.model is echt


def test_datei_lauf_schreibt_window_languages():
    m = _FakeModell()
    result, _ = transcribe._transkribiere_datei(m, "faster-whisper", "a.m4a", "de", True, "large-v3")
    assert "window_languages" in result


def test_einsprachige_datei_bekommt_keine_window_languages():
    m = _FakeModell()
    result, _ = transcribe._transkribiere_datei(m, "faster-whisper", "a.m4a", "de", False, "large-v3")
    assert "window_languages" not in result
    assert "multilingual" not in m.gesehen[0]


def test_gemischte_datei_faellt_von_whispercpp_auf_faster_whisper(monkeypatch):
    """DER Mac-Test. whisper.cpp ruft `whisper-cli` mit einem festen -l und kann keine
    Erkennung pro Fenster. Ohne diesen Rueckfall bekaeme ein Mac-Nutzer ein
    einsprachiges Transkript, ohne dass irgendwo etwas fehlschlaegt."""
    m = _FakeModell()
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **k: m)
    gerufen = []
    monkeypatch.setattr("webtool.whispercpp.transkribiere",
                        lambda *a, **k: gerufen.append(a) or {"segments": []})
    result, _ = transcribe._transkribiere_datei(None, "whisper.cpp", "a.m4a", "de", True, "large-v3")
    assert gerufen == []                       # whisper.cpp NICHT gerufen
    assert m.gesehen[0]["multilingual"] is True


def test_einsprachige_datei_bleibt_bei_whispercpp(monkeypatch):
    """Positivkontrolle zum vorigen Test: ohne sie koennte der Rueckfall auch ALLE
    Dateien von whisper.cpp wegziehen und der Test oben bliebe trotzdem gruen."""
    gerufen = []
    monkeypatch.setattr("webtool.whispercpp.transkribiere",
                        lambda *a, **k: gerufen.append(a) or {"segments": []})
    transcribe._transkribiere_datei(None, "whisper.cpp", "a.m4a", "de", False, "large-v3")
    assert len(gerufen) == 1
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_transcribe.py -q -k "sprachwahl or datei_lauf or whispercpp"`
Expected: FAIL — `AttributeError: module 'transcribe' has no attribute '_datei_sprachwahl'` bzw. `_transkribiere_datei`

- [ ] **Step 3: `_datei_whisper_code` ersetzen**

```python
def _datei_sprachwahl(proj_dir, base, fallback):
    """(Whisper-Sprach-Code, mehrsprachig) fuer EINE Datei aus projekt.json.

    EIN Lesevorgang fuer beide Werte -- zwei Aufrufe waeren zwei projekt.json-Lesungen
    pro Datei. Lazy import wie bisher: das Grund-Skript laeuft ohne das webtool-Paket,
    nur die Aufloesung braucht es. Fehlt projekt.json, gilt `fallback` (= WHISPER_LANG,
    Legacy-Verhalten) und nicht mehrsprachig. 'auto' -> None (Whisper erkennt selbst).
    """
    try:
        from webtool import projekt as _p, sprachen as _s
        name = os.path.basename(proj_dir)
        return _s.whisper_code(_p.datei_sprache(name, base)), _p.datei_mehrsprachig(name, base)
    except Exception:
        return fallback, False
```

Alle Aufrufstellen von `_datei_whisper_code` umstellen (es gibt genau eine, `transcribe.py:249`).

- [ ] **Step 4: Schleifenrumpf als eigene Funktion**

Neue Funktion neben `_datei_sprachwahl`:

```python
def _transkribiere_datei(m, engine, f, sprache, mehr, model):
    """EINE Aufnahme transkribieren -> (Ergebnis-dict, Modell).

    Das Modell kommt zurueck, weil es hier ERST ENTSTEHEN kann: auf einem
    whisper.cpp-Lauf haelt der Aufrufer keines vor (m is None), und eine gemischte
    Datei braucht trotzdem faster-whisper.

    Eigene Funktion und nicht inline in transcribe_project: die Schleife dort ist schon
    lang, und diese Verzweigung ist die einzige Stelle, an der ein Mac ein anderes
    Ergebnis bekommt als ein PC -- die will man am Stueck lesen und einzeln pruefen
    koennen, ohne echtes Audio und 3 GB Modell.
    """
    if engine == "whisper.cpp" and not mehr:
        from webtool import whispercpp
        return whispercpp.transkribiere(f, model, sprache), m
    # whisper.cpp ruft `whisper-cli` mit einem festen -l und kennt keine Erkennung pro
    # Fenster. Eine gemischte Datei faellt deshalb auf faster-whisper zurueck -- der
    # VIERTE dokumentierte Rueckfall (neben: kein Apple Silicon, whisper-cli fehlt, keine
    # GGML-Datei). Langsamer, aber richtig; ein einsprachiges Transkript ohne jede
    # Fehlermeldung waere schlechter.
    if m is None:
        from webtool import device as devicemod
        m = _modell(model, devicemod.pick_asr())
    proxy = _Sprachschwelle(m.model, sprache, MIX_SCHWELLE) if mehr else None
    if proxy is not None:
        m.model = proxy
    try:
        result = _ergebnis(*m.transcribe(f, **_opts(sprache, mehr)))
    finally:
        # Zwingend im finally: eine kaputte Datei ueberspringt der Lauf und macht weiter
        # (die Regel steht im Aufrufer). Das Modell wird von allen Dateien geteilt -- ein
        # haengengebliebener Proxy klemmte die naechste, einsprachige Datei auf eine
        # fremde Ankersprache.
        if proxy is not None:
            m.model = proxy._echt
    if proxy is not None:
        result["window_languages"] = proxy.fenster
    return result, m
```

Der Schleifenrumpf in `transcribe_project` schrumpft damit auf:

```python
            sprache, mehr = _datei_sprachwahl(proj_dir, base, language)
            result, m = _transkribiere_datei(m, engine, f, sprache, mehr, model)
```

Der bestehende Kommentarblock über diesen Zeilen (MPS-Rückfall, „eine kaputte Datei
überspringen") **bleibt stehen** — er begründet das `try/except` der Schleife, nicht
den herausgezogenen Rumpf.

`device` steht im whisper.cpp-Zweig nicht zur Verfügung (dort wurde es nie gesetzt) —
deshalb der lokale `devicemod`-Import in der neuen Funktion statt einer Durchreichung.

- [ ] **Step 5: Tests laufen lassen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q`
Expected: PASS — die gesamte Python-Suite, nicht nur die neue Datei

- [ ] **Step 6: Mutationsprobe**

Das `finally` in ein normales Ende umwandeln (Rückbau nur im Erfolgsfall) → `test_datei_lauf_haengt_auch_nach_fehler_wieder_aus` rot.
`and not mehr` aus der whisper.cpp-Bedingung entfernen → `test_gemischte_datei_faellt_von_whispercpp_auf_faster_whisper` rot.
Die Bedingung auf `if engine == "whisper.cpp" and False` festnageln → `test_einsprachige_datei_bleibt_bei_whispercpp` rot (die Positivkontrolle greift).
Danach alles zurückändern.

- [ ] **Step 7: Commit**

```bash
git add transcribe.py webtool/test_transcribe.py
git commit -m "feat(transcribe): gemischte Dateien fahren mit Schwellenproxy, Mac faellt zurueck"
```

---

### Task 5: Korrektur- und Treue-Prompt

**Files:**
- Modify: `webtool/correct.py:64-78` (`_ziel_dialekt`), `:353-390` (`_correct_prompt`), `:393-431` (`_verify_prompt`), plus die Aufrufstellen `:600`, `:621`, `:729`
- Test: `webtool/test_correct.py`

**Interfaces:**
- Consumes: `sprachen.ZIEL_MEHRSPRACHIG`, `projekt.datei_mehrsprachig` (Task 1)
- Produces: `_ziel_dialekt(project, base) -> tuple[str, bool, bool]` (ziel, dialekt, **mehrsprachig**); `_correct_prompt(..., mehrsprachig: bool = False)`; `_verify_prompt(..., mehrsprachig: bool = False)`

- [ ] **Step 1: Die Tests schreiben**

```python
def test_korrektur_prompt_ohne_mehrsprachig_unveraendert():
    """Constraint: die einsprachige Pipeline laeuft byte-identisch weiter."""
    assert "mehrere Sprachen" not in correct._correct_prompt(
        "b", "t.txt", "c.json", "", "kontext")


def test_korrektur_prompt_traegt_die_mehrsprachig_regel():
    p = correct._correct_prompt("b", "t.txt", "c.json", "", "kontext", mehrsprachig=True)
    assert "übersetze nichts" in p


def test_verify_prompt_traegt_die_mehrsprachig_regel():
    """DER eigentliche Test dieser Aufgabe. Der Treue-Pass prueft gegen das Roh und
    schreibt zuletzt -- ohne diese Zeile dreht er eine englische Passage neben
    deutschem Kontext als Untreue zurueck. Exakt die Falle der [Musik]-Regel."""
    p = correct._verify_prompt("b", "t.txt", "c.json", "kontext", mehrsprachig=True)
    assert "FREMDSPRACHE" in p


def test_verify_regel_haengt_nicht_an_kontext_md():
    """`ziel` erreicht _verify_prompt nur ueber _default_context, und der greift NUR
    ohne kontext.md. Ein Projekt MIT Kontextdatei saehe die Regel sonst nie --
    deshalb ein eigenes Flag statt einer ziel-Phrase."""
    p = correct._verify_prompt("b", "t.txt", "c.json", "ein ausfuehrlicher Projektkontext",
                               mehrsprachig=True)
    assert "FREMDSPRACHE" in p


def test_ziel_dialekt_meldet_mehrsprachig(projekt_root):
    from webtool import projekt
    projekt.setze_datei("p", "a", sprache="ch", mehrsprachig=True)
    ziel, dialekt, mehr = correct._ziel_dialekt("p", "a")
    assert mehr is True
    assert dialekt is True          # Anker bleibt Schweizerdeutsch
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_correct.py -q -k "mehrsprachig or fremdsprache"`
Expected: FAIL — `TypeError: _correct_prompt() got an unexpected keyword argument 'mehrsprachig'`

- [ ] **Step 3: `_ziel_dialekt` erweitern**

Rückgabe auf ein Tripel erweitern, Docstring um einen Satz ergänzen:

```python
    from . import projekt as _pj, sprachen as _s
    ...
    return _s.ziel_phrase(sid), _s.ist_dialekt(sid), _pj.datei_mehrsprachig(project, base)
```

`ziel` und `dialekt` folgen **unverändert** der Ankersprache — nur die Regelzeile kommt dazu.

- [ ] **Step 4: Beide Prompts erweitern**

`_correct_prompt`: Parameter `mehrsprachig: bool = False`, davor

```python
    mehr_regel = f"\n8) MEHRSPRACHIG: {sprachen.ZIEL_MEHRSPRACHIG}" if mehrsprachig else ""
```

und `{mehr_regel}` direkt hinter Regel 7 (vor der Leerzeile und „Schreibe das Ergebnis") einsetzen.

`_verify_prompt`: Parameter `mehrsprachig: bool = False`, davor

```python
    # Eigener Text, nicht ZIEL_MEHRSPRACHIG: hier geht es nicht darum, WAS zu tun ist,
    # sondern dass eine Fremdsprache KEIN Befund ist. Nach dem Muster der MUSIK-Zeile
    # darueber gebaut -- dieselbe Falle, derselbe Satzbau.
    mehr_regel = ("\n- FREMDSPRACHE ist eine ERLAUBTE Entscheidung, KEINE Untreue: Eine "
                  "Passage in einer anderen Sprache als der Rest ist NICHT "
                  "zurückzuübersetzen. Prüfe nur, ob sie zum Roh passt."
                  if mehrsprachig else "")
```

und `{mehr_regel}` unmittelbar hinter die MUSIK/ARTEFAKTE-Zeile in die Aufzählung einsetzen.

- [ ] **Step 5: Die drei Aufrufstellen nachziehen**

`webtool/correct.py:600`, `:621`, `:729` entpacken heute `ziel, dialekt = _ziel_dialekt(...)`. Auf drei Werte umstellen und `mehrsprachig=mehr` an `_correct_one` / die Prompt-Aufrufe durchreichen. `_glossary_prompt` bleibt **unangetastet** (läuft mit `ziel=""`, sprachneutral).

- [ ] **Step 6: Tests laufen lassen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q`
Expected: PASS

- [ ] **Step 7: Mutationsprobe**

`mehr_regel` in `_verify_prompt` auf `""` festnageln → `test_verify_prompt_traegt_die_mehrsprachig_regel` und `test_verify_regel_haengt_nicht_an_kontext_md` rot. Dasselbe in `_correct_prompt`. Danach zurückändern.

- [ ] **Step 8: Commit**

```bash
git add webtool/correct.py webtool/test_correct.py
git commit -m "feat(correct): Mehrsprachig-Regel in Korrektur- UND Treue-Prompt"
```

---

### Task 6: Endpunkte

**Files:**
- Modify: `webtool/app.py:229-279` (`EinstellungenBody` und die vier Handler)
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `projekt.*`, `sprachen.pruef_fehler` (Task 1)
- Produces: `mehrsprachig: bool` in beiden GET-Antworten und beiden PUT-Rümpfen/-Echos

- [ ] **Step 1: Die Tests schreiben**

```python
def test_projekt_einstellungen_liefern_mehrsprachig(client):
    assert client.get("/api/projects/p/einstellungen").json()["mehrsprachig"] is False


def test_projekt_put_setzt_mehrsprachig(client):
    r = client.put("/api/projects/p/einstellungen", json={"mehrsprachig": True})
    assert r.status_code == 200 and r.json()["mehrsprachig"] is True


def test_datei_put_setzt_mehrsprachig(client):
    r = client.put("/api/projects/p/files/a/einstellungen", json={"mehrsprachig": True})
    assert r.status_code == 200 and r.json()["mehrsprachig"] is True


def test_leerer_put_laesst_mehrsprachig_stehen(client):
    """Partial-Update: ein PUT ohne das Feld darf den Haken nicht loeschen."""
    client.put("/api/projects/p/einstellungen", json={"mehrsprachig": True})
    client.put("/api/projects/p/einstellungen", json={"sprache": "en"})
    assert client.get("/api/projects/p/einstellungen").json()["mehrsprachig"] is True
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_api.py -q -k mehrsprachig`
Expected: FAIL — `KeyError: 'mehrsprachig'`

- [ ] **Step 3: `EinstellungenBody` und die Handler erweitern**

```python
class EinstellungenBody(BaseModel):
    sprache: str | None = None
    korrektur: str | None = None
    mehrsprachig: bool | None = None
```

Beide GET-Handler geben `"mehrsprachig": ...` mit zurück (Projekt: `d["mehrsprachig"]`, Datei: `_projekt.datei_mehrsprachig(project, base)`).

Beide PUT-Handler: `pruef_fehler(..., mehrsprachig=body.mehrsprachig)`, dann den Wert an `speichern` bzw. `setze_datei` durchreichen und im Echo mit zurückgeben.

Den Kommentar in `projekteinstellungen_speichern` anpassen — er behauptet heute, `speichern()` überspringe None-Werte „über den isinstance-Check auf str". Das gilt für den bool nicht mehr; der hat seinen eigenen Zweig.

- [ ] **Step 4: Tests laufen lassen**

Run: `E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): mehrsprachig in beiden Einstellungs-Endpunkten"
```

---

### Task 7: Oberfläche

**Files:**
- Modify: `webtool/frontend/src/lib/types.ts:33-41`
- Modify: `webtool/frontend/src/lib/api.ts` (die beiden `save*Einstellungen`)
- Modify: `webtool/frontend/src/components/DateiEinstellungenDialog.tsx`
- Modify: `webtool/frontend/src/components/ProjektEinstellungenDialog.tsx`
- Modify: `webtool/frontend/src/components/DateiMenue.tsx` (`einstellungenGespeichert`)
- Test: `webtool/frontend/src/components/DateiEinstellungenDialog.test.tsx`, `DateiMenue.test.tsx`

**Interfaces:**
- Consumes: die Endpunkte aus Task 6
- Produces: `ProjectEinstellungen.mehrsprachig: boolean`, `EinstellungenWerte.mehrsprachig: boolean`; `onGespeichert({ spracheGeaendert, tiefeGeaendert })` bekommt `spracheGeaendert === true` auch bei reiner Haken-Änderung

- [ ] **Step 1: Die Tests schreiben**

```tsx
it('zeigt das Kästchen und schickt es mit', async () => {
  // getFileEinstellungen liefert mehrsprachig:false
  render(<DateiEinstellungenDialog ... offen />)
  await screen.findByLabelText(/enthält weitere sprachen/i)
  await userEvent.click(screen.getByLabelText(/enthält weitere sprachen/i))
  await userEvent.click(screen.getByRole('button', { name: /speichern/i }))
  expect(saveFileEinstellungen).toHaveBeenCalledWith('p', 'a',
    expect.objectContaining({ mehrsprachig: true }))
})

it('eine Haken-Änderung löst die Neu-Transkription aus', async () => {
  /* Der Haken aendert, WIE Whisper dekodiert -- ein vorhandenes Transkript ist danach
     falsch. Behandelt wie ein Sprachwechsel, inklusive Verwerfen-Hinweis. Ohne diesen
     Test bliebe der Haken eine Einstellung ohne Wirkung auf bereits transkribierte Dateien. */
  render(<DateiEinstellungenDialog ... file={{ ...datei, has_raw: true }} offen />)
  await userEvent.click(await screen.findByLabelText(/enthält weitere sprachen/i))
  expect(screen.getByRole('button', { name: /neu transkribieren/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend run test -- --run DateiEinstellungenDialog`
Expected: FAIL — Kästchen nicht gefunden

- [ ] **Step 3: Typen und api.ts erweitern**

```ts
export type ProjectEinstellungen = {
  sprache: string
  korrektur: string
  mehrsprachig: boolean
  sprach_choices: SprachChoice[]
  tiefen: TiefeChoice[]
};
export type EinstellungenWerte = { sprache: string; korrektur: string; mehrsprachig: boolean };
```

- [ ] **Step 4: Kästchen in beide Dialoge**

Ein natives `<input type="checkbox">`, **keine** neue Abhängigkeit — `@radix-ui/react-checkbox` liegt nicht vor, und für ein Kästchen lohnt es nicht (`components/ui/` hat bewusst nur, was mehrfach gebraucht wird).

```tsx
<label className="flex items-start gap-2 text-sm">
  <input type="checkbox" className="mt-0.5 size-4 accent-primary"
         checked={mehrsprachig} onChange={e => setMehrsprachig(e.target.checked)} />
  <span>
    Enthält weitere Sprachen
    <span className="block text-muted-foreground">
      Die oben gewählte Sprache gilt dann als Hauptsprache; andere werden im Verlauf erkannt.
    </span>
  </span>
</label>
```

In `DateiEinstellungenDialog` die Auslöser-Logik erweitern:

```tsx
const mehrGeaendert = !!data && mehrsprachig !== data.mehrsprachig
// Der Haken aendert die Dekodierung -- wie ein Sprachwechsel behandeln, samt Verwerfen-Hinweis.
const spracheGeaendert = !!data && (sprache !== data.sprache || mehrGeaendert)
```

`geaendert` um `mehrGeaendert` erweitern, `speichernFn` schickt `mehrsprachig` mit.

- [ ] **Step 5: Tests laufen lassen**

Run: `npm --prefix webtool/frontend run test -- --run && npm --prefix webtool/frontend run build`
Expected: PASS, Build grün (TypeScript)

- [ ] **Step 6: Mutationsprobe**

`|| mehrGeaendert` aus `spracheGeaendert` entfernen → der zweite Test rot. Danach zurückändern.

- [ ] **Step 7: Commit**

```bash
git add webtool/frontend/src
git commit -m "feat(ui): Kaestchen 'Enthaelt weitere Sprachen' in beiden Einstellungs-Dialogen"
```

---

### Task 8: README, Abschlussprüfung, Aufräumen

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md` (**lokal, nicht committen** — die Datei ist seit #110 gitignoriert)

- [ ] **Step 1: README nachziehen**

Unter dem Abschnitt zur Sprachauswahl, im Ton einer Anleitung (nicht als Changelog), was es dem Nutzer bringt: dass ein Video mit mehreren Sprachen jetzt als ein Transkript herauskommt, in dem jede Passage in ihrer Sprache steht; dass man dafür die Hauptsprache wählt und „Enthält weitere Sprachen" ankreuzt; und dass der Haken bei einsprachigen Aufnahmen **aus** bleiben soll, weil die Erkennung dort mehr schadet als nützt.

- [ ] **Step 2: Ende-zu-Ende gegen echtes Audio**

Der Testfall liegt bereits: `mixed.wav` im Scratchpad dieser Sitzung (echtes Schweizerdeutsch 0–90 s · englische TTS 90–130 s · Schweizerdeutsch 130–220 s). In ein Wegwerf-Projekt legen, Haken setzen, transkribieren.

Erwartung — und **nur diese drei Punkte** zählen als bestanden:
1. Der Abschnitt 90–130 s steht auf **Englisch** („I came here from Manchester with my club").
2. Ab ~129 s steht wieder **Deutsch**.
3. `<base>.json` enthält `window_languages` mit einem `en`-Eintrag.

- [ ] **Step 3: Gegenprobe einsprachig**

Dieselbe Datei ohne Haken transkribieren: Ergebnis muss dem heutigen Verhalten entsprechen (englischer Teil kommt deutsch heraus). Beweist, dass die Vorgabe unverändert ist.

- [ ] **Step 4: Im Browser nachsehen**

Beide Dialoge öffnen, Kästchen setzen und wieder abwählen, Knopftext prüfen (`Speichern & neu transkribieren`). Das Wegwerf-Projekt `projekte/zz-ui-check` benutzen — **nie** Marcus' echte Aufnahmen: ein Speicherlauf setzt `human_edited=true` und nimmt die Datei aus der Auto-Korrektur.

- [ ] **Step 5: CLAUDE.md ergänzen** (lokal)

Einen Absatz unter „Sprachauswahl + Korrektur-Tiefe": die beiden untrennbaren Decoder-Parameter samt Messung, die Schwelle als geratene Stellschraube, der vierte Mac-Rückfall, und warum die Regel in **beide** Prompts muss.

- [ ] **Step 6: Wegwerf-Projekte löschen**

`projekte/zz-mix-test` und `projekte/zz-ui-check` entfernen. `projekte/` wird nie committet — vor dem PR trotzdem prüfen: `git status --short projekte/` muss leer sein.

- [ ] **Step 7: Volle Suite + Commit**

```bash
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q
npm --prefix webtool/frontend run test -- --run
git add README.md
git commit -m "docs: README zur mehrsprachigen Transkription"
```

- [ ] **Step 8: PR**

```bash
git push -u origin feat/mehrsprachige-transkription
gh pr create --base master --title "Mehrsprachige Transkription: jede Passage in ihrer Sprache"
```

Danach — ohne Rückfrage, so will es CLAUDE.md: `/code-review` über den Commit-Bereich, `superpowers:requesting-code-review` mit **eigens gebautem** Kontext (nie mit dem Sitzungsverlauf), CodeRabbit am PR. Dem Reviewer ausdrücklich die Frage mitgeben, an der dieses Repo schon zweimal hing: **was erlaubt der Fix NEU?**

Anschliessend Issues anlegen (siehe Spec Abschnitt 6): yt-dlp-403, Upstream-Bericht an faster-whisper, Sprache pro Segment.
