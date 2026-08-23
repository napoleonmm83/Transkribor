import json
import os
import re
import pytest
from webtool import correct, paths


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
    monkeypatch.setattr(diar, "diarize_file", lambda audio, min_speakers=2, num_speakers=None, diagnose=None: _fake_turns())
    assert correct.cmd_diarize("Demo") == 1
    side = json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))
    assert side["segments"] == [{"id": 0, "speaker": "Sprecher 1"}]
    assert side["turns"] and side["audio"] == "S1.mp3"


def test_diagnose_landet_im_sidecar(project, monkeypatch):
    """#275: was `diarize_file` in das mitgegebene dict schreibt, steht danach in der
    `.diar.json`. Ohne diesen Weg waere die Diagnose gemessen und weggeworfen."""
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar

    def fake(audio, min_speakers=2, num_speakers=None, diagnose=None):
        if diagnose is not None:
            diagnose.update(pi=[0.62, 0.38, 4e-07], slots=287, durchgelassen=195)
        return _fake_turns()

    monkeypatch.setattr(diar, "diarize_file", fake)
    assert correct.cmd_diarize("Demo") == 1
    side = json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))
    assert side["diagnose"] == {"pi": [0.62, 0.38, 4e-07], "slots": 287, "durchgelassen": 195}


def test_diagnose_gehoert_der_datei_nicht_dem_lauf(project, monkeypatch):
    """Zwei Dateien in EINEM Lauf duerfen sich die Diagnose nicht teilen (CodeRabbit-Bot).

    `diagnose = {}` entsteht INNERHALB der Schleife von `cmd_diarize`. Wer es heraushebt —
    eine Zeile hoeher, sieht harmlos aus —, vererbt die Zahlen der ersten Datei an alle
    folgenden: S2 bekaeme ein `pi`, das zu S1 gehoert, und niemand saehe es an der Datei an.
    Dieselbe Klasse wie der `_Sprachschwelle`-Proxy in `transcribe.py`, nur eine Ebene hoeher.

    Die Attrappe fuellt deshalb NUR fuer S1: danach muss S1 die Zahlen tragen und S2 den
    Schluessel gar nicht haben."""
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    _add_S2(t)
    (_root / "Demo" / "audio" / "S2.mp3").write_bytes(b"x")   # sonst ueberspringt cmd_diarize S2
    import webtool.diarize as diar

    def nur_fuer_S1(audio, min_speakers=2, num_speakers=None, diagnose=None):
        if diagnose is not None and "S1" in os.path.basename(audio):
            diagnose.update(pi=[0.9, 0.1], slots=42, durchgelassen=40)
        return _fake_turns()

    monkeypatch.setattr(diar, "diarize_file", nur_fuer_S1)
    assert correct.cmd_diarize("Demo") == 2

    s1 = json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))
    s2 = json.loads((t / "S2.diar.json").read_text(encoding="utf-8"))
    assert s1["diagnose"] == {"pi": [0.9, 0.1], "slots": 42, "durchgelassen": 40}
    assert "diagnose" not in s2          # NICHT geerbt


def test_ohne_diagnose_steht_der_schluessel_NICHT_im_sidecar(project, monkeypatch):
    """Die Gegenrichtung, und sie ist die wichtigere: greift der Monkeypatch nicht (fremdes
    Paket geaendert), darf KEIN leerer `diagnose`-Schluessel entstehen. Der behauptete
    „gemessen, nichts gefunden" — dieselbe Unterscheidung wie `"text": ""` gegen einen
    fehlenden Schluessel in `apply_correction`. Bestehende Sidecars bleiben damit gueltig."""
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2, num_speakers=None, diagnose=None: _fake_turns())
    assert correct.cmd_diarize("Demo") == 1
    side = json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))
    assert "diagnose" not in side


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
    def fake_diarize(audio, min_speakers=2, num_speakers=None, diagnose=None):
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
                        lambda audio, min_speakers=2, num_speakers=None, diagnose=None: [{"start": 0.0, "end": 1.0, "cluster": "SPEAKER_00"}])
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


