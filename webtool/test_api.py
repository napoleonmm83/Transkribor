import json
import errno
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
    # Aus demselben Grund, eine Variable weiter: `job_env()` laesst eine gesetzte
    # TRANSKRIBOR_PARALLEL gegen die Einstellungsdatei gewinnen, und `parallel_env` im
    # Einstellungs-Rumpf meldet genau das. Eine Zeile in der `.env` des Entwicklers
    # entschiede sonst ueber `test_settings_modellwechsel_behaelt_den_key`.
    monkeypatch.delenv("TRANSKRIBOR_PARALLEL", raising=False)
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
    assert "Demo" in calls["cmd"] and calls["cmd"][1].endswith("transcribe.py")
    assert "--autocorrect" in calls["cmd"]


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
    def fake_start(project, cmd, cwd, kind, **kw):
        calls["cmd"] = cmd
        calls["kind"] = kind
        calls["project"] = project
        calls["base"] = kw.get("base")
        return "cf1", True
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "start", fake_start)
    r = client.post("/api/projects/Demo/files/S1/correct")
    assert r.status_code == 200 and r.json() == {"job_id": "cf1", "started": True}
    assert calls["kind"] == "correct" and calls["project"] == "Demo"
    assert calls["base"] == "S1"
    assert calls["cmd"][-3:] == ["run", "Demo", "S1"]         # base im Scope, kein --force
    # force=true -> --force ans Ende
    r2 = client.post("/api/projects/Demo/files/S1/correct", params={"force": "true"})
    assert r2.status_code == 200
    assert calls["cmd"][-1] == "--force" and calls["cmd"][-4:-1] == ["run", "Demo", "S1"]
    assert calls["base"] == "S1"


def test_correct_file_unknown_base_404(client):
    assert client.post("/api/projects/Demo/files/nope/correct").status_code == 404


def test_correct_file_invalid_name_400(client):
    assert client.post("/api/projects/Demo/files/a:b/correct").status_code == 400


def test_correct_file_409_waehrend_der_lauf_die_datei_schreibt(client, monkeypatch, mit_anbieter):
    """#441, Einzeldatei-Haelfte: seit der gestaffelten Pipeline (v0.48.0) korrigiert der
    transcribe-Job selbst mit, und die Job-Dedupe je (Projekt, Art) sieht den Konflikt
    zwischen "transcribe" und "correct" nicht — zwei Schreiber auf derselben edit.json.
    Gesperrt wird nur, WAHREND die Datei aktiv geschrieben wird ([active] … [done],
    active_only=True): der vorgesehene Parallelweg mit TRANSKRIBOR_AUTOCORRECT=0 —
    neben einer laufenden Transkription korrigieren — bleibt frei."""
    import webtool.jobs as jobs_mod
    jid = "t441"
    # Echter Registry-Eintrag statt betrifft-Attrappe: der Test soll die Trennung
    # messen, die active_only verspricht, nicht eine Kopie ihrer Behauptung.
    jobs_mod._active[("Demo", "transcribe")] = jid
    jobs_mod._jobs[jid] = {"id": jid, "kind": "transcribe", "status": "running",
                           "bases": None, "active_bases": {"S1"}}
    try:
        r = client.post("/api/projects/Demo/files/S1/correct")
        assert r.status_code == 409
        assert "gerade bearbeitet" in r.json()["detail"]
        # #442: der transcribe-Job korrigiert seit v0.48.0 selbst mit — „Transkription laeuft"
        # war waehrend seiner Korrekturphase eine Falschaussage. Der Server kennt nur die
        # Job-ART, nicht die Phase; „Verarbeitung" deckt beide Haelften ehrlich ab.
        assert "Verarbeitung" in r.json()["detail"]
        assert "Transkription" not in r.json()["detail"]
        # Nach dem [done] der Aufnahme (nicht mehr aktiv) ist der Weg frei.
        gestartet = []
        monkeypatch.setattr(jobs_mod, "start",
                            lambda *a, **k: gestartet.append(a) or ("x", True))
        jobs_mod._jobs[jid]["active_bases"] = set()
        r2 = client.post("/api/projects/Demo/files/S1/correct")
        assert r2.status_code == 200 and gestartet, "frei nach [done]"
    finally:
        jobs_mod._active.pop(("Demo", "transcribe"), None)
        jobs_mod._jobs.pop(jid, None)


def test_correct_file_409_vor_dem_404_wenn_der_lauf_gerade_schreibt(client, monkeypatch,
                                                                     mit_anbieter):
    """Am echten Pfad gemessen (Beleglauf 08-30): waehrend der Lauf die Datei aktiv
    transkribiert, existiert die Roh-JSON noch NICHT — staende der 404 davor, schluege
    er den 409 und der Riegel waere im einzigen Fenster, das er decken soll,
    unerreichbar. „gerade bearbeitet" ist die genauere Auskunft."""
    import webtool.jobs as jobs_mod
    jid = "t441b"
    jobs_mod._active[("Demo", "transcribe")] = jid
    jobs_mod._jobs[jid] = {"id": jid, "kind": "transcribe", "status": "running",
                           "bases": None, "active_bases": {"Neu1"}}
    try:
        r = client.post("/api/projects/Demo/files/Neu1/correct")   # Neu1 hat KEINE Raw-Datei
        assert r.status_code == 409 and "gerade bearbeitet" in r.json()["detail"]
    finally:
        jobs_mod._active.pop(("Demo", "transcribe"), None)
        jobs_mod._jobs.pop(jid, None)


def test_correct_409_wenn_transkription_mitkorrigiert(client, monkeypatch, mit_anbieter):
    """#441, projektweite Haelfte: der „Alles korrigieren"-Knopf muss sperren, wenn die
    laufende Transkription selbst korrigiert — zwei Korrekturlaeufe auf denselben
    Dateien, und mitten im Schreiben gibt es keine correction.json, die ein Skip
    retten wuerde. TRANSKRIBOR_AUTOCORRECT wird JE Test gepinnt: die client-Fixture
    fasst ihn nicht an, sonst entschiede eine .env-Altlast ueber rot und gruen."""
    import webtool.jobs as jobs_mod
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "1")
    jid = "t441p"
    jobs_mod._active[("Demo", "transcribe")] = jid
    jobs_mod._jobs[jid] = {"id": jid, "kind": "transcribe", "status": "running"}
    gestartet = []
    monkeypatch.setattr(jobs_mod, "request",
                        lambda *a, **k: gestartet.append(a) or ("x", True))
    try:
        r = client.post("/api/projects/Demo/correct")
        assert r.status_code == 409
        assert "selbst korrigiert" in r.json()["detail"]
        assert gestartet == [], "kein Job trotz laufender Mitkorrektur"
    finally:
        jobs_mod._active.pop(("Demo", "transcribe"), None)
        jobs_mod._jobs.pop(jid, None)


def test_correct_startet_trotz_laufender_transkription_ohne_autocorrect(
        client, monkeypatch, mit_anbieter):
    """Die Zusicherung gegen Ueberblockieren: mit TRANSKRIBOR_AUTOCORRECT=0 ist der
    manuelle Korrekturlauf neben der laufenden Transkription der VORGESEHENE Weg
    (GPU_KINDS in jobs.py) — ein blankes _keine_jobs(project) wuerde ihn sperren,
    genau die Verhaltensaenderung, die #441 verbietet."""
    import webtool.jobs as jobs_mod
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "0")
    jid = "t441q"
    jobs_mod._active[("Demo", "transcribe")] = jid
    jobs_mod._jobs[jid] = {"id": jid, "kind": "transcribe", "status": "running"}
    gestartet = []
    monkeypatch.setattr(jobs_mod, "request",
                        lambda *a, **k: gestartet.append(a) or ("x", True))
    try:
        r = client.post("/api/projects/Demo/correct")
        assert r.status_code == 200 and gestartet, "Parallelweg bleibt frei"
    finally:
        jobs_mod._active.pop(("Demo", "transcribe"), None)
        jobs_mod._jobs.pop(jid, None)


def test_correct_nicht_gesperrt_von_eigenem_correct_job(client, monkeypatch, mit_anbieter):
    """Nur transcribe sperrt, nicht jeder Job (Abgrenzung zur rename_project-Semantik
    von _keine_jobs mit base=None). jobs.request ist ein RECORDER, kein echter Aufruf:
    der wuerde _pending[("Demo","correct",None)] belegen und den Key nach Testende
    liegenlassen (die Vergiftungsfalle aus jobs.request)."""
    import webtool.jobs as jobs_mod
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "1")
    jid = "t441r"
    jobs_mod._active[("Demo", "correct")] = jid
    jobs_mod._jobs[jid] = {"id": jid, "kind": "correct", "status": "running"}
    gestartet = []
    monkeypatch.setattr(jobs_mod, "request",
                        lambda *a, **k: gestartet.append(a) or ("x", True))
    try:
        r = client.post("/api/projects/Demo/correct")
        assert r.status_code == 200 and gestartet, "eigener correct-Job sperrt nicht"
    finally:
        jobs_mod._active.pop(("Demo", "correct"), None)
        jobs_mod._jobs.pop(jid, None)


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
    assert "--autocorrect" in calls["cmd"]              # Streaming-Pipeline streamt Korrektur direkt je Datei


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


def test_create_project_reservierter_name_400(client, tmp_path):
    """K1 Glied 1 (#416/#478/#487): Markenraum und Projektnamensraum sind derselbe —
    die Laeufe praefixen gewoehnliche Zeilen mit "[{name}] ", die Marken ([active] …,
    [done] …, [scope] …, [scope+] …) stehen ohne Projektnamen im Strom. Ein Projekt
    namens "active" ist zeilengleich mit der Marke und vergiftet Buchfuehrung und
    Anzeige; "fetch" zusaetzlich, weil auch der Frontend-Parser ihn liest."""
    for name in ("active", "done", "scope", "scope+", "fetch"):
        assert client.post("/api/projects", json={"name": name}).status_code == 400, name
        assert not (tmp_path / name).exists(), name
    # Gross-/Kleinschreibung und nur-druckende Marken kommen durch: die Parser
    # matchen case-sensitiv, und "autocorrect" hat keinen Parse-Zweig (bewusst
    # nicht reserviert — sonst muessten es ytdlp und sperre auch sein).
    for name in ("Active", "autocorrect", "Weisstannen"):
        assert client.post("/api/projects", json={"name": name}).status_code == 200, name
    # Eckige Klammern machen die Protokollzeile fuer den Parser mehrdeutig (#416).
    for name in ("A]B", "a[b"):
        assert client.post("/api/projects", json={"name": name}).status_code == 400, name


def test_projekt_umbenennen_reserviertes_ziel_400_reparaturweg_frei(client, tmp_path):
    """Der Zielname steht im Markenraum wie ein neuer Name. Der ALTE Name wird
    bewusst nicht geprueft: ein vor dem Riegel angelegtes Projekt "active" bleibt
    lesbar (Lesepfad) und laesst sich auf einen sauberen Namen umbenennen —
    Umbenennen IST der Reparaturweg, kein Altprojekt ist eingesperrt."""
    assert client.post("/api/projects/Demo/rename", json={"name": "scope"}).status_code == 400
    assert client.post("/api/projects/Demo/rename", json={"name": "active"}).status_code == 400
    assert (tmp_path / "Demo").is_dir()
    alt = tmp_path / "active"
    (alt / "audio").mkdir(parents=True)          # Dateisystem-Attrappe: vor dem Riegel angelegt
    r = client.post("/api/projects/active/rename", json={"name": "active-alt"})
    assert r.status_code == 200
    assert (tmp_path / "active-alt").is_dir() and not alt.exists()


def test_upload_auf_reservierten_projektnamen_400(client, tmp_path):
    """upload_audio legt das Projekt sonst STILL an (os.makedirs) — der Riegel steht
    vor dem Datei-Schreiben, sonst laege eine orphan-Audiodatei auf der Platte."""
    r = client.post("/api/projects/active/audio",
                    files={"file": ("S1.mp3", b"ID3fakeaudio", "audio/mpeg")})
    assert r.status_code == 400 and "reserviert" in r.json()["detail"]
    assert not (tmp_path / "active").exists()


def test_fetch_und_einstellungs_puts_legen_kein_reserviertes_projekt_an(client, tmp_path):
    """Drei weitere Anlegewege: der fetch-Subprozess (fetch.py) und die beiden
    Einstellungs-PUTs, deren projekt.speichern/setze_datei den Projektordner als
    Nebeneffekt selbst anlegen (projekt.py) — ein PUT auf ein nicht vorhandenes
    "active" erschuenge sonst ein sichtbares Galerie-Projekt mit vergiftetem Namen."""
    r = client.post("/api/projects/active/fetch", json={"urls": ["https://youtu.be/x"]})
    assert r.status_code == 400
    r = client.put("/api/projects/active/einstellungen", json={"sprache": "de"})
    assert r.status_code == 400
    r = client.put("/api/projects/active/files/S1/einstellungen", json={"sprache": "de"})
    assert r.status_code == 400
    assert not (tmp_path / "active").exists()


def test_datei_endpunkte_legen_kein_reserviertes_projekt_an(client, tmp_path):
    """K1-Glied-1-Review (was-erlaubt-der-fix-neu, CONFIRMED): die makedirs in
    save_file/delete_file/rename_file legen bei nicht vorhandenem Projekt einen
    Ordner an — save_file schreibt sogar INHALT (edit.json + .md). Ein Stale-Editor-
    Tab, das nach dem Umbenennen eines Altprojekts "active" weiterspeichert, wuerde
    das vergiftete Projekt sonst samt Inhalt WIEDER aufstehen lassen; die Galerie
    listet jeden Ordner unter projekte/."""
    r = client.put("/api/projects/active/files/S1", json={"segments": []})
    assert r.status_code == 400 and "reserviert" in r.json()["detail"]
    r = client.delete("/api/projects/active/files/S1")
    assert r.status_code == 400
    r = client.post("/api/projects/active/files/S1/rename", json={"name": "Neu"})
    assert r.status_code == 400
    assert not (tmp_path / "active").exists()


def test_jobstart_endpunkte_geriegelt_fuer_reservierte_projekte(client, tmp_path, monkeypatch):
    """Bot-Befund #491 (Minor, berechtigt): transcribe/correct/correct_file/
    retranscribe ERZEUGEN den vergifteten Zeilenstrom selbst — ohne Riegel liefe
    ein Altprojekt "active" weiter und fuelle gesehen/bases mit Muell (#478/#487).
    Ein Altprojekt ist damit stillgelegt: lesen, umbenennen, loeschen geht,
    kein neuer Lauf."""
    import webtool.jobs as jobs_mod
    gestartet = []
    monkeypatch.setattr(jobs_mod, "start",
                        lambda *a, **k: gestartet.append(("start", a)) or ("x", True))
    monkeypatch.setattr(jobs_mod, "request",
                        lambda *a, **k: gestartet.append(("request", a)) or ("x", True))
    for pfad in ("/api/projects/active/transcribe",
                 "/api/projects/active/correct",
                 "/api/projects/active/files/S1/correct",
                 "/api/projects/active/files/S1/transcribe"):
        r = client.post(pfad)
        assert r.status_code == 400, pfad
        assert "reserviert" in r.json()["detail"], pfad
    assert gestartet == [], "400 darf nie neben einem gestarteten Job stehen (Bot R2)"
    assert not (tmp_path / "active").exists()


def _parser_marken() -> set:
    """Die Marken-Woerter aus den BEIDEN Parsern ernten — `jobs.py` (Praefix-Konstanten)
    und `jobPhases.ts` (die `startsWith('[…]')`-Literale).

    Bewusst NICHT aus `paths.RESERVIERTE_NAMEN`: die Menge ist das, was geprueft wird.
    Kaeme die Schleife von dort, fiele bei der Mutation „eine Marke aus der Menge nehmen"
    der Name einfach aus der Schleife und der Waechter bliebe gruen.

    Dieselbe Ernte fuehrt `test_paths.test_reservierte_namen_entsprechen_den_parser_marken`.
    Zwei Stellen bleiben unter der Rule of Three — und driftet eine Marke, wird dort der
    Mengenvergleich zuerst rot.
    """
    import pathlib
    import re

    from webtool import jobs as jobs_mod
    # Ueber die Konstanten-NAMEN statt ueber ein festes Vierertupel (Reviewbefund F4): ein
    # neu dazugebautes `NEU_PREFIX = "[neu] "` waere sonst still nicht abgedeckt.
    marken = {v.strip("[] ") for n, v in vars(jobs_mod).items()
              if n.endswith("_PREFIX") and isinstance(v, str) and v.startswith("[")}
    assert len(marken) >= 4, f"Ernte aus jobs.py verkuemmert: {marken}"
    ts = (pathlib.Path(__file__).parent / "frontend" / "src" / "lib" / "jobPhases.ts"
          ).read_text(encoding="utf-8")
    marken |= set(re.findall(r"startsWith\('\[([^\]]+)\]", ts))
    return marken


