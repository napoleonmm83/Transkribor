"""projekt.json: Sprache + Korrektur-Tiefe pro Projekt und pro Datei.

Liegt im Projektordner neben kontext.md. Fehlt die Datei oder ein Wert, gilt der
Projekt-Standard bzw. der System-Default (ch/auto) -> Legacy-Verhalten bleibt erhalten."""
import contextlib, json, os
from . import paths, sperre, sprachen


def _pfad(project: str) -> str:
    return os.path.join(paths.project_dir(project), "projekt.json")


@contextlib.contextmanager
def _gesperrt(project: str):
    """Projekt-weites Lock um den Read-Modify-Write auf projekt.json (#134).

    Zwei Schreiber (parallele Uploads im FastAPI-Threadpool, oder der fetch-Subprozess,
    der setze_datei aus einem *eigenen* OS-Prozess ruft) duerfen laden+modify+_write nicht
    verschraenken: der letzte _write gewinnt, des anderen Datei-Eintrag ist verloren.
    Die Mechanik steht seit derselben Race auf settings.json in `sperre.py`.
    """
    paths.safe_name(project)
    os.makedirs(paths.project_dir(project), exist_ok=True)
    with sperre.datei(_pfad(project)):
        yield


def _write(project: str, data: dict) -> None:
    # Trust-Boundary: project kommt aus der URL -> validieren, dann Ordner
    # anlegen (atomic_write macht keine Eltern). Ein zentraler Schreibpfad
    # fuer speichern + setze_datei -> keine Divergenz (siehe useDoc.ts-Regel).
    paths.safe_name(project)
    os.makedirs(paths.project_dir(project), exist_ok=True)
    paths.atomic_write(_pfad(project), json.dumps(data, ensure_ascii=False, indent=1))


def laden(project: str) -> dict:
    return _lesen(project)[0]


