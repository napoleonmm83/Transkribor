"""FastAPI-Backend für den Transkribor-Editor (Stufe 1)."""
import errno
import glob
import io
import json
import os
import shutil
import sys
import time
import uuid
import zipfile
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, StrictInt

from . import auth
# `as _correct` ist PFLICHT, nicht Stil: weiter unten steht `def correct(project)` (der
# Endpunkt). Ein unaliasiertes `from . import correct` wuerde davon ueberschrieben, und
# `correct.diarize_enabled()` liefe erst zur REQUEST-Zeit in einen AttributeError — kein
# Fehler beim Import, kein roter Test beim Start, ein 500er im Betrieb. Nicht "aufraeumen".
#
# Was dieser Import NEU aufmacht: `correct.py` wurde bisher NUR im Subprozess geladen — ein
# Import- oder Syntaxfehler dort kostete einen fehlgeschlagenen Korrekturjob. Jetzt haengt der
# SERVERSTART daran (Editor, Upload, Einstellungen inklusive). Gemessen und deshalb vertretbar:
# 8,2 ms marginal (llm/paths/settings/edit_model/render_md sind ohnehin geladen), kein Faden,
# kein Dateizugriff beim Import. Eine Falle bleibt: `CLAUDE_PARALLEL` liest
# `TRANSKRIBOR_PARALLEL` beim Import, also VOR `settings.load_env()` weiter unten — der Wert
# wird im Serverprozess nirgends benutzt, wer ihn hier je liest, liest an der `.env` vorbei.
from . import correct as _correct
from . import device
from . import diarize as _diarize
from . import fetch as fetch_mod
from . import jobs
from . import llm
from . import paths
from . import projekt as _projekt
from . import settings
from . import sperre
from . import sprachen as _sprachen
from . import ytdlp_update
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
    # #253: die faellige yt-dlp-Kalenderpruefung gehoert HIERHER, nicht vor jeden URL-Import.
    # Dort (`fetch._hole_yt_dlp()`) lag sie zwischen „Adresse eingefuegt" und „Download
    # beginnt" und kostete den Wartenden bis zu 120 s pip.
    #
    # **Im Faden laeuft nur das pip.** `auto_an()` und `faellig()` laufen HIER, auf dem
    # Event-Loop, vor dem `yield` — gemessen 54,7 ms kalt, danach ~6 ms (zwei
    # Metadaten-Zugriffe von der Platte). Folgenlos, aber „laeuft im Faden" waere eine
    # Behauptung, die der Kontrollfluss nicht deckt; wer hier ein drittes Tor dazunimmt,
    # misst wieder.
    #
    # `beim_start()` wirft nie — Bedingung dafuer, dass das hier stehen darf: ein kaputter
    # Selbstaktualisierer laesst den Server trotzdem hochkommen.
    if ytdlp_update.beim_start():
        print("[ytdlp] Kalenderpruefung faellig — aktualisiere im Hintergrund", flush=True)
    yield
    # Beim Herunterfahren die Kinder mitnehmen. Die Desktop-App schickt dem Server beim
    # Beenden ein SIGTERM — das erreicht auf POSIX nur uvicorn, whisper/claude sitzen in
    # eigenen Sitzungen und blieben sonst als Waisen mit belegter GPU zurueck.
    for jid in jobs.cancel_all():
        print(f"[shutdown] Job {jid} abgebrochen", flush=True)
    # #224: laeuft die Selbstaktualisierung noch, ueberlebt ihr pip-Kind uns (POSIX: SIGTERM
    # erreicht nur uvicorn) — der `daemon=True`-Faden stirbt dabei ohne sein `finally`.
    # Nach `cancel_all()`, weil die Jobs die GPU halten und das die dringendere Aufraeumarbeit
    # ist; auf einen Wurf kommt es dabei nicht an (`beim_ende()` ist best effort).
    #
    # Die Zeile sagt, was BEKANNT ist, nicht was vermutet wird: `True` heisst „der eigene Lauf
    # war noch als laufend vermerkt", nicht „pip laeuft in dieser Sekunde" — der Faden kann
    # schon in `_merken()` stehen.
    if ytdlp_update.beim_ende():
        print("[ytdlp] Selbstaktualisierung lief noch — Sperre bleibt, bis die Frist sie "
              "freigibt", flush=True)


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


def _dateistand(pfad: str) -> str:
    """Zustand der Datei als Zeichenkette — die Grundlage des optimistischen Sperrens (#160).

    Aus dem DATEIZUSTAND, nicht aus einem Merker im Serverprozess: die `edit.json` hat drei
    Schreiber, und einer davon (`correct.cmd_apply`) laeuft in einem EIGENEN PROZESS. Ein
    prozessinterner Zaehler bekaeme dessen Schreibvorgang nie zu sehen — er ist aber genau
    der, gegen den hier gesperrt wird.

    **`st_ino` traegt die Eindeutigkeit, nicht die Zeit — und das ist gemessen.** `_ns` ist die
    Breite des FELDES, nicht die Aufloesung des Dateisystems: ueber `paths.atomic_write` auf
    NTFS liegt der kleinste beobachtete Schritt bei rund einer Millisekunde. In 400 dicht
    aufeinanderfolgenden Schreibvorgaengen gleicher Groesse ergaben `mtime_ns`+`size`
    **237 Kollisionen**, mit `st_ino` **null**. Der Dateiindex ist exakt, weil beide Schreiber
    ueber `os.replace` einer Temp-Datei gehen (`paths.atomic_write`, `correct.cmd_apply`) —
    jeder Schreibvorgang bringt also einen neuen Index mit. Er kostet nichts: derselbe
    `os.stat`.

    `st_mtime_ns` und `st_size` bleiben daneben stehen. Sie erkennen den Fall, in dem ein
    Dateisystem Indizes wiederverwendet (POSIX vergibt frei gewordene Inodes neu), und
    `st_mtime` allein waere ohnehin zu grob — an der Sekunden-Aufloesung scheitert Pythons
    eigene .pyc-Invalidierung, der Vorfall steht in der Wurzel-CLAUDE.md.

    **Die leere Zeichenkette heisst „die Datei gibt es nicht" und ist eine ECHTE Erwartung,
    kein „egal".** Sie deckt den Fall, in dem der Korrekturlauf die `edit.json` erst ANLEGT,
    waehrend der Editor sie noch nicht kannte — ohne das bliebe genau die Haelfte von #160
    offen (jede frisch transkribierte Datei). „Egal" ist das FEHLEN des Schluessels, siehe
    `save_file`.

    **Nur `FileNotFoundError` faellt auf `""` zurueck, jeder andere `OSError` fliegt weiter.**
    `except OSError` deckte auch `PermissionError`, `EIO` und einen zu langen Pfad — und machte
    daraus „die Datei gibt es nicht". Damit kippte die Sperre in die falsche Richtung: haelt
    ein Client `""` und ist die vorhandene Datei gerade nicht abfragbar, vergleicht `save_file`
    `"" != ""`, findet keine Abweichung und schreibt darueber. „Nicht ermittelbar" wuerde zu
    „nicht geschuetzt" — genau die Rueckfallrichtung, die bei einer Schutzflagge nie gelten
    darf (dieselbe Regel wie `_is_human_edited`: wer die Zusage nicht LESEN kann, darf sie
    nicht ueberschreiben).

    Der Preis ist benannt: ein Virenscanner-Handle auf der `edit.json` macht Laden und
    Speichern zu einem 500 statt zu einem stillen Verlust. Ein Editor, der sagt „ich kann
    gerade nicht", ist besser als einer, der eine Korrektur wegwirft.
    """
    try:
        st = os.stat(pfad)
    except FileNotFoundError:
        return ""
    return f"{st.st_mtime_ns}-{st.st_size}-{st.st_ino}"


def _srt_path(project, base):
    return os.path.join(paths.transkripte_dir(project), base + ".srt")


def _validate(*names: str) -> None:
    try:
        for n in names:
            paths.safe_name(n)
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")


def _sicherer_projektname(roh: str) -> str:
    """Namensraum-Riegel als 400 (K1 Glied 1, #416): ein Projektname, der einer
    Protokoll-Marke gleicht ([active], [done], [scope], [scope+], [fetch]) oder
    eckige Klammern trägt, macht Job-Zeilen für die Konsumenten mehrdeutig.

    Nur auf ANLEGE-/UMBENENNWEGEN (diese Funktion) — der Lesepfad bleibt bei
    ``_validate``/``safe_name``, sonst sperrte ein Altprojekt ``active`` den
    Nutzer von seinen eigenen Daten aus. Reparaturweg für Altprojekte:
    Umbenennen auf einen sauberen Namen (rename_project prüft nur das Ziel).
    """
    try:
        return paths.sicherer_projektname(roh)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _json_objekt(pfad: str) -> dict:
    """`json.load`, aber ein Nicht-Objekt gilt als kaputt — als `ValueError`.

    Gueltiges JSON ist noch lange kein Dokument: eine Liste kommt durch `json.load` und stirbt
    erst am `.update`/`.get` des Aufrufers — mit `AttributeError`, also glatt an dessen
    Rueckfall vorbei. Gemessen an einer `edit.json` mit `["kein Objekt"]`: `GET …/files/S1`
    lieferte **200 mit der Liste**, und das Umbenennen endete mit **500 NACH dem `os.rename`**.
    Dieselbe Wache wie `correct._load` (#190).
    """
    with open(pfad, encoding="utf-8") as fh:
        daten = json.load(fh)
    if not isinstance(daten, dict):
        raise ValueError(f"{pfad}: JSON-Objekt erwartet, {type(daten).__name__} gelesen")
    return daten


def _ist_unlesbar(pfad: str) -> bool:
    """Liegt dort eine Datei, die sich NICHT als JSON-Objekt lesen laesst?

    Eine fehlende Datei ist nicht „unlesbar", sondern nichts zu retten (`False`) — dieselbe
    Trennung wie beim `FileNotFoundError`-Vorbehalt in `settings.load`.
    """
    if not os.path.exists(pfad):
        return False
    try:
        _json_objekt(pfad)
    except (OSError, ValueError):
        return True
    return False


