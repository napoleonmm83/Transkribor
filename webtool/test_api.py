import json
import os
import threading
import time
import pytest
from fastapi.testclient import TestClient


def _warte(pruef, sekunden=5.0) -> bool:
    """Bis `pruef()` wahr ist. Ein Faden braucht eine Weile — aber kein Test darf haengen,
    und ein festes `sleep` waere auf einem geteilten Runner entweder zu kurz oder Ballast."""
    ende = time.monotonic() + sekunden
    while time.monotonic() < ende:
        if pruef():
            return True
        time.sleep(0.01)
    return bool(pruef())


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    # Dieselbe Regel wie bei TRANSKRIBOR_SETTINGS: die Variable GEWINNT gegen die
    # Einstellungsdatei (`ytdlp_update.auto_an`), also entschiede sonst die Shell des
    # Entwicklers ueber das Testergebnis. Reproduziert: mit `TRANSKRIBOR_YTDLP_UPDATE=1`
    # faellt `test_settings_ytdlp_schalter_wird_gespeichert` um.
    monkeypatch.delenv("TRANSKRIBOR_YTDLP_UPDATE", raising=False)
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
    # Der Hintergrundlauf des yt-dlp-Knopfs (#174) ist MODULZUSTAND und ueberlebt den Test.
    # Ein liegengebliebenes `laeuft=True` sperrte den Knopf in jedem folgenden — `setitem`
    # setzt und stellt danach wieder her.
    import webtool.ytdlp_update as ytu
    monkeypatch.setitem(ytu._lauf, "laeuft", False)
    monkeypatch.setitem(ytu._lauf, "ergebnis", "")
    monkeypatch.setitem(ytu._lauf, "ungeschuetzt", False)
    # Seit #253 haengt die Kalenderpruefung am LIFESPAN, und jedes `with TestClient(app)`
    # betritt ihn. Diese Fixture loescht `TRANSKRIBOR_YTDLP_UPDATE` (oben, mit Begruendung)
    # und legt eine leere Einstellungsdatei an — also `auto_an() True` und `geprueft() None`.
    # Gemessen mit blockiertem `subprocess.run`: `faellig()` ist auf einem Entwicklerrechner
    # mit installiertem yt-dlp **True**, und `test_shutdown_bricht_laufende_jobs_ab` startete
    # damit ein echtes `pip install -U "yt-dlp[default]"` gegen die venv des Laeufers.
    #
    # **Die CI sieht das nie:** ihr Job installiert kein yt-dlp, also `fassung() None` ⇒
    # `faellig() False` ⇒ kein pip. Der Schaden trifft ausschliesslich den Entwickler — und
    # deshalb steht der Riegel hier in der Fixture und nicht in dem einen Test: das naechste
    # `with TestClient(...)` macht die Tuer sonst wieder auf. Wer den Startlauf PRUEFEN will,
    # baut seinen TestClient ohne diese Fixture (siehe
    # `test_start_stoesst_die_ytdlp_kalenderpruefung_an`).
    monkeypatch.setattr(ytu, "beim_start", lambda: False)
    from webtool.app import app
    yield TestClient(app)
    # Auf einen noch laufenden Hintergrundfaden warten — und zwar HIER, vor monkeypatchs
    # Teardown (Fixture-Teardown laeuft in umgekehrter Setup-Reihenfolge, die Attrappe von
    # `aktualisiere` steht also noch). Zwei Gruende, beide teurer als die vier Zeilen:
    # scheitert ein `assert` VOR dem `_warte(...)` im Test, schriebe der ueberlebende Faden
    # `_lauf` in den NAECHSTEN Test hinein — und `aktualisiere()` fragt `auto_an()` NICHT
    # (nur `automatisch()` tut das), die Schutzregel `TRANSKRIBOR_YTDLP_UPDATE=0` greift auf
    # diesem Pfad also gar nicht: ein durchgerutschter Aufruf waere ein echtes
    # `pip install -U yt-dlp[default]` gegen die venv des Laeufers.
    #
    # Nicht beobachtet, sondern fehlendes Netz: 200 Runden mit Teardown unmittelbar nach
    # `start()` ergaben 0 Ueberlaeufe (`Thread.start()` kehrt auf CPython/Windows erst
    # zurueck, wenn der Faden im Ziel ist). Der Schaden waere eine fremde venv.
    # Das Ergebnis auswerten, nicht wegwerfen: laeuft der Faden laenger, endete der Teardown
    # sonst STILL und `_lauf` leckte in den naechsten Test — also genau der Fall, gegen den
    # diese Zeilen stehen. Ein Fehlschlag hier nennt die Ursache, statt einen Folgetest ohne
    # erkennbaren Grund umzuwerfen. (CodeRabbit an PR #223.)
    assert _warte(lambda: not ytu.hintergrund_zustand()[0], 10.0), \
        "yt-dlp-Hintergrundfaden lief nach 10 s noch — Modulzustand leckt in den naechsten Test"


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
    monkeypatch.setattr(app_mod.llm, "available", lambda *_a: (False, "Kein API-Key fuer OpenAI hinterlegt"))
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
    monkeypatch.setattr(app_mod.llm, "available", lambda *_a: (False, "kein Anbieter"))
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
    monkeypatch.setattr(app_mod.llm, "available", lambda *_a: (True, ""))


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
    body = r.json()
    # `ytdlp` haengt an der Umgebung (installierte Fassung), nicht an den Einstellungen —
    # separat geprueft, damit dieser Vergleich nicht bei jedem yt-dlp-Update umfaellt.
    assert body.pop("ytdlp").keys() == {"version", "unlesbar", "geprueft", "auto", "env",
                                        # seit #174: der Knopf antwortet sofort, der Ausgang
                                        # des pip-Laufs kommt ueber diese beiden nach
                                        "laeuft", "ergebnis",
                                        # #236: der Lauf lief ohne Sperre — gehoert zu
                                        # `ergebnis`. #198: die Metadaten der Loeserskripte
                                        # sind kaputt, ihre Pruefung ist ausgesetzt.
                                        "ungeschuetzt", "unterbrochen", "ejs_unlesbar"}
    # Seit #239 baut der PUT denselben Rumpf wie der GET. Diese sechs haengen an der Umgebung
    # (installierte Abo-CLIs, Projektwurzel) und kommen deshalb hier heraus — sonst fiele der
    # Vergleich unten auf jedem zweiten Rechner um. Fehlt eines, wirft schon das `pop`.
    # DASS es dieselben sind wie im GET, prueft `test_settings_put_liefert_denselben_rumpf…`.
    umgebung = {k: body.pop(k) for k in ("providers", "env_key", "whisper_choices",
                                         "projekte_pfad", "ai_ready", "ai_reason")}
    assert umgebung["providers"], "die Anbieterliste kommt live und darf nicht leer sein"
    assert body == {"provider": "anthropic", "model": "claude-sonnet-5",
                    "base_url": "", "has_key": True,
                    "whisper_model": "large-v3", "whisper_lang": "de",
                    # "" = es liegt keine beiseitegelegte Einstellungsdatei (#192)
                    "ytdlp_auto": "1", "kaputt": "",
                    # Der Normalfall (#194) — und zugleich die Gegenprobe zum Test unten:
                    # ein dauerhaft gesetztes Flag waere ein Daueralarm und faellt hier auf.
                    "ungeschuetzt": False}


def test_settings_rumpf_traegt_alle_felder_die_das_frontend_tippt(client):
    """Die Gegenstuecke stehen in `webtool/frontend/src/lib/types.ts` als `Settings`.

    Der Paritaetstest darunter allein reicht dafuer NICHT: seit #239 bauen beide Endpunkte
    ihren Rumpf aus derselben Funktion, ein dort entferntes Feld verschwaende also auf beiden
    Seiten gleichzeitig und die Paritaet bliebe bestehen. Dieser Test haelt die Menge selbst
    fest — er wird rot, wenn ein Feld wegfaellt, das der Typ verspricht.
    """
    assert set(client.get("/api/settings").json()) == {
        # aus settings.public()
        "provider", "model", "base_url", "has_key", "kaputt",
        "whisper_model", "whisper_lang", "ytdlp_auto",
        # Umgebung, die das Frontend braucht
        "providers", "env_key", "whisper_choices", "ai_ready", "ai_reason",
        # wo die Arbeit des Nutzers liegt (#218)
        "projekte_pfad",
        "ytdlp"}


def test_settings_nennt_die_WIRKSAME_projektwurzel(client, monkeypatch, tmp_path):
    """#218: der Pfad muss der sein, unter dem der Server wirklich arbeitet.

    Der Wert ist nicht statisch — `TRANSKRIBOR_PROJEKTE` setzt ihn, und in der gepackten App
    tut das `electron/backend.js`. Entscheidend ist aber, dass `settings.load_env()` ihn
    danach noch aus der `.env` ueberschreiben darf: der Server kennt den wirksamen Wert also
    als EINZIGER. Genau daran haengt, dass „Ordner oeffnen" denselben Ordner oeffnet, den die
    Seite nennt — dieser Test ist der Grund, warum der Electron-Handler den Server fragt,
    statt `P.projekte` selbst zu benutzen (Reviewbefund I1).
    """
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path / "woanders"))
    assert client.get("/api/settings").json()["projekte_pfad"] == str(tmp_path / "woanders")