# ALLE sechs Wege, auf denen `jobs.start`/`jobs.request` erreichbar ist — nicht nur die vier
# offensichtlichen (Notiz des kalten Diff-Lesers): `fetch` und der Upload-Auto-Trigger starten
# ebenso einen Lauf und waren nur fuer den Namen "active" durch aeltere Tests gedeckt.
_JOBSTART_WEGE: tuple[tuple[str, dict], ...] = (
    ("/api/projects/{p}/transcribe", {}),
    ("/api/projects/{p}/correct", {}),
    ("/api/projects/{p}/files/S1/correct", {}),
    ("/api/projects/{p}/files/S1/transcribe", {}),
    ("/api/projects/{p}/fetch", {"json": {"urls": ["https://youtu.be/x"]}}),
    ("/api/projects/{p}/audio",
     {"files": {"file": ("S1.mp3", b"ID3fakeaudio", "audio/mpeg")}}),
)


def test_kein_lauf_startet_fuer_ein_projekt_das_eine_marke_nachahmt(client, tmp_path, monkeypatch):
    """#478/#487 — die GEWAEHLTE Richtung als Waechter: ein Projekt, das eine Protokoll-Marke
    nachahmt, kann `gesehen` und `bases` nicht mehr unbegrenzt fuellen, weil es gar nicht
    erst in einen Lauf kommt. Verworfen wurden Deckel und Kandidatenfilter im Leser
    (Richtung 1/3 aus #478): geschlossen ist die Tuer, nicht der Eimer.

    Die andere Haelfte des Belegs — dass hinter der Tuer wirklich etwas waechst — steht in
    `test_jobs.test_ein_projekt_namens_active_bucht_je_ZEILE_statt_je_AUFNAHME`.

    Der Nachbar darueber prueft dieselben vier Endpunkte fest verdrahtet fuer „active" und
    haelt zusaetzlich den Bot-Befund R2 fest. Dieser hier prueft ALLE Marken, und zwar
    geerntet (siehe `_parser_marken`) — nur so ist die Mutationsprobe „eine Marke aus
    `RESERVIERTE_NAMEN` nehmen" hier sichtbar.
    """
    import webtool.jobs as jobs_mod
    marken = _parser_marken()
    assert len(marken) >= 5, f"Ernte verkuemmert ({marken}) — der Waechter maesse nichts"
    gestartet = []
    monkeypatch.setattr(jobs_mod, "start",
                        lambda *a, **k: gestartet.append(("start", a)) or ("x", True))
    monkeypatch.setattr(jobs_mod, "request",
                        lambda *a, **k: gestartet.append(("request", a)) or ("x", True))
    for name in sorted(marken):
        for muster, wie in _JOBSTART_WEGE:
            r = client.post(muster.format(p=name), **wie)
            assert r.status_code == 400, (name, muster, r.text)
            detail = r.json()["detail"]
            assert "reserviert" in detail, (name, muster, detail)
            # Der Server hat GENAU diesen Namen gesehen. Ohne diese Zeile bliebe der Test
            # gruen, wenn "scope+" unterwegs zu "scope " verstuemmelte und der Riegel ueber
            # den falschen Namen griffe — die Mutation an "scope+" waere dann unsichtbar.
            assert repr(name) in detail, (name, muster, detail)
    assert gestartet == [], gestartet
    assert not any(p.name in marken for p in tmp_path.iterdir())
    # Positivkontrolle: der Riegel matcht exakt und kleingeschrieben. Ohne sie waere der Test
    # auch dann gruen, wenn diese Endpunkte pauschal 400 gaeben. Geprueft wird der GRUND, nicht
    # der Code: die sechs Wege antworten je nach Zustand legitim 200/404/409 (und `fetch` auch
    # 400, wenn ihm die URL nicht passt) — nur „reserviert" darf nicht dabei sein.
    for muster, wie in _JOBSTART_WEGE:
        r = client.post(muster.format(p="Active"), **wie)
        assert "reserviert" not in r.text, (muster, r.text)


