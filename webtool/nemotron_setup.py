"""Optionale NeMo-Pakete installieren — automatisch nur die GEPRUEFTE Fassung.

Der PyPI-Stand 3.0.0 kann Nemotron 3 (RoPE) nicht laden. Darum wird eine
konkrete Revision des offiziellen NVIDIA-Repos installiert.

Entscheidung Marcus 2026-09-24: die Automatik (Serverstart, Auswahl in den
Einstellungen) installiert ausschliesslich `GEPRUEFTE_REVISION` und fragt GitHub
nie. Vorher zog sie alle 14 Tage den jeweils neuesten, ungeprueften main-Stand
und ersetzte dabei eine funktionierende Installation. Den neuesten Stand holt nur
der Knopf (`force=True`); eine so geholte Fassung traegt `quelle: "knopf"` und
wird von der Automatik nie angefasst. Eine neuere gepruefte Fassung kommt mit
einem Transkribor-Update: dann ist der Pin ein anderer, und eine Automatik-
Installation (auch ein Alt-Marker ohne `quelle`) wird darauf gehoben.
"""

import contextlib
import datetime as dt
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from importlib import metadata
from pathlib import Path

from packaging.version import InvalidVersion, Version

from . import device

GEPRUEFTE_REVISION = "cf724ac337d1ebc7d0dda1e23fb80916f52927a5"
_GITHUB_API = "https://api.github.com/repos/NVIDIA-NeMo/Speech/commits/main"
_TRITON = {"2.10": "3.6.0.post26", "2.11": "3.6.0.post26",
           "2.12": "3.7.1.post27", "2.13": "3.7.1.post27",
           "2.14": "3.8.0.post28"}
_lock = threading.Lock()
_state = {"laeuft": False, "ergebnis": "", "fehler": "", "phase": "", "fortschritt": 0,
          "download_current": 0, "download_total": 0, "download_speed": 0,
          "download_eta": None}
_AV = "av>=11,<19"
_haelt_pip_lock = False
_RAW_PROGRESS = re.compile(r"^Progress (\d+) of (\d+)\s*$")


def _phase(name: str, fortschritt: int | None = None) -> None:
    with _lock:
        _state.update(phase=name, download_current=0, download_total=0,
                      download_speed=0, download_eta=None)
        if fortschritt is not None:
            _state["fortschritt"] = fortschritt


def _progress(line: str, previous: tuple[int, int, float] | None,
              now: float) -> tuple[int, int, float] | None:
    """One pip raw sample describes one file; a new file starts a new measurement."""
    match = _RAW_PROGRESS.fullmatch(line.strip())
    if not match:
        return previous
    current, total = map(int, match.groups())
    if total:
        current = min(current, total)
    prior = previous if previous and previous[1] == total and current >= previous[0] else None
    speed = 0
    eta = None
    if prior and total and current > prior[0] and now > prior[2]:
        speed = int((current - prior[0]) / (now - prior[2]))
        if speed > 0:
            eta = (total - current) / speed
    with _lock:
        _state.update(download_current=current, download_total=total,
                      download_speed=speed, download_eta=eta)
    return current, total, now


def _marker_path() -> Path:
    return Path(sys.prefix) / ".nemotron3-update.json"


def _version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except (metadata.PackageNotFoundError, OSError, UnicodeError, ValueError):
        return None


