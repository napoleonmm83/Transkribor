"""URL-Import: YouTube-/Instagram-Audio in ein Projekt laden und transkribieren.

    python -m webtool.fetch <projekt> <url> [<url> ...]

Laedt je URL die beste Tonspur als .m4a nach projekte/<projekt>/audio/ und
transkribiert anschliessend GENAU diese Dateien (transcribe.py, only=).
`cwd` muss das Repo-Root sein (wie bei webtool.correct) -> `import transcribe`.
"""
import argparse
import os
import re
import shutil
import sys
import unicodedata
from urllib.parse import urlparse

import transcribe

from . import paths, projekt, ytdlp_update

# Trust-Boundary: die URL kommt aus dem Browser. Gleichzeitig der Feature-Scope.
ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
    "instagram.com", "www.instagram.com",
}
MAX_BASE = 80
# Pfadtrenner, unter Windows verbotene Zeichen und Steuerzeichen
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
# Dateinamen bleiben ASCII (Entscheidung Marcus): umschreiben statt loeschen.
_UMLAUTE = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
                          "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"})

# yt-dlp wird NICHT am Modulkopf importiert, sondern erst in `_hole_yt_dlp()`. Der Grund ist
# die Selbstaktualisierung: pip tauscht die Dateien auf der PLATTE aus — ein hier importiertes
# Modul laege bereits im Speicher, und das Update wirkte erst beim naechsten Lauf. Nebenbei
# importiert der Server yt-dlp gar nicht mehr (aus fetch.py braucht app.py nur `check_url`).
yt_dlp = None

_PIP_HINWEIS = r".venv\Scripts\python.exe -m pip install -U yt-dlp"
# Instagram/YouTube melden Login-Zwang in vielen Formulierungen; hier grob abgedeckt.
_LOGIN_RE = re.compile(r"login|log in|sign in|private|not available|rate.?limit|cookies|bot", re.I)
# Wonach ein VERALTETER Extraktor aussieht. Bewusst eine Positivliste: eine fremde Plattform,
# fehlendes ffmpeg oder ein privates Video loesen damit KEINE Aktualisierung aus — ein pip bis
# 120 s fuer einen Fehler, den es nicht reparieren kann, waere reine Wartezeit.
# `requested format is not available` stand hier und war TOTER CODE: `_LOGIN_RE` enthaelt
# `not available`, und das Veto unten schlaegt die Positivliste. Nachgemessen an der echten
# yt-dlp-Meldung. Die Alternative — `_LOGIN_RE` auf `content is not available` schaerfen —
# waere die schlechtere: `This video is not available` (entfernt/geosperrt) verloere damit
# seine richtige Meldung "nicht oeffentlich abrufbar" UND loeste ein pip fuer nichts aus.
# Formatfehler heilen sich deshalb nicht selbst; das steht in #173.
_EXTRAKTOR_RE = re.compile(r"\b40[13]\b|unable to extract|failed to extract|nsig|signature",
                           re.I)


def _importiere_yt_dlp():
    """Der eigentliche Import — eigene Funktion, damit der Test die Reihenfolge
    (erst aktualisieren, dann importieren) beobachten kann, ohne echtes pip zu starten."""
    try:
        import yt_dlp as modul
    except ImportError:        # Feature ist optional -> Server und Tests laufen trotzdem
        return None
    return modul


def _hole_yt_dlp():
    """yt-dlp beim ersten Bedarf importieren — davor die faellige Aktualisierung."""
    global yt_dlp
    if yt_dlp is None:
        ytdlp_update.automatisch()
        yt_dlp = _importiere_yt_dlp()
    return yt_dlp


