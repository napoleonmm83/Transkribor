"""Minimale In-Memory-Job-Registry für langlaufende Subprozesse (Transkription u.a.).

threading + subprocess.Popen; kein asyncio/Celery/Redis. Ein einzelner lokaler Nutzer.
Fortschritt = stdout-Zeilen im Job-Log; via GET /api/jobs/{id} gepollt.
"""
import os
import re
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

# Womit ein Lauf seinen Wirkungsbereich meldet: eine tab-getrennte Liste von Basisnamen,
# gedruckt BEVOR er arbeitet (transcribe.py, correct.py, fetch.py). Eine eigene Zeile statt
# eines Nachbaus von jobPhases.ts: der Fortschritts-Dialekt sagt, wo ein Lauf GERADE steht —
# gebraucht wird, was er noch anfassen WIRD. Tab als Trenner, weil Dateinamen alles andere
# enthalten dürfen (der URL-Import legt "Video [dQw4w9].m4a" an), aber keinen Tabulator.
SCOPE_PREFIX = "[scope] "
ACTIVE_PREFIX = "[active] "
DONE_PREFIX = "[done] "


def buche_aktive(aktive: set, line: str) -> None:
    """Eine Protokollzeile auf die Menge der GERADE bearbeiteten Aufnahmen anwenden.

    Herausgezogen aus `_run` (#418), damit ein Test dieselbe Regel fahren kann wie der
    Server. Nachgebaut im Test waere sie wertlos: genau daran ist #418 vorbeigelaufen —
    die vorhandenen Tests faelschen `cmd_diarize` mit einer stummen Attrappe und konnten
    deshalb nicht sehen, dass die echte Funktion die Aufnahme mit ihrem eigenen `[done]`
    freigibt, bevor sie in die Poolschlange kommt.

    Mehrere Drucker bedienen dieselbe Menge (`transcribe.py`, `correct.py` in beiden
    Phasen), und derselbe Basisname kommt darin mehrfach vor — deshalb `discard` und nicht
    `remove`: ein zweites `[done]` ist folgenlos, kein KeyError.
    """
    if line.startswith(ACTIVE_PREFIX):
        b = line[len(ACTIVE_PREFIX):].strip()
        if b:
            aktive.add(b)
    elif line.startswith(DONE_PREFIX):
        b = line[len(DONE_PREFIX):].strip()
        if b:
            aktive.discard(b)

_PROZENT_RE = re.compile(r"^\d+%(?:\||\s|$)")
MAX_JOB_LINES = 10_000


def ist_fortschrittszeile(zeile: str) -> bool:
    """Erkennt flüchtige tqdm-Fortschrittszeilen (z. B. '45%|...')."""
    return bool(_PROZENT_RE.match(zeile.strip()))


def fuege_zeile_an(lines: list, line: str) -> None:
    """Fügt eine Zeile an den Puffer an. Flüchtige Fortschrittszeilen (tqdm)
    werden in-place aktualisiert (#371)."""
    if lines and ist_fortschrittszeile(lines[-1]) and ist_fortschrittszeile(line):
        lines[-1] = line
        return
    if len(lines) >= MAX_JOB_LINES:
        # Erste 10 Zeilen (inkl. [scope]) schützen, älteste Zwischenzeile verwerfen
        del lines[10:11]
    lines.append(line)


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


def start(project: str, cmd: list, cwd, kind: str, then=None, env=None, base: str = None, bases: set = None):
    """Startet den Job. `then` laeuft NACH erfolgreichem Abschluss (status 'done') im
    Job-Thread — damit haengt die Auto-Korrektur nach der Transkription nicht am Browser.
    `env` (dict) wird in die Subprozess-Umgebung gemischt; default None aendert nichts."""
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
        initial_bases = set(bases) if bases is not None else ({base} if base is not None else None)
        _jobs[jid] = {"id": jid, "project": project, "kind": kind, "status": "running",
                      # None = Wirkungsbereich noch unbekannt (Zeile noch nicht gedruckt)
                      # -> gilt als "faesst alles an". Siehe SCOPE_PREFIX.
                      "bases": initial_bases,
                      "active_bases": set(),
                      "lines": [], "returncode": None, "started": time.time(),
                      "ended": None, "pid": None, "cancelled": False,
                      "then": [then] if then else [],
                      "next_runs": []}
        _active[(project, kind)] = jid
    threading.Thread(target=_run, args=(jid, cmd, cwd, env), daemon=True).start()
    return jid, True


