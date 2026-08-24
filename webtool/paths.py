"""Pfade + Namensvalidierung (Trust-Boundary: project/base kommen aus der URL)."""
import glob
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def projekte_root() -> str:
    return os.environ.get("TRANSKRIBOR_PROJEKTE") or os.path.join(ROOT, "projekte")


def downloads_dir() -> str:
    """Standard-Downloads-Verzeichnis des Nutzers."""
    return os.environ.get("TRANSKRIBOR_DOWNLOADS") or os.path.join(os.path.expanduser("~"), "Downloads")


def safe_name(name: str) -> str:
    # "." / ".." resolven auf Eltern-/Self-Verzeichnis -> dürfen project_dir()
    # nie erreichen (sonst rmtree auf projekte_root() selbst, siehe Task 4 Review).
    # Steuerzeichen (\t, \r, \n, ord < 32, ord == 127) zerbrechen Protokoll- und Scope-Zeilen (#378).
    if (not name or name in (".", "..") or "/" in name or "\\" in name
            or ":" in name or ".." in name or any(ord(c) < 32 or ord(c) == 127 for c in name)):
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
    <base>.edit.json / <base>.correction.json / <base>.diar.json und ohne
    Meta-Artefakte (_*.json, z.B. _glossar.json aus Stufe 2b)."""
    tdir = transkripte_dir(project)
    if not os.path.isdir(tdir):
        return []
    out = set()
    for p in glob.glob(os.path.join(tdir, "*.json")):
        name = os.path.basename(p)
        if name.startswith("_") or p.endswith((".edit.json", ".correction.json", ".diar.json")):
            continue
        out.add(os.path.splitext(name)[0])
    return sorted(out)


def atomic_write(path: str, text: str) -> None:
    """Schreibe erst in .tmp, dann os.replace() -> nie halb-geschriebene Datei."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def beiseitelegen(pfad: str) -> str:
    """Eine nicht lesbare Datei retten, BEVOR ein Read-Modify-Write sie mit Defaults ersetzt.

    `settings.save()` und `projekt.speichern`/`setze_datei` lesen ueber einen Leser, der bei
    kaputten Bytes auf Defaults zurueckfaellt (#190) — und schreiben genau diese Defaults
    zurueck. Gemessen war danach der API-Key weg (#192) bzw. Sprache und Korrektur-Tiefe ALLER
    Dateien eines Projekts (#196). Der Inhalt war dabei mit blossem Auge noch lesbar: ein
    einzelnes kaputtes Byte macht die Datei fuer `json.load` unbrauchbar, nicht fuer den
    Menschen. Rueckgabe: der Pfad der Rettung, oder "" wenn nichts gerettet wurde.

    **Die ERSTE Rettung gewinnt.** Nach ihr steht in der Datei nur noch Default-Inhalt — eine
    zweite Beschaedigung ueberschriebe also ausgerechnet das, was man retten wollte. Dieselbe
    Richtung wie ueberall in diesem Repo: ein Rueckfall darf nichts freigeben, was er schuetzen
    soll.

    Best effort: schlaegt das Umbenennen fehl, laeuft der Schreibvorgang trotzdem. Der Aufruf
    dient dem Schutz, er ist nicht sein Zweck (dieselbe Regel wie beim Lock in `sperre.py`).
    """
    ziel = pfad + ".kaputt"
    try:
        if os.path.exists(ziel):
            print(f"⚠ {pfad} ist erneut nicht lesbar — {ziel} bleibt die aeltere Rettung "
                  f"und wird NICHT ueberschrieben", flush=True)
            return ""
        os.replace(pfad, ziel)
    except OSError as e:
        print(f"⚠ {pfad} liess sich nicht beiseitelegen ({type(e).__name__}: {e}) — "
              f"der Inhalt geht beim naechsten Schreibvorgang verloren", flush=True)
        return ""
    print(f"⚠ {pfad} war nicht lesbar — die alte Fassung liegt jetzt als {ziel}", flush=True)
    return ziel
