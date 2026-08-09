import json
import os
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    proj = tmp_path / "Demo"
    (proj / "audio").mkdir(parents=True)
    (proj / "transkripte").mkdir()
    (proj / "audio" / "S1.mp3").write_bytes(b"ID3fakeaudio")
    raw = {"language": "de", "text": "Hallo Welt.", "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Hallo Welt. ",
         "compression_ratio": 1.1, "no_speech_prob": 0.01, "avg_logprob": -0.3,
         "words": [{"word": " Hallo", "start": 0.0, "end": 0.5, "probability": 0.9}]}]}
    (proj / "transkripte" / "S1.json").write_text(json.dumps(raw), encoding="utf-8")
    # Seit dem Auto-Trigger startet schon ein Upload einen Job — ohne diese Attrappe waere das
    # ein echter Whisper-Subprozess, der auch noch die globale Job-Registry der Tests verschmutzt.
    # Tests, die den Start pruefen, patchen `start` danach selbst.
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "start", lambda *a, **k: ("job-fake", True))
    from webtool.app import app
    return TestClient(app)


def test_list_projects(client):
    r = client.get("/api/projects")
    assert r.status_code == 200
    projs = r.json()["projects"]
    demo = next(p for p in projs if p["name"] == "Demo")
    f = next(x for x in demo["files"] if x["base"] == "S1")
    assert f["has_raw"] and f["has_audio"] and not f["has_edit"]


def test_list_projects_zeigt_audio_ohne_transkript(client, tmp_path):
    """Frisch hochgeladenes/geladenes Audio muss sofort sichtbar sein — nicht erst,
    wenn Whisper die Roh-JSON geschrieben hat (sonst zeigt der Workspace '0 Dateien')."""
    (tmp_path / "Demo" / "audio" / "Neu.m4a").write_bytes(b"fake")
    demo = next(p for p in client.get("/api/projects").json()["projects"] if p["name"] == "Demo")
    neu = next(x for x in demo["files"] if x["base"] == "Neu")
    assert neu["has_audio"] and not neu["has_raw"]
    assert [x["base"] for x in demo["files"]] == ["Neu", "S1"]


def test_list_projects_ignoriert_nicht_audio_dateien(client, tmp_path):
    (tmp_path / "Demo" / "audio" / "notizen.txt").write_text("kein Audio", encoding="utf-8")
    demo = next(p for p in client.get("/api/projects").json()["projects"] if p["name"] == "Demo")
    assert [x["base"] for x in demo["files"]] == ["S1"]


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


def test_invalid_project_name_400(client):
    # ':' triggers safe_name rejection -> _validate -> HTTP 400 at the endpoint layer
    r = client.get("/api/projects/a:b/files/x")
    assert r.status_code == 400


def test_transcribe_starts_job(client, monkeypatch):
    calls = {}
    def fake_start(project, cmd, cwd, kind, then=None):
        calls["project"] = project; calls["kind"] = kind; calls["cmd"] = cmd
        calls["then"] = then
        return "job123", True
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "start", fake_start)
    r = client.post("/api/projects/Demo/transcribe")
    assert r.status_code == 200
    assert r.json() == {"job_id": "job123", "started": True}
    assert calls["kind"] == "transcribe" and calls["project"] == "Demo"
    assert calls["cmd"][-1] == "Demo" and calls["cmd"][1].endswith("transcribe.py")
    assert callable(calls["then"])                # Auto-Korrektur haengt am Job, nicht am Browser


def test_transcribe_invalid_name_400(client):
    assert client.post("/api/projects/a:b/transcribe").status_code == 400


def test_correct_starts_job(client, monkeypatch):
    calls = {}
    def fake_start(project, cmd, cwd, kind, then=None):
        calls["project"] = project; calls["kind"] = kind; calls["cmd"] = cmd
        return "corr123", True
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "start", fake_start)
    r = client.post("/api/projects/Demo/correct")
    assert r.status_code == 200
    assert r.json() == {"job_id": "corr123", "started": True}
    assert calls["kind"] == "correct" and calls["project"] == "Demo"
    assert calls["cmd"][-3:] == ["webtool.correct", "run", "Demo"]


def test_correct_invalid_name_400(client):
    assert client.post("/api/projects/a:b/correct").status_code == 400


