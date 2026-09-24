"""Optionale NeMo-Pakete installieren und den offiziellen Quellstand nachziehen.

Der PyPI-Stand 3.0.0 kann Nemotron 3 (RoPE) nicht laden. Darum wird eine
konkrete Revision des offiziellen NVIDIA-Repos installiert. Erst ein neuer,
vollstaendig gepruefter Stand wird als aktuell vermerkt.
"""

import datetime as dt
import json
import os
import re
import subprocess
import sys
import threading
import urllib.request
from importlib import metadata
from pathlib import Path

from packaging.version import InvalidVersion, Version

BASELINE_REVISION = "cf724ac337d1ebc7d0dda1e23fb80916f52927a5"
INTERVALL_TAGE = 14
_GITHUB_API = "https://api.github.com/repos/NVIDIA-NeMo/Speech/commits/main"
_TRITON = {"2.10": "3.6.0.post26", "2.11": "3.6.0.post26",
           "2.12": "3.7.1.post27", "2.13": "3.7.1.post27",
           "2.14": "3.8.0.post28"}
_lock = threading.Lock()
_state = {"laeuft": False, "ergebnis": "", "fehler": ""}
_haelt_pip_lock = False


def _marker_path() -> Path:
    return Path(sys.prefix) / ".nemotron3-update.json"


def _version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except (metadata.PackageNotFoundError, OSError, UnicodeError, ValueError):
        return None


def _marker() -> dict:
    try:
        return json.loads(_marker_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


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
            or BASELINE_REVISION[:7] in nemo):
        return False
    try:
        pin = _triton_pin()
    except RuntimeError:
        return False
    return pin is None or _version("triton-windows") == pin


def zustand() -> dict:
    marker = _marker()
    with _lock:
        lauf = dict(_state)
    return {"bereit": _bereit(marker), "version": _version("nemo-toolkit") or "",
            "revision": marker.get("revision", ""), "geprueft": marker.get("geprueft", ""),
            **lauf}


def _faellig() -> bool:
    if not _bereit(_marker()):
        return True
    try:
        tag = dt.date.fromisoformat(_marker()["geprueft"])
    except (KeyError, ValueError):
        return True
    return (dt.date.today() - tag).days >= INTERVALL_TAGE


def _latest_revision() -> str:
    request = urllib.request.Request(_GITHUB_API, headers={"User-Agent": "Transkribor"})
    with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 -- feste HTTPS-API
        revision = json.load(response)["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("ungueltige NVIDIA-Revision")
    return revision


def _run(args: list[str], timeout: int) -> str | None:
    try:
        done = subprocess.run([sys.executable, *args], capture_output=True, text=True,  # noqa: S603
                              encoding="utf-8", errors="replace", timeout=timeout,
                              check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"{type(exc).__name__}: {exc}"
    if done.returncode:
        return (done.stderr or done.stdout).strip()[-700:] or f"Exit {done.returncode}"
    return None


def _marker_entwerten() -> None:
    path = _marker_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"fehlgeschlagen": True}), encoding="utf-8")
    os.replace(tmp, path)


