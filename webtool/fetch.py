"""URL-Import: YouTube-/Instagram-Audio in ein Projekt laden und transkribieren.

    python -m webtool.fetch <projekt> <url> [<url> ...]

Laedt je URL die beste Tonspur als .m4a nach projekte/<projekt>/audio/ und
transkribiert anschliessend GENAU diese Dateien (transcribe.py, only=).
`cwd` muss das Repo-Root sein (wie bei webtool.correct) -> `import transcribe`.
"""
import argparse
import contextlib
import os
import re
import shutil
import sys
import unicodedata
from urllib.parse import urlparse

import transcribe

from . import druck, paths, projekt, sprachen, ytdlp_update

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

# `[default]` gehoert in den Rat hinein, nicht nur in requirements.txt: darin steckt der Pin
# auf `yt-dlp-ejs`, und wer diese Zeile ohne das Extra abtippt, hebt yt-dlp ueber die Fassung
# hinaus, zu der seine Loeserskripte passen — yt-dlp verwirft sie dann, `no_warnings` schluckt
# die Warnung, und YouTube antwortet wieder sporadisch mit 403 (#170). Der zweite Fundort
# (`yt-dlp ist nicht installiert`) waere sogar schlimmer: dort entstuende eine venv voellig
# ohne die Skripte. In Anfuehrungszeichen, weil zsh und PowerShell die eckigen Klammern sonst
# als Muster lesen.
_PIP_HINWEIS = r'.venv\Scripts\python.exe -m pip install -U "yt-dlp[default]"'
# Instagram/YouTube melden Login-Zwang in vielen Formulierungen; hier grob abgedeckt.
_LOGIN_RE = re.compile(r"login|log in|sign in|private|not available|rate.?limit|cookies|bot", re.I)
class Vorbedingung(ValueError):
    """Eigenfehler, den kein yt-dlp-Update reparieren kann (#173).

    Seit der Umkehr ist JEDER Fehlschlag Verdacht — die einzige Ausnahmeliste der
    Selbstheilung. Die bisherige Positivliste bekannter Extraktor-Formulierungen war
    geraten: EIN gemessener Fall (#162 — HTTP 403 ohne JS-Laufzeit, Messung im zugehoerigen
    PR) plus plausible yt-dlp-Meldungen, und was sie verfehlte, heilte nie — der Nutzer
    stand wieder an der Konsole, obwohl die Selbstheilung genau dafuer gebaut wurde. Ein
    falscher Verdacht kostet dagegen hoechstens ein pip pro Lauf (`geheilt` in main);
    ein verfehlter kostet die Funktion selbst. Erbt von ValueError, weil check_url sie
    wirft und app.py am Endpunkt genau `ValueError` faengt (-> 400) — erbt sie nicht,
    wird jeder URL-Fehler dort ein 500.
    """


def _importiere_yt_dlp():
    """Der eigentliche Import — eigene Funktion, damit der Test die Reihenfolge
    (erst aktualisieren, dann importieren) beobachten kann, ohne echtes pip zu starten."""
    try:
        import yt_dlp as modul
    except ImportError:        # Feature ist optional -> Server und Tests laufen trotzdem
        return None
    return modul


