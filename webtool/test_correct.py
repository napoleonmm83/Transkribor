import json
import os
import re
import pytest
from webtool import correct


@pytest.fixture
def project(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "0")   # hermetisch: kein Test rührt echtes pyannote an
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    # Sonst entschiede die echte Einstellungsdatei des Entwicklers, ob die Tests den Abo- oder
    # den API-Weg nehmen — und mit hinterlegtem Key gingen sie gegen einen echten Anbieter.
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
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


def test_prep_injects_cluster_prefix(project, monkeypatch):
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")     # Fixture-Default ist 0 (hermetisch) -> hier bewusst an
    (t / "S1.diar.json").write_text(json.dumps(
        {"base": "S1", "segments": [{"id": 0, "speaker": "Sprecher 2"}]}), encoding="utf-8")
    assert correct.cmd_prep("Demo") == 1
    tagged = (t / "S1.tagged.txt").read_text(encoding="utf-8")
    assert tagged.startswith("[0] (Sprecher 2) ")
    assert "[[Mathias|0.30]]" in tagged                # Unsicherheits-Tagging bleibt erhalten


def test_prep_no_prefix_when_diarize_disabled(project):
    _root, t = project
    # TRANSKRIBOR_DIARIZE=0 (Fixture-Default) muss auch die KONSUMPTION eines liegen
    # gebliebenen Sidecars unterdrücken, nicht nur dessen Erzeugung.
    (t / "S1.diar.json").write_text(json.dumps(
        {"base": "S1", "segments": [{"id": 0, "speaker": "Sprecher 2"}]}), encoding="utf-8")
    assert correct.cmd_prep("Demo") == 1
    tagged = (t / "S1.tagged.txt").read_text(encoding="utf-8")
    assert tagged.startswith("[0] ")
    assert "(Sprecher" not in tagged                   # Kill-Switch: Sidecar wird nicht konsumiert


def test_prep_without_diar_has_no_prefix(project):
    _root, t = project
    assert correct.cmd_prep("Demo") == 1
    tagged = (t / "S1.tagged.txt").read_text(encoding="utf-8")
    assert tagged.startswith("[0] ")
    assert "(Sprecher" not in tagged                   # kein Sidecar -> kein Präfix (Fallback)


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
    def fake(prompt, workdir):
        calls.append(prompt)
        m = re.search(r"(\S+_glossar\.json)", prompt)
        if m:
            _dump(m.group(1), {"context_summary": "Bäckerei-Interviews.",
                               "proper_nouns": [{"correct": "Matthias"}], "likely_corrections": []})
            return
        if "TREUE-CHECK" in prompt:                      # Verifikations-Pass: prüft cpath, gibt geprüfte Fassung zurück
            cpath = re.search(r"(\S+\.correction\.json)", prompt).group(1)
            corr = json.loads(open(cpath, encoding="utf-8").read())
            corr.setdefault("annotations", []).append("verifiziert (Fake)")   # Text unverändert, nur Beleg
            _dump(cpath, corr)
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
    # drei claude-Aufrufe: Glossar + Korrektur + Verifikation
    assert len(calls) == 3
    assert any("TREUE-CHECK" in c for c in calls)                    # Verifikations-Pass lief
    assert "verifiziert (Fake)" in (t / "S1.edit.json").read_text(encoding="utf-8")  # geprüfte Fassung gewann
    assert "verifiziert (Fake)" in (t / "S1.md").read_text(encoding="utf-8")         # -> ## Anmerkungen


def test_run_no_verify_skips_verify(project, monkeypatch):
    _root, t = project
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo", verify=False) == 1
    assert len(calls) == 2                                   # nur Glossar + Korrektur, kein Verify
    assert all("TREUE-CHECK" not in c for c in calls)
    assert "verifiziert (Fake)" not in (t / "S1.edit.json").read_text(encoding="utf-8")


