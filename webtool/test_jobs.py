import os
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