def _marker() -> dict:
    try:
        daten = json.loads(_marker_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    # Gueltiges JSON, aber kein Objekt (`[]`, `null`): `.get` darauf warf im Serverstart.
    return daten if isinstance(daten, dict) else {}


def _triton_pin() -> str | None:
    torch = _version("torch") or ""
    if sys.platform != "win32" or "+cu" not in torch:
        return None
    m = re.match(r"^(\d+\.\d+)\.", torch)
    if not m or m.group(1) not in _TRITON:
        raise RuntimeError(f"Keine gepruefte Triton-Windows-Fassung fuer PyTorch {torch}")
    return _TRITON[m.group(1)]


def _bereit(marker: dict) -> bool:
    if marker.get("fehlgeschlagen"):
        return False
    nemo = _version("nemo-toolkit") or ""
    lhotse = _version("lhotse") or ""
    try:
        lhotse_ok = Version(lhotse) >= Version("2.0.0a6")
    except InvalidVersion:
        lhotse_ok = False
    if (not nemo or nemo.startswith("3.0.") or not lhotse_ok
            or not _version("torch")):
        return False
    if not (marker.get("revision") and marker.get("version") == nemo
            or GEPRUEFTE_REVISION[:7] in nemo):
        return False
    try:
        pin = _triton_pin()
    except RuntimeError:
        return False
    return pin is None or _version("triton-windows") == pin


def _pin_fehler() -> str:
    """Grund, aus dem KEINE Installation gelingen kann — leer, wenn es keinen gibt."""
    if sys.version_info >= (3, 14):
        return ("NeMo kann mit Python 3.14 oder neuer derzeit nicht eingerichtet werden. "
                "Bitte Python 3.13 oder eine kompatible Transkribor-Umgebung verwenden.")
    try:
        _triton_pin()
    except RuntimeError as exc:
        return str(exc)
    return ""


def zustand() -> dict:
    marker = _marker()
    with _lock:
        lauf = dict(_state)
    bereit = _bereit(marker)
    if not lauf["laeuft"] and not lauf["fehler"]:
        # Nach einem Neustart ist `_state` leer. Jeder Grund, aus dem die Automatik gerade
        # NICHTS tut, muss trotzdem auf der Seite stehen — sonst sagte sie "startet
        # automatisch" (CodeRabbit-Bot an PR #645): die Tagesbremse und eine unvollstaendige
        # Knopf-Fassung lassen `_faellig()` False, ohne dass `_state` davon weiss.
        lauf["fehler"] = _pin_fehler()
        if not lauf["fehler"] and marker.get("fehlgeschlagen"):
            lauf["fehler"] = ("Die letzte Einrichtung ist fehlgeschlagen — automatisch erst "
                              "am nächsten Tag wieder.")
        elif not lauf["fehler"] and not bereit and marker.get("quelle") == "knopf":
            lauf["fehler"] = ("Die per Knopf geholte NeMo-Fassung ist unvollständig — "
                              "„Geprüfte Fassung einrichten“ richtet sie neu ein.")
    geeignet, hardware_grund = device.nemotron_eignung()
    return {"bereit": bereit, "geeignet": geeignet, "hardware_grund": hardware_grund,
            "version": _version("nemo-toolkit") or "",
            "revision": marker.get("revision", ""), "geprueft": marker.get("geprueft", ""),
            **lauf}


def _heute() -> str:
    return dt.date.today().isoformat()


def _faellig() -> bool:
    """Muss die AUTOMATIK etwas tun? Die Knoepfe fragen das nicht."""
    if _pin_fehler():
        # Steht vorher fest, dass es nicht gelingen kann (torch ausserhalb der Triton-
        # Tabelle), liefe sonst TAEGLICH ein 900-s-pip, das erst danach scheitert.
        return False
    marker = _marker()
    if marker.get("fehlgeschlagen"):
        # Tagesbremse: ohne sie startete jeder Serverstart nach einem Fehlschlag
        # (offline, kaputter Stand) erneut ein bis zu 900 s langes pip.
        return marker.get("am") != _heute()
    # VOR `_bereit`: eine Knopf-Fassung fasst die Automatik nie an — auch nicht, wenn nur
    # ein Nebenpaket (Triton) abweicht. Repariert wird sie ueber den Knopf "gepruefte
    # Fassung einrichten", nicht still.
    if marker.get("quelle", "auto") == "knopf":
        return False
    if not _bereit(marker):
        return True
    return marker.get("revision") != GEPRUEFTE_REVISION


def _latest_revision() -> str:
    request = urllib.request.Request(_GITHUB_API, headers={"User-Agent": "Transkribor"})
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 -- feste HTTPS-API
        revision = json.load(response)["sha"]
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("ungueltige NVIDIA-Revision")
    return revision


def _run(args: list[str], timeout: int) -> str | None:
    if args[:3] == ["-m", "pip", "install"]:
        return _run_pip(args, timeout)
    try:
        done = subprocess.run([sys.executable, *args], capture_output=True, text=True,  # noqa: S603
                              encoding="utf-8", errors="replace", timeout=timeout,
                              check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"{type(exc).__name__}: {exc}"
    if done.returncode:
        return (done.stderr or done.stdout).strip()[-700:] or f"Exit {done.returncode}"
    return None


def _pip_raw_supported() -> bool:
    """An older pip can still install NeMo, but cannot report raw progress."""
    version = _version("pip")
    if not version:
        return False
    try:
        return bool(Version(version) >= Version("24.1"))
    except InvalidVersion:
        return False


def _run_pip(args: list[str], timeout: int) -> str | None:
    """Read pip's documented raw byte counters while retaining a bounded error tail."""
    progress_arg = ["--progress-bar=raw"] if _pip_raw_supported() else []
    command = [sys.executable, *args[:3], *progress_arg, *args[3:]]
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE,  # noqa: S603 — fixed Python executable and pip args
                                stderr=subprocess.PIPE, bufsize=0)
    except OSError as exc:
        return f"{type(exc).__name__}: {exc}"
    chunks: queue.Queue[tuple[str, bytes | None]] = queue.Queue(maxsize=32)
    stopped = threading.Event()

    def offer(source: str, chunk: bytes | None) -> None:
        while not stopped.is_set():
            try:
                chunks.put((source, chunk), timeout=0.1)
                return
            except queue.Full:
                continue

    def read_output(source: str) -> None:
        stream = proc.stdout if source == "stdout" else proc.stderr
        if stream is None:
            offer(source, None)
            return
        try:
            while chunk := stream.read(4096):
                offer(source, chunk)
        finally:
            offer(source, None)

    for source in ("stdout", "stderr"):
        threading.Thread(target=read_output, args=(source,),
                         name=f"nemotron-pip-{source}", daemon=True).start()
    stderr_tail = b""
    previous = None
    progress_line = bytearray()
    oversized = False
    finished: set[str] = set()
    deadline = time.monotonic() + timeout
    try:
        while len(finished) < 2:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                source, chunk = chunks.get(timeout=remaining)
            except queue.Empty:
                raise subprocess.TimeoutExpired(command, timeout) from None
            if chunk is None:
                finished.add(source)
            elif source == "stderr":
                stderr_tail = (stderr_tail + chunk)[-700:]
            else:
                for char in chunk:
                    if char in (10, 13):
                        if progress_line and not oversized:
                            previous = _progress(progress_line.decode("ascii", "replace"),
                                                 previous, time.monotonic())
                        progress_line.clear()
                        oversized = False
                    elif not oversized:
                        if len(progress_line) < 128:
                            progress_line.append(char)
                        else:
                            progress_line.clear()
                            oversized = True
        if progress_line and not oversized:
            _progress(progress_line.decode("ascii", "replace"), previous, time.monotonic())
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(command, timeout)
        proc.wait(timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        stopped.set()
        proc.kill()
        proc.wait()
        return f"{type(exc).__name__}: {exc}"
    finally:
        stopped.set()
    if proc.returncode:
        return stderr_tail.decode("utf-8", "replace").strip()[-700:] or f"Exit {proc.returncode}"
    return None


def _torch_festhalten() -> str:
    """Constraints fuer den Audio-Decoder und die INSTALLIERTE torch-Fassung.

    CodeRabbit-Bot an PR #645: NeMo verlangt `torch>=2.7.0`, und `pip install --upgrade`
    hebt eine aeltere Abhaengigkeit dann von PyPI — auf Windows ein CPU-Rad statt des
    cu128-Baus: die GPU waere still weg (dieselbe Falle wie beim CPU-Rad in `setup.js`).
    Mit dem Constraint scheitert so ein Lauf LAUT (ResolutionImpossible -> Fehlermeldung
    auf der Seite), statt die Installation zu tauschen. Heute greift er nicht (2.11.0+cu128
    erfuellt >=2.7.0); er ist die Wache fuer den naechsten Pin.
    """
    zeilen = [f"{name}=={v}" for name in ("torch", "torchaudio") if (v := _version(name))]
    zeilen.append(_AV)
    fd, pfad = tempfile.mkstemp(prefix="nemo-constraints-", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(zeilen) + "\n")
    return pfad


def _marker_entwerten() -> None:
    path = _marker_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"fehlgeschlagen": True, "am": _heute()}), encoding="utf-8")
    os.replace(tmp, path)