def test_settings_antwort_beurteilt_DENSELBEN_stand_den_sie_meldet(client, monkeypatch):
    """Eine Antwort, eine Wahrheit (CodeRabbit-Bot an PR #248).

    `settings.public(cfg)` bekam den geschriebenen Snapshot, `llm.available()` las die Datei
    neu. Unter zwei gleichzeitigen Schreibern trug dieselbe Antwort dann `provider` aus dem
    einen Schreibvorgang und `ai_reason` aus dem anderen — der Nutzer laese „Anbieter:
    Anthropic" neben „claude ist auf diesem Rechner nicht installiert".

    Gemessen wird das ohne Nebenlaeufigkeit: die Datei sagt etwas ANDERES als der uebergebene
    Stand. Liest `available()` selbst nach, gewinnt die Datei und der Test faellt.
    """
    from webtool import llm

    # Was auf der PLATTE steht, wenn `available()` selbst laese: ein Abo ohne Binary.
    monkeypatch.setattr(llm.settings, "load",
                        lambda: {"provider": "claude-cli", "model": "opus", "base_url": "",
                                 "api_key": "", "whisper_model": "large-v3",
                                 "whisper_lang": "de", "ytdlp_auto": "1"})
    monkeypatch.setattr(llm, "_exe", lambda prov: "")      # kein claude-Binary

    # Der PUT stellt auf einen API-Anbieter OHNE Key um — die Begruendung muss DEN nennen.
    body = client.put("/api/settings", json={"provider": "openai"}).json()
    assert body["provider"] == "openai"
    assert body["ai_ready"] is False
    assert "OpenAI" in body["ai_reason"], \
        f"die Begruendung gilt einem anderen Stand als `provider`: {body['ai_reason']!r}"


def test_settings_put_liefert_denselben_rumpf_wie_der_get(client):
    """#239: `api.saveSettings` verspricht eine vollstaendige `Settings` — der PUT lieferte
    aber `providers`, `env_key`, `whisper_choices`, `ai_ready` und `ai_reason` nicht.

    Aufgefallen ist es nie, weil `SettingsPage.speichern` zusammenmischt und die fehlenden
    Felder aus dem vorigen Stand ueberleben; die Frontend-Tests koennen es strukturell nicht
    finden, weil ihre `saveSettings`-Attrappe ein VOLLSTAENDIGES Objekt liefert und damit die
    Falschaussage selbst behauptet. Deshalb steht der Waechter hier.

    Die Mutation, die er faengt: der PUT baut seinen Rumpf wieder selbst.
    """
    get = set(client.get("/api/settings").json())
    put = set(client.put("/api/settings", json={"model": "claude-sonnet-5"}).json())
    assert put - {"ungeschuetzt"} == get
    # Beide Richtungen: `ungeschuetzt` beschreibt EINEN Schreibvorgang (#194) — im GET waere
    # es sinnlos, und im `Settings`-Typ bliebe die Warnung bis zum Neuladen stehen.
    assert "ungeschuetzt" in put and "ungeschuetzt" not in get


def test_settings_put_sagt_es_wenn_ungeschuetzt_geschrieben_wurde(client, monkeypatch):
    """#194: die Sperre darf fail-open gehen (sie schuetzt vor einer Race, sie ist nicht der
    Zweck des Aufrufs) — aber dann ist `save()` ein Read-Modify-Write ohne Schutz, und ein
    gleichzeitiger Schreiber kann den gerade eingetragenen API-Key ueberbuegeln (#192). Der
    Server weiss das und meldete bisher blanken Erfolg; die Protokollzeile aus `sperre.py`
    erreicht nur eine Konsole, und die gepackte App hat keine, die jemand liest.

    **200, nicht 5xx**: geschrieben IST worden. Ein Fehler waere die zweite Unwahrheit.
    """
    from webtool import sperre

    def nie(*a, **k):
        raise PermissionError(5, "Access is denied")

    monkeypatch.setattr(sperre, "_HAKELIG_S", 0.02)
    # `sperre.os` IST `os` — das hier legt `os.mkdir` prozessweit lahm, also auch das
    # `os.makedirs` in `settings.save()` eine Zeile darueber. Das ueberlebt nur, weil
    # `makedirs` den Fehler bei `exist_ok=True` und bereits vorhandenem Verzeichnis schluckt:
    # die `client`-Fixture legt `settings.json` nach `tmp_path`, und das gibt es. Wer die
    # Fixture in ein noch nicht angelegtes Verzeichnis umzieht, bekommt hier einen 500er,
    # dessen Ursache drei Schichten entfernt liegt.
    monkeypatch.setattr(sperre.os, "mkdir", nie)
    r = client.put("/api/settings", json={"model": "claude-sonnet-5"})
    assert r.status_code == 200
    assert r.json()["ungeschuetzt"] is True
    assert r.json()["model"] == "claude-sonnet-5", "geschrieben wurde trotzdem"


def test_settings_meldet_den_ytdlp_zustand(client, monkeypatch):
    """Ohne Anzeige waere der Automatismus unsichtbar — und ein unsichtbarer Automatismus
    ist genau dann nicht zu durchschauen, wenn er danebengeht."""
    from webtool import ytdlp_update
    # An der ECHTEN Grenze gepatcht (`importlib.metadata`), nicht an einer Funktion des
    # Moduls: `fassung` zu patchen lief seit #189 ins Leere (`zustand()` geht nicht mehr
    # dadurch), und eine private Funktion zu patchen entwertet den naechsten Umbau
    # genauso still. So wird `_fassung_und_lesbarkeit` wirklich ausgeuebt.
    monkeypatch.setattr(ytdlp_update.metadata, "version", lambda name: "2026.8.12")
    body = client.get("/api/settings").json()
    assert body["ytdlp"]["version"] == "2026.8.12"
    assert body["ytdlp"]["auto"] is True and body["ytdlp_auto"] == "1"


def test_settings_ytdlp_schalter_wird_gespeichert(client):
    r = client.put("/api/settings", json={"ytdlp_auto": "0"}).json()
    assert r["ytdlp_auto"] == "0"
    # Der PUT liefert den ganzen `ytdlp`-Block mit: das Frontend tippt die Antwort als
    # vollstaendige `Settings`, und ohne ihn brauchte es ein zweites Laden, dessen
    # Fehlschlag die Anzeige auf dem Stand von vor dem Klick stehen liess.
    assert r["ytdlp"]["auto"] is False
    assert client.get("/api/settings").json()["ytdlp"]["auto"] is False


def test_settings_lehnt_ungueltigen_ytdlp_schalter_ab(client):
    """`auto_an()` prueft auf "0"/"false"/"no" — ein durchgereichtes "nein" waere still
    ein JA. Der Schreibpfad ist die Stelle, an der das auffallen muss."""
    assert client.put("/api/settings", json={"ytdlp_auto": "nein"}).status_code == 400
    assert client.get("/api/settings").json()["ytdlp_auto"] == "1"


def test_settings_meldet_und_entfernt_die_beiseitegelegte_datei(client, tmp_path):
    """#192: die gerettete Fassung nuetzt nur, wenn die Oberflaeche sie erwaehnt — und der
    Hinweis braucht ein Ende, sonst steht er fuer immer da (der Pfad liegt im Benutzerprofil,
    und wer die App benutzt, raeumt dort nicht selbst auf)."""
    k = tmp_path / "settings.json.kaputt"
    k.write_bytes(b'{"api_key": "sk-GEHEIM-\xff"}')
    assert client.get("/api/settings").json()["kaputt"] == str(k)
    assert client.delete("/api/settings/kaputt").json() == {"ok": True, "kaputt": ""}
    assert not k.exists()
    assert client.get("/api/settings").json()["kaputt"] == ""
    # Zweimal geklickt (oder zwei Tabs offen) ist kein Serverfehler, sondern nichts zu tun.
    assert client.delete("/api/settings/kaputt").status_code == 404


def test_settings_ytdlp_merker_kommt_nicht_aus_dem_browser(client):
    """Der Merker ist Buchhaltung des Servers. Ein vom Browser gesetztes Datum in der
    Zukunft legte die Aktualisierung auf Jahre still."""
    client.put("/api/settings", json={"ytdlp_geprueft": "2099-01-01"})
    from webtool import settings as s
    assert s.load()["ytdlp_geprueft"] == ""


def test_ytdlp_update_knopf_kehrt_zurueck_WAEHREND_pip_noch_laeuft(client, monkeypatch):
    """#174 — der eigentliche Fix. Vorher haing der Request am pip-Lauf: >=340 s im
    schlimmsten Fall (220 s `sperre.frist` + 120 s eigenes pip), und so lange sieht die App
    fuer einen Nutzer aus wie abgestuerzt."""
    from webtool import ytdlp_update
    los = threading.Event()

    def langsam(*a):
        los.wait(5)
        # `aktualisiere()` liefert seit #236 `(ok, gehalten)` — die Attrappe auch, sonst
        # scheitert das Auspacken in `_im_hintergrund` und der Test waere gruen ueber einen
        # Fehler, den es im Programm nicht gibt.
        return True, True
    monkeypatch.setattr(ytdlp_update, "aktualisiere", langsam)
    # An der ECHTEN Grenze gepatcht (`importlib.metadata`), nicht an einer Funktion des
    # Moduls: `fassung` zu patchen lief seit #189 ins Leere (`zustand()` geht nicht mehr
    # dadurch), und eine private Funktion zu patchen entwertet den naechsten Umbau
    # genauso still. So wird `_fassung_und_lesbarkeit` wirklich ausgeuebt.
    monkeypatch.setattr(ytdlp_update.metadata, "version", lambda name: "2026.8.12")

    # Ein Ergebnis des VORIGEN Laufs — der neue Klick muss beides loeschen, sonst zeigt die
    # Seite waehrend des laufenden Laufs eine Warnung ueber einen Vorgang, den der Nutzer
    # gerade wiederholt. (`ergebnis` deckte das schon ab, `ungeschuetzt` war ungewacht.)
    ytdlp_update._lauf["ungeschuetzt"] = True

    r = client.post("/api/settings/ytdlp/update")
    assert r.status_code == 200 and r.json()["gestartet"] is True
    # DAS ist die Zusicherung: die Antwort ist da, waehrend der Lauf noch steht.
    assert r.json()["laeuft"] is True and r.json()["ergebnis"] == ""
    assert r.json()["ungeschuetzt"] is False

    los.set()
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])
    st = client.get("/api/settings").json()["ytdlp"]
    # Der Ausgang geht nicht verloren, er kommt nur spaeter — sonst haette der Umbau einen
    # haengenden Browser gegen einen stillen Fehlschlag getauscht.
    assert st["laeuft"] is False and st["ergebnis"] == "ok" and st["version"] == "2026.8.12"
    # Das Frontend liest `unlesbar` von hier, um bei einem Fehlschlag nicht "bist du
    # online?" zu raten (#189).
    assert st["unlesbar"] is False
    # Und der Normalfall von #236 — zugleich die Gegenprobe zum Test unten: eine Warnung, die
    # IMMER kommt, ist als Daueralarm derselbe Schaden von der anderen Seite.
    assert st["ungeschuetzt"] is False


