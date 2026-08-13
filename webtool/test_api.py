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


# "Demo" wird von der client-Fixture angelegt (TRANSKRIBOR_PROJEKTE=tmp_path).
# tmp_projekt ist nur der Name als String; audio_datei das httpx-Tupel fuer files=.
@pytest.fixture
def tmp_projekt():
    return "Demo"


@pytest.fixture
def audio_datei():
    return ("Neu.mp3", b"ID3audio", "audio/mpeg")


def test_list_projects(client):
    r = client.get("/api/projects")
    assert r.status_code == 200
    projs = r.json()["projects"]
    demo = next(p for p in projs if p["name"] == "Demo")
    # S1 hat Roh+Audio, aber noch kein edit.json -> ein Datei, keine fertig.
    assert demo["dateien"] == 1 and demo["fertig"] == 0


def test_list_projects_zeigt_audio_ohne_transkript(client, tmp_path):
    """Frisch hochgeladenes/geladenes Audio muss sofort sichtbar sein — nicht erst,
    wenn Whisper die Roh-JSON geschrieben hat (sonst zeigt der Workspace '0 Dateien')."""
    (tmp_path / "Demo" / "audio" / "Neu.m4a").write_bytes(b"fake")
    demo = next(p for p in client.get("/api/projects").json()["projects"] if p["name"] == "Demo")
    assert demo["dateien"] == 2   # S1 (Roh+Audio) + Neu (nur Audio)


def test_list_projects_ignoriert_nicht_audio_dateien(client, tmp_path):
    (tmp_path / "Demo" / "audio" / "notizen.txt").write_text("kein Audio", encoding="utf-8")
    demo = next(p for p in client.get("/api/projects").json()["projects"] if p["name"] == "Demo")
    assert demo["dateien"] == 1


def test_zusammenfassung_zaehlt_dasselbe_wie_die_dateiliste(tmp_path, monkeypatch):
    """Die Zusammenfassung darf nicht anders zaehlen als der Einzelendpunkt.
    Genau diese Gegenprobe hat bei der Messung belegt, dass der schlanke Weg
    dasselbe misst (3963 == 3963)."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    proj = tmp_path / "Mix"
    (proj / "audio").mkdir(parents=True)
    (proj / "transkripte").mkdir()
    (proj / "audio" / "NurAudio.m4a").write_bytes(b"fake")            # nur Audio
    (proj / "transkripte" / "NurRoh.json").write_text("{}", encoding="utf-8")   # nur roh
    (proj / "transkripte" / "Fertig.json").write_text("{}", encoding="utf-8")   # fertig korrigiert
    (proj / "transkripte" / "Fertig.edit.json").write_text("{}", encoding="utf-8")
    # Ausschlussregel wirklich pruefen, nicht nur den einfachen Fall:
    (proj / "transkripte" / "Fertig.correction.json").write_text("{}", encoding="utf-8")
    (proj / "transkripte" / "Fertig.diar.json").write_text("{}", encoding="utf-8")
    (proj / "transkripte" / "_glossar.json").write_text("{}", encoding="utf-8")
    # verwaist: Rohtranskript geloescht, Editordatei stehengeblieben -- darf NICHT in fertig
    # zaehlen, sonst fertig > dateien (fertig zaehlt hier ausschliesslich existierende Basen).
    (proj / "transkripte" / "Verwaist.edit.json").write_text("{}", encoding="utf-8")

    from webtool.app import get_project, list_projects
    zusammenfassung = {p["name"]: p for p in list_projects()["projects"]}
    for name, p in zusammenfassung.items():
        dateien = get_project(name)["files"]
        assert p["dateien"] == len(dateien)
        assert p["fertig"] == sum(1 for f in dateien if f["has_edit"])
    assert not any(f["base"] == "Verwaist" for f in get_project("Mix")["files"])


def test_geaendert_folgt_dem_ueberschreiben_einer_datei(tmp_path, monkeypatch):
    """Verzeichnis-mtime bewegt sich NICHT, wenn eine vorhandene Datei ueberschrieben
    wird — der Editor tut aber genau das mit <base>.edit.json. Deshalb max(Datei-mtime)."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    proj = tmp_path / "Mix"
    (proj / "transkripte").mkdir(parents=True)
    epath = proj / "transkripte" / "S1.edit.json"
    epath.write_text("{}", encoding="utf-8")

    from webtool.app import list_projects
    vorher = next(p for p in list_projects()["projects"] if p["name"] == "Mix")["geaendert"]
    # os.utime statt sleep: deterministisch, unabhaengig von der mtime-Aufloesung des Dateisystems.
    epath.write_text('{"human_edited": true}', encoding="utf-8")
    os.utime(epath, (vorher + 10, vorher + 10))
    nachher = next(p for p in list_projects()["projects"] if p["name"] == "Mix")["geaendert"]
    assert nachher > vorher


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