def test_jede_route_die_einen_job_startet_traegt_den_namensraum_riegel():
    """Der Riegel liegt in den AUFRUFERN von `jobs.start`/`jobs.request`, nicht in
    `jobs.start` selbst. Heute ist keiner vergessen — aber nichts hielt fest, dass ein
    SIEBTER Start-Endpunkt ihn auch traegt, und gefangen haette ihn niemand: der Test
    darueber zaehlt vier Pfade von Hand auf, und `.coderabbit.yaml` kennt die Regel nicht
    (gemessen: `grep -i reserv .coderabbit.yaml` ist leer).

    Gelesen wird der QUELLTEXT von `app.py` per `ast` — welche Funktionen erreichen
    `jobs.start`/`jobs.request`, transitiv (`_start_transcribe` ist ein privater Helfer
    ohne eigenen Riegel; seine drei Aufrufer tragen ihn) — und jede ROUTE in diesem
    Abschluss muss `_sicherer_projektname` rufen.

    Ein Backstop IN `jobs.start` waere die staerkere Fassung und ist verworfen: der
    `messstand`-Skill koennte dann genau die Messung nicht mehr fahren, aus der #478
    stammt, und der Fall kaeme als 500 statt als 400 heraus.
    """
    import ast
    import pathlib
    quelltext = (pathlib.Path(__file__).parent / "app.py").read_text(encoding="utf-8")
    baum = ast.parse(quelltext)
    def punktname(k) -> str:
        """Der VOLLE punktierte Name einer Attributkette: `webtool.jobs.start`, nicht `.start`.

        Die einstufige Fassung las nur `k.value.id` und war damit blind fuer zwei Formen
        (Bot-Befund an diesem PR): `import webtool.jobs` + `webtool.jobs.start(…)` lieferte
        `.start`, und `@app.router.post` wurde gar nicht als Route erkannt.
        """
        teile = []
        while isinstance(k, ast.Attribute):
            teile.append(k.attr)
            k = k.value
        if isinstance(k, ast.Name):
            teile.append(k.id)
        return ".".join(reversed(teile))

    # Woran ein Start erkannt wird — an den LETZTEN zwei Gliedern, damit die Tiefe des
    # Imports (`jobs.start` wie `webtool.jobs.start`) keine Rolle spielt.
    START = {("jobs", "start"), ("jobs", "request")}

    def ist_start(name: str) -> bool:
        """Startet dieser punktierte Name einen Job? (`jobs.start` / `jobs.request`)

        Verglichen werden die letzten ZWEI Glieder, damit auch ein Alias-Import
        (`from webtool import jobs as j` -> `j.start`) trifft.
        """
        return tuple(name.split(".")[-2:]) in START

    # Der Waechter folgt dem AUFRUFGRAPH ab `@app.<verb>` und erkennt den Start an der
    # Schreibweise `jobs.start`/`jobs.request`. Das sind zwei ANNAHMEN ueber app.py, und
    # BEIDE wurden im Review als gruene Umgehung vorgefuehrt. Sie werden deshalb geprueft
    # statt geglaubt — ein Waechter, der „geprueft" meldet, ohne es zu sein, ist schlimmer
    # als die vorherige, offen von Hand gezaehlte Liste.
    # Am SYNTAXBAUM, nicht am Text. Die Textfassung war eine Substring-Suche ueber die ganze
    # Datei und machte damit den ersten Reflex eines Lesers rot: einen Kommentar „bewusst
    # kein APIRouter, der Waechter sieht nur @app.<verb>". Dieselbe Klasse wie der
    # Docstring-Treffer in druck.py weiter unten — zweimal am selben Tag.
    verstoss = []
    for k in ast.walk(baum):
        if isinstance(k, ast.Name) and k.id == "APIRouter":
            verstoss.append(f"APIRouter (Zeile {k.lineno})")
        elif isinstance(k, ast.Attribute) and k.attr in ("add_api_route", "include_router"):
            verstoss.append(f"{k.attr} (Zeile {k.lineno})")
        elif isinstance(k, ast.Import):
            for a in k.names:
                if a.name.split(".")[-1] == "jobs" and a.asname not in (None, "jobs"):
                    verstoss.append(f"jobs unter Alias {a.asname} (Zeile {k.lineno})")
        elif isinstance(k, ast.ImportFrom):
            for a in k.names:
                if a.name == "APIRouter":
                    verstoss.append(f"APIRouter-Import (Zeile {k.lineno})")
                elif a.name == "jobs" and a.asname not in (None, "jobs"):
                    verstoss.append(f"jobs unter Alias {a.asname} (Zeile {k.lineno})")
                elif (k.module or "").split(".")[-1] == "jobs" and a.name in ("start", "request"):
                    verstoss.append(f"{a.name} direkt importiert (Zeile {k.lineno})")
    assert not verstoss, (
        f"app.py: {verstoss}. Dieser Waechter erkennt Routen an `@app.<verb>` und den Start "
        f"an `jobs.start`/`jobs.request` — diese Formen sieht er NICHT. Er ist die Stelle, "
        f"die mitwandern muss, bevor sie benutzt werden (#416/#478/#487).")

    # Und der Start darf nur aus app.py kommen: ein `jobs.start` in einem anderen
    # Servermodul umginge diesen Waechter ganz, denn er liest ausschliesslich app.py.
    #
    # Ueber den SYNTAXBAUM, nicht ueber den Text: die erste Fassung suchte den String und
    # schlug auf `druck.py` an, das `jobs.start()` in einem DOCSTRING erwaehnt — ein
    # Fehlalarm auf unveraendertem Code, und ein Waechter mit Fehlalarmen wird weggeklickt.
    # `auth.py` importiert uebrigens legitim andere Namen aus `jobs`; gesucht sind nur
    # `start`/`request`.
    fremd = []
    for p in sorted(pathlib.Path(__file__).parent.glob("*.py")):
        if p.name in ("app.py", "jobs.py", "conftest.py") or p.name.startswith("test_"):
            continue
        fremdbaum = ast.parse(p.read_text(encoding="utf-8"))
        # Erst nachsehen, unter WELCHEM Namen das Modul dort gebunden ist. Auf `jobs.start`
        # zu vergleichen war zu wenig: `from webtool import jobs as j` + `j.start(…)` ging
        # still durch (Bot-Befund an diesem PR). In `app.py` ist die Alias-Form durch die
        # Zusicherungen oben verboten — im Fremdmodul nicht, dort muss aufgeloest werden.
        alias = set()
        for k in ast.walk(fremdbaum):
            if isinstance(k, ast.Import):
                for a in k.names:
                    if a.name.split(".")[-1] == "jobs":
                        alias.add((a.asname or a.name).split(".")[0])
            elif isinstance(k, ast.ImportFrom):
                for a in k.names:
                    if a.name == "jobs":
                        alias.add(a.asname or a.name)
                    elif ((k.module or "").split(".")[-1] == "jobs"
                            and a.name in ("start", "request")):
                        fremd.append(f"{p.name}:{k.lineno} (Direktimport {a.name})")
        for k in ast.walk(fremdbaum):
            teile = punktname(k).split(".") if isinstance(k, ast.Attribute) else []
            if len(teile) >= 2 and teile[0] in alias and teile[-1] in ("start", "request"):
                fremd.append(f"{p.name}:{k.lineno}")
    assert not fremd, (
        f"{fremd} startet Jobs an app.py vorbei — dieser Waechter liest nur app.py und "
        f"pruefte den Namensraum-Riegel dort nicht.")

    # `ast.AsyncFunctionDef` ist KEINE Unterklasse von `ast.FunctionDef`: ohne sie fiel ein
    # `async def`-Startendpunkt ohne Riegel still durch (F1, Probe M-A).
    DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)
    # Nur Modulebene. `ast.walk` faende auch INNERE `def`s, und zwei Routen mit je einem
    # inneren `_fmt` machten die Eindeutigkeitspruefung falsch-rot (F3) — ein Waechter mit
    # Fehlalarmen wird weggeklickt. Aufrufe innerhalb einer Funktion sieht die Ernte
    # trotzdem, denn sie walkt den Rumpf.
    funktionen = [k for k in baum.body if isinstance(k, DEFS)]
    assert len({f.name for f in funktionen}) == len(funktionen), \
        "gleichnamige Funktionen auf Modulebene in app.py — die Namensabbildung waere mehrdeutig"
    nach_namen = {f.name: f for f in funktionen}

    def lokale(fn) -> set:
        """Namen, die in `fn` LOKAL gebunden sind — Parameter, Zuweisungen, Schleifen,
        Comprehensions, with/except/import-Alias.

        Ohne diese Menge zieht die Ernte unten jede Funktion in den Starter-Abschluss, die
        ein gewoehnliches Wort dieses Projekts benutzt: die Startrouten heissen `transcribe`,
        `correct`, `fetch_urls`, `upload_audio`, und schon ein Parameter `correct: bool` in
        einer LESE-Route genuegte, damit der Waechter ihr „startet einen Job" vorwirft. Der
        billigste Weg zu Gruen waere dann ein `_sicherer_projektname` auf dem Lesepfad —
        und genau das verbietet `paths.sicherer_projektname` in seinem Docstring, weil es
        ein Altprojekt `active` von seinen eigenen Daten aussperrte.
        """
        raus = {a.arg for a in fn.args.args + fn.args.kwonlyargs + fn.args.posonlyargs}
        for x in (fn.args.vararg, fn.args.kwarg):
            if x is not None:
                raus.add(x.arg)
        for k in ast.walk(fn):
            if isinstance(k, ast.Name) and isinstance(k.ctx, (ast.Store, ast.Del)):
                raus.add(k.id)                       # Zuweisung, for-Ziel, Comprehension,
                                                     # und `with … as x` (ist auch ein Store)
            elif isinstance(k, ast.alias):
                raus.add((k.asname or k.name).split(".")[0])
            elif isinstance(k, ast.arg):
                raus.add(k.arg)                      # Lambda- und Nested-def-Parameter
            elif isinstance(k, ast.ExceptHandler) and k.name:
                raus.add(k.name)                     # `except E as x` ist ein STRING, kein
                                                     # Name-Knoten — sonst falsch-rot
            elif isinstance(k, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and k is not fn:
                raus.add(k.name)                     # `def x` / `class x` binden ebenfalls
                                                     # lokal — und AUCH ueber `.name`, nicht
                                                     # ueber einen Name-Store-Knoten. Ohne
                                                     # diesen Zweig war `lokale()` fuer die
                                                     # zwei haeufigsten Bindungsformen blind
                                                     # (Bot-Major an diesem PR, Proben
                                                     # CR-7/CR-8): eine Route konnte
                                                     # `_sicherer_projektname` als inneres
                                                     # `def` bzw. `class` definieren und
                                                     # damit den Riegel vortaeuschen.
        return raus

    def knoten(fn, tief: bool):
        """Alle Knoten unter `fn` — mit `tief=False` OHNE verschachtelte Bereiche.

        Die beiden Seiten brauchen VERSCHIEDENE Tiefen, und das ist der ganze Punkt
        (Bot-Befund an diesem PR): ein START zaehlt auch aus einem Lambda — `fetch_urls`
        reicht seinen Nachlauf als `then=lambda: _start_transcribe(…)` weiter. Ein RIEGEL
        in einer inneren Funktion laeuft dagegen nie, wenn die Route ihn nicht ruft; als
        Schutz gezaehlt waere er ein gruener Waechter ueber einer offenen Tuer.
        """
        stapel = list(ast.iter_child_nodes(fn))
        while stapel:
            k = stapel.pop()
            yield k
            if tief or not isinstance(k, (ast.FunctionDef, ast.AsyncFunctionDef,
                                          ast.Lambda, ast.ClassDef)):
                stapel.extend(ast.iter_child_nodes(k))

    def bezuege(fn) -> list:
        """(Name, Zeile) jeder Nennung — Aufruf ODER blosse Referenz.

        Die Referenz zaehlt mit, weil sie genauso einen Job startet: `run_in_threadpool(
        jobs.start, …)` uebergibt die Funktion, ruft sie aber nicht — und app.py reicht
        heute schon Funktionen so weiter. Ohne diesen Zweig blieb der Waechter gruen
        (F1, Probe M-C).

        Blosse NAMEN nur, wenn sie eine Funktion auf Modulebene benennen und in dieser
        Funktion nicht lokal gebunden sind (siehe `lokale`).
        """
        gebunden = lokale(fn)
        raus = []
        for k in knoten(fn, tief=True):
            if isinstance(k, ast.Attribute):
                raus.append((punktname(k), k.lineno))
            elif (isinstance(k, ast.Name) and isinstance(k.ctx, ast.Load)
                    and k.id in nach_namen and k.id not in gebunden):
                raus.append((k.id, k.lineno))
        return raus

    bezug = {f.name: bezuege(f) for f in funktionen}
    namen = {n: {b for b, _ in v} for n, v in bezug.items()}
    starter = {n for n, v in namen.items() if any(ist_start(b) for b in v)}
    while True:                                   # transitiver Abschluss ueber die Helfer
        neu = {n for n, v in namen.items() if v & starter} - starter
        if not neu:
            break
        starter |= neu

    def ist_route(fn) -> bool:
        """Traegt `fn` einen `@app.<verb>`-Dekorator, ist sie also von aussen erreichbar?"""
        for dek in fn.decorator_list:
            f = dek.func if isinstance(dek, ast.Call) else dek
            # `api_route` mit `methods=[…]` ist derselbe Weg unter anderem Namen (F1, M-D).
            # Voller punktierter Name: `@app.router.post` ist derselbe Weg eine Ebene
            # tiefer und wurde einstufig gar nicht als Route erkannt (Bot-Befund).
            teile = punktname(f).split(".")
            if (len(teile) >= 2 and teile[0] == "app"
                    and teile[-1] in ("get", "post", "put", "delete", "patch", "api_route")):
                return True
        return False

    routen = {n for n in starter if ist_route(nach_namen[n])}
    # Positivkontrolle: die sechs bekannten Startwege sind wirklich im Abschluss. Sie faengt
    # das TOTALE Leerlaufen der Erkennung — mehr nicht, und das ist ausdruecklich gesagt,
    # weil der erste Kommentar hier zu viel behauptete: eine EINZELNE neue Route mit einer
    # anderen Schreibweise laesst sie gruen, solange die sechs bekannten weiter `jobs.`
    # schreiben. Dagegen stehen die Quelltext-Zusicherungen oben, nicht diese Zeile.
    assert {"transcribe", "correct", "correct_file", "retranscribe_file",
            "fetch_urls", "upload_audio"} <= routen, sorted(routen)

    for n in sorted(routen):
        # Der Riegel zaehlt nur als AUFRUF und nur aus dem RUMPF der Route; der Start
        # dagegen aus allem, eine Lambda startet genauso (siehe `knoten`).
        #
        # Auf `bezuege` gestuetzt war das ein Loch, und zwar eines, das die HAERTUNG erst
        # aufgemacht hat (Bot-Befund an diesem PR): dort zaehlt auch eine blosse Referenz
        # mit. `guard = _sicherer_projektname` frueh in der Funktion erfuellte damit
        # `riegel`, ein Aufruf NACH `jobs.start` erfuellte `argumente` — beide Zusicherungen
        # gruen, waehrend der Job vor der Pruefung startet. Riegel UND Argumentpruefung
        # kommen deshalb aus derselben Knotenliste.
        #
        # `lokale()` bleibt dabei in Kraft, und das ist die Korrektur eines eigenen Fehlers:
        # `bezuege` verwarf lokal gebundene Namen, die erste Fassung von `rufe` nicht mehr.
        # Damit erfuellte eine ATTRAPPE den Riegel — `_sicherer_projektname = lambda p: p`
        # plus Aufruf, und der Waechter meldete gruen (gemessen an einer praeparierten
        # `transcribe`-Route: ohne die Zeile gruen, mit ihr rot; Probe CR-6). Gefunden haben
        # das der gegnerische Subagent und die CodeRabbit-CLI unabhaengig voneinander.
        #
        # DER PREIS, benannt statt verschwiegen: ein route-lokaler Alias auf die ECHTE
        # Funktion (`_sicherer_projektname = paths.sicherer_projektname`) faellt damit
        # ebenfalls durch, obwohl er schuetzt — ein Fehlalarm. Das ist die gewollte
        # Richtung: ein falsches ROT ist laut und wird repariert, ein falsches GRUEN ist
        # still, und ein gruener Struktur-Waechter ueber einer offenen Tuer ist schlimmer
        # als gar keiner. Heute gibt es die Form nicht (die 13 Aufrufstellen in `app.py`
        # sind schlichte Namensaufrufe); kommt sie, ist die Antwort, den Alias
        # aufzuloesen — nicht, die Zeile wieder zu entfernen.
        gebunden_hier = lokale(nach_namen[n])
        rufe = [k for k in knoten(nach_namen[n], tief=False)
                if isinstance(k, ast.Call) and isinstance(k.func, ast.Name)
                and k.func.id == "_sicherer_projektname"
                and k.func.id not in gebunden_hier]
        riegel = [k.lineno for k in rufe]
        start = [z for b, z in bezug[n] if ist_start(b) or b in starter - {n}]
        assert riegel, (
            f"app.py:{n} startet einen Job, ruft aber keinen _sicherer_projektname — ein "
            f"Projekt namens `active`/`scope+` kaeme darueber in einen Lauf und fuellte "
            f"`gesehen`/`bases` je ZEILE (#416/#478/#487).")
        # VOR dem Start, nicht bloss irgendwo in der Funktion: dahinter verschoben blieb
        # dieser Waechter gruen, waehrend der Riegel wirkungslos war (F2, Probe M-E).
        assert min(riegel) < min(start), (
            f"app.py:{n} ruft _sicherer_projektname erst in Zeile {min(riegel)}, startet "
            f"den Job aber schon in Zeile {min(start)} — der Riegel kommt zu spaet.")
        # ... und auf dem PROJEKTNAMEN. Auf ein anderes Argument gelegt blieb der Waechter
        # ebenfalls gruen (F2, Probe M-F).
        argumente = [k.args[0] for k in rufe if k.args]
        assert any(isinstance(a, ast.Name) and a.id == "project" for a in argumente), (
            f"app.py:{n} ruft _sicherer_projektname, aber nicht auf `project` — der Riegel "
            f"prueft dann einen anderen Wert als den, unter dem der Lauf druckt.")
    # EHRLICHE GRENZE: geprueft werden Anwesenheit, Reihenfolge und Argumentname im
    # QUELLTEXT — nicht die Wirkung zur Laufzeit. Ein Riegel hinter einem `if False:`
    # bliebe hier gruen; dagegen steht der Waechter darueber, der die Endpunkte faehrt.


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
    """`_require_ai` weist die Korrektur-Endpunkte ab, wenn `llm.available()` falsch ist.

    Ohne diesen Patch haengen die Tests daran, ob auf dem Rechner `claude` installiert ist:
    beim Entwickler ist es das, auf dem CI-Runner nicht. Dort brachen sie am Riegel ab und
    pruefte keiner mehr, was er behauptet — gruen aus dem falschen Grund.
    """
    from webtool import app as app_mod
    monkeypatch.setattr(app_mod.llm, "available", lambda *_a: (True, ""))


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
    from webtool import settings          # lokal wie ueberall in dieser Datei
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
                    # Der Korrektur-Deckel, seine Grenze und der Ausgangswert. "3" ist der
                    # bisherige, fest verdrahtete Wert — wer den Regler nicht anfasst, merkt
                    # nichts. `parallel_env` steht MIT im Vergleich (statt oben weggepoppt zu
                    # werden): die Fixture raeumt die Variable weg, "" ist hier also eine
                    # echte Zusicherung — ein dauerhaft gemeldetes Override waere ein
                    # Daueralarm und faellt genau hier auf.
                    "parallel": "3", "parallel_max": settings.PARALLEL_MAX,
                    "parallel_default": "3", "parallel_env": "", "parallel_env_wirksam": "",
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
        "parallel", "parallel_max", "parallel_default",
        # Umgebung, die das Frontend braucht
        "providers", "env_key", "whisper_choices", "ai_ready", "ai_reason",
        # wo die Arbeit des Nutzers liegt (#218)
        "projekte_pfad",
        # ob TRANSKRIBOR_PARALLEL den gespeicherten Deckel ueberstimmt (roh + wirksam)
        "parallel_env", "parallel_env_wirksam",
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


def test_settings_lehnt_unbrauchbaren_deckel_ab(client):
    """Der Wert reist ueber `job_env()` als Umgebungsvariable in den Korrektur-Subprozess und
    wird dort zur Groesse des `_claude_slots`-Semaphores. `correct.py` faengt nur einen
    Tippfehler ab (ValueError -> 3) — eine gueltige, aber absurde Zahl kaeme unveraendert
    durch. Der Schreibpfad ist die Stelle, an der das auffallen muss (dieselbe Regel wie beim
    yt-dlp-Schalter darueber).

    Drei Richtungen, weil sie verschiedene Zweige von `parallel_ok` treffen: zu gross, gar
    keine Zahl, und die Null. Bei der Null ist die Begruendung NICHT „Semaphore(0) blockiert
    fuer immer" — so stand es hier, und `max(1, …)` in correct.py macht daraus laengst eine 1.
    Sie wird abgelehnt, weil eine gespeicherte 0 etwas anderes TUT als sie sagt: der Nutzer
    laese „keine gleichzeitigen Anfragen" und bekaeme eine."""
    for schlecht in ("10000", "viele", "0"):
        assert client.put("/api/settings", json={"parallel": schlecht}).status_code == 400, schlecht
    assert client.get("/api/settings").json()["parallel"] == "3"
    # Positivkontrolle: die Wache laesst einen gueltigen Wert durch. Ohne sie waere der Test
    # auch dann gruen, wenn der Endpunkt JEDEN Wert mit 400 ablehnte.
    assert client.put("/api/settings", json={"parallel": "8"}).status_code == 200
    assert client.get("/api/settings").json()["parallel"] == "8"


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
    """Der Merker ist Buchhaltung des Servers — seit #281 als venv-eigene Datei, aber der
    PUT-Waechter bleibt: ein vom Browser gesetztes Datum haette die Aktualisierung auf
    Jahre stillgelegt. Der Schluessel ist nicht mal mehr in DEFAULTS, `load()` liefert
    ihn also nie."""
    client.put("/api/settings", json={"ytdlp_geprueft": "2099-01-01"})
    from webtool import settings as s
    assert "ytdlp_geprueft" not in s.load()


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
    monkeypatch.setattr(llm, "check", lambda: (_ for _ in ()).throw(llm.LLMError("HTTP 429: Rate limit reached")))
    r = client.post("/api/settings/test")
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert r.json()["detail"] == ("Anfrage-Limit erreicht (Rate Limit): "
                                 "Der Anbieter bittet um eine kurze Pause. Bitte in 1–2 Minuten erneut auf „Korrigieren“ klicken.")


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

    **`TRANSKRIBOR_PROJEKTE` ist seit #459 aus demselben Grund Pflicht — und diesmal LOESCHT
    es.** Der Lifespan stoesst den `.weg`-Aufraeumlauf an; ohne Umlenkung faellt
    `paths.projekte_root()` auf `<repo>/projekte` zurueck, und der Faden entfernte dort jeden
    Rest aelter als 10 Minuten. Heute liegt in den echten Projekten keiner — also gruen, bis
    er einmal trifft. Genau der Befund, den der kalte Plan-Reviewer aufgemacht hat.
    """
    from webtool import app as appmod
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path / "projekte"))
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
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base, **kw: {"id": "j1", "kind": "correct"})
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
    def nur_S9(name, base, **kw):
        gefragt.append((name, base, kw.get("active_only")))
        return {"id": "j1", "kind": "correct"} if base == "S9" else None
    monkeypatch.setattr(jobs_mod, "betrifft", nur_S9)
    assert client.delete("/api/projects/Demo/files/S1").status_code == 200
    assert not (tmp_path / "Demo" / "transkripte" / "S1.json").exists()
    assert gefragt == [("Demo", "S1", True)], "die Sperre fragt mit active_only=True nach der Aufnahme"


def test_datei_loeschen_ruft_remove_base_auf(client, monkeypatch, tmp_path):
    import webtool.jobs as jobs_mod
    entfernt = []
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base, **kw: None)
    monkeypatch.setattr(jobs_mod, "remove_base", lambda name, base: entfernt.append((name, base)))
    assert client.delete("/api/projects/Demo/files/S1").status_code == 200
    assert entfernt == [("Demo", "S1")]


def test_datei_loeschen_ohne_sperre_gibt_503(client, monkeypatch, tmp_path):
    from webtool import sperre
    import contextlib
    @contextlib.contextmanager
    def fake_sperre(pfad, **kw):
        yield False
    monkeypatch.setattr(sperre, "datei", fake_sperre)
    r = client.delete("/api/projects/Demo/files/S1")
    assert r.status_code == 503
    assert (tmp_path / "Demo" / "transkripte" / "S1.json").exists()


def test_projekt_umbenennen_bleibt_grob_gesperrt(client, monkeypatch):
    """Ohne `base` bleibt die alte Sperre richtig: beim Umbenennen wandert der ganze Ordner,
    da hilft es nicht, dass der Lauf nur eine einzelne Aufnahme anfasst."""
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base, **kw: None)   # keine Datei betroffen
    monkeypatch.setattr(jobs_mod, "active_for", lambda name: [{"id": "j1", "kind": "transcribe"}])
    r = client.post("/api/projects/Demo/rename", json={"name": "Neu"})
    # „Verarbeitung" seit #442 — der transcribe-Job korrigiert mit, „Transkription" war
    # waehrend seiner Korrekturphase falsch. Der Test misst die SPERRE, das Wort steht hier
    # nur mit; es bleibt trotzdem eine Zusicherung und wird deshalb nachgezogen statt gelockert.
    assert r.status_code == 409
    assert "Verarbeitung" in r.json()["detail"]


def test_neu_transkribieren_raeumt_transkripte_weg_und_startet_den_lauf(client, tmp_path, monkeypatch):
    t = _artefakte(tmp_path)
    aufrufe = []
    import webtool.jobs as jobs_mod
    orig_request = jobs_mod.request
    def mock_request(project, cmd, cwd, kind, then=None, base=None):
        aufrufe.append((project, cmd, kind, base))
        return orig_request(project, cmd, cwd, kind, then=then, base=base)
    monkeypatch.setattr(jobs_mod, "request", mock_request)
    r = client.post("/api/projects/Demo/files/S1/transcribe")
    assert r.status_code == 200 and r.json()["started"] is True
    # Die abgeleiteten MUESSEN mit weg: load_or_build_doc bevorzugt edit.json vor der Roh-JSON.
    assert list(t.iterdir()) == []
    assert (tmp_path / "Demo" / "audio" / "S1.mp3").exists()          # Audio bleibt
    assert len(aufrufe) == 1
    assert aufrufe[0][0] == "Demo"
    assert "--only" in aufrufe[0][1] and "S1" in aufrufe[0][1]
    assert aufrufe[0][3] == "S1"


def test_neu_transkribieren_ohne_audio_gibt_404_und_laesst_das_transkript_stehen(client, tmp_path):
    """Ohne Quelle waere das Wegraeumen ein reiner Datenverlust — der Lauf koennte
    nichts wiederherstellen."""
    (tmp_path / "Demo" / "audio" / "S1.mp3").unlink()
    assert client.post("/api/projects/Demo/files/S1/transcribe").status_code == 404
    assert (tmp_path / "Demo" / "transkripte" / "S1.json").exists()


def test_neu_transkribieren_waehrend_ein_job_laeuft_gibt_409(client, monkeypatch, tmp_path):
    import webtool.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base, **kw: {"id": "j1", "kind": "transcribe"})
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
    monkeypatch.setattr(jobs_mod, "betrifft", lambda name, base, **kw: {"id": "j1", "kind": "transcribe"})
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


def test_dateieinstellungen_melden_pyannote_verfuegbarkeit(client, tmp_projekt, monkeypatch):
    """#270: der Kill-Switch ist der UNWAHRSCHEINLICHERE der beiden Ausfallgründe —
    fehlendes pyannote ist der Normalfall einer halb eingerichteten Umgebung. Beide
    Richtungen, sonst wäre ein Feld, das immer False meldet, ununterscheidbar (dieselbe
    Regel wie der #266-Test darüber)."""
    from webtool import diarize as _diarize
    monkeypatch.setattr(_diarize, "_VERFUEGBAR", True)
    r = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen")
    assert r.json()["pyannote_da"] is True

    monkeypatch.setattr(_diarize, "_VERFUEGBAR", False)
    r = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen")
    assert r.json()["pyannote_da"] is False


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


def test_fetch_setzt_den_mehrsprachig_schluessel_IMMER(client, tmp_projekt, monkeypatch):
    """#298, zweite Haelfte: dasselbe Leck wie bei TRANSKRIBOR_FETCH_SPRACHE — der Schluessel
    wurde nur BEDINGT gesetzt, also ueberlebte eine `.env`-Zeile aus einem alten CLI-Test in
    `os.environ` und schlug auf jeden Browser-Import durch (`jobs._run_proc` baut
    `{**os.environ, **job_env(), **env}`).

    Der Fix war hier NICHT derselbe Einzeiler wie bei der Sprache, und das ist der Grund, warum
    es ein eigener PR wurde: `_mehrsprachig_aus_env("")` lieferte `False`, nicht `None` — ein
    leerer Wert haette also einen echten Datei-Override festgeschrieben statt die Altlast zu
    neutralisieren (die Falle aus #166). Die Leseseite ist deshalb mitgeaendert; die
    Gegenrichtung („0" bleibt False, wird NICHT zu nicht-gesetzt") steht im Parser-Test
    `test_env_parser_liest_beide_richtungen` in test_fetch.py.

    Der Preis einer durchgeschlagenen Altlast ist gemessen und hoch: `mehrsprachig` schaltet in
    `transcribe.py` `multilingual` + `condition_on_previous_text=False`. Auf einer rein
    deutschen Aufnahme (28 Fenster) meldete die Erkennung dann zweimal „Englisch" mit p = 0,432
    bzw. 0,289 und schob einen Satz ein, den niemand gesagt hat — von 206 Segmenttexten blieben
    89 identisch.
    """
    gesehen = _fetch_env_faenger(monkeypatch)
    monkeypatch.setenv("TRANSKRIBOR_FETCH_MEHRSPRACHIG", "1")          # Altlast aus der .env
    r = client.post(f"/api/projects/{tmp_projekt}/fetch",
                    json={"urls": ["https://youtu.be/aaaaaaaaaaa"]})   # kein Feld = kein Override
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_MEHRSPRACHIG"] == "",         "der Schluessel muss gesetzt sein, sonst gewinnt die Altlast aus os.environ"
    # Bis zur Leseseite durchziehen: ein gesetzter, aber falsch gelesener leerer Wert waere
    # derselbe Schaden mit einer anderen Signatur.
    from webtool import fetch as fetch_mod
    monkeypatch.setenv("TRANSKRIBOR_FETCH_MEHRSPRACHIG",
                       gesehen["TRANSKRIBOR_FETCH_MEHRSPRACHIG"])
    assert fetch_mod._mehrsprachig_aus_env() is None


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


def test_projekteinstellungen_put_liefert_dieselben_felder_wie_der_get(client):
    """Der PUT gab zwei Felder weniger zurueck als der GET (`sprach_choices`, `tiefen`) —
    dieselbe Divergenz wie bei `_settings_body` (#239), nur eine Datei weiter. Das Frontend
    tippt beide Antworten als denselben Typ."""
    g = client.get("/api/projects/Demo/einstellungen")
    p = client.put("/api/projects/Demo/einstellungen", json={"sprache": "de"})
    assert g.status_code == 200 and p.status_code == 200
    assert set(p.json()) == set(g.json())


def test_projekteinstellungen_nennen_die_sprecher_obergrenze(client):
    """Waechter gegen den Verlust der Menge SELBST: faellt `sprecher_max` aus dem gemeinsamen
    Bauweg, verschwaende es auf BEIDEN Seiten und der Paritaetstest oben bliebe gruen. Die
    Vorschau beim Hinzufuegen braucht die Grenze, bevor es eine Datei gibt, die sie nennen
    koennte — und `sprachen.SPRECHER_MAX` darf im Frontend nicht ein zweites Mal stehen."""
    from webtool import sprachen as s
    for antwort in (client.get("/api/projects/Demo/einstellungen"),
                    client.put("/api/projects/Demo/einstellungen", json={})):
        assert antwort.json()["sprecher_max"] == s.SPRECHER_MAX


def test_upload_traegt_die_sprecherzahl_ein_BEVOR_der_job_laeuft(client, monkeypatch):
    """Die Zahl muss in projekt.json stehen, wenn `_start_transcribe` laeuft — sonst ist sie
    ein Rennen gegen die eigene Pipeline (genau der Fehler, den dieser Umbau behebt).
    Geprueft wird deshalb der ZEITPUNKT, nicht nur das Ergebnis: die Attrappe liest den Stand
    in dem Moment, in dem der Job gestartet wuerde."""
    from webtool import projekt as projekt_mod
    import webtool.jobs as jobs_mod
    beim_start = {}

    def fake_start(project, cmd, cwd, kind, then=None, env=None):
        beim_start["sprecher"] = projekt_mod.datei_ansicht(project, "Neu")["sprecher"]
        return "upl1", True

    monkeypatch.setattr(jobs_mod, "start", fake_start)
    r = client.post("/api/projects/Demo/audio",
                    files={"file": ("Neu.mp3", b"a", "audio/mpeg")}, data={"sprecher": "4"})
    assert r.status_code == 200
    assert beim_start["sprecher"] == 4


def test_upload_ohne_sprecherzahl_legt_keinen_eintrag_an(client):
    """Legacy-Verhalten: wer das Feld weglaesst, bekommt `null` (automatisch) — und keinen
    Datei-Override, der spaeter etwas festschriebe.

    Geprueft wird der EINTRAG, nicht der aufgeloeste Wert. `datei_ansicht(...)["sprecher"]`
    liefert `None` sowohl fuer eine nie angelegte Datei ALS AUCH fuer einen leeren Override
    `{}` — und `setze_datei` schreibt IMMER, auch wenn jeder Parameter `None` ist (gemessen
    am 2026-08-20). Ein Test gegen den aufgeloesten Wert kann den Waechter in `upload_audio`
    also gar nicht beobachten: faellt er weg, schriebe JEDER Upload einen leeren Override in
    `projekt.json`, unter dem projektweiten Lock, bei jedem Request — und die Suite bliebe
    gruen. Genau so stand es hier, gefunden vom Reviewer-Subagenten am Gate A.
    """
    from webtool import projekt as projekt_mod
    r = client.post("/api/projects/Demo/audio", files={"file": ("Ohne.mp3", b"a", "audio/mpeg")})
    assert r.status_code == 200
    assert "Ohne" not in projekt_mod.laden("Demo")["dateien"]
    assert projekt_mod.datei_ansicht("Demo", "Ohne")["sprecher"] is None


def test_upload_lehnt_sprecherzahl_ausserhalb_des_bereichs_ab(client, tmp_path):
    """Trust-Boundary (#264): der Wert geht ungefiltert an pyannote. Und die Pruefung laeuft
    VOR dem Schreiben — sonst laege bei 400 eine verwaiste Audiodatei im Projekt."""
    r = client.post("/api/projects/Demo/audio",
                    files={"file": ("Zuviel.mp3", b"a", "audio/mpeg")}, data={"sprecher": "0"})
    assert r.status_code == 400 and "sprecher" in r.json()["detail"]
    assert not (tmp_path / "Demo" / "audio" / "Zuviel.mp3").exists()


def _fetch_env_faenger(monkeypatch):
    """jobs.start faelschen und die uebergebene Subprozess-Umgebung einsammeln."""
    gesehen = {}
    import webtool.jobs as jobs_mod

    def fake_start(project, cmd, cwd, kind, then=None, env=None):
        gesehen.update(env or {})
        gesehen["_cmd"] = cmd
        return "f1", True

    monkeypatch.setattr(jobs_mod, "start", fake_start)
    return gesehen


def test_fetch_reicht_eine_sprecherzahl_JE_URL_durch(client, tmp_projekt, monkeypatch):
    """`fetch.py` kennt den Basisnamen erst nach dem Download — die Zahl reist deshalb wie die
    Sprache per Env, aber als LISTE: „meist gemischt" gilt beim URL-Import genauso."""
    gesehen = _fetch_env_faenger(monkeypatch)
    r = client.post(f"/api/projects/{tmp_projekt}/fetch",
                    json={"urls": ["https://youtu.be/aaaaaaaaaaa", "https://youtu.be/bbbbbbbbbbb"],
                          "sprecher": [2, 5]})
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_SPRECHER"] == "2,5"


def test_fetch_leere_url_zeilen_verschieben_die_zuordnung_NICHT(client, tmp_projekt, monkeypatch):
    """Der Endpunkt wirft leere URL-Zeilen weg. Wuerde die Sprecher-Liste danach unveraendert
    uebernommen, landete ab der ersten Leerzeile JEDE Zahl bei der falschen Aufnahme — die 5
    des Teamgespraechs beim 2er-Interview. Gefiltert wird deshalb PAARWEISE."""
    gesehen = _fetch_env_faenger(monkeypatch)
    r = client.post(f"/api/projects/{tmp_projekt}/fetch",
                    json={"urls": ["  ", "https://youtu.be/aaaaaaaaaaa", "https://youtu.be/bbbbbbbbbbb"],
                          "sprecher": [None, 2, 5]})
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_SPRECHER"] == "2,5"


def test_fetch_ohne_sprecherzahlen_neutralisiert_einen_altwert_aus_der_umgebung(
        client, tmp_projekt, monkeypatch):
    """Kein Feld heisst „automatisch" — und das muss eine Altlast in der Umgebung SCHLAGEN.

    Der Subprozess erbt `os.environ` des Servers (`jobs._run_proc`), und eine
    `TRANSKRIBOR_FETCH_SPRECHER`-Zeile in der `.env` gewinnt dort. Waere der Schluessel bei
    fehlendem Feld gar nicht gesetzt, bekaeme ein Browser-Import die Zahl eines alten
    CLI-Tests — ein plausibler Wert wie „3" kommt durch jede Bereichspruefung, und die Folge
    waeren falsche Cluster ohne eine einzige Fehlermeldung. Ein leerer Wert loest in
    `_sprecher_aus_env` zu None auf, das Legacy-Verhalten bleibt also erhalten.
    (Fund des Reviewer-Subagenten am Gate A.)
    """
    gesehen = _fetch_env_faenger(monkeypatch)
    client.post(f"/api/projects/{tmp_projekt}/fetch",
                json={"urls": ["https://youtu.be/aaaaaaaaaaa"]})
    assert gesehen["TRANSKRIBOR_FETCH_SPRECHER"] == ""
    from webtool import fetch as fetch_mod
    assert fetch_mod._sprecher_aus_env(gesehen["TRANSKRIBOR_FETCH_SPRECHER"], 0) is None


def test_fetch_lehnt_falsche_listenlaenge_ab(client, tmp_projekt):
    """Eine kuerzere Liste waere kein harmloser Teil-Auftrag, sondern eine stille
    Fehlzuordnung ab dem ersten fehlenden Eintrag."""
    r = client.post(f"/api/projects/{tmp_projekt}/fetch",
                    json={"urls": ["https://youtu.be/aaaaaaaaaaa", "https://youtu.be/bbbbbbbbbbb"],
                          "sprecher": [2]})
    assert r.status_code == 400 and "sprecher" in r.json()["detail"]


def test_fetch_lehnt_sprecherzahl_ausserhalb_des_bereichs_ab(client, tmp_projekt):
    """Dieselbe Trust-Boundary wie beim Upload und am PUT — geprueft am Endpunkt, weil
    `fetch.py` sie erst im Subprozess eintraegt (ein spaetes Scheitern liesse den Download
    erst laufen; dieselbe Begruendung wie bei der Sprache)."""
    r = client.post(f"/api/projects/{tmp_projekt}/fetch",
                    json={"urls": ["https://youtu.be/aaaaaaaaaaa"], "sprecher": [99]})
    assert r.status_code == 400 and "sprecher" in r.json()["detail"]


# --- Sprache je URL (Material-Dialog, Task 2) ---------------------------------

def test_fetch_nimmt_eine_sprache_je_url(client, monkeypatch):
    """Gemischtsprachige Projekte sind vorgesehen (`projekt.json` haelt `sprache` je Base) —
    der URL-Weg konnte als einziger nur EINEN Wert fuer den ganzen Auftrag."""
    from webtool import jobs
    gesehen = {}
    monkeypatch.setattr(jobs, "start",
                        lambda *a, env=None, **k: gesehen.update(env or {}) or ("j1", True))
    r = client.post("/api/projects/Demo/fetch",
                    json={"urls": ["https://youtu.be/aaa", "https://youtu.be/bbb"],
                          "sprache": ["ch", "en"]})
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_SPRACHE"] == "ch,en"


def test_fetch_weist_eine_falsch_lange_sprachliste_mit_400_ab(client):
    """400, nicht 500. Ohne eigene Laengenpruefung feuert `zip(..., strict=True)` einen
    rohen ValueError — ausgerechnet an der Stelle, deren Zweck eine saubere Meldung ist."""
    r = client.post("/api/projects/Demo/fetch",
                    json={"urls": ["https://youtu.be/aaa", "https://youtu.be/bbb"],
                          "sprache": ["ch"]})
    assert r.status_code == 400
    assert "sprache" in r.json()["detail"]


def test_fetch_gibt_400_statt_500_bei_unbekannter_sprache_IN_DER_LISTE(client, monkeypatch):
    """Die alte Einzelpruefung `pruef_fehler(sprache=body.sprache)` WIRFT bei einer Liste:
    `sprache not in SPRACHEN` ist ein dict-Lookup -> `TypeError: unhashable type`. Sie muss
    durch die Schleife ERSETZT werden, nicht ergaenzt. (Fund des Faktenpruefer-Subagenten,
    dessen Bericht aus dem Transkript geborgen wurde.)"""
    from webtool import jobs
    gestartet = []
    monkeypatch.setattr(jobs, "start", lambda *a, **k: gestartet.append(1) or ("j1", True))
    r = client.post("/api/projects/Demo/fetch",
                    json={"urls": ["https://youtu.be/aaa", "https://youtu.be/bbb"],
                          "sprache": ["ch", "klingonisch"]})
    assert r.status_code == 400
    assert "klingonisch" in r.json()["detail"]
    assert gestartet == []


def test_fetch_setzt_den_sprach_schluessel_IMMER(client, monkeypatch):
    """#298: `jobs._run_proc` baut {**os.environ, **job_env(), **env} — das explizite `env`
    gewinnt. Der Durchschlag entsteht durch das BEDINGTE Setzen: fehlt der Schluessel,
    ueberlebt ein Altwert aus der `.env`. Mit der Liste kollabierte er ALLE
    Datei-Entscheidungen auf einen einzigen Wert — still, mit Erfolgsmeldung."""
    from webtool import jobs
    gesehen = {}
    monkeypatch.setattr(jobs, "start",
                        lambda *a, env=None, **k: gesehen.update(env or {}) or ("j1", True))
    monkeypatch.setenv("TRANSKRIBOR_FETCH_SPRACHE", "en")        # Altlast
    r = client.post("/api/projects/Demo/fetch", json={"urls": ["https://youtu.be/aaa"]})
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_SPRACHE"] == "", \
        "der Schluessel muss gesetzt sein, sonst gewinnt die Altlast aus os.environ"
    # Benannte Luecke: gemessen wird bis zur `jobs.start`-Attrappe. Das Glied dahinter — ob ein
    # leerer Wert im `env`-Dict einen GEERBTEN Wert auf Windows wirklich ueberschreibt statt zu
    # verschwinden — haengt an CreateProcess, nicht an unserem Code. Im Review mit einem echten
    # Kindprozess nachgemessen: Kind sieht `''`, nicht `'en'`. Ein Waechter dafuer gehoerte nach
    # test_jobs.py (echter Popen), einmal fuer beide Variablen.


def test_fetch_einzelner_sprachwert_gilt_fuer_alle_urls(client, monkeypatch):
    """Rueckwaertskompatibel: ein String (kein Array) behaelt seine bisherige Bedeutung.
    Er wird VOR dem `zip` auf die Zahl der URLs expandiert — andersherum braeche
    `strict=True`, und ohne `strict` waere es schlimmer: still gekuerzt heisst hier
    verschobene Zuordnung."""
    from webtool import jobs
    gesehen = {}
    monkeypatch.setattr(jobs, "start",
                        lambda *a, env=None, **k: gesehen.update(env or {}) or ("j1", True))
    r = client.post("/api/projects/Demo/fetch",
                    json={"urls": ["https://youtu.be/aaa", "https://youtu.be/bbb"],
                          "sprache": "fr"})
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_SPRACHE"] == "fr,fr"


def test_fetch_filtert_urls_und_sprachen_PAARWEISE(client, monkeypatch):
    """Leere URL-Zeilen fielen sonst nur auf einer Seite weg und verschoeben ab da JEDE
    Zuordnung — dieselbe Falle, die bei `sprecher` schon zugeschlagen hat."""
    from webtool import jobs
    gesehen = {}
    monkeypatch.setattr(jobs, "start",
                        lambda *a, env=None, **k: gesehen.update(env or {}) or ("j1", True))
    r = client.post("/api/projects/Demo/fetch",
                    json={"urls": ["https://youtu.be/aaa", "  ", "https://youtu.be/ccc"],
                          "sprache": ["ch", "de", "en"]})
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_SPRACHE"] == "ch,en"


def test_export_project_downloads_erstellt_ordner_und_dateien(client, tmp_path, monkeypatch):
    """POST /api/projects/{p}/export/downloads legt Downloads/<Projekt> an und speichert alle .md-Dateien."""
    monkeypatch.setenv("TRANSKRIBOR_DOWNLOADS", str(tmp_path / "Downloads"))
    r = client.post("/api/projects/Demo/export/downloads")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["anzahl"] >= 1
    assert "S1.md" in data["dateien"]
    ziel_ordner = tmp_path / "Downloads" / "Demo"
    assert ziel_ordner.is_dir()
    md_file = ziel_ordner / "S1.md"
    assert md_file.is_file()
    assert len(md_file.read_text(encoding="utf-8")) > 0


def test_export_project_zip_liefert_archiv(client):
    """GET /api/projects/{p}/export/zip liefert ein gueltiges ZIP mit den .md-Dateien."""
    import zipfile, io
    r = client.get("/api/projects/Demo/export/zip")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert 'attachment; filename="Demo_markdown.zip"' in r.headers["content-disposition"]
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    namelist = zf.namelist()
    assert "S1.md" in namelist
    content = zf.read("S1.md").decode("utf-8")
    assert len(content) > 0


def test_export_file_md_download(client):
    """GET /api/projects/{p}/files/{b}/export/md liefert das einzelne Markdown-Dokument als Download."""
    r = client.get("/api/projects/Demo/files/S1/export/md")
    assert r.status_code == 200
    assert "text/markdown" in r.headers["content-type"]
    assert 'attachment; filename="S1.md"' in r.headers["content-disposition"]
    assert len(r.text) > 0


def test_export_file_md_unknown_404(client):
    r = client.get("/api/projects/Demo/files/unbekannt_xyz/export/md")
    assert r.status_code == 404


def test_export_project_downloads_unknown_project_404(client):
    r = client.post("/api/projects/Unbekannt_xyz/export/downloads")
    assert r.status_code == 404


def test_export_project_zip_unknown_project_404(client):
    r = client.get("/api/projects/Unbekannt_xyz/export/zip")
    assert r.status_code == 404



# ---- #451: eine Aufnahme wird GANZ angefasst oder gar nicht ----
# Drei Endpunkte fassen die Dateien EINER Aufnahme in einer Schleife an. Haelt ein Lauf eine
# davon offen, brach die Schleife mittendrin ab: 500, und die Aufnahme gab es halb (gemessen —
# beim Umbenennen lag `A_fremd_neu.json` neben `A_fremd.raw.txt`).
#
# WARUM `os.rename` gefaelscht wird statt ein echtes Handle zu halten: die Sperre gibt es NUR
# auf Windows. Auf POSIX verhindert ein offener Griff weder rename noch unlink, die Schleife
# gelingt dort immer — ein Test mit echtem Handle waere in der Linux-CI still gruen, ohne je
# den Zweig zu betreten, um den es geht. Gefaelscht wird deshalb die Grenze, an der unsere
# Logik haengt; die Wirklichkeit dahinter deckt der Windows-Test darunter und die Messung am
# echten Pfad ab.


def _rename_faellt_aus_bei(monkeypatch, name_teil):
    """Echtes `os.rename`, aber fuer eine bestimmte Datei `PermissionError` — wie WinError 32.
    Der Ruecklauf laeuft ueber dieselbe Funktion und muss durchkommen: er benennt die schon
    beiseitegelegten Dateien zurueck, deren Quellname den Teil nicht traegt."""
    echt = os.rename
    versucht = []

    def fake(src, dst):
        versucht.append(os.path.basename(src))
        if os.path.basename(src).startswith(name_teil):
            raise PermissionError(32, "Der Prozess kann nicht auf die Datei zugreifen")
        return echt(src, dst)

    monkeypatch.setattr(os, "rename", fake)
    return versucht


def _bestand(tmp_path):
    p = tmp_path / "Demo"
    return sorted([f.name for f in (p / "transkripte").iterdir()]
                  + [f.name for f in (p / "audio").iterdir()])


def test_loeschen_bei_belegter_datei_gibt_409_und_dreht_zurueck(client, monkeypatch, tmp_path):
    """Die Roh-JSON wird beiseitegelegt, das Audio ist belegt -> NICHTS darf weg sein."""
    vorher = _bestand(tmp_path)
    assert "S1.json" in vorher and "S1.mp3" in vorher      # Vorbedingung: zwei Dateien
    versucht = _rename_faellt_aus_bei(monkeypatch, "S1.mp3")

    r = client.delete("/api/projects/Demo/files/S1")

    assert r.status_code == 409, r.text
    assert "S1" in r.json()["detail"] and "Benutzung" in r.json()["detail"]
    # Vorbedingung: es wurde wirklich erst umbenannt und dann zurueckgedreht — sonst
    # zeigte der Bestand unten nur, dass gar nichts passiert ist.
    assert len(versucht) >= 3, versucht
    assert _bestand(tmp_path) == vorher, "Ruecklauf unvollstaendig — halb geloeschte Aufnahme"


def test_neu_transkribieren_bei_belegter_datei_gibt_409_und_dreht_zurueck(client, monkeypatch,
                                                                         tmp_path):
    """Derselbe Loeschpfad, anderer Endpunkt (#451: `retranscribe_file` ruft `_datei_weg`).

    Hier raeumt `_datei_weg` mit `mit_audio=False` — das Audio bleibt absichtlich stehen, es
    wird ja gleich wieder transkribiert. Der Test legt deshalb ein ZWEITES Transkript-Artefakt
    an: sonst gaebe es nur eine Datei, der Ruecklauf haette nichts zu tun und die Zusicherung
    unten waere die halbe."""
    (tmp_path / "Demo" / "transkripte" / "S1.edit.json").write_text("{}", encoding="utf-8")
    vorher = _bestand(tmp_path)
    # `_datei_weg` sortiert seine Trefferliste, `S1.edit.json` kommt also vor `S1.json` —
    # verlassen darf man sich darauf erst, seit dort `sorted()` steht: `glob.glob` liefert
    # laut Doku eine beliebige, dateisystemabhaengige Reihenfolge.
    versucht = _rename_faellt_aus_bei(monkeypatch, "S1.json")

    r = client.post("/api/projects/Demo/files/S1/transcribe")

    assert r.status_code == 409, r.text
    assert len(versucht) >= 3, versucht          # beiseitegelegt, gescheitert, zurueckgedreht
    assert _bestand(tmp_path) == vorher, "halb geloeschte Aufnahme beim Neu-Transkribieren"


def test_umbenennen_bei_belegter_datei_gibt_409_und_dreht_zurueck(client, monkeypatch, tmp_path):
    """Der schlimmste der drei: hier entstand eine Aufnahme, die es ZWEIMAL HALB gab —
    `S1_neu.json` neben `S1.mp3`. Genau das schliesst der Docstring von `rename_file` aus."""
    vorher = _bestand(tmp_path)
    _rename_faellt_aus_bei(monkeypatch, "S1.mp3")

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 409, r.text
    assert _bestand(tmp_path) == vorher, "Aufnahme liegt halb unter dem neuen Namen"
    assert not any(n.startswith("S1_neu") for n in _bestand(tmp_path))


@pytest.mark.skipif(os.name != "nt", reason="Nur Windows sperrt offene Dateien (POSIX nicht)")
def test_loeschen_bei_ECHT_offener_datei_gibt_409(client, tmp_path):
    """Wirklichkeitsprobe ohne Attrappe — laeuft in der Linux-CI nie (dort gibt es die Sperre
    nicht). Gemessen: ein offener Lesegriff laesst weder rename noch unlink zu, beide mit
    `PermissionError [WinError 32]`."""
    vorher = _bestand(tmp_path)
    with open(tmp_path / "Demo" / "transkripte" / "S1.json", encoding="utf-8"):
        r = client.delete("/api/projects/Demo/files/S1")
    assert r.status_code == 409, r.text
    assert _bestand(tmp_path) == vorher


def test_loeschen_raeumt_liegengebliebene_reservierung_der_audio_seite_weg(client, tmp_path):
    """Ein abgestuerzter Loeschlauf laesst `S1.mp3.<id>.weg` im audio-Ordner liegen.

    Die Aufraeum-Regel der Transkriptseite (`<base>.*`) laeuft nur ueber `transkripte/`, und
    `find_audio` sucht exakte `base + ext`-Namen — ohne eine eigene Regel bliebe ausgerechnet
    die groesste Datei einer Aufnahme unsichtbar und dauerhaft liegen.
    """
    adir = tmp_path / "Demo" / "audio"
    (adir / "S1.mp3.deadbeef.weg").write_bytes(b"grosse Tonspur aus einem abgestuerzten Lauf")
    # BEIDE Seiten, denn es sind zwei getrennte Codezweige: der transkripte-Rest faellt aus dem
    # `<base>.*`-Glob, der audio-Rest aus einem eigenen Muster. Nur einen zu pruefen liesse den
    # anderen unbewacht — bei der Mutationsprobe genau so aufgefallen.
    (tmp_path / "Demo" / "transkripte" / "S1.json.cafe1234.weg").write_text("{}", encoding="utf-8")

    r = client.delete("/api/projects/Demo/files/S1")

    assert r.status_code == 200, r.text
    rest = [p.name for p in adir.iterdir()]
    assert rest == [], f"Reservierung im audio-Ordner liegengeblieben: {rest}"
    trest = [p.name for p in (tmp_path / "Demo" / "transkripte").iterdir()]
    assert trest == [], f"Reservierung im transkripte-Ordner liegengeblieben: {trest}"
    # Der Rest wird WEGGERAEUMT, aber NICHT MITGEZAEHLT: `geloescht` beschreibt die Dateien der
    # Aufnahme (S1.json + S1.mp3), nicht Ueberbleibsel eines frueheren Laufs. An derselben Zahl
    # haengt die 404-Entscheidung — eine Aufnahme, von der nur noch Reste da sind, meldete sonst
    # „1 geloescht" statt 404 (Bot-Befund an #460).
    assert r.json()["geloescht"] == 2, r.json()


def test_loeschen_wiederholt_ein_voruebergehend_gesperrtes_entfernen(client, monkeypatch,
                                                                    tmp_path):
    """Ein Scanner greift die eben umbenannte Datei — das ist auf Windows der Normalfall unter
    Konkurrenz, kein Defekt (dieselbe Regel wie `sperre._HAKELIG_S`). Ohne Wiederholung bliebe
    sie als unsichtbarer Rest liegen (#459)."""
    echt_remove = os.remove
    geklemmt = []

    def flaky(pfad, *a, **kw):
        if str(pfad).endswith(".weg") and len(geklemmt) < 2:
            geklemmt.append(str(pfad))
            raise PermissionError(32, "kurz belegt")
        return echt_remove(pfad, *a, **kw)

    monkeypatch.setattr(os, "remove", flaky)

    r = client.delete("/api/projects/Demo/files/S1")

    assert r.status_code == 200, r.text
    # Vorbedingung: es hat wirklich geklemmt — sonst misst der Test die Wiederholung nicht.
    assert len(geklemmt) == 2, geklemmt
    assert _bestand(tmp_path) == [], f"Rest trotz Wiederholung: {_bestand(tmp_path)}"


def test_ruecklauf_ueberschreibt_eine_neu_entstandene_datei_nicht(client, monkeypatch, tmp_path):
    """Der Ruecklauf ist der einzige neue SCHREIBpfad — er darf nichts ueberbuegeln.

    Ein Autosave (alle 800 ms) kann in das Fenster zwischen Reservierung und Fehlschlag eine
    frische `edit.json` schreiben — und zwar TROTZ der Sperre, die `retranscribe_file` seit
    Runde 6 haelt (`app.py:861`): der Autosave schreibt nicht gegen ein Lock, sondern gegen den
    PFAD. Bis Runde 7 stand hier „`retranscribe_file` nimmt keine `sperre.datei`"; das war seit
    Runde 6 falsch und widersprach `test_neu_transkribieren_ohne_sperre_gibt_503` zwei
    Bildschirme weiter unten. Auf POSIX
    ersetzt `os.rename` ein vorhandenes Ziel STILL, der Ruecklauf naehme die frische Fassung
    also mit. Der Test bildet diese POSIX-Semantik auf Windows nach (dort wuerde `os.rename`
    von sich aus scheitern) — sonst waere er auf der einen Plattform gruen und auf der anderen
    blind fuer genau den Fall, um den es geht."""
    tdir = tmp_path / "Demo" / "transkripte"
    (tdir / "S1.edit.json").write_text('{"alt": true}', encoding="utf-8")
    echt_rename, echt_replace = os.rename, os.replace

    def fake(src, dst):
        name = os.path.basename(src)
        if name.startswith("S1.json"):                 # zweite Reservierung scheitert
            raise PermissionError(32, "belegt")
        if name.endswith(".weg"):                      # RUECKLAUF: POSIX-Semantik nachbilden
            return echt_replace(src, dst)
        echt_rename(src, dst)
        if name == "S1.edit.json":                     # fremder Schreibvorgang im Fenster
            (tdir / "S1.edit.json").write_text('{"frisch": true}', encoding="utf-8")

    monkeypatch.setattr(os, "rename", fake)

    r = client.post("/api/projects/Demo/files/S1/transcribe")

    assert r.status_code == 409, r.text
    inhalt = (tdir / "S1.edit.json").read_text(encoding="utf-8")
    assert "frisch" in inhalt, f"Ruecklauf hat den fremden Schreibvorgang ueberbuegelt: {inhalt}"


def test_ein_anderer_fehler_wird_nicht_als_in_benutzung_beschriftet(client, monkeypatch,
                                                                   tmp_path):
    """Nur ein BELEGTER Zugriff bekommt „bitte warten" — der Rat muss stimmen.

    Die Reservierung haengt 13 Zeichen an (`.<8hex>.weg`); eine Datei nahe der 260er-Pfadgrenze
    liess sich vorher loeschen und scheiterte danach bei JEDEM Versuch. Als 409 „bitte warten"
    beschriftet waere das ein dauerhaft falscher Rat — dieselbe Lehre, die `_dateistand` in
    dieser Datei schon einmal bezahlt hat (`except OSError` deckte auch einen zu langen Pfad).
    Der Ruecklauf gilt trotzdem: Atomik darf nicht von der Ursache abhaengen.
    """
    import errno as _errno
    echt_rename = os.rename

    def fake(src, dst):
        if os.path.basename(src).startswith("S1.mp3"):
            # EIO, NICHT ENAMETOOLONG: fuer den langen Pfad gibt es seit dem Bot-Befund
            # einen eigenen Rueckfall (direkt loeschen). Hier geht es um „jeder ANDERE
            # OSError fliegt weiter" — dafuer braucht es einen Fehler ohne Sonderweg.
            raise OSError(_errno.EIO, "Ein-/Ausgabefehler")
        return echt_rename(src, dst)

    monkeypatch.setattr(os, "rename", fake)
    vorher = _bestand(tmp_path)

    with pytest.raises(OSError) as fehler:
        client.delete("/api/projects/Demo/files/S1")

    # Der ORIGINALFEHLER muss unveraendert durchkommen. `isinstance(..., PermissionError)`
    # waere hier eine Zusicherung ueber NICHTS: Python bildet `ENAMETOOLONG` auf keine
    # OSError-Unterklasse ab, die Zeile koennte also gar nicht rot werden (Bot-Befund an #460).
    assert fehler.value.errno == _errno.EIO, fehler.value
    assert _bestand(tmp_path) == vorher, "Ruecklauf muss auch bei fremdem Fehler laufen"


def test_ruecklauf_legt_beim_umbenennen_unsichtbar_beiseite(client, monkeypatch, tmp_path):
    """Ein übersprungener Rücklauf darf keine SICHTBARE halbe Aufnahme hinterlassen.

    `rename_file` gibt Ziele OHNE `.weg` herein. Ist der alte Platz beim Rücklauf wieder belegt,
    wird nicht zurückbenannt (sonst überbügelte man den fremden Schreibvorgang) — die schon
    umbenannte Datei bliebe dann aber unter dem NEUEN Namen in jeder Auflistung stehen, also
    genau der Zustand, den `_umbenennen_oder_keines` ausschliesst. Sie gehört in den
    unsichtbaren Namensraum, und der Fall gehört ins Protokoll (Bot-Befund an #460).
    """
    tdir = tmp_path / "Demo" / "transkripte"
    (tdir / "S1.edit.json").write_text('{"alt": true}', encoding="utf-8")
    echt_rename = os.rename

    def fake(src, dst):
        name = os.path.basename(src)
        if name.startswith("S1.json"):                 # zweite Reservierung scheitert
            raise PermissionError(32, "belegt")
        echt_rename(src, dst)
        if name == "S1.edit.json":                     # fremder Schreibvorgang belegt den Platz
            (tdir / "S1.edit.json").write_text('{"frisch": true}', encoding="utf-8")

    monkeypatch.setattr(os, "rename", fake)

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 409, r.text
    namen = sorted(p.name for p in tdir.iterdir())
    # Vorbedingung: der fremde Schreibvorgang steht noch — sonst misst der Test den anderen Zweig.
    assert "frisch" in (tdir / "S1.edit.json").read_text(encoding="utf-8")
    assert not any(n.startswith("S1_neu") for n in namen), f"sichtbare halbe Aufnahme: {namen}"
    beiseite = [n for n in namen if n.endswith(".weg")]
    assert beiseite, f"nicht beiseitegelegt: {namen}"
    # Und der Name kommt aus DERSELBEN Quelle wie die Reservierung (#459) — hier gemessen am
    # VERHALTEN, nicht am Quelltext. Der erste Versuch zaehlte `_weg_suffix()`-Vorkommen im
    # Modul und war VACUOUS: die `def`-Zeile zaehlt mit, `>= 2` hielt also schon mit einem
    # einzigen Aufrufer. Der gegnerische Pruefer hat die Mutation gefahren (Ruecklauf mit
    # eigenem Literal) und den Test gruen gesehen.
    #
    # Ohne den Stempel faende der Aufraeumlauf diese Datei zwar auch (kein Stempel = alt),
    # aber sofort statt nach der Frist — die Sicherungskopie waere beim naechsten Start weg,
    # egal wie frisch sie ist.
    import webtool.app as _appmod
    alter = _appmod._weg_alter(beiseite[0])
    assert alter is not None, f"der Ruecklauf baut den Namen selbst: {beiseite[0]}"
    assert alter < 60, f"Stempel unplausibel alt: {alter}"


# `glob.glob` liefert laut Doku eine BELIEBIGE Reihenfolge; gemessen liefert ext4 die
# Anlage-Reihenfolge und NTFS die alphabetische. Ein Test, der sich auf die Reihenfolge des
# WIRTS verlaesst, ist auf einer Plattform gruen und auf der anderen rot — genau so ist die
# fehlende Sortierung in `rename_file` durch Windows-Tests UND einen gruenen CodeRabbit-Lauf
# gerutscht und erst im ubuntu-Bein aufgefallen. Die beiden Tests hier geben die Reihenfolge
# deshalb VERDREHT vor und pruefen, dass der Code sie sortiert: damit haengt der Sensor an
# keiner Plattform mehr.

def _glob_verdreht(monkeypatch):
    """Kehrt die Reihenfolge jedes glob-Ergebnisses um — der ungünstigste Wirt."""
    from webtool import app as app_mod
    echt = app_mod.glob.glob
    monkeypatch.setattr(app_mod.glob, "glob",
                        lambda *a, **kw: list(reversed(sorted(echt(*a, **kw)))))


def _rename_reihenfolge(monkeypatch):
    """Protokolliert, in welcher Reihenfolge tatsaechlich umbenannt wird."""
    reihenfolge = []
    echt = os.rename

    def merken(src, dst):
        reihenfolge.append(os.path.basename(src))
        return echt(src, dst)

    monkeypatch.setattr(os, "rename", merken)
    return reihenfolge


def test_umbenennen_sortiert_die_trefferliste_unabhaengig_vom_wirt(client, monkeypatch, tmp_path):
    """`rename_file` muss die Reihenfolge selbst festlegen, nicht das Dateisystem."""
    (tmp_path / "Demo" / "transkripte" / "S1.edit.json").write_text("{}", encoding="utf-8")
    _glob_verdreht(monkeypatch)
    reihenfolge = _rename_reihenfolge(monkeypatch)

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 200, r.text
    assert reihenfolge[0] == "S1.edit.json", (
        f"nicht sortiert — die Reihenfolge kam vom Wirt: {reihenfolge}")


def test_loeschen_sortiert_die_trefferliste_unabhaengig_vom_wirt(client, monkeypatch, tmp_path):
    """Dasselbe fuer `_datei_weg` — zwei getrennte Globs, zwei getrennte Sensoren."""
    (tmp_path / "Demo" / "transkripte" / "S1.edit.json").write_text("{}", encoding="utf-8")
    _glob_verdreht(monkeypatch)
    reihenfolge = _rename_reihenfolge(monkeypatch)

    r = client.delete("/api/projects/Demo/files/S1")

    assert r.status_code == 200, r.text
    assert reihenfolge[0] == "S1.edit.json", (
        f"nicht sortiert — die Reihenfolge kam vom Wirt: {reihenfolge}")


def test_umbenennen_laesst_liegengebliebene_reste_liegen(client, tmp_path):
    """Ein `.weg`-Rest wandert seit #459 NICHT mehr mit — und das ist die Ruecknahme einer
    frueheren Entscheidung mit ihrer eigenen Begruendung.

    Er wanderte mit, WEIL er sonst unter dem alten Basisnamen dauerhaft verwaist waere
    („niemand loescht den alten Namen je wieder"). Diese Praemisse hat der Aufraeumlauf
    aufgehoben: er faengt Reste unabhaengig vom Basisnamen.

    Und das Mitwandern war seitdem nicht nur ueberfluessig, sondern SCHAEDLICH: der Startlauf
    loescht ohne die `sperre.datei` dieses Endpunkts. Raeumt er einen Rest zwischen Glob und
    `os.rename` weg, wirft `_umbenennen_oder_keines` einen `FileNotFoundError` — kein
    `PermissionError`, also 500 fuer ein Umbenennen, das ohne den Rest gelungen waere. Der
    kalte Diff-Leser hat dieses Interleaving deterministisch erzwungen und den 500er gemessen.
    """
    tdir = tmp_path / "Demo" / "transkripte"
    (tdir / "S1.json.cafe1234.weg").write_text("{}", encoding="utf-8")

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 200, r.text
    assert r.json()["umbenannt"] == 2, r.json()          # S1.json + S1.mp3
    namen = sorted(p.name for p in tdir.iterdir())
    assert namen == ["S1.json.cafe1234.weg", "S1_neu.json"], namen


def test_ein_verschwindender_rest_kippt_das_umbenennen_nicht(client, tmp_path, monkeypatch):
    """Die Zusicherung hinter der Aenderung darueber, am Mechanismus statt am Ergebnis: raeumt
    der Aufraeumlauf mitten im Umbenennen einen Rest weg, darf das den Endpunkt nicht kippen.

    Nachgestellt, indem der Rest zwischen Glob und `os.rename` verschwindet — genau das
    Interleaving, das der kalte Diff-Leser erzwungen hat. Steht der Rest nicht mehr in
    `paare`, ist es folgenlos; stuende er drin, gaebe es hier einen 500er."""
    tdir = tmp_path / "Demo" / "transkripte"
    rest = tdir / "S1.json.cafe1234.weg"
    rest.write_text("{}", encoding="utf-8")
    echt_rename = os.rename

    def raeumt_dazwischen(src, dst):
        if rest.exists():
            rest.unlink()            # der Startfaden schlaegt zu
        return echt_rename(src, dst)

    monkeypatch.setattr(os, "rename", raeumt_dazwischen)

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 200, f"ein weggeraeumter Rest hat das Umbenennen gekippt: {r.text}"
    assert sorted(p.name for p in tdir.iterdir()) == ["S1_neu.json"]


def test_loeschen_bei_zu_langem_pfad_loescht_direkt_statt_500(client, monkeypatch, tmp_path):
    """Die Reservierung haengt 13 Zeichen an — nahe der 260er-Pfadgrenze kippt sie, waehrend
    `os.remove` noch ginge. Vor dem Rueckfall war die Aufnahme damit dauerhaft unloeschbar
    (Bot-Befund an #460). Der Preis ist benannt: fuer DIESEN Fall gilt Alles-oder-nichts nicht."""
    import errno as _errno
    echt_rename = os.rename

    def zu_lang(src, dst):
        if dst.endswith(".weg"):
            raise OSError(_errno.ENAMETOOLONG, "Dateiname zu lang")
        return echt_rename(src, dst)

    monkeypatch.setattr(os, "rename", zu_lang)

    r = client.delete("/api/projects/Demo/files/S1")

    assert r.status_code == 200, r.text
    assert _bestand(tmp_path) == [], f"nicht geloescht: {_bestand(tmp_path)}"


def test_neu_transkribieren_ohne_sperre_gibt_503(client, monkeypatch, tmp_path):
    """`retranscribe_file` haelt seit dem `.weg`-Namensraum dieselbe Sperre wie `delete_file`:
    `_keine_jobs` schuetzt gegen JOBS, nicht gegen den anderen ENDPUNKT — ein gleichzeitiges
    DELETE koennte sonst die laufende Reservierung wegraeumen (Bot-Befund an #460)."""
    import contextlib
    from webtool import sperre

    @contextlib.contextmanager
    def keine_sperre(pfad, **kw):
        yield False

    monkeypatch.setattr(sperre, "datei", keine_sperre)

    r = client.post("/api/projects/Demo/files/S1/transcribe")

    assert r.status_code == 503, r.text
    assert (tmp_path / "Demo" / "transkripte" / "S1.json").exists(), "nichts angefasst"


def test_loeschen_deckelt_die_gesamte_wiederholungszeit(client, monkeypatch, tmp_path):
    """Die Wiederholungen laufen UNTER `sperre.datei`, und `stale` ist eine Zusage ueber die
    Haltedauer (#207). Ein Deckel je Datei reicht nicht — die Zahl der Artefakte ist durch
    `<base>.*` unbegrenzt. Hier klemmen fuenf Dateien; nach dem ERSTEN Schlaf ist das
    Gesamtbudget ueberschritten, danach darf nicht mehr gewartet werden."""
    from webtool import app as app_mod
    tdir = tmp_path / "Demo" / "transkripte"
    for i in range(5):
        (tdir / f"S1.teil{i}.json").write_text("{}", encoding="utf-8")
    echt_remove = os.remove

    def immer_belegt(pfad, *a, **kw):
        if str(pfad).endswith(".weg"):
            raise PermissionError(32, "belegt")
        return echt_remove(pfad, *a, **kw)

    uhr, schlaefe = {"t": 0.0}, []
    # `app_mod.time` IST das globale time-Modul — die Attrappe wirkt also prozessweit. Deshalb
    # ein eigener `MonkeyPatch.context()`: er raeumt am Ende des `with` auf, VOR jedem
    # Fixture-Teardown. Ohne ihn liefe der `client`-Teardown (`_warte`) noch mit gefaelschter
    # Uhr, und dessen Zusicherung „Modulzustand leckt nicht" maesse nichts mehr.
    # Die zweite prozessweite Beruehrung — `sperre.datei` schlaeft in seiner Warteschleife —
    # kommt hier nicht vor: die Sperre ist in einem frischen tmp_path unbestritten und
    # schlaeft deshalb kein einziges Mal. Das ist eine Eigenschaft der Fixture, keine
    # Zusicherung dieses Tests; wer die Fixture aendert, prueft es nach.
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(os, "remove", immer_belegt)
        mp.setattr(app_mod.time, "monotonic", lambda: uhr["t"])
        mp.setattr(app_mod.time, "sleep",
                   lambda s: (schlaefe.append(s), uhr.__setitem__("t", uhr["t"] + 10.0)))

        r = client.delete("/api/projects/Demo/files/S1")

    assert r.status_code == 200, r.text
    # Vorbedingung: es hat ueberhaupt geklemmt (sonst waere die Zusicherung leer).
    assert schlaefe, "kein einziger Wiederholungsversuch — der Test misst nichts"
    assert len(schlaefe) == 1, (
        f"nach dem Ueberschreiten des Budgets wurde weiter gewartet: {len(schlaefe)} Schlafphasen")


def test_umbenennen_faellt_nicht_ueber_lock_und_verzeichnis(client, tmp_path):
    """Der Glob trifft auch `<base>.edit.json.lock` (ein VERZEICHNIS, von `sperre` angelegt)
    und beliebige Unterordner — umbenannt werden duerfen sie nicht (Bot-Befund an #460)."""
    tdir = tmp_path / "Demo" / "transkripte"
    # NICHT `S1.edit.json.lock` nehmen — das ist seit Runde 7 der EIGENE Sperrpfad dieses
    # Endpunkts (`sperre.datei(_edit_path(...))`). Als Attrappe angelegt sieht er wie ein
    # verwaistes Lock aus: `sperre` sitzt die volle Frist ab (`STALTES_ALTER`, 60 s), greift
    # erzwungen zu und raeumt das Verzeichnis beim Freigeben weg — gemessen lief die Datei
    # dadurch 62 s statt 3 s, und die Zusicherung darunter fiel um. Ein `.lock` eines ANDEREN
    # Zielnamens prueft denselben Filter, ohne mit dem Mechanismus zu kollidieren.
    (tdir / "S1.md.lock").mkdir()                 # so legt `sperre.datei` es an: VERZEICHNIS
    (tdir / "S1.unterordner").mkdir()
    # Und eine `.lock`-DATEI. Ohne sie waere die `.lock`-Haelfte des Filters unbewacht: ein
    # Verzeichnis faellt schon an `os.path.isfile` heraus, `not p.endswith(".lock")` koennte
    # also entfernt werden und der Test bliebe gruen. Der Fall ist real — `sperre.py` behandelt
    # ausdruecklich „am Lock-Pfad liegt eine DATEI" (Sync-Client, Quarantaene).
    (tdir / "S1.raw.txt.lock").write_text("", encoding="utf-8")

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 200, r.text
    assert (tdir / "S1.md.lock").is_dir(), "Sperrverzeichnis wurde angefasst"
    assert (tdir / "S1.unterordner").is_dir(), "fremdes Verzeichnis wurde umbenannt"
    assert (tdir / "S1.raw.txt.lock").is_file(), "Sperr-DATEI wurde umbenannt"
    assert r.json()["umbenannt"] == 2, r.json()


def test_os_rename_behaelt_die_mtime(tmp_path):
    """Der Beleg fuer die Begruendung des Ruecklauf-Waechters — als Sensor statt als Behauptung.

    `_umbenennen_oder_keines` benennt nur zurueck, wenn der alte Platz noch frei ist. Die
    naheliegende Alternative waere eine ALTERSpruefung („ist die `.weg`-Datei alt genug, um sie
    gefahrlos anzufassen?") — und die traegt nicht, weil `os.rename` die mtime der Datei
    behaelt: eine soeben angelegte Reservierung sieht damit beliebig alt aus. Der Kommentar in
    `app.py` nennt das gemessen; hier steht die Messung, damit sie nicht bloss eine Behauptung
    im Fliesstext ist. Gilt auf beiden Plattformen — deshalb kein `skipif`.
    """
    import time as _time
    a, b = tmp_path / "a.txt", tmp_path / "b.txt"
    a.write_text("x", encoding="utf-8")
    vorher = a.stat().st_mtime
    _time.sleep(0.02)                     # echte Zeit vergeht zwischen Anlegen und Rename

    os.rename(a, b)

    assert abs(b.stat().st_mtime - vorher) < 0.001, (
        f"mtime nach dem Rename veraendert: {b.stat().st_mtime} statt {vorher} — "
        f"dann waere eine Alterspruefung doch moeglich und der Kommentar falsch")


def test_neu_transkribieren_ohne_transkripte_ordner_klappt(client, tmp_path):
    """Der Normalfall „noch nie transkribiert": `create_project` legt NUR `audio/` an.

    Die Sperre aus Runde 3 legt ihr Lock neben die `edit.json` und braucht dafuer das
    Elternverzeichnis — ohne `makedirs` scheitert `os.mkdir(lockdir)` mit `FileNotFoundError`,
    und ausgerechnet die ERSTE Transkription eines frisch hochgeladenen Projekts antwortete
    mit 503. `delete_file` legt das Verzeichnis seit je vorher an; beim Einbau der Sperre ist
    das Muster untergegangen (Bot-Befund an #460, Regression aus meiner eigenen Runde 3).
    """
    p = tmp_path / "NurAudio"
    (p / "audio").mkdir(parents=True)
    (p / "audio" / "A1.mp3").write_bytes(b"ID3fakeaudio")
    # Vorbedingung: es gibt WIRKLICH kein transkripte/ — sonst misst der Test nichts.
    assert not (p / "transkripte").exists()

    r = client.post("/api/projects/NurAudio/files/A1/transcribe")

    assert r.status_code == 200, r.text


def test_zu_langer_pfad_meldet_keinen_erfolg_wenn_nichts_verschwindet(client, monkeypatch,
                                                                     tmp_path):
    """Der `ENAMETOOLONG`-Rueckfall loescht direkt — dort behalten die Dateien ihre SICHTBAREN
    Namen. Scheitert das Loeschen, darf nicht „geloescht: N" gemeldet werden: im Hauptpfad
    traegt ein Rest einen `.weg`-Namen, den keine Auflistung kennt, hier steht die Aufnahme
    weiterhin vollstaendig da (Bot-Befund an #460)."""
    import errno as _errno
    echt_rename = os.rename

    def zu_lang(src, dst):
        if dst.endswith(".weg"):
            raise OSError(_errno.ENAMETOOLONG, "Dateiname zu lang")
        return echt_rename(src, dst)

    monkeypatch.setattr(os, "rename", zu_lang)
    echt_remove = os.remove

    def belegt(pfad, *a, **kw):
        # NUR die Dateien der Aufnahme klemmen. `sperre.datei` raeumt sein eigenes Lock
        # ebenfalls ueber `os.remove` ab — eine pauschale Attrappe liesse das Lock stehen
        # und der Test maesse den Riegel statt des Rueckfalls.
        if ".lock" in str(pfad):
            return echt_remove(pfad, *a, **kw)
        raise PermissionError(32, "belegt")

    monkeypatch.setattr(os, "remove", belegt)
    vorher = _bestand(tmp_path)

    r = client.delete("/api/projects/Demo/files/S1")

    assert r.status_code == 404, f"Erfolg gemeldet, obwohl nichts weg ist: {r.text}"
    assert _bestand(tmp_path) == vorher, "Bestand veraendert, obwohl 404"


def _oserror_mit_winerror(code):
    """Ein `OSError`, der `winerror` traegt — auf BEIDEN Plattformen.

    Auf Windows ueber die 4-Argument-Form, die `errno` aus `winerror` ableitet, genau wie
    CPython es im Ernstfall tut (`PC/errmap.h`). Auf POSIX gibt es die Form nicht, dort wird
    das Attribut gesetzt — damit laeuft der Test auch im ubuntu-Bein der CI und ist nicht der
    naechste Windows-Waechter, den dort nie jemand ausfuehrt (dieselbe Luecke wie #201).
    """
    if os.name == "nt":
        return OSError(0, "Zielname unbrauchbar", None, code)
    e = OSError(errno.EINVAL, "Zielname unbrauchbar")
    e.winerror = code
    return e


@pytest.mark.parametrize("winerror", [123, 206])
def test_unbrauchbarer_zielname_faellt_auf_direktes_loeschen_zurueck(client, monkeypatch,
                                                                    tmp_path, winerror):
    """Windows meldet einen zu langen Zielnamen NIE als `ENAMETOOLONG`.

    GEMESSEN auf dieser Maschine (Python 3.13.15, Windows 11): `os.rename` auf eine
    300-Zeichen-Komponente gibt `errno=22 (EINVAL)` mit `winerror=123`. Die urspruengliche
    Bedingung `e.errno == errno.ENAMETOOLONG` griff dort also NIE — der Rueckfall war auf der
    Plattform, fuer die er gebaut wurde, toter Code, und `delete_file` antwortete 500.
    206 (`ERROR_FILENAME_EXCED_RANGE`, laut `PC/errmap.h` auf `errno=ENOENT` abgebildet) ist
    der Gesamtpfad-Fall und HERGELEITET — auf dieser Maschine gelingt ein 276-Zeichen-Ziel,
    er ist hier also nicht herstellbar. Beide Codes muessen den Rueckfall ausloesen.
    """
    echt_rename = os.rename

    def zielname_unbrauchbar(src, dst):
        if dst.endswith(".weg"):
            raise _oserror_mit_winerror(winerror)
        return echt_rename(src, dst)

    monkeypatch.setattr(os, "rename", zielname_unbrauchbar)
    if os.name == "nt":                      # die Abbildung selbst festhalten, nicht glauben
        assert _oserror_mit_winerror(206).errno == errno.ENOENT
        assert _oserror_mit_winerror(123).errno == errno.EINVAL

    r = client.delete("/api/projects/Demo/files/S1")

    assert r.status_code == 200, f"kein Rueckfall — {r.status_code}: {r.text}"
    assert r.json()["geloescht"] >= 1, r.json()
    assert not (tmp_path / "Demo" / "transkripte" / "S1.json").exists()


def test_umbenennen_ohne_sperre_gibt_503(client, monkeypatch, tmp_path):
    """`rename_file` haelt seit Runde 7 dieselbe `sperre.datei` wie die zwei Nachbarendpunkte.

    Ohne sie teilten zwei HTTP-Anfragen auf dieselbe Aufnahme kein Schloss: ein gleichzeitiges
    DELETE raeumt eine Datei zwischen `_ziel_frei` und dem `os.rename` weg, das Umbenennen
    scheitert mit `FileNotFoundError` — kein `PermissionError`, also 500 statt 409 — und der
    Ruecklauf schreibt in einen Platz zurueck, den der andere Endpunkt gerade freigab.
    """
    from webtool import sperre
    import contextlib

    @contextlib.contextmanager
    def fake_sperre(pfad, **kw):
        yield False

    monkeypatch.setattr(sperre, "datei", fake_sperre)
    vorher = _bestand(tmp_path)

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 503, r.text
    assert _bestand(tmp_path) == vorher, "trotz 503 wurde umbenannt"


def test_umbenennen_ohne_transkripte_ordner_klappt(client, tmp_path):
    """Dasselbe wie beim Neu-Transkribieren (Runde 6), jetzt fuer `rename_file`.

    Mit der Sperre kam die Vorbedingung „Elternverzeichnis existiert" mit — und
    `create_project` legt nur `audio/` an. Ohne `os.makedirs` scheitert `os.mkdir(lockdir)`
    mit `FileNotFoundError`, und eine noch nie transkribierte Aufnahme liesse sich nicht mehr
    umbenennen. Der Fix von Runde 6 waere sonst genau einen Endpunkt weit gegangen.
    """
    p = tmp_path / "NurAudio2"
    (p / "audio").mkdir(parents=True)
    (p / "audio" / "B1.mp3").write_bytes(b"ID3fakeaudio")
    assert not (p / "transkripte").exists()

    r = client.post("/api/projects/NurAudio2/files/B1/rename", json={"name": "B1_neu"})

    assert r.status_code == 200, r.text
    assert (p / "audio" / "B1_neu.mp3").exists()


def test_umbenennen_fragt_nach_jobs_innerhalb_der_sperre(client, monkeypatch, tmp_path):
    """Die Job-Frage muss INNERHALB der Sperre stehen, nicht davor.

    Vor der Sperre gefragt lag zwischen Antwort und `os.rename` frueher nur die Trefferliste.
    Seit `rename_file` eine `sperre.datei` haelt, liegt dort eine Wartezeit von bis zu
    `sperre.STALTES_ALTER` (60 s) — die Sperre selbst hat das Fenster also erst geschaffen.
    Startet darin ein Lauf fuer denselben Basisnamen, benennt `_umbenennen_oder_keines`
    Dateien um, die ein Job gerade schreibt.

    Der Sensor bildet genau das ab: der Job erscheint erst, WAEHREND die Sperre gehalten wird.
    Steht `_keine_jobs` davor, sieht es ihn nicht, der Endpunkt antwortet 200 — und der Test
    wird rot.
    """
    import contextlib
    from webtool import sperre
    import webtool.jobs as jobs_mod

    im_kritischen_abschnitt = []

    @contextlib.contextmanager
    def sperre_in_der_ein_job_startet(pfad, **kw):
        im_kritischen_abschnitt.append(True)     # ab hier laeuft ein Lauf fuer denselben Namen
        try:
            yield True
        finally:
            im_kritischen_abschnitt.clear()

    monkeypatch.setattr(sperre, "datei", sperre_in_der_ein_job_startet)
    monkeypatch.setattr(jobs_mod, "betrifft",
                        lambda name, base, **kw: ({"id": "j1", "kind": "transcribe"}
                                                  if im_kritischen_abschnitt else None))
    vorher = _bestand(tmp_path)

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 409, f"Job im Fenster nicht gesehen — {r.status_code}: {r.text}"
    assert _bestand(tmp_path) == vorher, "trotz 409 wurde umbenannt"


def test_umbenennen_bei_zu_langem_namen_gibt_400_statt_500(client, monkeypatch, tmp_path):
    """#467: `rename_file` prueft Kollisionen, aber nicht die Laenge — und
    `_umbenennen_oder_keines` reicht jeden Nicht-`PermissionError` durch. Der Endpunkt
    antwortete damit 500, also „im Server ist etwas kaputt", obwohl der Nutzer nur einen Namen
    eingegeben hat, den das Dateisystem nicht annimmt.

    Der Fall wird ueber ein praepariertes `os.rename` hergestellt, nicht ueber einen echten
    300-Zeichen-Namen: die Grenze haengt an Pfadtiefe und Plattform, ein echter Name waere auf
    einem Wirt rot und auf dem anderen gruen. Dieselbe Vorlage wie im Loeschpfad
    (`test_loeschen_bei_zu_langem_pfad_loescht_direkt_statt_500`)."""
    import errno as _errno
    monkeypatch.setattr(os, "rename",
                        lambda src, dst: (_ for _ in ()).throw(
                            OSError(_errno.ENAMETOOLONG, "Dateiname zu lang")))
    vorher = _bestand(tmp_path)

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})

    assert r.status_code == 400, f"erwartet 400, bekam {r.status_code}: {r.text}"
    assert "zu lang" in r.json()["detail"]
    assert _bestand(tmp_path) == vorher, "trotz Fehlschlag wurde etwas umbenannt"


