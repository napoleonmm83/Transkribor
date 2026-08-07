"""FastAPI-Backend für den Transkribor-Editor (Stufe 1)."""
import json
import os
import shutil
import sys

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import fetch as fetch_mod
from . import jobs
from . import llm
from . import paths
from . import settings
from .edit_model import build_edit_doc
from .render_md import render_md

app = FastAPI(title="Transkribor Editor")

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")
MAX_FETCH_URLS = 20


def _bases(project: str):
    return paths.transcript_bases(project)


def _audio_bases(project: str) -> set:
    """Basisnamen der Audiodateien. Damit sind Dateien im Workspace schon nach dem
    Upload/Download sichtbar — nicht erst, wenn Whisper die Roh-JSON geschrieben hat."""
    adir = paths.audio_dir(project)
    if not os.path.isdir(adir):
        return set()
    return {os.path.splitext(f)[0] for f in os.listdir(adir) if f.lower().endswith(AUDIO_EXT)}


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


def _validate(*names: str) -> None:
    try:
        for n in names:
            paths.safe_name(n)
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
                audio = _audio_bases(name)
                files = []
                for base in sorted(set(_bases(name)) | audio):
                    files.append({
                        "base": base,
                        "has_audio": base in audio,
                        "has_raw": os.path.exists(_raw_path(name, base)),
                        "has_edit": os.path.exists(_edit_path(name, base)),
                        "has_md": os.path.exists(_md_path(name, base)),
                    })
            except ValueError:
                continue  # ponytail: un-nennbaren Ordner überspringen statt die ganze Liste zu 500en
            out.append({"name": name, "files": files, "active_jobs": jobs.active_for(name)})
    return {"projects": out}


class NewProject(BaseModel):
    name: str


@app.post("/api/projects")
def create_project(body: NewProject):
    try:
        name = paths.safe_name(body.name.strip())
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")
    pdir = paths.project_dir(name)
    if os.path.exists(pdir):
        raise HTTPException(status_code=409, detail="Projekt existiert bereits")
    os.makedirs(os.path.join(pdir, "audio"))
    return {"ok": True, "name": name}


@app.delete("/api/projects/{project}")
def delete_project(project: str):
    _validate(project)
    if jobs.active_for(project):
        raise HTTPException(status_code=409, detail="Job läuft — erst abbrechen")
    pdir = paths.project_dir(project)
    if not os.path.isdir(pdir):
        raise HTTPException(status_code=404, detail="kein Projekt")
    shutil.rmtree(pdir)
    return {"ok": True}


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


def _autocorrect_enabled() -> bool:
    return (os.environ.get("TRANSKRIBOR_AUTOCORRECT") or "1").lower() not in ("0", "false", "no")


def _autocorrect(project: str) -> None:
    """Korrektur nach der Transkription. Laeuft im Job-Thread, nicht im Browser — ein
    geschlossener Tab darf die Kette nicht unterbrechen. `correct run` ist idempotent, holt
    also genau die neu transkribierten Dateien nach."""
    if not _autocorrect_enabled():
        return
    jobs.request(project, [sys.executable, "-m", "webtool.correct", "run", project],
                 paths.ROOT, "correct")


def _start_transcribe(project: str):
    """Transkription anstossen; danach automatisch korrigieren."""
    return jobs.request(project, [sys.executable, os.path.join(paths.ROOT, "transcribe.py"), project],
                        paths.ROOT, "transcribe", then=lambda: _autocorrect(project))


@app.post("/api/projects/{project}/transcribe")
def transcribe(project: str):
    _validate(project)
    job_id, started = _start_transcribe(project)
    return {"job_id": job_id, "started": started}


@app.post("/api/projects/{project}/correct")
def correct(project: str):
    _validate(project)
    job_id, started = jobs.request(project, [sys.executable, "-m", "webtool.correct", "run", project],
                                   paths.ROOT, "correct")
    return {"job_id": job_id, "started": started}


@app.post("/api/projects/{project}/files/{base}/correct")
def correct_file(project: str, base: str, force: bool = False):
    _validate(project, base)
    if not os.path.exists(_raw_path(project, base)):
        raise HTTPException(status_code=404, detail=f"kein Roh-Transkript: {base}")
    cmd = [sys.executable, "-m", "webtool.correct", "run", project, base]
    if force:
        cmd.append("--force")                     # nur nach expliziter UI-Bestätigung (human_edited)
    job_id, started = jobs.start(project, cmd, paths.ROOT, "correct")
    return {"job_id": job_id, "started": started}


class FetchBody(BaseModel):
    urls: list[str]