def test_correct_file_starts_scoped_job(client, monkeypatch):
    calls = {}
    def fake_start(project, cmd, cwd, kind):
        calls["cmd"] = cmd; calls["kind"] = kind; calls["project"] = project
        return "cf1", True
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "start", fake_start)
    r = client.post("/api/projects/Demo/files/S1/correct")
    assert r.status_code == 200 and r.json() == {"job_id": "cf1", "started": True}
    assert calls["kind"] == "correct" and calls["project"] == "Demo"
    assert calls["cmd"][-3:] == ["run", "Demo", "S1"]         # base im Scope, kein --force
    # force=true -> --force ans Ende
    r2 = client.post("/api/projects/Demo/files/S1/correct", params={"force": "true"})
    assert r2.status_code == 200
    assert calls["cmd"][-1] == "--force" and calls["cmd"][-4:-1] == ["run", "Demo", "S1"]


def test_correct_file_unknown_base_404(client):
    assert client.post("/api/projects/Demo/files/nope/correct").status_code == 404


def test_correct_file_invalid_name_400(client):
    assert client.post("/api/projects/Demo/files/a:b/correct").status_code == 400


def test_job_status_and_404(client, monkeypatch):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "get", lambda jid: {"id": jid, "status": "running", "lines": ["x"]} if jid == "j1" else None)
    assert client.get("/api/jobs/j1").json()["status"] == "running"
    assert client.get("/api/jobs/nope").status_code == 404


def test_cancel_job_endpoint(client, monkeypatch):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "cancel", lambda jid: True if jid == "j1" else None)
    assert client.post("/api/jobs/j1/cancel").json() == {"cancelled": True}
    assert client.post("/api/jobs/nope/cancel").status_code == 404


def test_upload_ok_and_duplicate_409(client, tmp_path):
    files = {"file": ("Neu.mp3", b"ID3audio", "audio/mpeg")}
    r = client.post("/api/projects/Demo/audio", files=files)
    assert r.status_code == 200 and r.json()["base"] == "Neu"
    assert (tmp_path / "Demo" / "audio" / "Neu.mp3").read_bytes() == b"ID3audio"
    # zweiter Upload derselben Datei -> 409
    r2 = client.post("/api/projects/Demo/audio", files={"file": ("Neu.mp3", b"x", "audio/mpeg")})
    assert r2.status_code == 409


def test_upload_startet_transkription(client, monkeypatch):
    """Hochladen IST der Trigger — ohne den muesste der Nutzer zusaetzlich auf 'Transkribieren'."""
    calls = {}
    def fake_start(project, cmd, cwd, kind, then=None):
        calls["kind"] = kind; calls["cmd"] = cmd; calls["then"] = then
        return "upl1", True
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "start", fake_start)
    r = client.post("/api/projects/Demo/audio", files={"file": ("Neu.mp3", b"a", "audio/mpeg")})
    assert r.status_code == 200
    assert r.json()["job_id"] == "upl1" and r.json()["started"] is True
    assert calls["kind"] == "transcribe" and calls["cmd"][1].endswith("transcribe.py")
    assert callable(calls["then"])              # und danach automatisch korrigieren


def test_upload_ohne_job_start_bleibt_erfolgreich(client, monkeypatch):
    """Ein abgelehnter/aufgeschobener Job darf den Upload nicht als Fehler erscheinen lassen."""
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "start", lambda *a, **k: ("laeuft_schon", False))
    monkeypatch.setattr(jobs_mod, "when_done", lambda jid, fn: True)
    r = client.post("/api/projects/Demo/audio", files={"file": ("Neu.mp3", b"a", "audio/mpeg")})
    assert r.status_code == 200 and r.json()["started"] is False


def test_upload_bad_extension_400(client):
    r = client.post("/api/projects/Demo/audio", files={"file": ("schad.txt", b"x", "text/plain")})
    assert r.status_code == 400


def test_list_projects_active_jobs_default_empty(client):
    demo = next(p for p in client.get("/api/projects").json()["projects"] if p["name"] == "Demo")
    assert demo["active_jobs"] == []


def test_list_projects_active_jobs_reported(client, monkeypatch):
    import webtool.jobs as jobs_mod
    laufend = [{"id": "j9", "kind": "correct"}, {"id": "j8", "kind": "transcribe"}]
    monkeypatch.setattr(jobs_mod, "active_for", lambda name: laufend if name == "Demo" else [])
    demo = next(p for p in client.get("/api/projects").json()["projects"] if p["name"] == "Demo")
    assert demo["active_jobs"] == laufend         # beide Arten gleichzeitig sind erlaubt


def test_create_project_ok_and_duplicate_409(client, tmp_path):
    r = client.post("/api/projects", json={"name": "Neu"})
    assert r.status_code == 200 and r.json() == {"ok": True, "name": "Neu"}
    assert (tmp_path / "Neu" / "audio").is_dir()
    assert client.post("/api/projects", json={"name": "Neu"}).status_code == 409
    assert client.post("/api/projects", json={"name": "Demo"}).status_code == 409