def _hole_yt_dlp():
    """yt-dlp beim ersten Bedarf importieren.

    **Ohne Kalenderpruefung, seit #253.** Hier stand `ytdlp_update.automatisch()` — und damit
    lag ein pip von bis zu 120 s (mit Sperrwartezeit >=340 s) zwischen „Adresse eingefuegt"
    und „Download beginnt", an der einzigen Stelle der App, an der jemand aktiv wartet. Die
    Vorsorge macht jetzt `ytdlp_update.beim_start()` am Serverstart.

    **Die Selbstheilung unten in `main()` bleibt** (`automatisch(erzwingen=True)` nach einem
    gescheiterten Download): die repariert einen Fehler, den der Nutzer gerade vor sich hat,
    und ein Extraktor bricht nicht nach Kalender.

    Folge fuer den Weg ohne Server (`python -m webtool.fetch` von Hand): dort gibt es kein
    `_lifespan`, also auch keine Kalenderpruefung mehr. Bewusst — der Weg ist der des
    Entwicklers, und die Selbstheilung greift dort weiterhin.
    """
    global yt_dlp
    if yt_dlp is None:
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
    """Sieht der Fehlschlag nach etwas aus, das ein yt-dlp-Update reparieren könnte?

    Seit #173 umgedreht: JEDER Fehlschlag ist Verdacht — eine Positivliste bekannter
    Extraktor-Formulierungen waere Ratearbeit, und was sie verfehlte, heilte nie (der
    Fehlschlag, den niemand kennt, ist der zukünftige Instagram-Bruch). Zwei Ausnahmen:

    1. `Vorbedingung` — Eigenfehler (check_url, ffmpeg, yt-dlp fehlt/aktualisiert sich gerade,
       Spracheintrag). Ein pip repariert sie nicht und startete teils ein drittes auf dieselbe
       venv (#253).
    2. Das Login-Veto — eine Meldung kann BEIDE Muster treffen ("Unable to extract nsig; use
       --cookies-from-browser"), und dann gilt der Login-Verdacht: ein Update repariert eine
       fehlende Anmeldung nie.

    Ein falscher Verdacht (Netz weg, 404, Festplatte voll) kostet **ein** pip-Lauf pro Job,
    mit fester Argumentliste und Zeitdeckel — Wartezeit, kein Hebel: der Befehl haengt an
    keiner Eingabe. Die Rohmeldung samt Urteil landet fuer genau diese Faelle im Job-Log
    (`_roh_ins_log`), damit sich die Ausnahmen an echtem Material nachpruefen lassen.
    """
    if isinstance(exc, Vorbedingung):
        return False
    return not _LOGIN_RE.search(str(exc))


def _js_runtime_pfad() -> str:
    """Pfad einer node-kompatiblen Laufzeit aus der Umgebung — oder Leerstring.

    Gesetzt von `electron/backend.js`: die gepackte App hat weder node noch deno auf dem PATH
    (#171), bringt aber selbst eine mit — Electrons Binary IST ein Node, sobald
    `ELECTRON_RUN_AS_NODE=1` in der Umgebung steht (das setzt `download_one`, siehe dort).
    Gemessen mit genau dem Aufruf, den `NodeJCP._run_js_runtime` macht (`--permission -`,
    Skript auf stdin): Node 24, sauberes JSON auf stdout, Exitcode 0.

    Die Alternative waere ein Deno-Download bei der Ersteinrichtung gewesen: derselbe Zweck
    fuer 40 MB mehr — und auf Linux, wo `setup.js:plan()` nichts selbst installiert, ein
    Handgriff, den der Nutzer von Hand machen muesste.

    **Ein blosser String genuegt nicht, die Datei muss da sein.** Drei Dinge gingen sonst auf
    einmal schief, und zwar alle drei still: `NodeJsRuntime._info()` bekommt von
    `_get_exe_version_output` ein False und meldet die Laufzeit als nicht vorhanden; yt-dlp
    sucht wegen des gesetzten `path` NICHT mehr auf dem PATH (`_determine_runtime_path` nimmt
    ihn ungeprueft) — ein echtes node, das vor diesem Fix gefunden worden waere, faellt also
    weg; und `_js_laufzeit_da()` haette den 403-Hinweis unterdrueckt, der als einziger die
    Ursache nennt. Erreichbar ist ein veralteter Wert ueber die `.env`: `settings.load_env()`
    laesst eine Zeile dort bewusst gegen eine bereits gesetzte Variable gewinnen, sie
    ueberstimmt also auch den Pfad, den backend.js gerade errechnet hat.
    """
    pfad = (os.environ.get("TRANSKRIBOR_JS_RUNTIME") or "").strip()
    return pfad if pfad and os.path.isfile(pfad) else ""


