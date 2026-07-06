import json
import os
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    proj = tmp_path / "Demo"
    (proj / "audio").mkdir(parents=True)
    (proj / "transkripte").mkdir()
    (proj / "audio" / "S1.mp3").write_bytes(b"ID3fakeaudio")
    raw = {"language": "de", "text": "Hallo Welt.", "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Hallo Welt. ",
         "compression_ratio": 1.1, "no_speech_prob": 0.01, "avg_logprob": -0.3,
         "words": [{"word": " Hallo", "start": 0.0, "end": 0.5, "probability": 0.9}]}]}
    (proj / "transkripte" / "S1.json").write_text(json.dumps(raw), encoding="utf-8")
    from webtool.app import app
    return TestClient(app)


def test_list_projects(client):
    r = client.get("/api/projects")
    assert r.status_code == 200
    projs = r.json()["projects"]
    demo = next(p for p in projs if p["name"] == "Demo")
    f = next(x for x in demo["files"] if x["base"] == "S1")
    assert f["has_raw"] and f["has_audio"] and not f["has_edit"]


def test_get_file_builds_doc(client):
    r = client.get("/api/projects/Demo/files/S1")
    assert r.status_code == 200
    doc = r.json()
    assert doc["base"] == "S1" and doc["audio"] == "S1.mp3"
    assert doc["segments"][0]["text"] == "Hallo Welt."


def test_get_missing_file_404(client):
    assert client.get("/api/projects/Demo/files/nope").status_code == 404


def test_audio_range_206(client):
    r = client.get("/api/projects/Demo/audio/S1", headers={"Range": "bytes=0-3"})
    assert r.status_code == 206
    assert r.content == b"ID3f"


def test_put_saves_non_destructive(client, tmp_path):
    doc = client.get("/api/projects/Demo/files/S1").json()
    doc["segments"][0]["speaker"] = "Interviewer"
    doc["segments"][0]["text"] = "Hallo, Welt!"
    r = client.put("/api/projects/Demo/files/S1", json=doc)
    assert r.status_code == 200 and r.json()["ok"] is True

    tdir = tmp_path / "Demo" / "transkripte"
    saved = (tdir / "S1.edit.json").read_text(encoding="utf-8")
    assert '"human_edited": true' in saved
    assert "Interviewer" in saved
    md = (tdir / "S1.md").read_text(encoding="utf-8")
    assert "**Interviewer:** Hallo, Welt!" in md
    # Roh-JSON unangetastet
    raw = (tdir / "S1.json").read_text(encoding="utf-8")
    assert "Hallo Welt." in raw and "Hallo, Welt!" not in raw


def test_export_returns_md(client):
    client.get("/api/projects/Demo/files/S1")
    r = client.post("/api/projects/Demo/files/S1/export")
    assert r.status_code == 200 and r.json()["md"].startswith("# Interview S1")