def test_projekt_umbenennen_bei_zu_langem_namen_gibt_400_statt_500(client, monkeypatch):
    """Die NACHBARSTELLE zu #467, und sie steht in keinem Issue: `rename_project` hatte
    dieselbe ungeschuetzte `os.rename`-Zeile. Ein Fix an einer Stelle ist kein Fix der Klasse.

    Gemessen: ein zu langer VERZEICHNISname wirft auf NTFS denselben `errno=22 / winerror=123`
    wie ein Dateiname, auf ext4 dasselbe `ENAMETOOLONG` — der Fall verhaelt sich nicht anders,
    nur die Wache fehlte."""
    import errno as _errno
    monkeypatch.setattr(os, "rename",
                        lambda src, dst: (_ for _ in ()).throw(
                            OSError(_errno.ENAMETOOLONG, "Verzeichnisname zu lang")))

    r = client.post("/api/projects/Demo/rename", json={"name": "Demo_neu"})

    assert r.status_code == 400, f"erwartet 400, bekam {r.status_code}: {r.text}"
    assert "zu lang" in r.json()["detail"]


def test_ein_anderer_oserror_beim_umbenennen_bleibt_500(client, monkeypatch):
    """Die GEGENRICHTUNG, ohne die der Fang eine Wache waere, die alles durchwinkt: ein Fehler,
    der NICHT „Zielname unbrauchbar" heisst, muss weiterhin durchschlagen. Sonst beschriftete
    der Endpunkt jeden Plattenfehler als Eingabefehler des Nutzers."""
    import errno as _errno
    monkeypatch.setattr(os, "rename",
                        lambda src, dst: (_ for _ in ()).throw(
                            OSError(_errno.ENOSPC, "kein Platz mehr")))

    with pytest.raises(OSError):
        client.post("/api/projects/Demo/files/S1/rename", json={"name": "S1_neu"})