def test_ytdlp_update_zweiter_klick_startet_keinen_zweiten_lauf(client, monkeypatch):
    """Zwei `pip install` auf dieselbe venv sind der Schaden, gegen den die Sperre gebaut
    ist — im selben Prozess faengt ihn dieser Riegel schon vorher ab. `gestartet: false`
    ist dabei KEIN Fehler, sondern 'haeng dich an den laufenden'."""
    from webtool import ytdlp_update
    los, laeufe = threading.Event(), []

    def langsam(*a):
        laeufe.append(1)
        los.wait(5)
        return True, True
    monkeypatch.setattr(ytdlp_update, "aktualisiere", langsam)

    assert client.post("/api/settings/ytdlp/update").json()["gestartet"] is True
    zweiter = client.post("/api/settings/ytdlp/update").json()
    assert zweiter["gestartet"] is False and zweiter["laeuft"] is True
    los.set()
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])
    assert laeufe == [1]


def test_ytdlp_update_fehlschlag_wird_gemeldet_statt_verschluckt(client, monkeypatch):
    """Offline ist ein Normalfall, kein Serverfehler — der Nutzer soll 'hat nicht
    geklappt' lesen, nicht einen roten Stacktrace und nicht: gar nichts."""
    from webtool import ytdlp_update
    monkeypatch.setattr(ytdlp_update, "aktualisiere", lambda *a: (False, True))
    assert client.post("/api/settings/ytdlp/update").json()["gestartet"] is True
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])
    assert client.get("/api/settings").json()["ytdlp"]["ergebnis"] == "fehler"


def test_ytdlp_update_meldet_einen_ungeschuetzten_lauf_bis_ins_frontend(client, monkeypatch):
    """#236: fail-open ist hier kein verlorener Einstellungswert (#192), sondern die
    Moeglichkeit zweier `pip install` in dieselbe venv — und der zweite Ausloeser sitzt im
    fetch-Subprozess. Die Protokollzeile aus `sperre.py` erreicht nur eine Konsole; die
    gepackte App hat keine, die jemand liest. Also traegt `zustand()` es mit.

    Erfolg UND Warnung zugleich, nicht statt dessen: ob pip durchlief und ob es dabei allein
    war, sind zwei Fragen — deshalb ein eigenes Feld statt eines dritten `ergebnis`-Wertes.
    """
    from webtool import ytdlp_update
    monkeypatch.setattr(ytdlp_update, "aktualisiere", lambda *a: (True, False))
    assert client.post("/api/settings/ytdlp/update").json()["gestartet"] is True
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])
    st = client.get("/api/settings").json()["ytdlp"]
    assert st["ergebnis"] == "ok" and st["ungeschuetzt"] is True


def test_ytdlp_ein_wurf_behauptet_NICHT_ungeschuetzt(client, monkeypatch):
    """Bei einem Wurf ist unbekannt, ob die Sperre hielt — und Unbekanntes meldet dieses
    Modul nicht (dieselbe Richtung wie `_ejs_untauglich`). Ein `ungeschuetzt: true` auf
    Verdacht schickte den Nutzer in eine Fehlersuche, fuer die es keinen Anlass gibt."""
    from webtool import ytdlp_update

    def wirft(*a):
        raise RuntimeError("kaputt")
    monkeypatch.setattr(ytdlp_update, "aktualisiere", wirft)
    client.post("/api/settings/ytdlp/update")
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])
    st = client.get("/api/settings").json()["ytdlp"]
    assert st["ergebnis"] == "fehler" and st["ungeschuetzt"] is False


def test_ytdlp_hintergrundlauf_gibt_den_knopf_auch_nach_einem_wurf_frei(client, monkeypatch):
    """`laeuft` MUSS auch dann zurueckfallen, wenn `aktualisiere()` wirft — sonst waere der
    Knopf bis zum Serverneustart tot, und zwar still."""
    from webtool import ytdlp_update

    def wirft(*a):
        raise RuntimeError("kaputt")
    monkeypatch.setattr(ytdlp_update, "aktualisiere", wirft)
    client.post("/api/settings/ytdlp/update")
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])
    assert client.get("/api/settings").json()["ytdlp"]["ergebnis"] == "fehler"
    # ... und ein neuer Klick geht wieder durch.
    monkeypatch.setattr(ytdlp_update, "aktualisiere", lambda *a: (True, True))
    assert client.post("/api/settings/ytdlp/update").json()["gestartet"] is True
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])


def test_ytdlp_hintergrundlauf_gibt_den_knopf_auch_nach_einem_BaseException_frei(
        client, monkeypatch):
    """Erst DIESER Test uebt das `finally` aus — der Test darueber nicht.

    Ein `RuntimeError` wird schon von `except Exception` gefangen; danach liefe der
    Ruecksetzcode auch als gewoehnliche Zeile darunter. Nachgemessen: die Mutation
    „`finally` -> normaler Block" liess den Test darueber **gruen**. Tragend ist das
    `finally` allein fuer `BaseException` — und dort haengt zugleich die Vorbelegung
    `ergebnis = "fehler"` (ohne sie ein NameError IM `finally`, also `laeuft` fuer immer
    True und der Knopf bis zum Serverneustart tot).
    """
    from webtool import ytdlp_update

    def wirft(*a):
        # SystemExit statt KeyboardInterrupt, weil `threading` ihn im Normalbetrieb
        # unterdrueckt. UNTER PYTEST gilt das nicht — es ersetzt `threading.excepthook`,
        # der Lauf meldet also eine `PytestUnhandledThreadExceptionWarning`. Genau daher
        # kommen die zwei Warnungen am Suitenende; kein Fehler, aber die urspruengliche
        # Begruendung („keine Testausgabe") stimmte nicht.
        raise SystemExit(1)
    monkeypatch.setattr(ytdlp_update, "aktualisiere", wirft)
    client.post("/api/settings/ytdlp/update")
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])
    assert client.get("/api/settings").json()["ytdlp"]["ergebnis"] == "fehler"


def test_ytdlp_ein_gescheiterter_fadenstart_sperrt_den_knopf_nicht_dauerhaft(
        client, monkeypatch):
    """Das `finally` in `_im_hintergrund` deckt den RUMPF, nicht den Start. Wirft
    `Thread.start()` (`can't start new thread`), bliebe `laeuft` sonst True — gemessen: der
    erste Klick 500, **jeder weitere** 200 mit `{gestartet: false, laeuft: true}`, womit die
    Warteschleife im Frontend endlos nachfragt und nie einen Toast zeigt. Dauerhaft, bis zum
    Serverneustart. Gefunden vom Reviewer-Subagenten an PR #223 (I2)."""
    from webtool import ytdlp_update

    class _Fadenlos:
        """Ersetzt NUR die Modulreferenz in `ytdlp_update`, nicht `threading.Thread`
        global — das globale Attribut zu patchen traefe auch die Faden-Verwaltung des
        TestClients. `monkeypatch.undo()` scheidet aus demselben Grund aus: es drehte die
        ganze Fixture mit zurueck (Projektpfad, Einstellungsdatei, Job-Attrappe)."""
        @staticmethod
        def Thread(*a, **k):
            raise RuntimeError("can't start new thread")

    monkeypatch.setattr(ytdlp_update, "aktualisiere", lambda *a: (True, True))
    monkeypatch.setattr(ytdlp_update, "threading", _Fadenlos)
    with pytest.raises(RuntimeError):
        client.post("/api/settings/ytdlp/update")
    assert ytdlp_update.hintergrund_zustand() == (False, "fehler", False)

    # Der entscheidende Teil: der naechste Klick geht wieder durch.
    monkeypatch.setattr(ytdlp_update, "threading", threading)
    assert client.post("/api/settings/ytdlp/update").json()["gestartet"] is True
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])