def test_export_srt_schreibt_datei(client, tmp_path):
    r = client.post("/api/projects/Demo/files/S1/export/srt")
    assert r.status_code == 200
    srt = r.json()["srt"]
    assert srt.startswith("1\n00:00:")
    assert (tmp_path / "Demo" / "transkripte" / "S1.srt").read_text(encoding="utf-8") == srt


def test_export_srt_ohne_sprecher(client, tmp_path):
    doc = client.get("/api/projects/Demo/files/S1").json()
    doc["segments"][0]["speaker"] = "Interviewer"
    client.put("/api/projects/Demo/files/S1", json=doc)
    assert ">> Interviewer:" in client.post("/api/projects/Demo/files/S1/export/srt").json()["srt"]
    ohne = client.post("/api/projects/Demo/files/S1/export/srt?sprecher=false").json()["srt"]
    assert ">>" not in ohne
    # Beide Varianten schreiben dieselbe Datei — der zweite Lauf muss den ersten ueberschreiben.
    assert (tmp_path / "Demo" / "transkripte" / "S1.srt").read_text(encoding="utf-8") == ohne


def test_get_projekt_einzeln_zeigt_dateien(client, tmp_path):
    tdir = tmp_path / "Demo" / "transkripte"
    (tdir / "S2.json").write_text(json.dumps({"language": "de", "text": "", "segments": []}),
                                   encoding="utf-8")
    (tdir / "S2.edit.json").write_text("{}", encoding="utf-8")
    r = client.get("/api/projects/Demo")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Demo"
    bases = {f["base"]: f for f in body["files"]}
    assert set(bases) == {"S1", "S2"}
    assert bases["S1"]["has_raw"] and not bases["S1"]["has_edit"]
    assert bases["S2"]["has_raw"] and bases["S2"]["has_edit"]


def test_get_projekt_einzeln_unbekanntes_projekt_404(client):
    assert client.get("/api/projects/Nichtvorhanden").status_code == 404


def test_get_projekt_einzeln_ungueltiger_name_400(client):
    r = client.get("/api/projects/a..b")
    assert r.status_code == 400


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


def test_correct_starts_job(client, monkeypatch, mit_anbieter):
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


def test_correct_file_starts_scoped_job(client, monkeypatch, mit_anbieter):
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


def test_korrektur_ohne_anbieter_409_statt_job(client, monkeypatch):
    """Ohne nutzbaren Anbieter darf KEIN Job entstehen: sonst laeuft erst die Diarisierung
    (GPU, Minuten) durch, bevor der erste LLM-Aufruf scheitert."""
    import webtool.app as app_mod, webtool.jobs as jobs_mod
    monkeypatch.setattr(app_mod.llm, "available", lambda: (False, "Kein API-Key fuer OpenAI hinterlegt"))
    gestartet = []
    monkeypatch.setattr(jobs_mod, "start", lambda *a, **k: gestartet.append(a) or ("x", True))

    for pfad in ("/api/projects/Demo/correct", "/api/projects/Demo/files/S1/correct"):
        r = client.post(pfad)
        assert r.status_code == 409, pfad
        # Der Grund muss durchkommen — im Frontend wird genau `detail` zur Fehlermeldung.
        assert "OpenAI" in r.json()["detail"], pfad
    assert gestartet == [], "kein Job trotz fehlendem Anbieter"