def test_run_verify_invalid_restores_stage1(project, monkeypatch):
    _root, t = project

    def fake(prompt, workdir):
        if "_glossar.json" in prompt:
            return
        cpath = re.search(r"(\S+\.correction\.json)", prompt).group(1)
        if "TREUE-CHECK" in prompt:                          # Verify schreibt kaputtes JSON
            with open(cpath, "w", encoding="utf-8") as fh:
                fh.write("{ kaputt kein json")
            return
        _dump(cpath, {"base": "S1", "context": "x", "speakers": ["Interviewer"],
                      "segments": [{"id": 0, "speaker": "Interviewer", "text": "Ich bin Matthias."}],
                      "annotations": [], "summary": "ok"})
    monkeypatch.setattr(correct, "_run_claude", fake)
    assert correct.cmd_run("Demo") == 1                      # Rollback -> gültige Erst-Korrektur bleibt, apply läuft
    corr = json.loads((t / "S1.correction.json").read_text(encoding="utf-8"))
    assert corr["segments"][0]["text"] == "Ich bin Matthias."   # zurückgerollt, nicht das kaputte JSON
    assert "Ich bin Matthias." in (t / "S1.edit.json").read_text(encoding="utf-8")


def test_main_no_verify_flag_and_env(project, monkeypatch):
    seen = {}
    monkeypatch.setattr(correct, "cmd_run",
                        lambda project, base=None, force=False, verify=True: seen.update(verify=verify) or 1)
    correct.main(["run", "Demo"]);                assert seen["verify"] is True   # Default an
    correct.main(["run", "Demo", "--no-verify"]); assert seen["verify"] is False  # Flag schaltet ab
    monkeypatch.setenv("TRANSKRIBOR_VERIFY", "0")
    correct.main(["run", "Demo"]);                assert seen["verify"] is False  # Env schaltet ab


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

    def fake(prompt, workdir):
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

    def fake(prompt, workdir):
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


# ---- _run_claude: Vertrag (argv/cwd/stdin/timeout) + Fehlerzweige (subprocess gefälscht) ----

def test_run_claude_argv_and_confinement(project, monkeypatch):
    from webtool import paths
    captured = {}

    class _R:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        captured["kw"] = kw
        return _R()

    monkeypatch.setattr(correct, "_claude_exe", lambda: "C:/fake/claude.exe")
    monkeypatch.setattr(correct.subprocess, "run", fake_run)
    tdir = paths.transkripte_dir("Demo")
    correct._run_claude("MEIN PROMPT", tdir)
    assert captured["cmd"] == [
        "C:/fake/claude.exe", "-p", "--model", "opus",
        "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write",
        # kein MCP-Server: halbiert den Startup und haelt die persoenlichen Server (Mail,
        # Notion, …) aus einem Lauf raus, der nicht vertrauenswuerdigen Text verarbeitet
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--add-dir", tdir,
    ]
    assert captured["kw"]["cwd"] == tdir                 # Confinement auf EIN Projekt
    assert captured["kw"]["input"] == "MEIN PROMPT"      # Prompt über stdin, nicht argv
    assert captured["kw"]["timeout"] == correct.CLAUDE_TIMEOUT
    # Der Projektbaum als Ganzes darf es NICHT sein: ein praepariertes Transkript koennte
    # sonst in die Transkripte jedes anderen Projekts schreiben (Prompt-Injection).
    assert captured["kw"]["cwd"] != paths.projekte_root()


def test_ask_llm_confines_claude_to_the_output_dir(project, monkeypatch):
    """_ask_llm leitet den Schreibbereich aus dem Zielpfad ab — genau EIN Projekt."""
    from webtool import paths
    _root, t = project
    gesehen = {}
    monkeypatch.setattr(correct.llm, "use_api", lambda: False)
    monkeypatch.setattr(correct, "_run_claude", lambda p, wd: gesehen.update(workdir=wd))
    correct._ask_llm("prompt", [], str(t / "S1.correction.json"))
    assert gesehen["workdir"] == str(t)
    assert gesehen["workdir"] != paths.projekte_root()


def test_run_claude_missing_exe_is_silent(project, monkeypatch):
    ran = {"subprocess": False}
    monkeypatch.setattr(correct.shutil, "which", lambda name: None)   # claude nicht auf PATH
    monkeypatch.setattr(correct.subprocess, "run",
                        lambda *a, **k: ran.__setitem__("subprocess", True))
    correct._run_claude("x", ".")                             # darf nicht crashen
    assert ran["subprocess"] is False                    # still geschluckt: kein subprocess-Aufruf