def load_or_build_doc(project: str, base: str) -> dict:
    epath = _edit_path(project, base)
    geheilt = ""
    # VOR dem Lesen, nicht danach (#160): faellt ein fremder Schreibvorgang dazwischen, ist der
    # Stand damit AELTER als der gelieferte Inhalt — ein spaeterer PUT bekommt 409, obwohl der
    # Client nichts falsch gemacht hat. Andersherum (erst lesen, dann stat) waere der Stand
    # JUENGER als der Inhalt, und derselbe PUT ginge durch: der Client ueberschriebe eine
    # Fassung, die er nie gesehen hat. Von den beiden Fehlern ist die ueberfluessige Rueckfrage
    # der harmlose.
    stand = _dateistand(epath)
    if os.path.exists(epath):
        try:
            return {**_json_objekt(epath), "dateistand": stand}
        except (OSError, ValueError) as e:
            # OSError deckt das Fenster zwischen `os.path.exists` und dem `open`: `_datei_weg`
            # (Loeschen, Neu-Transkribieren) raeumt die edit.json weg, waehrend ein offener
            # Editor pollt. Der Rueckfall unten ist fuer "keine edit.json" ohnehin der
            # richtige Weg — vorher gab genau dieses Rennen 500.
            # ValueError, nicht JSONDecodeError: sind die BYTES nicht als UTF-8 dekodierbar,
            # wirft schon das Lesen im Textmodus einen UnicodeDecodeError — ebenfalls ein
            # ValueError, aber KEIN JSONDecodeError (#190, gemessen). Vorher gab genau diese
            # Datei 500 statt der Selbstheilung, die zwei Zeilen weiter unten steht.
            # Selbstheilung ja, aber nicht STILL (#197): der Nutzer sieht sonst ein sauberes
            # Transkript und haelt es fuer seines — die Korrekturen und Sprechernamen, an
            # denen er gearbeitet hat, fehlen darin schlicht. Das Feld reist mit dem Dokument
            # in den Editor (Hinweis) und mit dem naechsten PUT zurueck, wo es das
            # Beiseitelegen ausloest. `pass` genuegte fuer den Rueckfall, nicht fuer die Zusage.
            geheilt = type(e).__name__
    rpath = _raw_path(project, base)
    if not os.path.exists(rpath):
        raise HTTPException(status_code=404, detail=f"kein Roh-Transkript: {base}")
    try:
        raw = _json_objekt(rpath)
    except (OSError, ValueError) as e:
        # Hier gibt es KEINEN Rueckfall — die Roh-JSON ist die Quelle, aus der die
        # Selbstheilung oben baut. 500 bleibt also 500, aber mit Namen statt als
        # AttributeError-Traceback (`build_edit_doc` auf einer Liste): der Nutzer soll
        # sehen, WELCHE Datei kaputt ist, statt "Internal Server Error" zu lesen.
        raise HTTPException(status_code=500,
                            detail=f"Roh-Transkript unlesbar: {base} "
                                   f"({type(e).__name__})") from None
    audio = find_audio(project, base)
    doc = build_edit_doc(raw, base=base, project=project,
                         audio=os.path.basename(audio) if audio else "")
    if geheilt:
        doc["selbstgeheilt"] = geheilt
    doc["dateistand"] = stand
    return doc


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
        # edit_basen separat sammeln statt fertig direkt hochzuzaehlen: eine verwaiste
        # <base>.edit.json (Rohtranskript geloescht, Editordatei stehengeblieben) darf nicht in
        # fertig zaehlen, ohne auch in dateien mitzuzaehlen -- sonst fertig > dateien, im
        # Widerspruch zu _projekt_dateien (die pruefen has_edit nur fuer tatsaechlich
        # existierende Basen). Erst nach beiden Durchlaeufen die Schnittmenge bilden.
        basen, edit_basen, neuste = set(), set(), 0.0
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
                    edit_basen.add(n[:-len(".edit.json")])
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
            "fertig": len(edit_basen & basen),
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


class EinstellungenBody(BaseModel):
    sprache: str | None = None
    korrektur: str | None = None
    # `mehrsprachig` ist die Ankersprach-Ergaenzung: die gewaehlte Sprache bleibt die
    # Hauptsprache, weitere werden im Verlauf erkannt. None = Feld nicht gesendet.
    mehrsprachig: bool | None = None


class DateiEinstellungenBody(EinstellungenBody):
    """Der Datei-PUT kann eines mehr als der Projekt-PUT: die Sprecherzahl.

    Eigenes Modell, statt das Feld ins geteilte zu legen — dort naehme der Projekt-Endpunkt es
    entgegen und wuerfe es weg, also ein Schalter, der nichts tut und nichts sagt. So faellt es
    dort unter die normale Behandlung unbekannter Felder (Pydantic ignoriert sie), und es gibt
    nur EINE Stelle, an der `sprecher` ueberhaupt vorkommt.
    """
    # StrictInt, nicht int: Pydantic wandelt `true` sonst nach `1` um (bool ist eine
    # int-Subklasse) — ein versehentlich gesendeter Haken landete als „1 Sprecher" in der
    # Datei, waehrend `projekt._sprecher_wert` denselben Wert VERWIRFT. Zwei Schichten mit
    # verschiedener Auffassung davon, was gueltig ist, ist die Divergenz-Falle; strikt
    # gelesen sagen beide dasselbe. Kostet ausserdem `"5"` als String — richtig so, das
    # Frontend schickt eine Zahl.
    sprecher: StrictInt | None = None


def _projekt_body(d: dict) -> dict:
    """Die EINE Antwortform beider Projekt-Einstellungs-Endpunkte.

    Vorher bauten GET und PUT je ein eigenes Literal, und dem PUT fehlten `sprach_choices`
    und `tiefen` — waehrend `api.saveProjektEinstellungen` seinen Rueckgabewert als denselben
    Typ tippt. Dieselbe Falle wie `_settings_body` (#239): es knallt nicht, solange der
    Aufrufer die Antwort zusammenmischt, und faellt beim ersten auf, der es nicht tut.

    `sprecher_max` ist ein reiner SERVER-Wert (wie im Datei-Endpunkt): die Vorschau beim
    Hinzufuegen prueft den Bereich selbst, und `sprachen.SPRECHER_MAX` soll dafuer nicht ein
    zweites Mal im Frontend stehen. Ein Projekt-STANDARD fuer die Sprecherzahl entsteht damit
    NICHT — es gibt bewusst keinen (#264, die Zahl gehoert der Aufnahme); hier reist nur die
    Obergrenze.
    """
    return {"sprache": d["sprache"], "korrektur": d["korrektur"],
            "mehrsprachig": d["mehrsprachig"],
            "sprach_choices": _sprachen.fuer_frontend(), "tiefen": _sprachen.TIEFEN,
            "sprecher_max": _sprachen.SPRECHER_MAX}


@app.get("/api/projects/{project}/einstellungen")
def projekteinstellungen(project: str):
    _validate(project)
    return _projekt_body(_projekt.laden(project))


@app.put("/api/projects/{project}/einstellungen")
def projekteinstellungen_speichern(project: str, body: EinstellungenBody):
    _validate(project)
    _sicherer_projektname(project)   # speichern() legt den Projektordner selbst an
    fehler = _sprachen.pruef_fehler(sprache=body.sprache, korrektur=body.korrektur,
                                    mehrsprachig=body.mehrsprachig)
    if fehler:
        raise HTTPException(status_code=400, detail=fehler)
    # speichern() ueberspringt None-Werte (isinstance-Pruefung je Feld) -> leerer Body ist
    # sicher, und ein PUT ohne `mehrsprachig` laesst den Haken stehen (Partial-Update).
    d = _projekt.speichern(project, {"sprache": body.sprache, "korrektur": body.korrektur,
                                     "mehrsprachig": body.mehrsprachig})
    return _projekt_body(d)


@app.get("/api/projects/{project}/files/{base}/einstellungen")
def dateieinstellungen(project: str, base: str):
    """Effektive Sprache + Korrektur-Tiefe EINER Datei (Override, sonst Projekt-Standard) plus
    die Auswahlen — das Datei-Pendant des Projekt-Endpunkts (s. projekteinstellungen)."""
    _validate(project, base)
    if not find_audio(project, base) and not os.path.exists(_raw_path(project, base)):
        raise HTTPException(status_code=404, detail=f"keine Datei: {base}")
    # Drei Werte statt einem: `mehrsprachig` ist der EFFEKTIVE Wert (was die Transkription
    # nimmt), `mehrsprachig_eigen` der Datei-Override (`null` = folgt dem Projekt) und
    # `mehrsprachig_projekt` der Standard, den sie dann erbt. Ohne die letzten beiden kann die
    # Oberflaeche „folgt dem Projekt" nicht von einem gleichlautenden Override unterscheiden
    # und den Rueckweg nicht beschriften (#166).
    #
    # EIN Lesevorgang (`datei_ansicht`), nicht fuenf Einzelabfragen: sonst koennen `mehrsprachig`
    # und `mehrsprachig_eigen` aus verschiedenen Staenden stammen, wenn daneben geschrieben wird.
    # `sprecher_max` reist mit den uebrigen Auswahlen: das Eingabefeld prueft den Bereich
    # selbst (sonst laese der Nutzer den 400er des Servers), und eine zweite Zahl im Frontend
    # waere genau die Divergenz, gegen die `pruef_fehler` die EINE Quelle ist.
    # `diarisierung_aktiv` reist wie `sprecher_max` als reiner Server-Wert mit: das Feld
    # „Anzahl Sprecher" ist ohne Diarisierung ein toter Schalter (#266). Die Auskunft ist
    # belastbar, weil `settings.job_env()` `TRANSKRIBOR_DIARIZE` NICHT anfasst — der
    # correct-Subprozess liest exakt denselben Wert wie dieser Server. (Hier stand die
    # Aufzaehlung „nur WHISPER_MODEL/WHISPER_LANG"; sie wurde mit `TRANSKRIBOR_PARALLEL`
    # falsch, ohne dass die Zusicherung selbst gelitten haette. Die Eigenschaft, auf die es
    # ankommt, ist die Abwesenheit DIESES Schluessels — nicht die Laenge der Liste.)
    #
    # Sie beantwortet AUSDRUECKLICH nur den Kill-Switch. Ob pyannote wirklich rechnen
    # wuerde, sagt das SCHWESTERFELD `pyannote_da` (#270): gecacht je Serverlauf, ohne
    # torch im Request-Pfad (find_spec + Dateistat, Details in diarize.verfuegbar).
    # Offen bleibt dort der Laufzeitfall (GPU voll) — best-effort beim Lauf wie bisher.
    return {**_projekt.datei_ansicht(project, base),
            "sprach_choices": _sprachen.fuer_frontend(), "tiefen": _sprachen.TIEFEN,
            "sprecher_max": _sprachen.SPRECHER_MAX,
            "diarisierung_aktiv": _correct.diarize_enabled(),
            "pyannote_da": _diarize.verfuegbar()}


@app.put("/api/projects/{project}/files/{base}/einstellungen")
def dateieinstellungen_speichern(project: str, base: str, body: DateiEinstellungenBody):
    """Schreibt den Datei-Override (sprache/korrektur). Reiner Schreibpfad — kein Job-Start,
    keine 409-Sperre: derselbe sperrfreie Weg wie ``upload_audio`` (``setze_datei``), denn ein
    laufender Job hat seine Sprache beim Start bereits gelesen. Die Trigger (Neu-Transkription
    bei Sprache-Wechsel, Neu-Korrektur bei Tiefe-Wechsel) stößt das Frontend über die
    bestehenden ``…/transcribe``/``…/correct``-Endpunkte an — die ihrerseits ``_keine_jobs``
    prüfen. Siehe Spec #135."""
    _validate(project, base)
    _sicherer_projektname(project)   # setze_datei legt den Projektordner selbst an
    fehler = _sprachen.pruef_fehler(sprache=body.sprache, korrektur=body.korrektur,
                                    mehrsprachig=body.mehrsprachig, sprecher=body.sprecher)
    if fehler:
        raise HTTPException(status_code=400, detail=fehler)
    # `sprache: null` / `mehrsprachig: null` AUSDRUECKLICH gesendet heisst „Override entfernen"
    # (die Datei folgt wieder dem Projekt, #166/#234); das Feld GAR NICHT zu senden laesst ihn
    # stehen (Partial-Update, der bestehende Vertrag). Beides ist `None` im Modell —
    # unterschieden wird an `model_fields_set`, also wieder an der ANWESENHEIT des Schluessels
    # statt an seinem Wert. **`korrektur` bleibt bewusst aussen vor:** dort gibt es den Rueckweg
    # schon als echten Wert (`auto`), ein zweiter Weg zum selben Ziel waere eine zweite Wahrheit.
    def _erben(wert, feld):
        return _projekt.ERBEN if wert is None and feld in body.model_fields_set else wert

    # `sprecher: null` heisst hier nicht „folgt dem Projekt" (den Standard gibt es bewusst
    # nicht), sondern „wieder automatisch" — derselbe Mechanismus, s. `projekt.setze_datei`.
    _projekt.setze_datei(project, base, sprache=_erben(body.sprache, "sprache"),
                         korrektur=body.korrektur,
                         mehrsprachig=_erben(body.mehrsprachig, "mehrsprachig"),
                         sprecher=_erben(body.sprecher, "sprecher"))
    return _projekt.datei_ansicht(project, base)      # EIN Lesevorgang, s. GET oben


class NewProject(BaseModel):
    name: str


@app.post("/api/projects")
def create_project(body: NewProject):
    name = _sicherer_projektname(body.name)   # strip macht der Riegel selbst
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