def _neu_laden() -> None:
    """Das im Speicher liegende yt-dlp wegwerfen und frisch von der Platte laden.

    Nur nach einer Selbstheilung noetig: dort ist yt-dlp bereits importiert, wenn pip die
    Dateien tauscht — `import` allein bekaeme weiter den Eintrag aus `sys.modules`. Sicher,
    weil `download_one` der einzige Nutzer ist und ueber Aufrufe hinweg nichts festhaelt:
    jede `YoutubeDL` entsteht neu und wird im `with` wieder geschlossen.

    Geladen wird HIER, nicht ueber `_hole_yt_dlp()`: das fragte sonst ein zweites Mal nach
    einer Aktualisierung, die gerade eben gelaufen ist.
    """
    global yt_dlp
    for name in [n for n in sys.modules if n == "yt_dlp" or n.startswith("yt_dlp.")]:
        del sys.modules[name]
    yt_dlp = _importiere_yt_dlp()


def _extraktor_verdacht(exc: Exception) -> bool:
    """Sieht der Fehlschlag nach einem veralteten Extraktor aus — lohnt sich also ein Update?

    Das Veto zaehlt: eine Meldung kann BEIDE Muster treffen ("Unable to extract nsig; use
    --cookies-from-browser"), und dann gilt der Login-Verdacht — ein Update repariert eine
    fehlende Anmeldung nie.

    `\\b40[13]\\b` trifft auch in fremdgesteuertem Text (Videotitel, Fehlertext der Plattform).
    Erzwingbar ist damit **ein** pip-Lauf pro Job, mit fester Argumentliste und Zeitdeckel —
    Wartezeit, kein Hebel: der Befehl haengt an keiner Eingabe.
    """
    msg = str(exc)
    return bool(_EXTRAKTOR_RE.search(msg)) and not _LOGIN_RE.search(msg)


def _js_runtime_pfad() -> str:
    """Pfad einer node-kompatiblen Laufzeit aus der Umgebung — oder Leerstring.

    Gesetzt von `electron/backend.js`: die gepackte App hat weder node noch deno auf dem PATH
    (#171), bringt aber selbst eine mit — Electrons Binary IST ein Node, sobald
    `ELECTRON_RUN_AS_NODE=1` in der Umgebung steht. Gemessen mit genau dem Aufruf, den
    `NodeJCP._run_js_runtime` macht (`--permission -`, Skript auf stdin): Node 24, sauberes
    JSON auf stdout, Exitcode 0.

    **Die beiden Variablen sind untrennbar**, und das Paar wird in backend.js gesetzt, nicht
    hier: ohne `ELECTRON_RUN_AS_NODE` startet dasselbe Binary das GUI statt zu rechnen — wer
    dagegen von Hand auf ein echtes node zeigt, will die Electron-Variable gerade NICHT.
    Ein Test ueber `serverEnv()` haelt sie in backend.js zusammen.

    Die Alternative waere ein Deno-Download bei der Ersteinrichtung gewesen: derselbe Zweck
    fuer 40 MB mehr — und auf Linux, wo `setup.js:plan()` nichts selbst installiert, ein
    Handgriff, den der Nutzer von Hand machen muesste.
    """
    return (os.environ.get("TRANSKRIBOR_JS_RUNTIME") or "").strip()


def _js_laufzeit_da() -> bool:
    """Gibt es ueberhaupt eine JS-Laufzeit? Nur fuer die FEHLERMELDUNG, nicht fuer die Optionen.

    yt-dlp sucht selbst auf dem PATH (und zusaetzlich im Scripts-Ordner) — deshalb stehen
    `deno`/`node` in `_ydl_opts` bedingungslos. Hier geht es allein darum, den 403 richtig zu
    deuten. Die mitgereichte Laufzeit zaehlt mit: sonst riete die Meldung im gepackten Lauf
    ausgerechnet dort zu einer Node-Installation, wo bereits eine benutzt wird.
    """
    return bool(_js_runtime_pfad()) or any(shutil.which(x) for x in ("deno", "node"))