def test_ytdlp_ein_uebersprungener_lauf_meldet_der_seite_weder_ok_noch_fehler(
        client, monkeypatch):
    """Der Weg bis zum Nutzer, den der Reviewer an #254 Weg 3 gemessen hat: der Startlauf
    haengt an der Sperre, der Nutzer klickt, `gestartet:false` haengt seinen Poll an DIESEN
    Lauf — und der stellt unter der Sperre fest, dass ein anderer schneller war.

    `ok` haette „yt-dlp ist jetzt auf <alte Fassung>" gezeigt, `fehler` „bist du online?".
    Beides ist gelogen, und dieser Test ist die einzige Stelle, an der die ABBILDUNG bis zur
    Antwort geprueft wird — `test_ytdlp_update.py` pinnt nur den Rueckgabewert.
    """
    from webtool import ytdlp_update
    monkeypatch.setattr(ytdlp_update, "aktualisiere", lambda *a, **k: (None, False))
    monkeypatch.setattr(ytdlp_update.metadata, "version", lambda name: "2026.8.12")
    assert client.post("/api/settings/ytdlp/update").json()["gestartet"] is True
    assert _warte(lambda: not ytdlp_update.hintergrund_zustand()[0])
    st = client.get("/api/settings").json()["ytdlp"]
    assert st["ergebnis"] == "uebersprungen"
    # … und KEINE Sperrwarnung ueber ein pip, das nie lief — obwohl `gehalten` False war.
    assert st["ungeschuetzt"] is False


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
    monkeypatch.setattr(appmod.llm, "available", lambda *_a: (False, "kein claude"))
    monkeypatch.setattr(appmod.jobs, "request",
                        lambda *a, **k: gestartet.append(a) or ("id", True))
    appmod._autocorrect("Testprojekt")
    assert gestartet == []


def test_autocorrect_startet_mit_anbieter(client, monkeypatch):
    from webtool import app as appmod
    gestartet = []
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "1")
    monkeypatch.setattr(appmod.llm, "available", lambda *_a: (True, ""))
    monkeypatch.setattr(appmod.jobs, "request",
                        lambda *a, **k: gestartet.append(a) or ("id", True))
    appmod._autocorrect("Testprojekt")
    assert len(gestartet) == 1


def test_start_stoesst_die_ytdlp_kalenderpruefung_an(monkeypatch, tmp_path):
    """#253: die Vorsorge haengt am Serverstart, nicht mehr an `fetch._hole_yt_dlp()`.

    Der Gegenpart steht in `test_fetch.py`
    (`test_url_import_wartet_NICHT_mehr_auf_die_kalenderpruefung`): dort darf sie NICHT mehr
    laufen, hier MUSS sie. Ohne dieses Paar waere „verschoben" nicht von „ersatzlos entfernt"
    zu unterscheiden — und die Selbstaktualisierung waere still tot.

    **`TRANSKRIBOR_SETTINGS` ist Pflicht, obwohl der Test die `client`-Fixture bewusst nicht
    nimmt.** Das `with TestClient(app)` betritt seit #224 einen Lifespan-SHUTDOWN, der die
    echte `ytdlp_update.beim_ende()` ruft — ohne Umlenkung zeigte deren `_lockziel()` auf das
    Profil des Entwicklers. Heute folgenlos (`_lauf["laeuft"]` ist False, der Aufruf schliesst
    kurz), aber es ist dieselbe Familie, die bei #253 einen echten pip-Lauf gegen die
    Entwickler-venv gekostet hat: ein Test, der den Lifespan betritt, gehoert isoliert.
    """
    from webtool import app as appmod
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    gerufen = []
    monkeypatch.setattr(appmod.ytdlp_update, "beim_start",
                        lambda: gerufen.append(True) or False)
    with TestClient(appmod.app):
        pass
    assert gerufen == [True]


def test_shutdown_bricht_laufende_jobs_ab(client, monkeypatch):
    """Beim Beenden der App bekommt uvicorn ein SIGTERM — auf POSIX erreicht das die
    Job-Kinder nicht (eigene Sitzungen). Ohne diesen Haken laeuft whisper weiter."""
    from webtool import app as appmod
    gerufen = []
    monkeypatch.setattr(appmod.jobs, "cancel_all", lambda: gerufen.append(True) or [])
    with TestClient(appmod.app):
        pass                                   # Kontext verlassen -> lifespan-Shutdown
    assert gerufen == [True]


def test_shutdown_gibt_den_ytdlp_merker_auf(client, monkeypatch):
    """#224: laeuft die Selbstaktualisierung noch, ueberlebt ihr pip-Kind den Server (POSIX:
    SIGTERM erreicht nur uvicorn; in WSL gemessen). Ohne diesen Haken bleibt das Lock mit der
    PID des toten Halters liegen, der naechste Start raeumt es sofort ab und legt ein zweites
    `pip install` in dieselbe venv.

    Der Gegenpart ist `test_lifespan_stoesst_die_kalenderpruefung_an`: Start und Ende sind
    zwei Haelften desselben Vertrags, und nur die zweite kostet Datenintegritaet."""
    from webtool import app as appmod
    gerufen = []
    # `True`, damit der Meldezweig in `_lifespan` mitlaeuft statt unbeschrieben zu bleiben —
    # die Attrappe liefert sonst False und der `print` waere toter Code unter diesem Test.
    monkeypatch.setattr(appmod.ytdlp_update, "beim_ende",
                        lambda: gerufen.append(True) or True)
    with TestClient(appmod.app):
        pass                                   # Kontext verlassen -> lifespan-Shutdown
    assert gerufen == [True]


def test_settings_meldet_ai_ready(client, monkeypatch):
    from webtool import app as appmod
    monkeypatch.setattr(appmod.llm, "available", lambda *_a: (False, "kein claude"))
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


def test_dateieinstellungen_meldet_ob_diarisierung_laeuft(client, tmp_projekt, monkeypatch):
    """Ohne diese Auskunft zeigt der Dialog ein Feld an, das nichts tut (#266).

    BEIDE Richtungen, nicht nur die interessante: ein Feld, das IMMER „aus" meldet, ist
    derselbe Schaden von der anderen Seite — der Nutzer koennte die Sprecherzahl dann nie
    mehr setzen. Die Mutation „fest auf False" macht die erste Zusicherung rot.
    """
    monkeypatch.delenv("TRANSKRIBOR_DIARIZE", raising=False)
    r = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen")
    assert r.json()["diarisierung_aktiv"] is True

    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "0")
    r = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen")
    assert r.json()["diarisierung_aktiv"] is False


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


# --- Rueckweg auf "folgt dem Projekt" (#166) ---------------------------------

def test_dateieinstellungen_nennt_override_und_projektwert(client, tmp_projekt):
    """Drei Werte statt einem: aus dem effektiven allein ist "folgt dem Projekt" nicht von
    einem gleichlautenden Override zu unterscheiden — die Oberflaeche koennte den Rueckweg
    also weder anzeigen noch beschriften."""
    d = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen").json()
    assert d["mehrsprachig"] is False
    assert d["mehrsprachig_eigen"] is None          # nie angefasst -> folgt dem Projekt
    assert d["mehrsprachig_projekt"] is False
    # Dieselben drei Werte fuer die Sprache (#234). AM ENDPUNKT geprueft, nicht nur an
    # `datei_ansicht`: das Frontend haengt am Endpunkt, und ein vergessenes Feld im Handler
    # faellt an der Funktion darunter nicht auf.
    assert d["sprache_eigen"] is None
    assert d["sprache_projekt"] == d["sprache"] == "ch"


def test_dateieinstellungen_null_entfernt_den_override(client, tmp_projekt):
    """Der Kern von #166: `mehrsprachig: null` AUSDRUECKLICH gesendet heisst "Override weg".

    Unterschieden wird an `model_fields_set` — an der ANWESENHEIT des Schluessels im Rumpf,
    nicht an seinem Wert; im Modell sind beide Faelle `None`. Dasselbe Prinzip wie
    `"text": ""` in apply_correction."""
    import webtool.projekt as projekt
    client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"mehrsprachig": True})
    client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"mehrsprachig": False})
    assert projekt.datei_mehrsprachig(tmp_projekt, "S1") is False

    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"mehrsprachig": None})
    assert r.status_code == 200
    assert r.json()["mehrsprachig_eigen"] is None
    assert r.json()["mehrsprachig"] is True         # erbt jetzt wieder vom Projekt
    assert projekt.datei_override_mehrsprachig(tmp_projekt, "S1") is None


def test_projekt_PUT_mit_null_ist_ein_no_op(client, tmp_projekt):
    """Beide Endpunkte teilen sich `EinstellungenBody` — und `null` heisst dort VERSCHIEDENES:
    beim Datei-PUT "Override entfernen", beim Projekt-PUT nichts (das Projekt hat keinen zu
    erbenden Wert). Ein Waechter, weil ein Modell mit zwei Bedeutungen genau die Art
    Verwechslung ist, die beim naechsten Umbau still passiert.

    Seit #234 gilt das fuer ZWEI Felder — die Flaeche hat sich verdoppelt, der Waechter auch.
    """
    client.put(f"/api/projects/{tmp_projekt}/einstellungen",
               json={"mehrsprachig": True, "sprache": "en"})
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen",
                   json={"mehrsprachig": None, "sprache": None})
    assert r.status_code == 200
    assert r.json()["mehrsprachig"] is True         # unveraendert, nicht zurueckgesetzt
    assert r.json()["sprache"] == "en"


def test_dateieinstellungen_FEHLENDES_feld_laesst_den_override_stehen(client, tmp_projekt):
    """Die Gegenprobe — ohne sie waere ein `mehr = ERBEN` fuer JEDEN Aufruf gruen, und jedes
    Speichern der Sprache raeumte nebenbei den Mehrsprachig-Haken ab."""
    import webtool.projekt as projekt
    client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"mehrsprachig": True})
    client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprache": "en"})
    assert projekt.datei_override_mehrsprachig(tmp_projekt, "S1") is True