# Kurze Wiederholung beim abschliessenden Loeschen: ein voruebergehender `PermissionError` ist
# auf Windows unter Konkurrenz der Normalfall (dieselbe Regel und dieselbe Groessenordnung wie
# `sperre._HAKELIG_S`). HERGELEITET, nicht gemessen: als Ausloeser gilt uns ein Scanner, der
# die eben umbenannte Datei greift — belegt ist nur, DASS ein voruebergehender
# `PermissionError` auf Windows unter Konkurrenz vorkommt (`sperre.py` hat die Zahlen dazu),
# nicht wie oft und wie lange. Deshalb ein Budget und keine feste Wartezeit.
_WEG_VERSUCHE, _WEG_PAUSE_S = 3, 0.1
# Gesamtbudget ueber ALLE Dateien einer Aufnahme, weil die Wiederholungen unter der Sperre von
# `delete_file` laufen. Wie lange ein fremder Griff eine Datei haelt, ist hier NICHT gemessen —
# gewaehlt ist der Wert an der einzigen Zahl, die feststeht: er liegt um Groessenordnungen unter
# `sperre.STALTES_ALTER` (60 s), der Frist, ab der ein Warter das Lock erzwungen uebernimmt.
# Reicht er nicht, ist die Antwort 409 „in Benutzung" — kein Verlust, ein zweiter Versuch.
_WEG_GESAMT_S = 2.0


def _umbenennen_oder_keines(paare: list, base: str) -> None:
    """Alle Paare umbenennen — oder KEINES. Bei einer belegten Datei 409, ohne Spur.

    Der Basisname ist die einzige Verbindung zwischen Ton und Transkript. Eine Schleife, die
    auf halbem Weg abbricht, zerreisst sie: gemessen am echten Pfad (#451) blieb nach einem
    fehlgeschlagenen Umbenennen `A_fremd_neu.json` neben `A_fremd.raw.txt` liegen — die
    Aufnahme gab es danach zweimal halb. Beim Loeschen dasselbe Bild mit der Roh-JSON.

    WARUM Umbenennen die richtige Reservierung ist, gemessen statt angenommen: Windows
    verweigert Umbenennen UND Loeschen einer offen gehaltenen Datei mit demselben
    `PermissionError [WinError 32]` — im eigenen wie im fremden Prozess, und ohne Griff
    gelingt beides. Das Umbenennen stellt also GENAU dieselbe Frage wie die Tat, ist aber
    umkehrbar. Gelingt es fuer alle Dateien, gehoert die Aufnahme uns; scheitert eines,
    drehen wir die schon gemachten zurueck und niemand sieht einen halben Zustand.

    `os.rename`, NICHT `os.replace` — aber der Unterschied traegt nur auf EINER Plattform, und
    das gehoert dazugesagt: `os.replace` ueberschreibt ein vorhandenes Ziel ueberall still,
    `os.rename` tut das auf POSIX GENAUSO und wirft nur auf Windows `FileExistsError`.
    `rename_file` hat seine Kollisionspruefung (`_ziel_frei`) davor; zwischen Pruefung und Tat
    liegt ein Fenster, und eine dort entstandene Zieldatei endet auf Windows im Fehlschlag samt
    Ruecklauf, auf macOS/Linux dagegen still ueberschrieben. Das ist keine Verschlechterung
    (der Altcode rief dasselbe `os.rename`), aber auch keine Zusage, die ueberall gilt.

    AUF POSIX gibt es diese Sperre nicht: ein offener Griff verhindert dort weder rename noch
    unlink, die Schleife gelingt immer, und das Problem existiert gar nicht. Deshalb ist das
    hier KEIN Plattform-Zweig — derselbe Code, der nur auf Windows ueberhaupt ausloesen kann.
    Die CI (ubuntu) sieht diesen Pfad also nie scharf; der plattformunabhaengige Test
    faelscht deshalb `os.rename`, statt sich auf ein echtes Handle zu verlassen.

    GETRAGENER PREIS, benannt: zwischen zwei Umbenennungen kann ein neuer Griff entstehen.
    Dann laeuft der Ruecklauf — und scheitert der ebenfalls, ist der Zustand nicht schlimmer
    als vor diesem Fix. Dass er seltener eintritt, ist HERGELEITET und nicht gemessen: ein
    `os.rename` atomar ueber mehrere Dateien gibt es nicht, das Fenster schrumpft aber von der
    ganzen Lesedauer auf zwei benachbarte Systemaufrufe.
    """
    gemacht = []
    for p, ziel in paare:
        try:
            os.rename(p, ziel)
        except OSError as e:
            for q, qziel in reversed(gemacht):
                # NUR zurueckbenennen, wenn der alte Platz noch frei ist. Auf POSIX ersetzt
                # `os.rename` ein vorhandenes Ziel STILL — GEMESSEN in WSL: Ziel trug
                # "FRISCH-getippt", nach `os.rename(alt, ziel)` steht "ALT" darin, keine
                # Ausnahme. Auf Windows wirft dieselbe Zeile `FileExistsError`. Steht dort
                # wieder etwas, ist das ein FREMDER Schreibvorgang, und der Ruecklauf wuerde
                # ihn ueberbuegeln — ein Autosave (alle 800 ms) kann in genau dieses Fenster
                # eine frische `edit.json` schreiben. Dann ist die `.weg`-Datei der bessere
                # Aufbewahrungsort als ein stilles Ueberschreiben.
                #
                # Der Weg ueber `retranscribe_file` stand hier bis zur dritten Bot-Runde als
                # Beispiel, `rename_file` bis zur siebten — beide halten jetzt dieselbe
                # `sperre.datei` wie `delete_file`. Was bleibt, ist der Autosave: der schreibt
                # nicht gegen ein Lock, sondern gegen den PFAD, und ein Schreiber ausserhalb
                # dieses Prozesses (Virenscanner, Explorer) ohnehin.
                if not os.path.exists(q):
                    with suppress(OSError):           # best effort — mehr geht hier nicht
                        os.rename(qziel, q)
                elif not qziel.endswith(".weg"):
                    # Der alte Platz ist belegt, ABER `rename_file` gibt Ziele ohne `.weg`
                    # herein: `qziel` traegt hier den NEUEN Namen und bliebe als SICHTBARE
                    # halbe Aufnahme in jeder Auflistung stehen — genau der Zustand, den diese
                    # Funktion ausschliesst. Also in den unsichtbaren Namensraum legen statt
                    # liegenlassen, und den Fall MELDEN: die Datei ist danach unsichtbar, die
                    # Protokollzeile ist die einzige Spur, die von ihr bleibt. (Aus `_datei_weg`
                    # traegt `qziel` schon `.weg` — dort ist
                    # es bereits unsichtbar und bleibt, wo es ist.)
                    with suppress(OSError):
                        os.rename(qziel, f"{q}.{uuid.uuid4().hex[:8]}.weg")
                    print(f"[dateiop] {os.path.basename(q)} war beim Ruecklauf wieder belegt — "
                          f"{os.path.basename(qziel)} beiseitegelegt", flush=True)
            # Der RUECKLAUF gilt jedem `OSError` — Atomik darf nicht von der Ursache abhaengen.
            # Die BESCHRIFTUNG dagegen nur dem belegten Zugriff: „bitte warten" ist ein Rat, und
            # ein Rat, der nie hilft, ist schlimmer als ein ehrlicher Fehler. Diese Datei hat die
            # Lehre schon einmal bezahlt (`_dateistand`: „`except OSError` deckte auch
            # `PermissionError`, `EIO` und einen zu langen Pfad").
            #
            # Konkret hinge sonst genau EIN Fall dauerhaft: die Reservierung haengt 13 Zeichen an
            # (`.<8hex>.weg`), eine Datei nahe der 260er-Pfadgrenze liess sich vorher loeschen und
            # scheiterte danach bei JEDEM Versuch — mit dem Rat zu warten. Das waere die einzige
            # Stelle, an der dieser Fix etwas WEGNIMMT, was vorher ging.
            if not isinstance(e, PermissionError):
                print(f"[loeschpfad] {type(e).__name__} (errno={e.errno}) auf "
                      f"{os.path.basename(p)} — zurueckgedreht, kein 409", flush=True)
                raise
            raise HTTPException(
                status_code=409,
                detail=f"„{base}“ ist gerade in Benutzung ({os.path.basename(p)}) — "
                       f"bitte warten und noch einmal versuchen") from None
        gemacht.append((p, ziel))


# Windows meldet einen unbrauchbaren Zielnamen NICHT als `ENAMETOOLONG` — der POSIX-Code kommt
# dort gar nicht vor. GEMESSEN auf dieser Maschine (Python 3.13.15, Windows 11, `os.rename` auf
# eine 300-Zeichen-Komponente): `errno=22 (EINVAL)`, `winerror=123 (ERROR_INVALID_NAME)` — also
# weder mein urspruengliches `ENAMETOOLONG` noch die im Review vorgeschlagene 206. Fuer einen
# Gesamtpfad ueber MAX_PATH nennt CPythons `PC/errmap.h` `ERROR_FILENAME_EXCED_RANGE` (206) mit
# `errno=ENOENT`; das ist HERGELEITET und hier NICHT reproduzierbar (ein 276-Zeichen-Ziel gelingt
# auf dieser Maschine). Beide Codes stehen aufgenommen, weil sie dasselbe heissen.
#
# Warum 123 hier „zu lang" heisst und nicht „ungueltiges Zeichen", obwohl der Code beides deckt:
# die Quellpfade kommen aus einem `glob` ueber vorhandene Dateien, sind also gueltige Namen;
# unbrauchbar wird erst das um 13 Zeichen laengere Ziel. Ein anderer Weg zu 123 existiert an
# dieser Stelle nicht.
_ZU_LANG_WINERROR = (123, 206)


def _name_zu_lang(e: OSError) -> bool:
    """Heisst `e` „der ZIELNAME geht nicht" (Laenge) statt „die Datei ist belegt"?

    Getrennte Funktion, weil die Antwort plattformabhaengig ist und an genau EINER Stelle
    stehen soll: ein zweiter Vergleich anderswo wuerde beim naechsten Umbau auseinanderlaufen.
    """
    return e.errno == errno.ENAMETOOLONG or getattr(e, "winerror", None) in _ZU_LANG_WINERROR


