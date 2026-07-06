"""Pfade + Namensvalidierung (Trust-Boundary: project/base kommen aus der URL)."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def projekte_root() -> str:
    return os.environ.get("TRANSKRIBOR_PROJEKTE") or os.path.join(ROOT, "projekte")


def safe_name(name: str) -> str:
    if not name or "/" in name or "\\" in name or ".." in name or "\x00" in name:
        raise ValueError(f"unsicherer Name: {name!r}")
    return name


def project_dir(project: str) -> str:
    return os.path.join(projekte_root(), safe_name(project))


def transkripte_dir(project: str) -> str:
    return os.path.join(project_dir(project), "transkripte")


def audio_dir(project: str) -> str:
    d = os.path.join(project_dir(project), "audio")
    return d if os.path.isdir(d) else project_dir(project)