def _human_error(exc: Exception) -> str:
    """yt-dlp-Rauschen -> ein Satz, der Marcus sagt, was zu tun ist."""
    roh = str(exc).strip()
    msg = roh.splitlines()[-1] if roh else exc.__class__.__name__
    if _LOGIN_RE.search(msg):
        return "Video ist nicht öffentlich abrufbar (Login nötig)"
    # Ohne JS-Laufzeit loest yt-dlp YouTubes Signatur nicht und bekommt 403 (#162). Die
    # Meldung liest sich wie ein gesperrtes Video; die Ursache steht nur in einer Warnung,
    # die `no_warnings` obendrein schluckt. Der gepackte Lauf bringt seit #171 Electrons
    # eigenes Node mit — der Rat gilt also nur noch, wo wirklich keine Laufzeit da ist.
    if "403" in msg and not _js_laufzeit_da():
        return (f"{msg} — YouTube braucht eine JavaScript-Laufzeit; "
                f"installiere Node (https://nodejs.org) oder Deno und versuche es erneut")
    return f"{msg} — bei Instagram hilft oft: {_PIP_HINWEIS}"


def check_url(url: str) -> str:
    """Getrimmte URL, wenn erlaubt. Sonst ValueError mit nutzerlesbarer Meldung."""
    url = (url or "").strip()
    u = urlparse(url)
    if u.scheme != "https":
        raise ValueError(f"nur https-URLs werden unterstützt: {url!r}")
    if (u.hostname or "").lower() not in ALLOWED_HOSTS:
        raise ValueError(f"nicht unterstützte Plattform: {u.hostname or url!r} "
                         f"(erlaubt sind YouTube und Instagram)")
    return url


def safe_base(title: str, fallback: str) -> str:
    """Videotitel -> ASCII-Dateiname, der paths.safe_name() ueberlebt.

    Umlaute werden umgeschrieben (Mueller, nicht Mller), alles uebrige Nicht-ASCII
    (Emoji, Akzente, fremde Schriften) faellt weg. Hart auf MAX_BASE gekuerzt.
    """
    s = unicodedata.normalize("NFC", title or "").translate(_UMLAUTE)
    # NFKD zerlegt é -> e+Akzent, 'ignore' wirft den Akzent und alles Uebrige weg.
    # MUSS nach dem translate stehen, sonst wuerde ü ueber u+Trema zu 'u' statt 'ue'.
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = _BAD.sub(" ", s)          # ersetzen statt loeschen -> keine Wortverklebung
    s = s.replace(".", " ")       # '..' verbietet safe_name; einzelne Punkte stoeren splitext
    s = re.sub(r"\s+", " ", s).strip(" -")
    s = s[:MAX_BASE].strip(" -")  # harter Schnitt, danach erneut trimmen
    return paths.safe_name(s or fallback)   # letzte Instanz; wirft nur bei einem Bug


def unique_base(adir: str, base: str) -> str:
    """base, base-2, base-3 … bis im Verzeichnis keine Audiodatei so heisst."""
    cand, n = base, 1
    while any(os.path.exists(os.path.join(adir, cand + e)) for e in transcribe.AUDIO_EXT):
        n += 1
        cand = f"{base}-{n}"
    return cand