def _install_gesperrt(force: bool = False, neuester: bool = True) -> str:
    """`force` = ein Knopf; `neuester` waehlt, welcher: der neueste NVIDIA-Stand oder
    die gepruefte Fassung (zweiter Knopf, Entscheidung Marcus 2026-09-24 — sonst fuehrte
    nach einem Fehlschlag am selben Tag nur der ungepruefte Weg weiter)."""
    if not force and not _faellig():
        return "aktuell"
    _phase("nemo", 0)
    # Zuerst: steht fest, dass Triton nicht passt, wirft das HIER — vorher lief erst das
    # 900-s-pip von NeMo komplett durch und scheiterte danach.
    pin = _triton_pin()
    revision = _latest_revision() if force and neuester else GEPRUEFTE_REVISION
    marker = _marker()
    url = f"https://codeload.github.com/NVIDIA-NeMo/Speech/zip/{revision}"
    if _bereit(marker) and (marker.get("revision") == revision
                            or revision[:7] in (_version("nemo-toolkit") or "")):
        result = "aktuell"
    else:
        # Wird ein pip-Lauf abgebrochen, darf ein alter Erfolgsmarker den
        # moeglicherweise halb installierten Paketstand nicht freigeben.
        _marker_entwerten()
        constraints = _torch_festhalten()
        try:
            _phase("nemo")
            error = _run(["-m", "pip", "install", "--no-cache-dir", "--upgrade",
                          *(["-c", constraints] if constraints else []),
                          _AV, f"nemo-toolkit[asr] @ {url}"], 900)
        finally:
            if constraints:
                with contextlib.suppress(OSError):
                    os.remove(constraints)
        if error:
            raise RuntimeError(f"NeMo-Installation: {error}")
        result = "installiert"
    _phase("triton", 33)
    if pin and _version("triton-windows") != pin:
        _phase("triton")
        error = _run(["-m", "pip", "install", "--no-cache-dir",
                      f"triton-windows=={pin}"], 300)
        if error:
            raise RuntimeError(f"Triton-Installation: {error}")
        result = "installiert"
    # Eigener Prozess: der Server hat vielleicht schon eine alte NeMo-Fassung importiert.
    _phase("pruefung", 67)
    probe = ("from webtool.audio_runtime import pruefen; pruefen(); "
             "from nemo.collections.asr.models import SortformerEncLabelModel; "
             "from nemo.collections.asr.modules.transformer_encoder import "
             "_SUPPORTED_SELF_ATTENTION_MODELS; "
             "assert 'rope' in _SUPPORTED_SELF_ATTENTION_MODELS")
    _phase("pruefung")
    error = _run(["-c", probe], 120)
    if error:
        _marker_entwerten()
        if result == "aktuell":
            # Ein intakter Versionsmarker beweist keinen funktionierenden Import.
            # Die bekannten Begleitpakete koennen ebenso beschaedigt sein.
            lhotse_version = _version("lhotse")
            if lhotse_version:
                _phase("lhotse_reparatur")
                repair = _run(["-m", "pip", "install", "--no-cache-dir", "--force-reinstall",
                               "--no-deps", f"lhotse=={lhotse_version}"], 300)
                if repair:
                    raise RuntimeError(f"Lhotse-Reparatur: {repair}")
            if pin:
                _phase("triton_reparatur")
                repair = _run(["-m", "pip", "install", "--no-cache-dir", "--force-reinstall",
                               "--no-deps", f"triton-windows=={pin}"], 300)
                if repair:
                    raise RuntimeError(f"Triton-Reparatur: {repair}")
            _phase("nemo_reparatur")
            repair = _run(["-m", "pip", "install", "--no-cache-dir", "--force-reinstall",
                           "--no-deps", _AV, f"nemo-toolkit[asr] @ {url}"], 900)
            if repair:
                raise RuntimeError(f"NeMo-Reparatur: {repair}")
            _phase("pruefung")
            error = _run(["-c", probe], 120)
            if not error:
                result = "installiert"
        if error:
            raise RuntimeError(f"NeMo-Pruefung: {error}")
    path = _marker_path()
    tmp = path.with_suffix(".tmp")
    # Holt der Knopf genau den Pin, gilt die Fassung als Automatik-Fassung — sonst
    # erreichte ein spaeterer Pin-Wechsel diese Installation nie mehr.
    quelle = "auto" if revision == GEPRUEFTE_REVISION else "knopf"
    tmp.write_text(json.dumps({"revision": revision, "version": _version("nemo-toolkit"),
                               "geprueft": _heute(), "quelle": quelle}),
                   encoding="utf-8")
    os.replace(tmp, path)
    return result


