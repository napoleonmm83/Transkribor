"""Selbstaktualisierung von yt-dlp.

`pip install -r requirements.txt` laeuft in der installierten App genau EINMAL — beim ersten
Start. `electron/setup.js:venvVollstaendig()` prueft danach nur noch, ob torch, faster_whisper,
fastapi und uvicorn importierbar sind; ist das gruen, laeuft `einrichten()` nie wieder. Ein
App-Update ersetzt die .exe, nicht die venv (die liegt in `userData` und ueberlebt bewusst).
**yt-dlp friert damit auf dem Installationstag ein** — ausgerechnet bei der Abhaengigkeit, die
kaputtgehen MUSS: ihre Extraktoren laufen YouTube und Instagram hinterher (#162).
`yt-dlp>=…` in requirements.txt schuetzt nur Neuinstallationen, Renovate nur das Repo.

**Dasselbe trifft jedes Paket, das NACH der Installation in requirements.txt dazukommt** —
`yt-dlp-ejs` (ueber `yt-dlp[default]`, #178) war der erste Fall: die Fassung ist frisch, der
Loeser hat trotzdem keine Skripte, und der Kalenderweg sieht davon nichts (#179). `faellig()`
fragt deshalb nicht nur nach dem Datum, sondern auch danach, ob das Paket ueberhaupt da ist.

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
import re
import subprocess
import sys
from importlib import metadata

from . import settings, sperre

# yt-dlp veroeffentlicht stabil etwa monatlich: kuerzer bringt selten etwas Neues, laenger
# liesse einen kaputten Extraktor monatelang kaputt. Eine Zahl, an einer Stelle.
INTERVALL_TAGE = 14
PIP_TIMEOUT = 120
MERKER = "ytdlp_geprueft"
# Das Paket mit den Loeserskripten fuer YouTubes JS-Challenge; kommt ueber `yt-dlp[default]`.
_EJS = "yt-dlp-ejs"
# Der Pin aus yt-dlps eigenen Metadaten.
# `[-_]` ist VORSORGE, kein beobachteter Fall: gemessen steht in yt-dlps METADATA die
# Bindestrich-Form (`Requires-Dist: yt-dlp-ejs==0.8.0; extra == 'default'`), und
# `metadata.requires()` reicht die Zeile unveraendert durch. Ein Build-Backend, das Namen
# nach PEP 503 normalisiert, schriebe aber `yt_dlp_ejs` — und dann faende die Regex nichts,
# `_ejs_pin()` gaebe None zurueck und die Pruefung fiele nach fail-open, also STILL, genau
# in den Fehler zurueck, gegen den sie gebaut ist. Sechs Zeichen gegen ein stummes Versagen.
# `IGNORECASE` aus demselben Grund und mit demselben Stand: PEP 503 vergleicht Paketnamen
# ohne Ruecksicht auf Gross-/Kleinschreibung, `YT-DLP-EJS` waere also gueltige Metadaten.
# Gemessen steht dort Kleinschreibung — aber falsch liegt die Regex hier immer nach derselben
# stillen Seite, und mehr Namen als das ejs-Paket kann sie dadurch nicht treffen.
# NUR `==`: bei `>=` waere jede Antwort geraten, und Raten kostet hier ein taegliches pip
# ohne Ende — siehe `_ejs_untauglich`.
_EJS_PIN_RE = re.compile(r"yt[-_]dlp[-_]ejs\s*==\s*([^\s;,()]+)", re.IGNORECASE)
# Der Umgebungsmarker derselben Zeile — `; extra == 'default'`. Siehe `_gilt_fuer_uns`.
_EXTRA_RE = re.compile(r"extra\s*==\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)


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


def _gilt_fuer_uns(zeile: str) -> bool:
    """Gilt diese Anforderungszeile fuer das, was wir installieren — `yt-dlp[default]`?

    yt-dlp fuehrt neben `default` ein `pin`-Extra (seine Sperrliste, die JEDE Abhaengigkeit
    exakt nagelt). Heute sagen beide `yt-dlp-ejs==0.8.0`, der Unterschied ist folgenlos.
    Lockert yt-dlp aber irgendwann nur `default` (`>=0.8.0,<0.9`), hat dessen Zeile kein `==`
    mehr, `_EJS_PIN_RE` ueberspringt sie — und ohne diese Pruefung naehmen wir den exakten
    Wert aus `pin`. Ein Nutzer mit dem regelkonformen 0.8.1 gaelte dann als untauglich, und
    `pip install -U yt-dlp[default]` liesse ihn dort: der Flag ginge nie weg.

    Ohne `extra`-Marker ist es eine harte Abhaengigkeit und gilt fuer jede Installation.
    """
    m = _EXTRA_RE.search(zeile)
    return m is None or m.group(1).lower() == "default"


def _ejs_pin() -> str | None:
    """Welche ejs-Fassung verlangt das installierte yt-dlp? `None` = keine Aussage.

    yt-dlp deklariert das Extra als `yt-dlp-ejs==0.8.0; extra == 'default'` (gemessen in
    dieser venv, zweimal — einmal fuer `default`, einmal fuer `pin`). Auch das steht in den
    Metadaten auf der Platte, kostet also keinen Import.
    """
    try:
        zeilen = metadata.requires("yt-dlp") or []
    except metadata.PackageNotFoundError:
        return None
    for z in zeilen:
        m = _EJS_PIN_RE.search(z)
        if m and _gilt_fuer_uns(z):
            return m.group(1)
    return None


def _release(v: str | None) -> tuple[int, ...] | None:
    """'0.8.0' -> (0, 8, 0). `None`, sobald es keine reine Zahlenfolge ist.

    Der Rueckfall auf None ist der eigentliche Zweck. PEP 440 laesst Formen zu, deren Text
    mit einer installierten Fassung **nie** uebereinstimmen kann — `==0.8.*` (Praefix),
    `===0.8.0` (willkuerliche Gleichheit, die Regex faengt daraus `=0.8.0`), dazu alles mit
    `.post1`/`rc1`. Ein Zeichenkettenvergleich waere dort dauerhaft ungleich: `faellig()`
    jeden Tag True und ein pip, das den Flag NIE loescht — pip haelt `==0.8.*` mit 0.8.0
    naemlich fuer erfuellt. Gemessen an der echten Regex, alle drei Formen.
    """
    teile = (v or "").split(".")
    # `isdecimal()`, NICHT `isdigit()`: letzteres sagt bei hochgestellten Ziffern ja ("8²"),
    # `int()` wirft dort aber — und dieses Modul darf nirgends werfen (`_hole_yt_dlp` hat
    # keinen Schutz, ein URL-Import braeche ganz ab statt best effort weiterzulaufen).
    if not v or not all(t.isdecimal() for t in teile):
        return None
    return tuple(int(t) for t in teile)


def _fuellen(t: tuple[int, ...], n: int) -> tuple[int, ...]:
    """Mit Nullen auf n Stellen bringen — `0.8` und `0.8.0` sind dieselbe Fassung."""
    return t + (0,) * (n - len(t))


def _ejs_untauglich() -> bool:
    """Kann der Loeser mit dem, was hier installiert ist, ueberhaupt arbeiten?

    Zwei Arten von Nein, und die zweite sieht man dem Paketordner nicht an:
    - es ist **gar nicht da** (#179 — `yt-dlp[default]` kam erst mit #178 dazu), oder
    - es ist da, aber in einer Fassung, die **nicht zu diesem yt-dlp passt** (#182).

    Der zweite Fall entsteht durch ein `pip install -U yt-dlp` **ohne** das Extra: pip hat
    dann keine Anforderung an ejs, hebt yt-dlp und laesst die Skripte stehen. yt-dlp
    verwirft sie daraufhin (`jsc/_builtin/ejs.py` vergleicht Major+Minor gegen
    `vendor/_info.py:VERSION` und danach die Hashes) — und die Warnung darueber schluckt
    `no_warnings` in `fetch.py`. Sichtbar wird davon nur der sporadische 403.

    Wie `fassung()` von der PLATTE gelesen, nicht importiert — aus demselben Grund: ein
    geladenes Modul laege beim pip-Lauf danach schon im Speicher.

    **Im Zweifel NICHT flaggen.** Ein faelschlich gesetztes True liefe in ein pip, das den
    Zustand nicht aendert — also jeden Tag aufs Neue, dauerhaft. Die Tagesbremse aus #179
    deckelt das, sie beendet es nicht. Deshalb gilt „untauglich" nur bei einem Pin, der
    wirklich dasteht, wirklich `==` sagt und sich wirklich vergleichen laesst; alles andere
    (kein Pin, `>=`, `==0.8.*`, `===0.8.0`, `.post1`) laesst den Kalenderweg entscheiden wie
    bisher. Siehe `_release` — dort steht, warum gerade diese Formen gefaehrlich sind.

    Verglichen werden **aufgefuellte Zahlenfolgen**, nicht Zeichenketten: `0.8` und `0.8.0`
    sind dieselbe Fassung, als Text aber verschieden — ein Textvergleich haette genau den
    Dauerlauf erzeugt, den der Absatz darueber ausschliesst.

    Der Vergleich ist damit **auf die volle Fassung** genau, strenger als yt-dlps
    Versionsgatter (das nur Major+Minor prueft): ein Unterschied in der dritten Stelle kommt
    dort durch, faellt aber danach durch die Hash-Pruefung. Strenger zu sein kostet hoechstens
    EIN pip, das die Fassungen ausrichtet — laxer zu sein liesse genau den Fall stehen, um den
    es hier geht.
    """
    try:
        da = metadata.version(_EJS)
    except metadata.PackageNotFoundError:
        return True                       # #179: gar nicht da
    gefordert, installiert = _release(_ejs_pin()), _release(da)
    if gefordert is None or installiert is None:
        return False                      # nicht vergleichbar -> Kalenderweg entscheidet
    n = max(len(gefordert), len(installiert))
    return _fuellen(gefordert, n) != _fuellen(installiert, n)   # #182: da, aber unpassend


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
    """Fassung aelter als INTERVALL_TAGE **und** letzte Pruefung laenger her — ODER die
    Loeserskripte fehlen ganz (#179, dann zaehlt nur der Merker des Tages).

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
    g = geprueft()
    if _ejs_untauglich():
        # #179: `yt-dlp[default]` kam erst mit #178 in die requirements.txt, und die liest
        # eine installierte App nie wieder (`setup.js:venvVollstaendig()` winkt die venv
        # durch, ein App-Update ersetzt die .exe, nicht die venv). Am Kalender gemessen
        # faellt das nie auf: die Fassung kann taufrisch sein, der Loeser hat trotzdem keine
        # Skripte — also der Stand vor #170, samt demselben sporadischen 403.
        #
        # Ein FEHLENDES Paket ist keine Frage des Kalenders: pip hat hier etwas zu holen,
        # der 14-Tage-Takt waere die falsche Bremse. Ganz ohne Bremse zahlte dafuer ein
        # Rechner ohne Netz den pip-Fehlschlag bei JEDEM Import — deshalb greift der Merker
        # auf TAGES-, nicht auf Intervallbasis.
        return g is None or g < heute
    d = _als_datum(v)
    if d is not None and (heute - d).days < INTERVALL_TAGE:
        return False
    return g is None or (heute - g).days >= INTERVALL_TAGE


def _merken() -> None:
    """Merker setzen — AUCH nach einem Fehlschlag, sonst liefe der naechste Import in
    denselben Timeout. Buchhaltung, kein Ergebnis: scheitert das Schreiben (schreibgeschuetztes
    Profil), darf es den Aufrufer nicht mitreissen."""
    try:
        settings.save({MERKER: _heute().isoformat()})
    except OSError as e:
        print(f"[ytdlp] Merker nicht schreibbar: {e}", flush=True)


# `[default]` ist Pflicht, nicht Kosmetik: darin steckt `yt-dlp-ejs==0.8.0`, das Paket mit den
# Loeserskripten fuer YouTubes JS-Challenge (#170). pip merkt sich Extras NICHT — ein blosses
# `pip install -U yt-dlp` haette yt-dlp gehoben und das Skript-Paket auf der alten Fassung
# stehenlassen. Genau die Kombination verwirft yt-dlp dann (es prueft Fassung UND Hash gegen
# sein `vendor/_info.py`), und zwar mit einer Warnung, die `no_warnings` in fetch.py schluckt:
# die Selbstaktualisierung haette den URL-Import STILL wieder auf den Stand vor #170 gesetzt —
# dieselbe Sorte Fehler, gegen die dieses Modul gebaut wurde.
_PAKET = "yt-dlp[default]"


def aktualisiere() -> bool:
    """`pip install -U yt-dlp[default]`, bedingungslos. True, wenn pip sauber durchlief.

    NUR yt-dlp: ein `-U` ueber alle requirements erwischt irgendwann torch, und die GPU
    waere still weg (dieselbe Falle wie beim CPU-Rad in setup.js).
    """
    cmd = [sys.executable, "-m", "pip", "install", "-U",
           # Kurze Deckel: ohne sie haengt pip offline minutenlang, und der Import wartet mit.
           "--retries", "1", "--timeout", "10", _PAKET]
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
