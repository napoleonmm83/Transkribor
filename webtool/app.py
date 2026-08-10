"""FastAPI-Backend für den Transkribor-Editor (Stufe 1)."""
import json
import os
import shutil
import sys
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from . import auth
from . import device
from . import fetch as fetch_mod
from . import jobs
from . import llm
from . import paths
from . import settings
from .edit_model import build_edit_doc
from .render_md import render_md
from .render_srt import render_srt

# Vor allem anderen: die .env kann TRANSKRIBOR_PROJEKTE & Co. setzen, und die liest
# jeder folgende Zugriff aus os.environ. Frueher taten das die Launcher (webtool.ps1,
# electron/backend.js) — damit sah ein von Hand gestartetes uvicorn die Datei nie.
for _name in settings.load_env():
    print(f"[.env] {_name}", flush=True)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    # Beim Herunterfahren die Kinder mitnehmen. Die Desktop-App schickt dem Server beim
    # Beenden ein SIGTERM — das erreicht auf POSIX nur uvicorn, whisper/claude sitzen in
    # eigenen Sitzungen und blieben sonst als Waisen mit belegter GPU zurueck.
    for jid in jobs.cancel_all():
        print(f"[shutdown] Job {jid} abgebrochen", flush=True)


app = FastAPI(title="Transkribor Editor", lifespan=_lifespan)

# Trust-Boundary Browser. Der Server hoert nur auf 127.0.0.1 — aus dem Netz ist er nicht
# erreichbar. Aber JEDE Seite, die der Nutzer im Browser offen hat, darf ihm "simple"
# Cross-Origin-Requests schicken: multipart-Upload und POST ohne Body loesen keinen
# Preflight aus. Ohne diese Pruefung koennte eine besuchte Fremdseite Audio in ein Projekt
# legen (upload_audio legt den Ordner sogar an) und GPU-Jobs starten. Lesen kann sie die
# Antwort nie — es gibt keine CORS-Header —, es geht ausschliesslich um Schreibzugriffe.
#
# Warum der Origin-Header reicht: der Browser setzt ihn selbst, eine Seite kann ihn nicht
# faelschen. Same-Origin-Aufrufe des eigenen Frontends tragen einen Loopback-Origin (oder
# bei GET gar keinen), der Vite-Dev-Server auf :5173 ebenfalls — beide bleiben nutzbar.
# Nicht-Browser-Aufrufe (curl, die Tests) schicken keinen Origin und laufen unveraendert.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


@app.middleware("http")
async def _nur_lokale_herkunft(request: Request, call_next):
    origin = request.headers.get("origin")
    # "null" (sandboxed iframe, file://) hat keinen Hostnamen -> faellt korrekt durch.
    if origin and (urlparse(origin).hostname or "").lower() not in _LOOPBACK_HOSTS:
        return JSONResponse({"detail": "fremde Herkunft"}, status_code=403)
    return await call_next(request)


AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")
MAX_FETCH_URLS = 20
# Je Whisper-Stufe einmal pro Serverlauf ermittelt: der torch-Import kostet Sekunden,
# und die Antwort aendert sich zur Laufzeit nicht — eine neue GPU erfordert ohnehin einen
# Neustart. Ein Wechsel der Stufe kann die Engine wechseln (device.asr_engine), darum
# ein dict statt eines einzelnen Werts.
_HARDWARE = {}


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


def _srt_path(project, base):
    return os.path.join(paths.transkripte_dir(project), base + ".srt")


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


def _projekt_dateien(project: str):
    """Die Dateiliste eines Projekts. Steht nur noch hier — list_projects zaehlt
    seit Task 3 selbst (eigene Basisnamen-Regel), statt sie ueber diese Funktion
    fuer jedes Projekt einzeln aufzubauen."""
    audio = _audio_bases(project)
    return [
        {
            "base": base,
            "has_audio": base in audio,
            "has_raw": os.path.exists(_raw_path(project, base)),
            "has_edit": os.path.exists(_edit_path(project, base)),
            "has_md": os.path.exists(_md_path(project, base)),
        }
        for base in sorted(set(_bases(project)) | audio)
    ]


@app.get("/api/projects")
def list_projects():
    """Nur die Zusammenfassung: die Galerie zeigt zwei Zahlen je Projekt, die
    Dateiliste holt sich, wer sie braucht, ueber /api/projects/{project}.
    Gemessen an 300 Projekten (am gebauten Code, nicht am Entwurf): 310 -> ~50-115 ms
    (streut mit der Rechnerlast), 13691 -> 902 Zugriffe, 394 -> ~30 KB."""
    root = paths.projekte_root()
    out = []
    if not os.path.isdir(root):
        return {"projects": out}
    for eintrag in os.scandir(root):
        if not eintrag.is_dir():
            continue
        try:
            _validate(eintrag.name)
        except (ValueError, HTTPException):
            continue          # un-nennbaren Ordner ueberspringen, nicht die Liste 500en
        basen, fertig, neuste = set(), 0, 0.0
        try:
            for f in os.scandir(paths.transkripte_dir(eintrag.name)):
                # DirEntry.stat() kommt auf Windows aus dem Verzeichnislisting und
                # kostet keinen zusaetzlichen Zugriff (gemessen: 301 Zugriffe mit wie ohne).
                neuste = max(neuste, f.stat().st_mtime)
                n = f.name
                # spiegelt paths.transcript_bases; auseinanderlaufen faengt
                # test_zusammenfassung_zaehlt_dasselbe_wie_die_dateiliste
                if n.startswith("_") or not n.endswith(".json"):
                    continue
                if n.endswith(".edit.json"):
                    fertig += 1
                    continue
                if n.endswith((".correction.json", ".diar.json")):
                    continue
                basen.add(n[:-len(".json")])
        except FileNotFoundError:
            pass
        try:
            for f in os.scandir(paths.audio_dir(eintrag.name)):
                neuste = max(neuste, f.stat().st_mtime)
                stamm, ext = os.path.splitext(f.name)
                if ext.lower() in AUDIO_EXT:
                    basen.add(stamm)
        except FileNotFoundError:
            pass
        out.append({
            "name": eintrag.name,
            "dateien": len(basen),
            "fertig": fertig,
            # Ordner-mtime nur als Rueckfall: sie bewegt sich NICHT, wenn eine
            # vorhandene Datei ueberschrieben wird (gemessen) — und genau das tut
            # der Editor. Fuer ein leeres Projekt ist sie aber das Einzige, was es gibt.
            "geaendert": neuste or eintrag.stat().st_mtime,
            "active_jobs": jobs.active_for(eintrag.name),
        })
    return {"projects": out}


