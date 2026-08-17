"""Selbstaktualisierung von yt-dlp.

`pip install -r requirements.txt` laeuft in der installierten App im Regelfall genau EINMAL —
beim ersten Start. Ein App-Update ersetzt die .exe, nicht die venv (die liegt in `userData` und
ueberlebt bewusst). Seit #181 vergleicht `electron/setup.js` zusaetzlich einen Hash der
requirements.txt und bietet einen Nachlauf an — der aendert hier aber nichts: er laeuft nur auf
KLICK auf der Einrichtungsseite, und die zeigt nur die Electron-Huelle. Wer ueber `webtool.ps1`
oder direkt `uvicorn` startet, sieht ihn nie; eine von Hand verwaltete venv aktualisiert er
ohnehin nur, wenn ihr Besitzer es anstoesst.
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

Drei Wege hier hinein:
- `beim_start()` — der Kalenderweg, gerufen aus `app._lifespan` beim Serverstart. Bis #253
  hing er an `fetch._hole_yt_dlp()` und lief vor jedem URL-Import; dort wartete der Nutzer
  bis zu 120 s auf pip, nachdem er gerade eine Adresse eingefuegt hatte.
  **Er feuert einmal pro PROZESS.** Aus „alle 14 Tage" ist damit „bei jedem Start, sofern
  faellig" geworden — ein Server, der wochenlang durchlaeuft (`webtool.ps1`, ein
  Entwickler-uvicorn, eine offen stehende App), holt die Auffrischung NICHT nach. Fuer die
  gepackte App folgenlos (sie wird geschlossen und wieder geoeffnet); wer das aendern will,
  legt in `_im_hintergrund` einen Nachlauf ab, nicht hier.
- `automatisch(erzwingen=True)` — die Selbstheilung, gerufen wenn ein Download so
  abgebrochen ist, wie es ein veralteter Extraktor tut. **Der einzige Weg, der noch aus
  `fetch.py` kommt.**
- `starte_hintergrund()` — der Knopf „Jetzt aktualisieren", bedingungslos.

`automatisch()` **ohne** `erzwingen` hat seit #253 keinen Produktivaufrufer mehr; die
Funktion bleibt, weil `beim_start()` dieselben zwei Tore aus derselben Quelle braucht und
eine Aufteilung sie verdoppelte.

Beide sind **best effort**: scheitert pip (offline, PyPI zickt), wird das protokolliert und
der Aufrufer macht mit der vorhandenen Fassung weiter. Ein Rechner ohne Netz darf durch
dieses Feature nicht schlechter dastehen als vorher.
"""
import contextlib
import datetime as dt
import hashlib
import os
import re
import subprocess
import sys
import threading
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
# Das Extra, das wir installieren — EINE Quelle fuer beide Seiten: das Kommando an pip und die
# Frage an den Marker. Zwei Literale muessten sonst dasselbe Wort sagen, ohne dass etwas es prueft.
_UNSER_EXTRA = "default"

# Der Umgebungsmarker derselben Zeile — der RUECKFALL: wenn `packaging` fehlt ODER den Marker
# nicht versteht (der haeufigere Fall). `fullmatch` gegen GENAU `extra == 'default'`; alles
# andere faellt dann nach fail-open. Siehe `_gilt_fuer_uns`.
_NUR_DEFAULT_RE = re.compile(r"extra\s*==\s*['\"]default['\"]", re.IGNORECASE)

# `packaging` steht seit #187 in der requirements.txt (vorher kam es nur zufaellig ueber
# onnxruntime herein). Trotzdem abgesichert importiert, und mit `Exception` statt `ImportError`:
# dieses Modul darf NIRGENDS werfen — `fetch._hole_yt_dlp()` hat keinen Schutz (#185), ein
# Fehler beim Import zerlegte den ganzen URL-Import. Fehlt es, gilt die strikte Regel von vorher.
try:
    from packaging.markers import Marker as _Marker
except Exception:                                          # pragma: no cover - siehe _ohne_packaging
    _Marker = None


def _heute() -> dt.date:
    """Eigene Funktion, damit Tests das Datum setzen koennen, ohne die Uhr zu faelschen."""
    return dt.date.today()


def fassung() -> str | None:
    """Installierte Fassung — aus den Metadaten auf der Platte, OHNE yt-dlp zu importieren.

    Das ist der Angelpunkt: pip tauscht Dateien aus, ein bereits importiertes Modul laege
    schon im Speicher. Erst lesen, dann aktualisieren, dann importieren.

    **Fuer Tests:** `zustand()` geht NICHT hierdurch, sondern direkt ueber
    `_fassung_und_lesbarkeit()` — es braucht zwei Auskuenfte statt einer. Wer diese Funktion
    patcht, aendert die Einstellungsseite also nicht.
    """
    return _fassung_und_lesbarkeit()[0]


def _fassung_und_lesbarkeit() -> tuple[str | None, bool]:
    """`(Fassung, unlesbar)`. `(None, False)` = wirklich nicht installiert, `(None, True)` =
    die Metadaten liessen sich nicht lesen.

    `fassung()` wirft die Unterscheidung weg, und fuer die ENTSCHEIDUNG ist das richtig: kein
    pip auf Verdacht, in beiden Faellen. Fuer die AUSKUNFT ist es falsch — die
    Einstellungsseite hat nur zwei Zweige und schrieb "Nicht installiert — der Import von
    Video-URLs steht damit nicht zur Verfuegung", waehrend yt-dlp lief und laden konnte
    (#189). Die Anzeige darf nicht luegen; dieselbe Regel wie beim `asr`-Feld in
    `device.describe()`.

    Der zweite Wert gilt fuer die METADATA von **yt-dlp**, nicht nur fuer deren Versionszeile:
    `_ejs_zeilen()` liest dieselbe Distribution (`metadata.requires("yt-dlp")`) und faellt bei
    derselben kaputten Datei auf "unbekannt" — fuer diese beiden ist der stille Zustand EINER,
    ein Signal reicht. Gemessen an einer praeparierten dist-info: nicht dekodierbare METADATA
    ⇒ beide werfen denselben UnicodeDecodeError, `import yt_dlp` laeuft trotzdem.

    **NICHT gedeckt ist `_ejs_untauglich()`**: es liest eine ANDERE Distribution
    (`metadata.version("yt-dlp-ejs")`) und hat seit #185 einen eigenen stillen Rueckfall
    (unlesbar ⇒ `False` ⇒ nicht faellig). Das war die zweite Haelfte von #189; sie hat seit
    #198 ein EIGENES Signal (`_ejs_untauglich_und_lesbarkeit()` → `zustand()["ejs_unlesbar"]`)
    und wird hier weiterhin nicht mitbehauptet — zwei Distributionen, zwei Auskuenfte.
    """
    try:
        v = metadata.version("yt-dlp")
        # `version()` WIRFT NICHT IMMER: an einer dist-info ohne (lesbare) METADATA gibt es
        # `None` zurueck — gemessen an einer praeparierten dist-info ohne METADATA und an
        # einer mit METADATA ohne `Version:`-Kopfzeile, beide Male ohne Ausnahme. Erreichbar
        # nach einem abgebrochenen `pip install -U yt-dlp[default]`, also nach genau dem
        # Lauf, den dieses Modul selbst anstoesst: `yt_dlp/` liegt importierbar da, die
        # Metadaten sind Schrott. Im `try` heisst `None` deshalb "gefunden, aber unlesbar" —
        # wirklich nicht installiert wirft PackageNotFoundError.
        return (v, False) if v else (None, True)
    except metadata.PackageNotFoundError:
        return None, False
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
        return None, True