def _install_gesperrt(force: bool = False) -> str:
    if not force and not _faellig():
        return "aktuell"
    revision = _latest_revision()
    marker = _marker()
    url = f"https://codeload.github.com/NVIDIA-NeMo/Speech/zip/{revision}"
    if _bereit(marker) and (marker.get("revision") == revision
                            or revision[:7] in (_version("nemo-toolkit") or "")):
        result = "aktuell"
    else:
        # Wird ein pip-Lauf abgebrochen, darf ein alter Erfolgsmarker den
        # moeglicherweise halb installierten Paketstand nicht freigeben.
        _marker_entwerten()
        error = _run(["-m", "pip", "install", "--no-cache-dir", "--upgrade",
                      f"nemo-toolkit[asr] @ {url}"], 900)
        if error:
            raise RuntimeError(f"NeMo-Installation: {error}")
        result = "installiert"
    pin = _triton_pin()
    if pin and _version("triton-windows") != pin:
        error = _run(["-m", "pip", "install", "--no-cache-dir",
                      f"triton-windows=={pin}"], 300)
        if error:
            raise RuntimeError(f"Triton-Installation: {error}")
        result = "installiert"
    # Eigener Prozess: der Server hat vielleicht schon eine alte NeMo-Fassung importiert.
    probe = ("from nemo.collections.asr.models import SortformerEncLabelModel; "
             "from nemo.collections.asr.modules.transformer_encoder import "
             "_SUPPORTED_SELF_ATTENTION_MODELS; "
             "assert 'rope' in _SUPPORTED_SELF_ATTENTION_MODELS")
    error = _run(["-c", probe], 120)
    if error:
        _marker_entwerten()
        if result == "aktuell":
            # Ein intakter Versionsmarker beweist keinen funktionierenden Import.
            # Die bekannten Begleitpakete koennen ebenso beschaedigt sein.
            lhotse_version = _version("lhotse")
            if lhotse_version:
                repair = _run(["-m", "pip", "install", "--no-cache-dir", "--force-reinstall",
                               "--no-deps", f"lhotse=={lhotse_version}"], 300)
                if repair:
                    raise RuntimeError(f"Lhotse-Reparatur: {repair}")
            if pin:
                repair = _run(["-m", "pip", "install", "--no-cache-dir", "--force-reinstall",
                               "--no-deps", f"triton-windows=={pin}"], 300)
                if repair:
                    raise RuntimeError(f"Triton-Reparatur: {repair}")
            repair = _run(["-m", "pip", "install", "--no-cache-dir", "--force-reinstall",
                           "--no-deps", f"nemo-toolkit[asr] @ {url}"], 900)
            if repair:
                raise RuntimeError(f"NeMo-Reparatur: {repair}")
            error = _run(["-c", probe], 120)
            if not error:
                result = "installiert"
        if error:
            raise RuntimeError(f"NeMo-Pruefung: {error}")
    path = _marker_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"revision": revision, "version": _version("nemo-toolkit"),
                               "geprueft": dt.date.today().isoformat()}),
                   encoding="utf-8")
    os.replace(tmp, path)
    return result


def _install(force: bool = False) -> str:
    global _haelt_pip_lock
    if not force and not _faellig():
        return "aktuell"
    # yt-dlp und NeMo schreiben beide in dieselbe venv. Deren vorhandene, nach
    # venv getrennte pip-Sperre gilt deshalb auch fuer diesen gesamten Ablauf.
    from . import sperre, ytdlp_update

    lockziel = ytdlp_update._lockziel()
    os.makedirs(os.path.dirname(lockziel) or ".", exist_ok=True)
    with sperre.datei(lockziel, stale=ytdlp_update._lock_stale(),
                      erzwinge_uebernahme=False, wartezeit=1950) as gehalten:
        if not gehalten:
            raise RuntimeError("NeMo-Installation: Pip-Sperre nicht verfuegbar")
        with _lock:
            _haelt_pip_lock = True
        try:
            return _install_gesperrt(force)
        finally:
            with _lock:
                _haelt_pip_lock = False


def beim_ende() -> bool:
    """Bei Serverende den eigenen Sperrmerker aufgeben, falls pip noch laufen kann."""
    from . import sperre, ytdlp_update

    with _lock:
        if not _haelt_pip_lock:
            return False
        return sperre.merker_aufgeben(ytdlp_update._lockziel())


def _hintergrund(force: bool) -> None:
    try:
        result = _install(force)
        with _lock:
            _state.update(laeuft=False, ergebnis=result, fehler="")
    except Exception as exc:
        with _lock:
            _state.update(laeuft=False, ergebnis="fehler", fehler=str(exc)[-700:])


def starten(force: bool = False) -> bool:
    if not force and not _faellig():
        return False
    with _lock:
        if _state["laeuft"]:
            return False
        _state.update(laeuft=True, ergebnis="", fehler="")
    try:
        threading.Thread(target=_hintergrund, args=(force,), name="nemotron-setup",
                         daemon=True).start()
    except RuntimeError:
        with _lock:
            _state.update(laeuft=False, ergebnis="fehler", fehler="Installationsfaden nicht gestartet")
        return False
    return True
