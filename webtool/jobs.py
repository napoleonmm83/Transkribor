"""Minimale In-Memory-Job-Registry für langlaufende Subprozesse (Transkription u.a.).

threading + subprocess.Popen; kein asyncio/Celery/Redis. Ein einzelner lokaler Nutzer.
Fortschritt = stdout-Zeilen im Job-Log; via GET /api/jobs/{id} gepollt.
"""
import os
import signal
import subprocess
import sys
import threading
import time
import uuid

from . import settings

_jobs = {}                 # job_id -> record
_active = {}               # (project, kind) -> job_id (Dedupe: je Art einer pro Projekt)
_pending = set()           # (project, kind) mit genau EINEM vorgemerkten Nachlauf
_lock = threading.Lock()

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_PRUNE_AGE = 3600          # fertige Jobs nach 1h vergessen


def _popen_kwargs() -> dict:
    """Auf POSIX eine eigene Prozessgruppe — nur so erreicht der Abbruch spaeter auch die
    Kinder (whisper, claude). Auf Windows leistet das taskkill /T, siehe _kill_tree."""
    return {} if os.name == "nt" else {"start_new_session": True}

# Nur Whisper belegt die GPU dauerhaft und gross (large-v3, ganze Audiolaenge). `correct`
# haengt fast nur an Opus und braucht die GPU nur fuer den kurzen pyannote-Schritt — es hier
# mitzufuehren hiesse, dass eine 25-Minuten-Korrektur jede Transkription blockiert.
GPU_KINDS = ("transcribe",)


def _prune_locked():
    now = time.time()
    dead = [jid for jid, r in _jobs.items()
            if r["status"] in ("done", "error", "cancelled") and r.get("ended") and now - r["ended"] > _PRUNE_AGE]
    for jid in dead:
        _jobs.pop(jid, None)


def start(project: str, cmd: list, cwd, kind: str, then=None):
    """Startet den Job. `then` laeuft NACH erfolgreichem Abschluss (status 'done') im
    Job-Thread — damit haengt die Auto-Korrektur nach der Transkription nicht am Browser."""
    with _lock:
        _prune_locked()
        if (project, kind) in _active:
            return _active[(project, kind)], False
        if kind in GPU_KINDS:
            busy = next((jid for jid, r in _jobs.items()
                         if r["kind"] in GPU_KINDS and r["status"] == "running"), None)
            if busy is not None:
                return busy, False  # Einzel-GPU: nur ein Whisper-Lauf zugleich
        jid = uuid.uuid4().hex[:12]
        _jobs[jid] = {"id": jid, "project": project, "kind": kind, "status": "running",
                      "lines": [], "returncode": None, "started": time.time(),
                      "ended": None, "pid": None, "cancelled": False,
                      "then": [then] if then else []}
        _active[(project, kind)] = jid
    threading.Thread(target=_run, args=(jid, cmd, cwd), daemon=True).start()
    return jid, True


def request(project: str, cmd: list, cwd, kind: str, then=None):
    """Startet den Job — oder merkt genau EINEN Nachlauf vor, wenn der Slot belegt ist.

    Ein Upload/Import soll immer zu einer Verarbeitung fuehren, auch wenn gerade eine laeuft:
    die kennt die eben hochgeladene Datei nicht. Ohne die _pending-Sperre wuerden fuenf
    Uploads fuenf Whisper-Laeufe hinter dem laufenden aufreihen — einer reicht, er sieht
    ohnehin alle inzwischen dazugekommenen Dateien.
    """
    key = (project, kind)
    for _ in range(10):
        jid, started = start(project, cmd, cwd, kind, then=then)
        if started:
            return jid, True
        with _lock:
            if key in _pending:
                return jid, False        # schon vorgemerkt -> der Nachlauf nimmt die neuen Dateien mit
            _pending.add(key)

        def rerun(_key=key):
            with _lock:
                _pending.discard(_key)
            request(project, cmd, cwd, kind, then=then)

        if when_done(jid, rerun):
            return jid, False
        with _lock:                       # jid wurde eben terminal -> Slot frei, gleich nochmal
            _pending.discard(key)
        time.sleep(0.05)
    print(f"Nachlauf fuer {project!r}/{kind} aufgegeben: Slot blieb belegt", file=sys.stderr)
    return None, False


def when_done(job_id: str, fn) -> bool:
    """Haengt `fn` an einen LAUFENDEN Job. False, wenn er unbekannt oder schon terminal ist —
    dann muss der Aufrufer selbst entscheiden (z.B. sofort erneut versuchen)."""
    with _lock:
        r = _jobs.get(job_id)
        if r is None or r["status"] != "running":
            return False
        r["then"].append(fn)
        return True


def _run(jid, cmd, cwd):
    _run_proc(jid, cmd, cwd)
    # Nachlauf AUSSERHALB von _run_proc: dessen finally hat den Slot in _active schon
    # freigegeben, sonst wuerde ein `then`, das denselben Projekt-Job startet, sich selbst
    # aussperren. Und ausserhalb von _lock, sonst blockiert es jobs.start() im Callback.
    with _lock:
        r = _jobs.get(jid)
        callbacks = list(r["then"]) if r and r["status"] == "done" else []
    for fn in callbacks:
        try:
            fn()
        except Exception as e:                # ein kaputter Nachlauf darf den Job nicht faerben
            with _lock:
                r = _jobs.get(jid)            # der Nachlauf dauert Minuten — der Job kann
                if r is not None:             # zwischenzeitlich weggepruned worden sein
                    r["lines"].append(f"NACHLAUF-FEHLER: {e}")