def _datei_weg(project: str, base: str, mit_audio: bool) -> int:
    """Alle Dateien EINER Aufnahme entfernen; gibt zurueck, wie viele es waren.

    Die Zahl meint die Dateien der AUFNAHME. Nebenher raeumt die Funktion auch `.weg`-Reste
    eines frueher abgebrochenen Laufs weg — die zaehlen NICHT mit, denn an der Zahl haengt
    ausser der Antwort auch die 404-Entscheidung in `delete_file`, und eine Aufnahme, von der
    nur noch Reste dalagen, ist keine Aufnahme mehr.

    `transkripte/<base>.*` deckt raw/edit/md/srt/correction/tagged/diar/segments und die
    `.partN.correction.json`-Zwischenstaende in einem Rutsch ab — eine Aufzaehlung waere
    beim naechsten neuen Artefakt still unvollstaendig.

    glob.escape() ist Pflicht, nicht Vorsicht: paths.safe_name laesst `[` und `*` durch, und
    der URL-Import legt Dateien wie `Video [dQw4w9].m4a` an — ohne Escape liest glob das `[`
    als Zeichenklasse und findet die Datei nicht. Der literale Punkt im Muster trennt
    sauber: "Timeline 1.*" trifft `Timeline 1.json`, aber nicht `Timeline 10.json`."""
    muster = os.path.join(paths.transkripte_dir(project), glob.escape(base) + ".*")
    # `sorted`, weil `glob.glob` laut Doku eine BELIEBIGE Reihenfolge liefert — sie haengt am
    # Dateisystem. GEMESSEN (WSL/ext4, 5 frische Verzeichnisse, Dateien in der Reihenfolge
    # `S1.json`, `S1.edit.json` angelegt): glob liefert **5/5** `['S1.json', 'S1.edit.json']`,
    # also die ANLAGE-Reihenfolge; NTFS liefert dieselben zwei alphabetisch, also umgekehrt.
    # Fuer die Produktion ist das gleichgueltig; fuer einen Test, der eine bestimmte Datei
    # belegt, nicht: er waere auf einer Plattform gruen und auf der anderen rot, ohne dass sich
    # am Verhalten etwas aendert. Deterministisch ist billiger als ein Test, der nach Wirt
    # schwankt.
    gefunden = [p for p in glob.glob(muster) if os.path.isfile(p) and not p.endswith(".lock")]
    # `.weg`-Reste sind KEINE Dateien der Aufnahme mehr, sondern Ueberbleibsel eines frueheren,
    # abgebrochenen Laufs. Sie wandern in `reste` statt in `treffer`, und das ist keine Kosmetik:
    # `len(treffer)` ist der Rueckgabewert, und `delete_file` liest ihn ZWEIMAL — als Zahl in der
    # Antwort („geloescht: N") und als 404-Entscheidung. In `treffer` gezaehlt meldete eine
    # Aufnahme, von der nur noch Reste da sind, ein munteres „1 geloescht" statt des richtigen
    # 404, und die Zahl behauptete Dateien, die es als Aufnahme nicht mehr gab.
    treffer = sorted(p for p in gefunden if not p.endswith(".weg"))
    reste = sorted(p for p in gefunden if p.endswith(".weg"))
    if mit_audio:
        adir = paths.audio_dir(project)
        treffer += [os.path.join(adir, base + ext) for ext in AUDIO_EXT
                    if os.path.isfile(os.path.join(adir, base + ext))]
        # Liegengebliebene Reservierungen der AUDIO-Seite aus einem abgestuerzten Lauf: das
        # `<base>.*`-Glob oben erreicht sie NICHT (anderer Ordner), und `find_audio` sucht
        # exakte `base + ext`-Namen. Ohne diese Zeile bliebe eine grosse Tonspur unsichtbar und
        # dauerhaft liegen — der teuerste Rest von allen.
        reste += sorted(p for p in glob.glob(os.path.join(adir, glob.escape(base) + ".*.weg"))
                        if os.path.isfile(p))
    # Reste brauchen keine Reservierung: sie tragen bereits einen Namen, den keine Auflistung
    # kennt. Scheitert das Entfernen, bleibt genau der Zustand, der ohnehin schon bestand.
    for p in reste:
        with suppress(OSError):
            os.remove(p)
    # Zweistufig: erst ALLE beiseitebenennen (das ist die Reservierung und die Probe in einem),
    # dann loeschen. Der Suffix ist je Aufruf eindeutig, damit ein liegengebliebener Rest aus
    # einem frueheren Lauf das `os.rename` nicht mit FileExistsError kippt — der waere hier als
    # „in Benutzung" beschriftet und damit eine falsche Auskunft.
    weg = f".{uuid.uuid4().hex[:8]}.weg"
    try:
        _umbenennen_oder_keines([(p, p + weg) for p in treffer], base)
    except OSError as e:
        if not _name_zu_lang(e):
            raise
        # Der Suffix haengt 13 Zeichen an; nahe der 260er-Pfadgrenze kippt damit das
        # `os.rename`, waehrend `os.remove` noch ginge — vor diesem Fix liess sich die Aufnahme
        # also loeschen und danach nie wieder. Deshalb hier direkt loeschen.
        # GETRAGENER PREIS, benannt statt versteckt: fuer diesen einen Fall degradiert die
        # Alles-oder-nichts-Zusage zu best effort. Das ist die richtige Richtung — die
        # Alternative ist eine Aufnahme, die der Nutzer dauerhaft nicht loeschen kann.
        print(f"[loeschpfad] Pfad zu lang fuer die Reservierung ({base}) — direkt geloescht, "
              f"ohne Alles-oder-nichts", flush=True)
        # Gezaehlt wird hier, was WIRKLICH verschwunden ist — anders als im Hauptpfad unten.
        # Dort tragen Reste schon einen `.weg`-Namen, den keine Auflistung kennt; die Zahl
        # beschreibt also weiterhin die Sicht des Nutzers. HIER behalten sie ihre SICHTBAREN
        # Namen: `len(treffer)` meldete 200 und „geloescht: N", waehrend alles noch dasteht.
        # Mit der echten Zahl fuehrt ein vollstaendiger Fehlschlag ueber `delete_file` zu 404.
        entfernt = 0
        for p in treffer:
            with suppress(OSError):
                os.remove(p)
                entfernt += 1
        return entfernt
    # Die Wiederholungen unten laufen UNTER der Sperre von `delete_file`, und `stale` ist eine
    # Zusage ueber die HALTEDAUER (#207): wer sie ueberzieht, dem nimmt ein Warter das Lock
    # erzwungen ab — dann sind zwei Prozesse im kritischen Abschnitt, also genau der Schaden,
    # gegen den es die Sperre gibt. Ein Deckel JE DATEI reicht dafuer nicht: die Zahl der
    # Artefakte ist durch `<base>.*` unbegrenzt (`.partN.correction.json` je Block, dazu Reste),
    # und 0,2 s mal genug Dateien sprengen die 60 s aus `sperre.STALTES_ALTER`. Deshalb ein
    # GESAMTbudget ueber alle Dateien, geprueft vor jedem Schlafen.
    schluss = time.monotonic() + _WEG_GESAMT_S
    for p in treffer:
        # Ab hier ist die Aufnahme aus Sicht des Nutzers weg: die Dateien liegen unter einem
        # Namen, den keine Auflistung kennt (`transcript_bases`, `_audio_bases`, `find_audio`
        # und die Galerie filtern alle auf echte Endungen). Schiefgehen kann trotzdem etwas —
        # ein Virenscanner greift eine eben umbenannte Datei moeglicherweise genau jetzt
        # (HERGELEITET — die Haeufigkeit ist hier nicht gemessen).
        #
        # Deshalb NICHT nur `suppress`: erst ein paar kurze Versuche (dieselbe Regel wie in
        # `sperre.py` — ein voruebergehender `PermissionError` ist auf Windows unter Konkurrenz
        # der NORMALFALL, kein Defekt). Bleibt danach eine liegen, faengt sie ein spaeterer
        # `_datei_weg`-Lauf DERSELBEN Aufnahme ein (`<base>.*` im transkripte-Ordner, das
        # `.weg`-Muster im audio-Ordner) — nach einem vollstaendigen `delete_file` gibt es
        # diesen Basisnamen aber nicht mehr, also nie. Der Rest ist dann unsichtbar belegter
        # Plattenplatz: benannt als #459, nicht behauptet als geheilt.
        for versuch in range(_WEG_VERSUCHE):
            try:
                os.remove(p + weg)
                break
            except OSError:
                if versuch + 1 == _WEG_VERSUCHE or time.monotonic() >= schluss:
                    break                     # aufgeben — die Aufnahme ist trotzdem weg
                time.sleep(_WEG_PAUSE_S)
    return len(treffer)


_KIND_TEXT = {"transcribe": "Transkription", "correct": "Korrektur", "fetch": "Import"}


def _keine_jobs(project: str, base: str = None, active_only: bool = False) -> None:
    """Dateien wegzuraeumen, waehrend ein Lauf sie schreibt, ist ein Datenrennen: die
    Korrektur haelt Pfade ueber Minuten offen und schriebe die geloeschte edit.json neu.

    Mit `base` gilt die Sperre nur fuer diese Aufnahme — die uebrigen bleiben bedienbar,
    auch waehrend eine Korrektur ueber ein grosses Projekt zwanzig Minuten laeuft.
    Mit `active_only=True` (beim Loeschen) wird nur blockiert, wenn genau diese Datei
    in diesem Moment aktiv gerechnet/geschrieben wird.

    Der Text nennt den Grund und rät NICHT zum Abbrechen — bei einem Lauf, der die Aufnahme
    gerade schreibt, ist Warten fast immer die richtige Reaktion."""
    if base is None:
        offen = jobs.active_for(project)
        laufend, wen = (offen[0] if offen else None), "Im Projekt wird"
    else:
        laufend, wen = jobs.betrifft(project, base, active_only=active_only), f"„{base}“ wird"
    if laufend:
        was = _KIND_TEXT.get(laufend["kind"], laufend["kind"])
        raise HTTPException(status_code=409,
                            detail=f"{wen} gerade bearbeitet ({was} läuft) — bitte warten")


@app.delete("/api/projects/{project}/files/{base}")
def delete_file(project: str, base: str):
    """Eine einzelne Aufnahme samt Audio loeschen (das Projekt bleibt)."""
    _validate(project, base)
    _sicherer_projektname(project)   # sonst legt das makedirs unten ein Geisterprojekt an
    epath = _edit_path(project, base)
    tdir = paths.transkripte_dir(project)
    os.makedirs(tdir, exist_ok=True)
    with sperre.datei(epath) as gehalten:
        if not gehalten:
            raise HTTPException(status_code=503,
                                detail="Datei kann gerade nicht sicher gelöscht werden")
        _keine_jobs(project, base, active_only=True)
        n = _datei_weg(project, base, mit_audio=True)
        if not n:
            raise HTTPException(status_code=404, detail=f"keine Datei: {base}")
        jobs.remove_base(project, base)
    return {"ok": True, "geloescht": n}


@app.post("/api/projects/{project}/files/{base}/transcribe")
def retranscribe_file(project: str, base: str):
    """Transkript neu erzeugen: Artefakte weg, dann gezielter Einzeldatei-Lauf.

    Die abgeleiteten Dateien MUESSEN mit weg: load_or_build_doc bevorzugt <base>.edit.json
    vor der Roh-JSON, ein Neu-Transkribieren zeigte sonst weiter den alten Text.

    DIESELBE `sperre.datei` wie `delete_file` — und sie ist hier erst mit dem `.weg`-Namensraum
    noetig geworden. `_keine_jobs` schuetzt gegen laufende JOBS, nicht gegen den anderen
    ENDPUNKT: zwei HTTP-Anfragen auf dieselbe Aufnahme teilten sich bis hierher kein Schloss.
    Seit `_datei_weg` liegengebliebene `.weg`-Dateien einsammelt, kann ein gleichzeitiges
    `DELETE` die laufende RESERVIERUNG dieser Neu-Transkription wegraeumen — und der Ruecklauf
    findet dann nichts mehr, was er zurueckbenennen koennte. Eine Alterspruefung waere kein
    Ersatz: `os.rename` behaelt die alte mtime (gemessen), eine frische Reservierung sieht also
    beliebig alt aus.
    Preis, benannt: der Endpunkt kann jetzt 503 antworten, wenn die Sperre nicht zu holen ist —
    genau wie `delete_file` seit je."""
    _validate(project, base)
    if not find_audio(project, base):
        raise HTTPException(status_code=404, detail=f"kein Audio: {base}")
    # `sperre.datei` legt sein Lock NEBEN die Datei und braucht das Elternverzeichnis —
    # `create_project` legt aber nur `audio/` an. Ein Projekt mit Ton, aber ohne `transkripte/`
    # (Upload ohne Lauf, von Hand angelegt) bekaeme sonst `FileNotFoundError` und damit 503:
    # ausgerechnet die erste Transkription waere unmoeglich. `delete_file` macht es seit je so;
    # das Muster gehoerte mit der Sperre hierher und ist beim Einbau untergegangen.
    os.makedirs(paths.transkripte_dir(project), exist_ok=True)
    with sperre.datei(_edit_path(project, base)) as gehalten:
        if not gehalten:
            raise HTTPException(status_code=503,
                                detail="Aufnahme kann gerade nicht sicher neu transkribiert werden")
        _keine_jobs(project, base)
        _datei_weg(project, base, mit_audio=False)
        job_id, started = _start_transcribe(project, base=base)
    return {"job_id": job_id, "started": started}


class RenameBody(BaseModel):
    name: str


def _neuer_name(roh: str) -> str:
    try:
        return paths.safe_name(roh.strip())
    except ValueError:
        raise HTTPException(status_code=400, detail="ungültiger Name")