@pytest.mark.skipif(os.name != "nt", reason="die Zeichenklasse ist Windows-spezifisch")
def test_windows_sonderzeichen_werden_nicht_als_zu_lang_beschriftet(client, monkeypatch):
    """Der Befund des kalten Plan-Reviewers: `paths.safe_name` laesst `? * < > | "` durch, und
    `os.rename` wirft darauf auf NTFS `errno=22 / winerror=123` — genau den Code, den
    `_name_zu_lang` als Laenge liest. Wer eine Aufnahme in „Was?" umbenennt, bekaeme 400 mit
    der FALSCHEN Begruendung.

    Abgelehnt werden die Zeichen NICHT: auf POSIX sind sie gueltig, ein Riegel machte einen
    legalen Namen plattformabhaengig unmoeglich. Also richtig beschriften statt verbieten."""
    def unbrauchbar(src, dst):
        e = OSError(22, "Der Dateiname ist ungueltig")
        e.winerror = 123
        raise e

    monkeypatch.setattr(os, "rename", unbrauchbar)

    r = client.post("/api/projects/Demo/files/S1/rename", json={"name": "Was?"})

    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert "Windows" in detail and "?" in detail, detail
    assert "zu lang" not in detail, f"falsche Begruendung: {detail}"


def test_reservierungsname_traegt_einen_lesbaren_zeitstempel():
    """#459: der Aufraeumlauf muss frische Reservierungen von alten Resten unterscheiden — und
    das Dateisystem gibt die Antwort nicht her. GEMESSEN auf beiden Wirten:

        NTFS (Windows)   mtime geaendert = False   ctime geaendert = False
        ext4 (WSL)       mtime geaendert = False   ctime geaendert = True

    `os.rename` behaelt also die mtime, und `st_ctime` waere ein Sensor, der auf Linux liefe
    und auf WINDOWS still ausfiele — auf der Hauptplattform. Deshalb steht die Zeit im NAMEN."""
    import webtool.app as appmod
    s = appmod._weg_suffix()
    assert s.endswith(".weg")
    assert appmod._weg_alter("x.json" + s) is not None
    assert appmod._weg_alter("x.json" + s) < 5.0, "frisch gebauter Suffix gilt als alt"


