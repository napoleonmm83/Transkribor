"""FastAPI-Backend für den Transkribor-Editor (Stufe 1)."""
import json
import os
import sys

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import jobs
from . import paths
from .edit_model import build_edit_doc
from .render_md import render_md

app = FastAPI(title="Transkribor Editor")

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")


def _bases(project: str):
    return paths.transcript_bases(project)


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


def _validate(project: str, base: str) -> None:
    try:
        paths.safe_name(project)
        paths.safe_name(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")


def load_or_build_doc(project: str, base: str) -> dict:
    epath = _edit_path(project, base)
    if os.path.exists(epath):
        try:
            with open(epath, encoding="utf-8") as fh:
                return json.load(fh)
        except json.JSONDecodeError:
            pass  # korrupte edit.json -> aus Roh neu aufbauen (self-heal)
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
            try:
                files = []
                for base in _bases(name):
                    files.append({
                        "base": base,
                        "has_audio": find_audio(name, base) is not None,
                        "has_raw": os.path.exists(_raw_path(name, base)),
                        "has_edit": os.path.exists(_edit_path(name, base)),
                        "has_md": os.path.exists(_md_path(name, base)),
                    })
            except ValueError:
                continue  # ponytail: un-nennbaren Ordner überspringen statt die ganze Liste zu 500en
            out.append({"name": name, "files": files})
    return {"projects": out}


@app.get("/api/projects/{project}/files/{base}")
def get_file(project: str, base: str):
    _validate(project, base)
    return load_or_build_doc(project, base)


@app.get("/api/projects/{project}/audio/{base}")
def get_audio(project: str, base: str):
    _validate(project, base)
    audio = find_audio(project, base)
    if not audio:
        raise HTTPException(status_code=404, detail="kein Audio")
    return FileResponse(audio)  # Starlette FileResponse unterstützt HTTP-Range


@app.put("/api/projects/{project}/files/{base}")
async def save_file(project: str, base: str, request: Request):
    _validate(project, base)
    doc = await request.json()
    doc["human_edited"] = True
    tdir = paths.transkripte_dir(project)
    os.makedirs(tdir, exist_ok=True)
    paths.atomic_write(_edit_path(project, base), json.dumps(doc, ensure_ascii=False, indent=1))
    paths.atomic_write(_md_path(project, base), render_md(doc))
    return {"ok": True}


@app.post("/api/projects/{project}/files/{base}/export")
def export_file(project: str, base: str):
    _validate(project, base)
    doc = load_or_build_doc(project, base)
    md = render_md(doc)
    with open(_md_path(project, base), "w", encoding="utf-8") as fh:
        fh.write(md)
    return {"md": md}


@app.post("/api/projects/{project}/transcribe")
def transcribe(project: str):
    try:
        paths.safe_name(project)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    cmd = [sys.executable, os.path.join(paths.ROOT, "transcribe.py"), project]
    job_id, started = jobs.start(project, cmd, paths.ROOT, "transcribe")
    return {"job_id": job_id, "started": started}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    r = jobs.get(job_id)
    if r is None:
        raise HTTPException(status_code=404, detail="kein Job")
    return r


_STATIC = os.path.join(os.path.dirname(__file__), "static")
app.mount("/", StaticFiles(directory=_STATIC, html=True), name="static")