def _js_laufzeit_da() -> bool:
    """Gibt es ueberhaupt eine JS-Laufzeit? Nur fuer die FEHLERMELDUNG, nicht fuer die Optionen.

    yt-dlp sucht selbst auf dem PATH (und zusaetzlich im Scripts-Ordner) — deshalb stehen
    `deno`/`node` in `_ydl_opts` bedingungslos. Hier geht es allein darum, den 403 richtig zu
    deuten. Die mitgereichte Laufzeit zaehlt mit: sonst riete die Meldung im gepackten Lauf
    ausgerechnet dort zu einer Node-Installation, wo bereits eine benutzt wird.
    """
    return bool(_js_runtime_pfad()) or any(shutil.which(x) for x in ("deno", "node"))


@contextlib.contextmanager
def _node_modus():
    """`ELECTRON_RUN_AS_NODE=1` fuer die Dauer der yt-dlp-Aufrufe — und nur dafuer.

    Die mitgereichte Laufzeit ist Electrons eigenes Binary; ohne dieses Flag startet es das
    GUI, statt das Loeserskript zu rechnen. Gesetzt wird es HIER und nicht in `backend.js`:
    dort landete es in der Umgebung des Servers, und `jobs.py` gibt die an JEDEN Subprozess
    weiter (transcribe, correct, `claude`/`codex` samt Anmelde-Flow).

    **Und danach wieder weg**, aus demselben Grund eine Ebene tiefer: der direkte CLI-Aufruf
    transkribiert im SELBEN Prozess weiter (`main` ohne `--download-only`), und schon der
    ffmpeg-Postprocessor laeuft als Kindprozess. Eine Umgebungsvariable, die nur zwei Aufrufe
    braucht, hat danach im Prozess nichts mehr verloren. `finally`, nicht am Blockende: ein
    fehlgeschlagener Download ist der Normalfall, nicht die Ausnahme.
    """
    if not _js_runtime_pfad():
        yield
        return
    alt = os.environ.get("ELECTRON_RUN_AS_NODE")
    os.environ["ELECTRON_RUN_AS_NODE"] = "1"
    try:
        yield
    finally:
        if alt is None:
            os.environ.pop("ELECTRON_RUN_AS_NODE", None)
        else:
            os.environ["ELECTRON_RUN_AS_NODE"] = alt


# Wie viel Rohmeldung ins Protokoll geht. Der Deckel ist VORSORGE, kein beobachteter Fall:
# gemessen sind die yt-dlp-Meldungen dieses Projekts einzeilig und kurz. Er steht trotzdem,
# weil der Text aus der Fremdplattform stammt (Fehlerseite, Videotitel) und im Job-Log
# landet, das der Nutzer im Browser liest — und weil 500 Zeichen fuer den Zweck der Zeile
# (die Formulierung erkennen, an der eine weitere Ausnahme der Selbstheilung haette
# wachsen koennen) reichlich sind.
_ROH_MAX = 500