def test_create_project_invalid_name_400(client):
    assert client.post("/api/projects", json={"name": "a/b"}).status_code == 400
    assert client.post("/api/projects", json={"name": ""}).status_code == 400


def test_delete_project_ok(client, tmp_path):
    assert (tmp_path / "Demo").is_dir()
    r = client.delete("/api/projects/Demo")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert not (tmp_path / "Demo").exists()


def test_delete_project_blocked_when_active_409(client, tmp_path, monkeypatch):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "active_for", lambda name: {"id": "j", "kind": "correct"})
    assert client.delete("/api/projects/Demo").status_code == 409
    assert (tmp_path / "Demo").is_dir()  # nicht gelöscht


def test_delete_project_unknown_404(client):
    assert client.delete("/api/projects/Nope").status_code == 404


def test_delete_project_invalid_name_400(client):
    assert client.delete("/api/projects/a:b").status_code == 400


def test_delete_project_dot_is_rejected_no_data_loss(client, tmp_path):
    # %2e (percent-encoded ".") wird von Starlette/httpx NICHT wie ein
    # literales "." normalisiert -> project="." erreicht den Handler.
    # Ohne den safe_name-Fix: project_dir(".") == projekte_root() -> rmtree
    # löscht die gesamte projekte/-Wurzel (Task 4 Review-Fund).
    r = client.delete("/api/projects/%2e")
    assert r.status_code != 200          # niemals gelöscht
    assert (tmp_path / "Demo").is_dir()  # Root + Demo unangetastet
    assert tmp_path.is_dir()


def test_unknown_api_path_404(client):
    assert client.get("/api/nope").status_code == 404


def test_bare_api_path_404(client):
    assert client.get("/api").status_code == 404


def test_fetch_startet_job(client, monkeypatch):
    from webtool import jobs
    gestartet = {}
    monkeypatch.setattr(jobs, "start",
                        lambda project, cmd, cwd, kind, then=None:
                        gestartet.update(cmd=cmd, kind=kind, then=then) or ("j1", True))
    r = client.post("/api/projects/Demo/fetch", json={"urls": ["https://youtu.be/abc123"]})
    assert r.status_code == 200 and r.json() == {"job_id": "j1", "started": True}
    # Eigene Art: der Download braucht keine GPU und darf nicht hinter einer Transkription warten
    assert gestartet["kind"] == "fetch"
    assert callable(gestartet["then"])                # danach transkribieren (und korrigieren)
    assert "--download-only" in gestartet["cmd"]
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


def test_spa_serves_index_for_deep_link(client):
    from webtool import app as app_mod
    idx = app_mod._INDEX
    created = not os.path.exists(idx)
    if created:
        os.makedirs(app_mod._STATIC, exist_ok=True)
        with open(idx, "w", encoding="utf-8") as fh:
            fh.write("<!doctype html><div id=root></div>")
    try:
        r = client.get("/p/Demo/S1")
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]
    finally:
        if created:
            os.remove(idx)


# ---- Auto-Korrektur nach der Transkription ----

@pytest.fixture
def mit_anbieter(monkeypatch):
    """_autocorrect bricht seit dem ai_ready-Gate ab, wenn `llm.available()` falsch ist.

    Ohne diesen Patch haengen die Tests daran, ob auf dem Rechner `claude` installiert ist:
    beim Entwickler ist es das, auf dem CI-Runner nicht. Dort brachen sie in Zeile 1 von
    _autocorrect ab und pruefte keiner mehr, was er behauptet — gruen aus dem falschen Grund.
    """
    from webtool import app as app_mod
    monkeypatch.setattr(app_mod.llm, "available", lambda: (True, ""))


def test_autocorrect_startet_correct_run(client, monkeypatch, mit_anbieter):
    from webtool import app as app_mod
    gestartet = {}
    monkeypatch.setattr(app_mod.jobs, "start",
                        lambda project, cmd, cwd, kind, then=None:
                        gestartet.update(project=project, cmd=cmd, kind=kind) or ("j1", True))
    app_mod._autocorrect("Demo")
    assert gestartet["kind"] == "correct"
    assert gestartet["cmd"][-3:] == ["webtool.correct", "run", "Demo"]


def test_autocorrect_abschaltbar(client, monkeypatch):
    from webtool import app as app_mod
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "0")
    monkeypatch.setattr(app_mod.jobs, "start",
                        lambda *a, **k: pytest.fail("darf nicht starten"))
    app_mod._autocorrect("Demo")


