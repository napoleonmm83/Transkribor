"""Minimale In-Memory-Job-Registry für langlaufende Subprozesse (Transkription u.a.).

threading + subprocess.Popen; kein asyncio/Celery/Redis. Ein einzelner lokaler Nutzer.
Fortschritt = stdout-Zeilen im Job-Log; via GET /api/jobs/{id} gepollt.
"""
import os
import subprocess
import threading
import time
import uuid

_jobs = {}                 # job_id -> record
_active = {}               # project -> job_id (Dedupe: ein Job pro Projekt)
_lock = threading.Lock()

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_PRUNE_AGE = 3600          # fertige Jobs nach 1h vergessen


def _prune_locked():
    now = time.time()
    dead = [jid for jid, r in _jobs.items()
            if r["status"] in ("done", "error") and r.get("ended") and now - r["ended"] > _PRUNE_AGE]
    for jid in dead:
        _jobs.pop(jid, None)


def start(project: str, cmd: list, cwd, kind: str):
    with _lock:
        _prune_locked()
        if project in _active:
            return _active[project], False
        if kind == "transcribe":
            running_t = [jid for jid, r in _jobs.items()
                         if r["kind"] == "transcribe" and r["status"] == "running"]
            if running_t:
                return running_t[0], False  # Einzel-GPU: nur ein Transcribe-Job
        jid = uuid.uuid4().hex[:12]
        _jobs[jid] = {"id": jid, "project": project, "kind": kind, "status": "running",
                      "lines": [], "returncode": None, "started": time.time(),
                      "ended": None, "pid": None}
        _active[project] = jid
    threading.Thread(target=_run, args=(jid, cmd, cwd), daemon=True).start()
    return jid, True


def _run(jid, cmd, cwd):
    try:
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=_CREATE_NO_WINDOW, env=env,
        )
        with _lock:
            _jobs[jid]["pid"] = proc.pid
        for line in proc.stdout:
            with _lock:
                _jobs[jid]["lines"].append(line.rstrip("\n"))
        proc.wait()
        with _lock:
            _jobs[jid]["returncode"] = proc.returncode
            _jobs[jid]["status"] = "done" if proc.returncode == 0 else "error"
            _jobs[jid]["ended"] = time.time()
    except Exception as e:  # Launch-Fehler etc. -> kein Zombie 'running'
        with _lock:
            _jobs[jid]["lines"].append(f"JOB-FEHLER: {e}")
            _jobs[jid]["status"] = "error"
            _jobs[jid]["ended"] = time.time()
    finally:
        with _lock:
            proj = _jobs[jid]["project"]
            if _active.get(proj) == jid:
                _active.pop(proj, None)


def get(job_id: str):
    with _lock:
        r = _jobs.get(job_id)
        if r is None:
            return None
        snap = dict(r)
        snap["lines"] = list(r["lines"])
        return snap
