"""Selbstaktualisierung von yt-dlp.

`pip install -r requirements.txt` laeuft in der installierten App genau EINMAL — beim ersten
Start. `electron/setup.js:venvVollstaendig()` prueft danach nur noch, ob torch, faster_whisper,
fastapi und uvicorn importierbar sind; ist das gruen, laeuft `einrichten()` nie wieder. Ein
App-Update ersetzt die .exe, nicht die venv (die liegt in `userData` und ueberlebt bewusst).
**yt-dlp friert damit auf dem Installationstag ein** — ausgerechnet bei der Abhaengigkeit, die
kaputtgehen MUSS: ihre Extraktoren laufen YouTube und Instagram hinterher (#162).
`yt-dlp>=…` in requirements.txt schuetzt nur Neuinstallationen, Renovate nur das Repo.

Zwei Wege hier hinein:
- `automatisch()` — der Kalenderweg, gerufen vor dem ersten Zugriff auf yt-dlp.
- `automatisch(erzwingen=True)` — die Selbstheilung, gerufen wenn ein Download so
  abgebrochen ist, wie es ein veralteter Extraktor tut.

Beide sind **best effort**: scheitert pip (offline, PyPI zickt), wird das protokolliert und
der Aufrufer macht mit der vorhandenen Fassung weiter. Ein Rechner ohne Netz darf durch
dieses Feature nicht schlechter dastehen als vorher.
"""
import datetime as dt
import os
import subprocess
import sys
from importlib import metadata

from . import settings, sperre

# yt-dlp veroeffentlicht stabil etwa monatlich: kuerzer bringt selten etwas Neues, laenger
# liesse einen kaputten Extraktor monatelang kaputt. Eine Zahl, an einer Stelle.
INTERVALL_TAGE = 14
PIP_TIMEOUT = 120
MERKER = "ytdlp_geprueft"


def _heute() -> dt.date:
    """Eigene Funktion, damit Tests das Datum setzen koennen, ohne die Uhr zu faelschen."""
    return dt.date.today()


def fassung() -> str | None:
    """Installierte Fassung — aus den Metadaten auf der Platte, OHNE yt-dlp zu importieren.

    Das ist der Angelpunkt: pip tauscht Dateien aus, ein bereits importiertes Modul laege
    schon im Speicher. Erst lesen, dann aktualisieren, dann importieren.
    """
    try:
        return metadata.version("yt-dlp")
    except metadata.PackageNotFoundError:
        return None


def _als_datum(v: str | None) -> dt.date | None:
    """'2026.7.4' -> date. Die Versionsnummer IST ein Datum — keine PyPI-Abfrage noetig.

    Nightlies haengen die Uhrzeit als viertes Glied an ('2026.7.4.232355'); ohne den Schnitt
    auf drei Teile waere jede davon unlesbar und damit dauernd faellig.
    """
    try:
        jahr, monat, tag = (int(x) for x in (v or "").split(".")[:3])
        return dt.date(jahr, monat, tag)
    except ValueError:                      # zu wenige Teile, keine Zahlen, oder 2026.13.40
        return None


def env_override() -> str | None:
    """Der Wert von TRANSKRIBOR_YTDLP_UPDATE, wenn er die Einstellung ueberstimmt — sonst None.

    **Leer ist kein Override.** `settings.load_env()` schreibt eine Zeile `TRANSKRIBOR_YTDLP_UPDATE=`
    als leeren String in die Umgebung; `os.environ.get` liefert dann `""` statt `None`, und
    `"" not in ("0","false","no")` waere ein stilles JA — wer den Haken im Browser abwaehlt,
    bekaeme weiter Updates und dazu die Meldung, eine Variable sei schuld, die er leer gelassen
    hat. (Dieselbe Null-Richtung wie in `fetch._mehrsprachig_aus_env`.)
    """
    roh = os.environ.get("TRANSKRIBOR_YTDLP_UPDATE")
    return roh if roh and roh.strip() else None


def auto_an() -> bool:
    """Darf automatisch aktualisiert werden? Eine gesetzte Env-Variable gewinnt gegen die
    Einstellung — dieselbe Regel wie in `settings.job_env()`: wer sie gesetzt hat (.env, CI),
    soll sie behalten."""
    roh = env_override() or settings.load().get("ytdlp_auto") or "1"
    return roh.strip().lower() not in ("0", "false", "no")


def geprueft() -> dt.date | None:
    """Wann zuletzt geprueft wurde. Ein verdrehtes Datum gilt als 'nie' — es darf die
    Aktualisierung nicht fuer immer abschalten.

    Das gilt fuer unlesbare Werte UND fuer Daten in der Zukunft. Letzteres stand zuerst nur
    im Docstring: `(heute - g).days` wird bei einem Zukunftsdatum negativ, `faellig()` also
    dauerhaft False — `ytdlp_geprueft: "2099-01-01"` schaltete den Kalenderweg **still und
    fuer immer** ab. Der API-Pfad ist dagegen verteidigt (`SettingsBody` kennt den Schluessel
    nicht), Handbearbeitung und eine vorgehende Rechneruhr aber nicht.
    """
    try:
        d = dt.date.fromisoformat((settings.load().get(MERKER) or "").strip())
    except ValueError:
        return None
    return None if d > _heute() else d