def _rohmeldung(exc: Exception) -> str:
    """Die ORIGINALmeldung, einzeilig und gedeckelt — die Messgrundlage fuer #173.

    `_human_error` glaettet auf einen von drei Saetzen und nimmt vorher nur die **letzte**
    Zeile (`roh.splitlines()[-1]`). Damit ist nach dem Protokollieren nicht mehr
    rekonstruierbar, welche Formulierung yt-dlp wirklich benutzt hat. Die Liste der
    Ausnahmen (`Vorbedingung`, `_LOGIN_RE`) ist seit #173 kurz — aber jede Meldung, die
    trotzdem einen pip-Lauf ausloest, ist ein Kandidat fuer eine weitere Ausnahme, und ohne
    Rohmeldung im Log gibt es dafuer keine Evidenz; „warten auf echte Fehlschlaege" waere
    dann ein Plan ohne Endpunkt.

    **Einzeilig**, weil `jobPhases.ts` das Protokoll zeilenweise liest und jede Zeile ohne
    `[fetch] `-Praefix in seine Datei-Regexes fiele. **Gedeckelt**, siehe `_ROH_MAX`.
    Leere Meldung -> Klassenname, sonst stuende dort gar nichts.
    """
    roh = " ".join(str(exc).split()) or exc.__class__.__name__
    if len(roh) <= _ROH_MAX:
        return roh
    # Die Marke zaehlt MIT: eine Konstante namens `_ROH_MAX`, die 502 Zeichen liefert, haelt
    # nicht, was ihr Name zusagt (CodeRabbit an PR #223).
    marke = " …"
    return roh[:_ROH_MAX - len(marke)] + marke


