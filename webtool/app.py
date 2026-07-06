"""FastAPI-Backend für den Transkribor-Editor (Stufe 1)."""
import glob
import json
import os

from fastapi import FastAPI, HTTPException

from . import paths
from .edit_model import build_edit_doc

app = FastAPI(title="Transkribor Editor")

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")


def _bases(project: str):
    tdir = paths.transkripte_dir(project)
    if not os.path.isdir(tdir):
        return []
    return sorted({os.path.splitext(os.path.basename(p))[0]
                   for p in glob.glob(os.path.join(tdir, "*.json"))
                   if not p.endswith(".edit.json")})


def find_audio(project: str, base: str):
    adir = paths.audio_dir(project)
    for ext in AUDIO_EXT:
        cand = os.path.join(adir, base + ext)
        if os.path.exists(cand):
            return cand
    return None


def _raw_path(project, base):
    return os.path.join(paths.transkripte_dir(project), base + ".json")


def _edit_path(project, base):
    return os.path.join(paths.transkripte_dir(project), base + ".edit.json")


def _md_path(project, base):
    return os.path.join(paths.transkripte_dir(project), base + ".md")


def load_or_build_doc(project: str, base: str) -> dict:
    epath = _edit_path(project, base)
    if os.path.exists(epath):
        with open(epath, encoding="utf-8") as fh:
            return json.load(fh)
    rpath = _raw_path(project, base)
    if not os.path.exists(rpath):
        raise HTTPException(status_code=404, detail=f"kein Roh-Transkript: {base}")
    with open(rpath, encoding="utf-8") as fh:
        raw = json.load(fh)
    audio = find_audio(project, base)
    return build_edit_doc(raw, base=base, project=project,
                          audio=os.path.basename(audio) if audio else "")


@app.get("/api/projects")
def list_projects():
    root = paths.projekte_root()
    out = []
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            if not os.path.isdir(os.path.join(root, name)):
                continue
            files = []
            for base in _bases(name):
                files.append({
                    "base": base,
                    "has_audio": find_audio(name, base) is not None,
                    "has_raw": os.path.exists(_raw_path(name, base)),
                    "has_edit": os.path.exists(_edit_path(name, base)),
                    "has_md": os.path.exists(_md_path(name, base)),
                })
            out.append({"name": name, "files": files})
    return {"projects": out}


@app.get("/api/projects/{project}/files/{base}")
def get_file(project: str, base: str):
    try:
        paths.safe_name(project); paths.safe_name(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    return load_or_build_doc(project, base)