def test_run_claude_nonzero_returncode_logs(project, monkeypatch, capsys):
    class _R:
        returncode = 2
        stdout = "boom"
        stderr = ""

    monkeypatch.setattr(correct, "_claude_exe", lambda: "claude")
    monkeypatch.setattr(correct.subprocess, "run", lambda *a, **k: _R())
    correct._run_claude("x", ".")                             # kein Crash bei exit!=0
    assert "claude exit 2" in capsys.readouterr().out


def test_run_claude_timeout_is_caught(project, monkeypatch, capsys):
    def boom(*a, **k):
        raise correct.subprocess.TimeoutExpired(cmd="claude", timeout=correct.CLAUDE_TIMEOUT)

    monkeypatch.setattr(correct, "_claude_exe", lambda: "claude")
    monkeypatch.setattr(correct.subprocess, "run", boom)
    correct._run_claude("x", ".")                             # Timeout gefangen, kein Crash
    assert "Timeout" in capsys.readouterr().out


# ---- 2C: CLI-Exitcode signalisiert Total-Ausfall (sonst wird der Job faelschlich "done") ----

def test_run_cli_exits_nonzero_when_nothing_corrected(project, monkeypatch):
    # claude schreibt nie etwas (z.B. nicht auf PATH) -> jede versuchte Datei schlaegt fehl
    monkeypatch.setattr(correct, "_run_claude", lambda prompt, workdir: None)
    with pytest.raises(SystemExit) as ei:
        correct.main(["run", "Demo"])
    assert ei.value.code != 0                            # Job-Signal: Fehler, nicht "done"


def test_run_cli_ok_when_all_human_edited(project, monkeypatch):
    _root, t = project
    (t / "S1.edit.json").write_text(json.dumps(
        {"human_edited": True, "segments": [{"id": 0, "text": "Von Hand."}]}), encoding="utf-8")
    monkeypatch.setattr(correct, "_run_claude", lambda prompt, workdir: None)
    correct.main(["run", "Demo"])                        # alles uebersprungen -> kein Fehlalarm


def test_run_cli_ok_on_success(project, monkeypatch):
    _root, t = project
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, []))
    correct.main(["run", "Demo"])                        # 1/1 korrigiert -> kein SystemExit


# ---- P2.1: Per-Datei-Korrektur (base-Scope + --force) ----

def _add_S2(t):
    raw2 = {"language": "de", "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Zweite Datei.",
         "compression_ratio": 1.0, "no_speech_prob": 0.01, "avg_logprob": -0.3, "words": []}]}
    (t / "S2.json").write_text(json.dumps(raw2), encoding="utf-8")
    (t / "S2.raw.txt").write_text("Zweite Datei.\n", encoding="utf-8")


def test_run_single_base_scopes_to_file_and_bypasses_reuse(project, monkeypatch):
    _root, t = project
    _add_S2(t)
    # frische correction für S1: im BATCH würde sie wiederverwendet, der explizite Einzel-Lauf soll neu korrigieren
    (t / "S1.correction.json").write_text(json.dumps(
        {"base": "S1", "segments": [{"id": 0, "speaker": "X", "text": "Alt."}]}), encoding="utf-8")
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo", base="S1") == 1
    assert (t / "S1.edit.json").exists()
    assert not (t / "S2.edit.json").exists()                  # S2 unangetastet
    assert any("S1.correction.json" in c for c in calls)      # neu korrigiert (Reuse-Guard bypassed)
    assert all("S2.correction.json" not in c for c in calls)  # S2 nie angefasst


def test_run_single_base_unknown_returns_zero(project, monkeypatch):
    _root, t = project
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo", base="gibtsnicht") == 0
    assert all(".correction.json" not in c for c in calls)    # keine Korrektur ausgelöst


def test_run_single_base_force_recorrects_human_edited(project, monkeypatch):
    _root, t = project
    (t / "S1.edit.json").write_text(json.dumps(
        {"human_edited": True, "segments": [{"id": 0, "text": "Von Hand."}]}), encoding="utf-8")
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo", base="S1") == 0            # ohne force: human_edited geschützt
    assert "Von Hand." in (t / "S1.edit.json").read_text(encoding="utf-8")
    assert correct.cmd_run("Demo", base="S1", force=True) == 1  # mit force: neu korrigiert + überschrieben
    assert "Von Hand." not in (t / "S1.edit.json").read_text(encoding="utf-8")