def test_der_treue_pass_laeuft_ueber_dateien_hinweg_PARALLEL(project, monkeypatch):
    """Marcus' Frage: laufen zehn Dateien auch im Treue-Pass nebeneinander, nicht nur in der
    Korrektur? Ja — `_correct_one` macht Korrektur UND Verify innerhalb des Datei-Threads,
    der Deckel gilt fuer beide Aufrufarten gleich.

    Der Wächter daneben (`test_parallel_calls_stay_under_the_global_cap`) faehrt mit
    `verify=False` und sagt darueber NICHTS. Ohne diesen Test waere die Zusicherung „der
    Treue-Pass wird mitparallelisiert" eine Behauptung — und sie steht seit der
    Tempo-Messung in der README.

    Gemessen wird, dass zwei VERIFY-Aufrufe gleichzeitig unterwegs sind. Innerhalb EINER
    Datei geht das nicht (Verify braucht das Ergebnis der Korrektur); ueber zwei Dateien
    hinweg schon."""
    import threading, time
    _root, t = project
    _write_raw(t, "S1", 2)
    _write_raw(t, "S2", 2)
    (_root / "Demo" / "audio" / "S2.mp3").write_bytes(b"x")
    monkeypatch.setattr(correct, "_claude_slots", threading.Semaphore(4))
    monkeypatch.setattr(correct, "_claude_exe", lambda: "C:/fake/claude.exe")

    lock, state = threading.Lock(), {"verify_jetzt": 0, "verify_max": 0}
    verify_dateien = []
    schreibe = _chunk_claude(t, [], lock)

    def fake_run(cmd, **kw):
        # `TREUE-CHECK` ist der etablierte Marker — `_chunk_claude` erkennt den Verify-Pass
        # daran (Zeile 650). Ein selbst ausgedachtes "Treue" traf NICHT (Grossschreibung),
        # und ohne die Positivkontrolle unten waere das als "laeuft nicht parallel"
        # durchgegangen statt als Fehler im Test.
        ist_verify = "TREUE-CHECK" in kw["input"]
        if ist_verify:
            with lock:
                state["verify_jetzt"] += 1
                state["verify_max"] = max(state["verify_max"], state["verify_jetzt"])
                # WELCHE Datei — nicht nur wie viele. Ohne das sagt der Test nur „zwei
                # Verify gleichzeitig"; dass es VERSCHIEDENE Dateien sind (der Name
                # behauptet es), folgt sonst bloss daraus, dass hier zufaellig jede Datei
                # einen Block hat. Mit mehr Segmenten waeren zwei Bloecke DERSELBEN Datei
                # dieselbe Beobachtung (CodeRabbit-CLI).
                m = re.search(r"(\S+)\.correction\.json", kw["input"])
                if m:
                    verify_dateien.append(os.path.basename(m.group(1)))
        time.sleep(0.05)                     # Ueberlappung erzwingen, sonst misst der Test nichts
        schreibe(kw["input"])
        if ist_verify:
            with lock:
                state["verify_jetzt"] -= 1
        return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(correct.subprocess, "run", fake_run)
    assert correct.cmd_run("Demo", verify=True) == 2
    # Positivkontrolle: es gab ueberhaupt Verify-Aufrufe (sonst waere die Zeile darunter leer).
    assert state["verify_max"] >= 1, "kein Treue-Pass gelaufen — der Test misst nichts"
    assert state["verify_max"] > 1, "der Treue-Pass lief NICHT parallel ueber die Dateien"
    assert set(verify_dateien) == {"S1", "S2"},         f"beide Dateien muessen durch den Treue-Pass — gesehen: {sorted(set(verify_dateien))}"


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


def test_force_ignoriert_liegengebliebene_teil_dateien(project, monkeypatch):
    """--force galt nur der zusammengefuehrten correction.json; liegengebliebene
    .partN.correction.json wurden weiter wiederverwendet. Ein Lauf nach einer
    Prompt-Aenderung uebernahm damit still Bloecke nach der ALTEN Regel."""
    _root, t = project
    _write_raw(t, "S1", 6)
    monkeypatch.setattr(correct, "CHUNK_SEGMENTS", 2)          # -> 3 Bloecke
    # Block 2 liegt als Teil-Datei vor und ist neuer als die Roh-JSON
    alt = {"base": "S1", "context": "", "speakers": [], "annotations": [], "summary": "",
           "segments": [{"id": 2, "speaker": "Alt", "text": "ALTER PROMPT"},
                        {"id": 3, "speaker": "Alt", "text": "ALTER PROMPT"}]}
    (t / "S1.part2.correction.json").write_text(json.dumps(alt), encoding="utf-8")
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _chunk_claude(t, calls))

    assert correct.cmd_run("Demo", force=True, verify=False) == 1

    corr = json.loads((t / "S1.correction.json").read_text(encoding="utf-8"))
    texte = {s["id"]: s["text"] for s in corr["segments"]}
    assert "ALTER PROMPT" not in texte.values(), "Teil-Datei trotz --force wiederverwendet"
    assert texte[2] == "Satz 2." and texte[3] == "Satz 3."


def test_ohne_force_bleibt_die_teil_datei_der_resume_anker(project, monkeypatch):
    """Die Kehrseite muss erhalten bleiben: ein abgebrochener Lauf ist resumbar, ein
    erneuter Lauf OHNE --force holt nur die fehlenden Bloecke nach."""
    _root, t = project
    _write_raw(t, "S1", 6)
    monkeypatch.setattr(correct, "CHUNK_SEGMENTS", 2)
    fertig = {"base": "S1", "context": "", "speakers": [], "annotations": [], "summary": "",
              "segments": [{"id": 2, "speaker": "X", "text": "SCHON FERTIG"},
                           {"id": 3, "speaker": "X", "text": "SCHON FERTIG"}]}
    (t / "S1.part2.correction.json").write_text(json.dumps(fertig), encoding="utf-8")
    calls = []
    monkeypatch.setattr(correct, "_run_claude", _chunk_claude(t, calls))

    assert correct.cmd_run("Demo", verify=False) == 1

    corr = json.loads((t / "S1.correction.json").read_text(encoding="utf-8"))
    texte = {s["id"]: s["text"] for s in corr["segments"]}
    assert texte[2] == "SCHON FERTIG" and texte[3] == "SCHON FERTIG"


def test_run_meldet_seinen_wirkungsbereich(project, monkeypatch, capsys):
    """Die Zeile ist ein Vertrag mit jobs.py: sie sagt, welche Aufnahmen dieser Lauf anfasst,
    und nur die bleiben fuers Loeschen/Umbenennen gesperrt (Issue #80). Geprueft wird gegen
    jobs.SCOPE_PREFIX, weil das Praefix hier als Literal steht — correct.py darf die
    Job-Registry nicht importieren, also muss ein Test die beiden Seiten zusammenhalten."""
    from webtool import jobs
    _root, t = project
    monkeypatch.setattr(correct, "_run_claude", _fake_claude(t, []))
    correct.cmd_run("Demo", verify=False)
    zeilen = [z for z in capsys.readouterr().out.splitlines() if z.startswith(jobs.SCOPE_PREFIX)]
    assert len(zeilen) == 1, "genau eine Meldung, und zwar vor der Arbeit"
    assert set(zeilen[0][len(jobs.SCOPE_PREFIX):].split("\t")) == {"S1"}