def request(project: str, cmd: list, cwd, kind: str, then=None, base: str = None):
    """Startet den Job — oder merkt genau EINEN Nachlauf vor, wenn der Slot belegt ist.

    Ein Upload/Import soll immer zu einer Verarbeitung fuehren, auch wenn gerade eine laeuft:
    die kennt die eben hochgeladene Datei nicht. Ohne die _pending-Sperre wuerden fuenf
    Uploads fuenf Whisper-Laeufe hinter dem laufenden aufreihen — einer reicht, er sieht
    ohnehin alle inzwischen dazugekommenen Dateien.
    """
    key = (project, kind, base)
    for _ in range(10):
        if base is not None:
            jid, started = start(project, cmd, cwd, kind, then=then, base=base)
        else:
            jid, started = start(project, cmd, cwd, kind, then=then)
        if started:
            return jid, True
        with _lock:
            if key in _pending:
                return jid, False        # schon vorgemerkt -> der Nachlauf nimmt die neuen Dateien mit
            _pending.add(key)

        def rerun(_key=key, _jid=jid):
            # Die Vormerkung wird IMMER geraeumt, der Neustart nur ausserhalb eines Abbruchs —
            # und die Reihenfolge ist der ganze Punkt. Bliebe der Schluessel liegen, waere der
            # Weg DAUERHAFT vergiftet: die Zeile `if key in _pending: return jid, False` weiter
            # oben steigt dann sofort aus, OHNE einen neuen Nachlauf zu registrieren. Gemessen —
            # nach einem Abbruch lag `('P','correct',None)` noch im Set, und jeder spaetere
            # Upload waehrend eines laufenden Laufs desselben Projekts wurde still verworfen,
            # bis zum Neustart des Servers. Es war also nicht EIN verlorener Nachlauf, sondern
            # jeder folgende.
            #
            # Der Abbruch-Riegel sitzt HIER und nicht in `_run`: dort ist der Schluessel nicht
            # bekannt (er steckt in diesem Abschluss), und ein Aufraeumen ueber `(projekt, art)`
            # traefe auch Vormerkungen fremder Basisnamen. Ein Abbruch ist eine Entscheidung —
            # denselben Lauf danach neu zu starten waere das Gegenteil dessen, worum gebeten
            # wurde; seine Vormerkung zu behalten waere schlicht ein Leck.
            #
            # ER GILT ABER NUR FUER DIE EIGENE ARBEIT, und das ist keine Feinheit: `start()`
            # gibt fuer `GPU_KINDS` den laufenden Whisper-Job eines BELIEBIGEN Projekts als
            # Blocker zurueck (Einzel-GPU, `:82-86`) — `_jid` ist dann ein FREMDER Job. Ohne
            # den Projekt-/Art-Vergleich nahm der Abbruch von Projekt Q den vorgemerkten Lauf
            # von Projekt P mit, ueber das der Nutzer gar nichts gesagt hat: dessen eben
            # hochgeladene Aufnahme wurde nie transkribiert, ohne eine Zeile darueber.
            # Gemessen (Codex-Gegenreview): `gestartete Jobs: [('Q', …)]`, P fehlte.
            # „Ein Abbruch ist eine Entscheidung" gilt fuer die abgebrochene Arbeit; fuer alles,
            # was bloss dahinter in der Schlange stand, ist er eine fremde Nachricht.
            #
            # `base` wird BEWUSST nicht verglichen: innerhalb desselben (Projekt, Art) ist der
            # Blocker per Dedupe genau der Lauf, den der Nutzer gemeint hat.
            with _lock:
                _pending.discard(_key)
                blocker = _jobs.get(_jid) or {}
                abgebrochen = (blocker.get("status") == "cancelled"
                               and blocker.get("project") == project
                               and blocker.get("kind") == kind)
            if abgebrochen:
                return
            request(project, cmd, cwd, kind, then=then, base=base)

        if when_done(jid, rerun):
            return jid, False
        with _lock:                       # jid wurde eben terminal -> Slot frei, gleich nochmal
            _pending.discard(key)
        time.sleep(0.05)
    print(f"Nachlauf fuer {project!r}/{kind} aufgegeben: Slot blieb belegt", file=sys.stderr)
    return None, False


def when_done(job_id: str, fn) -> bool:
    """Haengt `fn` an einen LAUFENDEN Job. False, wenn er unbekannt oder schon terminal ist —
    dann muss der Aufrufer selbst entscheiden (z.B. sofort erneut versuchen).

    **`fn` feuert bei JEDEM terminalen Ausgang — `done`, `error` UND `cancelled`.** Das ist
    nicht der Vertrag von `then` (das bleibt auf `done`) und war bis #417 auch nicht der von
    hier; wer den Rueckruf nur bei Erfolg laufen lassen will, fragt den Status SELBST ab.
    Heute ist das gefahrlos, weil es genau EINEN Produktivaufrufer gibt (`request`s `rerun`,
    der genau das tut) — der zweite erbt die Eigenschaft sonst still. Der Grund steht in
    `_run`: `rerun` raeumt seine Vormerkung aus `_pending`, und die muss auch nach einem
    Abbruch weg, sonst ist der Nachlauf-Weg dauerhaft vergiftet."""
    with _lock:
        r = _jobs.get(job_id)
        if r is None or r["status"] != "running":
            return False
        r.setdefault("next_runs", []).append(fn)
        return True