def _ydl_opts(outtmpl: str = "") -> dict:
    """Gemeinsame yt-dlp-Optionen; mit `outtmpl` zusaetzlich die Download-Seite.

    EINE Stelle fuer beide Aufrufe: die Metadaten-Runde extrahiert genauso wie der
    Download, eine Option nur an einem der beiden Orte wirkt also nur halb.
    """
    # Ohne JS-Laufzeit antwortet YouTube mit 403 (#162); die Ursache steht nur in einer
    # Warnung darueber. deno ist yt-dlps Vorgabe, node liegt fuer den Frontend-Build ohnehin
    # vor. Beide bleiben stehen, auch wenn eine Laufzeit mitgereicht wird: eine nicht
    # gefundene ist fuer yt-dlp kein Fehler (JsRuntime.info -> None), gewarnt wird nur bei
    # einem unbekannten NAMEN — und ein auf dem PATH liegendes deno hat hoehere Prioritaet.
    # `path` ueberspringt yt-dlps PATH-Suche fuer `node` (YoutubeDL._js_runtimes ->
    # NodeJsRuntime(path=…)); im Entwickler-Checkout ist die Variable leer und es bleibt
    # byte-identisch beim alten Verhalten.
    pfad = _js_runtime_pfad()
    opts = {
        "noplaylist": True,        # ?list=… nicht als ganze Playlist auffassen
        "quiet": True, "no_warnings": True, "noprogress": True,
        "js_runtimes": {"deno": {}, "node": {"path": pfad} if pfad else {}},
    }
    if outtmpl:
        opts |= {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": outtmpl,
            # m4a steht in AUDIO_EXT und spielt im Browser; YouTubes Default waere Opus-in-.webm
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
            "retries": 3,
        }
    return opts


def _mehrsprachig_aus_env():
    """TRANSKRIBOR_FETCH_MEHRSPRACHIG -> True/False/None (nicht gesetzt = kein Override).

    Eigene Funktion, damit der Test sie ruft statt die Logik nachzubauen — ein Test, der den
    Parser dupliziert, prueft sich selbst. Wichtig ist die Null-Richtung: der Wert ist ein
    STRING, und "0" ist truthy. Ein blosses `bool(env)` gaebe einer bewusst einsprachig
    markierten Datei den Haken doch.
    """
    roh = os.environ.get("TRANSKRIBOR_FETCH_MEHRSPRACHIG")
    return None if roh is None else roh.strip().lower() in ("1", "true", "yes")


def download_one(project: str, url: str) -> str:
    """Laedt die Tonspur nach projekte/<project>/audio/. Liefert den Basisnamen."""
    # Der FFmpegExtractAudio-Postprocessor laeuft im extract_info(download=True) unten und
    # sucht ffmpeg auf PATH. ensure_ffmpeg() legt den winget-Pfad dorthin — muss also HIER
    # stehen, nicht erst vor dem Whisper-Lauf in main(). Findet es nichts, lieber sofort
    # abbrechen als hinterher am kryptischen "ffprobe and ffmpeg not found" scheitern.
    # Steht VOR _hole_yt_dlp(): der Griff kann ein pip von bis zu 120 s ausloesen, und diese
    # Vorbedingung steht ohne jede Wartezeit fest.
    if not transcribe.ensure_ffmpeg():
        raise RuntimeError("ffmpeg nicht gefunden — installiere: winget install Gyan.FFmpeg")
    ydl_modul = _hole_yt_dlp()
    if ydl_modul is None:
        raise RuntimeError(f"yt-dlp ist nicht installiert — {_PIP_HINWEIS}")
    adir = os.path.join(paths.project_dir(project), "audio")
    os.makedirs(adir, exist_ok=True)

    # ponytail: zwei yt-dlp-Aufrufe (Metadaten, dann Download) — kostet einen Roundtrip,
    # dafuer steht der Dateiname VOR dem Download fest und Kollisionen sind sauber loesbar.
    with ydl_modul.YoutubeDL(_ydl_opts()) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    plattform = "youtube" if "youtu" in (urlparse(url).hostname or "") else "instagram"
    base = unique_base(adir, safe_base(info.get("title") or "",
                                       f"{plattform}-{info.get('id') or 'video'}"))

    print(f"[fetch] lade {base} …", flush=True)
    with ydl_modul.YoutubeDL(_ydl_opts(os.path.join(adir, base + ".%(ext)s"))) as ydl:
        ydl.extract_info(url, download=True)
    print(f"[fetch] fertig {base}", flush=True)
    # Sprache pro geladene Base eintragen (vom Web-Tool per Env durchgereicht). Fehlt die
    # Variable, greift der Projekt-Default — Legacy-Verhalten bleibt unveraendert.
    sprache = os.environ.get("TRANSKRIBOR_FETCH_SPRACHE")
    mehr = _mehrsprachig_aus_env()
    if sprache or mehr is not None:
        projekt.setze_datei(project, base, sprache=sprache, mehrsprachig=mehr)
    return base