def _lesen(project: str) -> tuple:
    """(Einstellungen, kaputt). `laden()` ist der reine Lesepfad und verschluckt `kaputt`
    bewusst; `speichern`/`setze_datei` brauchen es, sonst ersetzen sie die Datei ungefragt
    durch Defaults (#196) — und ihre Schreiber sind unbeaufsichtigt (jeder Upload, jeder
    URL-Import aus dem fetch-Subprozess)."""
    # Pfad VOR dem try: `paths.safe_name` wirft ValueError fuer unsichere Namen, und seit
    # der Erweiterung auf ValueError (#190) verschluckte der Rueckfall genau diese
    # Vertrauensgrenze — `laden("..")` gab Defaults zurueck statt zu werfen (gemessen).
    pfad = _pfad(project)
    kaputt = False
    try:
        with open(pfad, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:         # Normalfall (Legacy-Projekt ohne Datei) -> schweigen
        data = {}
    except (OSError, ValueError) as e:     # ValueError deckt auch UnicodeDecodeError (#190)
        # Laut, nicht still — dieselbe Regel wie `settings.load()` seit #188: `speichern`
        # und `setze_datei` sind Read-Modify-Write ueber genau diese Funktion, der naechste
        # Upload ueberbuegelt die Datei also mit Defaults. Gemessen: Sprache und Tiefe ALLER
        # Dateien waren danach weg, englische Aufnahmen liefen wieder auf Schweizerdeutsch.
        # Seit #196 bleibt der Inhalt erhalten: der Schreiber legt sie als .kaputt beiseite.
        print(f"⚠ {pfad} nicht lesbar ({type(e).__name__}: {e}) — Projekt- und "
              f"Datei-Einstellungen fallen auf Standard (ch/auto)", flush=True)
        data = {}
        kaputt = True
    if not isinstance(data, dict):
        data = {}
    sprache = data.get("sprache")
    korrektur = data.get("korrektur")
    mehrsprachig = data.get("mehrsprachig")
    dateien = data.get("dateien")
    return ({
        # Tolerant gegenueber falschem Schema (z.B. dateien als Liste, sprache
        # als Zahl): nur akzeptieren, was den richtigen Typ hat, sonst Default.
        "sprache": sprache if isinstance(sprache, str) else sprachen.SPRACH_DEFAULT,
        "korrektur": korrektur if isinstance(korrektur, str) else sprachen.TIEFE_DEFAULT,
        # Vorgabe False: bestehende Projekte ohne den Schluessel behalten ihr Verhalten.
        "mehrsprachig": mehrsprachig if isinstance(mehrsprachig, bool) else False,
        "dateien": {k: v for k, v in dateien.items() if isinstance(v, dict)} if isinstance(dateien, dict) else {},
    }, kaputt)


def speichern(project: str, patch: dict) -> dict:
    # RMW unter dem projekt-weiten Lock: laden+modify+_write sind atomar gegen
    # parallele Schreiber (Threads wie fetch-Subprozess).
    with _gesperrt(project):
        cur, kaputt = _lesen(project)
        # INNERHALB der Sperre und VOR `_write`: dessen `os.replace` verwirft den Inhalt
        # sonst, und ausserhalb der Sperre raenge das Umbenennen mit dem zweiten Schreiber.
        if kaputt:
            paths.beiseitelegen(_pfad(project))
        for k in ("sprache", "korrektur"):
            if k in patch and isinstance(patch[k], str):
                cur[k] = patch[k]
        # Eigener Zweig: die Schleife darueber filtert auf isinstance(str) — ein bool faellt
        # dort durch und waere still verworfen worden (das Kaestchen liesse sich setzen,
        # ohne dass etwas passiert).
        if isinstance(patch.get("mehrsprachig"), bool):
            cur["mehrsprachig"] = patch["mehrsprachig"]
        _write(project, cur)
        return cur


# Sentinel fuer `setze_datei`: den Datei-Override ENTFERNEN, statt einen zu setzen. `None` heisst
# dort bereits "nicht anfassen" (Partial-Update), `True`/`False` heissen "setzen" — fuer "folgt
# wieder dem Projekt" braucht es einen dritten Wert. Es ist dieselbe Unterscheidung, an der
# `datei_mehrsprachig` haengt: der SCHLUESSEL entscheidet, nicht sein Wert (#166).
ERBEN = object()


def setze_datei(project: str, base: str, sprache=None, korrektur=None, mehrsprachig=None) -> dict:
    with _gesperrt(project):
        cur, kaputt = _lesen(project)
        if kaputt:                      # siehe `speichern`
            paths.beiseitelegen(_pfad(project))
        eintrag = dict(cur["dateien"].get(base, {}))
        if sprache is not None:
            eintrag["sprache"] = sprache
        if korrektur is not None:
            eintrag["korrektur"] = korrektur
        if mehrsprachig is ERBEN:
            eintrag.pop("mehrsprachig", None)
        elif mehrsprachig is not None:
            eintrag["mehrsprachig"] = bool(mehrsprachig)
        cur["dateien"][base] = eintrag
        _write(project, cur)
        return cur


def datei_sprache(project: str, base: str) -> str:
    d = laden(project)
    return d["dateien"].get(base, {}).get("sprache") or d["sprache"]


def datei_korrektur(project: str, base: str) -> str:
    d = laden(project)
    return d["dateien"].get(base, {}).get("korrektur") or d["korrektur"]


def datei_override_mehrsprachig(project: str, base: str) -> bool | None:
    """Hat die Datei einen EIGENEN Haken — und welchen? `None` heisst „folgt dem Projekt".

    Getrennt von `datei_mehrsprachig` (das den effektiven Wert liefert), weil die Oberflaeche
    beides braucht: die drei Zustaende zur Auswahl und den Projektwert als Beschriftung. Aus dem
    effektiven Wert allein laesst sich „folgt dem Projekt" nicht ablesen — er sieht identisch
    aus wie ein Override, der zufaellig dasselbe sagt (#166).
    """
    e = laden(project)["dateien"].get(base, {})
    return bool(e["mehrsprachig"]) if "mehrsprachig" in e else None


def datei_mehrsprachig(project: str, base: str) -> bool:
    """Enthaelt die Datei mehrere Sprachen? Datei-Override, sonst Projekt-Standard.

    Der Rueckfall geht ueber die ANWESENHEIT des Schluessels, nicht ueber `or` wie bei
    datei_sprache: ein bewusst gesetztes False ist falsy — mit `or` gewaenne der Projektwert,
    und der Haken liesse sich pro Datei nie wieder abwaehlen. Dasselbe Prinzip wie
    `"text": ""` in apply_correction: der Schluessel entscheidet, nicht der Wert.
    """
    d = laden(project)
    e = d["dateien"].get(base, {})
    if "mehrsprachig" in e:
        return bool(e["mehrsprachig"])
    return bool(d["mehrsprachig"])


def datei_einstellungen(project: str, base: str) -> tuple:
    """(sprache, mehrsprachig) EINER Datei aus EINEM Lesevorgang.

    datei_sprache + datei_mehrsprachig einzeln zu rufen laedt projekt.json zweimal — pro
    Datei, in einer Schleife ueber ein ganzes Projekt. Die Aufloesungsregeln stehen absichtlich
    weiterhin nur in den Einzelfunktionen; hier wird der geladene Stand nur geteilt.
    """
    d = laden(project)
    e = d["dateien"].get(base, {})
    sprache = e.get("sprache") or d["sprache"]
    mehr = bool(e["mehrsprachig"]) if "mehrsprachig" in e else bool(d["mehrsprachig"])
    return sprache, mehr


def tiefe_effektiv(project: str, base: str) -> str:
    tiefe = datei_korrektur(project, base)
    if tiefe != "auto":
        return tiefe
    return "voll_dialekt" if datei_sprache(project, base) == "ch" else "voll"