def test_unbekannte_datei_gewinnt_gegen_den_anbieter_riegel(client, monkeypatch):
    """404 vor 409: dass die Datei gar nicht existiert, ist die genauere Auskunft — und sie
    gilt unabhaengig davon, ob gerade ein Anbieter eingerichtet ist."""
    import webtool.app as app_mod
    monkeypatch.setattr(app_mod.llm, "available", lambda: (False, "kein Anbieter"))
    assert client.post("/api/projects/Demo/files/nope/correct").status_code == 404


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
                        lambda project, cmd, cwd, kind, then=None, env=None:
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
    monkeypatch.setattr(appmod, "_HARDWARE", {})
    monkeypatch.setattr(device, "describe",
                        lambda m: {"device": "cuda", "name": "RTX 5080", "torch_ok": True})
    r = client.get("/api/hardware")
    assert r.status_code == 200
    assert r.json()["device"] == "cuda"


def test_hardware_wird_gecacht(client, monkeypatch):
    """Der torch-Import kostet Sekunden — genau einmal pro Whisper-Stufe."""
    from webtool import app as appmod
    from webtool import device
    rufe = []
    monkeypatch.setattr(appmod, "_HARDWARE", {})
    monkeypatch.setattr(device, "describe",
                        lambda m: (rufe.append(m),
                                   {"device": "cpu", "name": "CPU", "torch_ok": True})[1])
    client.get("/api/hardware")
    client.get("/api/hardware")
    assert len(rufe) == 1


def test_hardware_bekommt_die_eingestellte_stufe(client, monkeypatch):
    """Auf Apple Silicon haengt die Engine an der Whisper-Stufe (device.asr_engine).
    Wuerde der Endpunkt sie nicht durchreichen, meldete er nach einem Wechsel das
    falsche Rechenwerk — genau die Luege, die device.describe() vermeiden soll."""
    from webtool import app as appmod
    from webtool import device, settings
    monkeypatch.setattr(appmod, "_HARDWARE", {})
    monkeypatch.setattr(settings, "load", lambda: {**settings.DEFAULTS,
                                                   "whisper_model": "turbo"})
    gesehen = []
    monkeypatch.setattr(device, "describe",
                        lambda m: (gesehen.append(m), {"device": "cpu"})[1])
    client.get("/api/hardware")
    assert gesehen == ["turbo"]


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


# --- Anmeldung an den Abo-CLIs -----------------------------------------------

def test_auth_endpunkt_meldet_den_zustand(client, monkeypatch):
    from webtool import auth
    monkeypatch.setattr(auth, "status", lambda p: {
        "unterstuetzt": True, "angemeldet": True, "detail": "Angemeldet als a@b.c (max)"})
    r = client.get("/api/settings/auth")
    assert r.status_code == 200
    assert r.json()["angemeldet"] is True


def test_auth_zustand_ist_auf_den_eingestellten_anbieter_gefiltert(client, monkeypatch):
    """Der Filter sitzt im Endpunkt, nicht in auth.py — ungetestet waere genau der Fehler
    zurueck, der gemeldet wurde: waehrend einer Codex-Anmeldung auf das Claude-Abo
    umgestellt, und die Codex-URL stand unter der Claude-Ueberschrift."""
    from webtool import auth
    client.put("/api/settings", json={"provider": "claude-cli"})
    gesehen = {}

    def fake(provider=""):
        gesehen["provider"] = provider
        return {"laeuft": False}
    monkeypatch.setattr(auth, "zustand", fake)
    client.get("/api/settings/auth/login")
    assert gesehen["provider"] == "claude-cli"


def test_login_code_ohne_laufenden_vorgang_gibt_400(client):
    r = client.post("/api/settings/auth/login/code", json={"code": "EGAL"})
    assert r.status_code == 400


def test_login_start_bei_anbieter_ohne_anmeldung_gibt_400(client):
    """OpenAI kennt keine CLI-Anmeldung — dort ist der Key die Anmeldung."""
    client.put("/api/settings", json={"provider": "openai"})
    assert client.post("/api/settings/auth/login").status_code == 400