def _ziel_frei(alt: str, neu: str) -> bool:
    """Ist `neu` als Ziel frei?

    `not os.path.exists(neu)` allein reicht auf Windows NICHT: das Dateisystem ist dort
    case-insensitiv, beim reinen Gross-/Kleinschreibungswechsel ("weistannen" ->
    "Weisstannen") zeigt exists() also auf genau den Ordner, den man gerade umbenennt —
    und die Aktion scheiterte mit „gibt es schon“. samefile() trennt die beiden Faelle."""
    if not os.path.exists(neu):
        return True
    return os.path.exists(alt) and os.path.samefile(alt, neu)


def _doc_felder(pfad: str, **felder: str) -> None:
    """`base`/`project`/`audio` in einer edit.json nachziehen.

    Die drei stehen IM Dokument (edit_model.build_edit_doc), und render_md macht aus `base`
    den Titel — ohne das truege der naechste Markdown-Export den alten Namen. Fehlt die Datei
    oder ist sie kaputt, bleibt sie unangetastet: ein Umbenennen soll nicht daran scheitern,
    die Dateien auf der Platte sind der wichtigere Teil."""
    try:
        doc = _json_objekt(pfad)          # Nicht-Objekt = kaputt, sonst wirft `.update`
        doc.update(felder)
        # Der Schreibvorgang gehoert MIT in den try: `json.dumps` stirbt an einem einzelnen
        # Surrogat im Dokument (UnicodeEncodeError, auch ein ValueError). Diese Funktion
        # laeuft in `rename_file` NACH dem `os.rename` — ein Wurf hier meldete dem Aufrufer
        # einen Fehler fuer ein bereits erledigtes Umbenennen. Die Zusage im Docstring gilt
        # jetzt fuer beide Haelften, nicht nur fuers Lesen (#190-Review).
        paths.atomic_write(pfad, json.dumps(doc, ensure_ascii=False, indent=1))
    except (OSError, ValueError) as e:     # ValueError deckt auch UnicodeDecodeError (#190)
        print(f"⚠ {os.path.basename(pfad)} nicht nachgezogen ({type(e).__name__}: {e})",
              flush=True)
        return


@app.post("/api/projects/{project}/rename")
def rename_project(project: str, body: RenameBody):
    """Projekt umbenennen = Ordner umbenennen. Die Aufnahmen wandern mit, nichts wird neu
    gerechnet — der Projektname steht nirgends ausser im Ordnernamen und in `project` der
    edit.json."""
    _validate(project)
    neu = _sicherer_projektname(body.name)   # Zielname im Markenraum? (#416)
    _keine_jobs(project)
    alt_dir = paths.project_dir(project)
    if not os.path.isdir(alt_dir):
        raise HTTPException(status_code=404, detail="kein Projekt")
    neu_dir = paths.project_dir(neu)
    if not _ziel_frei(alt_dir, neu_dir):
        raise HTTPException(status_code=409, detail="Projekt existiert bereits")
    if neu != project:
        os.rename(alt_dir, neu_dir)
    for b in paths.transcript_bases(neu):
        _doc_felder(_edit_path(neu, b), project=neu)
    return {"ok": True, "name": neu}


@app.post("/api/projects/{project}/files/{base}/rename")
def rename_file(project: str, base: str, body: RenameBody):
    """Eine Aufnahme umbenennen: Audio UND alle abgeleiteten Dateien in einem Zug.

    Der Basisname IST die Verbindung zwischen Ton und Transkript — eines allein umzubenennen
    zerreisst sie. Erst wird die ganze Liste auf Kollisionen geprueft und dann umbenannt:
    auf halbem Weg abzubrechen liesse eine Aufnahme zurueck, die es zweimal halb gibt."""
    _validate(project, base)
    _sicherer_projektname(project)   # sonst legt das makedirs unten ein Geisterprojekt an
    neu = _neuer_name(body.name)
    # DIESELBE `sperre.datei` wie `delete_file` und `retranscribe_file` — der dritte Endpunkt
    # fehlte, und `_keine_jobs` schuetzt nur gegen JOBS, nicht gegen den Nachbar-ENDPUNKT.
    # Konkret: ein gleichzeitiges DELETE raeumt eine Datei zwischen `_ziel_frei` und dem
    # `os.rename` weg; das Umbenennen scheitert dann mit `FileNotFoundError` — ein `OSError`,
    # aber KEIN `PermissionError`, also 500 statt 409 — und der Ruecklauf schriebe in einen
    # Platz zurueck, den der andere Endpunkt gerade freigegeben hat.
    # `os.makedirs` VOR der Sperre ist die Lehre aus Runde 6: `sperre.datei` braucht das
    # Elternverzeichnis, und `create_project` legt nur `audio/` an.
    os.makedirs(paths.transkripte_dir(project), exist_ok=True)
    with sperre.datei(_edit_path(project, base)) as gehalten:
        if not gehalten:
            raise HTTPException(status_code=503,
                                detail="Aufnahme kann gerade nicht sicher umbenannt werden")
        # INNERHALB der Sperre, wie bei `delete_file` und `retranscribe_file` — und das ist
        # keine Kosmetik, sondern die Antwort auf „was erlaubt die Reparatur NEU?": VOR der
        # Sperre gefragt lag zwischen Antwort und `os.rename` frueher nur die Trefferliste,
        # seit der Sperre aber eine Wartezeit von bis zu `sperre.STALTES_ALTER` (60 s). In
        # diesem Fenster kann ein Lauf fuer denselben Basisnamen starten, und dann benennt
        # `_umbenennen_oder_keines` Dateien um, die ein Job gerade schreibt — genau das
        # Rennen, das `_keine_jobs` ausschliessen soll. Die Sperre hat das Fenster also erst
        # geschaffen; sie schliesst es nur, wenn die Frage INNERHALB gestellt wird.
        # Die `HTTPException` verlaesst das `with` und gibt die Sperre frei — dasselbe
        # Verhalten wie bei den zwei Nachbarn, nichts Neues.
        _keine_jobs(project, base)
        tdir = paths.transkripte_dir(project)
        # glob.escape wie in _datei_weg: safe_name laesst `[` durch, der URL-Import legt
        # "Video [dQw4w9].m4a" an, und ungeschuetzt liest glob das `[` als Zeichenklasse.
        # `sorted` aus demselben Grund wie in `_datei_weg` — und diese Zeile fehlte dort zuerst:
        # der Fix ging in EINE der beiden Globs und liess die andere zufaellig. Auf ext4 liefert
        # `glob.glob` die Anlage-Reihenfolge (5/5 gemessen), auf NTFS die alphabetische; damit
        # entschied das Dateisystem, WELCHE Datei zuerst umbenannt wird und welche bei einem
        # Fehlschlag im Ruecklauf landet. Der eigene Test fiel darueber im ubuntu-Bein der CI um.
        # Es haengt aber mehr daran als ein Test: zwei gleichzeitige Anfragen auf dieselbe Aufnahme
        # enden nur dann sauber, wenn BEIDE dieselbe Reihenfolge gehen — der Verlierer scheitert
        # dann an Datei 1 mit leerem `gemacht`. Bei zufaelliger Reihenfolge ist das nicht zugesichert.
        # Derselbe Filter wie in `_datei_weg`: `.lock` gehoert der Sperre und keiner Aufnahme, und
        # ein VERZEICHNIS mit passendem Namen wuerde hier mitumbenannt. `.weg`-Reste bleiben drin —
        # sie sollen mitwandern (siehe die Begruendung an `umbenannt` unten).
        treffer = sorted(p for p in glob.glob(os.path.join(tdir, glob.escape(base) + ".*"))
                         if os.path.isfile(p) and not p.endswith(".lock"))
        adir = paths.audio_dir(project)
        treffer += [os.path.join(adir, base + ext) for ext in AUDIO_EXT
                    if os.path.exists(os.path.join(adir, base + ext))]
        if not treffer:
            raise HTTPException(status_code=404, detail=f"keine Datei: {base}")
        paare = []
        for p in treffer:
            rest = os.path.basename(p)[len(base):]      # ".edit.json", ".mp3", ".part1.correction.json"
            ziel = os.path.join(os.path.dirname(p), neu + rest)
            if not _ziel_frei(p, ziel):
                raise HTTPException(status_code=409, detail=f"gibt es schon: {neu + rest}")
            paare.append((p, ziel))
        # Die Kollisionspruefung oben beantwortet „ist der Zielname frei?" — sie sieht keine
        # offenen Griffe. Genau daran zerbrach die Schleife: gemessen blieb `A_fremd_neu.json`
        # neben `A_fremd.raw.txt` liegen, die Aufnahme gab es zweimal halb (#451). Alles oder
        # nichts, mit Ruecklauf.
        _umbenennen_oder_keines(paare, base)
        audio = find_audio(project, neu)
        _doc_felder(_edit_path(project, neu), base=neu,
                    audio=os.path.basename(audio) if audio else "")
        # `.weg`-Reste eines abgebrochenen Laufs wandern MIT (sie tragen den Basisnamen und werden
        # vom Glob getroffen), zaehlen aber NICHT: `umbenannt` nennt dem Nutzer die Dateien SEINER
        # Aufnahme, nicht unsichtbare Ueberbleibsel — dieselbe Regel wie `geloescht` in `_datei_weg`.
        #
        # BEWUSST anders als der Reviewvorschlag, sie ganz aus der Liste zu nehmen: dann bliebe der
        # Rest unter dem ALTEN Basisnamen liegen, waehrend die Aufnahme unter dem neuen weiterlebt —
        # und da niemand den alten Namen je wieder loescht, waere er dauerhaft verwaist (#459).
        # Mitgenommen faengt ihn das naechste Loeschen der Aufnahme ein.
        return {"ok": True, "name": neu,
                "umbenannt": sum(1 for p, _ in paare if not p.endswith(".weg"))}


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


# Sentinel fuer „der Client hat gar keinen Stand mitgeschickt" — unterscheidbar von `""`
# („noch keine Datei"), denn das ist eine echte Erwartung. Ein eigenes Objekt statt `None`,
# damit ein durchgereichtes `None` aus einem JSON-Rumpf nicht als Verzicht durchginge.
_KEIN_VORBEHALT = object()


def _pruefe_und_schreibe(project: str, base: str, doc: dict, erwartet) -> str:
    """Stand pruefen UND schreiben unter EINER Sperre — sonst bleibt #160 als schmales
    Fenster offen (CodeRabbit an PR #278).

    Zwischen `_dateistand()` und `atomic_write()` liegen `json.dumps` des ganzen Dokuments und
    ein vollstaendiges `render_md` — bei einem langen Transkript **Millisekunden**, nicht
    Mikrosekunden. Landet `correct.cmd_apply` genau darin, hat der Vergleich schon zugestimmt
    und der Schreibvorgang ueberbuegelt die frische Korrektur: exakt der Schaden aus #160, nur
    durch ein schmaleres Tor. Das Issue selbst nennt diesen Weg („der Sperrgedanke aus #134,
    eine Ebene hoeher").

    **Die Sperre wirkt nur, weil `correct.cmd_apply` dieselbe nimmt** — eine Sperre, die nicht
    alle Schreiber nehmen, ist keine (dieselbe Regel wie bei `settings.save`). Beide sperren
    auf denselben Pfad, die `edit.json`.

    Laeuft synchron und wird vom Handler ueber `run_in_threadpool` gerufen: `sperre.datei`
    wartet mit `sleep`, und das im Ereignisfaden zu tun hielte den ganzen Server an. Der
    sync-`def`-Weg von `put_settings` geht denselben Weg, nur ueber FastAPIs Automatik.

    `stale` bleibt beim Standard: der Abschnitt ist ein Render plus zwei Schreibvorgaenge und
    nimmt KEINE weitere Sperre — die #207-Rechnung („`stale` ist die Zusage ueber die eigene
    Haltedauer") geht also ohne Zuschlag auf.
    """
    epath = _edit_path(project, base)
    # VOR der Sperre: `sperre.datei` verlangt ein vorhandenes Elternverzeichnis.
    tdir = paths.transkripte_dir(project)
    os.makedirs(tdir, exist_ok=True)
    with sperre.datei(epath):
        if erwartet is not _KEIN_VORBEHALT and erwartet != _dateistand(epath):
            raise HTTPException(
                status_code=409,
                detail="Die Datei wurde inzwischen von aussen geändert "
                       "(vermutlich ist eine Korrektur fertig geworden).")
        # Hier drin, nicht davor: der Zweig legt eine Datei beiseite, und die erste Rettung
        # gewinnt — ein abgelehnter Schreibvorgang darf keinen Seiteneffekt hinterlassen.
        if doc.pop("selbstgeheilt", None) and _ist_unlesbar(epath):
            paths.beiseitelegen(epath)
        doc["human_edited"] = True
        paths.atomic_write(epath, json.dumps(doc, ensure_ascii=False, indent=1))
        paths.atomic_write(_md_path(project, base), render_md(doc))
        return _dateistand(epath)


