import json
import os
import re
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
    (t / "S1.raw.txt").write_text("Ich bin Mathias.\n", encoding="utf-8")
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


def test_apply_missing_correction_returns_missing(project):
    _root, t = project
    assert correct.cmd_apply("Demo", "S1") == "missing"
    assert not (t / "S1.edit.json").exists()


# ---- Stufe 2b: cmd_run-Orchestrierung (claude-Aufruf gefälscht) ----

def _fake_claude(t, calls):
    """Ersatz für _run_claude: schreibt kanonische Dateien wie das echte claude -p
    (Write-Tool). Zielpfad wird — wie im echten Prompt — aus dem Prompt gelesen."""
    def fake(prompt):
        calls.append(prompt)
        m = re.search(r"(\S+_glossar\.json)", prompt)
        if m:
            _dump(m.group(1), {"context_summary": "Bäckerei-Interviews.",
                               "proper_nouns": [{"correct": "Matthias"}], "likely_corrections": []})
            return
        m = re.search(r"(\S+\.correction\.json)", prompt)
        if m:
            cpath = m.group(1)
            base = os.path.basename(cpath)[: -len(".correction.json")]
            raw = json.loads((t / (base + ".json")).read_text(encoding="utf-8"))
            _dump(cpath, {"base": base, "context": "Kurzes Gespräch.", "speakers": ["Interviewer"],
                          "segments": [{"id": s["id"], "speaker": "Interviewer", "text": "Ich bin Matthias."}
                                       for s in raw["segments"]],
                          "annotations": [], "summary": "Vorstellung."})
    return fake


def _dump(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)


def test_run_full_flow(project, monkeypatch):
    _root, t = project
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    # prep + Glossar + Korrektur alle gelaufen
    assert (t / "S1.tagged.txt").exists()
    assert (t / "_glossar.json").exists()
    assert (t / "S1.correction.json").exists()
    # apply hat kanonisches edit.json + md gebaut, Korrektur eingewoben
    doc = json.loads((t / "S1.edit.json").read_text(encoding="utf-8"))
    assert doc["segments"][0]["text"] == "Ich bin Matthias."
    assert doc["segments"][0]["speaker"] == "Interviewer"
    assert doc["human_edited"] is False
    assert "**Interviewer:** Ich bin Matthias." in (t / "S1.md").read_text(encoding="utf-8")
    # zwei claude-Aufrufe: Glossar + eine Datei
    assert len(calls) == 2


def test_run_skips_human_edited(project, monkeypatch):
    _root, t = project
    (t / "S1.edit.json").write_text(json.dumps(
        {"human_edited": True, "segments": [{"id": 0, "text": "Von Hand."}]}), encoding="utf-8")
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo") == 0
    assert not (t / "S1.correction.json").exists()      # keine Korrektur für die Datei erzeugt
    assert "Von Hand." in (t / "S1.edit.json").read_text(encoding="utf-8")  # unangetastet
    assert all(".correction.json" not in c for c in calls)  # claude nie für S1 korrigiert


def test_run_reuses_existing_correction(project, monkeypatch):
    _root, t = project
    (t / "S1.correction.json").write_text(json.dumps(
        {"base": "S1", "segments": [{"id": 0, "speaker": "Interviewer", "text": "Schon da."}]}),
        encoding="utf-8")
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    assert all(".correction.json" not in c for c in calls)  # kein claude-Korrekturlauf für S1
    assert "Schon da." in (t / "S1.edit.json").read_text(encoding="utf-8")  # apply nutzte vorhandene


def test_run_reuses_fresh_glossary(project, monkeypatch):
    _root, t = project
    # vorhandenes Glossar, neuer als alle .raw.txt -> soll NICHT neu per claude gebaut werden
    gpath = t / "_glossar.json"
    gpath.write_text(json.dumps(
        {"context_summary": "vorhanden", "proper_nouns": [{"correct": "Matthias"}],
         "likely_corrections": []}), encoding="utf-8")
    raw_mtime = (t / "S1.raw.txt").stat().st_mtime
    os.utime(gpath, (raw_mtime + 10, raw_mtime + 10))   # deterministisch neuer als raw
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    assert all("_glossar.json" not in c for c in calls)   # Glossar wiederverwendet, kein claude-Aufruf
    assert any(".correction.json" in c for c in calls)    # Datei-Korrektur lief trotzdem


