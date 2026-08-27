import os
import signal
import subprocess
import sys
import time
from webtool import jobs


def _alive(pid):
    if os.name == "nt":
        # Bytes vergleichen: dt. tasklist-Ausgabe ist nicht UTF-8 -> text=True würde crashen
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                             capture_output=True).stdout
        return str(pid).encode() in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _wait(job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = jobs.get(job_id)
        if r and r["status"] != "running":
            return r
        time.sleep(0.02)
    return jobs.get(job_id)


def _echo_cmd(n=3):
    # druckt n Zeilen inkl. Umlaut (Encoding-Check), mit flush
    code = "import sys\n" + f"for i in range({n}):\n    print(f'zeile {{i}} ä', flush=True)\n"
    return [sys.executable, "-c", code]


def test_leerer_env_wert_verdraengt_einen_geerbten_im_KIND(tmp_path, monkeypatch):
    """Die #298-Zusicherung endet in `test_api.py` an der `jobs.start`-Attrappe: dort ist
    belegt, dass ein leerer Wert im `env`-Dict ANKOMMT — nicht, dass er im Kind einen
    geerbten Wert wirklich verdraengt, statt zu verschwinden. Das haengt an CreateProcess
    bzw. execve und an unserer Mischreihenfolge in `_run_proc` (`**os.environ` zuerst,
    `**env` zuletzt), nicht an der Attrappe.

    Die Gegenprobe im selben Test ist Pflicht: ohne `env` MUSS das Kind die Altlast sehen,
    sonst waere die Zusicherung oben auch dann gruen, wenn gar nichts geerbt wuerde.
    """
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.setenv("TRANSKRIBOR_FETCH_SPRACHE", "en")        # Altlast im Serverprozess
    code = "import os; print(repr(os.environ.get('TRANSKRIBOR_FETCH_SPRACHE')))"
    cmd = [sys.executable, "-c", code]

    jid, _ = jobs.start("P_env_leer", cmd, cwd=None, kind="fetch",
                        env={"TRANSKRIBOR_FETCH_SPRACHE": ""})
    assert _wait(jid)["lines"] == ["''"], "der leere Wert verdraengt die Altlast nicht"

    jid2, _ = jobs.start("P_env_ohne", cmd, cwd=None, kind="fetch")
    assert _wait(jid2)["lines"] == ["'en'"], "Gegenprobe: ohne env muss geerbt werden"


def test_start_streams_lines_and_completes():
    jid, started = jobs.start("P_stream", _echo_cmd(3), cwd=None, kind="transcribe")
    assert started is True
    r = _wait(jid)
    assert r["status"] == "done" and r["returncode"] == 0
    assert r["lines"] == ["zeile 0 ä", "zeile 1 ä", "zeile 2 ä"]
    assert r["kind"] == "transcribe" and r["project"] == "P_stream"


def test_error_status_on_nonzero_exit():
    jid, _ = jobs.start("P_err", [sys.executable, "-c", "import sys; sys.exit(3)"], cwd=None, kind="correct")
    r = _wait(jid)
    assert r["status"] == "error" and r["returncode"] == 3


def test_dedupe_same_project():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jid1, s1 = jobs.start("P_dupe", slow, cwd=None, kind="correct")
    jid2, s2 = jobs.start("P_dupe", slow, cwd=None, kind="correct")
    assert s1 is True and s2 is False and jid1 == jid2
    _wait(jid1)


def test_only_one_transcribe_at_a_time():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jidA, sA = jobs.start("ProjA", slow, cwd=None, kind="transcribe")
    jidB, sB = jobs.start("ProjB", slow, cwd=None, kind="transcribe")
    assert sA is True and sB is False and jidB == jidA  # zweiter Transcribe abgewiesen
    _wait(jidA)


def test_correct_blockiert_keine_transcribe():
    """Eine 25-Minuten-Korrektur darf keine Transkription aufhalten — sie haengt an Opus,
    nicht an der GPU (GPU_KINDS = nur transcribe)."""
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jidC, sC = jobs.start("ProjC", slow, cwd=None, kind="correct")
    jidT, sT = jobs.start("ProjD", slow, cwd=None, kind="transcribe")
    assert sC is True and sT is True and jidT != jidC
    _wait(jidC); _wait(jidT)


def test_transcribe_blockiert_keine_correct():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jidT, sT = jobs.start("ProjE", slow, cwd=None, kind="transcribe")
    jidC, sC = jobs.start("ProjF", slow, cwd=None, kind="correct")
    assert sT is True and sC is True
    _wait(jidT); _wait(jidC)


def test_transcribe_und_correct_parallel_im_selben_projekt():
    """Dedupe geht je (Projekt, Art) — im selben Projekt duerfen beide Arten gleichzeitig
    laufen, zwei gleiche Arten nicht."""
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    jidT, sT = jobs.start("P_mix", slow, cwd=None, kind="transcribe")
    jidC, sC = jobs.start("P_mix", slow, cwd=None, kind="correct")
    jidC2, sC2 = jobs.start("P_mix", slow, cwd=None, kind="correct")
    assert sT is True and sC is True
    assert sC2 is False and jidC2 == jidC          # zweite correct-Runde wird abgewiesen
    assert {j["kind"] for j in jobs.active_for("P_mix")} == {"transcribe", "correct"}
    _wait(jidT); _wait(jidC)


def test_then_laeuft_nach_erfolg_und_darf_neu_starten():
    """Der Nachlauf (Auto-Korrektur) muss den Slot des beendeten Jobs neu belegen koennen —
    er laeuft deshalb erst, nachdem _active freigegeben wurde."""
    gelaufen = []

    def nachlauf():
        jid2, ok = jobs.start("P_then", _echo_cmd(1), cwd=None, kind="transcribe")
        gelaufen.append(ok)
        _wait(jid2)

    jid, _ = jobs.start("P_then", _echo_cmd(1), cwd=None, kind="transcribe", then=nachlauf)
    _wait(jid)
    for _ in range(100):                           # then laeuft im Job-Thread, kurz nachlaufen lassen
        if gelaufen:
            break
        time.sleep(0.02)
    assert gelaufen == [True]


def test_then_laeuft_nicht_nach_abbruch():
    gelaufen = []
    slow = [sys.executable, "-c", "import time; time.sleep(5)"]
    jid, _ = jobs.start("P_cancel_then", slow, cwd=None, kind="transcribe",
                        then=lambda: gelaufen.append(True))
    for _ in range(100):
        if jobs.get(jid)["pid"]:
            break
        time.sleep(0.02)
    jobs.cancel(jid)
    _wait(jid)
    time.sleep(0.2)
    assert gelaufen == []                          # abgebrochen ist nicht 'done'


def test_when_done_auf_fertigem_job_ist_false():
    jid, _ = jobs.start("P_wd", _echo_cmd(1), cwd=None, kind="correct")
    _wait(jid)
    assert jobs.when_done(jid, lambda: None) is False
    assert jobs.when_done("gibtsnicht", lambda: None) is False


def test_get_unknown_returns_none():
    assert jobs.get("doesnotexist") is None


def test_cancel_unknown_returns_none():
    assert jobs.cancel("doesnotexist") is None


def test_cancel_finished_returns_none():
    jid, _ = jobs.start("P_fin", _echo_cmd(1), cwd=None, kind="correct")
    _wait(jid)
    assert jobs.cancel(jid) is None  # schon terminal -> nichts abzubrechen


def test_cancel_kills_process_tree():
    # Äußerer Prozess spawnt einen Enkel (wie jobs->python->claude) und druckt dessen PID.
    code = ("import subprocess, sys, time\n"
            "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
            "print(p.pid, flush=True)\n"
            "time.sleep(30)\n")
    jid, started = jobs.start("P_cancel", [sys.executable, "-c", code], cwd=None, kind="correct")
    assert started is True
    grandchild = None
    deadline = time.time() + 5
    while time.time() < deadline:
        r = jobs.get(jid)
        if r and r["pid"] and r["lines"]:
            grandchild = int(r["lines"][0])
            break
        time.sleep(0.02)
    assert grandchild is not None and _alive(grandchild)  # Baum steht

    assert jobs.cancel(jid) is True
    r = _wait(jid)
    assert r["status"] == "cancelled"
    # taskkill /T killt den ganzen Baum -> Enkel stirbt (kurz auf OS-Aufräumen warten)
    deadline = time.time() + 5
    while _alive(grandchild) and time.time() < deadline:
        time.sleep(0.05)
    assert not _alive(grandchild)


def test_active_for_running_then_none():
    slow = [sys.executable, "-c", "import time; time.sleep(0.6)"]
    assert jobs.active_for("P_af") == []
    jid, started = jobs.start("P_af", slow, cwd=None, kind="correct")
    assert started is True
    assert jobs.active_for("P_af") == [{"id": jid, "kind": "correct"}]
    _wait(jid)
    assert jobs.active_for("P_af") == []


def test_request_startet_sofort_wenn_frei():
    jid, started = jobs.request("P_req", _echo_cmd(1), cwd=None, kind="transcribe")
    assert started is True
    assert _wait(jid)["status"] == "done"


def test_request_haengt_genau_einen_nachlauf_an():
    """Fuenf Uploads waehrend eines laufenden Laufs duerfen nicht fuenf Laeufe aufreihen —
    einer reicht, er sieht ohnehin alle inzwischen dazugekommenen Dateien."""
    slow = [sys.executable, "-c", "import time; time.sleep(0.5)"]
    jid, started = jobs.request("P_req1", slow, cwd=None, kind="transcribe")
    assert started is True
    for _ in range(5):                       # alle waehrend des laufenden Jobs
        jid2, ok = jobs.request("P_req1", _echo_cmd(1), cwd=None, kind="transcribe")
        assert ok is False and jid2 == jid   # eingereiht, nicht gestartet
    _wait(jid)
    # der eine vorgemerkte Nachlauf laeuft im Job-Thread an
    deadline = time.time() + 5
    while time.time() < deadline:
        laufend = jobs.active_for("P_req1")
        if laufend:
            _wait(laufend[0]["id"])
            break
        time.sleep(0.02)
    nachlaeufe = [r for r in jobs._jobs.values()
                  if r["project"] == "P_req1" and r["id"] != jid]
    assert len(nachlaeufe) == 1, f"genau ein Nachlauf erwartet, waren {len(nachlaeufe)}"
    assert ("P_req1", "transcribe") not in jobs._pending   # Vormerkung wieder freigegeben


def test_request_gibt_pending_frei_wenn_der_blocker_schon_weg_ist(monkeypatch):
    """when_done()==False heisst 'Job eben terminal' -> sofort neu versuchen, nicht aufgeben."""
    versuche = []
    echt_start = jobs.start

    def fake_start(project, cmd, cwd, kind, then=None):
        versuche.append(kind)
        if len(versuche) == 1:
            return "weg", False
        return echt_start(project, cmd, cwd, kind, then=then)

    monkeypatch.setattr(jobs, "start", fake_start)
    monkeypatch.setattr(jobs, "when_done", lambda jid, fn: False)
    jid, started = jobs.request("P_req2", _echo_cmd(1), cwd=None, kind="correct")
    assert started is True and versuche == ["correct", "correct"]
    _wait(jid)
    assert ("P_req2", "correct") not in jobs._pending


def test_popen_startet_eigene_sitzung_auf_posix(monkeypatch):
    """Ohne eigene Prozessgruppe erreicht der Abbruch die Kinder nicht."""
    monkeypatch.setattr(jobs.os, "name", "posix")
    assert jobs._popen_kwargs()["start_new_session"] is True


def test_popen_ohne_sitzung_auf_windows(monkeypatch):
    monkeypatch.setattr(jobs.os, "name", "nt")
    assert jobs._popen_kwargs().get("start_new_session", False) is False


def test_start_reicht_die_popen_kwargs_wirklich_durch(monkeypatch):
    """_popen_kwargs() und _kill_tree tragen einander: os.killpg(os.getpgid(pid)) ist nur
    erlaubt, WEIL das Kind Sitzungsfuehrer ist. Faellt start_new_session am Popen-Aufruf weg,
    liefert getpgid die Gruppe des Servers — der Abbruch wuerde uvicorn selbst killen. Beide
    Bausteine sind einzeln getestet, diese Naht bisher nicht."""
    gesehen = {}

    class FakeProc:
        pid = 1234
        returncode = 0
        stdout = iter(())

        def wait(self):
            return 0

    monkeypatch.setattr(jobs.os, "name", "posix")
    monkeypatch.setattr(jobs.subprocess, "Popen",
                        lambda cmd, **kw: (gesehen.update(kw), FakeProc())[1])
    jid, started = jobs.start("P_kwargs", ["egal"], cwd=None, kind="correct")
    assert started is True
    assert _wait(jid)["status"] == "done"
    assert gesehen.get("start_new_session") is True


def test_cancel_all_bricht_laufende_jobs_ab():
    """Beim Herunterfahren: auf POSIX erreicht das SIGTERM nur uvicorn, die Kinder sitzen
    in eigenen Sitzungen und blieben sonst als Waisen mit belegter GPU zurueck."""
    slow = [sys.executable, "-c", "import time; time.sleep(5)"]
    jid, started = jobs.start("P_shutdown", slow, cwd=None, kind="correct")
    assert started is True
    for _ in range(100):
        if jobs.get(jid)["pid"]:
            break
        time.sleep(0.02)
    assert jid in jobs.cancel_all()
    assert _wait(jid)["status"] == "cancelled"
    assert jid not in jobs.cancel_all()     # fertige Jobs nicht nochmal anfassen


def test_kill_tree_posix_nutzt_prozessgruppe(monkeypatch):
    getoetet = []

    class FakeProc:
        pid = 4711
        def terminate(self):
            getoetet.append("terminate")

    monkeypatch.setattr(jobs.os, "name", "posix")
    monkeypatch.setattr(jobs.os, "getpgid", lambda pid: pid, raising=False)
    monkeypatch.setattr(jobs.os, "killpg",
                        lambda pgid, sig: getoetet.append(("killpg", pgid, sig)), raising=False)
    jobs._kill_tree(FakeProc())
    # SIGKILL, nicht SIGTERM: whisper faengt SIGTERM ab bzw. braucht zu lange, und der
    # Abbruch soll die GPU sofort freigeben. (Windows kennt SIGKILL nicht -> 9.)
    assert getoetet == [("killpg", 4711, getattr(signal, "SIGKILL", 9))]


def test_kill_tree_posix_faellt_auf_terminate_zurueck(monkeypatch):
    """Prozess schon weg oder keine Rechte — nicht werfen, der Abbruch muss durchlaufen."""
    getoetet = []

    class FakeProc:
        pid = 4711
        def terminate(self):
            getoetet.append("terminate")

    def explodiere(pid):
        getoetet.append(("getpgid-versucht", pid))
        raise ProcessLookupError()

    monkeypatch.setattr(jobs.os, "name", "posix")
    monkeypatch.setattr(jobs.os, "getpgid", explodiere, raising=False)
    monkeypatch.setattr(jobs.os, "killpg", lambda pgid, sig: None, raising=False)
    jobs._kill_tree(FakeProc())
    assert getoetet == [("getpgid-versucht", 4711), "terminate"]


# ---- Wirkungsbereich (Issue #80): welche Aufnahmen ein Lauf anfasst ----

def _scope_cmd(zeilen):
    """Ein Lauf, der `zeilen` druckt und dann wartet — so laesst sich `betrifft` befragen,
    solange er laeuft."""
    code = "import sys, time\n" + "".join(f"print({z!r}, flush=True)\n" for z in zeilen) + "time.sleep(30)\n"
    return [sys.executable, "-c", code]


def _warte_auf_zeilen(jid, n, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if len(jobs.get(jid)["lines"]) >= n:
            return
        time.sleep(0.02)
    raise AssertionError(f"Job druckte keine {n} Zeilen: {jobs.get(jid)['lines']}")


def test_betrifft_liest_den_gemeldeten_wirkungsbereich():
    jid, _ = jobs.start("P_scope", _scope_cmd(["[scope] S1\tS2", "los"]), cwd=None, kind="correct")
    try:
        _warte_auf_zeilen(jid, 2)
        assert jobs.betrifft("P_scope", "S1")["kind"] == "correct"
        assert jobs.betrifft("P_scope", "S2") is not None
        assert jobs.betrifft("P_scope", "S3") is None, "nicht gemeldet -> nicht gesperrt"
        assert jobs.betrifft("AnderesProjekt", "S1") is None
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_ohne_meldung_gilt_ein_job_als_allumfassend():
    """Die sichere Richtung: die ersten Sekunden eines Laufs kosten eine Rueckfrage, ein zu
    frueh freigegebenes Loeschen kostet die Datei."""
    jid, _ = jobs.start("P_stumm", _scope_cmd(["arbeite"]), cwd=None, kind="transcribe")
    try:
        _warte_auf_zeilen(jid, 1)
        assert jobs.betrifft("P_stumm", "egal") is not None
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_ein_leerer_bereich_sperrt_nichts():
    """Der URL-Import legt neue Aufnahmen an und fasst keine vorhandene an."""
    jid, _ = jobs.start("P_leer", _scope_cmd(["[scope] ", "lade"]), cwd=None, kind="fetch")
    try:
        _warte_auf_zeilen(jid, 2)
        assert jobs.betrifft("P_leer", "S1") is None
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_eine_spaetere_scope_zeile_aendert_den_bereich_nicht():
    """Nur die erste zaehlt — sonst koennte Transkripttext, der zufaellig so beginnt, die
    Sperre aufweichen."""
    jid, _ = jobs.start("P_zwei", _scope_cmd(["[scope] S1", "[scope] S1\tS2"]), cwd=None, kind="correct")
    try:
        _warte_auf_zeilen(jid, 2)
        assert jobs.betrifft("P_zwei", "S1") is not None
        assert jobs.betrifft("P_zwei", "S2") is None
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_active_zeilen_aktualisieren_active_bases():
    """[active] S1 setzt S1 als aktiv, [done] S1 entfernt es wieder."""
    code = (
        "import sys, time\n"
        "print('[scope] S1\\tS2', flush=True)\n"
        "print('[active] S1', flush=True)\n"
        "time.sleep(30)\n"
    )
    jid, _ = jobs.start("P_dyn", [sys.executable, "-c", code], cwd=None, kind="transcribe")
    try:
        _warte_auf_zeilen(jid, 2)
        # S1 ist aktiv, S2 steht in der Warteschlange
        assert jobs.betrifft("P_dyn", "S1", active_only=True) is not None
        assert jobs.betrifft("P_dyn", "S2", active_only=True) is None
        # Ohne active_only sind beide im Scope
        assert jobs.betrifft("P_dyn", "S1") is not None
        assert jobs.betrifft("P_dyn", "S2") is not None
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_done_entfernt_aufnahme_aus_active_bases():
    """[done] S1 nimmt die Aufnahme wieder aus active_bases, belaesst sie aber im Gesamtscope."""
    code = (
        "import sys, time\n"
        "print('[scope] S1\\tS2', flush=True)\n"
        "print('[active] S1', flush=True)\n"
        "print('[done] S1', flush=True)\n"
        "print('warte', flush=True)\n"
        "time.sleep(30)\n"
    )
    jid, _ = jobs.start("P_dyn_done", [sys.executable, "-c", code], cwd=None, kind="transcribe")
    try:
        _warte_auf_zeilen(jid, 4)
        assert jobs.betrifft("P_dyn_done", "S1", active_only=True) is None
        assert jobs.betrifft("P_dyn_done", "S1", active_only=False) is not None
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_remove_base_entfernt_datei_aus_job_scope():
    """jobs.remove_base entfernt eine geloeschte Datei sofort aus dem Scope."""
    jid, _ = jobs.start("P_rem", _scope_cmd(["[scope] S1\tS2", "warte"]), cwd=None, kind="correct")
    try:
        _warte_auf_zeilen(jid, 2)
        assert jobs.betrifft("P_rem", "S2") is not None
        jobs.remove_base("P_rem", "S2")
        assert jobs.betrifft("P_rem", "S2") is None
        assert jobs.betrifft("P_rem", "S1") is not None
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_jobs_start_mit_initialem_base_scope():
    """jobs.start mit base= setzt den Scope ab Millisekunde 0."""
    jid, started = jobs.start("P_single", _scope_cmd(["warte"]), cwd=None, kind="correct", base="DateiA")
    try:
        assert started is True
        snap = jobs.get(jid)
        assert snap["bases"] == ["DateiA"]
        assert jobs.betrifft("P_single", "DateiA") is not None
        assert jobs.betrifft("P_single", "DateiB") is None
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_request_merkt_unterschiedliche_basen_vor():
    """Unterschiedliche Dateien (S2, S3) werden bei laufendem S1 beide vorgemerkt und abgearbeitet."""
    # Job S1 starten (kurzer Job)
    jid1, s1 = jobs.start("P_multi", _echo_cmd(1), cwd=None, kind="correct", base="S1")
    assert s1 is True
    # Request für S2 (Slot belegt -> vorgemerkt)
    _, s2 = jobs.request("P_multi", _echo_cmd(1), cwd=None, kind="correct", base="S2")
    assert s2 is False
    assert ("P_multi", "correct", "S2") in jobs._pending

    # Request für S3 (anderer Basisname -> ebenfalls vorgemerkt)
    _, s3 = jobs.request("P_multi", _echo_cmd(1), cwd=None, kind="correct", base="S3")
    assert s3 is False
    assert ("P_multi", "correct", "S3") in jobs._pending

    # Nochmaliger Request für S2 (identischer Basisname -> dedupliziert)
    _, s2_dup = jobs.request("P_multi", _echo_cmd(1), cwd=None, kind="correct", base="S2")
    assert s2_dup is False

    # Warten bis S1 beendet ist
    _wait(jid1)
    # Warten bis auch die vorgemerkten Jobs abgearbeitet sind
    deadline = time.time() + 5.0
    while time.time() < deadline:
        with jobs._lock:
            if not any(k[0] == "P_multi" for k in jobs._pending):
                break
        time.sleep(0.02)
    with jobs._lock:
        assert not any(k[0] == "P_multi" for k in jobs._pending)


def test_active_for_enthaelt_bases_fuer_scoped_jobs():
    """jobs.active_for liefert bases fuer scoped jobs, damit das Frontend sie direkt adoptieren kann."""
    jid, started = jobs.start("P_act", _scope_cmd(["warte"]), cwd=None, kind="correct", base="DateiZ")
    try:
        assert started is True
        aktive = jobs.active_for("P_act")
        assert len(aktive) == 1
        assert aktive[0]["id"] == jid
        assert aktive[0]["kind"] == "correct"
        assert aktive[0]["bases"] == ["DateiZ"]
    finally:
        jobs.cancel(jid)
        _wait(jid)


def test_ist_fortschrittszeile_erkennt_tqdm_muster():
    assert jobs.ist_fortschrittszeile("12%|###       | 12/100 [00:01<00:09, 9.50it/s]") is True
    assert jobs.ist_fortschrittszeile("100%|") is True
    assert jobs.ist_fortschrittszeile(" 45%| ") is True
    assert jobs.ist_fortschrittszeile("[Demo] -> transkribiere audio_01 …") is False
    assert jobs.ist_fortschrittszeile("[scope] S1\tS2") is False
    assert jobs.ist_fortschrittszeile("✓ fertig") is False
    assert jobs.ist_fortschrittszeile("FEHLER: timeout") is False


def test_fuege_zeile_an_kompaktiert_fluechtige_prozentzeilen():
    lines = []
    jobs.fuege_zeile_an(lines, "[scope] S1\tS2")
    jobs.fuege_zeile_an(lines, "[Demo] -> transkribiere S1 …")
    jobs.fuege_zeile_an(lines, "10%|#         | 10/100")
    jobs.fuege_zeile_an(lines, "20%|##        | 20/100")
    jobs.fuege_zeile_an(lines, "30%|###       | 30/100")
    assert lines == [
        "[scope] S1\tS2",
        "[Demo] -> transkribiere S1 …",
        "30%|###       | 30/100",
    ]
    jobs.fuege_zeile_an(lines, "[Demo] fertig S1: 10s")
    jobs.fuege_zeile_an(lines, "[Demo] -> transkribiere S2 …")
    jobs.fuege_zeile_an(lines, "15%|#         | 15/100")
    jobs.fuege_zeile_an(lines, "50%|#####     | 50/100")
    assert lines == [
        "[scope] S1\tS2",
        "[Demo] -> transkribiere S1 …",
        "30%|###       | 30/100",
        "[Demo] fertig S1: 10s",
        "[Demo] -> transkribiere S2 …",
        "50%|#####     | 50/100",
    ]


def test_fuege_zeile_an_schuetzt_initiale_zeilen_bei_ueberlauf():
    lines = [f"[scope] S{i}" for i in range(10)]
    for i in range(jobs.MAX_JOB_LINES + 50):
        jobs.fuege_zeile_an(lines, f"logzeile {i}")
    assert len(lines) == jobs.MAX_JOB_LINES
    # Die ersten 10 Zeilen bleiben geschützt
    assert lines[0] == "[scope] S0"
    assert lines[9] == "[scope] S9"
    # Die neueste Zeile ist am Ende
    assert lines[-1] == f"logzeile {jobs.MAX_JOB_LINES + 49}"


def test_request_verzoegert_then_bis_alle_pending_jobs_fertig_sind():
    """Wenn bei laufendem Job 1 ein Nachlauf (Job 2) vorgemerkt wird, feuert `then`
    nicht nach Job 1, sondern wird an Job 2 weitergereicht und erst am Ende der Kette
    genau EINMAL ausgeführt (#Option1)."""
    ergebnisse = []

    def log_nachlauf():
        with jobs._lock:
            act = ("P_defer", "transcribe") in jobs._active
            pend = any(k[0] == "P_defer" for k in jobs._pending)
        ergebnisse.append({"active": act, "pending": pend})

    # Job 1 starten
    jid1, s1 = jobs.request("P_defer", _echo_cmd(2), cwd=None, kind="transcribe", then=log_nachlauf)
    assert s1 is True

    # Job 2 sofort anfordern (wird vorgemerkt)
    jid2, s2 = jobs.request("P_defer", _echo_cmd(2), cwd=None, kind="transcribe", then=log_nachlauf)
    assert s2 is False

    # Warten bis Job 1 und der nachfolgende Job 2 beendet sind
    _wait(jid1)
    deadline = time.time() + 5.0
    while time.time() < deadline:
        with jobs._lock:
            if ("P_defer", "transcribe") not in jobs._active and not any(k[0] == "P_defer" for k in jobs._pending):
                if ergebnisse:
                    break
        time.sleep(0.02)

    # `then` darf genau EINMAL am Ende gefeuert haben
    assert len(ergebnisse) == 1
    assert ergebnisse[0] == {"active": False, "pending": False}


def test_request_mehrere_dateien_verzoegern_then_bis_zum_letzten_nachlauf():
    """Batch-Upload-Simulation: 3 Dateien werden angefordert. `then` feuert erst nach
    dem letzten Nachlauf und findet alle Jobs abgeschlossen vor (#Option1)."""
    ergebnisse = []

    def autocorrect_cb():
        with jobs._lock:
            act = ("P_batch", "transcribe") in jobs._active
            pend = any(k[0] == "P_batch" for k in jobs._pending)
        ergebnisse.append({"active": act, "pending": pend})

    # Datei 1 startet Transkription
    jid1, s1 = jobs.request("P_batch", _echo_cmd(3), cwd=None, kind="transcribe", then=autocorrect_cb)
    assert s1 is True

    # Datei 2 und 3 werden währenddessen hochgeladen
    jid2, s2 = jobs.request("P_batch", _echo_cmd(2), cwd=None, kind="transcribe", then=autocorrect_cb)
    jid3, s3 = jobs.request("P_batch", _echo_cmd(2), cwd=None, kind="transcribe", then=autocorrect_cb)
    assert s2 is False
    assert s3 is False

    _wait(jid1)
    deadline = time.time() + 6.0
    while time.time() < deadline:
        with jobs._lock:
            if ("P_batch", "transcribe") not in jobs._active and not any(k[0] == "P_batch" for k in jobs._pending):
                if ergebnisse:
                    break
        time.sleep(0.02)

    assert len(ergebnisse) == 1
    assert ergebnisse[0] == {"active": False, "pending": False}


def test_get_ist_json_serialisierbar_auch_mit_next_runs():
    """jobs.get(jid) muss strikt JSON-serialisierbar sein, auch wenn next_runs Funktionen enthält."""
    import json
    jid1, s1 = jobs.start("P_json", _echo_cmd(5), cwd=None, kind="transcribe")
    assert s1 is True
    # Nachlauf registrieren -> next_runs wird befüllt
    jid2, s2 = jobs.request("P_json", _echo_cmd(1), cwd=None, kind="transcribe")
    assert s2 is False
    try:
        snap = jobs.get(jid1)
        assert snap is not None
        assert "next_runs" not in snap
        assert "then" not in snap
        # JSON-Serialisierung darf keine TypeError-Exception werfen (HTTP 500 Verhinderung)
        dumped = json.dumps(snap)
        assert isinstance(dumped, str)
    finally:
        jobs.cancel(jid1)
        _wait(jid1)


def test_request_mit_lambdas_feuert_am_ende():
    """Auch bei dynamisch erzeugten Lambda-Instanzen feuert das final-then am Ende."""
    ergebnisse = []
    # 3x Request mit verschiedenen Lambda-Instanzen
    jid1, s1 = jobs.request("P_lambda", _echo_cmd(2), cwd=None, kind="transcribe",
                            then=lambda: ergebnisse.append("fertig"))
    assert s1 is True
    jid2, s2 = jobs.request("P_lambda", _echo_cmd(2), cwd=None, kind="transcribe",
                            then=lambda: ergebnisse.append("fertig"))
    assert s2 is False

    _wait(jid1)
    deadline = time.time() + 6.0
    while time.time() < deadline:
        with jobs._lock:
            if ("P_lambda", "transcribe") not in jobs._active and not any(k[0] == "P_lambda" for k in jobs._pending):
                if ergebnisse:
                    break
        time.sleep(0.02)

    assert len(ergebnisse) >= 1










def _fail_cmd(n=2):
    """Wie `_echo_cmd`, endet aber mit Exitcode 1 — der Job wird `error`."""
    code = ("import sys\n" + f"for i in range({n}):\n    print(f'zeile {{i}}', flush=True)\n"
            + "import time; time.sleep(0.4)\nsys.exit(1)\n")
    return [sys.executable, "-c", code]


def test_vorgemerkter_nachlauf_laeuft_auch_nach_einem_GESCHEITERTEN_lauf():
    """Der vorgemerkte Nachlauf haengt an einer FREMDEN Datei, nicht am Ausgang dieses Laufs.

    `jobs.request` merkt genau einen Nachlauf vor, wenn der Slot belegt ist — das ist der
    Weg, auf dem ein Upload WAEHREND eines laufenden Laufs trotzdem verarbeitet wird
    (`app.py:1410`). `_run` gatete beides, `next_runs` UND `then`, auf `status == "done"`.
    Damit ging der Nachlauf verloren, sobald der laufende Job rot endete: die eben
    hochgeladene Aufnahme wurde NIE transkribiert, ohne eine einzige Zeile darueber.

    Die beiden Rueckrufe haben verschiedene Vertraege, und genau das war die Verwechslung:
    `then` heisst „bei Erfolg weiter in der Kette" (fetch -> transcribe, `app.py:1123`) und
    bleibt auf `done` — eine Transkription ueber Dateien, die gar nicht geladen wurden, waere
    sinnlos. `next_runs` heisst „jemand anders braucht einen Lauf, du warst besetzt", und
    dafuer ist der Ausgang DIESES Laufs ohne Bedeutung; nach einem Fehlschlag ist der zweite
    Anlauf sogar der wichtigere.

    Das Loch gibt es seit es `request` gibt (ein Absturz beim Modell-Laden reichte).
    Erreichbar wurde es mit #417: seitdem endet ein Lauf auch dann rot, wenn nur die
    KI-Korrektur ausgefallen ist — ein Anbieterausfall ist Alltag, ein Absturz nicht.

    Die Art ist `correct` und nicht `transcribe`, obwohl der Anlassfall ein Upload waehrend
    einer Transkription ist: `GPU_KINDS` serialisiert `transcribe` PROJEKTUEBERGREIFEND, der
    Test haenge damit am Nachhall fremder Tests (gemessen: `request` gab `started=False`, der
    Test mass nichts mehr). Der Mechanismus sitzt in `_run` und kennt die Art nicht.
    """
    gelaufen = []
    orig_start = jobs.start

    def zaehl_start(project, cmd, cwd, kind, then=None, env=None, base=None, bases=None):
        jid, started = orig_start(project, cmd, cwd, kind, then=then, env=env,
                                  base=base, bases=bases)
        if started:
            gelaufen.append(jid)
        return jid, started

    jobs.start = zaehl_start
    try:
        jid1, s1 = jobs.request("P_rot", _fail_cmd(2), cwd=None, kind="correct")
        assert s1 is True
        jid2, s2 = jobs.request("P_rot", _echo_cmd(1), cwd=None, kind="correct")
        assert s2 is False, "Slot war nicht belegt — der Test misst den Nachlauf gar nicht"

        assert _wait(jid1)["status"] == "error", "Vorbedingung: der erste Lauf endet ROT"
        frist = time.time() + 5.0
        while time.time() < frist and len(gelaufen) < 2:
            time.sleep(0.02)
    finally:
        jobs.start = orig_start

    assert len(gelaufen) == 2, ("der vorgemerkte Nachlauf ist ausgefallen — die zweite "
                                f"Aufnahme waere nie transkribiert worden (gelaufen={gelaufen})")


def test_abbruch_startet_KEINEN_nachlauf():
    """Negativkontrolle zum Test darueber — und die teurere Haelfte.

    Ein Abbruch ist eine ENTSCHEIDUNG, kein Unfall. Waere `next_runs` schlicht ungegatet,
    startete ein Cancel genau den Lauf neu, den jemand eben gestoppt hat — auf der GPU, mit
    dem Modell, ueber Minuten. Ohne diese Zeile hier waere `status == "cancelled"` ein
    Wächter, den kein Test rot bekommt.
    """
    gelaufen = []
    orig_start = jobs.start

    def zaehl_start(project, cmd, cwd, kind, then=None, env=None, base=None, bases=None):
        jid, started = orig_start(project, cmd, cwd, kind, then=then, env=env,
                                  base=base, bases=bases)
        if started:
            gelaufen.append(jid)
        return jid, started

    jobs.start = zaehl_start
    try:
        jid1, s1 = jobs.request("P_abbr", _fail_cmd(2), cwd=None, kind="correct")
        assert s1 is True
        jid2, s2 = jobs.request("P_abbr", _echo_cmd(1), cwd=None, kind="correct")
        assert s2 is False, "Slot war nicht belegt — der Test misst den Nachlauf gar nicht"

        jobs.cancel(jid1)
        assert _wait(jid1)["status"] == "cancelled", "Vorbedingung: der Lauf gilt als abgebrochen"
        frist = time.time() + 2.0
        while time.time() < frist and len(gelaufen) < 2:
            time.sleep(0.02)
    finally:
        jobs.start = orig_start

    assert gelaufen == [jid1], f"ein Abbruch hat einen Nachlauf gestartet (gelaufen={gelaufen})"


def test_then_feuert_NICHT_nach_einem_gescheiterten_lauf():
    """Die andere Haelfte der Aufspaltung: `then` bleibt auf `done`.

    Sein einziger Produktivnutzer ist `app.py:1123` (fetch -> transcribe). Scheitert der
    Download, gibt es nichts zu transkribieren — ein `then` auf `error` startete einen Lauf
    ueber Dateien, die nie ankamen. Ohne diesen Test waere die Aufspaltung nur zur Haelfte
    bewacht, und die Mutation `then_callbacks = list(r.get("then", []))` (also ungegatet)
    bliebe gruen.
    """
    gefeuert = []
    jid, s = jobs.start("P_thenrot", _fail_cmd(1), cwd=None, kind="fetch",
                        then=lambda: gefeuert.append(True))
    assert s is True
    assert _wait(jid)["status"] == "error", "Vorbedingung: der Lauf endet ROT"
    time.sleep(0.3)                      # dem Rueckruf Zeit geben, falsch zu feuern
    assert gefeuert == [], "then ist nach einem gescheiterten Lauf gefeuert"