def _human_error(exc: Exception) -> str:
    """yt-dlp-Rauschen -> ein Satz, der Marcus sagt, was zu tun ist."""
    # Eigene Vorbedingungen kommen UNVERAENDERT durch: sie sind bereits als Satz
    # formuliert (#173) — der pip-Hinweis darunter riete zu einem Update bei einem
    # Namen, den wir selbst abgelehnt haben (K1-Glied-1-Review, Minor).
    if isinstance(exc, Vorbedingung):
        return str(exc)
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
    try:
        u = urlparse(url)
    except ValueError as e:
        # urlparse wirft bei kaputtem netloc ("https://[::1") einen NACKTEN ValueError —
        # unser Wurf, nicht yt-dlps. Ohne Wandelung waere er seit der Umkehr 'fremd'
        # (Verdacht True) und loeste auf dem CLI-Weg ein pip fuer einen Tippfehler aus;
        # der Web-Endpunkt faengt vorher mit 400 ab (Vorbedingung erbt ValueError).
        raise Vorbedingung(f"unlesbare URL: {e}") from e
    if u.scheme != "https":
        raise Vorbedingung(f"nur https-URLs werden unterstützt: {url!r}")
    if (u.hostname or "").lower() not in ALLOWED_HOSTS:
        raise Vorbedingung(f"nicht unterstützte Plattform: {u.hostname or url!r} "
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

    **Ein LEERER Wert heisst „nicht gesetzt", nicht `False` (#298).** Das ist die Bedingung
    dafuer, dass `app.py` den Schluessel unbedingt setzen kann: `jobs._run_proc` baut
    `{**os.environ, **job_env(), **env}`, und fehlt der Schluessel im expliziten `env`,
    ueberlebt eine `.env`-Zeile aus einem alten CLI-Test und schlaegt auf JEDEN
    Browser-Import durch. Mit `False` erzeugte der leere Wert stattdessen einen echten
    Datei-Override — die Falle aus #166. Eine Env-Variable kennt kein `null`, `""` ist also
    der einzige Weg, in einer Umgebung „nicht gesetzt" zu sagen; dieselbe Null-Richtung, die
    `_sprecher_aus_env` und `_sprache_aus_env` schon haben.
    """
    roh = (os.environ.get("TRANSKRIBOR_FETCH_MEHRSPRACHIG") or "").strip()
    if not roh:
        return None
    return roh.lower() in ("1", "true", "yes")


def _sprecher_aus_env(roh, i: int):
    """Die Sprecherzahl der i-ten URL aus der Komma-Liste, oder None.

    Positionsbasiert, weil die Zuordnung URL->Zahl sonst durch den Titel einer
    Video-Beschreibung laufen muesste. Stabil, weil `check_url` die Liste weder umsortiert
    noch kuerzt und `main` ueber `args.urls` iteriert — ein fehlgeschlagener Download
    verschiebt nichts, denn der Index kommt aus der Schleife, nicht aus einem Erfolgszaehler.

    Wirft NIE (#185): eine fremd gesetzte, zu kurze oder unsinnige Variable heisst
    „automatisch", nicht „Absturz im Subprozess NACH dem Download".
    """
    if not roh:
        return None
    teile = roh.split(",")
    if not 0 <= i < len(teile):
        return None
    try:
        wert = int(teile[i])
    except ValueError:
        return None
    # Bereich ueber `sprachen.pruef_fehler` — die EINE Quelle, dieselbe wie im HTTP-Weg.
    # Der Endpunkt weist einen Wert ausserhalb 1..SPRECHER_MAX mit 400 zurueck; dieser Weg
    # hat niemanden zum Anmecken (er laeuft im Subprozess, gespeist aus der Umgebung), also
    # gilt die sichere Richtung: „automatisch". Ohne die Pruefung landete eine 99 oder eine 0
    # in `projekt.json` — die Diarisierung bekaeme sie zwar nie (`projekt._sprecher_wert`
    # filtert beim LESEN, gemessen), aber der Schalter waere tot UND die Datei truege Muell.
    return None if sprachen.pruef_fehler(sprecher=wert) else wert


def _sprache_aus_env(roh, i: int):
    """Die Sprache der i-ten URL aus der Komma-Liste, oder None (= Projekt-Standard).

    Zwilling von `_sprecher_aus_env` — mit EINEM Unterschied, den man kennen muss:
    **ein einzelner Wert ohne Komma gilt fuer ALLE URLs.** Die Variable trug bisher genau
    einen Sprach-Code fuer den ganzen Auftrag; wer sie von Hand setzt, meint weiterhin das.
    `_sprecher_aus_env` entscheidet im selben Randfall entgegengesetzt (eine zu kurze Liste
    heisst dort None) — die beiden Funktionen sehen aehnlich aus und sind es hier nicht.
    Sprach-ids enthalten kein Komma (`ch/de/en/fr/it/auto`), die Trennung ist eindeutig.

    Wirft NIE (#185): ein unbekannter Wert heisst „Projekt-Standard", nicht „Absturz im
    Subprozess NACH dem Download". Gueltigkeit ueber `sprachen.pruef_fehler` — dieselbe
    Quelle wie im HTTP-Weg, damit die beiden Wege nicht auseinanderdriften.
    """
    if not roh:
        return None
    teile = roh.split(",")
    if len(teile) == 1:
        wert = teile[0]
    elif 0 <= i < len(teile):
        wert = teile[i]
    else:
        return None
    wert = wert.strip()
    if not wert:
        return None
    return None if sprachen.pruef_fehler(sprache=wert) else wert


def download_one(project: str, url: str, sprecher=None, sprache=None) -> str:
    """Laedt die Tonspur nach projekte/<project>/audio/. Liefert den Basisnamen."""
    # Namensraum-Riegel (#416), als ERSTE Vorbedingung — er steht ohne jede Wartezeit
    # fest (billiger als ffmpeg und yt-dlp darunter): der CLI-Weg legt das Projekt
    # selbst an, der Endpunkt prueft denselben Namen vorher. Vorbedingung statt
    # Rohwurf (#173): kein pip, kein Wiederholungsdownload.
    try:
        paths.sicherer_projektname(project)
    except ValueError as e:
        raise Vorbedingung(f"Projektname unzulässig: {e}") from e
    # Der FFmpegExtractAudio-Postprocessor laeuft im extract_info(download=True) unten und
    # sucht ffmpeg auf PATH. ensure_ffmpeg() legt den winget-Pfad dorthin — muss also HIER
    # stehen, nicht erst vor dem Whisper-Lauf in main(). Findet es nichts, lieber sofort
    # abbrechen als hinterher am kryptischen "ffprobe and ffmpeg not found" scheitern.
    # Steht VOR _hole_yt_dlp(): eine Vorbedingung, die ohne jede Wartezeit feststeht, gehoert
    # vor die, die es nicht tut. (Bis #253 war das dringlicher — damals konnte der Griff ein
    # pip von bis zu 120 s ausloesen; die Kalenderpruefung liegt jetzt am Serverstart.)
    if not transcribe.ensure_ffmpeg():
        raise Vorbedingung("ffmpeg nicht gefunden — installiere: winget install Gyan.FFmpeg")
    ydl_modul = _hole_yt_dlp()
    if ydl_modul is None:
        # **Das ist, was #253 NEU aufmacht.** Der Kalenderlauf liegt jetzt im Serverprozess
        # und kann laufen, waehrend hier importiert wird — faellt der Import in pips
        # Deinstallations-/Installationsluecke, ist yt-dlp fuer einen Moment weg. Vorher gab
        # es das nicht: der Import wartete das pip ja gerade ab.
        #
        # Ohne diese Abfrage saehe der Nutzer drei falsche Dinge auf einmal: eine Meldung, die
        # „nicht installiert" behauptet, obwohl gerade INSTALLIERT wird; keine Selbstheilung
        # (beide Wuerfe sind `Vorbedingung`, #173 — ein pip repariert ein laufendes pip
        # nicht, es startete nur ein zweites auf dieselbe venv); und einen Rat, der ein
        # DRITTES pip auf dieselbe venv startet.
        #
        # Gefragt wird die Sperre, nicht `_lauf`: der Lauf sitzt in einem anderen Prozess —
        # dieselbe Begruendung wie bei `zustand()["laeuft"]` (#243). `wird_gehalten` ist eine
        # Momentaufnahme und taugt nur fuer die AUSKUNFT; eine Entscheidung daraus abzuleiten
        # baute genau die Race nach, gegen die die Sperre steht.
        if ytdlp_update.laeuft_gerade():
            raise Vorbedingung("yt-dlp wird gerade aktualisiert — bitte gleich noch einmal "
                               "versuchen (der Import braucht den Downloader).")
        raise Vorbedingung(f"yt-dlp ist nicht installiert — {_PIP_HINWEIS}")
    adir = os.path.join(paths.project_dir(project), "audio")
    os.makedirs(adir, exist_ok=True)

    # ponytail: zwei yt-dlp-Aufrufe (Metadaten, dann Download) — kostet einen Roundtrip,
    # dafuer steht der Dateiname VOR dem Download fest und Kollisionen sind sauber loesbar.
    with _node_modus():
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
    # `sprache` kommt als PARAMETER, nicht mehr aus der Umgebung: sie gilt je URL, und die
    # Zuordnung URL->Sprache kennt nur `main` (ueber den Schleifenindex). Genau wie `sprecher`.
    mehr = _mehrsprachig_aus_env()
    if sprache or mehr is not None or sprecher is not None:
        # `or None`, weil `""` nicht `None` ist. Es kommt heute nur noch von einem DIREKTEN
        # Aufrufer — `_sprache_aus_env` filtert Leeres vorher weg —, der Riegel ist also die
        # Grenze dieser Funktion, nicht die des Env-Parsers. Ist gleichzeitig
        # `TRANSKRIBOR_FETCH_MEHRSPRACHIG` gesetzt, traegt der ZWEITE Konjunkt oben den
        # Aufruf — und `""` landete dann als Sprach-Eintrag in projekt.json, vorbei an
        # `pruef_fehler` (das auf diesem Weg nicht laeuft). Der Datei-Dialog legte so einen
        # Eintrag als LEEREN Waehler vor, samt „neu transkribieren", das mit 400 endete (#234).
        #
        # Vorbedingung statt Rohwurf (#173): der Eintrag laeuft NACH dem gelungenen Download.
        # Als 'fremder' Fehlschlag wuerde er seit der Umkehr pip + Wiederholung ausloesen —
        # und der Wiederholungsdownload legte die Datei per unique_base ein ZWEITES Mal ab,
        # obwohl sie schon da war.
        try:
            projekt.setze_datei(project, base, sprache=sprache or None, mehrsprachig=mehr,
                                sprecher=sprecher)
        except Exception as e:
            raise Vorbedingung(f"Spracheintrag nach dem Download fehlgeschlagen: {e}") from e
    return base


def _lade(project: str, url: str, sprecher=None, sprache=None):
    """(base, None) bei Erfolg, (None, exception) sonst — damit `main` denselben Versuch
    zweimal machen kann (einmal, und nach einer Aktualisierung noch einmal), ohne den
    try/except-Block zu verdoppeln.

    `sprecher` UND `sprache` reichen durch: BEIDE Aufrufe in `main` tragen dieselben Werte,
    sonst verloere ausgerechnet der Download seine Datei-Einstellungen, der erst nach der
    Selbstheilung klappt."""
    try:
        return download_one(project, check_url(url), sprecher, sprache), None
    except Exception as e:
        return None, e


def main(argv=None):
    try:  # Umlaute/… auch bei umgeleitetem stdout auf non-UTF-8-Windows nicht crashen
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    sys.stdout = druck.zeilenweise(sys.stdout)   # EIN write je Zeile (#344)
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
    def _roh_ins_log(fehler: Exception) -> None:
        """#173: die Rohmeldung samt Urteil. Erst beides nebeneinander beantwortet die
        offene Frage — war dieser Fehlschlag ein pip-Lauf wert, und wenn ja (oder nein),
        warum?

        **Gerufen bei JEDEM Fehlschlag, auch bei dem, der gleich geheilt wird.** Der
        Wiederholversuch ueberschreibt `fehler`; stuende die Zeile nur am Schleifenende,
        fehlte ausgerechnet die ausloesende Meldung — also genau die, an der die Liste
        nachzuziehen waere. Nebenbei laese sich das Protokoll dann widerspruechlich:
        „yt-dlp aktualisiert" direkt ueber einem `extraktor-verdacht=False`.

        Das Praefix `[fetch] ` ist Pflicht: `jobPhases.ts:54` schluckt damit die Zeile,
        sonst laese seine Datei-Regex `^\\[.+?\\] FEHLER (.+?): ` sie als Fehlschlag mit
        der URL als Basisnamen.
        """
        print(f"[fetch] roh ({type(fehler).__name__}, extraktor-verdacht="
              f"{_extraktor_verdacht(fehler)}): {_rohmeldung(fehler)}", flush=True)

    # EINMAL gelesen, nicht je URL: die Variablen aendern sich waehrend des Laufs nicht.
    sprecher_roh = os.environ.get("TRANSKRIBOR_FETCH_SPRECHER")
    sprache_roh = os.environ.get("TRANSKRIBOR_FETCH_SPRACHE")
    for i, url in enumerate(args.urls):
        # Der Index kommt aus der Schleife, nicht aus einem Erfolgszaehler — ein
        # fehlgeschlagener Download verschiebt die Zuordnung damit nicht.
        sprecher = _sprecher_aus_env(sprecher_roh, i)
        sprache = _sprache_aus_env(sprache_roh, i)
        base, fehler = _lade(args.project, url, sprecher, sprache)
        if fehler is not None:
            _roh_ins_log(fehler)
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
                # Zweite Aufrufstelle: DIESELBEN Werte wie oben. Ohne sie verlaere genau der
                # Download seine Datei-Einstellungen, der erst nach der Heilung klappt.
                base, fehler = _lade(args.project, url, sprecher, sprache)
                if fehler is not None:
                    _roh_ins_log(fehler)      # der zweite Versuch, nach der Heilung
        if fehler is not None:
            # Der Rat an den Nutzer zuletzt: er ist die Handlungsanweisung, die Rohzeilen
            # darueber sind die Belege.
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
