import json
import os
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