# --- Einzelne Datei: loeschen / neu transkribieren ----------------------------

def _artefakte(tmp_path, base="S1"):
    """Legt neben der Roh-JSON aus der Fixture die abgeleiteten Dateien an."""
    t = tmp_path / "Demo" / "transkripte"
    for name in (f"{base}.edit.json", f"{base}.md", f"{base}.srt", f"{base}.correction.json",
                 f"{base}.part1.correction.json", f"{base}.tagged.txt", f"{base}.diar.json",
                 f"{base}.segments.txt"):
        (t / name).write_text("x", encoding="utf-8")
    return t


def test_datei_loeschen_raeumt_audio_und_alle_artefakte_weg(client, tmp_path):
    t = _artefakte(tmp_path)
    r = client.delete("/api/projects/Demo/files/S1")
    assert r.status_code == 200 and r.json()["geloescht"] == 10   # 9 Transkript-Dateien + 1 Audio
    assert list(t.iterdir()) == []
    assert not (tmp_path / "Demo" / "audio" / "S1.mp3").exists()
    assert (tmp_path / "Demo").is_dir()                            # das Projekt bleibt


def test_datei_loeschen_laesst_nachbarn_mit_gemeinsamem_praefix_stehen(client, tmp_path):
    """glob-Muster "S1.*" darf S10 nicht mitnehmen — der literale Punkt trennt.
    Ohne diese Probe faellt der Fehler erst an echten Projekten auf ('Timeline 1'/'Timeline 10')."""
    t = tmp_path / "Demo" / "transkripte"
    (t / "S10.json").write_text("{}", encoding="utf-8")
    (tmp_path / "Demo" / "audio" / "S10.mp3").write_bytes(b"fake")
    assert client.delete("/api/projects/Demo/files/S1").status_code == 200
    assert (t / "S10.json").exists() and (tmp_path / "Demo" / "audio" / "S10.mp3").exists()


def test_datei_loeschen_vertraegt_glob_sonderzeichen_im_namen(client, tmp_path):
    """yt-dlp legt Dateien wie `Video [dQw4w9].m4a` an. Ohne glob.escape() liest glob das
    `[` als Zeichenklasse, findet nichts — und der Endpunkt meldete faelschlich 404."""
    base = "Video [dQw4w9]"
    (tmp_path / "Demo" / "transkripte" / f"{base}.json").write_text("{}", encoding="utf-8")
    (tmp_path / "Demo" / "audio" / f"{base}.m4a").write_bytes(b"fake")
    r = client.delete(f"/api/projects/Demo/files/{base}")
    assert r.status_code == 200 and r.json()["geloescht"] == 2
    assert not (tmp_path / "Demo" / "transkripte" / f"{base}.json").exists()


def test_datei_loeschen_unbekannt_gibt_404(client):
    assert client.delete("/api/projects/Demo/files/GibtsNicht").status_code == 404


def test_datei_loeschen_waehrend_ein_job_laeuft_gibt_409(client, monkeypatch, tmp_path):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base: {"id": "j1", "kind": "correct"})
    r = client.delete("/api/projects/Demo/files/S1")
    assert r.status_code == 409
    # Der Text nennt Aufnahme und Grund und raet NICHT zum Abbrechen: bei einem Lauf, der
    # die Datei gerade schreibt, ist Warten die richtige Reaktion.
    assert "S1" in r.json()["detail"] and "Korrektur" in r.json()["detail"]
    assert "abbrechen" not in r.json()["detail"].lower()
    assert (tmp_path / "Demo" / "transkripte" / "S1.json").exists()   # nichts angefasst


def test_ein_lauf_ohne_diese_aufnahme_sperrt_sie_nicht(client, monkeypatch, tmp_path):
    """Der Kern von #80: eine 20-Minuten-Korrektur ueber andere Aufnahmen darf DIESE nicht
    blockieren. Frueher sperrte jeder Job des Projekts jede Datei."""
    import webtool.jobs as jobs_mod
    gefragt = []
    def nur_S9(name, base):
        gefragt.append((name, base))
        return {"id": "j1", "kind": "correct"} if base == "S9" else None
    monkeypatch.setattr(jobs_mod, "betrifft", nur_S9)
    assert client.delete("/api/projects/Demo/files/S1").status_code == 200
    assert not (tmp_path / "Demo" / "transkripte" / "S1.json").exists()
    assert gefragt == [("Demo", "S1")], "die Sperre fragt nach der Aufnahme, nicht nach dem Projekt"


