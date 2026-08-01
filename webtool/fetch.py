"""URL-Import: YouTube-/Instagram-Audio in ein Projekt laden und transkribieren.

    python -m webtool.fetch <projekt> <url> [<url> ...]

Laedt je URL die beste Tonspur als .m4a nach projekte/<projekt>/audio/ und
transkribiert anschliessend GENAU diese Dateien (transcribe.py, only=).
`cwd` muss das Repo-Root sein (wie bei webtool.correct) -> `import transcribe`.
"""
import argparse
import os
import re
import sys
import unicodedata
from urllib.parse import urlparse

import transcribe

from . import paths

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

try:
    import yt_dlp
except ImportError:            # Feature ist optional -> Server und Tests laufen trotzdem
    yt_dlp = None

_PIP_HINWEIS = r".venv\Scripts\python.exe -m pip install -U yt-dlp"
# Instagram/YouTube melden Login-Zwang in vielen Formulierungen; hier grob abgedeckt.
_LOGIN_RE = re.compile(r"login|log in|sign in|private|not available|rate.?limit|cookies|bot", re.I)


def _human_error(exc: Exception) -> str:
    """yt-dlp-Rauschen -> ein Satz, der Marcus sagt, was zu tun ist."""
    roh = str(exc).strip()
    msg = roh.splitlines()[-1] if roh else exc.__class__.__name__
    if _LOGIN_RE.search(msg):
        return "Video ist nicht öffentlich abrufbar (Login nötig)"
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


def _ydl_opts(outtmpl: str) -> dict:
    return {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": outtmpl,
        # m4a steht in AUDIO_EXT und spielt im Browser; YouTubes Default waere Opus-in-.webm
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
        "noplaylist": True,        # ?list=… nicht als ganze Playlist auffassen
        "quiet": True, "no_warnings": True, "noprogress": True, "retries": 3,
    }


def download_one(project: str, url: str) -> str:
    """Laedt die Tonspur nach projekte/<project>/audio/. Liefert den Basisnamen."""
    if yt_dlp is None:
        raise RuntimeError(f"yt-dlp ist nicht installiert — {_PIP_HINWEIS}")
    # Der FFmpegExtractAudio-Postprocessor laeuft im extract_info(download=True) unten und
    # sucht ffmpeg auf PATH. ensure_ffmpeg() legt den winget-Pfad dorthin — muss also HIER
    # stehen, nicht erst vor dem Whisper-Lauf in main(). Findet es nichts, lieber sofort
    # abbrechen als hinterher am kryptischen "ffprobe and ffmpeg not found" scheitern.
    if not transcribe.ensure_ffmpeg():
        raise RuntimeError("ffmpeg nicht gefunden — installiere: winget install Gyan.FFmpeg")
    adir = os.path.join(paths.project_dir(project), "audio")
    os.makedirs(adir, exist_ok=True)

    # ponytail: zwei yt-dlp-Aufrufe (Metadaten, dann Download) — kostet einen Roundtrip,
    # dafuer steht der Dateiname VOR dem Download fest und Kollisionen sind sauber loesbar.
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    plattform = "youtube" if "youtu" in (urlparse(url).hostname or "") else "instagram"
    base = unique_base(adir, safe_base(info.get("title") or "",
                                       f"{plattform}-{info.get('id') or 'video'}"))

    print(f"[fetch] lade {base} …", flush=True)
    with yt_dlp.YoutubeDL(_ydl_opts(os.path.join(adir, base + ".%(ext)s"))) as ydl:
        ydl.extract_info(url, download=True)
    print(f"[fetch] fertig {base}", flush=True)
    return base


def main(argv=None):
    try:  # Umlaute/… auch bei umgeleitetem stdout auf non-UTF-8-Windows nicht crashen
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description="URL-Import (YouTube/Instagram) fuer ein Projekt")
    ap.add_argument("project")
    ap.add_argument("urls", nargs="+")
    args = ap.parse_args(argv)
    paths.safe_name(args.project)

    geladen = []
    for url in args.urls:
        try:
            geladen.append(download_one(args.project, check_url(url)))
        except Exception as e:
            print(f"[fetch] FEHLER {url}: {_human_error(e)}", flush=True)
    print(f"[fetch] {len(geladen)} von {len(args.urls)} geladen", flush=True)
    if not geladen:
        raise SystemExit(1)      # Job-Status 'error'; Whisper wird gar nicht erst geladen

    transcribe.ensure_ffmpeg()
    transcribe.transcribe_project(args.project,
                                  os.environ.get("WHISPER_MODEL", "large-v3"),
                                  os.environ.get("WHISPER_LANG", "de"),
                                  only=geladen)


if __name__ == "__main__":
    main()