@app.put("/api/projects/{project}/files/{base}")
async def save_file(project: str, base: str, request: Request):
    _validate(project, base)
    # Der schreibende Anlegeweg mit INHALT (K1-Glied-1-Review): ein Stale-Editor-Tab,
    # das nach dem Umbenennen eines Altprojekts "active" weiterspeichert, wuerde das
    # Projekt sonst samt edit.json WIEDER aufstehen lassen — makedirs + atomic_write
    # legen bedingungslos an, und die Galerie listet jeden Ordner unter projekte/.
    _sicherer_projektname(project)
    doc = await request.json()
    # Trust-Boundary: der Rumpf kommt vom Client. Ein JSON-Array kam bisher bis zum
    # `doc["human_edited"] = True` durch und endete als 500 (TypeError) — dieselbe Wache wie
    # `_json_objekt` beim Lesen, nur auf der Schreibseite.
    if not isinstance(doc, dict):
        raise HTTPException(status_code=400,
                            detail=f"JSON-Objekt erwartet, {type(doc).__name__} bekommen")
    # Optimistisches Sperren (#160). Der Editor speichert 800 ms nach dem letzten Tastendruck;
    # wird eine Korrektur fertig, waehrend ein PUT schon unterwegs ist, landete er DANACH und
    # ersetzte die frische edit.json — ein kompletter Lauf weg, ohne eine Zeile im Protokoll.
    # Der Browser kann eine laufende Anfrage nicht zurueckholen, also muss der Server ablehnen.
    #
    # `pop`, nicht `get` — dieselbe Regel wie bei `selbstgeheilt`: das Feld beschreibt den
    # ZUSTAND der Datei, geschrieben stuende es in der Datei, deren Zustand es beschreibt.
    #
    # **Fehlender Schluessel heisst „ohne Vorbehalt schreiben"** und ist kein Versehen: er
    # haelt `curl` und jeden Nicht-Browser-Aufrufer unveraendert lauffaehig — und er ist
    # zugleich der Weg fuers BEWUSSTE Ueberschreiben. Wer im Editor „meine Fassung behalten"
    # waehlt, schickt das Feld einfach nicht mehr mit. Ein eigenes Kraft-Flag waere ein
    # zweiter Schalter fuer dieselbe Aussage — und einer, der haengenbleiben kann.
    # Unterschieden wird am SCHLUESSEL, nicht am Wert: `""` ist eine Erwartung („noch keine
    # Datei"), nur das Fehlen ist der Verzicht.
    #
    # Vor dem `selbstgeheilt`-Zweig, denn der legt eine Datei beiseite: ein abgelehnter
    # Schreibvorgang darf keinen Seiteneffekt hinterlassen.
    erwartet = doc.pop("dateistand", _KEIN_VORBEHALT)
    # Der Editor gibt zurueck, was `load_or_build_doc` ihm mitgegeben hat: „deine gespeicherte
    # Fassung war nicht lesbar" (#197). Dann liegt auf der Platte noch die unlesbare Datei, und
    # der Schreibvorgang unten wuerde sie ersetzen — dieselbe Konstellation wie bei
    # settings.json (#192), nur mit der Handarbeit eines Menschen darin. Erst beiseitelegen.
    #
    # Der Merker ist ein HINWEIS, keine Anweisung: nachgesehen wird auf der Platte
    # (`_ist_unlesbar`). Das kostet einen Parse — aber nur, wenn der Merker gesetzt ist, also
    # hoechstens einmal je geheilter Datei; unbesehen zu folgen liesse einen erfundenen Merker
    # eine GESUNDE edit.json beiseiteschieben, und weil die erste Rettung gewinnt, waere der
    # Platz danach belegt: eine spaetere, echte Beschaedigung liesse sich nicht mehr retten.
    # (CodeRabbit-CLI an PR #204 — der Weg ueber die Pruefung ist billig genug, das Argument
    # „einmal pro Tipppause waere zu teuer" galt nur fuer eine Pruefung OHNE Merker.)
    #
    # `pop`, nicht `get`: das Feld ist eine Meldung ueber den Ladevorgang, kein Bestandteil des
    # Dokuments — geschrieben gaelte die Datei beim naechsten Oeffnen fuer immer als geheilt.
    # Der neue Stand MUSS zurueck: sonst liefe der naechste Autosave gegen die eigene
    # Schreibung von gerade eben und bekaeme 409 — die Sperre schluege bei jedem zweiten
    # Speichern zu, ohne dass irgendein fremder Schreiber beteiligt waere.
    stand = await run_in_threadpool(_pruefe_und_schreibe, project, base, doc, erwartet)
    return {"ok": True, "dateistand": stand}


@app.post("/api/projects/{project}/files/{base}/export")
def export_file(project: str, base: str):
    _validate(project, base)
    doc = load_or_build_doc(project, base)
    md = render_md(doc)
    paths.atomic_write(_md_path(project, base), md)
    return {"md": md}


@app.post("/api/projects/{project}/files/{base}/export/srt")
def export_srt(project: str, base: str, sprecher: bool = True):
    """Untertitel fuer den YouTube-Upload. Eigener Endpoint statt ?fmt= am Zwilling darueber:
    der muesste dafuer seinen Rueckgabeschluessel `md` aufgeben.

    `?sprecher=false` blendet die Sprechernamen aus. Beide Fassungen schreiben dieselbe
    `<base>.srt` — die Datei ist eine Kopie des Downloads, kein zweites Artefakt."""
    _validate(project, base)
    srt = render_srt(load_or_build_doc(project, base), sprecher)
    paths.atomic_write(_srt_path(project, base), srt)
    return {"srt": srt}


