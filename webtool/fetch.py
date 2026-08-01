"""URL-Import: YouTube-/Instagram-Audio in ein Projekt laden und transkribieren.

    python -m webtool.fetch <projekt> <url> [<url> ...]

Laedt je URL die beste Tonspur als .m4a nach projekte/<projekt>/audio/ und
transkribiert anschliessend GENAU diese Dateien (transcribe.py, only=).
`cwd` muss das Repo-Root sein (wie bei webtool.correct) -> `import transcribe`.
"""
import os
import re
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