def test_es_gibt_nur_EINEN_erzeuger_des_weg_namens():
    """Der `.weg`-Name wird an ZWEI Stellen vergeben — Reservierung in `_datei_weg` und
    Beiseitelegen im Ruecklauf von `_umbenennen_oder_keines`. Zwei Literale liefen beim
    naechsten Umbau auseinander, und der Aufraeumlauf kennte eine der Formen nicht.

    Hier steht nur noch die EINE Zusicherung, die am Quelltext ueberhaupt scharf ist: es gibt
    genau einen Zufallserzeuger. Die zweite („beide Aufrufer nutzen die Quelle") war VACUOUS —
    `count("_weg_suffix()")` zaehlt die `def`-Zeile mit, `>= 2` hielt also schon mit einem
    einzigen Aufrufer, und die Mutation „Ruecklauf mit eigenem Literal" blieb gruen
    (gegnerischer Pruefer). Den Ruecklauf misst jetzt
    `test_ruecklauf_legt_beim_umbenennen_unsichtbar_beiseite` am VERHALTEN: der beiseitegelegte
    Name muss einen lesbaren Stempel tragen."""
    import inspect
    import webtool.app as appmod
    assert inspect.getsource(appmod).count("uuid.uuid4") == 1, "ein zweiter Erzeuger ist zurueck"