def _gilt_fuer_uns(zeile: str) -> bool:
    """Gilt diese Anforderungszeile fuer das, was wir installieren — `yt-dlp[default]`?

    yt-dlp fuehrt neben `default` ein `pin`-Extra (seine Sperrliste, die JEDE Abhaengigkeit
    exakt nagelt). Heute sagen beide `yt-dlp-ejs==0.8.0`, der Unterschied ist folgenlos.
    Lockert yt-dlp aber irgendwann nur `default` (`>=0.8.0,<0.9`), hat dessen Zeile kein `==`
    mehr, `_EJS_PIN_RE` ueberspringt sie — und ohne diese Pruefung naehmen wir den exakten
    Wert aus `pin`. Ein Nutzer mit dem regelkonformen 0.8.1 gaelte dann als untauglich, und
    `pip install -U yt-dlp[default]` liesse ihn dort: der Flag ginge nie weg.

    Ohne Marker ist es eine harte Abhaengigkeit und gilt fuer jede Installation.

    Der Marker wird seit #187 **ausgewertet** (`packaging.markers`), nicht mehr mit einer
    Zeichenkette verglichen. Vorher galt nur exakt `extra == 'default'`; ein
    `extra == 'default' and python_version >= "3.9"` fiel nach fail-open — obwohl pip das
    Paket auf jedem unterstuetzten Python sehr wohl installiert. Folge waren zwei STILLE
    Ausfaelle (`_ejs_pin()` -> None, `_ejs_verlangt()` -> False) bis zum 14-Tage-Kalender.

    Gefragt wird gegen `extra="default"` — genau das, was wir installieren (`yt-dlp[default]`);
    `python_version` und die uebrigen Variablen kommen vom laufenden Interpreter. Damit gilt
    ein *erfuellter* Zusatzmarker, ein *unerfuellter* nicht: `extra == 'default' and
    python_version >= "3.99"` heisst, dass pip hier eine andere Fassung installiert, und ein
    Pin, den pip nie erfuellt, erzeugte ein taegliches pip ohne Ende.

    Ohne `packaging` (oder bei einem Marker, den es nicht versteht) bleibt die alte, strikte
    Regel. Die Richtung ist dieselbe wie vorher: ein nicht gelesener Pin laesst nur den
    Kalenderweg entscheiden, ein falsch gelesener erzeugt taegliches pip.
    """
    marker = zeile.partition(";")[2].strip()
    if not marker:
        return True
    if _Marker is not None:
        try:
            return bool(_Marker(marker).evaluate({"extra": _UNSER_EXTRA}))
        except Exception as e:
            # `except Exception` ist die noetige Weite, nicht Bequemlichkeit: `extras == "x"`
            # und `dependency_groups == "x"` sind GUELTIGE Marker-Variablen, im Kontext
            # "metadata" aber nicht gesetzt — packaging wirft dort einen blanken `KeyError`
            # (gemessen, 26.2). Ein `except InvalidMarker` faenge sie NICHT, und dieses Modul
            # darf nirgends werfen (#185).
            #
            # Gemeldet wird es, weil es die Nachricht "unser Lesen der yt-dlp-Metadaten passt
            # nicht mehr zur Wirklichkeit" ist — genau die Klasse, fuer die #179/#182/#184
            # gebaut wurden. Still faellt sie sonst bis zum 14-Tage-Kalender durch. Kein
            # Log-Regen: `_ejs_zeilen` filtert vorher auf den Paketnamen, hier kommen
            # hoechstens die zwei ejs-Zeilen an.
            print(f"[ytdlp] Marker unlesbar ({marker!r}): {type(e).__name__}: {e}", flush=True)
    return bool(_NUR_DEFAULT_RE.fullmatch(marker))


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
    **still ausfaellt**, bis der 14-Tage-Takt greift. Genau daran hing #187: eine Zeile mit
    zusaetzlichem, aber ERFUELLTEM Marker (`extra == 'default' and python_version >= "3.9"`)
    zaehlte hier frueher nicht, obwohl pip ejs sehr wohl installiert. Seit der Marker
    ausgewertet wird, zaehlt sie — und ein UNerfuellter weiterhin nicht. Beide Richtungen
    festgehalten in `test_erfuellter_zusatzmarker_macht_auch_das_FEHLEN_faellig` und
    `test_unerfuellter_zusatzmarker_macht_das_FEHLEN_nicht_faellig`.
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
    """Kann der Loeser mit dem, was hier installiert ist, ueberhaupt arbeiten? Die
    ENTSCHEIDUNG allein — die Auskunft daneben liefert `_ejs_untauglich_und_lesbarkeit()`.

    Bleibt der Einstieg fuer `faellig()`, damit die Frage im Code so heisst, wie sie gestellt
    wird; dieselbe Aufteilung wie `fassung()` / `_fassung_und_lesbarkeit()` eine Ebene hoeher.
    """
    return _ejs_untauglich_und_lesbarkeit()[0]