def test_autocorrect_reiht_sich_hinter_eine_laufende_korrektur(client, monkeypatch, mit_anbieter):
    """Die laufende Runde kennt die eben transkribierten Dateien nicht — also anhaengen,
    statt die Auto-Korrektur stillschweigend fallen zu lassen."""
    from webtool import app as app_mod
    versuche, angehaengt = [], []

    def fake_start(project, cmd, cwd, kind, then=None):
        versuche.append(kind)
        return ("laeuft_schon", False) if len(versuche) == 1 else ("j2", True)

    monkeypatch.setattr(app_mod.jobs, "start", fake_start)
    monkeypatch.setattr(app_mod.jobs, "when_done",
                        lambda jid, fn: angehaengt.append((jid, fn)) or True)
    app_mod._autocorrect("Demo")
    assert len(versuche) == 1 and angehaengt[0][0] == "laeuft_schon"
    angehaengt[0][1]()                                  # der blockierende Job ist fertig
    assert versuche == ["correct", "correct"]           # zweiter Versuch lief


def test_autocorrect_versucht_sofort_neu_wenn_der_blocker_schon_weg_ist(client, monkeypatch, mit_anbieter):
    from webtool import app as app_mod
    versuche = []

    def fake_start(project, cmd, cwd, kind, then=None):
        versuche.append(kind)
        return ("weg", False) if len(versuche) == 1 else ("j2", True)

    monkeypatch.setattr(app_mod.jobs, "start", fake_start)
    monkeypatch.setattr(app_mod.jobs, "when_done", lambda jid, fn: False)   # schon terminal
    app_mod._autocorrect("Demo")
    assert versuche == ["correct", "correct"]


# --- Einstellungen (KI-Anbieter) ---------------------------------------------

def test_settings_default_ist_abo(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    d = r.json()
    assert d["provider"] == "claude-cli" and d["has_key"] is False
    assert any(p["id"] == "anthropic" for p in d["providers"])


def test_settings_speichern_und_key_bleibt_geheim(client):
    r = client.put("/api/settings", json={"provider": "anthropic", "model": "claude-opus-5",
                                          "api_key": "sk-streng-geheim"})
    assert r.status_code == 200 and r.json()["has_key"] is True
    # Der Key darf ueber KEINEN Endpoint zurueckkommen — er verlaesst den Server nie.
    assert "sk-streng-geheim" not in r.text
    assert "sk-streng-geheim" not in client.get("/api/settings").text


def test_settings_modellwechsel_behaelt_den_key(client):
    client.put("/api/settings", json={"provider": "anthropic", "api_key": "sk-a"})
    r = client.put("/api/settings", json={"model": "claude-sonnet-5"})
    assert r.json() == {"provider": "anthropic", "model": "claude-sonnet-5",
                        "base_url": "", "has_key": True,
                        "whisper_model": "large-v3", "whisper_lang": "de"}


def test_settings_unbekannter_anbieter_400(client):
    assert client.put("/api/settings", json={"provider": "erfunden"}).status_code == 400


def test_settings_modelle_ohne_key_400(client):
    client.put("/api/settings", json={"provider": "anthropic"})
    r = client.get("/api/settings/models")
    assert r.status_code == 400 and "Key" in r.json()["detail"]


def test_settings_test_meldet_fehler_statt_zu_500en(client, monkeypatch):
    from webtool import llm
    monkeypatch.setattr(llm, "check", lambda: (_ for _ in ()).throw(llm.LLMError("kein Netz")))
    r = client.post("/api/settings/test")
    assert r.status_code == 200 and r.json() == {"ok": False, "detail": "kein Netz"}


# --- Hardware und Whisper-Einstellungen (Task 6) ---

def test_hardware_endpoint(client, monkeypatch):
    from webtool import app as appmod
    from webtool import device
    monkeypatch.setattr(appmod, "_HARDWARE", None)
    monkeypatch.setattr(device, "describe",
                        lambda: {"device": "cuda", "name": "RTX 5080", "torch_ok": True})
    r = client.get("/api/hardware")
    assert r.status_code == 200
    assert r.json()["device"] == "cuda"


def test_hardware_wird_gecacht(client, monkeypatch):
    """Der torch-Import kostet Sekunden — genau einmal pro Serverlauf."""
    from webtool import app as appmod
    from webtool import device
    rufe = []
    monkeypatch.setattr(appmod, "_HARDWARE", None)
    monkeypatch.setattr(device, "describe",
                        lambda: (rufe.append(1),
                                 {"device": "cpu", "name": "CPU", "torch_ok": True})[1])
    client.get("/api/hardware")
    client.get("/api/hardware")
    assert len(rufe) == 1


def test_settings_liefert_whisper_auswahl(client):
    r = client.get("/api/settings")
    body = r.json()
    assert body["whisper_model"] == "large-v3"
    assert any(c["id"] == "turbo" for c in body["whisper_choices"])


def test_settings_speichert_whisper_modell(client):
    r = client.put("/api/settings", json={"whisper_model": "turbo"})
    assert r.status_code == 200
    assert r.json()["whisper_model"] == "turbo"


def test_settings_lehnt_unbekanntes_whisper_modell_ab(client):
    r = client.put("/api/settings", json={"whisper_model": "gibt-es-nicht"})
    assert r.status_code == 400


# --- Auto-Korrektur mit Anbieter-Gate (Task 8) ---

def test_autocorrect_startet_nicht_ohne_anbieter(client, monkeypatch):
    """Sonst scheitert nach jedem Upload ein Korrektur-Job — der erste Eindruck der App."""
    from webtool import app as appmod
    gestartet = []
    # Ohne das Setzen waere der Test auf einem Rechner mit TRANSKRIBOR_AUTOCORRECT=0
    # gruen, ohne das Anbieter-Gate ueberhaupt zu erreichen.
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "1")
    monkeypatch.setattr(appmod.llm, "available", lambda: (False, "kein claude"))
    monkeypatch.setattr(appmod.jobs, "request",
                        lambda *a, **k: gestartet.append(a) or ("id", True))
    appmod._autocorrect("Testprojekt")
    assert gestartet == []


