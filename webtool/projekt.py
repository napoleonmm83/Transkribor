"""projekt.json: Sprache + Korrektur-Tiefe pro Projekt und pro Datei.

Liegt im Projektordner neben kontext.md. Fehlt die Datei oder ein Wert, gilt der
Projekt-Standard bzw. der System-Default (ch/auto) -> Legacy-Verhalten bleibt erhalten."""
import contextlib, json, os, time
from . import paths, sprachen


def _pfad(project: str) -> str:
    return os.path.join(paths.project_dir(project), "projekt.json")


# Ab wann ein liegengebliebenes Lock als verwaist gilt (Prozess im kritischen
# Abschnitt abgestorben). Die RMW-Sequenz selbst dauert Mikrosekunden — wer hier
# landet, ist ein Crash-Hinterlassenschaft.
_LOCK_STALTES_ALTER = 60.0


@contextlib.contextmanager
def _gesperrt(project: str):
    """Projekt-weites Lock um den Read-Modify-Write auf projekt.json.

    Zwei Schreiber (parallele Uploads im FastAPI-Threadpool, oder der fetch-
    Subprozess, der setze_datei aus einem *eigenen* OS-Prozess ruft) duerfen
    laden+modify+_write nicht verschränken: der letzte _write gewinnt, des
    anderen Datei-Eintrag ist verloren (#134). Ein prozess-lokales threading.Lock
    reicht nicht — der fetch-Subprozess hat ein eigenes. os.mkdir ist auf POSIX
    wie Windows atomar (im Gegensatz zu fcntl/msvcrt), darum ein Verzeichnis als
    Lock, ohne fremde Abhaengigkeit.
    """
    paths.safe_name(project)
    os.makedirs(paths.project_dir(project), exist_ok=True)
    lockdir = _pfad(project) + ".lock"
    while True:
        try:
            os.mkdir(lockdir)             # atomar auf allen Plattformen -> Lock erworben
            break
        except FileExistsError:
            # Verwaist? (Crash waehrend des kritischen Abschnitts.) Dann aufräumen
            # und erneut versuchen. Ein lebender Halter wird hier nicht weggerissen.
            try:
                if time.time() - os.stat(lockdir).st_mtime > _LOCK_STALTES_ALTER:
                    os.rmdir(lockdir)
            except OSError:
                pass
            time.sleep(0.01)
    try:
        yield
    finally:
        try:
            os.rmdir(lockdir)
        except OSError:
            pass


def _write(project: str, data: dict) -> None:
    # Trust-Boundary: project kommt aus der URL -> validieren, dann Ordner
    # anlegen (atomic_write macht keine Eltern). Ein zentraler Schreibpfad
    # fuer speichern + setze_datei -> keine Divergenz (siehe useDoc.ts-Regel).
    paths.safe_name(project)
    os.makedirs(paths.project_dir(project), exist_ok=True)
    paths.atomic_write(_pfad(project), json.dumps(data, ensure_ascii=False, indent=1))


def laden(project: str) -> dict:
    try:
        with open(_pfad(project), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    sprache = data.get("sprache")
    korrektur = data.get("korrektur")
    dateien = data.get("dateien")
    return {
        # Tolerant gegenueber falschem Schema (z.B. dateien als Liste, sprache
        # als Zahl): nur akzeptieren, was den richtigen Typ hat, sonst Default.
        "sprache": sprache if isinstance(sprache, str) else sprachen.SPRACH_DEFAULT,
        "korrektur": korrektur if isinstance(korrektur, str) else sprachen.TIEFE_DEFAULT,
        "dateien": {k: v for k, v in dateien.items() if isinstance(v, dict)} if isinstance(dateien, dict) else {},
    }


def speichern(project: str, patch: dict) -> dict:
    # RMW unter dem projekt-weiten Lock: laden+modify+_write sind atomar gegen
    # parallele Schreiber (Threads wie fetch-Subprozess).
    with _gesperrt(project):
        cur = laden(project)
        for k in ("sprache", "korrektur"):
            if k in patch and isinstance(patch[k], str):
                cur[k] = patch[k]
        _write(project, cur)
        return cur


def setze_datei(project: str, base: str, sprache=None, korrektur=None) -> dict:
    with _gesperrt(project):
        cur = laden(project)
        eintrag = dict(cur["dateien"].get(base, {}))
        if sprache is not None:
            eintrag["sprache"] = sprache
        if korrektur is not None:
            eintrag["korrektur"] = korrektur
        cur["dateien"][base] = eintrag
        _write(project, cur)
        return cur


def datei_sprache(project: str, base: str) -> str:
    d = laden(project)
    return d["dateien"].get(base, {}).get("sprache") or d["sprache"]


def datei_korrektur(project: str, base: str) -> str:
    d = laden(project)
    return d["dateien"].get(base, {}).get("korrektur") or d["korrektur"]


def tiefe_effektiv(project: str, base: str) -> str:
    tiefe = datei_korrektur(project, base)
    if tiefe != "auto":
        return tiefe
    return "voll_dialekt" if datei_sprache(project, base) == "ch" else "voll"