def test_run_cli_base_arg_and_force(project, monkeypatch):
    _root, t = project
    _add_S2(t)
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, []))
    correct.main(["run", "Demo", "S1"])                       # nur S1 im Scope
    assert (t / "S1.edit.json").exists() and not (t / "S2.edit.json").exists()
    (t / "S2.edit.json").write_text(json.dumps(
        {"human_edited": True, "segments": [{"id": 0, "text": "Hand."}]}), encoding="utf-8")
    correct.main(["run", "Demo", "S2", "--force"])            # --force überschreibt human_edited
    assert "Hand." not in (t / "S2.edit.json").read_text(encoding="utf-8")


# ---- Stufe 3: Diarisierung (pyannote gefälscht über webtool.diarize.diarize_file) ----

def _fake_turns(prompt=None):
    # zwei Sprecher, passend zum project-Fixture (S1.json hat 1 Segment 0.0–1.0)
    return [{"start": 0.0, "end": 1.0, "cluster": "SPEAKER_00"}]


def test_cmd_diarize_writes_sidecar(project, monkeypatch):
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
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
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    def boom(*a, **k):
        raise RuntimeError("pyannote kaputt")
    monkeypatch.setattr(diar, "diarize_file", boom)
    assert correct.cmd_diarize("Demo") == 0            # Fehler geschluckt, kein Crash
    assert not (t / "S1.diar.json").exists()


def test_cmd_diarize_idempotent_skip(project, monkeypatch):
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    # frisches Sidecar (neuer als S1.json) -> diarize_file darf nicht laufen
    (t / "S1.diar.json").write_text(json.dumps({"segments": [{"id": 0, "speaker": "Sprecher 1"}]}), encoding="utf-8")
    j_mtime = (t / "S1.json").stat().st_mtime
    os.utime(t / "S1.diar.json", (j_mtime + 10, j_mtime + 10))
    import webtool.diarize as diar
    called = {"n": 0}
    monkeypatch.setattr(diar, "diarize_file", lambda *a, **k: called.__setitem__("n", called["n"] + 1) or [])
    assert correct.cmd_diarize("Demo") == 0
    assert called["n"] == 0


def test_run_single_base_diarizes_only_that_file(project, monkeypatch):
    _root, t = project
    _add_S2(t)
    (_root / "Demo" / "audio" / "S2.mp3").write_bytes(b"x")   # Audio nötig, sonst überspringt cmd_diarize S2 eh
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    calls = {"n": 0}
    def fake_diarize(audio, min_speakers=2):
        calls["n"] += 1
        return [{"start": 0.0, "end": 1.0, "cluster": "SPEAKER_00"}]
    monkeypatch.setattr(diar, "diarize_file", fake_diarize)
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, []))
    assert correct.cmd_run("Demo", base="S1") == 1
    assert calls["n"] == 1                              # nur S1 diarisiert, nicht das ganze Projekt
    assert (t / "S1.diar.json").exists()
    assert not (t / "S2.diar.json").exists()


def test_run_diarizes_before_prep_and_injects(project, monkeypatch):
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2: [{"start": 0.0, "end": 1.0, "cluster": "SPEAKER_00"}])
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    assert (t / "S1.diar.json").exists()                        # diarisiert
    assert (t / "S1.tagged.txt").read_text(encoding="utf-8").startswith("[0] (Sprecher 1) ")  # Präfix im Prep
    assert any("(Sprecher N)" in c and ".tagged.txt" in c for c in calls)  # Korrektur-Prompt erklärt das Präfix


# ---- Chunking + Parallelität ----