# ---- Sprachbewusste Prompts (ziel + dialekt) ----
# Die Anfuehrungszeichen im Dialekt-Hinweis sind deutsche Typografen-Quotes
# (U+201E low-9 ... U+201C high-9). Der _DIALEKT_HINT-String fuehrt sie als
# echte Unicode-Zeichen (Prompt-Literal, Unicode erlaubt); dieser Kommentar
# bleibt in Ascii, damit ein Editor mit falschem Encoding sie nicht still verbiegt.
_DIALEKT_HINT = "Schweizer „ss“"        # U+201E ss U+201C (Prompt-Literal, Unicode ok)
_EINLEITUNG_CH = "Schweizerdeutsch ->"            # (oft Schweizerdeutsch -> ...)


def test_correct_prompt_englisch_ohne_dialekt():
    p = correct._correct_prompt("b", "t.txt", "c.json", "g.json", "",
                                ziel="clear English", dialekt=False)
    assert "clear English" in p
    assert _DIALEKT_HINT not in p                  # Dialekt-Hinweis nur bei dialekt
    assert _EINLEITUNG_CH not in p


def test_correct_prompt_ch_mit_dialekt():
    # Defaults = Schweizerdeutsch: der Dialekt-Fallback-Kontext (kein kontext.md)
    # muss die urspruengliche dialektsignalisierende Prosa tragen (Constraint 4).
    p = correct._correct_prompt("b", "t.txt", "c.json", "g.json", "")
    assert "Standarddeutsch" in p
    assert _DIALEKT_HINT in p                       # CH: Dialekt-Hinweis steht
    assert _EINLEITUNG_CH in p
    # F1-Regressionsschutz: _default_context(dialekt=True) darf nicht zur neutralen
    # ziel-Prosa verkommen -- sonst geht die Dialekt-Signalisierung verloren.
    assert "Schweizerdeutsch/Dialekt" in p and "Dialektbegriffen" in p


def test_verify_prompt_nimmt_ziel_an():
    p = correct._verify_prompt("b", "t.txt", "c.json", "", ziel="clear English", dialekt=False)
    assert "clear English" in p