def _install(force: bool = False, neuester: bool = True) -> str:
    global _haelt_pip_lock
    if not force and not _faellig():
        return "aktuell"
    # Steht vorher fest, dass es nicht gelingen kann, nicht erst die Sperre erwerben (und
    # yt-dlp bis zu 215 s warten lassen), um danach in `_install_gesperrt` zu scheitern.
    grund = _pin_fehler()
    if grund:
        raise RuntimeError(grund)
    # yt-dlp und NeMo schreiben beide in dieselbe venv. Deren vorhandene, nach
    # venv getrennte pip-Sperre gilt deshalb auch fuer diesen gesamten Ablauf.
    from . import sperre, ytdlp_update

    lockziel = ytdlp_update._lockziel()
    os.makedirs(os.path.dirname(lockziel) or ".", exist_ok=True)
    # Dieselbe Sperrart wie yt-dlp, NICHT strikt: der strikte Warter raeumte ein Lock ohne
    # Merker nie nach der Uhr ab — genau den Zustand, den `beim_ende()` beim Shutdown
    # absichtlich erzeugt. Danach wartete JEDER Start 32 min und scheiterte (Befund beider
    # Kalt-Leser). Der erzwungene Griff ist sicher, weil jeder Halter kuerzer bleibt als
    # die Frist: yt-dlp <= 215 s, NeMo <= 1750 s gegen frist(1900) = 1905 s.
    with sperre.datei(lockziel, stale=ytdlp_update._lock_stale()) as gehalten:
        if not gehalten:
            raise RuntimeError("NeMo-Installation: Pip-Sperre nicht verfuegbar")
        with _lock:
            _haelt_pip_lock = True
        try:
            return _install_gesperrt(force, neuester)
        finally:
            with _lock:
                _haelt_pip_lock = False


