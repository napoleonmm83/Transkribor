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
fragt deshalb nicht nur nach dem Datum, sondern auch danach, ob der Loeser ueberhaupt
arbeiten kann — und zwar in ZWEI Richtungen: das Paket fehlt (#179), oder es ist da, passt
aber nicht zu diesem yt-dlp (#182, ueber ein `pip install -U yt-dlp` ohne das Extra). Beides
beantwortet `_ejs_untauglich()`; dort steht auch, warum im Zweifel NICHT geflaggt wird.

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
# --- Wie der Paketname in beiden Regexes geschrieben steht -------------------
# `[-_.]+` und `IGNORECASE` sind VORSORGE, kein beobachteter Fall: gemessen steht in yt-dlps
# METADATA die kleingeschriebene Bindestrich-Form (`Requires-Dist: yt-dlp-ejs==0.8.0;
# extra == 'default'`), und `metadata.requires()` reicht die Zeile unveraendert durch. PEP 503
# normalisiert LAEUFE aus `-`, `_` und `.` auf ein einzelnes `-` und vergleicht ohne Ruecksicht auf
# Gross-/Kleinschreibung — ein anderes Build-Backend duerfte also `yt_dlp_ejs`, `yt.dlp.ejs`
# oder `YT-DLP-EJS` schreiben — und `yt__dlp..ejs` ist derselbe Projektname, deshalb `+`
# statt eines einzelnen Zeichens. Faende die Regex das nicht, fielen beide Fragen nach fail-open,
# also STILL, genau in den Fehler zurueck, gegen den sie gebaut sind.
#
# `^\s*` in BEIDEN: eine Anforderungszeile FAENGT mit dem Paketnamen an. Ungeankert las
# `search` aus `my-yt-dlp-ejs==0.9.0` brav `0.9.0` als geforderten ejs-Pin (gemessen).
#
# `(?![\w.-])` statt `\b` am Namensende. `\b` trennt nur gegen Wortzeichen und liess
# `yt-dlp-ejs-extra` und `yt-dlp-ejs.deno` als „unser Paket" durch (gemessen) — Geschwister-
# pakete, die pip statt ejs installierte, waeren damit ein Flag ohne Ende gewesen. `[deno]`
# muss dagegen durchkommen (dasselbe Paket mit Extra), deshalb steht `[` nicht in der Klasse.

# Der NAME allein, ohne Bedingung an den Specifier — die schwaechere Frage aus #184
# („verlangt yt-dlp ejs ueberhaupt?").
_EJS_NAME_RE = re.compile(r"^\s*yt[-_.]+dlp[-_.]+ejs(?![\w.-])", re.IGNORECASE)
# Derselbe Name, aber NUR mit `==`: bei `>=` waere jede Antwort geraten, und Raten kostet hier
# ein taegliches pip ohne Ende (siehe `_ejs_untauglich`).
#
# Der Anker ist hier **Tiefenstaffelung ohne eigenen roten Test** — und das ist eine bewusste
# Ausnahme von der Hausregel, keine Nachlaessigkeit: `_ejs_zeilen()` filtert vorher an
# `_EJS_NAME_RE`, ein Aufruf mit einer nicht gefilterten Zeile kommt hier also nicht an.
# Gemessen: mit beiden Ankern bleiben alle Tests gruen. Er bleibt trotzdem stehen, weil er
# etwas kann, was die Namensfilterung NICHT abdeckt — den Pin an den ZEILENANFANG binden
# statt nur an die richtige Zeile:
#   "yt-dlp-ejs@ file:///pkgs/yt-dlp-ejs==0.8.1; extra == 'default'" -> ohne Anker 0.8.1
#   "yt-dlp-ejs; extra == 'default' or yt-dlp-ejs==0.9.0"            -> ohne Anker 0.9.0
# Damit er nicht doch unbewacht bleibt, prueft ein Test die Regex DIREKT statt ueber
# `_ejs_pin()` (`test_pin_regex_bindet_an_den_zeilenanfang`).
#
# Was hier bewusst NICHT abgedeckt ist: `yt-dlp-ejs[deno]==0.9.0` und die geklammerte Form
# `yt-dlp-ejs (==0.9.0)` aelterer setuptools liefern KEINEN Pin (fail-open) — waehrend
# `_EJS_NAME_RE` sie als unser Paket zaehlt. Die Asymmetrie ist sicher (fail-open kostet
# hoechstens eine verspaetete Erkennung) und billiger als eine Regex, die beide Klammerformen
# mitfuehrt, solange yt-dlp keine davon schreibt.
_EJS_PIN_RE = re.compile(r"^\s*yt[-_.]+dlp[-_.]+ejs\s*==\s*([^\s;,()]+)", re.IGNORECASE)
# Der Umgebungsmarker derselben Zeile. `fullmatch` gegen GENAU `extra == 'default'` — alles
# andere (`extra == 'pin'`, zusaetzliches `and python_version …`) faellt nach fail-open.
# Siehe `_gilt_fuer_uns`.
_NUR_DEFAULT_RE = re.compile(r"extra\s*==\s*['\"]default['\"]", re.IGNORECASE)


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
    except Exception as e:
        # #185: `importlib.metadata` wirft nicht nur PackageNotFoundError — eine METADATA,
        # die sich nicht als UTF-8 dekodieren laesst, gibt einen UnicodeDecodeError. Diese
        # Funktion haengt an DREI HTTP-Handlern (`zustand()` in GET/PUT /api/settings und im
        # Update-Knopf) UND an `fetch._hole_yt_dlp()`, das keinen Schutz hat: ungefangen
        # waere das eine 500er-Einstellungsseite bzw. ein abgerissener URL-Import statt des
        # zugesagten best effort. Unbekannt heisst hier "nicht installiert" — und damit
        # `faellig() is False`, also KEIN pip auf Verdacht.
        # Mit Ausnahmetyp: `except Exception` faengt alles, aber die Meldung behauptet
        # "unlesbar". Ein kuenftiger AttributeError aus einem Umbau erschiene sonst als
        # falsch benannte Ursache ohne jeden Hinweis darauf, was wirklich passiert ist.
        print(f"[ytdlp] Metadaten von yt-dlp unlesbar: {type(e).__name__}: {e}", flush=True)
        return None


def _gilt_fuer_uns(zeile: str) -> bool:
    """Gilt diese Anforderungszeile fuer das, was wir installieren — `yt-dlp[default]`?

    yt-dlp fuehrt neben `default` ein `pin`-Extra (seine Sperrliste, die JEDE Abhaengigkeit
    exakt nagelt). Heute sagen beide `yt-dlp-ejs==0.8.0`, der Unterschied ist folgenlos.
    Lockert yt-dlp aber irgendwann nur `default` (`>=0.8.0,<0.9`), hat dessen Zeile kein `==`
    mehr, `_EJS_PIN_RE` ueberspringt sie — und ohne diese Pruefung naehmen wir den exakten
    Wert aus `pin`. Ein Nutzer mit dem regelkonformen 0.8.1 gaelte dann als untauglich, und
    `pip install -U yt-dlp[default]` liesse ihn dort: der Flag ginge nie weg.

    Ohne Marker ist es eine harte Abhaengigkeit und gilt fuer jede Installation.

    Der Marker muss **genau** `extra == 'default'` sein, nichts daneben. Ein
    `extra == 'default' and python_version >= "3.14"` waere sonst „gilt fuer uns", waehrend
    pip auf 3.13 weiter die alte Fassung installiert: wir laesen einen Pin, den pip nie
    erfuellt, und der Flag ginge nie weg. Marker richtig auszuwerten braeuchte
    `packaging.markers` — hier reicht der Rueckfall, weil ein nicht gelesener Pin nur den
    Kalenderweg entscheiden laesst, ein falsch gelesener aber ein taegliches pip erzeugt.
    """
    marker = zeile.partition(";")[2].strip()
    return not marker or bool(_NUR_DEFAULT_RE.fullmatch(marker))


def _ejs_zeilen() -> list[str]:
    """Die Anforderungszeilen des installierten yt-dlp, die `yt-dlp-ejs` FUER UNS betreffen.

    Der eine Ort, an dem die Metadaten gelesen und gefiltert werden — beide Fragen darueber
    (`_ejs_pin`, `_ejs_verlangt`) sollen sich denselben Namensanker und denselben
    Extra-Marker teilen, sonst driften sie auseinander.
    """
    try:
        zeilen = metadata.requires("yt-dlp") or []
        # INNERHALB des `try`: stand die Filterung darunter, lag sie hinter allen `except`-
        # Zweigen, und ein Nicht-String in `zeilen` haette `_EJS_NAME_RE.search` mit einem
        # TypeError quer durch `faellig()` bis aus `automatisch()` heraus geworfen — an der
        # Wache vorbei, die genau das verhindern soll. Konstruiert, nicht beobachtet
        # (`requires()` liefert `list[str] | None`), aber eine Zeile Einrueckung billiger als
        # ein Waechter, der weniger deckt, als er aussieht.
        return [z for z in zeilen if _EJS_NAME_RE.search(z) and _gilt_fuer_uns(z)]
    except metadata.PackageNotFoundError:
        return []
    except Exception as e:      # #185, s. `fassung()`
        # Keine Zeilen heisst: kein Pin (#182 faellt aus) und keine Anforderung (#184 sagt
        # "verlangt nicht"). Beides fail-open — der Kalenderweg entscheidet wie bisher.
        print(f"[ytdlp] Anforderungen von yt-dlp unlesbar: {type(e).__name__}: {e}", flush=True)
        return []


def _ejs_pin() -> str | None:
    """Welche ejs-Fassung verlangt das installierte yt-dlp? `None` = keine Aussage.

    yt-dlp deklariert das Extra als `yt-dlp-ejs==0.8.0; extra == 'default'` (gemessen in
    dieser venv, zweimal — einmal fuer `default`, einmal fuer `pin`). Auch das steht in den
    Metadaten auf der Platte, kostet also keinen Import.

    **Warum dieser Pin der richtige Massstab ist** (und nicht nur ein vernuenftiger Proxy):
    `vendor/_info.py` traegt den Kopf „This file is generated by
    devscripts/update_requirements.py. DO NOT MODIFY!" — **derselbe Generator** schreibt den
    Metadaten-Pin und das `VERSION`, gegen das yt-dlp spaeter prueft. Die beiden sind also
    konstruktionsbedingt gekoppelt, nicht zufaellig gleich.
    """
    for z in _ejs_zeilen():
        m = _EJS_PIN_RE.search(z)
        if m:
            return m.group(1)
    return None


def _ejs_verlangt() -> bool:
    """Verlangt das installierte yt-dlp `yt-dlp-ejs` ueberhaupt — bei BELIEBIGEM Specifier?

    Die schwaechere Schwester von `_ejs_pin()` und der Grund, warum es zwei Fragen sind
    (#184): fehlt das Paket, haengt die Antwort NICHT davon ab, ob der Specifier vergleichbar
    ist. Der naheliegende Einzeiler (`_ejs_pin() is not None`) haette die #179-Erkennung an
    die bewusst enge `==`-Regel gekoppelt — bei einem gelockerten Pin (`>=0.8.0,<0.9`) faende
    `_ejs_pin()` nichts, und ein WIRKLICH fehlendes ejs waere still nicht mehr erkannt worden.
    Still ist hier das teure Wort.

    **Die Kosten von fail-open sind hier umgekehrt zum Pin.** Bei `_ejs_pin()` heisst „nicht
    lesbar" nur „der Kalenderweg entscheidet" — hier heisst es, dass #179 fuer diese Datei
    **still ausfaellt**, bis der 14-Tage-Takt greift. Der geteilte `_gilt_fuer_uns` bringt das
    mit: eine Zeile mit zusaetzlichem Marker (`extra == 'default' and python_version >= "3.9"`)
    zaehlt hier nicht, obwohl pip ejs auf einer passenden Python-Fassung sehr wohl
    installierte. Bewusst so gelassen — yt-dlp schreibt heute einen blanken Marker, und zwei
    verschiedene Marker-Regeln fuer zwei Fragen waeren die teurere Verwechslungsquelle.
    Festgehalten in `test_weitere_marker_gelten_auch_beim_FEHLEN_nicht`.
    """
    return bool(_ejs_zeilen())


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
    # Zwei Wachen mit ZWEI verschiedenen Aufgaben — keine ersetzt die andere:
    #
    # `isdecimal()` haelt die Formen drausen, die `int()` **still akzeptiert**: `-8`, `+8`,
    # ` 8` (gemessen). `0.-8` wuerde sonst zu `(0, -8)` — ein Pin, den pip nie erfuellen
    # kann, also wieder ein Flag ohne Ende. `[^\s;,()]+` in `_EJS_PIN_RE` laesst `-` und `+`
    # durch, der Fall ist also erreichbar.
    #
    # Das `try` faengt, was `isdecimal()` NICHT zusichert. Hier stand, es garantiere ein
    # gelingendes `int()` — falsch: ab `sys.get_int_max_str_digits()` (Default 4300) wirft
    # `int()` auch bei lauter Dezimalziffern (gemessen mit 5000 Ziffern, „Exceeds the limit
    # (4300 digits)"). Und dieses Modul darf nicht werfen: `fetch._hole_yt_dlp()` hat keinen
    # Schutz, der URL-Import braeche ganz ab.
    #
    # Nebenbefund: gegen `isdigit()` unterscheidet sich `isdecimal()` nur bei hochgestellten
    # Ziffern ("8²") — und die faengt seit dem `try` ohnehin beides gleich ab. Die Wahl ist
    # hier also Absicht, kein Verhaltensunterschied; ein Test darauf waere vacuous.
    if not v or not all(t.isdecimal() for t in teile):
        return None
    try:
        return tuple(int(t) for t in teile)
    except ValueError:
        return None


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
    verwirft sie daraufhin (`yt_dlp/extractor/youtube/jsc/_builtin/ejs.py` vergleicht Major+Minor gegen
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
        # #179 fehlt — aber nur, wenn yt-dlp es ueberhaupt verlangt (#184). Sonst holt es
        # auch `pip install -U yt-dlp[default]` nicht: es warnt „does not provide the extra"
        # und endet mit **0** (gemessen mit `--dry-run` an einem erfundenen Extra).
        #
        # Dauerhaft waere der Flag dabei nur, wenn die NEUESTE installierbare Fassung das
        # Extra nicht fuehrt — liegt auf PyPI eine neuere mit `default`, hebt `-U` yt-dlp mit
        # und ejs kommt beim ersten Lauf. Erreichbar ist der Dauerfall also nur, wenn pip an
        # der alten Fassung festhaengt (Python-Version). Fuer genau diesen Nutzer verschiebt
        # #184 die #179-Erkennung vom Tagesrhythmus auf den 14-Tage-Kalenderweg — das ist die
        # Entscheidung, nicht eine Nebenwirkung: ein taegliches pip, das nichts holen kann,
        # ist teurer als eine um Tage spaetere Erkennung.
        return _ejs_verlangt()
    except Exception as e:
        # #185 — und hier geht der Rueckfall in die ANDERE Richtung als in `fassung()` und
        # `_ejs_zeilen()`. Der Zweig darueber darf flaggen (tut es seit #184 nur, wenn yt-dlp
        # ejs ueberhaupt verlangt), weil `PackageNotFoundError` eine TATSACHE ist
        # ("nicht installiert"); jede andere Ausnahme heisst nur "unbekannt",
        # und Unbekanntes flaggt dieses Modul nicht (s. Docstring). Es waere sonst der
        # teuerste Flag von allen: ob ein pip eine unlesbare METADATA ueberhaupt ersetzt,
        # ist offen — bleibt sie liegen, laeuft das taegliche pip dauerhaft weiter.
        print(f"[ytdlp] Metadaten von {_EJS} unlesbar: {type(e).__name__}: {e}", flush=True)
        return False
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
    Loeserskripte sind untauglich (#179 fehlend / #182 unpassend; dann zaehlt nur der
    Merker des Tages).

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
        # Dasselbe gilt fuer eine ejs-Fassung, die NICHT zu diesem yt-dlp passt (#182):
        # das Paket ist da, yt-dlp verwirft es trotzdem, und `no_warnings` schluckt die
        # Warnung. Beide Faelle beantwortet `_ejs_untauglich()`.
        #
        # Ein untauglicher Loeser ist keine Frage des Kalenders: pip hat hier etwas zu holen,
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