def test_projekt_umbenennen_bleibt_grob_gesperrt(client, monkeypatch):
    """Ohne `base` bleibt die alte Sperre richtig: beim Umbenennen wandert der ganze Ordner,
    da hilft es nicht, dass der Lauf nur eine einzelne Aufnahme anfasst."""
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base: None)   # keine Datei betroffen
    monkeypatch.setattr(jobs_mod, "active_for", lambda name: [{"id": "j1", "kind": "transcribe"}])
    r = client.post("/api/projects/Demo/rename", json={"name": "Neu"})
    assert r.status_code == 409 and "Transkription" in r.json()["detail"]


def test_neu_transkribieren_raeumt_transkripte_weg_und_startet_den_lauf(client, tmp_path):
    t = _artefakte(tmp_path)
    r = client.post("/api/projects/Demo/files/S1/transcribe")
    assert r.status_code == 200 and r.json()["started"] is True
    # Die abgeleiteten MUESSEN mit weg: load_or_build_doc bevorzugt edit.json vor der Roh-JSON.
    assert list(t.iterdir()) == []
    assert (tmp_path / "Demo" / "audio" / "S1.mp3").exists()          # Audio bleibt


def test_neu_transkribieren_ohne_audio_gibt_404_und_laesst_das_transkript_stehen(client, tmp_path):
    """Ohne Quelle waere das Wegraeumen ein reiner Datenverlust — der Lauf koennte
    nichts wiederherstellen."""
    (tmp_path / "Demo" / "audio" / "S1.mp3").unlink()
    assert client.post("/api/projects/Demo/files/S1/transcribe").status_code == 404
    assert (tmp_path / "Demo" / "transkripte" / "S1.json").exists()


def test_neu_transkribieren_waehrend_ein_job_laeuft_gibt_409(client, monkeypatch, tmp_path):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base: {"id": "j1", "kind": "transcribe"})
    assert client.post("/api/projects/Demo/files/S1/transcribe").status_code == 409
    assert (tmp_path / "Demo" / "transkripte" / "S1.json").exists()


def test_datei_endpunkte_weisen_unsichere_namen_ab(client, tmp_path):
    """%2e%2e erreicht den Handler un-normalisiert (der Client wuerde ein rohes `..`
    schon in der URL wegkuerzen) — genau der Weg, gegen den paths.safe_name steht.
    Ungeprueft loeschte `_datei_weg` sonst mit einem Muster im Elternverzeichnis."""
    assert client.delete("/api/projects/Demo/files/%2e%2e").status_code == 400
    assert client.post("/api/projects/Demo/files/%2e%2e/transcribe").status_code == 400
    # %2f dekodiert Starlette beim Routing -> passt auf kein einzelnes Segment mehr und
    # landet im SPA-Catch-all (405 statt 400). Anderer Code, gleiche Wirkung: der Handler
    # sieht die Anfrage nie. Geprueft wird darum die Wirkung, nicht die Zahl.
    assert client.delete("/api/projects/Demo/files/%2e%2e%2fS1").status_code >= 400
    assert (tmp_path / "Demo" / "transkripte" / "S1.json").exists()


# --- Umbenennen: Projekt und einzelne Aufnahme -------------------------------

def test_projekt_umbenennen_nimmt_die_aufnahmen_mit(client, tmp_path):
    r = client.post("/api/projects/Demo/rename", json={"name": "US Car Treff Rüthi"})
    assert r.status_code == 200 and r.json()["name"] == "US Car Treff Rüthi"
    neu = tmp_path / "US Car Treff Rüthi"
    assert neu.is_dir() and not (tmp_path / "Demo").exists()
    assert (neu / "transkripte" / "S1.json").exists()
    assert (neu / "audio" / "S1.mp3").exists()