def haelt_pip_sperre() -> bool:
    """Haelt die NeMo-Einrichtung DIESES Prozesses gerade die gemeinsame pip-Sperre?"""
    with _lock:
        return _haelt_pip_lock


def beim_ende() -> bool:
    """Bei Serverende den eigenen Sperrmerker aufgeben, falls pip noch laufen kann."""
    from . import sperre, ytdlp_update

    with _lock:
        if not _haelt_pip_lock:
            return False
        return sperre.merker_aufgeben(ytdlp_update._lockziel())


def _hintergrund(force: bool, neuester: bool = True) -> None:
    try:
        result = _install(force, neuester)
        with _lock:
            _state.update(laeuft=False, ergebnis=result, fehler="", phase="fertig", fortschritt=100,
                          download_current=0, download_total=0, download_speed=0,
                          download_eta=None)
    except Exception as exc:
        with _lock:
            _state.update(laeuft=False, ergebnis="fehler", fehler=str(exc)[-700:],
                          phase="fehler", download_current=0, download_total=0,
                          download_speed=0, download_eta=None)


def starten(force: bool = False, neuester: bool = True) -> bool:
    """`force=False` = Automatik (Pin, Tagesbremse). Die Knoepfe setzen `force=True`:
    `neuester=True` holt den ungeprueften NVIDIA-Stand, `neuester=False` richtet die
    gepruefte Fassung ein — auch am Tag eines Fehlschlags."""
    if not device.nemotron_eignung()[0]:
        return False
    if not force and not _faellig():
        return False
    with _lock:
        if _state["laeuft"]:
            return False
        _state.update(laeuft=True, ergebnis="", fehler="", phase="vorbereitung", fortschritt=0,
                      download_current=0, download_total=0, download_speed=0,
                      download_eta=None)
    try:
        threading.Thread(target=_hintergrund, args=(force, neuester), name="nemotron-setup",
                         daemon=True).start()
    except RuntimeError:
        with _lock:
            _state.update(laeuft=False, ergebnis="fehler", fehler="Installationsfaden nicht gestartet",
                          phase="fehler")
        return False
    return True