def test_dateieinstellungen_sprache_null_entfernt_den_override(client, tmp_projekt):
    """#234: derselbe Rueckweg fuer die Sprache. `sprache: null` AUSDRUECKLICH gesendet heisst
    „Override entfernen"; das Feld GAR NICHT zu senden laesst ihn stehen (der Test darunter).
    Unterschieden wird an `model_fields_set` — an der ANWESENHEIT des Schluessels, nicht an
    seinem Wert.

    Ohne diesen Weg war ein einmal geschriebener Sprach-Eintrag endgueltig, und der entstand
    beim Upload auch dann, wenn niemand die Auswahl angefasst hatte.
    """
    import webtool.projekt as projekt
    client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"sprache": "ch"})
    client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprache": "en"})
    assert projekt.datei_sprache(tmp_projekt, "S1") == "en"

    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprache": None})
    assert r.status_code == 200
    assert r.json()["sprache_eigen"] is None
    assert r.json()["sprache"] == "ch"              # erbt jetzt wieder vom Projekt
    # Und zieht mit — das ist die Eigenschaft, um die es geht, nicht der Momentanwert.
    client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"sprache": "fr"})
    assert projekt.datei_sprache(tmp_projekt, "S1") == "fr"


def test_dateieinstellungen_OHNE_sprache_laesst_den_sprach_override_stehen(client, tmp_projekt):
    """Die Gegenprobe zum Test darueber: waere `sprache = ERBEN` fuer JEDEN Aufruf gesetzt,
    raeumte jedes Speichern der Tiefe nebenbei die Sprache ab — und das faellt erst beim
    naechsten Transkriptionslauf auf."""
    import webtool.projekt as projekt
    client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprache": "en"})
    client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"korrektur": "leicht"})
    assert projekt.datei_ansicht(tmp_projekt, "S1")["sprache_eigen"] == "en"


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
    """422 von pydantic, NICHT 400 von sprachen.pruef_fehler — und das ist der Punkt.

    Anders als bei sprache/korrektur (#139, Werte gegen eine Liste) ist `mehrsprachig` ein
    bool: pydantic wandelt bzw. lehnt ab, BEVOR pruef_fehler den Wert je sieht. Die
    Typpruefung dort ist damit ueber HTTP unerreichbar; sie bleibt fuer direkte
    Python-Aufrufer (dafuer gibt es den ehrlichen Unit-Test in test_sprachen.py).

    Der Test stand vorher auf `in (400, 422)` und behauptete im Docstring eine 400 — er traf
    immer die 422 und blieb gruen, auch wenn man die Pruefung ganz entfernte (Mutationsprobe
    des Reviews: 8/8 weiter gruen). Ein Test, der Schutz behauptet, den es nicht gibt, ist
    schlimmer als keiner; deshalb steht jetzt exakt da, was der Endpunkt wirklich tut."""
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"mehrsprachig": "ja"})
    assert r.status_code == 422
    assert r.json()["detail"][0]["type"] == "bool_parsing"


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


def test_fetch_env_kennt_auch_den_ausgeschalteten_haken(client, tmp_projekt, monkeypatch):
    """Nur der true-Fall war geprueft. Ein Datei-Override auf FALSE ist aber genau der Fall,
    den es geben muss: eine einsprachige Datei in einem Projekt, dessen Standard true ist."""
    gesehen = {}
    from webtool import jobs
    monkeypatch.setattr(jobs, "start",
                        lambda *a, **k: (gesehen.update(k.get("env") or {}), ("j1", True))[1])
    client.post(f"/api/projects/{tmp_projekt}/fetch",
                json={"urls": ["https://youtu.be/x"], "mehrsprachig": False})
    assert gesehen.get("TRANSKRIBOR_FETCH_MEHRSPRACHIG") == "0"


# ---- #190: nicht dekodierbare Bytes sind KEIN JSONDecodeError ----

def test_nicht_dekodierbare_edit_json_heilt_sich_aus_der_roh_json(client, tmp_path):
    """`load_or_build_doc` faengt eine korrupte `edit.json` ab und baut aus der Roh-JSON neu
    auf. Das galt aber nur fuers PARSEN: sind die BYTES nicht als UTF-8 dekodierbar, wirft
    schon das Lesen einen `UnicodeDecodeError` — auch ein `ValueError`, aber kein
    `JSONDecodeError` (#190). Der Editor bekam dann 500 statt der Selbstheilung, und die
    Aufnahme war ueber die Oberflaeche nicht mehr zu oeffnen.

    `write_bytes`, nicht `write_text`: anders ist der Fall nicht herzustellen.
    """
    (tmp_path / "Demo" / "transkripte" / "S1.edit.json").write_bytes(b'{"summary": "\xe9"}')
    r = client.get("/api/projects/Demo/files/S1")
    assert r.status_code == 200
    assert r.json()["segments"][0]["text"].strip() == "Hallo Welt."   # aus der Roh-JSON


def test_selbstheilung_meldet_sich_und_nur_dann(client, tmp_path):
    """#197: die Heilung war STILL. Der Nutzer sah ein sauberes Transkript und hielt es fuer
    seines — die Korrekturen und Sprechernamen, an denen er gearbeitet hatte, fehlten darin.

    Die Gegenprobe gehoert dazu: ein Feld, das IMMER gesetzt ist, waere ein Daueralarm und
    damit dieselbe Nutzlosigkeit von der anderen Seite. Geprueft werden beide stillen Faelle —
    gar keine edit.json (frisch transkribiert) und eine gesunde."""
    e = tmp_path / "Demo" / "transkripte" / "S1.edit.json"
    assert "selbstgeheilt" not in client.get("/api/projects/Demo/files/S1").json()   # keine Datei
    doc = client.get("/api/projects/Demo/files/S1").json()
    client.put("/api/projects/Demo/files/S1", json=doc)                              # gesunde Datei
    assert "selbstgeheilt" not in client.get("/api/projects/Demo/files/S1").json()
    e.write_bytes(b'{"summary": "\xe9"}')
    assert client.get("/api/projects/Demo/files/S1").json()["selbstgeheilt"] == "UnicodeDecodeError"


def test_speichern_legt_die_unlesbare_edit_json_beiseite(client, tmp_path):
    """#197: der Schutz aus dem Korrekturlauf (unlesbar ⇒ gilt als handbearbeitet, #195) war
    nur AUFGESCHOBEN — bis zum ersten Oeffnen. Der Editor heilte still, und die naechste
    Autosave schrieb ueber die kaputten Bytes. Jetzt wandern sie zur Seite, wie bei
    settings.json (#192).

    Der Merker darf dabei NICHT in der Datei landen: geschrieben gaelte sie beim naechsten
    Oeffnen fuer immer als geheilt, und der Hinweis stuende dauerhaft im Editor."""
    e = tmp_path / "Demo" / "transkripte" / "S1.edit.json"
    roh = b'{"summary": "\xe9", "handarbeit": "eine Stunde"}'
    e.write_bytes(roh)
    doc = client.get("/api/projects/Demo/files/S1").json()
    assert client.put("/api/projects/Demo/files/S1", json=doc).status_code == 200
    assert (tmp_path / "Demo" / "transkripte" / "S1.edit.json.kaputt").read_bytes() == roh
    neu = json.loads(e.read_text(encoding="utf-8"))
    assert neu["human_edited"] is True and "selbstgeheilt" not in neu


def test_erfundener_merker_schiebt_keine_gesunde_datei_beiseite(client, tmp_path):
    """Der Merker ist ein HINWEIS, keine Anweisung — nachgesehen wird auf der Platte.

    Ohne die Pruefung schoebe ein erfundenes `selbstgeheilt` eine gesunde `edit.json` beiseite.
    Der Inhalt waere zwar nicht weg (die Kopie traegt ihn), aber der Platz waere belegt: die
    ERSTE Rettung gewinnt, eine spaetere echte Beschaedigung liesse sich also nicht mehr
    retten. Genau die Kette hat die CodeRabbit-CLI an PR #204 aufgezeigt."""
    e = tmp_path / "Demo" / "transkripte" / "S1.edit.json"
    doc = client.get("/api/projects/Demo/files/S1").json()
    client.put("/api/projects/Demo/files/S1", json=doc)               # gesunde Datei anlegen
    gesund = e.read_bytes()
    assert gesund                                                     # war wirklich etwas da
    # Seit #160 zaehlt der `dateistand`: der erste PUT hat die Datei angelegt, das Token aus
    # dem GET oben ist damit veraltet. Ein echter Client holt hier neu — ohne das pruefte der
    # Test unten die SPERRE (409) statt des Merkers und waere vacuous.
    doc = client.get("/api/projects/Demo/files/S1").json()
    r = client.put("/api/projects/Demo/files/S1", json={**doc, "selbstgeheilt": "erfunden"})
    # Der zweite PUT muss GELUNGEN sein, sonst prueft alles darunter nur die Datei aus dem
    # ersten (CodeRabbit an PR #204) — ein 400/500 haette den Test gruen gelassen.
    assert r.status_code == 200, r.text
    assert not (tmp_path / "Demo" / "transkripte" / "S1.edit.json.kaputt").exists()
    # Byte-gleich: weder verschoben noch veraendert. Der Merker faellt beim Schreiben weg,
    # also muss dasselbe Dokument dastehen wie nach dem ersten PUT.
    assert e.read_bytes() == gesund