def _get_or_render_md(project: str, base: str) -> str | None:
    """Holt fertiges Markdown oder rendert es aus dem Dokument."""
    md_p = _md_path(project, base)
    if os.path.exists(md_p):
        try:
            with open(md_p, "r", encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            pass
    if os.path.exists(_edit_path(project, base)) or os.path.exists(_raw_path(project, base)):
        doc = load_or_build_doc(project, base)
        md = render_md(doc)
        try:
            paths.atomic_write(md_p, md)
        except OSError:
            pass
        return md
    return None


@app.get("/api/projects/{project}/files/{base}/export/md")
def export_file_md(project: str, base: str):
    """Direkter Download der Markdown-Fassung einer einzelnen Datei."""
    _validate(project, base)
    md = _get_or_render_md(project, base)
    if md is None:
        raise HTTPException(status_code=404, detail=f"kein Transkript vorhanden: {base}")
    filename = f"{paths.safe_name(base)}.md"
    return Response(
        content=md.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/projects/{project}/export/downloads")
def export_project_downloads(project: str):
    """Exportiert alle Markdown-Dateien des Projekts direkt in den Downloads-Ordner."""
    _validate(project)
    if not os.path.isdir(paths.project_dir(project)):
        raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
    dateien = _projekt_dateien(project)
    target_dir = os.path.join(paths.downloads_dir(), paths.safe_name(project))
    os.makedirs(target_dir, exist_ok=True)
    exported = []
    for f in dateien:
        base = f["base"]
        md = _get_or_render_md(project, base)
        if md is not None:
            safe_base = paths.safe_name(base)
            dest = os.path.join(target_dir, f"{safe_base}.md")
            paths.atomic_write(dest, md)
            exported.append(f"{safe_base}.md")
    return {
        "ok": True,
        "ziel": target_dir,
        "anzahl": len(exported),
        "dateien": exported,
    }


@app.get("/api/projects/{project}/export/zip")
def export_project_zip(project: str):
    """Packt alle Markdown-Dateien des Projekts in ein ZIP-Archiv zum Download."""
    _validate(project)
    if not os.path.isdir(paths.project_dir(project)):
        raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
    dateien = _projekt_dateien(project)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in dateien:
            base = f["base"]
            md = _get_or_render_md(project, base)
            if md is not None:
                safe_base = paths.safe_name(base)
                zf.writestr(f"{safe_base}.md", md.encode("utf-8"))
    buf.seek(0)
    filename = f"{paths.safe_name(project)}_markdown.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _start_transcribe(project: str, base: str | None = None):
    """Transkription anstossen; danach automatisch korrigieren via Streaming-Pipeline.

    `--autocorrect` haengt hier bedingungslos dran, und das ist Absicht: ueber den Kill-Switch
    `TRANSKRIBOR_AUTOCORRECT` und den Anbieter entscheidet der LAUF (#406). Ein hier
    weggelassenes Flag waere fuer den Nutzer ununterscheidbar von "es lief einfach nichts";
    der Lauf schreibt stattdessen den Grund ins Protokoll."""
    cmd = [sys.executable, os.path.join(paths.ROOT, "transcribe.py"), project]
    if base:
        cmd.extend(["--only", base])
    cmd.append("--autocorrect")
    return jobs.request(project, cmd, paths.ROOT, "transcribe", base=base)


@app.post("/api/projects/{project}/transcribe")
def transcribe(project: str):
    _validate(project)
    job_id, started = _start_transcribe(project)
    return {"job_id": job_id, "started": started}


def _require_ai():
    """Kein Korrektur-Job ohne nutzbaren Anbieter — der Riegel des automatischen Wegs steht
    seit #406 in `transcribe._autocorrect_an` bzw. direkt vor der KI-Phase in
    `transcribe.transcribe_project`.

    Ohne ihn laeuft erst `cmd_diarize` (pyannote, GPU, Minuten) und `cmd_prep` durch, bevor
    der erste LLM-Aufruf scheitert: Rechenzeit fuer ein Ergebnis, das nach der ersten Zeile
    feststand. Der Lauf endet dann zwar ehrlich rot (`correct.main` -> SystemExit(1)), aber
    eben spaet und mit dem Grund irgendwo mitten im Job-Protokoll.

    Das Gate im Frontend (`useAiReady`) ersetzt das nicht: es fragt genau einmal beim Laden
    und laesst die Knoepfe bei einem Fehler der Abfrage bewusst aktiv.

    409, nicht 400: die Anfrage ist in Ordnung, der Serverzustand nicht."""
    ok, grund = llm.available()
    if not ok:
        raise HTTPException(status_code=409, detail=grund)


@app.post("/api/projects/{project}/correct")
def correct(project: str):
    _validate(project)
    _require_ai()
    job_id, started = jobs.request(project, [sys.executable, "-m", "webtool.correct", "run", project],
                                   paths.ROOT, "correct")
    return {"job_id": job_id, "started": started}


@app.post("/api/projects/{project}/files/{base}/correct")
def correct_file(project: str, base: str, force: bool = False):
    _validate(project, base)
    # Zwei Schreiber auf derselben edit.json verhindern (#441, Einzeldatei-Haelfte):
    # seit der gestaffelten Pipeline (v0.48.0) korrigiert der transcribe-Job selbst mit,
    # und die Job-Dedupe je (Projekt, Art) sieht keinen Konflikt zwischen "transcribe"
    # und "correct". active_only=True wie beim Loeschen: die Datei ist nur gesperrt,
    # WAHREND der Lauf sie schreibt — der vorgesehene Parallelweg mit
    # TRANSKRIBOR_AUTOCORRECT=0 (neben einer laufenden Transkription korrigieren)
    # bleibt frei. Der projektweite Endpunkt oben bleibt ohne Riegel, bis es ein
    # positives Merkmal gibt ("korrigiert der Lauf selbst mit?"), siehe #441/Glied 4.
    #
    # Der Riegel steht VOR dem 404 (wie bei delete_file): waehrend der Lauf die Datei
    # aktiv schreibt, existiert die Roh-JSON noch NICHT — "gerade bearbeitet" ist die
    # genauere Auskunft, "kein Roh-Transkript" hiesse "erst transkribieren", waehrend
    # genau das laeuft. Am echten Pfad gemessen (Beleglauf 08-30): der 404 schlug den
    # 409 und machte den Riegel im einzigen Fenster, das er decken soll, unerreichbar.
    _keine_jobs(project, base, active_only=True)
    if not os.path.exists(_raw_path(project, base)):
        raise HTTPException(status_code=404, detail=f"kein Roh-Transkript: {base}")
    _require_ai()
    cmd = [sys.executable, "-m", "webtool.correct", "run", project, base]
    if force:
        cmd.append("--force")                     # nur nach expliziter UI-Bestätigung (human_edited)
    job_id, started = jobs.start(project, cmd, paths.ROOT, "correct", base=base)
    return {"job_id": job_id, "started": started}


class FetchBody(BaseModel):
    urls: list[str]
    # Index-parallel zu `urls` — ODER ein einzelner String, der fuer alle gilt. Die zweite
    # Form ist die bisherige Bedeutung und bleibt gueltig; sie wird VOR dem `zip` expandiert.
    # Ein Auftrag mischt Aufnahmen mit verschiedenen Sprachen (`projekt.json` haelt `sprache`
    # je Base — gemischtsprachige Projekte sind ausdruecklich vorgesehen).
    # `null` heisst „nicht gesetzt"; `""` ist ein FEHLER (400 aus `pruef_fehler`), kein Weg
    # zum Zuruecksetzen — umgekehrt zur Env-Schicht, wo `""` genau „nicht gesetzt" bedeutet.
    # Absicht: im Rumpf ist explizit besser als raten, in der Umgebung gibt es kein `null`.
    sprache: str | list[str | None] | None = None
    mehrsprachig: bool | None = None
    # Index-parallel zu `urls`; `None` = automatisch. Eine LISTE statt eines Wertes, weil ein
    # Auftrag Aufnahmen mit verschiedenen Sprecherzahlen mischt — ein Wert fuer alle waere fuer
    # die Haelfte falsch, und `num_speakers` ist exakt, keine Obergrenze (#264).
    # `StrictInt` aus demselben Grund wie in `DateiEinstellungenBody`: sonst naehme Pydantic
    # `"5"` und `5.0` an, waehrend `projekt._sprecher_wert` denselben Wert VERWIRFT.
    sprecher: list[StrictInt | None] | None = None


@app.post("/api/projects/{project}/fetch")
def fetch_urls(project: str, body: FetchBody):
    """URL-Import: laedt Audio von YouTube/Instagram und transkribiert genau diese Dateien."""
    _validate(project)
    _sicherer_projektname(project)   # der Subprozess legt den Projektordner an (fetch.py)
    # Laenge VOR dem Filtern pruefen: danach ist die Zuordnung schon verloren.
    sprecher_roh = body.sprecher if body.sprecher is not None else [None] * len(body.urls)
    if len(sprecher_roh) != len(body.urls):
        raise HTTPException(status_code=400,
                            detail="sprecher muss so viele Eintraege haben wie urls")
    # Erst EXPANDIEREN, dann filtern. Ein einzelner String gilt fuer alle URLs (die bisherige
    # Bedeutung); andersherum braeche `strict=True` unten, und ohne `strict` waere es
    # schlimmer — still gekuerzt heisst hier verschobene Zuordnung.
    if isinstance(body.sprache, list):
        sprache_roh = body.sprache
    else:
        sprache_roh = [body.sprache] * len(body.urls)
    if len(sprache_roh) != len(body.urls):
        raise HTTPException(status_code=400,
                            detail="sprache muss so viele Eintraege haben wie urls")
    # PAARWEISE filtern: leere URL-Zeilen fielen sonst nur auf der einen Seite weg und
    # verschoeben ab da JEDE Zuordnung — die 5 des Teamgespraechs landete beim 2er-Interview.
    # `strict=True` kann nach der Laengenpruefung darueber nicht mehr feuern — es steht als
    # Zusicherung da, nicht als Schutz: wer die Pruefung eines Tages verschiebt, bekommt einen
    # lauten Fehler statt einer still gekuerzten Liste, und still gekuerzt hiesse hier
    # verschobene Zuordnung (CodeRabbit-CLI).
    paare = [(u.strip(), spk, spr) for u, spk, spr
             in zip(body.urls, sprecher_roh, sprache_roh, strict=True) if u.strip()]
    urls = [u for u, _, _ in paare]
    sprecher = [spk for _, spk, _ in paare]
    sprachen_liste = [spr for _, _, spr in paare]
    if not urls:
        raise HTTPException(status_code=400, detail="keine URL angegeben")
    if len(urls) > MAX_FETCH_URLS:
        raise HTTPException(status_code=400,
                            detail=f"maximal {MAX_FETCH_URLS} URLs pro Auftrag")
    try:
        urls = [fetch_mod.check_url(u) for u in urls]   # zweite Instanz: fetch.py prueft erneut
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # Sprache am Endpoint pruefen: fetch.py traegt sie erst im Subprozess ein, ein spaetes
    # Scheitern liesse den Download erst laufen. gleiche Quelle wie die PUT-Endpunkte (#139).
    # Je Eintrag, NICHT `pruef_fehler(sprache=body.sprache)`: mit einer Liste ist
    # `sprache not in SPRACHEN` ein dict-Lookup mit einer Liste -> `TypeError: unhashable
    # type` -> 500 statt 400, ausgerechnet an der Stelle, deren Zweck eine saubere Meldung
    # ist. Die alte Einzelpruefung ist deshalb ERSETZT, nicht ergaenzt.
    fehler = None
    for l in sprachen_liste:
        fehler = fehler or _sprachen.pruef_fehler(sprache=l)
    for s in sprecher:
        fehler = fehler or _sprachen.pruef_fehler(sprecher=s)
    if fehler:
        raise HTTPException(status_code=400, detail=fehler)
    # Eigene Job-Art: der Download braucht keine GPU. Als "transcribe" gefuehrt wuerde er von
    # jeder laufenden Transkription blockiert — und die laeuft seit dem Auto-Trigger oft.
    # Sprache pro geladener Base: fetch.py liest TRANSKRIBOR_FETCH_SPRACHE und traegt sie ein,
    # sobald der Basisname feststeht (die Basen kennen wir hier noch nicht).
    cmd = [sys.executable, "-m", "webtool.fetch", "--download-only", project, *urls]
    # IMMER gesetzt, auch leer — dieselbe Trust-Boundary wie bei TRANSKRIBOR_FETCH_SPRECHER
    # darunter (#298): `jobs._run_proc` baut {**os.environ, **job_env(), **env}, das explizite
    # `env` gewinnt. FEHLT der Schluessel, ueberlebt ein Altwert aus der `.env` in os.environ
    # und schlaegt auf jeden Browser-Import durch. Mit der Liste waere der Schaden groesser
    # als vorher: ein Altwert kollabierte ALLE Datei-Entscheidungen auf einen Wert.
    # `fetch._sprache_aus_env("")` liest das sauber als „nicht gesetzt" zurueck.
    env_sprache = {"TRANSKRIBOR_FETCH_SPRACHE": ",".join(l or "" for l in sprachen_liste)}
    # Als "1"/"0", weil eine Env-Variable nur Strings kennt; fetch.py liest sie zurueck.
    # IMMER gesetzt, auch leer (#298) — dieselbe Trust-Boundary wie bei SPRACHE und SPRECHER:
    # fehlt der Schluessel im expliziten `env`, ueberlebt eine `.env`-Altlast in `os.environ`
    # und schlaegt auf jeden Browser-Import durch. `""` heisst „nicht gesetzt"; eine
    # Env-Variable kennt kein `null`. Die Leseseite ist dafuer MITGEAENDERT — sie las `""`
    # bisher als `False` und haette daraus einen echten Datei-Override gemacht (#166).
    env_sprache["TRANSKRIBOR_FETCH_MEHRSPRACHIG"] = (
        "" if body.mehrsprachig is None else ("1" if body.mehrsprachig else "0"))
    # Komma-Liste, index-parallel zu den URLs; ein leeres Feld heisst „automatisch".
    #
    # IMMER gesetzt, auch wenn keine einzige Zahl dabei ist — und das ist kein Schoenheits-
    # fehler, sondern eine Trust-Boundary: `jobs._run_proc` baut die Subprozess-Umgebung als
    # `{**os.environ, **job_env(), **env}`, der Lauf erbt also alles, was beim Server steht.
    # Eine `TRANSKRIBOR_FETCH_SPRECHER`-Zeile in der `.env` (Ueberbleibsel eines CLI-Tests;
    # die Datei GEWINNT gegen die gesetzte Variable) schlaege sonst auf jeden Browser-Import
    # durch, und ein plausibler Altwert wie „3" kommt durch jede Bereichspruefung — falsche
    # Cluster, GPU-Minuten, kein Fehler. Ein leerer Wert neutralisiert das:
    # `_sprecher_aus_env("")` liefert None. Wer im Browser nichts eintraegt, meint
    # „automatisch", und diese Entscheidung schlaegt eine Altlast in der Umgebung.
    # Der CLI-Weg (`python -m webtool.fetch`) bleibt unberuehrt — dort setzt niemand `env`.
    #
    # `TRANSKRIBOR_FETCH_SPRACHE` und `TRANSKRIBOR_FETCH_MEHRSPRACHIG` gehen denselben Weg
    # (beide oben, unbedingt gesetzt). Bei MEHRSPRACHIG war es NICHT derselbe Einzeiler und
    # kam deshalb erst mit #298: `_mehrsprachig_aus_env("")` lieferte `False`, nicht `None`,
    # ein leerer Wert haette dort also einen echten Datei-Override erzeugt. Der Parser ist
    # jetzt auf dieselbe Null-Richtung umgestellt.
    env_sprache["TRANSKRIBOR_FETCH_SPRECHER"] = ",".join(
        "" if s is None else str(s) for s in sprecher)
    job_id, started = jobs.start(project, cmd, paths.ROOT, "fetch",
                                 then=lambda: _start_transcribe(project), env=env_sprache)
    return {"job_id": job_id, "started": started}


class AuthCodeBody(BaseModel):
    code: str


class SettingsBody(BaseModel):
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None          # weggelassen = gespeicherten Key behalten
    whisper_model: str | None = None    # Qualitaetsstufe der Transkription
    parallel: str | None = None          # gleichzeitige LLM-Aufrufe der Korrektur, "1".."16"
    ytdlp_auto: str | None = None        # "1"/"0" — yt-dlp automatisch aktualisieren
    # whisper_lang fehlt hier bewusst: es hat keine UI, und ein ueber die API gesetztes
    # "Deutsch" statt "de" liesse jeden kuenftigen Lauf scheitern, ohne dass der Browser
    # eine Moeglichkeit haette, das zurueckzunehmen. Env und Handbearbeitung bleiben.
    # `ytdlp_geprueft` fehlt aus demselben Grund: der Merker ist Buchhaltung des Servers,
    # ein vom Browser gesetztes Datum koennte die Aktualisierung auf Jahre stilllegen.
    # (Seit #281 ist er ohnehin eine venv-eigene Datei und nicht mehr in settings.json.)


def _settings_body(cfg: dict | None = None) -> dict:
    """Der EINE Bauweg fuer beide Einstellungs-Endpunkte (#239).

    Vorher baute jeder Handler seinen Rumpf selbst, und der PUT lieferte fuenf Felder
    weniger (`providers`, `env_key`, `whisper_choices`, `ai_ready`, `ai_reason`) — waehrend
    das Frontend beide als vollstaendige `Settings` tippt. Es knallte nur deshalb nicht, weil
    `SettingsPage.speichern` zusammenmischte und die fehlenden Felder aus dem vorigen Stand
    ueberlebten. Der Typ war trotzdem eine Falschaussage, und sie laedt zu genau dem Fehler
    ein, den der Merge verdeckt: `(await saveSettings(...)).providers` ist `undefined` mit
    einem Typ, der Sicherheit behauptet.

    Ein handgeschriebenes `Pick<Settings, …>` im Frontend waere die falsche Richtung gewesen —
    eine zweite Feldliste neben `settings.public()`, die beim naechsten neuen Feld
    auseinanderlaeuft. Dieselbe Regel wie bei den Anbieter-Modellen und den Sprachen: eine
    fest verdrahtete Liste waere in drei Monaten falsch.

    Der Preis ist benannt, nicht uebersehen: der PUT zahlt jetzt `llm.available()`, und das
    startet bei den Abo-CLIs einen Subprozess (0,09 s codex / 0,26 s claude, gemessen). Die
    Seite speichert bei `onBlur`, das ist also einmal je Feldwechsel. Vertretbar, weil der
    GET denselben Aufruf laengst macht — und ihn waehrend einer yt-dlp-Aktualisierung alle
    1,5 s zahlt (der Poll der Einstellungsseite).

    `projekte_pfad` gehoert HIER hin und nicht in `settings.public()`: `public()` ist „die
    Einstellungen ohne die Geheimnisse", die Projektwurzel ist keine Einstellung, sondern
    Umgebung. In `public()` gelegt reiste sie ausserdem in jede Antwort, die Einstellungen
    meint.
    """
    # EIN Lesevorgang fuer die ganze Antwort. Vorher las `settings.public()` den uebergebenen
    # Snapshot und `llm.available()` die Datei neu — unter zwei gleichzeitigen Schreibern trug
    # dieselbe Antwort dann `provider` aus dem einen und `ai_reason` aus dem anderen, und der
    # Nutzer las „Anbieter: Anthropic" neben „claude ist nicht installiert".
    # (`ytdlp_update.zustand()` liest weiterhin selbst — es beantwortet eine Frage an die
    # UMGEBUNG, nicht an die Einstellungen, und dass `ytdlp_auto` und `ytdlp.auto` auseinander
    # liegen koennen, sagt die Antwort ohnehin ausdruecklich.)
    cfg = cfg if cfg is not None else settings.load()
    ai_ready, ai_reason = llm.available(cfg)
    return {**settings.public(cfg), "providers": llm.provider_list(),
            "env_key": llm.env_key_hint(),
            "whisper_choices": list(settings.WHISPER_CHOICES),
            # Wo die Arbeit des Nutzers liegt (#218). Der Server ist die richtige Quelle: in
            # der gepackten App setzt `electron/backend.js` `TRANSKRIBOR_PROJEKTE` aus
            # `P.projekte`, und `paths.projekte_root()` liest genau das — Anzeige und
            # „Ordner oeffnen" zeigen damit per Konstruktion auf dasselbe Verzeichnis.
            "projekte_pfad": paths.projekte_root(),
            # Ob `TRANSKRIBOR_PARALLEL` den gespeicherten Deckel ueberstimmt: der EINGETRAGENE
            # Wert (roh, "" = kein Override) und die Zahl, die daraus WIRKLICH wird. Beide,
            # weil sie auseinanderfallen koennen — `200` ergibt 16, `viele` ergibt 3 —, und
            # eine Anzeige, die den rohen Wert als wirksam ausgibt, waere falsch (genau das
            # hat die Klemmung neu moeglich gemacht). Gehoert HIER hin und nicht in
            # `settings.public()`: das sind „die Einstellungen ohne die Geheimnisse", die
            # Umgebung ist keine Einstellung — dieselbe Abgrenzung wie `projekte_pfad`.
            "parallel_env": settings.parallel_env(),
            "parallel_env_wirksam": (str(settings.parallel_wirksam(settings.parallel_env()))
                                     if settings.parallel_env() else ""),
            # Installierte yt-dlp-Fassung + Merker + WIRKSAMER Schalter. Letzterer kann von
            # `ytdlp_auto` abweichen, wenn TRANSKRIBOR_YTDLP_UPDATE gesetzt ist — das Frontend
            # vergleicht beides und sagt es, statt einen Haken zu zeigen, der nichts tut.
            "ytdlp": ytdlp_update.zustand(),
            "ai_ready": ai_ready, "ai_reason": ai_reason}


@app.get("/api/settings")
def get_settings():
    """Nie den Key ausliefern — nur, OB einer hinterlegt ist."""
    return _settings_body()


@app.put("/api/settings")
def put_settings(body: SettingsBody):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "provider" in patch and patch["provider"] not in llm.PROVIDERS:
        raise HTTPException(status_code=400, detail=f"unbekannter Anbieter: {patch['provider']}")
    if "whisper_model" in patch and patch["whisper_model"] not in settings.KNOWN_WHISPER_MODELS:
        raise HTTPException(status_code=400,
                            detail=f"unbekanntes Whisper-Modell: {patch['whisper_model']}")
    if "parallel" in patch and not settings.parallel_ok(patch["parallel"]):
        raise HTTPException(
            status_code=400,
            detail=f"parallel muss zwischen 1 und {settings.PARALLEL_MAX} liegen: {patch['parallel']!r}")
    if "ytdlp_auto" in patch and patch["ytdlp_auto"] not in ("0", "1"):
        raise HTTPException(status_code=400,
                            detail=f"ytdlp_auto muss '0' oder '1' sein: {patch['ytdlp_auto']!r}")
    # Derselbe Rumpf wie der GET (#239) — „ein Aufruf, eine Wahrheit". Der Gedanke stand hier
    # schon fuer den `ytdlp`-Block, galt aber nur fuer ihn; fuenf weitere Felder fehlten
    # weiterhin. Jetzt entscheidet EIN Bauweg, was in einer Einstellungs-Antwort steht, und
    # der Typ im Frontend ist fuer beide Endpunkte wahr. Warum das die 0,26 s wert ist, steht
    # bei `_settings_body`.
    #
    # `ungeschuetzt` bleibt der einzige Zusatz, und bewusst NUR hier (#194): geschrieben wurde,
    # aber ohne Sperre — ein gleichzeitiger Schreiber kann den gerade eingetragenen Key
    # ueberbuegelt haben (#192). Es beschreibt diesen einen Schreibvorgang, nicht den Zustand
    # des Servers; im GET waere es sinnlos, und im `Settings`-Typ bliebe die Warnung bis zum
    # Neuladen stehen. Kein 5xx: geschrieben IST worden, ein Fehler waere die zweite Unwahrheit.
    cfg, gehalten = settings.save(patch)
    return {**_settings_body(cfg), "ungeschuetzt": not gehalten}


@app.delete("/api/settings/kaputt")
def settings_kaputt_weg():
    """Die beiseitegelegte Einstellungsdatei entfernen — der Knopf unter dem Hinweis (#192).

    Ohne ihn stuende der Hinweis fuer immer: der Pfad liegt im Benutzerprofil, und wer die
    App benutzt, um nicht mit Dateien hantieren zu muessen, faengt dafuer keinen Explorer an.
    Der Pfad kommt aus `settings.path()`, nicht aus dem Request — es gibt hier nichts zu
    validieren, und es darf auch nichts anderes geloescht werden koennen.
    """
    p = settings.kaputt_pfad()
    if not p:
        raise HTTPException(status_code=404, detail="keine beiseitegelegte Datei")
    try:
        os.remove(p)
    except OSError as e:
        # `from None` wie in `load_or_build_doc`: der Grund steht bereits im `detail`, die
        # Kette darunter faende ohnehin niemand (Starlette protokolliert eine behandelte
        # HTTPException ohne Traceback). Nachtrag zu PR #203, wo ich die Stelle mit dem
        # Argument „alle Geschwister werfen bare" verteidigt hatte — das stimmte nicht.
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from None
    return {"ok": True, "kaputt": ""}


@app.post("/api/settings/ytdlp/update")
def settings_ytdlp_update():
    """Der Knopf 'Jetzt aktualisieren'. Stoesst pip an und kehrt SOFORT zurueck (#174).

    Vorher lief pip synchron im Request. Der Docstring bezifferte den schlimmsten Fall auf
    „rund 250 s" und begruendete das mit „PIP_TIMEOUT (120 s) Warten auf die Sperre" — beides
    falsch (#219): gewartet wird `sperre.frist(stale)`, und `stale` ist am pip-Lock seit #207
    `PIP_TIMEOUT + 30 + sperre.frist()` = 215 s, macht **220 s** Wartezeit plus 120 s eigenes
    pip = **>=340 s**. Zwei Minuten ohne Lebenszeichen liest ein Nutzer als Absturz; ein
    Proxy- oder Browser-Timeout schnitt den Request ausserdem ab, ohne dass der pip-Lauf
    davon etwas merkte — das Ergebnis sah dann niemand.

    **Kein eigener Job-Typ.** Der kostete ein neues `kind` samt Label in `_KIND_TEXT`,
    `jobPhases.ts` und der Fusszeile — fuer eine Arbeit, die zu keiner Datei gehoert und
    deren Fortschritt niemanden interessiert. Ein Faden plus zwei Felder in `zustand()`
    reicht: das Frontend fragt beim naechsten `GET /api/settings` nach.

    **`gestartet: false`** heisst „es laeuft schon einer" — kein Fehler, sondern die
    Antwort auf den zweiten Klick. Das Frontend haengt sich dann an denselben Lauf.
    """
    gestartet = ytdlp_update.starte_hintergrund()
    return {"gestartet": gestartet, **ytdlp_update.zustand()}


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
        diag = llm.diagnose_fehler(e)
        detail = f"{diag['titel']}: {diag['hinweis']}" if diag["kategorie"] != "unbekannt" else str(e)
        return {"ok": False, "detail": detail}


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
def upload_audio(project: str, file: UploadFile = File(...), sprache: str = Form(None),
                 mehrsprachig: bool = Form(None), sprecher: int = Form(None)):
    _validate(project)
    _sicherer_projektname(project)   # VOR makedirs: Upload legt sonst still ein Projekt an
    name = os.path.basename(file.filename or "")           # vom Browser mitgesendete Pfade entfernen
    base, ext = os.path.splitext(name)
    ext = ext.lower()
    _validate(base)
    if ext not in AUDIO_EXT:
        raise HTTPException(status_code=400, detail=f"nicht unterstützte Endung: {ext or '(keine)'}")
    # Sprache VOR dem Datei-Schreiben pruefen — sonst laege bei 400 eine orphan-Audiodatei.
    fehler = _sprachen.pruef_fehler(sprache=sprache, mehrsprachig=mehrsprachig,
                                    sprecher=sprecher)
    if fehler:
        raise HTTPException(status_code=400, detail=fehler)
    adir = os.path.join(paths.project_dir(project), "audio")
    os.makedirs(adir, exist_ok=True)
    dest = os.path.join(adir, base + ext)
    try:
        with open(dest, "xb") as out:  # exklusiv: FileExistsError statt TOCTOU
            shutil.copyfileobj(file.file, out)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="Datei existiert bereits")
    # Sprache und Sprecherzahl fuer diese Datei eintragen, BEVOR der Job laeuft — sonst
    # transkribiert er auf Projekt-Standard und diarisiert ohne die Zahl. Fehlt ein Feld,
    # greift der Projekt-Default bzw. „automatisch" (Legacy-Verhalten).
    #
    # Der Zeitpunkt ist der ganze Grund, warum die Vorschau VOR dem Upload sitzt und nicht
    # daneben: der Upload startet die Pipeline selbst, wer die Zahl danach eintraegt, rennt
    # gegen die eigene Korrektur. Ein Test misst deshalb den Zeitpunkt, nicht nur das Ergebnis.
    if sprache or mehrsprachig is not None or sprecher is not None:
        _projekt.setze_datei(project, base, sprache=sprache, mehrsprachig=mehrsprachig,
                             sprecher=sprecher)
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