def test_projekt_umbenennen_zieht_project_in_der_edit_json_nach(client, tmp_path):
    """`project` steht IM Dokument. Bleibt es stehen, zeigt es auf ein Projekt, das es
    nicht mehr gibt."""
    client.get("/api/projects/Demo/files/S1")
    doc = client.get("/api/projects/Demo/files/S1").json()
    client.put("/api/projects/Demo/files/S1", json=doc)       # legt die edit.json an
    client.post("/api/projects/Demo/rename", json={"name": "Neu"})
    gespeichert = json.loads((tmp_path / "Neu" / "transkripte" / "S1.edit.json").read_text(encoding="utf-8"))
    assert gespeichert["project"] == "Neu"


def test_projekt_umbenennen_auf_bestehenden_namen_gibt_409(client, tmp_path):
    (tmp_path / "Zweit").mkdir()
    assert client.post("/api/projects/Demo/rename", json={"name": "Zweit"}).status_code == 409
    assert (tmp_path / "Demo").is_dir()


def test_projekt_umbenennen_darf_nur_die_schreibweise_aendern(client, tmp_path):
    """Auf Windows ist das Dateisystem case-insensitiv: `exists()` allein meldete hier
    „gibt es schon“ und der Nutzer koennte einen Tippfehler in der Gross-/Kleinschreibung
    nie korrigieren."""
    r = client.post("/api/projects/Demo/rename", json={"name": "DEMO"})
    assert r.status_code == 200
    assert client.get("/api/projects/DEMO").status_code == 200


def test_projekt_umbenennen_prueft_namen_und_jobs(client, monkeypatch, tmp_path):
    assert client.post("/api/projects/Demo/rename", json={"name": ".."}).status_code == 400
    assert client.post("/api/projects/Demo/rename", json={"name": "  "}).status_code == 400
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "active_for", lambda name: [{"id": "j1", "kind": "correct"}])
    assert client.post("/api/projects/Demo/rename", json={"name": "Egal"}).status_code == 409
    assert (tmp_path / "Demo").is_dir()


def test_datei_umbenennen_nimmt_audio_und_alle_artefakte_mit(client, tmp_path):
    t = _artefakte(tmp_path)
    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "Hans Müller"})
    assert r.status_code == 200 and r.json()["umbenannt"] == 10
    assert (t / "Hans Müller.json").exists() and (t / "Hans Müller.part1.correction.json").exists()
    assert (tmp_path / "Demo" / "audio" / "Hans Müller.mp3").exists()
    assert not list(t.glob("S1.*")) and not (tmp_path / "Demo" / "audio" / "S1.mp3").exists()


def test_datei_umbenennen_zieht_base_und_audio_im_dokument_nach(client, tmp_path):
    """render_md macht aus `base` den Titel — bliebe er stehen, truege der naechste
    Export den alten Namen."""
    doc = client.get("/api/projects/Demo/files/S1").json()
    client.put("/api/projects/Demo/files/S1", json=doc)
    client.post("/api/projects/Demo/files/S1/rename", json={"name": "Hans"})
    neu = json.loads((tmp_path / "Demo" / "transkripte" / "Hans.edit.json").read_text(encoding="utf-8"))
    assert neu["base"] == "Hans" and neu["audio"] == "Hans.mp3"


def test_datei_umbenennen_laesst_nachbarn_mit_gemeinsamem_praefix_stehen(client, tmp_path):
    t = tmp_path / "Demo" / "transkripte"
    (t / "S10.json").write_text("{}", encoding="utf-8")
    assert client.post("/api/projects/Demo/files/S1/rename", json={"name": "Neu"}).status_code == 200
    assert (t / "S10.json").exists()


def test_datei_umbenennen_bricht_ab_BEVOR_etwas_wandert(client, tmp_path):
    """Der wichtige Teil ist nicht der 409, sondern dass NICHTS umbenannt wurde: eine halb
    umbenannte Aufnahme gibt es zweimal halb, und der Basisname ist die einzige Verbindung
    zwischen Ton und Transkript."""
    t = _artefakte(tmp_path)
    (t / "Ziel.md").write_text("belegt", encoding="utf-8")     # nur EIN Name kollidiert
    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "Ziel"})
    assert r.status_code == 409
    assert (t / "S1.json").exists() and (t / "S1.edit.json").exists()
    assert (tmp_path / "Demo" / "audio" / "S1.mp3").exists()
    assert (t / "Ziel.md").read_text(encoding="utf-8") == "belegt"