def test_get_liefert_immer_einen_dateistand(client, tmp_path):
    """#160: der `dateistand` ist die Grundlage des optimistischen Sperrens — fehlt er im GET,
    schickt der Client nichts mit, und der PUT schreibt OHNE VORBEHALT. Die Sperre waere damit
    still abgeschaltet, ohne dass irgendetwas rot wuerde.

    Dieser Waechter gehoert ins pytest und NICHT ins vitest: die Frontend-Attrappe von `getDoc`
    liefert ein Objekt, das wir selbst schreiben — sie wuerde den Vertrag also selbst behaupten.
    Genau die Luecke aus #239.

    Beide Wege muessen liefern: die gebaute Fassung (noch keine edit.json) und die gelesene."""
    ohne = client.get("/api/projects/Demo/files/S1").json()
    assert ohne["dateistand"] == "", "ohne edit.json ist der Stand die leere Zeichenkette"
    client.put("/api/projects/Demo/files/S1", json=ohne)
    mit = client.get("/api/projects/Demo/files/S1").json()
    assert mit["dateistand"], "mit edit.json muss ein Stand geliefert werden"
    assert (tmp_path / "Demo" / "transkripte" / "S1.edit.json").exists()


def test_zwei_schreibvorgaenge_gleicher_groesse_haben_verschiedene_staende(client, tmp_path):
    """Der Stand muss sich bei JEDEM Schreibvorgang aendern — sonst laesst die Sperre einen
    veralteten PUT durch, und zwar lautlos.

    `st_mtime_ns` ist die Breite des FELDES, nicht die Aufloesung des Dateisystems: auf NTFS
    liegt der kleinste Schritt ueber `atomic_write` bei rund einer Millisekunde. Gemessen an
    400 dichten Schreibvorgaengen gleicher Groesse: **237 Kollisionen** ohne `st_ino`, **null**
    mit. Genau diesen Fall stellt der Test her — gleiche Groesse, unmittelbar nacheinander."""
    from webtool import paths as _paths, app as app_mod
    e = str(tmp_path / "Demo" / "transkripte" / "S1.edit.json")
    staende = set()
    for i in range(30):
        _paths.atomic_write(e, json.dumps({"summary": f"{i:03d}", "segments": []}))
        staende.add(app_mod._dateistand(e))
    assert len(staende) == 30, f"nur {len(staende)} verschiedene Staende aus 30 Schreibvorgaengen"
    # UND die Zusicherung direkt am Feld. Die Zeile darueber allein waere auf einem
    # Dateisystem mit feiner Zeitaufloesung (ext4, tmpfs — also der CI) VACUOUS: dort
    # liefert `st_mtime_ns` schon fuer sich 30 verschiedene Werte, und die Mutation
    # „st_ino raus" bliebe gruen. Gemessen wurde die Kollision auf NTFS; der Waechter
    # muss auf jedem Laeufer fallen.
    assert str(os.stat(e).st_ino) in app_mod._dateistand(e), "st_ino fehlt im Stand"


def test_nicht_ermittelbarer_stand_gilt_nicht_als_fehlende_datei(client, tmp_path, monkeypatch):
    """Rueckfallrichtung: „nicht ermittelbar" darf NICHT zu „nicht geschuetzt" werden.

    `except OSError` deckte auch `PermissionError` und `EIO` — und machte daraus `""`, also
    „die Datei gibt es nicht". Ein Client mit `""` haette dann gegen eine vorhandene, nur
    gerade nicht abfragbare Datei verglichen, keine Abweichung gefunden und darueber
    geschrieben. Dieselbe Regel wie bei `_is_human_edited`: wer die Zusage nicht LESEN kann,
    darf sie nicht ueberschreiben."""
    from webtool import app as app_mod
    e = str(tmp_path / "Demo" / "transkripte" / "S1.edit.json")
    doc = client.get("/api/projects/Demo/files/S1").json()
    client.put("/api/projects/Demo/files/S1", json=doc)          # Datei existiert wirklich
    assert app_mod._dateistand(e)                                 # Positivkontrolle

    echt = os.stat

    def sperrig(pfad, *a, **kw):
        if str(pfad).endswith("S1.edit.json"):
            raise PermissionError(13, "Zugriff verweigert")
        return echt(pfad, *a, **kw)

    monkeypatch.setattr(app_mod.os, "stat", sperrig)
    with pytest.raises(PermissionError):
        app_mod._dateistand(e)


def test_pruefung_und_schreiben_liegen_unter_EINER_sperre(client, tmp_path, monkeypatch):
    """Ohne die gemeinsame Sperre bleibt #160 als schmales Fenster offen.

    Zwischen `_dateistand()` und `atomic_write()` liegen ein `json.dumps` des ganzen Dokuments
    und ein vollstaendiges `render_md` — bei einem langen Transkript Millisekunden. Landet
    `correct.cmd_apply` genau darin, hat der Vergleich schon zugestimmt und der Schreibvorgang
    ueberbuegelt die frische Korrektur.

    Geprueft wird an `render_md`, weil das die LETZTE Station vor dem zweiten Schreibvorgang
    ist: haelt die Sperre dort noch, umschliesst sie den ganzen Abschnitt. Eine Zeitmessung
    waere die schlechtere Probe (sie belegte Gleichzeitigkeit, nicht die Sperre)."""
    from webtool import app as app_mod
    epath = str(tmp_path / "Demo" / "transkripte" / "S1.edit.json")
    gehalten = []
    echt = app_mod.render_md
    # Direkt am Lock-Verzeichnis, NICHT ueber `sperre.wird_gehalten`: das geht durch die
    # vierstufige Lebendpruefung (#175/#243) und liefert im vollen Suite-Lauf `False`, weil
    # ein anderer Test die Lebendpruefung faelscht — der Waechter haette dann gemeldet, was
    # die Nachbartests tun, nicht was dieser Code tut. Sein eigener Docstring sagt ausserdem:
    # „fuer eine ANZEIGE, nie fuer eine Entscheidung".
    monkeypatch.setattr(app_mod, "render_md",
                        lambda d: (gehalten.append(os.path.isdir(epath + ".lock")), echt(d))[1])
    doc = client.get("/api/projects/Demo/files/S1").json()
    assert client.put("/api/projects/Demo/files/S1", json=doc).status_code == 200
    assert gehalten == [True], f"Sperre waehrend des Schreibens: {gehalten}"
    # Gegenprobe: danach ist sie wieder frei — eine Sperre, die haengenbleibt, waere ein
    # anderer Schaden (jeder weitere Schreiber wartete seine Frist ab).
    assert not os.path.isdir(epath + ".lock")


def test_correct_apply_nimmt_dieselbe_sperre(tmp_path, monkeypatch):
    """Eine Sperre wirkt nur, wenn ALLE Schreiber sie nehmen (dieselbe Regel wie bei
    `settings.save`). `correct.cmd_apply` ist der zweite Schreiber der `edit.json` — und der,
    gegen den der Editor ueberhaupt gesperrt wird."""
    from webtool import correct as correct_mod
    tdir = tmp_path / "P" / "transkripte"
    tdir.mkdir(parents=True)
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    (tdir / "S1.json").write_text(json.dumps(
        {"language": "de", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "roh",
                                         "words": []}]}), encoding="utf-8")
    (tdir / "S1.correction.json").write_text(json.dumps(
        {"segments": [{"id": 0, "text": "korrigiert", "speaker": "A"}]}), encoding="utf-8")
    epath = str(tdir / "S1.edit.json")
    gehalten = []
    echt = correct_mod.render_md
    monkeypatch.setattr(correct_mod, "render_md",
                        lambda d: (gehalten.append(os.path.isdir(epath + ".lock")), echt(d))[1])
    assert correct_mod.cmd_apply("P", "S1") == "written"
    assert gehalten == [True], f"Sperre waehrend des Schreibens: {gehalten}"


def test_apply_prueft_handarbeit_ERNEUT_unter_der_sperre(tmp_path, monkeypatch):
    """Der Spiegel des Fensters aus #160 — und der groessere von beiden.

    `cmd_apply` prueft `human_edited` am Anfang; dazwischen liegen das Laden der Korrektur,
    `apply_correction` ueber ALLE Segmente und `render_md` — auf einem langen Transkript
    hunderte Millisekunden. Der Editor speichert 800 ms nach der letzten Tipppause: wer
    waehrend eines Korrekturlaufs arbeitet, setzt `human_edited` genau in dieses Fenster.
    Ohne die zweite Pruefung loescht der Schreibvorgang seine Handarbeit — und meldet dabei
    Erfolg.

    Eingeworfen wird an `apply_correction` — der teuersten Station ZWISCHEN erster Pruefung
    und Sperre. `render_md` waere zu spaet: es wird erst als Argument des ZWEITEN
    Schreibvorgangs ausgewertet, die `edit.json` ist dann laengst ueberschrieben. (Der erste
    Anlauf dieses Tests hing genau dort und wurde deshalb rot — die richtige Art, es zu
    merken.)"""
    from webtool import correct as correct_mod
    tdir = tmp_path / "P" / "transkripte"
    tdir.mkdir(parents=True)
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    (tdir / "S1.json").write_text(json.dumps(
        {"language": "de", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "roh",
                                         "words": []}]}), encoding="utf-8")
    (tdir / "S1.correction.json").write_text(json.dumps(
        {"segments": [{"id": 0, "text": "von der Maschine", "speaker": "A"}]}), encoding="utf-8")
    epath = tdir / "S1.edit.json"
    handarbeit = json.dumps({"human_edited": True, "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": "VON HAND", "speaker": "Ich"}]})

    echt = correct_mod.apply_correction

    def dazwischen(*a, **kw):
        # Genau hier tippt der Nutzer und der Editor speichert — nach der ersten Pruefung,
        # vor der Sperre.
        epath.write_text(handarbeit, encoding="utf-8")
        return echt(*a, **kw)

    monkeypatch.setattr(correct_mod, "apply_correction", dazwischen)
    assert correct_mod.cmd_apply("P", "S1") == "skipped"
    assert epath.read_text(encoding="utf-8") == handarbeit, "Handarbeit wurde ueberschrieben"
    assert not (tdir / "S1.md").exists(), "der Export haette die Handarbeit ueberschrieben"