@app.get("/api/projects/{project}")
def get_project(project: str):
    _validate(project)
    if not os.path.isdir(os.path.join(paths.projekte_root(), project)):
        raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
    return {"name": project, "files": _projekt_dateien(project)}


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


@app.post("/api/projects/{project}/files/{base}/export/srt")
def export_srt(project: str, base: str):
    """Untertitel fuer den YouTube-Upload. Eigener Endpoint statt ?fmt= am Zwilling darueber:
    der muesste dafuer seinen Rueckgabeschluessel `md` aufgeben."""
    _validate(project, base)
    srt = render_srt(load_or_build_doc(project, base))
    paths.atomic_write(_srt_path(project, base), srt)
    return {"srt": srt}


def _autocorrect_enabled() -> bool:
    return (os.environ.get("TRANSKRIBOR_AUTOCORRECT") or "1").lower() not in ("0", "false", "no")


def _autocorrect(project: str) -> None:
    """Korrektur nach der Transkription. Laeuft im Job-Thread, nicht im Browser — ein
    geschlossener Tab darf die Kette nicht unterbrechen. `correct run` ist idempotent, holt
    also genau die neu transkribierten Dateien nach."""
    if not _autocorrect_enabled():
        return
    ok, grund = llm.available()
    if not ok:
        # Kein Job statt eines Jobs, der scheitert: die Transkription ist fertig und
        # nutzbar, es fehlt nur die Korrektur. Eine Zeile ins Log, kein Fehlerzustand.
        print(f"[autocorrect] uebersprungen — {grund}", flush=True)
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


class AuthCodeBody(BaseModel):
    code: str


class SettingsBody(BaseModel):
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None          # weggelassen = gespeicherten Key behalten
    whisper_model: str | None = None    # Qualitaetsstufe der Transkription
    # whisper_lang fehlt hier bewusst: es hat keine UI, und ein ueber die API gesetztes
    # "Deutsch" statt "de" liesse jeden kuenftigen Lauf scheitern, ohne dass der Browser
    # eine Moeglichkeit haette, das zurueckzunehmen. Env und Handbearbeitung bleiben.


@app.get("/api/settings")
def get_settings():
    """Nie den Key ausliefern — nur, OB einer hinterlegt ist."""
    ai_ready, ai_reason = llm.available()
    return {**settings.public(), "providers": llm.provider_list(),
            "env_key": llm.env_key_hint(),
            "whisper_choices": list(settings.WHISPER_CHOICES),
            "ai_ready": ai_ready, "ai_reason": ai_reason}


@app.put("/api/settings")
def put_settings(body: SettingsBody):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "provider" in patch and patch["provider"] not in llm.PROVIDERS:
        raise HTTPException(status_code=400, detail=f"unbekannter Anbieter: {patch['provider']}")
    if "whisper_model" in patch and patch["whisper_model"] not in settings.KNOWN_WHISPER_MODELS:
        raise HTTPException(status_code=400,
                            detail=f"unbekanntes Whisper-Modell: {patch['whisper_model']}")
    return settings.public(settings.save(patch))


@app.get("/api/hardware")
def hardware():
    """Worauf gerechnet wird. 'Warum dauert das so lange' ist die haeufigste Frage —
    wer sieht, dass 'cpu' laeuft, hat die Antwort ohne Support."""
    # Je Whisper-Stufe gecacht, nicht global: auf Apple Silicon haengt die Engine an der
    # Stufe (device.asr_engine), ein einmal gemerktes Ergebnis wuerde nach einem Wechsel
    # das falsche Rechenwerk melden. Der teure Teil ist der torch-Import, und den zahlt
    # man so hoechstens einmal pro Stufe.
    modell = settings.load()["whisper_model"]
    if modell not in _HARDWARE:
        _HARDWARE[modell] = device.describe(modell)
    return _HARDWARE[modell]


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


@app.get("/api/settings/auth")
def settings_auth():
    """Anmeldezustand des eingestellten Abo-Anbieters. Fuer API-Anbieter `unterstuetzt: false`
    — dort IST der Key die Anmeldung."""
    return auth.status(settings.load()["provider"])


@app.post("/api/settings/auth/login")
def settings_auth_login():
    try:
        return auth.start(settings.load()["provider"])
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/settings/auth/login")
def settings_auth_login_state():
    # Auf den eingestellten Anbieter gefiltert: sonst zeigt ein Wechsel waehrend eines
    # laufenden Vorgangs dessen URL unter der Ueberschrift des neuen Anbieters.
    return auth.zustand(settings.load()["provider"])


@app.post("/api/settings/auth/login/code")
def settings_auth_login_code(body: AuthCodeBody):
    """Den aus dem Browser zurueckgebrachten Code an die wartende CLI reichen."""
    try:
        return auth.code(body.code)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/settings/auth/login/cancel")
def settings_auth_login_cancel():
    return auth.abbrechen()


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