def _lade(project: str, url: str):
    """(base, None) bei Erfolg, (None, exception) sonst — damit `main` denselben Versuch
    zweimal machen kann (einmal, und nach einer Aktualisierung noch einmal), ohne den
    try/except-Block zu verdoppeln."""
    try:
        return download_one(project, check_url(url)), None
    except Exception as e:
        return None, e


def main(argv=None):
    try:  # Umlaute/… auch bei umgeleitetem stdout auf non-UTF-8-Windows nicht crashen
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description="URL-Import (YouTube/Instagram) fuer ein Projekt")
    ap.add_argument("project")
    ap.add_argument("urls", nargs="+")
    # Das Web-Tool laedt nur herunter und laesst danach den normalen Transkriptions-Job laufen:
    # sonst belegte der Import einen GPU-Slot fuer die ganze Download-Dauer und wuerde selbst
    # von jeder laufenden Transkription blockiert. Direkter CLI-Aufruf transkribiert wie bisher.
    ap.add_argument("--download-only", action="store_true")
    args = ap.parse_args(argv)
    paths.safe_name(args.project)

    # Leerer Wirkungsbereich: der Import legt NEUE Aufnahmen an und fasst keine vorhandene
    # an. Ohne die Zeile gaelte der Job als allumfassend und sperrte waehrend des Downloads
    # das ganze Projekt (Issue #80). Transkribiert wird danach im eigenen Job, der seinen
    # Bereich selbst meldet; beim direkten CLI-Lauf (--download-only fehlt) tut das
    # transcribe_project unten.
    print("[scope] ", flush=True)
    geladen = []
    geheilt = False        # hoechstens EIN pip pro Lauf, egal wie viele URLs brechen
    for url in args.urls:
        base, fehler = _lade(args.project, url)
        # Selbstheilung: ein veralteter Extraktor bricht nicht nach Kalender, sondern wenn
        # YouTube etwas umstellt — der 14-Tage-Takt kaeme dafuer zu spaet. `erzwingen` uebergeht
        # deshalb den Merker; der Schalter bleibt unberuehrt.
        if fehler is not None and not geheilt and _extraktor_verdacht(fehler):
            geheilt = True
            # Die Meldung steht NACH dem Aufruf: bei abgeschaltetem Automatismus passiert
            # nichts, und ein "versuche es noch einmal" im Job-Log waere dann eine Zusage,
            # die niemand einloest — ausgerechnet in dem Protokoll, das der Nutzer liest,
            # wenn ein Import fehlschlaegt. `automatisch()` meldet sich selbst, waehrend es
            # laeuft ("[ytdlp] aktualisiere …"), die Pause bleibt also erklaert.
            if ytdlp_update.automatisch(erzwingen=True):
                print(f"[fetch] yt-dlp aktualisiert — versuche {url} noch einmal", flush=True)
                _neu_laden()
                base, fehler = _lade(args.project, url)
        if fehler is not None:
            print(f"[fetch] FEHLER {url}: {_human_error(fehler)}", flush=True)
        else:
            geladen.append(base)
    print(f"[fetch] {len(geladen)} von {len(args.urls)} geladen", flush=True)
    if not geladen:
        raise SystemExit(1)      # Job-Status 'error'; Whisper wird gar nicht erst geladen
    if args.download_only:
        return

    transcribe.ensure_ffmpeg()
    transcribe.transcribe_project(args.project,
                                  os.environ.get("WHISPER_MODEL", "large-v3"),
                                  os.environ.get("WHISPER_LANG", "de"),
                                  only=geladen)


if __name__ == "__main__":
    main()