def test_run_regenerates_stale_glossary(project, monkeypatch):
    _root, t = project
    # veraltetes Glossar (aelter als eine .raw.txt, z.B. nach Neu-Transkription) -> neu bauen
    gpath = t / "_glossar.json"
    gpath.write_text(json.dumps(
        {"context_summary": "alt", "proper_nouns": [], "likely_corrections": []}), encoding="utf-8")
    g_mtime = gpath.stat().st_mtime
    os.utime(t / "S1.raw.txt", (g_mtime + 10, g_mtime + 10))   # raw neuer -> Glossar stale
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    assert any("_glossar.json" in c for c in calls)       # Glossar neu erzeugt (nicht stale wiederverwendet)


def test_run_reruns_stale_correction(project, monkeypatch):
    _root, t = project
    # veraltete correction.json (aelter als die Roh-JSON) -> claude muss neu laufen, nicht reusen
    (t / "S1.correction.json").write_text(json.dumps(
        {"base": "S1", "segments": [{"id": 0, "speaker": "X", "text": "Veraltet."}]}), encoding="utf-8")
    c_mtime = (t / "S1.correction.json").stat().st_mtime
    os.utime(t / "S1.json", (c_mtime + 10, c_mtime + 10))   # Roh neuer -> correction stale
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    assert any("S1.correction.json" in c for c in calls)   # neu korrigiert (stale nicht wiederverwendet)
    edit = (t / "S1.edit.json").read_text(encoding="utf-8")
    assert "Ich bin Matthias." in edit and "Veraltet." not in edit


def test_run_continues_after_missing_correction(project, monkeypatch):
    _root, t = project
    # zweite Datei, deren claude-Korrektur "fehlschlägt" (keine correction.json)
    raw2 = {"language": "de", "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Test.",
         "compression_ratio": 1.0, "no_speech_prob": 0.01, "avg_logprob": -0.3, "words": []}]}
    (t / "S2.json").write_text(json.dumps(raw2), encoding="utf-8")

    def fake(prompt):
        if "_glossar.json" in prompt:
            return
        if "S1.correction.json" in prompt:
            _dump(re.search(r"(\S+\.correction\.json)", prompt).group(1),
                  {"base": "S1", "segments": [{"id": 0, "speaker": "Interviewer", "text": "Ok."}]})
        # S2: schreibt nichts -> simuliert claude-Fehler
    monkeypatch.setattr(correct, "_run_claude", fake)
    assert correct.cmd_run("Demo") == 1                 # nur S1 erfolgreich, Lauf bricht nicht ab
    assert (t / "S1.edit.json").exists()
    assert not (t / "S2.edit.json").exists()


def test_run_survives_corrupt_raw(project, monkeypatch):
    _root, t = project
    (t / "S2.json").write_text("{ kaputt, kein json", encoding="utf-8")  # z.B. abgebrochene Transkription

    def fake(prompt):
        if "_glossar.json" in prompt:
            return
        _dump(re.search(r"(\S+\.correction\.json)", prompt).group(1),
              {"base": "x", "segments": [{"id": 0, "speaker": "Interviewer", "text": "ok"}]})
    monkeypatch.setattr(correct, "_run_claude", fake)
    # S1 wird korrigiert, S2 (korrupte Roh-JSON) übersprungen — kein Absturz des Batches
    assert correct.cmd_run("Demo") == 1
    assert (t / "S1.tagged.txt").exists()               # prep hat S1 trotz korruptem S2 getaggt
    assert (t / "S1.edit.json").exists()
    assert not (t / "S2.edit.json").exists()