def test_ziel_dialekt_explicit_ch(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    from webtool import projekt
    projekt.speichern("p", {"sprache": "ch"})
    ziel, dialekt, _ = correct._ziel_dialekt("p", "x")
    assert "Standarddeutsch" in ziel and dialekt is True


def test_ziel_dialekt_auto_nie_dialekt(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    tdir = os.path.join(tmp_path, "p", "transkripte")
    os.makedirs(tdir, exist_ok=True)
    with open(os.path.join(tdir, "x.json"), "w") as fh:
        json.dump({"language": "en"}, fh)          # Whisper detektierte Englisch
    from webtool import projekt
    projekt.speichern("p", {"sprache": "auto"})
    ziel, dialekt, _ = correct._ziel_dialekt("p", "x")
    assert "English" in ziel and dialekt is False


def _auto_datei(tmp_path, projekt_sprache, erkannt):
    """Projekt mit Standard `projekt_sprache`, Datei ausdruecklich auf `auto`, Roh-JSON
    mit dem detektierten Code `erkannt`."""
    tdir = os.path.join(tmp_path, "p", "transkripte")
    os.makedirs(tdir, exist_ok=True)
    with open(os.path.join(tdir, "x.json"), "w") as fh:
        json.dump({"language": erkannt}, fh)
    from webtool import projekt
    projekt.speichern("p", {"sprache": projekt_sprache})
    projekt.setze_datei("p", "x", sprache="auto")


def test_ziel_dialekt_auto_folgt_dem_projekt_standard(tmp_path, monkeypatch):
    """Spec 10.1: erkanntes `de` + Projekt-Standard `ch` ⇒ `ch`, mit Dialekt-Glaettung.

    Ohne den Vorrang gaebe `von_whisper_code` immer `de` zurueck -- `ch` waere fuer eine
    `auto`-Datei unerreichbar, obwohl der Nutzer es am Projekt eingestellt hat."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    _auto_datei(tmp_path, "ch", "de")
    ziel, dialekt, _ = correct._ziel_dialekt("p", "x")
    assert "Standarddeutsch" in ziel and dialekt is True


def test_ziel_dialekt_auto_uebergeht_den_projekt_standard_bei_fremder_sprache(tmp_path, monkeypatch):
    """Negativkontrolle: der Standard greift NUR bei gleichem Whisper-Code. Sonst waere
    `auto` in einem CH-Projekt ein fest verdrahtetes `ch` -- und der englische Beitrag
    liefe mit Dialekt-Glaettung durch."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    _auto_datei(tmp_path, "ch", "en")
    ziel, dialekt, _ = correct._ziel_dialekt("p", "x")
    assert "English" in ziel and dialekt is False


# ---- Leichte Modi: Prompt-Builder + Tiefen-Verzweigung in cmd_run ----

def test_light_prompt_produziert_zusammenfassung_und_sprecher(monkeypatch):
    p = correct._light_prompt("b", "t.txt", "c.json", "", ziel="clear English")
    assert "clear English" in p
    assert "Zusammenfassung" in p or "summary" in p.lower()
    assert "Sprecher" in p


def test_summary_prompt_ohne_text_korrektur():
    p = correct._summary_prompt("b", "t.txt", "c.json", "", ziel="clear English")
    # verlangt pro Segment NUR id+speaker, KEIN text-Feld
    assert '"id"' in p and "speaker" in p
    # "context"/"Kontext" enthalten den Teilstring "text" -- sie streifen, bevor geprueft wird,
    # ob ein echoes "text"-Feld im Schema steht (nur id+speaker erlaubt).
    stripped = p.replace("Zusammenfassung", "").replace("Kontext", "").replace("context", "")
    assert "text" not in stripped


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
    # a (leicht) -> genau 1 LLM-Aufruf auf a.correction.json (kein Verify);
    # b (voll)   -> 2 Aufrufe auf b.correction.json (Korrektur + Treue-Pass).
    # Auf den .correction.json-Basisnamen geprueft, nicht auf Einzelbuchstaben
    # (die im tmp_path ueberall stehen -- Windows \AppData, Laufwerksbuchstabe).
    bn = lambda p: os.path.basename(p)
    assert sum(1 for c in calls if bn(c) == "a.correction.json") == 1
    assert sum(1 for c in calls if bn(c) == "b.correction.json") == 2


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
    # Der Testfunktionsname enthaelt "_glossar" und steht im tmp_path -- darum auf den
    # tatsaechlichen Dateinamen pruefen, nicht auf den Teilstring.
    monkeypatch.setattr(correct, "_ask_llm",
                        lambda prompt, inputs, output: (glossar_calls.append(output) if output.endswith("_glossar.json") else None,
                         paths.atomic_write(output, '{"speakers":[],"segments":[{"id":0,"speaker":"I","text":"x"}],"summary":"s","base":"x"}')))
    monkeypatch.setattr(correct, "cmd_apply", lambda *a, **k: "written")
    correct.cmd_run("p")
    assert not glossar_calls   # kein Glossar bei nur-zusammenfassung


# --- Mehrsprachige Aufnahmen: die Regel muss in JEDEN Prompt, der Text umschreibt ---

def test_korrektur_prompt_ohne_mehrsprachig_unveraendert():
    """Constraint: die einsprachige Pipeline laeuft WOERTLICH weiter.

    Nicht nur "MEHRSPRACHIG kommt nicht vor" — das bliebe gruen, wenn die Umstellung auf
    `norm_satz` die Wortstellung von Regel 2 aendert. Genau das ist beim Umbau einmal
    passiert (aus "…verbessern, zu X normalisieren." wurde "…verbessern. Normalisiere zu
    X."). Der Schweizerdeutsch-Prompt ist ueber Monate erprobt; er bleibt Zeichen fuer
    Zeichen, wie er war."""
    p = correct._correct_prompt("b", "t.txt", "c.json", "", "kontext")
    assert "MEHRSPRACHIG" not in p
    assert ("2) KORRIGIEREN: klare ASR-Fehler mit Kontext + Glossar verbessern, zu lesbarem "
            "Standarddeutsch normalisieren (Schweizer „ss“). BLEIB TREU:") in p
    assert "SEGMENT FÜR SEGMENT (oft Schweizerdeutsch -> lesbares Standarddeutsch)" in p


def test_leicht_prompt_ohne_mehrsprachig_unveraendert():
    """Dasselbe fuer die leichte Tiefe — auch sie hat eine `norm_satz`-Umstellung bekommen."""
    p = correct._light_prompt("b", "t.txt", "c.json", "kontext")
    assert "2) KORRIGIERE NUR offensichtliche ASR-Fehler und Eigennamen (Sprache: lesbarem Standarddeutsch)." in p


def test_mehrsprachig_prompt_widerspricht_sich_nicht():
    """Der eigentliche Befund aus dem Review: die Regel darf nicht NEBEN einer Anweisung
    stehen, die weiter EINE Zielsprache verlangt. Ueberschrift, Projekt-Kontext und Regel 2
    muessen alle drei mitziehen — sonst enthaelt der Prompt zwei Anweisungen, die sich fuer
    eine englische Passage widersprechen (dieselbe Form, an der die [Musik]-Regel hing)."""
    p = correct._correct_prompt("b", "t.txt", "c.json", "", "", mehrsprachig=True)
    assert "normalisieren" not in p.split("BLEIB TREU")[0]       # Regel 2 verlangt es nicht mehr
    assert "Schweizerdeutsch -> lesbares Standarddeutsch" not in p   # Ueberschrift zieht mit
    assert "oft Schweizerdeutsch/Dialekt" not in p                   # _default_context zieht mit
    assert "übersetze nichts" in p


def test_korrektur_prompt_traegt_die_mehrsprachig_regel():
    p = correct._correct_prompt("b", "t.txt", "c.json", "", "kontext", mehrsprachig=True)
    assert "übersetze nichts" in p


def test_verify_prompt_traegt_die_mehrsprachig_regel():
    """DER eigentliche Test dieser Aufgabe. Der Treue-Pass prueft gegen das Roh und
    schreibt ZULETZT — ohne diese Zeile dreht er eine englische Passage neben deutschem
    Kontext als Untreue zurueck. Exakt die Falle, in die die [Musik]-Regel gelaufen ist."""
    p = correct._verify_prompt("b", "t.txt", "c.json", "kontext", mehrsprachig=True)
    assert "FREMDSPRACHE" in p


def test_verify_regel_haengt_nicht_an_kontext_md():
    """`ziel` erreicht _verify_prompt NUR ueber _default_context, und der greift nur ohne
    kontext.md. Ein Projekt MIT Kontextdatei saehe die Regel sonst nie — deshalb ein
    eigenes Flag statt einer ziel-Phrase."""
    p = correct._verify_prompt("b", "t.txt", "c.json", "ein ausfuehrlicher Projektkontext",
                               mehrsprachig=True)
    assert "FREMDSPRACHE" in p


def test_light_prompt_traegt_die_regel():
    """Die leichte Tiefe schreibt ebenfalls Text um ("KORRIGIERE ... (Sprache: {ziel})") —
    ohne die Regel uebersetzt eine gemischte Datei bei Tiefe 'leicht' genauso nach
    Standarddeutsch. Derselbe Fehler ueber einen anderen Weg."""
    p = correct._light_prompt("b", "t.txt", "c.json", "kontext", mehrsprachig=True)
    assert "übersetze nichts" in p


def test_summary_prompt_bleibt_ohne_regel():
    """Bewusst NICHT: _summary_prompt liefert Segmente ohne text-Schluessel, apply_correction
    behaelt dort den Rohtext — es gibt nichts zu uebersetzen. Eine Regel gegen einen Schaden,
    den das Schema schon ausschliesst, waere Prompt-Ballast.

    Geprueft wird der GERENDERTE Prompt, nicht nur die Signatur: wer den Text direkt in den
    Rumpf schriebe, bliebe bei einer reinen Signaturpruefung gruen."""
    import inspect
    assert "mehrsprachig" not in inspect.signature(correct._summary_prompt).parameters
    p = correct._summary_prompt("b", "t.txt", "c.json", "kontext")
    assert "MEHRSPRACHIG" not in p and "übersetze nichts" not in p


def test_alle_umbenennenden_prompts_erlauben_zwei_cluster_pro_person():
    """Die Erlaubnis stand seit 328ebf2 NUR in _correct_prompt — und der Treue-Pass schreibt
    ZULETZT. Dieselbe Falle wie bei `[Musik]` und der Fremdsprachen-Regel: was der Verify-Pass
    nicht als erlaubt kennt, dreht er als Fehlzuordnung zurueck.

    `_summary_prompt` ist hier ANDERS als bei der Mehrsprachig-Regel dabei: die laesst es
    bewusst aus (seine Segmente haben keinen text-Schluessel, es gibt nichts zu uebersetzen) —
    Sprecher vergibt es aber sehr wohl, also gilt die Cluster-Regel dort.
    """
    prompts = {
        "correct": correct._correct_prompt("b", "t.txt", "c.json", "g.json", "kontext"),
        "verify":  correct._verify_prompt("b", "t.txt", "c.json", "kontext"),
        "light":   correct._light_prompt("b", "t.txt", "c.json", "kontext"),
        "summary": correct._summary_prompt("b", "t.txt", "c.json", "kontext"),
    }
    for name, p in prompts.items():
        assert correct.CLUSTER_REGEL in p, f"{name}-Prompt traegt die Cluster-Regel nicht"


def test_cluster_regel_nennt_den_gemessenen_grund():
    """Eine blosse Erlaubnis reichte nicht — sie stand da, und die Aufspaltung passierte
    trotzdem (#267, gemessen an Rhyathlon/00114307 mit vorgegebener Sprecherzahl 5). Die Regel
    nennt deshalb das konkrete Erkennungsmerkmal, nicht nur die Befugnis.

    Geprueft werden BEIDE Haelften. Nur das Erkennungsmerkmal zu pruefen waere eine
    Vacuity-Luecke: eine Regel, die bloss „Kameramikrofon" und „Frageform" enthaelt, liesse
    diesen Test UND den Einbettungstest gruen — und genau die Erlaubnis, um die es geht, waere
    aus allen vier Prompts verschwunden (CodeRabbit-Bot an PR #269).
    """
    # das Erkennungsmerkmal
    assert "Kameramikrofon" in correct.CLUSTER_REGEL
    assert "Frageform" in correct.CLUSTER_REGEL
    # die Erlaubnis selbst — der eigentliche Inhalt
    assert "nicht zwingend die PERSON" in correct.CLUSTER_REGEL
    assert "ERLAUBTE Entscheidung" in correct.CLUSTER_REGEL
    assert "KEINE Fehlzuordnung" in correct.CLUSTER_REGEL


def test_correct_prompt_nennt_das_cluster_praefix_nicht_mehr_die_wahrheit():
    """Die Erlaubnis stand seit 328ebf2 da und wirkte NICHT — weil zwei Saetze darueber
    „das Praefix ist die WAHRHEIT, WER spricht" stand. Dieselbe Form, gegen die
    correct.py beim Mehrsprachig-Fix ausdruecklich entschieden hat (siehe den Kommentar an
    `_correct_prompt`): die Regel ERSETZT die widersprechende Anweisung, sie steht nicht
    daneben. Ein Prompt mit zwei sich widersprechenden Anweisungen ist die Form, an der die
    [Musik]-Regel schon einmal haengengeblieben ist.
    """
    p = correct._correct_prompt("b", "t.txt", "c.json", "g.json", "kontext")
    assert "WAHRHEIT, WER spricht" not in p


def test_verify_prompt_verbietet_das_auseinanderziehen_gleich_benannter_cluster():
    """Der Gegenpart im Treue-Pass: „Fehlzuordnungen korrigieren" stand dort als PAUSCHALER
    Auftrag — und der Pass schreibt ZULETZT. Ungeschraenkt liest er zwei Cluster mit demselben
    Namen als Fehler und dreht sie zurueck.

    Der Auftrag selbst BLEIBT. Ein erster Anlauf hatte ihn durch „falsch zugeordnete EINZELNE
    Segmente korrigieren" ersetzt und dem Pass damit eine Faehigkeit genommen, die er braucht:
    einen Cluster, der DURCHGEHEND den falschen Namen traegt, umzubenennen (Reviewbefund M1).
    Eingeschraenkt ist nur die eine Richtung — auseinanderziehen.
    """
    p = correct._verify_prompt("b", "t.txt", "c.json", "kontext")
    assert "NICHT auseinanderziehen" in p
    assert "durchgehend falsch benannten Cluster" in p


def test_ziel_dialekt_meldet_mehrsprachig(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    from webtool import projekt
    projekt.setze_datei("p", "a", sprache="ch", mehrsprachig=True)
    ziel, dialekt, mehr = correct._ziel_dialekt("p", "a")
    assert mehr is True
    assert dialekt is True                      # Anker bleibt Schweizerdeutsch
    assert ziel == "lesbarem Standarddeutsch"   # ziel folgt UNVERAENDERT der Ankersprache


# ---- #190: nicht dekodierbare Bytes sind KEIN JSONDecodeError ----
# `json.JSONDecodeError` deckt nur das PARSEN. Sind die BYTES nicht als UTF-8 dekodierbar,
# wirft schon das Lesen im Textmodus einen `UnicodeDecodeError` — ebenfalls ein `ValueError`,
# aber KEIN `JSONDecodeError` (gemessen an einer Datei mit einem einzelnen \xe9-Byte). Jede
# dieser Stellen verspricht "kaputt ⇒ Rueckfall" und hielt es nur fuers Parsen. `write_bytes`
# ist Pflicht: mit `write_text` plus Encoding laesst sich der Fall gar nicht herstellen.

def test_ziel_dialekt_auto_ueberlebt_nicht_dekodierbare_roh_json(tmp_path, monkeypatch):
    """`auto` wird an der Roh-JSON aufgeloest. Ein Wurf hier reisst den ganzen Korrekturlauf
    mit, obwohl der Rueckfall ("de") danebensteht."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    tdir = os.path.join(tmp_path, "p", "transkripte")
    os.makedirs(tdir, exist_ok=True)
    with open(os.path.join(tdir, "x.json"), "wb") as fh:
        fh.write(b'{"language": "\xe9n"}')
    from webtool import projekt
    projekt.speichern("p", {"sprache": "auto"})
    ziel, dialekt, _ = correct._ziel_dialekt("p", "x")
    assert "Standarddeutsch" in ziel and dialekt is False   # Rueckfall "de", nie Dialekt


def test_prep_ueberspringt_nicht_dekodierbare_roh_json(project, capsys):
    """Eine kaputte Roh-JSON darf den Batch nicht stoppen — das galt nur fuers Parsen."""
    _root, t = project
    with open(t / "S2.json", "wb") as fh:
        fh.write(b'{"segments": [{"id": 0, "text": "\xe9"}]}')
    (t / "S2.raw.txt").write_text("x\n", encoding="utf-8")
    assert correct.cmd_prep("Demo") == 1                   # S1 getaggt, S2 uebersprungen
    ausgabe = capsys.readouterr().out
    assert "SKIP S2" in ausgabe and "UnicodeDecodeError" in ausgabe
    assert (t / "S1.tagged.txt").exists() and not (t / "S2.tagged.txt").exists()


def test_apply_ueberschreibt_eine_nicht_lesbare_edit_json_NICHT(project, capsys):
    """Der schaerfste Befund des #190-Reviews, end-to-end gemessen: mit `human_edited` ⇒
    False ersetzte `cmd_apply` die Datei und der Lauf meldete "1/1 korrigiert" — Erfolg
    gemeldet, Handarbeit weg, keine Zeile im Protokoll.

    Hier liegt eine GUELTIGE `correction.json` daneben, der Schreibvorgang wird also
    wirklich erreicht (der erste Anlauf dieses Tests endete an einer fehlenden correction
    und pruefte damit die Ueberschreibrichtung ueberhaupt nicht). `--force` bleibt der Weg
    darueber hinweg — die Kehrseite gehoert mitgetestet, sonst ist die Datei fuer immer
    blockiert."""
    _root, t = project
    roh = b'{"human_edited": true, "summary": "\xe9von Hand"}'
    with open(t / "S1.edit.json", "wb") as fh:
        fh.write(roh)
    (t / "S1.correction.json").write_text(json.dumps(
        {"segments": [{"id": 0, "text": "Maschine."}]}), encoding="utf-8")
    assert correct.cmd_apply("Demo", "S1") == "skipped"
    assert (t / "S1.edit.json").read_bytes() == roh          # Bytes unangetastet
    assert "nicht lesbar" in capsys.readouterr().out         # und nicht still
    assert correct.cmd_apply("Demo", "S1", force=True) == "written"
    assert (t / "S1.edit.json").read_bytes() != roh          # --force kommt durch


def test_is_human_edited_schuetzt_eine_nicht_lesbare_datei(tmp_path, capsys):
    """Die Fehlerrichtung ist hier umgekehrt zu allen anderen Rueckfaellen des Moduls:
    nicht lesbar heisst NICHT "keine Handarbeit". Die Bytes koennen Handarbeit enthalten,
    und `cmd_apply` ersetzt die Datei gleich darauf.

    Vor #190 warf das hier, und der Catch-all in `one()` uebersprang die Datei — die
    Wirkung war also schon immer "uebersprungen", nur als Fehler getarnt (gemessen; ein
    frueherer Docstring behauptete hier "killte den Lauf", das stimmte nicht)."""
    p = tmp_path / "x.edit.json"
    p.write_bytes(b'{"human_edited": true, "summary": "\xe9"}')
    assert correct._is_human_edited(str(p)) is True
    assert "nicht lesbar" in capsys.readouterr().out


def test_is_human_edited_schweigt_bei_fehlender_datei(tmp_path, capsys):
    """Der Normalfall (noch nie korrigiert) darf weder schuetzen noch protokollieren —
    sonst stuende die Warnzeile bei JEDER ersten Korrektur im Log und waere wertlos."""
    assert correct._is_human_edited(str(tmp_path / "gibtsnicht.edit.json")) is False
    assert capsys.readouterr().out == ""


def test_valid_correction_faellt_bei_nicht_dekodierbarer_datei_auf_false(tmp_path):
    """False heisst "keine brauchbare Korrektur" — der Lauf holt sie neu. Genau dafuer ist
    das Erfolgsmass da: eine halb geschriebene Datei darf nicht als fertig durchgehen."""
    p = tmp_path / "x.correction.json"
    p.write_bytes(b'{"segments": [{"id": 0, "text": "\xe9"}]}')
    assert correct._valid_correction(str(p)) is False


def test_glossar_faellt_bei_nicht_dekodierbarer_datei_auf_leer(project, monkeypatch, capsys):
    """Ohne Glossar laeuft die Korrektur weiter (nur ohne gemeinsame Schreibweisen). Ein
    Wurf hier beendete den Lauf, bevor die erste Datei ueberhaupt drankam.

    `_ask_llm` ist gepinnt, obwohl die mtime-Ordnung den Aufruf ueberspringt: kippte sie je
    (rueckwaerts laufende Uhr), ginge dieser Test in einen ECHTEN `claude -p`-Aufruf mit bis
    zu 900 s Timeout und Kontingentverbrauch. Die Fixture pinnt Diarisierung und
    Einstellungen ausdruecklich hermetisch — das hier fehlte."""
    monkeypatch.setattr(correct, "_ask_llm", lambda *a, **k: None)
    _root, t = project
    with open(t / "_glossar.json", "wb") as fh:
        fh.write(b'{"proper_nouns": ["\xe9"]}')      # neuer als S1.raw.txt -> kein LLM-Aufruf
    assert correct._glossary("Demo", "") == ""
    assert "ohne gemeinsames Glossar" in capsys.readouterr().out


def test_kontext_md_nicht_lesbar_stoppt_den_lauf_nicht(project, capsys):
    """`kontext.md` schreibt der Nutzer von Hand — im Editor als ANSI gespeichert ist sie mit
    Umlaut nicht als UTF-8 lesbar. `_context` steht in `cmd_run` NACH diarize + prep: ein Wurf
    verwirft GPU-Minuten und den ganzen Lauf. Weiter ohne Kontext, aber LAUT — ohne ihn faellt
    die Korrektur messbar schlechter aus, das darf nicht still passieren."""
    root, _t = project
    with open(root / "Demo" / "kontext.md", "wb") as fh:
        fh.write(b"Interview mit Gr\xfcnder")          # ANSI/CP1252, kein UTF-8
    assert correct._context("Demo") == ""
    assert "kontext.md nicht lesbar" in capsys.readouterr().out


def test_load_meldet_ein_nicht_objekt_als_valuerror(tmp_path):
    """Gueltiges JSON, aber kein Objekt (ein Modell antwortet auch mal mit einer Liste). Alle
    Aufrufer fangen ValueError und fallen zurueck; das `.get` daneben wuerfe AttributeError
    glatt an ihnen vorbei — dieselbe gebrochene Zusage wie #190 ueber einen anderen Typ.
    Gemessen: `_glossary` starb mit AttributeError, eine Zeile ueber der Meldung
    'Glossar fehlt/ungültig'."""
    p = tmp_path / "g.json"
    p.write_text('["Mathias"]', encoding="utf-8")
    with pytest.raises(ValueError):
        correct._load(str(p))
    assert correct._valid_correction(str(p)) is False      # Rueckfall greift jetzt wirklich


def test_ziel_dialekt_verschluckt_den_unsicheren_namen_nicht(tmp_path, monkeypatch):
    """`paths.safe_name` wirft ValueError fuer unsichere Namen — eine Vertrauensgrenze, kein
    kaputter Dateiinhalt, und der #190-Rueckfall darf sie nicht verschlucken (gemessen: er
    tat es, die Funktion lieferte klaglos Defaults).

    Der Riegel liegt NICHT hier, sondern in `projekt.laden` (ueber `datei_sprache` eine Zeile
    vor dem try). Dieser Test misst die Zusage am Ende der Kette; rot wird er, wenn dort der
    Pfadbau zurueck in den try wandert."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    from webtool import projekt
    projekt.speichern("p", {"sprache": "auto"})
    with pytest.raises(ValueError):
        correct._ziel_dialekt("..", "x")


# ---- Sprecheranzahl aus projekt.json -> pyannote (#264) ----

def test_diarize_reicht_die_eingestellte_sprecherzahl_durch(project, monkeypatch):
    """Ohne Durchreichung ist das Eingabefeld ein toter Schalter. Gemessen an Marcus'
    Rhyathlon-Material: pyannote fand von sich aus 2 statt 4 bzw. 3 statt 5 Sprecher, und die
    Clustering-Parameter halfen nicht (threshold 0.60→0.50 identisch, Fb=0.3 sprengte eine
    5-Personen-Aufnahme auf 9 Cluster). Die vorgegebene Zahl ist die einzige Stellschraube,
    die trifft."""
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    from webtool import projekt
    gesehen = {}
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2, num_speakers=None, diagnose=None:
                        gesehen.update(min=min_speakers, num=num_speakers) or _fake_turns())
    projekt.setze_datei("Demo", "S1", sprecher=5)
    assert correct.cmd_diarize("Demo") == 1
    assert gesehen["num"] == 5
    side = json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))
    assert side["sprecher"] == 5          # das Sidecar haelt fest, WOMIT es gerechnet wurde