def _run(jid, cmd, cwd, env):
    _run_proc(jid, cmd, cwd, env)
    # Nachlauf AUSSERHALB von _run_proc: dessen finally hat den Slot in _active schon
    # freigegeben, sonst wuerde ein `then`, das denselben Projekt-Job startet, sich selbst
    # aussperren. Und ausserhalb von _lock, sonst blockiert es jobs.start() im Callback.
    # ZWEI Rueckrufarten, ZWEI Vertraege — sie hingen bis #417 an derselben Bedingung
    # (`status != "done"` -> return), und das war eine Verwechslung mit Datenverlust:
    #
    # `then` heisst „bei Erfolg weiter in der Kette". Der einzige Produktivnutzer ist
    # `app.py:1123` (fetch -> transcribe); eine Transkription ueber Dateien, die gar nicht
    # geladen wurden, waere sinnlos. Bleibt auf `done`.
    #
    # `next_runs` heisst „jemand anders braucht einen Lauf, du warst besetzt" (`request`).
    # Das ist der Weg, auf dem ein Upload WAEHREND eines laufenden Laufs ueberhaupt
    # verarbeitet wird — `app.py:1410`. Der Ausgang DIESES Laufs ist dafuer ohne Bedeutung:
    # der Nachlauf haengt an einer FREMDEN Datei. Endete der laufende Job rot, ging er
    # ersatzlos verloren und die eben hochgeladene Aufnahme wurde nie transkribiert, ohne
    # eine Zeile darueber. Das Loch gibt es seit es `request` gibt (ein Absturz beim
    # Modell-Laden reichte); erreichbar wurde es mit #417, seit ein blosser Anbieterausfall
    # den Lauf rot enden laesst — und der ist Alltag, ein Absturz nicht.
    #
    # `cancelled` gehoert zu `next_runs` DAZU, obwohl danach nichts neu starten soll: der
    # Rueckruf raeumt seine Vormerkung aus `_pending`, und die muss auch nach einem Abbruch
    # weg (sonst ist der Weg dauerhaft vergiftet — die Begruendung samt Messung steht in
    # `request.rerun`, wo der Schluessel bekannt ist). Ob er danach neu startet, entscheidet
    # er selbst. Hier stehenzubleiben hiesse, den Riegel an der Stelle zu setzen, an der die
    # noetige Information fehlt.
    with _lock:
        r = _jobs.get(jid)
        if not r:
            return
        next_runs = list(r.get("next_runs", []))
        then_callbacks = list(r.get("then", [])) if r["status"] == "done" else []
        project = r["project"]
        kind = r["kind"]

    # 1. Zuerst Folge-Läufe (rerun) ausführen, um den nächsten Batch-Teilschritt zu starten
    for fn in next_runs:
        try:
            fn()
        except Exception as e:
            with _lock:
                r = _jobs.get(jid)
                if r is not None:
                    fuege_zeile_an(r["lines"], f"NACHLAUF-FEHLER: {e}")

    # 2. Prüfen, ob noch Folge-Läufe für (Projekt, Art) aktiv oder vorgemerkt sind
    with _lock:
        folge_jid = _active.get((project, kind))
        hat_pending = any(k[0] == project and k[1] == kind for k in _pending)
        if (folge_jid or hat_pending) and folge_jid != jid:
            # Nachlauf existiert -> `then` an den Folge-Job weiterreichen, damit autocorrect
            # erst nach Abschluss ALLER Transkriptionen des Projekts feuert (#Option1)
            if folge_jid and folge_jid in _jobs:
                for fn in then_callbacks:
                    if fn not in _jobs[folge_jid]["then"]:
                        _jobs[folge_jid]["then"].append(fn)
                then_callbacks = []

    # 3. Wenn die Kette komplett abgeschlossen ist: finale `then`-Callbacks ausführen
    for fn in then_callbacks:
        try:
            fn()
        except Exception as e:
            with _lock:
                r = _jobs.get(jid)
                if r is not None:
                    fuege_zeile_an(r["lines"], f"NACHLAUF-FEHLER: {e}")


