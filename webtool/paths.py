"""Pfade + Namensvalidierung (Trust-Boundary: project/base kommen aus der URL)."""
import glob
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def projekte_root() -> str:
    return os.environ.get("TRANSKRIBOR_PROJEKTE") or os.path.join(ROOT, "projekte")


def safe_name(name: str) -> str:
    if not name or "/" in name or "\\" in name or ":" in name or ".." in name or "\x00" in name:
        raise ValueError(f"unsicherer Name: {name!r}")
    return name


def project_dir(project: str) -> str:
    return os.path.join(projekte_root(), safe_name(project))


def transkripte_dir(project: str) -> str:
    return os.path.join(project_dir(project), "transkripte")


def audio_dir(project: str) -> str:
    d = os.path.join(project_dir(project), "audio")
    return d if os.path.isdir(d) else project_dir(project)


def transcript_bases(project: str) -> list:
    """Basisnamen der Roh-Transkripte (<base>.json), ohne abgeleitete
    <base>.edit.json / <base>.correction.json und ohne Meta-Artefakte (_*.json,
    z.B. _glossar.json aus Stufe 2b)."""
    tdir = transkripte_dir(project)
    if not os.path.isdir(tdir):
        return []
    out = set()
    for p in glob.glob(os.path.join(tdir, "*.json")):
        name = os.path.basename(p)
        if name.startswith("_") or p.endswith((".edit.json", ".correction.json")):
            continue
        out.add(os.path.splitext(name)[0])
    return sorted(out)


def atomic_write(path: str, text: str) -> None:
    """Schreibe erst in .tmp, dann os.replace() -> nie halb-geschriebene Datei."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)