def _write_raw(t, base: str, n: int):
    """Roh-Transkript mit n Segmenten — genug, um CHUNK_SEGMENTS zu ueberschreiten."""
    raw = {"language": "de", "segments": [
        {"id": i, "start": float(i), "end": i + 1.0, "text": f" Satz {i}.",
         "compression_ratio": 1.0, "no_speech_prob": 0.01, "avg_logprob": -0.3,
         "words": [{"word": f" Satz{i}", "start": float(i), "end": i + 0.5, "probability": 0.3}]}
        for i in range(n)]}
    (t / f"{base}.json").write_text(json.dumps(raw), encoding="utf-8")
    (t / f"{base}.raw.txt").write_text("Text.\n", encoding="utf-8")


def _chunk_claude(t, calls, lock=None):
    """Fake-claude, der die Block-Anweisung BEACHTET (nur IDs a..b ausgeben) — sonst
    lieferte jeder Block die ganze Datei und der Merge waere blind gegen ID-Fehler."""
    # workdir hat einen Default, weil zwei Tests diesen Schreiber DIREKT aufrufen (statt ihn
    # auf _run_claude zu patchen) — dort ist der Arbeitsordner belanglos.
    def fake(prompt, workdir=None):
        if lock:
            with lock:
                calls.append(prompt)
        else:
            calls.append(prompt)
        m = re.search(r"(\S+_glossar\.json)", prompt)
        if m:
            _dump(m.group(1), {"context_summary": "x", "proper_nouns": [], "likely_corrections": []})
            return
        cpath = re.search(r"(\S+\.correction\.json)", prompt).group(1)
        if "TREUE-CHECK" in prompt:
            return                                   # Treue-Pass laesst die Datei unveraendert
        base = re.sub(r"(\.part\d+)?\.correction\.json$", "", os.path.basename(cpath))
        raw = json.loads((t / (base + ".json")).read_text(encoding="utf-8"))
        ids = [s["id"] for s in raw["segments"]]
        r = re.search(r"IDs (\d+) bis (\d+)", prompt)
        if r:
            a, b = int(r.group(1)), int(r.group(2))
            ids = [i for i in ids if a <= i <= b]
        _dump(cpath, {"base": base, "context": "", "speakers": ["Interviewer"],
                      "segments": [{"id": i, "speaker": "Interviewer", "text": f"Satz {i}."} for i in ids],
                      "annotations": [], "summary": ""})
    return fake


def test_merge_haengt_zusammenfassungen_aller_bloecke_aneinander():
    """"Erster nicht-leerer" hiesse bei einer 390-Segment-Datei, dass die Zusammenfassung des
    ganzen Gespraechs in Wahrheit nur das erste Drittel beschreibt — ohne dass man es sieht.
    Leere Bloecke duerfen dabei keine doppelten Leerzeichen hinterlassen."""
    docs = [{"summary": "Teil eins.", "verification": "nichts geaendert."},
            {"summary": "", "verification": ""},
            {"summary": "Teil drei.", "verification": "Segment 5 zurueckgeholt."}]
    m = correct._merge_parts(docs, "S1")
    assert m["summary"] == "Teil eins. Teil drei."
    assert m["verification"] == "nichts geaendert. Segment 5 zurueckgeholt."


def test_chunked_file_merges_all_blocks(project, monkeypatch):
    _root, t = project
    _write_raw(t, "S1", 6)
    monkeypatch.setattr(correct, "CHUNK_SEGMENTS", 2)          # -> 3 Bloecke
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _chunk_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    corr = json.loads((t / "S1.correction.json").read_text(encoding="utf-8"))
    assert [s["id"] for s in corr["segments"]] == [0, 1, 2, 3, 4, 5]   # vollstaendig und sortiert
    assert not list(t.glob("*.part*.correction.json"))                 # Teil-Dateien nach Merge weg


def test_first_block_is_the_anchor_for_speaker_names(project, monkeypatch):
    """Block 1 laeuft ohne Hinweis, alle spaeteren MIT — sonst taufen die parallelen
    Bloecke denselben Menschen unterschiedlich und _merge_parts zaehlt vier Personen."""
    _root, t = project
    _write_raw(t, "S1", 6)
    monkeypatch.setattr(correct, "CHUNK_SEGMENTS", 2)
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _chunk_claude(t, calls))
    assert correct.cmd_run("Demo", verify=False) == 1
    korr = [c for c in calls if "_glossar.json" not in c]
    erster = next(c for c in korr if "IDs 0 bis 1" in c)
    spaeter = [c for c in korr if "IDs 0 bis 1" not in c]
    assert "Bereits vergebene Sprecher-Namen" not in erster
    assert len(spaeter) == 2
    assert all("Bereits vergebene Sprecher-Namen" in c and "Interviewer" in c for c in spaeter)