def test_datei_umbenennen_unbekannt_gibt_404_und_prueft_namen(client, monkeypatch):
    assert client.post("/api/projects/Demo/files/GibtsNicht/rename", json={"name": "X"}).status_code == 404
    assert client.post("/api/projects/Demo/files/S1/rename", json={"name": "../weg"}).status_code == 400
    assert client.post("/api/projects/Demo/files/%2e%2e/rename", json={"name": "X"}).status_code == 400
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base: {"id": "j1", "kind": "transcribe"})
    assert client.post("/api/projects/Demo/files/S1/rename", json={"name": "X"}).status_code == 409


# --- Projekteinstellungen: Sprache + Korrektur-Tiefe (Task 6) -----------------

def test_einstellungen_default_fuer_neues_projekt(client, tmp_projekt):
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


# --- Datei-Einstellungen: Sprache + Tiefe pro einzelne Datei (#135) -------------

def test_dateieinstellungen_liefert_effektive_werte(client, tmp_projekt):
    r = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen")
    assert r.status_code == 200
    d = r.json()
    assert d["sprache"] == "ch"          # System-Default, kein Override gesetzt
    assert d["korrektur"] == "auto"
    assert isinstance(d["sprach_choices"], list) and d["sprach_choices"]
    assert isinstance(d["tiefen"], list) and d["tiefen"]


def test_dateieinstellungen_unbekannte_datei_404(client, tmp_projekt):
    # Weder Audio noch Roh-JSON -> die Datei existiert fuer die API nicht.
    assert client.get(f"/api/projects/{tmp_projekt}/files/nope/einstellungen").status_code == 404


def test_dateieinstellungen_invalid_name_400(client, tmp_projekt):
    assert client.get(f"/api/projects/{tmp_projekt}/files/a:b/einstellungen").status_code == 400


def test_dateieinstellungen_speichern_schreibt_override(client, tmp_projekt):
    import webtool.projekt as projekt
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprache": "en"})
    assert r.status_code == 200
    assert r.json()["sprache"] == "en"
    # Override tatsächlich in projekt.json gelandet (datei_sprache siegt über Projekt-Default):
    assert projekt.datei_sprache(tmp_projekt, "S1") == "en"
    # GET liefert den neuen effektiven Wert:
    assert client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen").json()["sprache"] == "en"


def test_dateieinstellungen_speichern_ignoriert_none(client, tmp_projekt):
    # Leerer Body -> nichts ändert sich, kein Fehler (EinstellungenBody ist komplett optional).
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={})
    assert r.status_code == 200
    assert r.json()["korrektur"] == "auto"


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


# --- Sprache-Validierung an Upload + Fetch (#143, gleiche Klasse wie #139) -----

def test_upload_lehnt_unbekannte_sprache_ab(client, tmp_projekt, audio_datei, tmp_path):
    # Ungueltige Sprache muss 400 sein, *bevor* die Datei geschrieben wird — sonst liegt
    # bei der Zurueckweisung eine orphan-Audiodatei auf der Platte.
    r = client.post(f"/api/projects/{tmp_projekt}/audio",
                    files={"file": audio_datei}, data={"sprache": "enm"})
    assert r.status_code == 400
    assert "Sprache" in r.json()["detail"]
    assert not (tmp_path / tmp_projekt / "audio" / "Neu.mp3").exists()   # kein orphan


def test_fetch_lehnt_unbekannte_sprache_ab(client, monkeypatch):
    # fetch.py traegt die Sprache erst im Subprozess ein — am Endpoint geprueft, startet der
    # Download-Job bei ungueltigem Wert gar nicht erst.
    from webtool import jobs
    gestartet = []
    monkeypatch.setattr(jobs, "start",
                        lambda *a, **k: gestartet.append(1) or ("j1", True))
    r = client.post("/api/projects/Demo/fetch",
                    json={"urls": ["https://youtu.be/abc123"], "sprache": "enm"})
    assert r.status_code == 400
    assert "Sprache" in r.json()["detail"]
    assert gestartet == []                      # kein Job angestossen