@app.post("/api/projects/{project}/fetch")
def fetch_urls(project: str, body: FetchBody):
    """URL-Import: laedt Audio von YouTube/Instagram und transkribiert genau diese Dateien."""
    _validate(project)
    urls = [u.strip() for u in body.urls if u.strip()]
    if not urls:
        raise HTTPException(status_code=400, detail="keine URL angegeben")
    if len(urls) > MAX_FETCH_URLS:
        raise HTTPException(status_code=400,
                            detail=f"maximal {MAX_FETCH_URLS} URLs pro Auftrag")
    try:
        urls = [fetch_mod.check_url(u) for u in urls]   # zweite Instanz: fetch.py prueft erneut
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # Eigene Job-Art: der Download braucht keine GPU. Als "transcribe" gefuehrt wuerde er von
    # jeder laufenden Transkription blockiert — und die laeuft seit dem Auto-Trigger oft.
    cmd = [sys.executable, "-m", "webtool.fetch", "--download-only", project, *urls]
    job_id, started = jobs.start(project, cmd, paths.ROOT, "fetch",
                                 then=lambda: _start_transcribe(project))
    return {"job_id": job_id, "started": started}


class SettingsBody(BaseModel):
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None          # weggelassen = gespeicherten Key behalten


@app.get("/api/settings")
def get_settings():
    """Nie den Key ausliefern — nur, OB einer hinterlegt ist."""
    return {**settings.public(), "providers": llm.provider_list(),
            "env_key": llm.env_key_hint()}


@app.put("/api/settings")
def put_settings(body: SettingsBody):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "provider" in patch and patch["provider"] not in llm.PROVIDERS:
        raise HTTPException(status_code=400, detail=f"unbekannter Anbieter: {patch['provider']}")
    return settings.public(settings.save(patch))


@app.get("/api/settings/models")
def settings_models():
    """Modellliste live beim Anbieter holen — eine fest verdrahtete Liste waere in drei Monaten falsch."""
    try:
        return {"models": llm.list_models()}
    except llm.LLMError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/settings/test")
def settings_test():
    try:
        return llm.check()
    except llm.LLMError as e:
        return {"ok": False, "detail": str(e)}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    r = jobs.get(job_id)
    if r is None:
        raise HTTPException(status_code=404, detail="kein Job")
    return r


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    if jobs.cancel(job_id) is None:
        raise HTTPException(status_code=404, detail="kein aktiver Job")
    return {"cancelled": True}


@app.post("/api/projects/{project}/audio")
def upload_audio(project: str, file: UploadFile = File(...)):
    _validate(project)
    name = os.path.basename(file.filename or "")           # vom Browser mitgesendete Pfade entfernen
    base, ext = os.path.splitext(name)
    ext = ext.lower()
    _validate(base)
    if ext not in AUDIO_EXT:
        raise HTTPException(status_code=400, detail=f"nicht unterstützte Endung: {ext or '(keine)'}")
    adir = os.path.join(paths.project_dir(project), "audio")
    os.makedirs(adir, exist_ok=True)
    dest = os.path.join(adir, base + ext)
    try:
        with open(dest, "xb") as out:  # exklusiv: FileExistsError statt TOCTOU
            shutil.copyfileobj(file.file, out)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="Datei existiert bereits")
    # Hochladen IST der Startschuss: Transkription (und danach Korrektur) laufen von selbst an.
    # jobs.request() sorgt dafuer, dass ein Mehrfach-Upload hoechstens EINEN Nachlauf anhaengt.
    job_id, started = _start_transcribe(project)
    return {"ok": True, "base": base, "file": base + ext, "job_id": job_id, "started": started}


_STATIC = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(_STATIC, exist_ok=True)  # Build-loser Checkout: Verzeichnis muss existieren
_INDEX = os.path.join(_STATIC, "index.html")


@app.get("/{full_path:path}")
def spa(full_path: str):
    # Unbekannte API-Pfade -> echtes 404 (nicht das SPA-HTML zurueckgeben).
    if full_path == "api" or full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="kein Endpoint")
    # Existierende statische Datei ausliefern, aber nur INNERHALB von _STATIC
    # (Path-Traversal-Schutz: realpath darf _STATIC nicht verlassen).
    if full_path:
        target = os.path.realpath(os.path.join(_STATIC, full_path))
        if target.startswith(os.path.realpath(_STATIC) + os.sep) and os.path.isfile(target):
            return FileResponse(target)
    # Sonst index.html -> der Client-Router (BrowserRouter) uebernimmt die Route.
    if os.path.isfile(_INDEX):
        return FileResponse(_INDEX)
    raise HTTPException(status_code=404, detail="Frontend nicht gebaut")