def _run_proc(jid, cmd, cwd, env=None):
    try:
        # settings.job_env() reicht die Whisper-Einstellungen durch: die .env laedt nur
        # webtool.ps1, in der Desktop-App gibt es keine. `env` (z.B. TRANSKRIBOR_FETCH_SPRACHE)
        # gewinnt gegen beide — der pro-Job-Wert ist spezifischer als der systemweite.
        full_env = {**os.environ, **settings.job_env(),
                    "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
                    **(env or {})}
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=_CREATE_NO_WINDOW, env=full_env, **_popen_kwargs(),
        )
        with _lock:
            _jobs[jid]["pid"] = proc.pid
            _jobs[jid]["proc"] = proc            # Handle für cancel() (nicht via get() ausgeliefert)
            cancelled = _jobs[jid]["cancelled"]
        if cancelled:                            # cancel() kam an, bevor die pid gesetzt war -> selbst killen
            _kill_tree(proc)
        for line in proc.stdout:
            line = line.rstrip("\n")
            with _lock:
                fuege_zeile_an(_jobs[jid]["lines"], line)
                # Nur die ERSTE Zeile zaehlt: der Lauf druckt sie, bevor er arbeitet, und
                # spaeter kaeme sie hoechstens aus Transkripttext, der so beginnt.
                if _jobs[jid]["bases"] is None and line.startswith(SCOPE_PREFIX):
                    _jobs[jid]["bases"] = {b for b in line[len(SCOPE_PREFIX):].split("\t") if b}
                else:
                    buche_aktive(_jobs[jid]["active_bases"], line)
        proc.wait()
        with _lock:
            _jobs[jid]["returncode"] = proc.returncode
            _jobs[jid]["status"] = "cancelled" if _jobs[jid]["cancelled"] \
                else ("done" if proc.returncode == 0 else "error")
            _jobs[jid]["ended"] = time.time()
    except Exception as e:  # Launch-Fehler etc. -> kein Zombie 'running'
        with _lock:
            fuege_zeile_an(_jobs[jid]["lines"], f"JOB-FEHLER: {e}")
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
        snap.pop("next_runs", None)           # Callables sind nicht JSON-serialisierbar
        snap.pop("active_bases", None)        # Set ist nicht JSON-serialisierbar
        if isinstance(snap.get("bases"), set):
            snap["bases"] = list(snap["bases"])
        return snap


def remove_base(project: str, base: str) -> None:
    """Entfernt eine gelöschte Aufnahme sofort aus dem Wirkungsbereich aller laufenden Jobs."""
    with _lock:
        for (proj, _kind), jid in _active.items():
            if proj != project:
                continue
            r = _jobs.get(jid)
            if r is not None:
                if r.get("bases") is not None:
                    r["bases"].discard(base)
                if r.get("active_bases") is not None:
                    r["active_bases"].discard(base)


def betrifft(project: str, base: str, active_only: bool = False) -> dict | None:
    """Der laufende Job, der GENAU DIESE Aufnahme anfasst — sonst None.

    Ein Lauf druckt seinen Wirkungsbereich als erste Zeile (`SCOPE_PREFIX`), bevor er
    arbeitet: `transcribe` die noch nicht transkribierten Aufnahmen, `correct` die des
    Laufs, `fetch` gar keine (er legt neue an).

    Mit `active_only=True` (für `delete_file`) wird nur blockiert, wenn die Aufnahme
    in genau diesem Moment aktiv bearbeitet/geschrieben wird (`[active]`).
    Mit `active_only=False` (für `rename_file`, `retranscribe_file`) gilt der gesamte geplante Scope.
    """
    with _lock:
        for (proj, _kind), jid in _active.items():
            if proj != project:
                continue
            r = _jobs.get(jid)
            if r is None or r["status"] != "running":
                continue
            if active_only:
                if base in r.get("active_bases", set()):
                    return {"id": r["id"], "kind": r["kind"]}
            else:
                if r["bases"] is None or base in r["bases"]:
                    return {"id": r["id"], "kind": r["kind"]}
    return None


def active_for(project: str) -> list:
    """[{'id','kind', 'bases'}, …] der laufenden Jobs des Projekts — transcribe und correct duerfen
    gleichzeitig laufen, deshalb eine Liste."""
    with _lock:
        out = []
        for (proj, _kind), jid in _active.items():
            if proj != project:
                continue
            r = _jobs.get(jid)
            if r is not None and r["status"] == "running":
                item = {"id": r["id"], "kind": r["kind"]}
                if r.get("bases") is not None:
                    item["bases"] = list(r["bases"])
                out.append(item)
        return sorted(out, key=lambda j: j["kind"])