def test_autocorrect_startet_mit_anbieter(client, monkeypatch):
    from webtool import app as appmod
    gestartet = []
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "1")
    monkeypatch.setattr(appmod.llm, "available", lambda: (True, ""))
    monkeypatch.setattr(appmod.jobs, "request",
                        lambda *a, **k: gestartet.append(a) or ("id", True))
    appmod._autocorrect("Testprojekt")
    assert len(gestartet) == 1


def test_shutdown_bricht_laufende_jobs_ab(client, monkeypatch):
    """Beim Beenden der App bekommt uvicorn ein SIGTERM — auf POSIX erreicht das die
    Job-Kinder nicht (eigene Sitzungen). Ohne diesen Haken laeuft whisper weiter."""
    from webtool import app as appmod
    gerufen = []
    monkeypatch.setattr(appmod.jobs, "cancel_all", lambda: gerufen.append(True) or [])
    with TestClient(appmod.app):
        pass                                   # Kontext verlassen -> lifespan-Shutdown
    assert gerufen == [True]


def test_settings_meldet_ai_ready(client, monkeypatch):
    from webtool import app as appmod
    monkeypatch.setattr(appmod.llm, "available", lambda: (False, "kein claude"))
    body = client.get("/api/settings").json()
    assert body["ai_ready"] is False
    assert body["ai_reason"] == "kein claude"


# ---- Trust-Boundary Browser: Origin-Guard ----
# Der Server hoert nur auf 127.0.0.1, aber eine beliebige besuchte Webseite darf ihm
# "simple" Requests schicken (multipart-Upload, POST ohne Body -> kein Preflight).

def test_fremder_origin_wird_abgewiesen(client):
    r = client.post("/api/projects/Demo/transcribe", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_fremder_origin_kann_kein_audio_unterschieben(client, tmp_path):
    """Der teuerste Fall: multipart ist CORS-safelisted, loest also KEINEN Preflight aus."""
    r = client.post("/api/projects/Neu/audio", headers={"Origin": "https://evil.example"},
                    files={"file": ("x.mp3", b"ID3fake", "audio/mpeg")})
    assert r.status_code == 403
    assert not (tmp_path / "Neu").exists()      # upload_audio legt den Ordner sonst selbst an


def test_origin_null_wird_abgewiesen(client):
    """Sandboxed iframe / file:// schickt 'null' — kein Hostname, also nicht Loopback."""
    assert client.post("/api/projects/Demo/transcribe", headers={"Origin": "null"}).status_code == 403


@pytest.mark.parametrize("origin", ["http://127.0.0.1:8000", "http://localhost:5173",
                                    "http://[::1]:8000"])
def test_eigene_und_dev_herkunft_bleiben_erlaubt(client, origin):
    """Das eigene Frontend, der Vite-Dev-Server (:5173) und die Desktop-App (freier Port)."""
    assert client.post("/api/projects/Demo/transcribe", headers={"Origin": origin}).status_code == 200


def test_ohne_origin_unveraendert(client):
    """curl, die Tests und jeder Nicht-Browser schicken keinen Origin."""
    assert client.get("/api/projects").status_code == 200
    assert client.post("/api/projects/Demo/transcribe").status_code == 200