def test_weg_alter_liest_rechtsverankert_und_ueberlebt_das_umbenennen():
    """Ein Rest wandert beim Umbenennen der Aufnahme MIT und heisst danach
    `Neu.json.<epoch>.<uuid>.weg`. Der Stempel muss von RECHTS gelesen werden — ein Basisname
    darf beliebig viele Punkte tragen (`Meeting 2026.01.15`), und „der erste Zahlenabschnitt"
    faende dort die falsche Zahl."""
    import webtool.app as appmod
    jetzt = 2_000_000_000.0
    assert appmod._weg_alter(f"Meeting 2026.01.15.json.{int(jetzt) - 42}.abc12345.weg",
                             jetzt=jetzt) == 42


def test_ein_name_ohne_stempel_gilt_als_alt():
    """Das ALTE Format (`<name>.<uuid>.weg`) hat an der Stempelstelle eine Dateiendung. Solche
    Namen stammen zwangslaeufig aus der Zeit vor dieser Aenderung, koennen also keine laufende
    Reservierung sein — `None` heisst fuer den Aufrufer ALT. Das ist die ganze Migration."""
    import webtool.app as appmod
    assert appmod._weg_alter("S1.mp3.deadbeef.weg") is None
    assert appmod._weg_alter("S1.json.cafe1234.weg") is None