# --- mehrsprachig: Haken neben der Sprachauswahl -------------------------------

def test_projekteinstellungen_liefern_mehrsprachig(client, tmp_projekt):
    assert client.get(f"/api/projects/{tmp_projekt}/einstellungen").json()["mehrsprachig"] is False


def test_projekt_put_setzt_mehrsprachig(client, tmp_projekt):
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"mehrsprachig": True})
    assert r.status_code == 200 and r.json()["mehrsprachig"] is True
    assert client.get(f"/api/projects/{tmp_projekt}/einstellungen").json()["mehrsprachig"] is True


def test_dateieinstellungen_liefern_mehrsprachig(client, tmp_projekt):
    assert client.get(
        f"/api/projects/{tmp_projekt}/files/S1/einstellungen").json()["mehrsprachig"] is False


def test_datei_put_setzt_mehrsprachig(client, tmp_projekt):
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen",
                   json={"mehrsprachig": True})
    assert r.status_code == 200 and r.json()["mehrsprachig"] is True
    from webtool import projekt
    assert projekt.datei_mehrsprachig(tmp_projekt, "S1") is True


def test_leerer_put_laesst_mehrsprachig_stehen(client, tmp_projekt):
    """Partial-Update: ein PUT ohne das Feld darf den Haken nicht loeschen — sonst raeumt
    ein Sprachwechsel im Dialog die Mehrsprachigkeit still ab."""
    client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"mehrsprachig": True})
    client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"sprache": "en"})
    d = client.get(f"/api/projects/{tmp_projekt}/einstellungen").json()
    assert d["mehrsprachig"] is True and d["sprache"] == "en"


def test_put_lehnt_ungueltiges_mehrsprachig_ab(client, tmp_projekt):
    """Wie sprache/korrektur (#139): 400 mit Feldnamen, geprueft ueber sprachen.pruef_fehler."""
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"mehrsprachig": "ja"})
    assert r.status_code in (400, 422)


def test_upload_schreibt_mehrsprachig(client, tmp_projekt, audio_datei):
    """Der Haken muss VOR dem Job in projekt.json stehen — sonst transkribiert der
    automatisch gestartete Lauf auf Projekt-Standard, und die Datei muesste danach noch
    einmal komplett durch (Minuten GPU)."""
    r = client.post(f"/api/projects/{tmp_projekt}/audio",
                    files={"file": audio_datei}, data={"mehrsprachig": "true"})
    assert r.status_code == 200
    from webtool import projekt
    assert projekt.datei_mehrsprachig(tmp_projekt, r.json()["base"]) is True


def test_upload_ohne_feld_erbt_das_projekt(client, tmp_projekt, audio_datei):
    """Kein Feld = kein Datei-Override -> der Projektwert gilt (Legacy-Verhalten)."""
    client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"mehrsprachig": True})
    r = client.post(f"/api/projects/{tmp_projekt}/audio", files={"file": audio_datei})
    from webtool import projekt
    assert projekt.datei_mehrsprachig(tmp_projekt, r.json()["base"]) is True


def test_fetch_reicht_mehrsprachig_als_env_durch(client, tmp_projekt, monkeypatch):
    """fetch.py kennt den Basisnamen erst nach dem Download — die Einstellung reist deshalb
    als Env mit, wie schon TRANSKRIBOR_FETCH_SPRACHE."""
    gesehen = {}
    from webtool import jobs
    monkeypatch.setattr(jobs, "start",
                        lambda *a, **k: (gesehen.update(k.get("env") or {}), ("j1", True))[1])
    client.post(f"/api/projects/{tmp_projekt}/fetch",
                json={"urls": ["https://youtu.be/x"], "mehrsprachig": True})
    assert gesehen.get("TRANSKRIBOR_FETCH_MEHRSPRACHIG") == "1"