def test_diarize_ohne_einstellung_bleibt_beim_alten_verhalten(project, monkeypatch):
    """Die Vorgabe darf sich nicht aendern: wer nichts eintraegt, bekommt exakt den Lauf von
    vorher (min_speakers=2, kein num_speakers). Sonst waere das hier eine stille
    Verhaltensaenderung fuer jedes bestehende Projekt."""
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    gesehen = {}
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2, num_speakers=None, diagnose=None:
                        gesehen.update(min=min_speakers, num=num_speakers) or _fake_turns())
    assert correct.cmd_diarize("Demo") == 1
    assert gesehen == {"min": 2, "num": None}
    assert json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))["sprecher"] is None


def test_geaenderte_sprecherzahl_erzwingt_neue_diarisierung(project, monkeypatch):
    """DIE Falle dieses Features. `cmd_diarize` ueberspringt ein Sidecar, das neuer ist als die
    Roh-JSON — und genau das ist es nach jedem Lauf. Ohne diese Pruefung traegt der Nutzer die
    Zahl ein, laesst neu korrigieren, und es passiert NICHTS: die alte Clusterung wird
    weiterverwendet, der Fehler bleibt, und nichts sagt es ihm. Ein toter Schalter mit
    Bestaetigungston."""
    _root, _t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    from webtool import projekt
    laeufe = {"n": 0}
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2, num_speakers=None, diagnose=None:
                        laeufe.__setitem__("n", laeufe["n"] + 1) or _fake_turns())
    assert correct.cmd_diarize("Demo") == 1 and laeufe["n"] == 1
    assert correct.cmd_diarize("Demo") == 0 and laeufe["n"] == 1     # unveraendert -> Skip
    projekt.setze_datei("Demo", "S1", sprecher=4)
    assert correct.cmd_diarize("Demo") == 1 and laeufe["n"] == 2     # geaendert -> neu
    assert correct.cmd_diarize("Demo") == 0 and laeufe["n"] == 2     # jetzt wieder Skip
    projekt.setze_datei("Demo", "S1", sprecher=projekt.ERBEN)
    assert correct.cmd_diarize("Demo") == 1 and laeufe["n"] == 3     # zurueck auf auto -> neu