def _run_proc(jid, cmd, cwd):
    try:
        # settings.job_env() reicht das HF_TOKEN aus den Einstellungen durch: die .env laedt nur
        # webtool.ps1, in der Desktop-App gibt es keine — sonst faellt die Diarisierung still aus.
        env = {**os.environ, **settings.job_env(),
               "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=_CREATE_NO_WINDOW, env=env, **_popen_kwargs(),
        )
        with _lock:
            _jobs[jid]["pid"] = proc.pid
            _jobs[jid]["proc"] = proc            # Handle für cancel() (nicht via get() ausgeliefert)
            cancelled = _jobs[jid]["cancelled"]
        if cancelled:                            # cancel() kam an, bevor die pid gesetzt war -> selbst killen
            _kill_tree(proc)
        for line in proc.stdout:
            with _lock:
                _jobs[jid]["lines"].append(line.rstrip("\n"))
        proc.wait()
        with _lock:
            _jobs[jid]["returncode"] = proc.returncode
            _jobs[jid]["status"] = "cancelled" if _jobs[jid]["cancelled"] \
                else ("done" if proc.returncode == 0 else "error")
            _jobs[jid]["ended"] = time.time()
    except Exception as e:  # Launch-Fehler etc. -> kein Zombie 'running'
        with _lock:
            _jobs[jid]["lines"].append(f"JOB-FEHLER: {e}")
            _jobs[jid]["status"] = "cancelled" if _jobs[jid]["cancelled"] else "error"
            _jobs[jid]["ended"] = time.time()
    finally:
        with _lock:
            key = (_jobs[jid]["project"], _jobs[jid]["kind"])
            if _active.get(key) == jid:
                _active.pop(key, None)


def _kill_tree(proc):
    if os.name == "nt":
        # /T killt den ganzen Prozessbaum (python -> [claude.cmd] -> claude/node -> MCP-Kinder);
        # ein blosses terminate() liesse den claude-Subtree verwaisen (vgl. correct.py:147-149).
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                       capture_output=True, creationflags=_CREATE_NO_WINDOW)  # exit!=0 (schon weg) ist ok
        return
    # Dasselbe auf POSIX: die Prozessgruppe aus _popen_kwargs() abraeumen. Ein blosses
    # terminate() liesse whisper/claude als Waisen mit belegter GPU zurueck.
    try:
        sigkill = getattr(signal, 'SIGKILL', 9)  # ponytail: Rueckfall auf 9 nur fuer Tests auf Windows-als-posix
        os.killpg(os.getpgid(proc.pid), sigkill)
    except (ProcessLookupError, PermissionError, OSError):
        proc.terminate()


def cancel(job_id: str):
    """Bricht einen laufenden Job samt Prozessbaum ab. None wenn unbekannt/schon terminal."""
    with _lock:
        r = _jobs.get(job_id)
        if r is None or r["status"] != "running":
            return None
        r["cancelled"] = True                 # Flag IMMER setzen -> deckt den pid=None-Race in _run ab
        proc = r.get("proc")
    if proc is not None and proc.poll() is None:  # poll-gate: nur killen, wenn proc noch lebt (kein PID-Recycling)
        _kill_tree(proc)
    return True


def cancel_all():
    """Alle laufenden Jobs abbrechen — fuer das Herunterfahren des Servers.

    Auf POSIX erreicht das SIGTERM beim Beenden der App nur uvicorn selbst: die Kinder
    sitzen bewusst in eigenen Sitzungen (_popen_kwargs), also erreicht sie auch kein
    Gruppensignal. Ohne diesen Aufruf liefe whisper nach dem Schliessen des Fensters
    als Waise mit belegter GPU weiter. Auf Windows raeumt schon taskkill /T auf.
    """
    with _lock:
        laufend = [jid for jid, r in _jobs.items() if r["status"] == "running"]
    for jid in laufend:
        cancel(jid)
    return laufend


def get(job_id: str):
    with _lock:
        r = _jobs.get(job_id)
        if r is None:
            return None
        snap = dict(r)
        snap["lines"] = list(r["lines"])
        snap.pop("proc", None)                # Popen-Handle ist nicht JSON-serialisierbar
        snap.pop("then", None)                # Callables sind nicht JSON-serialisierbar
        return snap


def active_for(project: str) -> list:
    """[{'id','kind'}, …] der laufenden Jobs des Projekts — transcribe und correct duerfen
    gleichzeitig laufen, deshalb eine Liste."""
    with _lock:
        out = []
        for (proj, _kind), jid in _active.items():
            if proj != project:
                continue
            r = _jobs.get(jid)
            if r is not None and r["status"] == "running":
                out.append({"id": r["id"], "kind": r["kind"]})
        return sorted(out, key=lambda j: j["kind"])