def test_apply_mit_force_schreibt_auch_unter_der_sperre(tmp_path, monkeypatch):
    """Gegenprobe: die zweite Pruefung darf `--force` nicht aushebeln — sonst waere
    „Neu korrigieren" im Menue tot, sobald jemand die Datei je angefasst hat.

    **`human_edited` steht hier VOR dem Lauf, nicht mittendrin — und das ist Absicht.** Die
    CodeRabbit-CLI schlug vor, es wie im Nachbartest waehrend `apply_correction` zu setzen,
    damit „die erneute Pruefung erreicht wird". Nachgemessen ist das nicht noetig: mit
    `force=True` ueberspringt die ERSTE Pruefung die Datei ohnehin
    (`if os.path.exists(epath) and not force`), das vorab gesetzte Flag sieht also
    ausschliesslich die zweite. Die Mutation aus dem Befund — Force-Ausnahme nur an der
    zweiten Pruefung entfernen — macht diesen Test bereits rot (gemessen). Der Vorschlag
    haette den Test seinem Nachbarn aehnlicher gemacht, ohne Abdeckung zu gewinnen."""
    from webtool import correct as correct_mod
    tdir = tmp_path / "P" / "transkripte"
    tdir.mkdir(parents=True)
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    (tdir / "S1.json").write_text(json.dumps(
        {"language": "de", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "roh",
                                         "words": []}]}), encoding="utf-8")
    (tdir / "S1.correction.json").write_text(json.dumps(
        {"segments": [{"id": 0, "text": "von der Maschine", "speaker": "A"}]}), encoding="utf-8")
    (tdir / "S1.edit.json").write_text(json.dumps({"human_edited": True, "segments": []}),
                                       encoding="utf-8")
    assert correct_mod.cmd_apply("P", "S1", force=True) == "written"
    assert "von der Maschine" in (tdir / "S1.edit.json").read_text(encoding="utf-8")


def test_veralteter_dateistand_wird_abgelehnt(client, tmp_path):
    """Der Kern von #160: der Editor speichert 800 ms nach dem letzten Tastendruck. Wird eine
    Korrektur fertig, waehrend der PUT schon unterwegs ist, landet er DANACH und ersetzt die
    frische edit.json — ein kompletter Korrekturlauf weg, ohne eine Zeile im Protokoll.

    Nachgestellt wird der fremde Schreiber (`correct.cmd_apply`, eigener Prozess) durch
    direktes Schreiben der Datei."""
    e = tmp_path / "Demo" / "transkripte" / "S1.edit.json"
    doc = client.get("/api/projects/Demo/files/S1").json()
    client.put("/api/projects/Demo/files/S1", json=doc)
    alt = client.get("/api/projects/Demo/files/S1").json()      # Stand, den der Editor haelt

    korrektur = json.dumps({**doc, "summary": "frisch korrigiert, viel laengerer Text als zuvor",
                            "human_edited": False}, ensure_ascii=False)
    e.write_text(korrektur, encoding="utf-8")
    # Positivkontrolle IM Test: waere der Stand unveraendert, pruefte die Zeile darunter nichts.
    assert client.get("/api/projects/Demo/files/S1").json()["dateistand"] != alt["dateistand"]

    r = client.put("/api/projects/Demo/files/S1", json=alt)
    assert r.status_code == 409, r.text
    # Und die Korrektur steht noch da — darum geht es, nicht um den Statuscode.
    assert e.read_text(encoding="utf-8") == korrektur


def test_dateistand_leer_schuetzt_die_frisch_angelegte_datei(client, tmp_path):
    """Die andere Haelfte von #160, die eine blosse „egal wenn leer"-Regel offen liesse: der
    Editor steht auf einer Datei OHNE edit.json (frisch transkribiert), und der Korrekturlauf
    legt sie waehrenddessen an. Der Stand `""` ist deshalb eine ECHTE Erwartung."""
    e = tmp_path / "Demo" / "transkripte" / "S1.edit.json"
    doc = client.get("/api/projects/Demo/files/S1").json()
    assert doc["dateistand"] == ""
    e.write_text(json.dumps({**doc, "summary": "vom Korrekturlauf angelegt"}), encoding="utf-8")
    assert client.put("/api/projects/Demo/files/S1", json=doc).status_code == 409


def test_ohne_dateistand_schreibt_ohne_vorbehalt(client, tmp_path):
    """Unterschieden wird am SCHLUESSEL, nicht am Wert — dieselbe Regel wie `"text": ""` in
    `apply_correction`.

    Zwei Dinge haengen daran: `curl` und jeder Nicht-Browser-Aufrufer laufen unveraendert
    weiter, UND es ist der Weg fuers bewusste Ueberschreiben. Waehlt der Nutzer im Editor
    „meine Fassung behalten", schickt der Client das Feld nicht mehr mit. Ein eigenes
    Kraft-Flag waere ein zweiter Schalter fuer dieselbe Aussage — und einer, der
    haengenbleiben kann."""
    e = tmp_path / "Demo" / "transkripte" / "S1.edit.json"
    doc = client.get("/api/projects/Demo/files/S1").json()
    client.put("/api/projects/Demo/files/S1", json=doc)
    e.write_text(json.dumps({**doc, "summary": "fremd"}), encoding="utf-8")   # Stand veraltet
    ohne = {k: v for k, v in doc.items() if k != "dateistand"}
    r = client.put("/api/projects/Demo/files/S1", json=ohne)
    assert r.status_code == 200, r.text
    assert "fremd" not in e.read_text(encoding="utf-8")       # bewusst ueberschrieben


def test_dateistand_landet_nicht_in_der_datei(client, tmp_path):
    """`pop`, nicht `get` — dieselbe Regel wie bei `selbstgeheilt`. Geschrieben stuende das
    Token in der Datei, deren Zustand es beschreibt: der naechste GET liefert dann einen Stand
    aus der Datei UND einen daneben, und welcher gilt, haengt an der Reihenfolge im dict."""
    e = tmp_path / "Demo" / "transkripte" / "S1.edit.json"
    doc = client.get("/api/projects/Demo/files/S1").json()
    assert client.put("/api/projects/Demo/files/S1", json=doc).status_code == 200
    assert "dateistand" not in json.loads(e.read_text(encoding="utf-8"))


def test_antwort_traegt_den_neuen_dateistand(client):
    """Ohne den Rueckgabewert liefe der NAECHSTE Autosave gegen die eigene Schreibung von
    gerade eben: die Sperre schluege bei jedem zweiten Speichern zu, ohne dass ein fremder
    Schreiber beteiligt waere. Zwei Speichervorgaenge hintereinander sind der Normalfall
    (jede Tipppause einer), also wird genau das geprueft."""
    doc = client.get("/api/projects/Demo/files/S1").json()
    erste = client.put("/api/projects/Demo/files/S1", json=doc)
    assert erste.status_code == 200
    neu = erste.json()["dateistand"]
    assert neu and neu != doc["dateistand"]
    zweite = client.put("/api/projects/Demo/files/S1", json={**doc, "dateistand": neu})
    assert zweite.status_code == 200, zweite.text


def test_abgelehnter_put_legt_nichts_beiseite(client, tmp_path):
    """Die Reihenfolge im Handler ist tragend: der `selbstgeheilt`-Zweig hat einen
    SEITENEFFEKT (`paths.beiseitelegen`), und die erste Rettung gewinnt — ein abgelehnter
    Schreibvorgang, der den Platz belegt, machte eine spaetere echte Beschaedigung
    unrettbar. Steht die Stand-Pruefung hinter dem Zweig, passiert genau das."""
    e = tmp_path / "Demo" / "transkripte" / "S1.edit.json"
    doc = client.get("/api/projects/Demo/files/S1").json()
    e.write_bytes(b'{"summary": "\xe9"}')                       # unlesbar UND Stand veraltet
    r = client.put("/api/projects/Demo/files/S1",
                   json={**doc, "selbstgeheilt": "UnicodeDecodeError"})
    assert r.status_code == 409, r.text
    assert not (tmp_path / "Demo" / "transkripte" / "S1.edit.json.kaputt").exists()


def test_speichern_lehnt_ein_nicht_objekt_ab(client):
    """Trust-Boundary: ein JSON-Array kam bis zum `doc["human_edited"] = True` durch und
    endete als 500 (TypeError). Die Schreibseite braucht dieselbe Wache wie `_json_objekt`
    beim Lesen."""
    r = client.put("/api/projects/Demo/files/S1", json=["kein Objekt"])
    assert r.status_code == 400
    assert "JSON-Objekt" in r.json()["detail"]