def faellig() -> bool:
    """Fassung aelter als INTERVALL_TAGE **und** letzte Pruefung laenger her.

    Der Merker ist noetig, nicht Zierde: yt-dlp veroeffentlicht etwa monatlich, allein an der
    Fassung gemessen waere sie nach 14 Tagen DAUERHAFT faellig — und jeder Import liefe in
    ein pip, das nichts aendert.
    """
    v = fassung()
    if v is None:
        # `pip install -U` wuerde yt-dlp hier NEU installieren. Das ist Sache des Setups;
        # der Import meldet dann ehrlich "yt-dlp ist nicht installiert".
        return False
    heute = _heute()
    d = _als_datum(v)
    if d is not None and (heute - d).days < INTERVALL_TAGE:
        return False
    g = geprueft()
    return g is None or (heute - g).days >= INTERVALL_TAGE


def _merken() -> None:
    """Merker setzen — AUCH nach einem Fehlschlag, sonst liefe der naechste Import in
    denselben Timeout. Buchhaltung, kein Ergebnis: scheitert das Schreiben (schreibgeschuetztes
    Profil), darf es den Aufrufer nicht mitreissen."""
    try:
        settings.save({MERKER: _heute().isoformat()})
    except OSError as e:
        print(f"[ytdlp] Merker nicht schreibbar: {e}", flush=True)


def aktualisiere() -> bool:
    """`pip install -U yt-dlp`, bedingungslos. Liefert True, wenn pip sauber durchlief.

    NUR yt-dlp: ein `-U` ueber alle requirements erwischt irgendwann torch, und die GPU
    waere still weg (dieselbe Falle wie beim CPU-Rad in setup.js).
    """
    cmd = [sys.executable, "-m", "pip", "install", "-U",
           # Kurze Deckel: ohne sie haengt pip offline minutenlang, und der Import wartet mit.
           "--retries", "1", "--timeout", "10", "yt-dlp"]
    print(f"[ytdlp] aktualisiere (installiert: {fassung() or 'nichts'}) …", flush=True)
    ok = False
    # Zwei pip-Laeufe auf DIESELBE venv duerfen sich nicht ueberschneiden — sie schreiben in
    # dasselbe site-packages und koennen die Installation zerlegen. Erreichbar, seit es zwei
    # Ausloeser aus zwei Prozessen gibt: der Import-Job und der Knopf in den Einstellungen.
    # Eigener Lock-Name (…ytdlp.lock), damit er sich nicht mit dem von `settings.save()`
    # ueberschneidet — der wird im `_merken()` genommen, waehrend dieser noch haelt.
    try:
        # `or "."` fuer ein TRANSKRIBOR_SETTINGS ohne Verzeichnisanteil (`os.makedirs("")`
        # wuerde werfen). Und best effort wie alles hier: ein nicht anlegbares Verzeichnis
        # darf den Aufrufer nicht mitreissen — dann laeuft es eben ohne Sperre.
        os.makedirs(os.path.dirname(settings.path()) or ".", exist_ok=True)
    except OSError as e:
        print(f"[ytdlp] Sperrverzeichnis nicht anlegbar: {e}", flush=True)
    with sperre.datei(settings.path() + ".ytdlp", stale=PIP_TIMEOUT + 30):
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                               timeout=PIP_TIMEOUT)
            ok = p.returncode == 0
            zeilen = (p.stdout or "").strip().splitlines() or (p.stderr or "").strip().splitlines()
            print(f"[ytdlp] {'ok' if ok else 'fehlgeschlagen'}: {zeilen[-1] if zeilen else ''}",
                  flush=True)
        except (OSError, subprocess.SubprocessError) as e:
            print(f"[ytdlp] Update fehlgeschlagen: {e}", flush=True)
        # INNERHALB der Sperre: der Kommentar oben behauptete das, der Aufruf stand aber eine
        # Zeile darunter — womit der Test auf die verschiedenen Lock-Namen nichts pruefte
        # (mit demselben Namen blieb er gruen). Jetzt ist die verschachtelte Sperre echt.
        _merken()
    return ok


def automatisch(erzwingen: bool = False) -> bool:
    """Der automatische Weg: Schalter und Faelligkeit werden respektiert.

    `erzwingen` uebergeht die Faelligkeit (Selbstheilung — ein Extraktor bricht nicht nach
    Kalender), **nicht** den Schalter: wer seine venv selbst verwaltet, will auch keine
    Selbstheilung darin.
    """
    if not auto_an():
        return False
    if not erzwingen and not faellig():
        return False
    return aktualisiere()


def zustand() -> dict:
    """Fuer die Einstellungsseite: was installiert ist, wann zuletzt geprueft wurde,
    ob der Automatismus laeuft — und ob die Umgebung den Haken ueberstimmt.

    `env` sagt der Server, statt das Frontend `ytdlp_auto` gegen `auto` vergleichen zu lassen:
    die beiden Werte kommen aus zwei Antworten (PUT liefert nur `ytdlp_auto`), und dazwischen
    behauptete der Vergleich fuer einen Moment ein Override, das es gar nicht gibt. Eine
    Wahrheit statt einer abgeleiteten.
    """
    g = geprueft()
    return {"version": fassung(), "geprueft": g.isoformat() if g else "",
            "auto": auto_an(), "env": env_override() is not None}