def test_parallel_calls_stay_under_the_global_cap(project, monkeypatch):
    """Der Deckel sitzt in _run_claude, nicht in den Executors: zwei Dateien à drei Bloecke
    duerfen NICHT 2x3 gleichzeitige claude-Prozesse ergeben."""
    import threading, time
    _root, t = project
    _write_raw(t, "S1", 6)
    _write_raw(t, "S2", 6)
    (_root / "Demo" / "audio" / "S2.mp3").write_bytes(b"x")
    monkeypatch.setattr(correct, "CHUNK_SEGMENTS", 2)
    monkeypatch.setattr(correct, "_claude_slots", threading.Semaphore(2))
    monkeypatch.setattr(correct, "_claude_exe", lambda: "C:/fake/claude.exe")

    lock, state = threading.Lock(), {"jetzt": 0, "max": 0}
    schreibe = _chunk_claude(t, [], lock)

    def fake_run(cmd, **kw):
        with lock:
            state["jetzt"] += 1
            state["max"] = max(state["max"], state["jetzt"])
        time.sleep(0.05)                     # Ueberlappung erzwingen, sonst misst der Test nichts
        schreibe(kw["input"])                # echtes claude schreibt die Datei via Write-Tool
        with lock:
            state["jetzt"] -= 1
        return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(correct.subprocess, "run", fake_run)
    assert correct.cmd_run("Demo", verify=False) == 2          # beide Dateien fertig
    assert state["max"] <= 2                                   # Deckel hat gehalten
    assert state["max"] > 1                                    # ... und es lief wirklich parallel


def test_verify_pass_bekommt_die_schon_vergebenen_sprechernamen(project, monkeypatch):
    """Der Treue-Pass schreibt die Datei NEU und prueft dabei die Sprecherzuordnung. Ohne
    `known` taufte er Block 2..n um und machte den Anker aus Block 1 wieder zunichte."""
    _root, t = project
    _write_raw(t, "S1", 4)
    monkeypatch.setattr(correct, "CHUNK_SEGMENTS", 2)
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _chunk_claude(t, calls))
    assert correct.cmd_run("Demo") == 1
    verifies = [c for c in calls if "TREUE-CHECK" in c]
    assert len(verifies) == 2
    spaeter = [c for c in verifies if "IDs 0 bis 1" not in c]
    assert spaeter and all("Bereits vergebene Sprecher-Namen" in c for c in spaeter)


def test_gescheiterter_block1_stoppt_die_datei(project, monkeypatch):
    """Sonst schreiben die Bloecke 2..n gueltige Teil-Dateien mit selbst erfundenen Namen,
    die der naechste Lauf als 'schon vorhanden' wiederverwendet — dauerhaft inkonsistent."""
    _root, t = project
    _write_raw(t, "S1", 6)
    monkeypatch.setattr(correct, "CHUNK_SEGMENTS", 2)
    schreibe = _chunk_claude(t, [])

    def nur_block1_faellt_aus(prompt, workdir=None):
        if "IDs 0 bis 1" in prompt and "TREUE-CHECK" not in prompt:
            return                                   # claude schreibt nichts -> Block 1 ungueltig
        schreibe(prompt)

    monkeypatch.setattr(correct, "_run_claude", nur_block1_faellt_aus)
    assert correct.cmd_run("Demo", verify=False) == 0
    assert not (t / "S1.correction.json").exists()
    assert not (t / "S1.part2.correction.json").exists()   # Block 2 lief gar nicht erst
    assert not (t / "S1.part3.correction.json").exists()


def test_kaputtes_TRANSKRIBOR_PARALLEL_faellt_auf_den_default(monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PARALLEL", "drei")
    import importlib
    neu = importlib.reload(correct)
    try:
        assert neu.CLAUDE_PARALLEL == 3
    finally:
        monkeypatch.delenv("TRANSKRIBOR_PARALLEL")
        importlib.reload(correct)