def test_scheiternde_diarisierung_laesst_kein_veraltetes_sidecar_zurueck(project, monkeypatch):
    """Was die Sidecar-Invalidierung NEU erlaubt hat (Reviewbefund, gemessen).

    Der Skip faellt jetzt auch bei Zahl-Ungleichheit aus — geschrieben wird das Sidecar aber
    nur bei ERFOLG. Wirft `diarize_file` (GPU-OOM, pyannote fehlt), blieb das ALTE Sidecar
    liegen, die Ungleichheit bestand fort, und JEDER weitere Lauf rechnete erneut: bei einem
    dauerhaften Fehler endlos, jedes Mal GPU-Minuten. Schlimmer als die Kosten war die Luege:
    `cmd_prep` webt danach weiter die ALTE Clusterung in die tagged.txt, waehrend das
    Protokoll „Korrektur ohne Cluster" behauptet — eine stille Falschzuordnung ausgerechnet
    fuer den Nutzer, der die Zahl gerade gesetzt hat. Vor diesem Feld war der Zustand
    unerreichbar (ein gueltiges Sidecar wurde nie erneut versucht).

    Geprueft werden BEIDE Folgen: dass die Datei weg ist (sonst luege `cmd_prep`) und dass ein
    zweiter Lauf nicht schon wieder rechnet — die zweite ist die eigentliche Zusicherung, die
    erste allein bekaeme man auch mit einem `atomic_write` am Ende hin."""
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    from webtool import projekt
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2, num_speakers=None, diagnose=None: _fake_turns())
    assert correct.cmd_diarize("Demo") == 1                    # Sidecar aus dem Auto-Lauf
    assert (t / "S1.diar.json").exists()

    laeufe = {"n": 0}
    def boom(audio, min_speakers=2, num_speakers=None, diagnose=None):
        laeufe["n"] += 1
        raise RuntimeError("CUDA out of memory")
    monkeypatch.setattr(diar, "diarize_file", boom)
    projekt.setze_datei("Demo", "S1", sprecher=4)
    assert correct.cmd_diarize("Demo") == 0 and laeufe["n"] == 1
    assert not (t / "S1.diar.json").exists()                   # sonst nutzt cmd_prep die ALTE Clusterung
    # ... und der naechste Lauf faengt nicht wieder von vorn an zu rechnen? Doch — aber jetzt
    # aus dem dokumentierten „kein Sidecar"-Zustand heraus, nicht aus einer Ungleichheit, die
    # sich selbst am Leben haelt. Der Unterschied zeigt sich, sobald die GPU wieder da ist:
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2, num_speakers=None, diagnose=None: _fake_turns())
    assert correct.cmd_diarize("Demo") == 1
    assert correct.cmd_diarize("Demo") == 0                    # konvergiert, kein Dauerlauf