def _weg_datei(ordner, name, alter_s):
    """Legt einen `.weg`-Rest mit einem Stempel an, der `alter_s` Sekunden zurueckliegt."""
    import time as _t
    ordner.mkdir(parents=True, exist_ok=True)
    p = ordner / f"{name}.{int(_t.time()) - int(alter_s)}.abc12345.weg"
    p.write_bytes(b"x")
    return p


def test_aufraeumlauf_entfernt_alte_reste_und_laesst_frische_stehen(tmp_path):
    """#459: der Kern in beiden Richtungen. Ohne die Gegenrichtung waere ein Lauf, der ALLES
    wegraeumt, gruen — und der raeumte die Reservierung eines gerade laufenden Loeschvorgangs
    mit weg, also genau den Schaden, gegen den die Frist da ist."""
    import webtool.app as appmod
    p = tmp_path / "Demo"
    alt = _weg_datei(p / "transkripte", "S1.json", 3600)
    frisch = _weg_datei(p / "transkripte", "S2.json", 5)
    alt_audio = _weg_datei(p / "audio", "S1.mp3", 3600)

    n = appmod._weg_reste_aufraeumen(str(tmp_path))

    assert n == 2, f"erwartet 2 entfernte, bekam {n}"
    assert not alt.exists() and not alt_audio.exists()
    assert frisch.exists(), "eine frische Reservierung wurde weggeraeumt"


def test_aufraeumlauf_nimmt_reste_ohne_stempel_mit(tmp_path):
    """Das ALTE Namensformat hat keinen Stempel — solche Reste stammen zwangslaeufig aus der
    Zeit vor dieser Aenderung und koennen keine laufende Reservierung sein. `None` heisst ALT;
    das ist die ganze Migration."""
    import webtool.app as appmod
    p = tmp_path / "Demo" / "transkripte"
    p.mkdir(parents=True)
    (p / "S1.json.cafe1234.weg").write_bytes(b"x")

    assert appmod._weg_reste_aufraeumen(str(tmp_path)) == 1
    assert not (p / "S1.json.cafe1234.weg").exists()


def test_aufraeumlauf_fasst_nur_weg_dateien_an(tmp_path):
    """Der Lauf loescht. Ohne diesen Waechter waere ein zu weites Glob ein Datenverlust, den
    keine Ansicht meldet — die echten Dateien sind sichtbar, ihr Verschwinden nicht erklaerbar."""
    import webtool.app as appmod
    t = tmp_path / "Demo" / "transkripte"
    a = tmp_path / "Demo" / "audio"
    t.mkdir(parents=True)
    a.mkdir(parents=True)
    (t / "S1.json").write_bytes(b"echt")
    (t / "S1.edit.json").write_bytes(b"echt")
    (a / "S1.mp3").write_bytes(b"echt")
    _weg_datei(t, "S9.json", 3600)

    assert appmod._weg_reste_aufraeumen(str(tmp_path)) == 1
    assert sorted(x.name for x in t.iterdir()) == ["S1.edit.json", "S1.json"]
    assert [x.name for x in a.iterdir()] == ["S1.mp3"]


def test_aufraeumlauf_ueberlebt_eine_fehlende_wurzel_und_einen_sperrigen_rest(tmp_path, monkeypatch):
    """Zwei Ausfaelle, die den Lauf nicht aufhalten duerfen — er haengt an einem Daemon-Faden
    beim Serverstart, ein Wurf endet dort als Traceback ohne Adressaten.

    Die fehlende Wurzel ist der Fall der frischen Installation; das `suppress` je Datei deckt
    sie NICHT, weil `os.scandir` eine Ebene darueber wirft (Plan-Review)."""
    import webtool.app as appmod
    assert appmod._weg_reste_aufraeumen(str(tmp_path / "gibtsnicht")) == 0

    t = tmp_path / "Demo" / "transkripte"
    alt = _weg_datei(t, "S1.json", 3600)
    zweiter = _weg_datei(t, "S2.json", 3600)
    echt_remove = os.remove
    monkeypatch.setattr(os, "remove",
                        lambda p: (_ for _ in ()).throw(PermissionError(13, "in Benutzung"))
                        if str(p) == str(alt) else echt_remove(p))

    assert appmod._weg_reste_aufraeumen(str(tmp_path)) == 1, "der zweite Rest wurde nicht erreicht"
    assert alt.exists() and not zweiter.exists()


def test_aufraeumlauf_liest_die_wurzel_aus_dem_argument_nicht_aus_der_umgebung(tmp_path, monkeypatch):
    """Der schwerste Befund des Plan-Reviews, als Zusicherung: `paths.projekte_root()` liest
    `os.environ` bei JEDEM Aufruf. Haengt der Lauf daran, zeigt er nach einem
    monkeypatch-Teardown auf die ECHTE Projektwurzel — und der eine Test, der den Lifespan
    betritt, setzt `TRANSKRIBOR_PROJEKTE` gar nicht."""
    import webtool.app as appmod
    _weg_datei(tmp_path / "Demo" / "transkripte", "S1.json", 3600)
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path / "ganz-woanders"))

    assert appmod._weg_reste_aufraeumen(str(tmp_path)) == 1, "die Umgebung hat gewonnen"


def test_der_serverstart_raeumt_liegengebliebene_reste_weg(monkeypatch, tmp_path):
    """Die VERDRAHTUNG, nicht die Regel — die steht in den Tests darueber.

    Ohne diesen Test liesse sich `_weg_aufraeumen_starten()` aus dem Lifespan ersatzlos
    streichen: die Funktion bliebe getestet, der Aufraeumlauf faende nie statt, und keine
    Zusicherung waere rot. Dieselbe Luecke, die #488 an einem optionalen Prop gekostet hat.

    Die `client`-Fixture wird bewusst NICHT genommen (sie betritt den Lifespan gar nicht — sie
    yieldet `TestClient(app)` ohne `with`); dafuer wird hier beides umgebogen, was der Start
    anfasst."""
    from webtool import app as appmod
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(appmod.ytdlp_update, "beim_start", lambda: False)
    # `_weg_faden` ist MODULZUSTAND und ueberlebt fremde Tests. Ohne das Zuruecksetzen waren
    # die beiden Zusicherungen darunter unter der Mutation „Aufruf aus dem Lifespan entfernt"
    # blind — sie sahen den Faden eines frueheren Lifespan-Eintritts und blieben gruen
    # (Was-erlaubt-Linse). Rot wurde nur die Datei-Zusicherung; der Test war also schaerfer,
    # als seine Zwischenschritte belegten.
    monkeypatch.setattr(appmod, "_weg_faden", None)
    alt = _weg_datei(tmp_path / "Demo" / "transkripte", "S1.json", 3600)
    frisch = _weg_datei(tmp_path / "Demo" / "transkripte", "S2.json", 5)

    with TestClient(appmod.app):
        pass
    assert appmod._weg_faden is not None, "der Start hat gar keinen Aufraeumfaden angestossen"
    appmod._weg_faden.join(10.0)
    assert not appmod._weg_faden.is_alive(), "der Aufraeumfaden lief nach 10 s noch"

    assert not alt.exists(), "der alte Rest ueberlebte den Serverstart"
    assert frisch.exists(), "eine frische Reservierung wurde vom Serverstart weggeraeumt"


def test_die_wurzel_wird_VOR_dem_faden_aufgeloest_nicht_darin(monkeypatch, tmp_path):
    """Der eigentliche Schutz hinter #459s schwerstem Befund — und er war zuerst UNBEWACHT:
    die Mutation „Wurzel im Faden statt davor" liess alle 254 Tests gruen.

    Warum die naheliegenden Tests ihn nicht sehen: sie setzen die Umgebung einmal und aendern
    sie nicht mehr — dann liefert `paths.projekte_root()` drinnen wie draussen dasselbe. Der
    Unterschied zeigt sich nur, wenn sich die Umgebung ZWISCHEN Fadenstart und Fadenlauf
    aendert, und genau das passiert im echten Fall: `monkeypatch` raeumt beim Teardown auf,
    waehrend ein Daemon-Faden noch laeuft.

    Deterministisch gemacht, indem der Faden NICHT gestartet, sondern sein Rumpf gefangen und
    spaeter von Hand gerufen wird — mit einer echten Uhr waere der Test ein Rennen."""
    from webtool import app as appmod
    gefangen = {}

    class FadenAttrappe:
        def __init__(self, target, name=None, daemon=None):
            gefangen["rumpf"] = target
        def start(self):
            pass                     # NICHT laufen lassen — der Rumpf kommt spaeter dran

    monkeypatch.setattr(appmod.threading, "Thread", FadenAttrappe)
    echt = tmp_path / "echt"
    spaeter = tmp_path / "spaeter"
    alt_echt = _weg_datei(echt / "Demo" / "transkripte", "S1.json", 3600)
    alt_spaeter = _weg_datei(spaeter / "Demo" / "transkripte", "S1.json", 3600)

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(echt))
    appmod._weg_aufraeumen_starten()                      # loest die Wurzel HIER auf
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(spaeter))
    gefangen["rumpf"]()                                   # der Faden laeuft ERST JETZT

    assert not alt_echt.exists(), "der Faden hat die Wurzel vom Startzeitpunkt nicht benutzt"
    assert alt_spaeter.exists(), "der Faden hat die spaetere Umgebung gelesen — genau der Weg " \
                                 "in die echten Projekte"


def test_aufraeumlauf_erreicht_auch_den_projektstamm(tmp_path):
    """Ein von Hand angelegtes Projekt OHNE `audio/`-Unterordner: `paths.audio_dir` faellt dann
    auf den PROJEKTSTAMM zurueck, `_datei_weg` legt seine Audio-Reservierung also dort ab.

    Zwei Ebenen liessen dort ausgerechnet die groesste Datei der Aufnahme fuer immer liegen —
    genau den Fall, den README und Release-Notiz als behoben melden. Gefunden vom kalten
    Diff-Leser, der den liegenbleibenden Rest vorgefuehrt hat."""
    import webtool.app as appmod
    p = tmp_path / "Handgemacht"
    p.mkdir()
    (p / "transkripte").mkdir()
    stamm = _weg_datei(p, "S1.mp3", 3600)

    assert appmod._weg_reste_aufraeumen(str(tmp_path)) == 1
    assert not stamm.exists(), "der Rest im Projektstamm blieb liegen"


def test_weg_alter_faellt_nicht_ueber_hochgestellte_ziffern():
    """`isdigit()` ist fuer hochgestellte Ziffern True, `int()` wirft darauf. Der Aufruf steht
    AUSSERHALB des `suppress` — im Daemon-Faden waere das ein Traceback ohne Adressaten, und
    der Aufraeumlauf braeche fuer alle restlichen Projekte dieses Starts ab.

    Dieselbe Falle fuehrt `webtool/CLAUDE.md` fuer `ytdlp_update` bereits als Lehre
    („`isdecimal()`, nicht `isdigit()`") — hier war sie zurueck."""
    import webtool.app as appmod
    # Die Praemisse selbst, sonst prueft der Test eine Falle, die es vielleicht gar nicht gibt:
    assert "²²".isdigit() and not "²²".isdecimal(), "Praemisse der Falle stimmt nicht mehr"
    assert appmod._weg_alter("S1.json.²².abc12345.weg") is None


def test_ein_stempel_in_der_zukunft_macht_einen_rest_nicht_unsterblich(tmp_path):
    """Der Fund der Was-erlaubt-Linse, und er ist der teuerste dieses PRs: ein Stempel in der
    ZUKUNFT ergibt ein negatives Alter. Ohne die Untergrenze `0 <=` waere `alter < max_alter`
    wahr, die Datei also DAUERHAFT immun — genau das Leck, das #459 schliessen soll, nur im
    Namen festgeschrieben.

    Erreichbar ohne fremdes Zutun: die RTC steht beim Hochfahren vor, NTP korrigiert danach
    nach unten; ein ausgesetzter Laptop oder eine VM tut dasselbe. Ein unglaubwuerdiger
    Stempel schuetzt deshalb NICHT — dieselbe Richtung wie ein fehlender."""
    import webtool.app as appmod
    zukunft = _weg_datei(tmp_path / "Demo" / "transkripte", "S1.json", -3600)

    assert appmod._weg_alter(str(zukunft)) < 0, "Praemisse: der Stempel liegt in der Zukunft"
    assert appmod._weg_reste_aufraeumen(str(tmp_path)) == 1
    assert not zukunft.exists(), "ein Zukunfts-Stempel machte den Rest unsterblich"


def test_ein_gescheiterter_fadenstart_haelt_den_server_nicht_auf(monkeypatch, tmp_path, capsys):
    """Bot-Befund (Major): der `try` in `lauf()` deckt den RUMPF — `Thread.start()` selbst
    lief ungeschuetzt, und der Aufruf steht im Lifespan VOR dem `yield`. Ein
    `RuntimeError: can't start new thread` haette den Server also gar nicht erst hochkommen
    lassen, wegen reiner Aufraeumarbeit.

    Die Klasse ist im Haus bekannt: `ytdlp_update.starte_hintergrund` buchstabiert sie aus
    („die Kosten des Fehlers, nicht seine Wahrscheinlichkeit") und faengt dort ebenfalls am
    Start. Der Unterschied ist die Richtung — dort wird weitergereicht, weil ein Endpunkt
    den Fehler melden soll, hier geschluckt, weil niemand auf das Ergebnis wartet.

    Gefaelscht wird NUR `appmod.threading`, nicht `threading.Thread` global: das globale
    Attribut traefe die Faden-Verwaltung des TestClients (dieselbe Begruendung wie beim
    ytdlp-Zwilling). `app.py` zieht aus `threading` ausschliesslich diesen einen Faden —
    nachgesehen, nicht angenommen.

    Mutation, die ihn rot macht: `try`/`except` um `faden.start()` entfernen ⇒ der
    `RuntimeError` verlaesst `_lifespan` und `TestClient.__enter__` wirft.
    """
    import webtool.app as appmod

    class _Fadenlos:
        class Thread:
            def __init__(self, *a, **k):
                pass

            def start(self):
                raise RuntimeError("can't start new thread")

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(appmod.ytdlp_update, "beim_start", lambda: False)
    monkeypatch.setattr(appmod, "_weg_faden", None)
    monkeypatch.setattr(appmod, "threading", _Fadenlos)
    rest = _weg_datei(tmp_path / "Demo" / "transkripte", "S1.json", 3600)

    with TestClient(appmod.app):          # der eigentliche Beweis: das hier wirft nicht
        pass

    assert appmod._weg_faden is None, "ein nie gestarteter Faden darf nicht als laufend gelten"
    assert rest.exists(), "ohne Faden raeumt niemand — die Datei muss liegen bleiben"
    assert "[aufraeumen] nicht angestossen" in capsys.readouterr().out, \
        "der Ausfall ist still geblieben"


def test_unbrauchbarer_zielname_trennt_zeichen_von_laenge(monkeypatch):
    """Bot-Befund: die Unterscheidung selbst ist reine Python-Logik, ihr einziger Test hing
    aber an `skipif(os.name != "nt")` — auf dem ubuntu-Laeufer lief er NIE, und die Mutation
    `os.name == "nt"` → `"posix"` blieb dort gruen. Der Endpunkt-Test daneben braucht sein
    `skipif` zu Recht (`os.rename` verhaelt sich plattformabhaengig); diese Funktion nicht.

    Geprueft werden BEIDE Richtungen plus der Nicht-Laengenfall — eine Beschriftung, die
    immer „Zeichen" sagt, ist derselbe Schaden von der anderen Seite.
    """
    import errno as _errno

    import webtool.app as appmod
    e = OSError(22, "ungueltig")
    e.winerror = 123

    monkeypatch.setattr(appmod.os, "name", "nt")
    assert "Windows" in (appmod._unbrauchbarer_zielname(e, "Was?") or "")
    assert appmod._unbrauchbarer_zielname(e, "Sauber") == "Name zu lang"

    # Gegenrichtung: auf POSIX gibt es diese Zeichenklasse nicht, `Was?` ist ein legaler Name.
    monkeypatch.setattr(appmod.os, "name", "posix")
    assert appmod._unbrauchbarer_zielname(e, "Was?") == "Name zu lang"

    # Und ein Fehler OHNE Laengenbezug bleibt None — sonst beschriftete die Funktion
    # jeden beliebigen OSError als Namensproblem.
    monkeypatch.setattr(appmod.os, "name", "nt")
    assert appmod._unbrauchbarer_zielname(OSError(_errno.ENOSPC, "voll"), "Was?") is None