def _ejs_untauglich_und_lesbarkeit() -> tuple[bool, bool]:
    """`(untauglich, unlesbar)`. Kann der Loeser mit dem, was hier installiert ist,
    ueberhaupt arbeiten?

    **Der zweite Wert ist #198.** Der stille Rueckfall unten (`unlesbar ⇒ False`) ist
    richtig und bleibt — aber er schaltet die Erkennung aus #179/#182 ab, und bis hierher
    konnte das niemand melden: `zustand()` sagte "alles in Ordnung" (`version` da,
    `unlesbar: false`), waehrend der URL-Import auf dem Stand vor #170 stand. Die
    ENTSCHEIDUNG bleibt unveraendert, nur die AUSKUNFT wird davon getrennt — dieselbe
    Trennung wie bei `_fassung_und_lesbarkeit()` (#189), und aus demselben Grund: die
    Anzeige darf nicht luegen.

    `unlesbar` gilt NUR fuer die Metadaten von `yt-dlp-ejs`. "Nicht installiert"
    (`PackageNotFoundError`) ist keine Unlesbarkeit, sondern eine Tatsache — die flaggt der
    Zweig unten von sich aus, dort ist nichts stillzulegen.

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
        return _ejs_verlangt(), False
    except Exception as e:
        # #185 — und hier geht der Rueckfall in die ANDERE Richtung als in `fassung()` und
        # `_ejs_zeilen()`. Der Zweig darueber darf flaggen (tut es seit #184 nur, wenn yt-dlp
        # ejs ueberhaupt verlangt), weil `PackageNotFoundError` eine TATSACHE ist
        # ("nicht installiert"); jede andere Ausnahme heisst nur "unbekannt",
        # und Unbekanntes flaggt dieses Modul nicht (s. Docstring). Es waere sonst der
        # teuerste Flag von allen: ob ein pip eine unlesbare METADATA ueberhaupt ersetzt,
        # ist offen — bleibt sie liegen, laeuft das taegliche pip dauerhaft weiter.
        print(f"[ytdlp] Metadaten von {_EJS} unlesbar: {type(e).__name__}: {e}", flush=True)
        return False, True
    gefordert, installiert = _release(_ejs_pin()), _release(da)
    if gefordert is None or installiert is None:
        # Nicht vergleichbar -> Kalenderweg entscheidet. **Kein `unlesbar`**: die Metadaten
        # LIESSEN sich lesen, sie sagen nur nichts Vergleichbares (kein Pin, `>=`, `==0.8.*`).
        # Das ist der dokumentierte Normalfall aus `_release`, kein Schaden — ein Hinweis
        # darauf waere ein Daueralarm bei jedem Nutzer mit gelockertem Pin.
        return False, False
    n = max(len(gefordert), len(installiert))
    return _fuellen(gefordert, n) != _fuellen(installiert, n), False   # #182: da, unpassend


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
    if v is None and _pip_unterbrochen():
        # #257/#258: ein pip-Lauf hat keinen Erfolg gemeldet, UND es gibt keine lesbare
        # Fassung mehr. Genau das hinterlaesst ein abgewuergtes pip — Windows
        # `taskkill /F /T` auf den Prozessbaum beim Schliessen der App, POSIX
        # `jobs.cancel_all()` → SIGKILL auf die Prozessgruppe des fetch-Jobs. Gemessen an
        # einer Wegwerf-venv: `metadata.version` wirft danach PackageNotFoundError, waehrend
        # die Paketdateien noch daliegen und `import yt_dlp` mit ModuleNotFoundError bricht.
        #
        # **Beide Haelften sind noetig.** Der Merker allein feuerte auch nach einem ganz
        # normalen Fehlschlag (offline) — eine Reparatur fuer einen Schaden, den es nicht
        # gibt. `fassung() is None` allein ist der Riegel eine Zeile tiefer, und der ist
        # richtig: ohne Merker heisst „keine Fassung" wirklich „nie installiert, Sache des
        # Setups".
        #
        # **Dass die beiden zusammen „WIR haben es zerlegt" heissen, traegt aber erst durch
        # die dritte Bedingung in `aktualisiere()`:** der Merker entsteht nur, wenn vor dem
        # Lauf eine Fassung da war. Ohne sie war die Aussage hier schlicht falsch — ein
        # gescheitertes pip auf einer Maschine ohne yt-dlp erfuellt sonst beide Haelften.
        # (Reviewbefund M1, mit gefaelschtem pip gemessen.)
        #
        # **Was das NICHT trennt:** `fassung()` gibt auch bei unlesbarer METADATA `None`
        # (#189), und fuer diesen Zustand ist gemessen, dass pip SELBST mit Exit 2 scheitert
        # (#198) — die Reparatur kann dort also nicht greifen. Bewusst nicht getrennt: der
        # Fall ist in fuenf Kill-Messungen nicht aufgetreten (alle lieferten
        # PackageNotFoundError), und die Kosten sind durch die Frist gedeckelt — hoechstens
        # 14 Tage lang je ein schnell scheiternder Hintergrundlauf. Eine Trennung kostete
        # einen zweiten Metadaten-Zugriff und einen Zweig auf dem selteneren Pfad.
        #
        # **VOR dem Riegel darunter**, denn genau der hielt die Reparatur bisher auf. Ein
        # Test haelt die Reihenfolge fest.
        #
        # **Keine Tagesbremse.** Sie waere hier schaedlich: lief heute schon ein regulaeres
        # pip durch (`geprueft` = heute) und wurde DANACH eines abgewuergt — das ist #258s
        # Ablauf —, verschoebe sie die Reparatur auf morgen, also einen ganzen Tag ohne
        # URL-Import. Gedeckelt ist der Fall stattdessen am Merker selbst: ein gelungener
        # Lauf loescht ihn, und `_pip_unterbrochen()` laesst ihn nach INTERVALL_TAGE
        # verfallen — fuer den Fall, dass `os.remove` ihn dauerhaft nicht wegbekommt.
        return True
    if v is None:
        # `pip install -U` wuerde yt-dlp hier NEU installieren. Das ist Sache des Setups;
        # der Import meldet dann ehrlich "yt-dlp ist nicht installiert".
        return False
    heute = _heute()
    g = geprueft()
    if _ejs_untauglich():
        # #179: `yt-dlp[default]` kam erst mit #178 in die requirements.txt. Die Datei wird
        # seit #181 zwar bei jeder Statuspruefung GELESEN (Hashvergleich), INSTALLIERT wird
        # daraus aber erst nach einem Klick auf der Einrichtungsseite. Am Kalender gemessen
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
# Aus `_UNSER_EXTRA` zusammengesetzt, nicht danebengeschrieben: die Frage an den Marker
# (`evaluate({"extra": _UNSER_EXTRA})`) und das Kommando an pip muessen dasselbe Extra meinen.
_PAKET = f"yt-dlp[{_UNSER_EXTRA}]"


def _lockziel() -> str:
    """Der Pfad, um den die pip-Sperre liegt. EIN Ausdruck: `aktualisiere()` NIMMT sie,
    `zustand()` FRAGT sie ab (#243) — zwei Literale liefen beim naechsten Umbau auseinander,
    und die Anzeige saehe dann dauerhaft ein Lock, das niemand haelt (oder keines, obwohl
    eines liegt)."""
    return settings.path() + ".ytdlp"


def _lock_stale() -> float:
    """Die Zusage ueber die Haltedauer der pip-Sperre (#207) — eine Funktion, weil
    `sperre.frist()` selbst eine ist und eine Modulkonstante sie beim Import einfrieren
    wuerde.

    Die Frist muss die WIRKLICHE Haltedauer decken, nicht nur den pip-Lauf: das `_merken()`
    in `aktualisiere()` nimmt INNERHALB dieser Sperre das settings-Lock und wartet darauf
    schlimmstenfalls dessen volle `sperre.frist()`. Mit `PIP_TIMEOUT + 30` stand eine
    Haltedauer von bis zu 185 s gegen eine Frist von 155 s — ein Warter uebernahm die Sperre
    also, waehrend pip noch lief, und genau die zwei gleichzeitigen `pip install` auf
    dieselbe venv sind der Schaden, gegen den sie gebaut ist. Die 30 s bleiben der Zuschlag
    fuer `subprocess.run`s Nach-Kill-`communicate()`, das auf Windows ohne Frist laeuft.
    Preis: ein Lock OHNE Auskunft (fremder Rechner, unschreibbarer Merker) gilt entsprechend
    spaeter als verwaist — ein toter lokaler Halter wird weiterhin sofort erkannt, die Uhr
    ist nur der Rueckfall.
    """
    return PIP_TIMEOUT + 30 + sperre.frist()


def _venv_kennung() -> str:
    """Eine kurze, stabile Kennung DIESER Umgebung.

    Der Merker unten haengt an `settings.path()` — und das ist pro NUTZER, nicht pro venv:
    `settings.path()` kennt keinen Zweig fuer die gepackte App, und `electron/backend.js`
    setzt `TRANSKRIBOR_SETTINGS` nicht (nachgeprueft). Der SCHADEN ist aber pro venv, denn
    `aktualisiere()` ruft `sys.executable -m pip`. Ohne diese Kennung reparierte der
    Entwicklerserver seine Repo-venv fuer einen Schaden in der App-venv — und verbrauchte
    dabei den Merker, den die App noch braucht (dieselbe Zwei-Prozess-Lage wie #254).

    `hashlib`, nicht `hash()`: das ist pro Prozess gesalzen (PYTHONHASHSEED) und liefe beim
    naechsten Start auf einen anderen Namen. `normcase` + `abspath`, weil Windows-Pfade
    gross-/kleinschreibungsblind sind. Was das NICHT deckt: dieselbe venv ueber einen Symlink
    oder eine Netzfreigabe erreicht ergibt zwei Kennungen — die Folge ist eine verpasste
    Reparatur, kein Schaden.
    """
    roh = os.path.normcase(os.path.abspath(sys.prefix)).encode("utf-8", "replace")
    # `blake2b`, nicht `sha1`: letzteres geht durch OpenSSL und wirft unter einem
    # FIPS-erzwingenden Provider einen `ValueError` — und dieses Modul darf nirgends werfen
    # (#185; `_pip_merker_setzen` faengt nur `OSError`, der Wurf verliesse `aktualisiere()`
    # und landete in `fetch.py`, das keinen Schutz hat). blake2b kommt aus CPythons eigenem
    # `_blake2` und kennt keinen Provider. Gelesen, nicht gemessen — hier steht kein
    # FIPS-Rechner; die Zeile kostet nichts, der Wurf koennte den URL-Import abreissen.
    return hashlib.blake2b(roh, digest_size=4).hexdigest()


def _pip_merker() -> str:
    """Der Pfad des Merkers „ein pip-Lauf hat begonnen und ist nie sauber geendet"
    (#257/#258).

    **NEBEN der Sperre, nicht darin.** Das Lock-Verzeichnis raeumt der naechste Erwerber weg —
    genau das darf diesem Merker nicht passieren, sein Ueberleben IST seine Aufgabe. Eine
    Datei IM Lock waere zusaetzlich ein Fehler mit Ansage: `sperre._wegraeumen` bekommt ein
    nicht leeres Verzeichnis nicht per `os.rmdir` weg, `datei()` faellt dann nach
    `frist(stale)` offen — an echtem `sperre.py` gemessen 220 s Wartezeit bei jedem Lauf und
    danach pip OHNE Sperre.

    **Eine Datei statt eines Schluessels in `settings.json`**, aus zwei Gruenden: sie kann eine
    venv-Kennung im Namen tragen (siehe oben), und das Setzen liegt INNERHALB der pip-Sperre —
    ein `settings.save()` dort waere eine zweite verschachtelte Sperre und zwaenge
    `_lock_stale()` um eine weitere `sperre.frist()` nach oben (215 s -> 280 s, die Rechnung
    aus #207). Ein einfacher Dateischreibvorgang nimmt keine Sperre. (Der dritte, naheliegende
    Grund — „ein neuer DEFAULTS-Schluessel schluege in die API durch" — ist NACHGEPRUEFT
    FALSCH: `settings.public()` und `app._settings_body()` haben feste Feldlisten. Er steht
    hier, damit ihn niemand ein zweites Mal erfindet.)
    """
    return f"{_lockziel()}.{_venv_kennung()}.abbruch"


def _merker_datum() -> dt.date | None:
    """Das Datum im Merker, oder None (kein Merker, unlesbar, oder in der ZUKUNFT).

    Ein Zukunftsdatum (vorgehende Rechneruhr) gilt als keines — dieselbe Richtung wie in
    `geprueft()`. Es MUSS hier herausfallen und nicht erst in `_pip_unterbrochen()`: sonst
    liesse es sich weder auswerten noch ueberschreiben (`_pip_merker_setzen` schont einen
    datierten Merker) und schaltete die Erkennung dauerhaft still ab.
    """
    # **`O_NONBLOCK` wie in `sperre._merker_lesen` (#200), und aus demselben Grund.** Liegt am
    # Merker-Pfad ein FIFO, wartet ein normales `open()` auf einen Schreiber, der nie kommt —
    # ohne Frist. Hier waere das eine Stufe schlimmer als bei #200: der Aufrufer ist ueber
    # `faellig()` -> `beim_start()` der Lifespan VOR dem `yield`, dessen `except Exception`
    # keinen Haenger faengt — der Server kaeme gar nicht hoch, ohne Fehlerseite und ohne Log.
    # In WSL/ext4 gemessen: blankes `open()` kehrt binnen 3 s nicht zurueck, mit dem Flag
    # sofort. Was OFFEN bleibt, ist dasselbe wie dort: eine regulaere Datei auf einer nicht
    # erreichbaren Netzfreigabe (das Flag tut da nichts) — steht als #237.
    #
    # `O_BINARY` nur auf Windows, `O_NONBLOCK` nur auf POSIX; `getattr(..., 0)` ist in beiden
    # Faellen das neutrale Element.
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(_pip_merker(), flags)
    except (OSError, ValueError):     # ValueError: eingebettetes NUL im Pfad
        return None
    try:
        roh = os.read(fd, 64)
    except OSError:                   # BlockingIOError am haengenden Schreiber ist einer
        return None
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)
    try:
        d = dt.date.fromisoformat(roh.decode("utf-8").strip())
    except ValueError:                # UnicodeDecodeError IST einer (#185/#190)
        return None
    return None if d > _heute() else d


def _pip_merker_setzen() -> None:
    """Unmittelbar VOR `subprocess.run`, INNERHALB der Sperre — siehe `aktualisiere`.

    **Ein noch GUELTIGER Merker wird NICHT aufgefrischt.** Sein Datum ist der Anker der
    Verfallsfrist, und genau daran endet der einzige verbliebene Dauerlauf: scheitert pip
    dauerhaft (offline, kein Netz, kaputte venv), setzte ein aufgefrischtes Datum die Frist
    bei jedem Lauf zurueck und die Faelligkeit liefe ewig. So friert sie ein und laeuft nach
    `INTERVALL_TAGE` aus. Unlesbar zaehlt dabei als „keiner" und wird ueberschrieben — sonst
    bliebe eine halb geschriebene Datei fuer immer liegen und schaltete die Erkennung ab.

    **Ein ABGELAUFENER wird sehr wohl ueberschrieben**, und das ist der Unterschied zwischen
    „geschont" und „eingefroren": geschont wird nur, was gerade noch gilt. Ohne diese Grenze
    bliebe ein einmal liegengebliebener Merker fuer immer auf seinem alten Datum stehen — eine
    NEUE Unterbrechung Wochen spaeter faende ihn abgelaufen vor, frischte ihn nicht auf, und
    die Reparatur unterbliebe dauerhaft. Ein Dauerlauf entsteht dadurch nicht: damit der
    Merker `faellig()` ueberhaupt ausloest, muss `fassung()` None sein — und dann gibt es ohne
    ihn gar keinen Lauf mehr, der ihn auffrischen koennte. (CodeRabbit-CLI, Major.)

    Best effort: ein nicht schreibbarer Merker macht den Zustand nur so schlecht, wie er vor
    diesem Fix war. Aber nicht STILL, sonst ist er von einem gesetzten nicht zu unterscheiden
    (dieselbe Regel wie bei `sperre.datei`s fail-open).
    """
    d = _merker_datum()
    if d is not None and (_heute() - d).days <= INTERVALL_TAGE:
        return
    try:
        with open(_pip_merker(), "w", encoding="utf-8") as f:
            f.write(_heute().isoformat())
    except OSError as e:
        print(f"[ytdlp] Merker fuer den pip-Lauf nicht schreibbar: {e}", flush=True)


def _pip_merker_loeschen() -> None:
    """NUR nach einem pip-Lauf, der mit **0** zurueckgekehrt ist — siehe `aktualisiere`.

    **Gemessen, und es war der Fehler der ersten Fassung:** `taskkill /F /T` toetet auf
    Windows das pip-KIND zuerst und laesst dem Elternprozess ein Zeitfenster. Der sah
    `returncode != 0`, raeumte auf und kam noch bis ins `_merken()` (`settings.json.tmp` lag
    danach da) — der Merker war weg, ausgerechnet im Szenario von #257. Deshalb entscheidet
    nicht „hat der Prozess ueberlebt", sondern „hat pip Erfolg gemeldet".

    `FileNotFoundError` schweigt — das ist der Normalfall, wenn der Schreibversuch scheiterte.
    Jeder andere `OSError` gehoert ins Protokoll: er ist die einzige verbliebene Quelle eines
    Dauerlaufs, und `_pip_unterbrochen()` deckelt ihn mit der Uhr, statt ihn zu verhindern.
    """
    try:
        os.remove(_pip_merker())
    except FileNotFoundError:
        pass
    except OSError as e:
        print(f"[ytdlp] Merker fuer den pip-Lauf nicht loeschbar: {e} — die Faelligkeit "
              f"bleibt bis zur Frist bestehen", flush=True)


def _pip_unterbrochen() -> bool:
    """Wurde ein pip-Lauf abgewuergt, und ist das noch aktuell?

    Gefragt wird die PLATTE (wie bei `settings.kaputt_pfad()`): der Merker ueberlebt den
    Prozess absichtlich, und geschrieben hat ihn oft ein Subprozess, den nie jemand gesehen
    hat (die Selbstheilung in `fetch.py`).

    **Das Datum wird GELESEN, nicht nur geschrieben** — daran haengt die Zusicherung „kein
    Flag ohne Ende". Gelingt `os.remove` dauerhaft nicht, friert das Datum ein (dieselbe Datei
    weist auch `open(...,"w")` ab — auf Windows an einer Datei mit Read-only-Attribut
    gemessen), und nur die Uhr beendet den Zustand dann noch. `INTERVALL_TAGE` statt einer
    eigenen Zahl: laenger als der Kalendertakt zu warten hiesse, auf eine Reparatur zu warten,
    die der Kalender ohnehin anstoesst.

    Unlesbar oder in der ZUKUNFT (vorgehende Rechneruhr) heisst „keine Auskunft" ⇒ gilt nicht.
    Unbekanntes flaggt dieses Modul nicht — dieselbe Richtung wie in `_ejs_untauglich`. Ein
    solcher Merker bleibt nicht liegen: der naechste Lauf ueberschreibt ihn.

    **Die Antwort allein macht noch nicht faellig.** `faellig()` verlangt zusaetzlich, dass
    yt-dlp wirklich unbrauchbar ist (`fassung() is None`) — der Merker sagt „ein Lauf hat
    keinen Erfolg gemeldet", nicht „etwas ist kaputt". Ohne diese zweite Haelfte liefe nach
    jedem gescheiterten pip (offline) eine Reparatur fuer einen Schaden, den es nicht gibt.
    """
    d = _merker_datum()
    return d is not None and (_heute() - d).days <= INTERVALL_TAGE


def aktualisiere() -> tuple[bool, bool]:
    """`pip install -U yt-dlp[default]`, bedingungslos. `(ok, gehalten)`.

    NUR yt-dlp: ein `-U` ueber alle requirements erwischt irgendwann torch, und die GPU
    waere still weg (dieselbe Falle wie beim CPU-Rad in setup.js).

    **`gehalten` ist die zweite Haelfte von #194** (dieselbe Tupel-Form und derselbe Name wie
    bei `settings.save()`, aus demselben Grund): `False` heisst, dass pip **ohne Sperre**
    lief. Dort ist fail-open kein verlorener Einstellungswert, sondern die Moeglichkeit
    zweier `pip install` in dieselbe venv — genau der Schaden, gegen den diese Sperre gebaut
    ist, und der zweite Ausloeser kommt aus einem eigenen Prozess (der fetch-Subprozess).
    Wer einem Menschen Erfolg meldet, sagt das also dazu; die Protokollzeile aus `sperre.py`
    erreicht nur eine Konsole, und die gepackte App hat keine, die jemand liest (#236).

    **Der Merker `_pip_merker()` deckt das Abwuergen von aussen** (#257/#258): gesetzt
    unmittelbar vor `subprocess.run`, geloescht unmittelbar danach, beides innerhalb der
    Sperre. Er ueberlebt damit genau dann, wenn DIESER Prozess dazwischen stirbt —
    `taskkill /F /T` beim Schliessen der Desktop-App, `jobs.cancel_all()` → SIGKILL auf die
    Prozessgruppe des fetch-Jobs beim Herunterfahren, oder ein Ctrl+C. `faellig()` holt
    daraufhin genau EINEN Reparaturlauf nach. Ohne ihn blieb yt-dlp halb installiert zurueck
    (gemessen: `metadata.version` wirft PackageNotFoundError, die Paketdateien liegen noch da,
    `import yt_dlp` wirft ModuleNotFoundError) ⇒ `fassung()` None ⇒ `faellig()` bewusst False
    ⇒ die Selbstaktualisierung war DAUERHAFT aus und heilte sich nicht selbst.
    """
    cmd = [sys.executable, "-m", "pip", "install", "-U",
           # Kurze Deckel: ohne sie haengt pip offline minutenlang, und der Import wartet mit.
           "--retries", "1", "--timeout", "10", _PAKET]
    # EIN Lesevorgang, zwei Verwender: die Protokollzeile und der Merker unten. Getrennt
    # gelesen koennten die beiden Auskuenfte auseinanderfallen (pip laeuft dazwischen).
    vorher = fassung()
    print(f"[ytdlp] aktualisiere (installiert: {vorher or 'nichts'}) …", flush=True)
    ok = False
    # Zwei pip-Laeufe auf DIESELBE venv duerfen sich nicht ueberschneiden — sie schreiben in
    # dasselbe site-packages und koennen die Installation zerlegen. Erreichbar, seit es zwei
    # Ausloeser aus zwei Prozessen gibt: der Import-Job und der Knopf in den Einstellungen.
    # Eigener Lock-Name (…ytdlp.lock), damit er sich nicht mit dem von `settings.save()`
    # ueberschneidet — der wird im `_merken()` genommen, waehrend dieser noch haelt.
    lockziel = _lockziel()      # EIN Ausdruck: Verzeichnis, Sperre und Anzeige denselben Pfad
    try:
        # `or "."` fuer ein TRANSKRIBOR_SETTINGS ohne Verzeichnisanteil (`os.makedirs("")`
        # wuerde werfen). Und best effort wie alles hier: ein nicht anlegbares Verzeichnis
        # darf den Aufrufer nicht mitreissen — dann laeuft es eben ohne Sperre.
        os.makedirs(os.path.dirname(lockziel) or ".", exist_ok=True)
    except OSError as e:
        print(f"[ytdlp] Sperrverzeichnis nicht anlegbar: {e}", flush=True)
    # Die Frist deckt die WIRKLICHE Haltedauer, nicht nur den pip-Lauf — siehe `_lock_stale`.
    with sperre.datei(lockziel, stale=_lock_stale()) as gehalten:
        # INNERHALB der Sperre und unmittelbar um `subprocess.run` herum — beide Zeilen. Das
        # ist die ganze Erkennung: der Merker ueberlebt GENAU DANN, wenn dieser Prozess
        # zwischen ihnen stirbt, und das ist #257/#258.
        #
        # Nicht VOR die Sperre: dann setzte ihn auch, wer nur WARTET, und der Fertigwerdende
        # loeschte den Merker des Wartenden — dessen pip liefe danach ungedeckt. Zwei
        # Aktualisierer gleichzeitig sind hier der Normalfall (Server + fetch-Subprozess, seit
        # #254 auch zwei Server). Ein `settings.save()` an dieser Stelle waere dagegen teuer
        # (zweite verschachtelte Sperre ⇒ `_lock_stale()` muesste um `frist()` wachsen, #207);
        # ein einfacher Dateischreibvorgang nimmt keine Sperre.
        #
        # **Nur, wenn hier ueberhaupt etwas zu zerlegen war.** Der Merker bedeutet „wir haben
        # eine LAUFENDE Installation angefasst und nicht sauber beendet" — ohne diese Frage
        # bedeutete er bloss „ein pip ist gelaufen", und dann feuerte `faellig()` auch nach
        # einem ganz gewoehnlich gescheiterten Lauf auf einer Maschine, auf der yt-dlp nie
        # installiert war (Knopf „Jetzt aktualisieren" ohne Netz). Genau den Zustand schuetzt
        # der Riegel in `faellig()` als „Sache des Setups"; der Merker haette ihn ausgehebelt
        # und 14 Tage lang bei jedem Start einen Hintergrund-pip freigeschaltet. Gemessen im
        # Review, mit gefaelschtem pip.
        #
        # Der Preis, und er ist der richtige: wird die ERSTE Installation abgewuergt, gibt es
        # keinen Merker und keine Reparatur — das ist der Zustand von heute, und „yt-dlp war
        # nie da" ist wirklich Sache des Setups. Ein Reparaturlauf ist davon nicht betroffen:
        # der Merker des abgewuergten Laufs liegt ja noch (geloescht wird nur bei Erfolg), und
        # `_pip_merker_setzen` frischt einen datierten Merker ohnehin nicht auf.
        if vorher is not None:
            _pip_merker_setzen()
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                               timeout=PIP_TIMEOUT)
            ok = p.returncode == 0
            zeilen = (p.stdout or "").strip().splitlines() or (p.stderr or "").strip().splitlines()
            print(f"[ytdlp] {'ok' if ok else 'fehlgeschlagen'}: {zeilen[-1] if zeilen else ''}",
                  flush=True)
        except (OSError, subprocess.SubprocessError) as e:
            print(f"[ytdlp] Update fehlgeschlagen: {e}", flush=True)
        # NUR bei Erfolg. „Der Prozess hat ueberlebt" waere das falsche Mass, und das ist
        # GEMESSEN: `taskkill /F /T` toetet auf Windows das pip-KIND zuerst und laesst dem
        # Elternprozess ein Zeitfenster — im Versuch kam er hier vorbei und noch bis ins
        # `_merken()`, der Merker war weg, ausgerechnet im Szenario von #257. Ein abgewuergtes
        # pip meldet nie 0, ein gelungenes immer.
        #
        # Der Preis: nach einem ECHTEN Fehlschlag (offline, Aufloesung) bleibt der Merker
        # liegen. Das kostet nichts, weil `faellig()` zusaetzlich `fassung() is None` verlangt
        # — und die Fassung ist dann ja unveraendert lesbar. Aufgeraeumt wird er vom naechsten
        # gelungenen Lauf, spaetestens von der Frist in `_pip_unterbrochen()`.
        #
        # VOR `_merken()`: das faengt nur `OSError`, ein anderer Wurf dort liesse den Merker
        # sonst liegen, obwohl pip sauber durchgelaufen ist.
        if ok:
            _pip_merker_loeschen()
        # INNERHALB der Sperre: der Kommentar oben behauptete das, der Aufruf stand aber eine
        # Zeile darunter — womit der Test auf die verschiedenen Lock-Namen nichts pruefte
        # (mit demselben Namen blieb er gruen). Jetzt ist die verschachtelte Sperre echt.
        _merken()
    return ok, gehalten


# Zustand des Knopfes „Jetzt aktualisieren" (#174). `ergebnis`: "" = noch nichts bzw.
# laeuft gerade, "ok" = pip sauber durch, "fehler" = nicht.
#
# **Modulzustand, also PRO PROZESS** — und das ist richtig so: der fetch-Subprozess
# aktualisiert ebenfalls, aber der hat kein Frontend, das nachfragt. Dass sich die beiden
# nicht ins Gehege kommen, regelt `sperre.datei` in `aktualisiere()`, nicht dieser Riegel;
# hier geht es allein um den Doppelklick im selben Server.
#
# `ungeschuetzt` gehoert zum ERGEBNIS, nicht zum Lauf (#236): es beschreibt, ob der letzte
# abgeschlossene pip-Lauf die Sperre wirklich hielt. Ein eigenes Feld statt eines dritten
# `ergebnis`-Wertes, weil die beiden unabhaengig sind — ein Lauf kann ungeschuetzt UND
# fehlgeschlagen sein, und ein Wert kann nur eines von beidem sagen.
_lauf = {"laeuft": False, "ergebnis": "", "ungeschuetzt": False}
_lauf_sperre = threading.Lock()


def hintergrund_zustand() -> tuple[bool, str, bool]:
    """`(laeuft, ergebnis, ungeschuetzt)` — unter der Sperre gelesen, damit sie zusammenpassen."""
    with _lauf_sperre:
        return _lauf["laeuft"], _lauf["ergebnis"], _lauf["ungeschuetzt"]


def starte_hintergrund() -> bool:
    """`aktualisiere()` in einem Faden anstossen. False = es laeuft schon einer.

    Der Knopf lief bis #174 SYNCHRON im Request. Der schlimmste Fall sind nicht die im
    alten Docstring genannten „rund 250 s", sondern **>=340 s** (#219): die Wartezeit haengt
    an `sperre.frist(stale)` = 220 s, danach kommt das eigene pip mit 120 s obendrauf. Zwei
    Minuten ohne Lebenszeichen liest ein Nutzer als Absturz — und ein Proxy- oder
    Browser-Timeout schnitt den Request ab, ohne dass der pip-Lauf davon etwas merkte:
    das Ergebnis sah dann niemand.
    """
    with _lauf_sperre:
        if _lauf["laeuft"]:
            return False
        _lauf["laeuft"] = True
        _lauf["ergebnis"] = ""
        # Mit zuruecksetzen: ein stehengebliebenes `ungeschuetzt` des VORIGEN Laufs waere
        # eine Warnung ueber einen Vorgang, den der Nutzer gerade wiederholt hat.
        _lauf["ungeschuetzt"] = False
    # Das `finally` in `_im_hintergrund` deckt den RUMPF — nicht den Start. Wirft `start()`
    # (`RuntimeError: can't start new thread`), laeuft es nie, und `laeuft` bliebe True:
    # gemessen gibt der erste Klick dann 500, **jeder weitere** 200 mit
    # `{gestartet: false, laeuft: true}` — womit die Warteschleife im Frontend endlos alle
    # 1,5 s nachfragt und nie einen Toast zeigt. Dauerhaft, bis zum Serverneustart. Selten
    # (Faden-Erschoepfung), aber derselbe Massstab, mit dem unten das `finally` begruendet
    # ist: die Kosten des Fehlers, nicht seine Wahrscheinlichkeit.
    try:
        threading.Thread(target=_im_hintergrund, daemon=True).start()
    except BaseException:
        with _lauf_sperre:
            # `ungeschuetzt` NICHT noch einmal: der Block oben hat es unter derselben Sperre
            # schon geloescht, und dazwischen kann es niemand gesetzt haben — ein frueherer
            # Faden waere am Riegel abgewiesen worden, ein neuer ist nie gestartet. Die Zeile
            # stand hier und war damit ein Waechter, den keine Mutation rot bekommt
            # (Reviewbefund M1). `laeuft`/`ergebnis` brauchen sie sehr wohl: `laeuft` steht
            # seit dem Block oben auf True.
            _lauf["laeuft"], _lauf["ergebnis"] = False, "fehler"
        raise
    return True


def _im_hintergrund() -> None:
    """Der Faden. Setzt `laeuft` unter ALLEN Umstaenden zurueck."""
    # `ergebnis` VOR dem `try`: ein Wurf, den `except Exception` nicht faengt (SystemExit,
    # KeyboardInterrupt), liefe im `finally` sonst in einen UnboundLocalError.
    #
    # **Was das WIRKLICH kostet — nachgerechnet, nicht geraten:** `laeuft = False` steht im
    # `finally` VOR der `ergebnis`-Zeile und gelingt immer; der Knopf bliebe also nutzbar.
    # Uebrig bliebe `ergebnis = ""`, und das Frontend nimmt dafuer den Fehlerzweig — also
    # dieselbe sichtbare Meldung wie mit "fehler", plus ein Traceback im Serverlog. Die
    # Zeile bleibt trotzdem: der Zustand gehoert explizit gesetzt, nicht zufaellig richtig.
    # (Eine erste Fassung dieses Kommentars behauptete „laeuft bliebe fuer immer True" —
    # falsch, und genau die Sorte unnachgerechnete Kontrollfluss-Behauptung, die dieses
    # Repo als haeufigsten Fehler fuehrt.)
    #
    # `ungeschuetzt` bleibt bei einem Wurf auf `False`: dann ist unbekannt, ob die Sperre
    # hielt, und Unbekanntes wird hier nicht gemeldet (dieselbe Richtung wie bei
    # `_ejs_untauglich` — eine Warnung auf Verdacht ist ein Daueralarm).
    ergebnis, ungeschuetzt = "fehler", False
    try:
        ok, gehalten = aktualisiere()
        ergebnis, ungeschuetzt = ("ok" if ok else "fehler"), not gehalten
    except Exception as e:
        # `aktualisiere()` faengt selbst schon OSError/SubprocessError; was hier ankommt,
        # ist unerwartet und gehoert benannt statt verschluckt.
        print(f"[ytdlp] Hintergrundlauf abgebrochen: {type(e).__name__}: {e}", flush=True)
    finally:
        with _lauf_sperre:
            _lauf["laeuft"] = False
            _lauf["ergebnis"] = ergebnis
            _lauf["ungeschuetzt"] = ungeschuetzt


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
    # Nur der Ausgang: `fetch.py` fragt "hat es sich gelohnt, es noch einmal zu versuchen".
    # Die Sperr-Auskunft (#236) gilt dem Menschen vor der Einstellungsseite, und den gibt es
    # auf diesem Weg nicht — der laeuft im fetch-Subprozess, wo sie in `sperre`s
    # Protokollzeile steht und sonst nirgends.
    return aktualisiere()[0]


def laeuft_gerade(eigener: bool | None = None) -> bool:
    """Aktualisiert IRGENDWER gerade yt-dlp? Fuer eine AUSKUNFT, nie fuer eine Entscheidung.

    Zwei Quellen, weil es zwei Prozesse gibt: `_lauf` ist Modulzustand (der eigene
    Hintergrundlauf), die Sperre deckt den fremden — den fetch-Subprozess mit seiner
    Selbstheilung und, seit #253, jeden anderen Serverprozess mit seinem Startlauf.
    `sperre.wird_gehalten` nimmt die Lebendpruefung mit; ein blosses `isdir` liesse ein
    liegengebliebenes Lock dauerhaft „laeuft gerade" melden (#243).

    **Die Antwort ist eine Momentaufnahme.** Wer daraus einen Sprung in den kritischen
    Abschnitt ableitet, baut genau die Race nach, gegen die die Sperre steht.

    `eigener` erspart dem Aufrufer, der `hintergrund_zustand()` ohnehin schon gelesen hat,
    einen zweiten Zugriff — und haelt die Antwort damit in sich konsistent (dieselbe Regel
    wie `cfg` bei `llm.available`).

    Herausgezogen aus `zustand()`, weil `fetch.download_one` seit #253 dieselbe Frage stellt:
    der Startlauf kann laufen, waehrend dort importiert wird, und „nicht installiert" waere
    dann falsch. Zwei Orte mit derselben Regel driften auseinander.
    """
    if eigener is None:
        eigener = hintergrund_zustand()[0]
    return eigener or sperre.wird_gehalten(_lockziel(), _lock_stale())


def beim_start() -> bool:
    """Die faellige Kalenderpruefung beim Serverstart, im Hintergrund. True = ein Lauf laeuft.

    **Bis #253 hing dieser Weg an `fetch._hole_yt_dlp()`**, lief also vor JEDEM URL-Import:
    war yt-dlp faellig, wartete der Nutzer dort bis zu 120 s auf pip (mit Sperrwartezeit
    >=340 s) — direkt nachdem er eine Adresse eingefuegt hatte, also an der einzigen Stelle
    der App, an der er aktiv auf ein Ergebnis wartet. Vorsorge gehoert an den Start, wo
    niemand wartet.

    **Die SELBSTHEILUNG bleibt, wo sie ist** (`automatisch(erzwingen=True)` in `fetch.main`
    nach einem gescheiterten Download): ein Extraktor bricht nicht nach Kalender, und dort
    ist das pip die Reparatur eines Fehlers, den der Nutzer gerade vor sich hat — keine
    Vorsorge. Die beiden Wege sahen im Code gleich aus und sind es nie gewesen.

    Dieselben zwei Tore wie `automatisch()`, aus derselben Quelle: Schalter (`auto_an`) und
    Faelligkeit (`faellig`). Ohne das zweite liefe bei jedem Start ein pip — die App startet
    oefter als alle 14 Tage.

    Der Lauf geht ueber `starte_hintergrund()`, nicht ueber `automatisch()`: nur der setzt
    `_lauf`, und daran haengt die Ausgangsmeldung der Einstellungsseite (#174/#243);
    `automatisch()` liefe ausserdem synchron und hielte den Start auf.

    **Wirft nie** — der Aufrufer ist `app._lifespan`. Dieselbe Zusage wie im Modul-Docstring
    (#185: `fetch._hole_yt_dlp()` hatte kein try/except und riss den URL-Import mit), nur mit
    hoeherem Einsatz: dort fiel eine Funktion aus, hier kaeme der Server nicht hoch.
    """
    try:
        if not auto_an() or not faellig():
            return False
        # **Drittes Tor, nur fuer diesen Weg** (CodeRabbit-Bot an PR #255, Major): starten zwei
        # Serverprozesse gleichzeitig — gepackte App neben Entwickler-Checkout teilen sich
        # Sperre und Merker (#254) —, sehen beide `faellig()` und starten je einen Lauf. Der
        # zweite sitzt bis zu `sperre.frist()` ≈ 220 s an der Sperre ab und macht danach ein
        # pip, das „Requirement already satisfied" meldet. Dieselbe Klasse wie #176, auf dem
        # neuen Weg.
        #
        # **Advisory, nicht Entscheidung im kritischen Abschnitt** — und das ist hier zulaessig,
        # anders als bei einem Sprung IN den Abschnitt: wir lassen eine freiwillige Vorsorge
        # aus. Verliert die Pruefung ihr Rennen, laufen beide — also genau das heutige
        # Verhalten, kein neuer Schaden. Ein Riegel INNERHALB der Sperre waere die vollstaendige
        # Antwort und braeuchte `aktualisiere()`s bedingungslosen Vertrag anzufassen, an dem
        # der Knopf „Jetzt aktualisieren" haengt; das gehoert zu #176s Neuzuschnitt.
        if laeuft_gerade():
            print("[ytdlp] Kalenderpruefung uebersprungen — es aktualisiert schon jemand",
                  flush=True)
            return False
        return starte_hintergrund()
    except Exception as e:
        # Nicht still: eine uebersprungene Vorsorge sieht man sonst erst daran, dass Monate
        # spaeter ein Extraktor bricht. `BaseException` faengt der Block bewusst nicht —
        # ein KeyboardInterrupt beim Start soll den Start abbrechen.
        print(f"[ytdlp] Kalenderpruefung beim Start uebersprungen "
              f"({type(e).__name__}: {e})", flush=True)
        return False


def beim_ende(eigener: bool | None = None) -> bool:
    """Der Serverprozess endet, waehrend der eigene Update-Faden noch pip haelt (#224).
    True = der Merker wurde aufgegeben.

    Das Gegenstueck zu `beim_start()`, und es steht aus demselben Grund hier: seit #253 laeuft
    das pip **im Serverprozess**, in den ersten Sekunden nach dem Start — also genau in dem
    Fenster, in dem jemand die frisch geoeffnete App wieder zumacht. Bei einer Neuinstallation
    ist die Pruefung garantiert faellig.

    Der Faden ist `daemon=True`, sein `finally` laeuft beim Interpreter-Ende also nicht, und
    das pip-Kind ueberlebt uns (in WSL gemessen, siehe `sperre.merker_aufgeben`). Wir koennen
    das Lock deshalb nicht freigeben — wir wollen es auch nicht: es soll halten, bis das Kind
    fertig ist. Aufgegeben wird nur die **Auskunft**, damit der naechste Start die Uhr
    befragt statt eine tote PID.

    **Nur der EIGENE Lauf** (`hintergrund_zustand`, nicht `laeuft_gerade`): ein fremder Halter
    — der fetch-Subprozess mit seiner Selbstheilung, oder ein zweiter Serverprozess (#254) —
    lebt weiter und braucht seine Auskunft. Der Ausweis in `merker_aufgeben` faengt den Fall
    ein zweites Mal ab; hier steht er, weil ein Lock, das uns nie gehoerte, gar nicht erst
    angefasst werden soll.

    **`_lauf` kennt nur den FADEN-Weg**, und das ist eine Falle fuer den naechsten Umbau:
    `automatisch()` ruft `aktualisiere()` **synchron** (fetch-Subprozess), dort steht
    `_lauf["laeuft"]` nie auf True. Heute folgenlos — jenen Prozess raeumt `jobs.cancel_all()`
    per SIGKILL ab, es laeuft ohnehin kein Handler. Wer ihm einen gibt, bekommt `beim_ende()`
    als stillen No-op, der abgedeckt aussieht.

    `eigener` ist derselbe Saum wie bei `laeuft_gerade` — und hier zusaetzlich der einzige
    Weg, den Fall im Test ohne echten Faden zu stellen.
    """
    if eigener is None:
        eigener = hintergrund_zustand()[0]
    return eigener and sperre.merker_aufgeben(_lockziel())


def zustand() -> dict:
    """Fuer die Einstellungsseite: was installiert ist, wann zuletzt geprueft wurde,
    ob der Automatismus laeuft — und ob die Umgebung den Haken ueberstimmt.

    `unlesbar` trennt "nicht installiert" von "Metadaten nicht lesbar": `version` ist in
    beiden Faellen `null`, und die Einstellungsseite behauptete daraufhin, der URL-Import
    stehe nicht zur Verfuegung, waehrend er lief (#189).

    `env` sagt der Server, statt das Frontend `ytdlp_auto` gegen `auto` vergleichen zu lassen:
    die beiden Werte kommen aus zwei Antworten (PUT liefert nur `ytdlp_auto`), und dazwischen
    behauptete der Vergleich fuer einen Moment ein Override, das es gar nicht gibt. Eine
    Wahrheit statt einer abgeleiteten.

    `laeuft`/`ergebnis` gehoeren seit #174 dazu: der Knopf antwortet sofort, der Ausgang des
    pip-Laufs kommt ueber den naechsten GET nach. Ohne die beiden Felder haette der Umbau
    einen haengenden Browser gegen einen STILLEN Fehlschlag getauscht — und der ist die
    teurere Sorte (dieselbe Klasse wie #189/#192).

    **`laeuft` fragt seit #243 auch die SPERRE, nicht nur `_lauf`.** Das ist Modulzustand je
    Prozess, und der fetch-Subprozess aktualisiert ebenfalls (`automatisch()`, samt
    Selbstheilung nach einem gescheiterten Download). Waehrend dessen pip-Lauf schrieb ein
    fremder Prozess `site-packages` um, hier stand `laeuft: False` — und ein GET, das in pips
    Deinstallations-/Installationsluecke faellt, liess die Einstellungsseite „Nicht
    installiert" behaupten. Also dieselbe Luege, die #225 fuer den eigenen Lauf geschlossen
    hat, durch die andere Tuer; die README schickt den Nutzer sogar genau dann auf diese
    Seite. `sperre.wird_gehalten` nimmt die Lebendpruefung mit — ein blosses `isdir` liesse
    ein liegengebliebenes Lock dauerhaft „laeuft gerade" melden.

    **`ungeschuetzt`** ist der Ausgang des letzten eigenen Laufs, nicht der Sperrzustand
    jetzt (#236) — es gehoert zu `ergebnis`, nicht zu `laeuft`.

    **`ejs_unlesbar`** meldet, dass die Metadaten von `yt-dlp-ejs` nicht lesbar sind und die
    Erkennung untauglicher Loeserskripte (#179/#182) deshalb ausgesetzt ist (#198).
    """
    g = geprueft()
    v, unlesbar = _fassung_und_lesbarkeit()
    laeuft, ergebnis, ungeschuetzt = hintergrund_zustand()
    return {"version": v, "unlesbar": unlesbar, "geprueft": g.isoformat() if g else "",
            "auto": auto_an(), "env": env_override() is not None,
            "laeuft": laeuft_gerade(laeuft),
            "ergebnis": ergebnis, "ungeschuetzt": ungeschuetzt,
            "ejs_unlesbar": _ejs_untauglich_und_lesbarkeit()[1]}