def test_umbenennen_ueberlebt_eine_nicht_dekodierbare_edit_json(client, tmp_path):
    """`_doc_felder` zieht `base`/`audio` im Dokument nach. Ist die Datei kaputt,
    bleibt sie unangetastet — das Umbenennen der Dateien auf der Platte ist der wichtigere
    Teil und darf daran nicht scheitern. Auch das galt nur fuers Parsen (#190): ein
    `UnicodeDecodeError` machte aus dem Umbenennen einen 500 — und zwar NACH dem
    `os.rename`, die Dateien waeren also schon umbenannt und der Aufrufer saehe einen Fehler.
    """
    t = tmp_path / "Demo" / "transkripte"
    roh = b'{"base": "S1", "summary": "\xe9"}'
    (t / "S1.edit.json").write_bytes(roh)
    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "Neu"})
    assert r.status_code == 200, r.text
    assert (t / "Neu.edit.json").exists() and not (t / "S1.edit.json").exists()
    assert (tmp_path / "Demo" / "audio" / "Neu.mp3").exists()
    # "unangetastet" muss auch geprueft werden: mit einer falschen Richtung (Datei mit
    # Defaults ueberbuegeln) blieben die drei Zeilen darueber gruen.
    assert (t / "Neu.edit.json").read_bytes() == roh


def test_umbenennen_ueberlebt_ein_nicht_schreibbares_dokument(client, tmp_path, capsys):
    """Die Lesehaelfte allein reicht nicht: ein einzelnes Surrogat kommt durch `json.load`
    und stirbt erst in `json.dumps`/`atomic_write` (UnicodeEncodeError — auch ein
    ValueError). Diese Stelle laeuft NACH dem `os.rename`, ein Wurf meldete dem Aufrufer
    also einen Fehler fuer ein bereits erledigtes Umbenennen."""
    t = tmp_path / "Demo" / "transkripte"
    roh = b'{"base": "S1", "summary": "\\ud800"}'
    (t / "S1.edit.json").write_bytes(roh)
    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "Neu"})
    assert r.status_code == 200, r.text
    assert (t / "Neu.edit.json").exists()
    # Nicht nur "existiert": ein `atomic_write`, das die Datei vor dem Fehler anfasst oder
    # kuerzt, bliebe sonst unbemerkt. Heute stirbt `json.dumps` VOR jedem Schreibvorgang —
    # genau das nagelt diese Zeile fest (CodeRabbit an PR #195).
    assert (t / "Neu.edit.json").read_bytes() == roh
    assert "nicht nachgezogen" in capsys.readouterr().out


def test_edit_json_ohne_objekt_heilt_sich_ebenfalls(client, tmp_path, capsys):
    """Gueltiges JSON ist noch lange kein Dokument. Eine Liste kam durch `json.load` und
    starb erst am `.get`/`.update` des Aufrufers — mit AttributeError, also an den
    #190-Rueckfaellen VORBEI. Gemessen: `GET …/files/S1` lieferte 200 mit `["kein Objekt"]`
    (der Editor bekam eine Liste statt eines Dokuments), und das Umbenennen endete mit 500
    NACH dem `os.rename` — die Dateien waren also schon umbenannt.

    Gefunden vom CodeRabbit-Bot an PR #195 (Merge Risk), am laufenden Code nachgemessen."""
    t = tmp_path / "Demo" / "transkripte"
    (t / "S1.edit.json").write_text('["kein Objekt"]', encoding="utf-8")
    doc = client.get("/api/projects/Demo/files/S1").json()
    assert isinstance(doc, dict)                              # aus der Roh-JSON geheilt
    assert doc["segments"][0]["text"].strip() == "Hallo Welt."
    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "Neu"})
    assert r.status_code == 200, r.text                       # kein 500 nach dem Umbenennen
    assert (t / "Neu.edit.json").exists()
    assert "nicht nachgezogen" in capsys.readouterr().out


def test_verschwundene_edit_json_faellt_auf_die_roh_json(client, tmp_path, monkeypatch):
    """Zwischen `os.path.exists` und dem `open` liegt ein Fenster: `_datei_weg` (Loeschen,
    Neu-Transkribieren) raeumt die edit.json weg, waehrend ein offener Editor pollt. Der
    `FileNotFoundError` ist ein OSError, kein ValueError — er fiel also an der Selbstheilung
    vorbei und gab 500. Das Rennen wird hier deterministisch gestellt: `exists` sagt ja, die
    Datei ist trotzdem nicht da (CodeRabbit-CLI an PR #195)."""
    from webtool import app as app_mod
    echt = app_mod.os.path.exists
    monkeypatch.setattr(app_mod.os.path, "exists",
                        lambda p: True if p.endswith("S1.edit.json") else echt(p))
    r = client.get("/api/projects/Demo/files/S1")
    assert r.status_code == 200, r.text
    assert r.json()["segments"][0]["text"].strip() == "Hallo Welt."


def test_kaputte_roh_json_meldet_die_datei_statt_eines_tracebacks(client, tmp_path):
    """Fuer die Roh-JSON gibt es KEINEN Rueckfall — sie ist die Quelle, aus der die
    Selbstheilung baut. 500 bleibt also richtig; ohne Namen war es aber ein
    AttributeError-Traceback aus `build_edit_doc` (gueltiges JSON, nur kein Objekt), und der
    Nutzer las "Internal Server Error", ohne zu erfahren, welche Datei kaputt ist.
    Gefunden ueber den Merge-Risk-Hinweis des CodeRabbit-Bots an PR #195."""
    (tmp_path / "Demo" / "transkripte" / "S1.json").write_text('["kein Objekt"]', encoding="utf-8")
    r = client.get("/api/projects/Demo/files/S1")
    assert r.status_code == 500
    assert "Roh-Transkript unlesbar: S1" in r.json()["detail"]


# ---- Sprecheranzahl fuer die Diarisierung (#264) ----

def test_datei_einstellungen_speichern_und_zuruecksetzen_der_sprecherzahl(client, tmp_projekt):
    """Der Weg, den Marcus geht: Zahl eintragen, sie steht im GET, und sie laesst sich wieder
    auf automatisch stellen. `null` ist der Rueckweg — ohne ihn bliebe eine einmal getippte
    Zahl fuer immer stehen."""
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprecher": 5})
    assert r.status_code == 200 and r.json()["sprecher"] == 5
    assert client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen").json()["sprecher"] == 5
    # Partial-Update: ein PUT ohne das Feld laesst die Zahl stehen
    client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprache": "de"})
    assert client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen").json()["sprecher"] == 5
    # ausdrueckliches null -> wieder automatisch
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprecher": None})
    assert r.status_code == 200 and r.json()["sprecher"] is None


@pytest.mark.parametrize("wert", [0, -1, 21])
def test_sprecherzahl_ausserhalb_des_bereichs_wird_mit_400_abgewiesen(client, tmp_projekt, wert):
    """Der Wert geht ungefiltert an pyannote — eine dreistellige Zahl kostet GPU-Zeit fuer ein
    Ergebnis, das niemand wollte. 400 (nicht 422) wie die uebrigen Wertfehler in denselben
    Handlern; die Meldung nennt das Feld."""
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprecher": wert})
    assert r.status_code == 400, f"{wert!r} haette abgewiesen werden muessen"
    assert "sprecher" in str(r.json()["detail"])


@pytest.mark.parametrize("wert", [2.5, "vier", True, "5"])
def test_sprecherzahl_vom_falschen_TYP_wird_mit_422_abgewiesen(client, tmp_projekt, wert):
    """Zwei Schichten, zwei Codes: den TYP weist Pydantic ab (422), bevor `pruef_fehler`
    ueberhaupt laeuft — den WERTEBEREICH danach der Handler (400). Der Test haelt die
    Aufteilung fest, damit sie nicht fuer einen Fehler gehalten wird.

    `True` ist der Grund fuer `StrictInt`: mit dem blossen `int` wandelt Pydantic es nach `1`
    um (bool ist eine int-Subklasse), der Haken landete als "1 Sprecher" in der Datei — und
    `projekt._sprecher_wert` verwirft denselben Wert. Gemessen: ohne StrictInt antwortet
    dieser Fall mit 200."""
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprecher": wert})
    assert r.status_code == 422, f"{wert!r} haette abgewiesen werden muessen"
    # und nichts davon ist in der Datei gelandet
    assert client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen").json()["sprecher"] is None


def test_projekt_endpunkt_kennt_die_sprecherzahl_NICHT(client, tmp_projekt):
    """Die Sprecherzahl ist eine Eigenschaft der Aufnahme, nicht des Projekts (2er-Interviews
    stehen neben einem 5er-Team). Ein Projekt-Standard waere fuer fast jede Datei falsch und
    erzwaenge dort STILL eine falsche Zahl — `num_speakers` ist exakt, nicht eine Obergrenze.
    Der Waechter haelt fest, dass das Feld nicht durch die Hintertuer des geteilten
    Body-Modells doch noch auf Projektebene landet und dort schweigend wirkungslos ist."""
    r = client.put(f"/api/projects/{tmp_projekt}/einstellungen", json={"sprache": "de", "sprecher": 5})
    assert r.status_code == 200                     # unbekanntes Feld: ignoriert wie jedes andere
    assert "sprecher" not in r.json()
    assert client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen").json()["sprecher"] is None
    # DAS ist die beobachtbare Differenz — und ohne sie war der Test Dekoration: dass das Feld
    # nicht in `projekt.json` landet, gilt AUCH mit `sprecher` im geteilten Modell (der Handler
    # baut sein Dict explizit, `speichern` filtert nach Schluesseln). Im Review gemessen: die
    # Mutation liess 215 Tests gruen. Woran man sie sieht, ist die VALIDIERUNG — ein Modell mit
    # dem Feld antwortete hier 422 statt 200.
    assert client.put(f"/api/projects/{tmp_projekt}/einstellungen",
                      json={"sprecher": "keine Zahl"}).status_code == 200
