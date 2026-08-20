"""Selbstaktualisierung von yt-dlp.

Zwei Dinge stellt die Fixture IMMER sicher, und beide sind keine Kosmetik:
`TRANSKRIBOR_SETTINGS` zeigt in tmp_path (der Merker landet in der Einstellungsdatei —
sonst schriebe der Test in Marcus' echte), und `subprocess.run` ist gefaelscht (ein Test,
der echtes pip startet, aendert die venv des Entwicklers waehrend der Lauf laeuft).

**Seit #257/#258 haengt `faellig()` zusaetzlich an einer DATEI auf der Platte**
(`_pip_merker()`, ueber `_lockziel()` ebenfalls an `TRANSKRIBOR_SETTINGS`). Wer kuenftig
einen Test schreibt, der `faellig()`/`beim_start()` OHNE diese Fixture anfasst, bekommt auf
einem Entwicklerrechner ein True, sobald dort einmal ein pip abgewuergt wurde — und damit
einen echten pip-Lauf gegen dessen venv. Die CI sieht das nie: dort lief nie ein
`aktualisiere()`, also liegt auch nie ein Merker.
"""
import contextlib
import datetime as dt
import os
import platform
import subprocess
import sys
import threading
import time

import pytest

from webtool import settings, sperre
from webtool import ytdlp_update as yu

HEUTE = dt.date(2026, 8, 13)

# VOR jeder Fixture-Faelschung festgehalten: die Fixture pinnt `_ejs_untauglich` (s. unten),
# und der Test der Funktion selbst braucht trotzdem das Original.
_ECHTES_EJS_UNTAUGLICH = yu._ejs_untauglich
# Dasselbe fuer `subprocess.run`: die Fixture verdrahtet es auf `pytest.fail`, und weil
# `yu.subprocess` DASSELBE Modulobjekt ist wie das hier importierte, trifft das jeden Aufruf
# in dieser Datei — auch einen, der gar kein pip startet.
_ECHTES_RUN = subprocess.run


@pytest.fixture(autouse=True)
def isoliert(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.delenv("TRANSKRIBOR_YTDLP_UPDATE", raising=False)
    monkeypatch.setattr(yu.subprocess, "run",
                        lambda *a, **k: pytest.fail("kein echtes pip im Test"))
    monkeypatch.setattr(yu, "_heute", lambda: HEUTE)
    # Die Suite laeuft bewusst ohne yt-dlp (und damit ohne yt-dlp-ejs) — im CI-Job steht
    # `pip install fastapi python-multipart pytest httpx`, sonst nichts. Ungepinnt haengen
    # damit VIER Faelligkeitstests daran, ob die Umgebung des Laeufers das Paket zufaellig
    # mitbringt: gemessen, indem `_ejs_untauglich` einmal fest auf True gesetzt wurde — dann
    # fallen `frische_fassung`, `merker_bremst`, `nightly` und `automatisch_ueberspringt` um.
    monkeypatch.setattr(yu, "_ejs_untauglich", lambda: False)
    return tmp_path


def _warte_bis(bedingung, frist=5.0) -> bool:
    """Der Faden setzt `_lauf` in seinem `finally`, also NACH dem Event, an dem der Test
    haengt. Ohne dieses Warten liest der Test einen Zwischenstand — eine Rennbedingung im
    Test selbst, und die faellt sporadisch aus.

    `monotonic`, nicht `time`: die Wanduhr kann waehrend der Frist springen (NTP), und
    `_warte` in `test_api.py` nimmt dieselbe Uhr — zwei Helfer mit derselben Aufgabe und
    verschiedenen Uhren driften auseinander. Und die Runde AM Fristende zaehlt mit: ein
    hartes `False` verwuerfe das Ergebnis des letzten `sleep`. (Beides CodeRabbit-Bot.)
    """
    ende = time.monotonic() + frist
    while time.monotonic() < ende:
        if bedingung():
            return True
        time.sleep(0.01)
    return bool(bedingung())


def _pip(returncode=0, ausgabe="Successfully installed yt-dlp-2026.8.12"):
    """Spion statt echtem pip. Liefert (Liste der Aufrufe, Ersatzfunktion)."""
    gerufen = []

    def run(cmd, **kwargs):
        gerufen.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, returncode, ausgabe, "")

    return gerufen, run


def _kalender_merken(datum: str) -> None:
    """Test-Hilfe #281: den Kalendermerker DER EIGENEN venv auf ein Datum setzen —
    ersetzt das fruehere `settings.save({'ytdlp_geprueft': …})`, das seit #281
    herausgefiltert wird (und dessen Setzen damit vacuous waere)."""
    with open(yu._kalender_merker(), "w", encoding="utf-8") as f:
        f.write(datum)


# --- Faelligkeit (ohne Netz, allein aus der Versionsnummer) ------------------

def test_frische_fassung_ist_nicht_faellig(monkeypatch):
    """Die Versionsnummer IST ein Datum — deshalb braucht die Faelligkeit keine PyPI-Abfrage."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.1")        # 12 Tage alt
    assert yu.faellig() is False


def test_alte_fassung_ohne_merker_ist_faellig(monkeypatch):
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")        # 40 Tage alt
    assert yu.faellig() is True


def test_merker_bremst_die_alte_fassung(monkeypatch):
    """yt-dlp veroeffentlicht stabil etwa monatlich. Allein an der Fassung gemessen waere
    sie nach 14 Tagen DAUERHAFT faellig, und jeder Import liefe in ein pip, das nichts tut."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    _kalender_merken("2026-08-10")                                  # vor drei Tagen geprueft
    assert yu.faellig() is False


def test_alter_merker_gibt_wieder_frei(monkeypatch):
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    _kalender_merken("2026-07-01")
    assert yu.faellig() is True


def test_nightly_fassung_wird_gelesen(monkeypatch):
    """2026.8.1.232355 ist dieselbe Fassung wie 2026.8.1 — die vierte Zahl ist die Uhrzeit.
    Ohne den Schnitt auf drei Teile waere jede Nightly unlesbar und damit dauernd faellig."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.1.232355")
    assert yu.faellig() is False


def test_unlesbare_fassung_gilt_als_faellig_aber_der_merker_bremst(monkeypatch):
    """Einmal pip zu viel ist besser als nie. Der Merker haelt es trotzdem im Zaum —
    sonst waere eine exotische Fassungsnummer ein pip bei JEDEM Import."""
    monkeypatch.setattr(yu, "fassung", lambda: "unbekannt")
    assert yu.faellig() is True
    _kalender_merken(HEUTE.isoformat())
    assert yu.faellig() is False


def test_kaputter_merker_blockiert_nicht(monkeypatch):
    """Ein von Hand verdrehtes Datum darf die Aktualisierung nicht fuer immer abschalten."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    _kalender_merken("gestern")
    assert yu.faellig() is True


def test_merker_in_der_ZUKUNFT_blockiert_nicht(monkeypatch):
    """`(heute - g).days` wird bei einem Zukunftsdatum negativ — `faellig()` waere damit
    dauerhaft False und der Kalenderweg **still und fuer immer** abgeschaltet. Erreichbar
    per Handbearbeitung oder einer vorgehenden Rechneruhr; der API-Pfad ist verteidigt
    (`SettingsBody` kennt den Schluessel nicht), diese beiden nicht."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    _kalender_merken("2099-01-01")
    assert yu.geprueft() is None
    assert yu.faellig() is True


def test_ohne_installiertes_yt_dlp_kein_update(monkeypatch):
    """`pip install -U` wuerde yt-dlp NEU installieren. Das ist Sache des Setups; hier
    bliebe sonst die ehrliche Meldung 'yt-dlp ist nicht installiert' aus.

    **`_ejs_untauglich` steht hier bewusst auf True** — ohne yt-dlp fehlt auch dessen Extra, das
    ist der ECHTE Zustand dieser Maschine. Mit dem `False` aus der Fixture prueft der Test
    die Reihenfolge nicht: der ejs-Zweig ist dann neutralisiert, und ob er vor oder hinter
    dem `v is None`-Riegel steht, sieht niemand. Gemessen (an PR #180 vom Review gefunden):
    den Zweig VOR den Riegel zu schieben liess vorher ALLE 32 Tests gruen — und genau das
    waere der Fall, in dem ein URL-Import yt-dlp per pip **installiert**, statt ehrlich zu
    melden, dass es fehlt. Die Regel dahinter: bei einem Abwesenheitstest alle frueheren
    Waechter umschiffen, damit der gepruefte der EINZIGE ist.
    """
    monkeypatch.setattr(yu, "fassung", lambda: None)
    monkeypatch.setattr(yu, "_ejs_untauglich", lambda: True)
    assert yu.faellig() is False


def test_fassung_laedt_yt_dlp_nicht(monkeypatch):
    """Der Kern des Mechanismus: die Fassung kommt aus den Metadaten auf der Platte.
    Ein Import hier machte die ganze Reihenfolge (pruefen -> pip -> importieren) sinnlos."""
    gerufen = []
    monkeypatch.setattr(yu.metadata, "version", lambda name: gerufen.append(name) or "2026.8.1")
    assert yu.fassung() == "2026.8.1"
    assert gerufen == ["yt-dlp"]


# --- Faelligkeit ohne Kalender: ein FEHLENDES Paket (#179) -------------------

def test_fehlende_loeserskripte_machen_faellig(monkeypatch):
    """#179: `yt-dlp[default]` kam erst mit #178 in die requirements.txt — eine venv von
    davor hat `yt-dlp-ejs` nicht. Seit #181 wird die Datei zwar bei jeder Statuspruefung
    GELESEN (Hashvergleich), INSTALLIERT wird daraus aber erst nach einem Klick auf der
    Einrichtungsseite. Am Kalender gemessen faellt das NIE auf: die Fassung ist
    frisch, der Loeser hat trotzdem keine Skripte — und YouTube antwortet mit 403."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")       # gestern erschienen
    monkeypatch.setattr(yu, "_ejs_untauglich", lambda: True)
    assert yu.faellig() is True


def test_fehlende_loeserskripte_bremst_der_merker_nur_einen_TAG(monkeypatch):
    """Ein fehlendes Paket ist keine Frage des Kalenders — pip HAT hier etwas zu holen,
    der 14-Tage-Takt waere die falsche Bremse (bis zu zwei Wochen 403 fuer nichts).

    Ganz ohne Bremse zahlte dafuer ein Rechner ohne Netz den pip-Fehlschlag bei JEDEM
    Import; deshalb hoechstens einmal am Tag statt gar nicht.
    """
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")
    monkeypatch.setattr(yu, "_ejs_untauglich", lambda: True)
    _kalender_merken(HEUTE.isoformat())
    assert yu.faellig() is False
    _kalender_merken((HEUTE - dt.timedelta(days=1)).isoformat())
    assert yu.faellig() is True


def test_ejs_wird_an_den_metadaten_gemessen(monkeypatch):
    """Dieselbe Regel wie bei `fassung()`: von der PLATTE lesen, nicht importieren — ein
    geladenes `yt_dlp_ejs` laege beim pip-Lauf danach schon im Speicher.

    Positiv- UND Negativkontrolle: eine Fassung, die immer `True` liefert, waere von der
    richtigen Antwort nicht zu unterscheiden, solange das Paket im CI ohnehin fehlt.

    Was dieser Test NICHT kann: das Paket wirklich deinstallieren — es haengt an der
    Umgebung des laufenden Interpreters, und `faellig()` sieht hier deshalb immer die
    gepinnte Fixture-Fassung. Deshalb an zwei echten Wegwerf-venvs nachgemessen, gleiche
    yt-dlp-Fassung (2026.7.4) und gleicher Merker (gestern), nur das Paket unterschiedlich:

        ohne yt-dlp-ejs -> _ejs_untauglich() True,  faellig() True
        mit  yt-dlp-ejs -> _ejs_untauglich() False, faellig() False

    Dass `pip install -U "yt-dlp[default]"` das Paket ueberhaupt nachzieht, wenn yt-dlp
    schon die neueste Fassung ist, haengt der ganze Fix daran — im selben Lauf gemessen:
    yt-dlp blieb bei 2026.7.4, `yt-dlp-ejs-0.8.0` kam neu dazu.

    **Der Distributionsname wird mitgeprueft** (wie in `test_fassung_laedt_yt_dlp_nicht`):
    ein Stub, der jeden Namen annimmt, bleibt auch dann gruen, wenn `_ejs_untauglich()` aus
    Versehen `yt-dlp` abfragt — und das ist immer installiert, die Funktion antwortete also
    dauerhaft "da ist es". Nachgemessen: mit `_EJS = "yt-dlp"` liefen vorher ALLE 32 Tests
    durch (CodeRabbit an PR #180).
    """
    gerufen = []
    monkeypatch.setattr(yu.metadata, "version", lambda name: gerufen.append(name) or "0.8.0")
    # `requires` MUSS mitgefaelscht werden, sonst liest `_ejs_pin()` die ECHTEN Metadaten
    # dieser Maschine. Der Test liefe dann nur deshalb gruen, weil das hier installierte
    # yt-dlp zufaellig `yt-dlp-ejs==0.8.0` verlangt — und fiele um, sobald yt-dlp den Pin
    # anhebt (im CI faellt es nie auf, dort gibt es gar kein yt-dlp). Dieselbe
    # Umgebungs-Kopplung, gegen die oben schon die Fixture geschrieben wurde.
    # Die Zeile deklariert ejs, damit der „fehlt"-Zweig unten ueberhaupt flaggt (#184: ohne
    # Anforderung gibt es nichts auszurichten).
    def gefordert(name):
        assert name == "yt-dlp", f"unerwartet nach den Anforderungen von {name!r} gefragt"
        return ["yt-dlp-ejs==0.8.0; extra == 'default'"]

    monkeypatch.setattr(yu.metadata, "requires", gefordert)
    assert _ECHTES_EJS_UNTAUGLICH() is False

    def fehlt(name):
        gerufen.append(name)
        raise yu.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(yu.metadata, "version", fehlt)
    assert _ECHTES_EJS_UNTAUGLICH() is True
    assert gerufen == ["yt-dlp-ejs", "yt-dlp-ejs"]


# --- Untauglich ist auch eine UNPASSENDE Fassung (#182) ----------------------

def _metadaten(monkeypatch, installiert, requires):
    """yt-dlps Metadaten faelschen — beides von der Platte, ohne Import."""
    monkeypatch.setattr(yu.metadata, "version", lambda name: installiert)
    monkeypatch.setattr(yu.metadata, "requires", lambda name: requires)


def test_unpassende_loeserskripte_sind_untauglich(monkeypatch):
    """#182: `pip install -U yt-dlp` OHNE `[default]` hebt yt-dlp und laesst ejs stehen.
    Das Paket ist dann DA — `_ejs_untauglich` haette nach #179 also False gesagt — aber
    yt-dlp verwirft es (Major+Minor, dann Hash) und `no_warnings` schluckt die Warnung.
    Ergebnis waere still der Stand vor #170, samt sporadischem 403."""
    _metadaten(monkeypatch, "0.8.0", ["yt-dlp-ejs==0.9.0; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is True


def test_passende_loeserskripte_sind_tauglich(monkeypatch):
    """Negativkontrolle — sonst waere eine Fassung, die immer True liefert, nicht zu
    unterscheiden. Die Zeichenkette ist die echte aus dieser venv (gemessen)."""
    _metadaten(monkeypatch, "0.8.0", ["yt-dlp-ejs==0.8.0; extra == 'default'",
                                      "yt-dlp-ejs==0.8.0; extra == 'pin'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_ohne_pin_wird_NICHT_geflaggt(monkeypatch):
    """Verlangt das installierte yt-dlp gar kein ejs, gibt es nichts auszurichten.

    Der Rueckfall muss hier nach FALSE gehen, und das ist die wichtigste Zeile dieses
    Blocks: ein faelschlich gesetztes True liefe in ein pip, das den Zustand nicht aendert
    — also jeden Tag aufs Neue, dauerhaft und ohne dass es je gruen wird. Die Bremse aus
    #179 deckelt das auf einmal taeglich, sie beendet es nicht."""
    _metadaten(monkeypatch, "0.8.0", ["requests; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False
    _metadaten(monkeypatch, "0.8.0", None)          # yt-dlp deklariert gar nichts
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_pin_ohne_exakte_bindung_wird_NICHT_geflaggt(monkeypatch):
    """Nur `==` ist eine Aussage, die sich billig vergleichen laesst. Bei `>=` waere jede
    Antwort geraten — und Raten kostet hier ein taegliches pip ohne Ende (s. o.).

    Die Fassungen muessen hier AUSEINANDERGEHEN (0.8.0 installiert, 0.9.0 gefordert): mit
    `>=0.8.0` war der Test vacuous — beide Seiten gleich, also lieferte auch eine Regex, die
    `>=` faelschlich frisst, brav False. Die Mutationsprobe fand genau das (die gelockerte
    Regex liess alle 37 Tests gruen). Jetzt ist die `==`-Bindung das EINZIGE, was hier noch
    False erzeugen kann."""
    _metadaten(monkeypatch, "0.8.0", ["yt-dlp-ejs>=0.9.0; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False


@pytest.mark.parametrize("name", ["yt_dlp_ejs", "YT-DLP-EJS", "Yt_Dlp_Ejs"])
def test_pin_auch_in_abweichender_schreibweise(monkeypatch, name):
    """Vorsorge, kein beobachteter Fall — und deshalb hier festgehalten statt ungetestet
    im Code: gemessen steht in yt-dlps METADATA die kleingeschriebene Bindestrich-Form.
    PEP 503 vergleicht Paketnamen aber ohne Ruecksicht auf Trennzeichen UND Schreibung, ein
    anderes Build-Backend duerfte also `yt_dlp_ejs` oder `YT-DLP-EJS` schreiben.

    Ohne die Toleranz faende die Regex nichts, `_ejs_pin()` gaebe None, und die Pruefung
    fiele nach fail-open — also STILL — in genau den Fehler zurueck, gegen den sie gebaut
    ist. Die Regex liegt hier immer nach derselben stillen Seite falsch; das ist der Grund,
    beide Toleranzen zu behalten statt sie als spekulativ zu streichen."""
    _metadaten(monkeypatch, "0.8.0", [f"{name}==0.9.0; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is True


@pytest.mark.parametrize("pin, warum", [
    ("0.8.*", "Praefix-Bindung — pip erfuellt sie mit 0.8.0, der Vergleich nie"),
    ("=0.8.0", "aus `===0.8.0` (willkuerliche Gleichheit), fuehrendes ="),
    ("0.8.0.post1", "keine reine Zahlenfolge"),
    ("0.8²", "hochgestellte Ziffer: isdigit() sagt JA, int() wirft"),
    ("0.-8", "int() nimmt '-8' KLAGLOS — ohne isdecimal() waere das (0, -8)"),
    ("0.+8", "dito fuer '+8'"),
])
def test_nicht_vergleichbarer_pin_wird_NICHT_geflaggt(monkeypatch, pin, warum):
    """Ein Pin, dessen Text nie mit einer installierten Fassung uebereinstimmen KANN, ist
    schlimmer als gar keiner: `pin != da` waere dauerhaft wahr, `faellig()` jeden Tag True,
    und pip liefe taeglich, ohne den Flag je zu loeschen. Genau der nicht-konvergierende
    Dauerlauf, den `_ejs_untauglich` im Docstring ausschliesst.

    PEP 440 erlaubt diese Formen — gemessen an der echten Regex ergaben alle drei einen
    dauerhaften Unterschied gegen ein installiertes `0.8.0`. Also: nur eine reine
    Zahlenfolge ist eine vergleichbare Aussage, alles andere faellt nach fail-open.
    """
    _metadaten(monkeypatch, "0.8.0", [f"yt-dlp-ejs=={pin}; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False, warum


def test_kurzer_pin_ist_gleichwertig(monkeypatch):
    """`0.8` und `0.8.0` sind dieselbe Fassung — als Zeichenketten aber nicht. Verglichen
    werden deshalb aufgefuellte Zahlenfolgen, sonst liefe auch hier ein pip taeglich ins
    Leere (pip haelt `==0.8` mit 0.8.0 fuer erfuellt)."""
    _metadaten(monkeypatch, "0.8.0", ["yt-dlp-ejs==0.8; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_pin_aus_einem_FREMDEN_extra_zaehlt_nicht(monkeypatch):
    """Wir installieren `yt-dlp[default]` — also gilt der Pin aus `extra == 'default'`.
    yt-dlp fuehrt daneben ein `pin`-Extra (seine Sperrliste, die JEDE Abhaengigkeit exakt
    nagelt). Heute sagen beide 0.8.0, der Unterschied ist also folgenlos.

    Lockert yt-dlp aber irgendwann nur `default`, wird er es: die gelockerte Zeile hat kein
    `==`, die Regex ueberspringt sie, und ohne diese Pruefung naehme `_ejs_pin()` den exakten
    Wert aus `pin`. Ein Nutzer mit dem voellig regelkonformen 0.8.1 gaelte dann als
    untauglich — und `pip install -U yt-dlp[default]` loest `>=0.8.0,<0.9` auf und LAESST
    0.8.1 stehen. Der Flag ginge nie weg: taegliches pip ohne Ende, genau das Verbot aus
    `_ejs_untauglich`. (Nachgemessen an der echten Regex mit genau diesen zwei Zeilen.)
    """
    _metadaten(monkeypatch, "0.8.1", ["yt-dlp-ejs>=0.8.0,<0.9; extra == 'default'",
                                      "yt-dlp-ejs==0.8.0; extra == 'pin'"])
    assert yu._ejs_pin() is None
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_pin_kommt_aus_YT_DLPS_metadaten(monkeypatch):
    """Gefragt wird `requires("yt-dlp")` — wer hier `_EJS` einsetzt, liest ejs' EIGENE
    Anforderungen, faende nichts, bekaeme None, und die ganze #182-Pruefung fiele STILL
    nach fail-open aus. Ohne diese Zusicherung blieben alle 47 Tests dabei gruen (gemessen);
    dieselbe Luecke wie beim Distributionsnamen in `_ejs_untauglich` an PR #180."""
    gerufen = []
    monkeypatch.setattr(yu.metadata, "requires",
                        lambda name: gerufen.append(name) or ["yt-dlp-ejs==0.8.0; extra == 'default'"])
    assert yu._ejs_pin() == "0.8.0"
    assert gerufen == ["yt-dlp"]


def test_UNERFUELLTER_zusatzmarker_gilt_nicht(monkeypatch):
    """Ein Zusatzmarker, den DIESE Installation nicht erfuellt, darf nicht zaehlen.

    Schriebe yt-dlp `extra == 'default' and python_version >= "3.99"`, installierte pip hier
    weiter 0.8.0, waehrend wir 0.9.0 als gefordert laesen: Dauer-True, und
    `pip install -U yt-dlp[default]` KANN daran nichts aendern — taegliches pip ohne Ende,
    genau das Verbot aus `_ejs_untauglich`.

    `>= "3.99"` statt des naheliegenden `>= "3.14"`: der Marker muss auf JEDEM Laeufer
    unerfuellt sein. Mit 3.14 pruefte dieser Test auf einem 3.14-Interpreter still das
    Gegenteil — dieselbe Falle wie ein Schwellwert, der an der Attrappe kalibriert wurde."""
    _metadaten(monkeypatch, "0.8.0",
               ['yt-dlp-ejs==0.9.0; extra == \'default\' and python_version >= "3.99"'])
    assert yu._ejs_pin() is None
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_ERFUELLTER_zusatzmarker_gilt(monkeypatch):
    """#187: `extra == 'default' and python_version >= "3.0"` installiert pip hier sehr wohl.

    Vor der Marker-Auswertung fiel diese Zeile nach fail-open — und damit fielen BEIDE Fragen
    still aus: `_ejs_pin()` lieferte None (#182 aus) und `_ejs_verlangt()` False (#179 aus),
    bis der 14-Tage-Kalender griff. `>= "3.0"` ist auf jedem Python 3 erfuellt, der Test haengt
    also nicht am Laeufer."""
    _metadaten(monkeypatch, "0.8.0",
               ['yt-dlp-ejs==0.9.0; extra == \'default\' and python_version >= "3.0"'])
    assert yu._ejs_pin() == "0.9.0"


def test_ohne_packaging_bleibt_die_strikte_regel(monkeypatch):
    """Faellt der Import weg, gilt wieder genau `extra == 'default'` — und nichts daneben.

    Der Zweig ist sonst unerreichbar (packaging liegt in der requirements.txt UND bringt pytest
    selbst mit), also hier ausdruecklich gefahren: ein Rueckfall, den kein Test je ausuebt,
    ist eine Behauptung.

    **Die doppelten Anfuehrungszeichen gehoeren HIERHIN**, seit der Marker ausgewertet wird:
    `extra == "default"` beantwortet `evaluate()` jetzt selbst, die Regex sieht es nie mehr —
    die `['\"]`-Alternative in `_NUR_DEFAULT_RE` haette sonst wieder null Abdeckung
    (mutationsgeprueft: `['\"]` -> `[']` liess vorher ALLE 88 Tests gruen). Genau dieselbe
    Regex stand schon einmal ungewacht da, PR #183 hat ihr den Test gegeben."""
    monkeypatch.setattr(yu, "_Marker", None)
    assert yu._gilt_fuer_uns("yt-dlp-ejs==0.9.0; extra == 'default'") is True
    assert yu._gilt_fuer_uns('yt-dlp-ejs==0.9.0; extra == "default"') is True
    assert yu._gilt_fuer_uns('yt-dlp-ejs==0.9.0; extra == \'default\' and python_version >= "3.0"') is False
    assert yu._gilt_fuer_uns("yt-dlp-ejs==0.9.0") is True


def test_unverstaendlicher_marker_faellt_auf_die_strikte_regel():
    """`packaging` wirft bei kaputter Syntax — das darf nicht aus `faellig()` herausfliegen."""
    assert yu._gilt_fuer_uns("yt-dlp-ejs==0.9.0; extra == = 'default'") is False


def test_unlesbarer_marker_wird_GEMELDET(capsys):
    """Der Rueckfall ist richtig, aber er darf nicht still sein.

    Was hier durchfaellt, ist die Nachricht „unser Lesen der yt-dlp-Metadaten passt nicht mehr
    zur Wirklichkeit" — die Klasse, fuer die #179/#182/#184 gebaut wurden. Ohne Zeile faellt
    sie bis zum 14-Tage-Kalender durch, ohne dass irgendwo etwas davon steht.

    Der Test steht hier, weil die Mutationsprobe ihn eingefordert hat: die Meldung zu
    entfernen liess vorher alle 90 Tests gruen."""
    yu._gilt_fuer_uns("yt-dlp-ejs==0.9.0; extra == = 'default'")
    aus = capsys.readouterr().out
    assert "Marker unlesbar" in aus
    assert "extra == = 'default'" in aus, "der Marker selbst gehoert hinein, sonst ist er nicht auffindbar"
    assert "InvalidMarker" in aus, "der Ausnahmetyp gehoert hinein — er nennt die Ursache"


def test_gueltiger_aber_UNGESETZTER_marker_wirft_nicht():
    """Der zweite Wurfweg, und der wahrscheinlichere — er begruendet die Weite des `except`.

    `extras` und `dependency_groups` sind GUELTIGE PEP-508-Variablen, im Kontext "metadata"
    aber nicht gesetzt: packaging wirft dort einen blanken `KeyError` (gemessen an 26.2), also
    KEINEN `InvalidMarker`. Wer das `except Exception` spaeter auf die Marker-Ausnahmen
    verengt, zerlegt damit `fetch._hole_yt_dlp()` (#185) — dieser Test haelt das fest."""
    assert yu._gilt_fuer_uns('yt-dlp-ejs==0.9.0; extras == "default"') is False
    assert yu._gilt_fuer_uns('yt-dlp-ejs==0.9.0; dependency_groups == "default"') is False


@pytest.mark.parametrize("marker", ['extra == "default"', "EXTRA == 'DEFAULT'",
                                    "extra=='default'"])
def test_marker_auch_in_abweichender_schreibweise(monkeypatch, marker):
    """Dieselbe Vorsorge wie beim Paketnamen — und aus demselben Grund getestet statt nur
    behauptet: `_NUR_DEFAULT_RE` traegt `['\\"]` und `IGNORECASE`, beide hatten NULL
    Abdeckung. Gemessen: die Regex auf einfache Anfuehrungszeichen verengt liess alle 50
    Tests gruen, `IGNORECASE` entfernt ebenfalls.

    **Seit #187 deckt dieser Test nur noch `IGNORECASE`.** `extra == "default"` beantwortet
    `evaluate()` selbst, die Regex sieht es hier nicht mehr — die `['\\"]`-Alternative haengt
    seitdem allein an `test_ohne_packaging_bleibt_die_strikte_regel` (auch das gemessen: die
    Alternative verengt, 88 Tests gruen). Die grossgeschriebene Fassung kommt weiter hier an,
    weil packaging sie als `InvalidMarker` ablehnt und der Rueckfall greift.

    Die Fehlrichtung ist die stille: schriebe ein Build-Backend `extra == "default"`, gaebe
    `_gilt_fuer_uns` False, `_ejs_pin()` None, und die ganze #182-Pruefung fiele lautlos aus
    — ohne Logzeile, ohne roten Test. Beim Paketnamen zwei Zeilen darueber steht genau dieses
    Argument; bei der Schwesterregex war es nicht mitgezogen worden.
    """
    _metadaten(monkeypatch, "0.8.0", [f"yt-dlp-ejs==0.9.0; {marker}"])
    assert _ECHTES_EJS_UNTAUGLICH() is True


def test_release_wirft_nicht_bei_absurd_langer_zahl():
    """`isdecimal()` garantiert KEIN gelingendes `int()`: ab `sys.get_int_max_str_digits()`
    (Default 4300) wirft `int()` auch bei lauter Dezimalziffern — gemessen mit 5000 Ziffern,
    „Exceeds the limit (4300 digits)". Der Kommentar im Code behauptete das Gegenteil.

    Ohne das `try/except` riss die Ausnahme den ganzen URL-Import ab: `_release` ->
    `_ejs_untauglich` -> `faellig` -> `automatisch` -> `fetch._hole_yt_dlp()`, und dort gibt
    es keinen Schutz. Best effort heisst, dass hier nichts fliegt.
    """
    assert yu._release("0." + "1" * 5000) is None


def test_das_gepruefte_extra_ist_das_installierte():
    """`_PAKET` bestimmt, welches Extra pip installiert; die Frage an den Marker bestimmt,
    welchem Extra-Pin wir glauben. Beide muessen dasselbe Extra nennen.

    **Seit #187 ist das keine Behauptung mehr, sondern gebaut:** beide kommen aus
    `_UNSER_EXTRA`. Der Waechter prueft deshalb jetzt die ZUSAMMENSETZUNG — vorher stand hier
    `_NUR_DEFAULT_RE`, das auf dem lebenden Pfad gar nicht mehr entscheidet (der Vergleich
    liegt im `evaluate`-Aufruf). Ein Waechter, der auf die falsche Stelle zeigt, ist Deko.

    Auf Gleichheit, nicht auf Teilstring: `"default" in "yt-dlp[default,pin]"` waere wahr, und
    genau dann laege der Fall vor, den der Waechter melden soll — pip installierte zwei Extras,
    geglaubt wuerde weiterhin nur dem `default`-Pin. Ein Waechter, der bei der Aenderung
    schweigt, fuer die es ihn gibt, ist Deko (CodeRabbit an PR #183)."""
    assert yu._PAKET == f"yt-dlp[{yu._UNSER_EXTRA}]"
    assert yu._PAKET == "yt-dlp[default]"
    # Die Frage an den Marker nimmt DASSELBE Extra — sonst laege der Pin einer anderen
    # Variante zugrunde als der, die pip installiert.
    assert yu._gilt_fuer_uns(f"yt-dlp-ejs==0.9.0; extra == '{yu._UNSER_EXTRA}'") is True


def test_fremdes_paket_mit_passendem_namensende_zaehlt_nicht(monkeypatch):
    """Der Name muss die Zeile ANFANGEN. Ungeankert las `search` aus
    `my-yt-dlp-ejs==0.9.0` brav `0.9.0` als geforderten ejs-Pin (gemessen) — ein fremdes
    Paket haette damit den Flag gesetzt, und `pip install -U yt-dlp[default]` haette ihn nie
    geloescht. Wieder derselbe Dauerlauf."""
    _metadaten(monkeypatch, "0.8.0", ["my-yt-dlp-ejs==0.9.0; extra == 'default'"])
    assert yu._ejs_pin() is None
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_pin_ohne_extra_marker_gilt(monkeypatch):
    """Gegenprobe zur Zeile darueber — sonst waere die Wache zu scharf: eine Anforderung
    ganz OHNE `extra`-Marker ist eine harte Abhaengigkeit von yt-dlp und gilt fuer jede
    Installation, also auch fuer unsere."""
    _metadaten(monkeypatch, "0.8.0", ["yt-dlp-ejs==0.9.0"])
    assert yu._ejs_pin() == "0.9.0"
    assert _ECHTES_EJS_UNTAUGLICH() is True


def test_fehlendes_ejs_schlaegt_den_pin(monkeypatch):
    """#179 bleibt gueltig: ist das Paket gar nicht da, zaehlt kein Pin mehr."""
    def fehlt(name):
        raise yu.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(yu.metadata, "version", fehlt)
    monkeypatch.setattr(yu.metadata, "requires", lambda name: ["yt-dlp-ejs==0.8.0"])
    assert _ECHTES_EJS_UNTAUGLICH() is True


# --- Fehlt es, muss yt-dlp es ueberhaupt verlangen (#184) --------------------

def _ohne_ejs(monkeypatch, requires):
    """ejs ist NICHT installiert; yt-dlp deklariert `requires`.

    Beide Attrappen pruefen den Distributionsnamen und scheitern sonst — eine Attrappe, die
    JEDEN Namen annimmt, bliebe auch dann gruen, wenn der Code das falsche Paket abfragt
    (genau die Luecke, die CodeRabbit an PR #180 beim Distributionsnamen fand).
    """
    def fassung(name):
        if name == "yt-dlp-ejs":
            raise yu.metadata.PackageNotFoundError(name)
        assert name == "yt-dlp", f"unerwartet nach der Fassung von {name!r} gefragt"
        return "2026.8.12"

    def gefordert(name):
        assert name == "yt-dlp", f"unerwartet nach den Anforderungen von {name!r} gefragt"
        return requires

    monkeypatch.setattr(yu.metadata, "version", fassung)
    monkeypatch.setattr(yu.metadata, "requires", gefordert)


def test_ohne_ejs_anforderung_kein_flag(monkeypatch):
    """#184: verlangt das installierte yt-dlp gar kein ejs, gibt es nichts auszurichten.

    Vorher flaggte der „gar nicht da"-Zweig bedingungslos — als einziger Zweig umging er die
    Regel, die der Rest der Funktion durchsetzt. Die Folge war der Dauerlauf, den dieses Modul
    ueberall sonst vermeidet: `pip install -U yt-dlp[default]` warnt bei einem yt-dlp ohne
    dieses Extra nur („does not provide the extra") und endet mit 0 — ejs kommt nie, der Flag
    ginge nie weg."""
    _ohne_ejs(monkeypatch, ["requests; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False
    _ohne_ejs(monkeypatch, None)
    assert _ECHTES_EJS_UNTAUGLICH() is False


@pytest.mark.parametrize("spec", ["==0.8.0", ">=0.8.0", ">=0.8.0,<0.9", "~=0.8.0", ""])
def test_fehlendes_ejs_bleibt_geflaggt_bei_JEDEM_specifier(monkeypatch, spec):
    """Der Kern von #184 und zugleich seine Falle. Der naheliegende Einzeiler
    (`_ejs_pin() is not None` als Vorbedingung) haette #179 an die bewusst enge `==`-Regel
    aus #182 gekoppelt — bei einem gelockerten Pin faende `_ejs_pin()` nichts, und ein
    WIRKLICH fehlendes ejs waere still nicht mehr erkannt worden.

    Deshalb eine zweite, schwaechere Frage: „verlangt yt-dlp ejs ueberhaupt?" — Name und
    Extra-Marker, ohne jede Bedingung an den Specifier."""
    _ohne_ejs(monkeypatch, [f"yt-dlp-ejs{spec}; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is True


def test_fehlendes_ejs_nur_in_FREMDEM_extra_zaehlt_nicht(monkeypatch):
    """Steht die Anforderung nur unter einem Extra, das wir nicht installieren, holt unser
    `pip install -U yt-dlp[default]` das Paket auch nicht — flaggen waere wieder ein Flag
    ohne Ende. Dieselbe Regel wie beim Pin."""
    _ohne_ejs(monkeypatch, ["yt-dlp-ejs==0.8.0; extra == 'pin'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_fremdes_paket_zaehlt_auch_beim_FEHLEN_nicht(monkeypatch):
    """`my-yt-dlp-ejs` ist nicht unser Paket — auch nicht in der schwaecheren Frage."""
    _ohne_ejs(monkeypatch, ["my-yt-dlp-ejs==0.8.0; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False


@pytest.mark.parametrize("name", ["yt-dlp-ejs2", "yt-dlp-ejs-extra", "yt-dlp-ejs.deno"])
def test_geschwisterpaket_zaehlt_nicht(monkeypatch, name):
    """Der Anker schuetzt den Zeilenanfang, `(?![\\w.-])` das Ende.

    Mit `\\b` — dem ersten Versuch — kamen `yt-dlp-ejs-extra` und `yt-dlp-ejs.deno` als
    „unser Paket" durch (gemessen): `\\b` trennt nur gegen WORTzeichen, `-` und `.` sind
    keine. Verlangte ein kuenftiges yt-dlp so ein Geschwisterpaket statt `yt-dlp-ejs`, holte
    `pip install -U yt-dlp[default]` das Geschwister und nie ejs — ein Flag ohne Ende, also
    die verbotene Richtung. Nur der Ziffernfall (`…ejs2`) war schon vorher richtig.
    """
    _ohne_ejs(monkeypatch, [f"{name}==0.9.0; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_paket_mit_extra_in_klammern_zaehlt_MIT(monkeypatch):
    """Gegenprobe zur Zeile darueber — sonst waere die Wache zu scharf: `yt-dlp-ejs[deno]`
    ist dasselbe Paket mit Extra und muss durchkommen. Deshalb steht `[` nicht in der
    verbotenen Zeichenklasse."""
    _ohne_ejs(monkeypatch, ["yt-dlp-ejs[deno]==0.9.0; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is True


@pytest.mark.parametrize("name", ["yt.dlp.ejs", "yt_dlp_ejs", "yt__dlp..ejs", "yt---dlp___ejs"])
def test_pep503_schreibweisen_zaehlen_MIT(monkeypatch, name):
    """PEP 503 normalisiert **Laeufe** aus `-`, `_` und `.` auf ein einzelnes `-` — alle vier
    sind derselbe Projektname wie `yt-dlp-ejs`.

    Zwei Schritte, beide aus Reviews: der Punkt fehlte zuerst ganz (die Begruendung im Code
    fuehrte PEP 503 an und liess ein Drittel davon weg), danach traf die Klasse nur EIN
    Trennzeichen. In beiden Faellen fielen die Fragen bei diesen Schreibweisen STILL nach
    fail-open."""
    _ohne_ejs(monkeypatch, [f"{name}==0.9.0; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is True


def test_name_ohne_trennzeichen_zaehlt_NICHT(monkeypatch):
    """Gegenprobe zum `+`: `ytdlpejs` ist NICHT derselbe Projektname — PEP 503 laesst Laeufe
    zusammenfallen, es entfernt sie nicht. Ohne diese Zeile koennte man `[-_.]*` schreiben
    und haette die Wache still aufgeweicht."""
    _ohne_ejs(monkeypatch, ["ytdlpejs==0.9.0; extra == 'default'"])
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_unerfuellter_zusatzmarker_macht_das_FEHLEN_nicht_faellig(monkeypatch):
    """Die teure Richtung auf dem `_ejs_verlangt`-Pfad, mit eigenem Anker.

    Ein Marker, den DIESE Installation nicht erfuellt, darf das Fehlen nicht faellig machen:
    pip installierte das Paket hier nie, das Flag ginge also nie wieder weg — taegliches pip
    ohne Ende. Steht als eigener Test da, obwohl `_gilt_fuer_uns` geteilt ist: dieser Pfad ist
    der mit den umgekehrten Kosten, und ein geteilter Helfer kann aufgeteilt werden."""
    _ohne_ejs(monkeypatch,
              ['yt-dlp-ejs==0.8.0; extra == \'default\' and python_version >= "3.99"'])
    assert _ECHTES_EJS_UNTAUGLICH() is False


def test_erfuellter_zusatzmarker_macht_auch_das_FEHLEN_faellig(monkeypatch):
    """Die Gegenrichtung von #187, auf dem zweiten Pfad: `_ejs_verlangt`.

    Bis #187 fiel diese Zeile nach fail-open, und #179 blieb fuer die betroffene
    Installation still aus — obwohl pip `yt-dlp-ejs` auf jedem unterstuetzten Python
    installiert haette. Der geteilte `_gilt_fuer_uns` dreht jetzt beide Pfade gemeinsam."""
    _ohne_ejs(monkeypatch,
              ['yt-dlp-ejs==0.8.0; extra == \'default\' and python_version >= "3.0"'])
    assert _ECHTES_EJS_UNTAUGLICH() is True


def test_pin_regex_bindet_an_den_zeilenanfang():
    """`_EJS_PIN_RE` DIREKT geprueft, nicht ueber `_ejs_pin()` — dort filtert `_ejs_zeilen()`
    vorher an `_EJS_NAME_RE`, der Anker waere ueber `_ejs_pin()` also nicht erreichbar und
    bliebe eine Wache ohne roten Test (gemessen: mit beiden Ankern bleibt alles gruen).

    Er kann etwas, was die Namensfilterung nicht abdeckt — den Pin an den ZEILENANFANG binden
    statt nur an die richtige Zeile. Beide Formen unten lieferten ohne ihn einen Pin."""
    assert yu._EJS_PIN_RE.search(
        "yt-dlp-ejs@ file:///pkgs/yt-dlp-ejs==0.8.1; extra == 'default'") is None
    assert yu._EJS_PIN_RE.search(
        "yt-dlp-ejs; extra == 'default' or yt-dlp-ejs==0.9.0") is None
    assert yu._EJS_PIN_RE.search("yt-dlp-ejs==0.8.0; extra == 'default'").group(1) == "0.8.0"


def test_klammerformen_liefern_bewusst_KEINEN_pin():
    """Die dokumentierte Asymmetrie, hier festgenagelt: `yt-dlp-ejs[deno]` und die
    geklammerte `Requires-Dist:`-Form aelterer setuptools zaehlen fuer `_EJS_NAME_RE` als
    unser Paket (also fuer #179), liefern aber KEINEN Pin (also kein #182). Das ist sicher —
    fail-open kostet hoechstens eine verspaetete Erkennung — und billiger als eine Regex, die
    beide Klammerformen mitfuehrt, solange yt-dlp keine davon schreibt.

    Ohne diesen Test verschoebe eine spaetere Erweiterung von `_EJS_PIN_RE` die
    #182-Erkennung **still**, und nichts wuerde rot. Dieselbe Luecke, fuer die eine Zeile
    weiter oben `test_pin_regex_bindet_an_den_zeilenanfang` gebaut wurde."""
    assert yu._EJS_NAME_RE.search("yt-dlp-ejs[deno]==0.9.0; extra == 'default'")
    assert yu._EJS_PIN_RE.search("yt-dlp-ejs[deno]==0.9.0; extra == 'default'") is None
    assert yu._EJS_NAME_RE.search("yt-dlp-ejs (==0.9.0); extra == 'default'")
    assert yu._EJS_PIN_RE.search("yt-dlp-ejs (==0.9.0); extra == 'default'") is None


# Die Kette „untauglich -> faellig, trotz frischer yt-dlp-Fassung" steht bereits in
# `test_fehlende_loeserskripte_machen_faellig` — sie haengt an `_ejs_untauglich`, nicht am
# GRUND der Untauglichkeit. Ein zweiter Test mit identischer Zusicherung waere Deko.


# --- Kaputte Metadaten reissen den Aufrufer nicht mit (#185) -----------------

def _unlesbar(gerufen):
    """Attrappe, die wirft, was `importlib.metadata` bei einer nicht als UTF-8 dekodierbaren
    METADATA wirft — KEIN PackageNotFoundError, genau darum ging es.

    Der Distributionsname wird **gesammelt und danach geprueft**, nicht per `assert` IM Stub
    (Konvention aus 4c3abbd, aber in dieser anderen Form). Ein `assert` liefe hier ins Leere:
    er stuende INNERHALB des `try`, um das dieser PR gerade `except Exception` legt — der
    AssertionError wuerde also von der gepruefteten Wache selbst geschluckt. Gemessen: mit einem
    `assert` im Stub blieb der Test gruen, obwohl `fassung()` mutiert das falsche Paket
    abfragte, und rot wurde nur ein entfernter Alt-Test.
    """
    def lesen(name):
        gerufen.append(name)
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")

    return lesen


def test_unlesbare_fassung_wirft_nicht(monkeypatch, capsys):
    """`fassung()` haengt an DREI HTTP-Handlern (`zustand()`) und an `fetch._hole_yt_dlp()`,
    das keinen Schutz hat. Ungefangen waere das eine 500er-Einstellungsseite bzw. ein
    abgerissener URL-Import — statt des im Modul-Docstring zugesagten best effort.

    Unbekannt heisst „nicht installiert", und damit NICHT faellig: ein pip auf Verdacht
    liefe hier taeglich, ohne den Zustand zu aendern."""
    gerufen = []
    monkeypatch.setattr(yu.metadata, "version", _unlesbar(gerufen))
    assert yu.fassung() is None
    assert yu.faellig() is False
    assert "unlesbar" in capsys.readouterr().out
    assert gerufen and set(gerufen) == {"yt-dlp"}     # nicht irgendein Paket, DAS richtige


def test_unlesbare_anforderungen_werfen_nicht(monkeypatch, capsys):
    """Zweite Lesestelle (`metadata.requires`). Fail-open wie beim fehlenden Pin: keine
    Zeilen heisst kein #182 und kein #184, der Kalenderweg entscheidet wie bisher.

    Die Protokollzeile wird MITgeprueft: die Hausregel „ein `except Exception` darf keinen
    echten Programmierfehler ohne Protokoll verschlucken" haengt sonst an einem Waechter ohne
    roten Test (gemessen: ohne die Zusicherung blieb das Entfernen der `print`-Zeile gruen)."""
    gefragt, gerufen = [], []
    monkeypatch.setattr(yu.metadata, "version",
                        lambda name: gefragt.append(name) or "0.8.0")
    monkeypatch.setattr(yu.metadata, "requires", _unlesbar(gerufen))
    assert _ECHTES_EJS_UNTAUGLICH() is False
    assert yu._ejs_pin() is None
    assert yu._ejs_verlangt() is False
    assert gefragt == [yu._EJS] and set(gerufen) == {"yt-dlp"}
    assert "Anforderungen von yt-dlp unlesbar" in capsys.readouterr().out


def test_nicht_string_anforderungen_werfen_nicht(monkeypatch):
    """Die Filterung gehoert INS `try`. Stand sie darunter, lag sie hinter allen
    `except`-Zweigen: `_EJS_NAME_RE.search(None)` wirft `TypeError` an der Wache vorbei, quer
    durch `faellig()` bis aus `automatisch()` heraus — genau der Weg, den #185 schliesst.

    Konstruiert, nicht beobachtet: `metadata.requires()` liefert `list[str] | None`. Der Test
    steht trotzdem da, weil die Einrueckung sonst eine Aenderung ohne roten Test waere.

    Zwei Vorkehrungen, damit `automatisch()` wirklich das prueft, was hier gemeint ist:
    yt-dlp bekommt eine FRISCHE Fassung (`0.8.0` waere als Datum unlesbar -> faellig -> der
    Lauf liefe in ein pip und damit in den `pytest.fail`-Riegel der Fixture), und die Fixture-
    Attrappe fuer `_ejs_untauglich` wird zurueckgenommen — sonst kaeme `faellig()` gar nicht
    an `_ejs_zeilen()` vorbei, und die Zeile darunter waere vacuous."""
    monkeypatch.setattr(yu, "_ejs_untauglich", _ECHTES_EJS_UNTAUGLICH)
    monkeypatch.setattr(yu.metadata, "version",
                        lambda name: "0.8.0" if name == yu._EJS else HEUTE.isoformat().replace("-", "."))
    monkeypatch.setattr(yu.metadata, "requires", lambda name: [None, 42])
    assert yu._ejs_zeilen() == []
    assert _ECHTES_EJS_UNTAUGLICH() is False
    assert yu.automatisch() is False        # der Weg, um den es geht: bis nach draussen


def test_unlesbares_ejs_wird_NICHT_geflaggt(monkeypatch, capsys):
    """Die dritte Lesestelle faellt in die ANDERE Richtung — das ist der Kern von #185.

    Der `PackageNotFoundError`-Zweig daneben flaggt (ueber `_ejs_verlangt`), weil „nicht
    installiert" eine Tatsache ist. Eine unlesbare METADATA ist dagegen nur „unbekannt", und
    Unbekanntes flaggt dieses Modul nicht: ob ein pip die kaputte Datei ueberhaupt ersetzt,
    ist offen — bleibt sie liegen, laeuft das taegliche pip dauerhaft weiter.

    yt-dlp verlangt hier ausdruecklich ejs, `_ejs_verlangt()` waere also True. Wer den neuen
    Zweig auf `return _ejs_verlangt()` umschreibt, macht genau diesen Test rot."""
    gefragt, gerufen = [], []

    def fassung(name):
        if name == yu._EJS:
            return _unlesbar(gerufen)(name)
        gefragt.append(name)
        return "2026.7.4"

    monkeypatch.setattr(yu.metadata, "version", fassung)
    monkeypatch.setattr(yu.metadata, "requires",
                        lambda name: gefragt.append(name) or
                        ["yt-dlp-ejs==0.8.0; extra == 'default'"])
    assert yu._ejs_verlangt() is True          # Positivkontrolle: der Flag WAERE erreichbar
    assert _ECHTES_EJS_UNTAUGLICH() is False
    assert gerufen == [yu._EJS] and set(gefragt) == {"yt-dlp"}
    # Wie oben: ohne diese Zeile ist die Protokollzeile eine Wache ohne roten Test.
    assert f"Metadaten von {yu._EJS} unlesbar" in capsys.readouterr().out


# --- Schalter ----------------------------------------------------------------

def test_einstellung_schaltet_ab():
    settings.save({"ytdlp_auto": "0"})
    assert yu.auto_an() is False


def test_env_gewinnt_gegen_die_einstellung(monkeypatch):
    """Wie job_env(): wer die Variable gesetzt hat (.env, CI), soll sie behalten."""
    settings.save({"ytdlp_auto": "0"})
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "1")
    assert yu.auto_an() is True
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    settings.save({"ytdlp_auto": "1"})
    assert yu.auto_an() is False


def test_leere_env_variable_ist_KEIN_override(monkeypatch):
    """`settings.load_env()` schreibt eine Zeile `TRANSKRIBOR_YTDLP_UPDATE=` als LEEREN
    String in die Umgebung. `os.environ.get` liefert dann "" statt None — ein `is None`-Test
    haelt das faelschlich fuer ein gesetztes JA, und wer den Haken im Browser abwaehlt,
    bekaeme weiter Updates plus die Meldung, eine leer gelassene Variable sei schuld."""
    settings.save({"ytdlp_auto": "0"})
    for leer in ("", "   "):
        monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", leer)
        assert yu.env_override() is None, repr(leer)
        assert yu.auto_an() is False, repr(leer)
        assert yu.zustand()["env"] is False, repr(leer)


# --- zustand()["unterbrochen"] (#262) ------------------------------------------

def test_zustand_meldet_einen_unterbrochenen_lauf(monkeypatch):
    """Der DRITTE `version: null`-Zustand (#262): Abbruch-Merker liegt, yt-dlp ist
    unbrauchbar — eine Reparatur steht beim naechsten Serverstart an. Ohne das Feld sagte
    die Seite „Nicht installiert" und schickte den Nutzer zu einer Neuinstallation, obwohl
    ein Neustart genuegt; die README leitet ihn bei einem fehlgeschlagenen Import
    ausdruecklich auf diese Seite.

    `_fassung_und_lesbarkeit` statt `fassung` patchen: es ist der Leser, den `zustand()`
    wirklich aufruft (drei Tests patchten frueher `fassung` und liefen ins Leere)."""
    monkeypatch.setattr(yu, "_fassung_und_lesbarkeit", lambda: (None, False))
    assert yu.zustand()["unterbrochen"] is False          # Negativkontrolle: kein Merker
    yu._pip_merker_setzen()
    assert yu.zustand()["unterbrochen"] is True


def test_zustand_meldet_den_MERKER_ALLEIN_nicht_als_unterbrochen(monkeypatch):
    """Die zweite Haelfte — und die, ohne die das Feld DAUERALARM waere. Seit #280 wird der
    Merker bei JEDEM Lauf neu datiert, auch im ejs-untauglichen Zustand (#179/#182: Fassung
    vorhanden, pip scheitert offline taeglich). Dort liegt der Merker also regelmaessig bei
    einer HEILEN Fassung — „eine Reparatur steht beim naechsten Start an" waere dort gelogen,
    `faellig()` feuert aus dem ejs-Zweig, nicht aus dem Merker-Zweig. Derselbe Schnitt wie
    dort: Beide Haelften, nicht der Merker allein."""
    monkeypatch.setattr(yu, "_fassung_und_lesbarkeit", lambda: ("2026.7.4", False))
    yu._pip_merker_setzen()
    assert yu.zustand()["unterbrochen"] is False


def test_zustand_liest_den_MERKER_NICHT_bei_vorhandener_fassung(monkeypatch):
    """Der Kurzschluss ist Teil des Vertrags, nicht Sparsamkeit: dieser Rumpf liegt auf dem
    1,5-s-Poll der Einstellungsseite (#262 nennt den Dateizugiff ausdruecklich), und der
    Merker-Leser ist ein `open()` mit O_NONBLOCK. Wird die Reihenfolge gedreht, zahlt jede
    Poll-Runde den Zugriff — dafuer steht hier ein Zaehler, nicht eine Stoppuhr."""
    gelesen = []
    monkeypatch.setattr(yu, "_pip_unterbrochen", lambda: gelesen.append(1) or True)
    monkeypatch.setattr(yu, "_fassung_und_lesbarkeit", lambda: ("2026.7.4", False))
    yu.zustand()
    assert gelesen == []                                   # nicht gelesen: Fassung steht
    monkeypatch.setattr(yu, "_fassung_und_lesbarkeit", lambda: (None, False))
    yu.zustand()
    assert gelesen == [1]                                  # gelesen, sobald es darauf ankommt


def test_zustand_meldet_das_override_selbst(monkeypatch):
    """Der Server sagt es, statt das Frontend `ytdlp_auto` gegen `auto` vergleichen zu
    lassen: die beiden kommen aus zwei Antworten, und dazwischen behauptete der Vergleich
    ein Override, das es nicht gibt."""
    settings.save({"ytdlp_auto": "1"})
    assert yu.zustand()["env"] is False
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    z = yu.zustand()
    assert z["env"] is True and z["auto"] is False


def test_abgeschaltet_laeuft_kein_pip(monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")        # waere faellig
    assert yu.automatisch() is False                              # das gefaelschte run() wuerde failen


# --- aktualisiere ------------------------------------------------------------

def test_pip_aktualisiert_NUR_yt_dlp(monkeypatch):
    """Nie ueber alle requirements: das erwischt irgendwann torch, und die GPU waere still
    weg (dieselbe Falle wie beim CPU-Rad in setup.js)."""
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    # `(ok, gehalten)` seit #236 — und `gehalten` gehoert in die Zusicherung: das Lock
    # liegt hier wirklich (tmp_path ist beschreibbar), ein `False` waere ein Befund.
    assert yu.aktualisiere() == (True, True)
    cmd = gerufen[0][0]
    assert cmd[:5] == [yu.sys.executable, "-m", "pip", "install", "-U"]
    assert [x for x in cmd if not x.startswith("-")][-1].startswith("yt-dlp")
    assert "-r" not in cmd and not any("requirement" in x for x in cmd)


def test_pip_hebt_die_loeserskripte_mit(monkeypatch):
    """#170: `pip install -U yt-dlp` OHNE das Extra haette yt-dlp gehoben und `yt-dlp-ejs` auf
    der alten Fassung stehenlassen — pip merkt sich Extras nicht. yt-dlp prueft Fassung und
    Hash der Loeserskripte gegen sein eigenes `vendor/_info.py` und verwirft die alten; die
    Warnung darueber schluckt `no_warnings` in fetch.py. Die Selbstaktualisierung haette den
    URL-Import damit STILL wieder auf den Stand vor diesem Fix gesetzt."""
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    assert "yt-dlp[default]" in gerufen[0][0]


def test_pip_bekommt_kurze_zeitlimits(monkeypatch):
    """Ohne Deckel haengt pip offline minutenlang — und der Import wartet solange."""
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    cmd, kwargs = gerufen[0]
    assert "--timeout" in cmd and "--retries" in cmd
    assert kwargs["timeout"] == yu.PIP_TIMEOUT


def test_aktualisiere_setzt_den_merker(monkeypatch):
    _, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    # ueber geprueft() gelesen, nicht die Datei direkt: die Zusicherung deckt setzen
    # UND lesen — seit #281 beides venv-lokal.
    assert yu.geprueft() == HEUTE


def test_merker_auch_nach_fehlschlag(monkeypatch):
    """Sonst liefe der naechste Import in denselben Timeout."""
    def kaputt(*a, **k):
        raise subprocess.TimeoutExpired("pip", 120)
    monkeypatch.setattr(yu.subprocess, "run", kaputt)
    assert yu.aktualisiere() == (False, True)
    assert yu.geprueft() == HEUTE


def test_pip_exitcode_ungleich_null_ist_kein_erfolg(monkeypatch):
    _, run = _pip(returncode=1, ausgabe="ERROR: Could not find a version")
    monkeypatch.setattr(yu.subprocess, "run", run)
    assert yu.aktualisiere() == (False, True)


def test_fehlschlag_wirft_nicht_und_wird_protokolliert(monkeypatch, capsys):
    """Best effort: ein Rechner ohne Netz darf durch dieses Feature nicht schlechter
    dastehen als vorher. Der Import laeuft danach mit der vorhandenen Fassung weiter."""
    def kaputt(*a, **k):
        raise OSError("kein Netz")
    monkeypatch.setattr(yu.subprocess, "run", kaputt)
    assert yu.aktualisiere() == (False, True)
    assert "ytdlp" in capsys.readouterr().out


def test_unanlegbares_sperrverzeichnis_bricht_nicht_ab(monkeypatch, capsys):
    """Der einzige Aufruf in diesem Modul, der frueher ungeschuetzt werfen konnte. Ein
    schreibgeschuetztes Profil (oder ein TRANSKRIBOR_SETTINGS ohne Verzeichnisanteil) haette
    den Import mitgerissen — genau das, was 'best effort, nie blockierend' ausschliesst.

    `yu.os` IST das `os`-Modul, der Patch wirkt also global: auch `settings.save()` im
    `_merken()` faellt damit aus. Das ist Absicht und macht die Probe haerter — geprueft wird,
    dass `aktualisiere()` **beide** Fehlschlaege ueberlebt und trotzdem True meldet. Die
    Sperre selbst braucht `os.mkdir`, nicht `makedirs`, wird hier also nicht angefasst; ihr
    eigener Fehlerpfad steht in `test_sperre.py`.
    """
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)

    def nein(*a, **k):
        raise OSError(13, "Permission denied")
    monkeypatch.setattr(yu.os, "makedirs", nein)
    assert yu.aktualisiere() == (True, True)    # pip laeuft trotzdem …
    assert len(gerufen) == 1
    assert "Sperrverzeichnis" in capsys.readouterr().out   # … und sagt es


def test_unschreibbare_einstellungsdatei_bricht_nicht_ab(monkeypatch):
    """Der Merker ist Buchhaltung, kein Ergebnis. Scheitert sein Schreiben, war das
    Update trotzdem erfolgreich — ein Fehler hier wuerde den Import mitreissen."""
    _, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)

    def nein(*a, **k):
        raise OSError("read-only")
    monkeypatch.setattr(yu.settings, "save", nein)
    assert yu.aktualisiere() == (True, True)


# --- automatisch (der Weg, den fetch.py geht) --------------------------------

def test_automatisch_ueberspringt_die_frische_fassung(monkeypatch):
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")
    assert yu.automatisch() is False        # das gefaelschte run() wuerde sonst failen


def test_erzwingen_uebergeht_den_merker(monkeypatch):
    """Die Selbstheilung greift genau dann, wenn gerade erst geprueft wurde: der Extraktor
    bricht ja nicht nach Kalender. Ein Merker-Respekt machte sie meistens wirkungslos."""
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")
    _kalender_merken(HEUTE.isoformat())
    assert yu.automatisch(erzwingen=True) is True
    assert len(gerufen) == 1


def test_automatisch_meldet_den_PIP_ausgang_nicht_den_sperrzustand(monkeypatch):
    """`automatisch()` gibt seit #236 `aktualisiere()[0]` zurueck — und der Index war
    ungewacht: kein Test unterschied ihn von `[1]`.

    Die vorhandenen Tests kommen alle nicht dorthin (zwei kehren an `auto_an()` um, zwei an
    `faellig()`, `test_fetch.py` faelscht `automatisch` selbst) — und der eine, der pip
    wirklich laufen laesst, liefert `(True, True)`, wo **beide** Indizes dasselbe sagen.
    Hier laufen sie auseinander: das Lock haelt, pip nicht.

    Was `[1]` kostete: `fetch.py` entscheidet an diesem Wert, ob es yt-dlp neu laedt und den
    Download wiederholt. Mit dem Sperrzustand statt dem pip-Ausgang uebersprungen es die
    Wiederholung ausgerechnet dann, wenn pip GELUNGEN ist — also im Normalfall.
    """
    _, run = _pip(returncode=1, ausgabe="ERROR: Could not find a version")
    monkeypatch.setattr(yu.subprocess, "run", run)
    assert yu.aktualisiere() == (False, True)      # Positivkontrolle: die Indizes SIND ungleich
    assert yu.automatisch(erzwingen=True) is False


def test_erzwingen_uebergeht_den_schalter_NICHT(monkeypatch):
    """Wer seine venv selbst verwaltet, will auch keine Selbstheilung darin."""
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    assert yu.automatisch(erzwingen=True) is False


# --- beim_start (der Weg, den app._lifespan geht — seit #253) -----------------

def test_beim_start_stoesst_einen_HINTERGRUND_lauf_an(monkeypatch):
    """Geprueft wird der WEG, nicht nur die Wirkung.

    `starte_hintergrund()` setzt `_lauf`, und daran haengt die Ausgangsmeldung der
    Einstellungsseite (#174/#243). Ein direktes `aktualisiere()` haette dieselbe Wirkung auf
    die venv, KEINE auf die Anzeige — und haette den Serverstart blockiert, was der ganze
    Grund fuer diesen Weg ist. Der `aktualisiere`-Riegel ist deshalb Teil der Zusicherung,
    nicht Deko.
    """
    gerufen = []
    monkeypatch.setattr(yu, "faellig", lambda: True)
    monkeypatch.setattr(yu, "starte_hintergrund", lambda **k: gerufen.append(k) or True)
    monkeypatch.setattr(yu, "aktualisiere",
                        lambda *a, **k: pytest.fail("beim Start laeuft pip im Faden, nicht hier"))
    assert yu.beim_start() is True
    # **Das Argument, nicht nur der Aufruf** (#254 Weg 3): ohne `nur_wenn_faellig` faellt die
    # Pruefung unter der Sperre aus, und der zweite Serverprozess macht wieder sein
    # „already satisfied"-pip. Ein Test, der nur den Aufruf zaehlt, bliebe dabei gruen — und
    # `beim_start`s `except Exception` verschluckt sogar einen Signaturfehler still (gemessen:
    # eine Attrappe ohne Parameter macht daraus ein stummes `False`).
    assert gerufen == [{"nur_wenn_faellig": True}]


def test_beim_start_respektiert_den_schalter(monkeypatch):
    """Wer seine venv selbst verwaltet, will auch beim Start kein pip."""
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    monkeypatch.setattr(yu, "faellig", lambda: True)      # Positivkontrolle: es waere faellig
    monkeypatch.setattr(yu, "starte_hintergrund",
                        lambda **k: pytest.fail("Schalter aus — kein Lauf beim Start"))
    assert yu.beim_start() is False


def test_beim_start_respektiert_die_faelligkeit(monkeypatch):
    """Sonst liefe bei JEDEM Serverstart ein pip — und die App startet oefter als alle
    14 Tage. Der Merker ist die Bremse, nicht die Gelegenheit."""
    monkeypatch.setattr(yu, "faellig", lambda: False)
    monkeypatch.setattr(yu, "starte_hintergrund",
                        lambda **k: pytest.fail("nicht faellig — kein Lauf beim Start"))
    assert yu.beim_start() is False


def test_beim_start_tritt_zurueck_wenn_schon_jemand_aktualisiert(monkeypatch, capsys):
    """Starten zwei Serverprozesse gleichzeitig (gepackte App neben Entwickler-Checkout,
    #254), sehen beide `faellig()` und starten je einen Lauf — der zweite sitzt bis zu 220 s
    an der Sperre ab und macht danach ein pip, das „already satisfied" meldet. Dieselbe
    Klasse wie #176, auf dem neuen Weg (CodeRabbit-Bot an PR #255).

    Advisory, keine Entscheidung im kritischen Abschnitt: verliert die Pruefung ihr Rennen,
    laufen beide — also das heutige Verhalten, kein neuer Schaden. Deshalb darf sie hier
    stehen, anders als bei einem Sprung IN den Abschnitt.
    """
    monkeypatch.setattr(yu, "faellig", lambda: True)         # Positivkontrolle: es WAERE faellig
    monkeypatch.setattr(yu, "laeuft_gerade", lambda *a: True)
    monkeypatch.setattr(yu, "starte_hintergrund",
                        lambda **k: pytest.fail("es aktualisiert schon jemand — kein zweiter Lauf"))
    assert yu.beim_start() is False
    assert "schon jemand" in capsys.readouterr().out         # nicht still


def test_beim_start_laeuft_wenn_NIEMAND_aktualisiert(monkeypatch):
    """Die Gegenrichtung — ohne sie waere das dritte Tor ein Riegel, der IMMER schliesst, und
    die Kalenderpruefung fiele still ganz aus."""
    monkeypatch.setattr(yu, "faellig", lambda: True)
    monkeypatch.setattr(yu, "laeuft_gerade", lambda *a: False)
    monkeypatch.setattr(yu, "starte_hintergrund", lambda **k: True)
    assert yu.beim_start() is True


@pytest.mark.parametrize("wo", ["auto_an", "faellig", "starte_hintergrund"])
def test_beim_start_wirft_NIE(monkeypatch, capsys, wo):
    """Der Aufrufer ist `app._lifespan` — ein Wurf hier liesse den Server GAR NICHT ERST
    hochkommen. Das ist dieselbe Zusage wie in #185 (`fetch._hole_yt_dlp()` hatte kein
    try/except und riss den URL-Import mit), nur mit hoeherem Einsatz: dort fiel eine
    Funktion aus, hier die ganze App.

    Alle drei Stufen einzeln, weil jede eine eigene Wurfquelle hat: `auto_an` liest die
    Einstellungsdatei (unlesbare Bytes → ValueError, #190), `faellig` die Paket-Metadaten
    (#185), und `starte_hintergrund` wirft bei Faden-Erschoepfung ausdruecklich weiter.
    """
    def wirft(*a, **k):
        raise RuntimeError("kaputt")
    monkeypatch.setattr(yu, "faellig", lambda: True)      # damit Stufe 3 erreichbar ist
    monkeypatch.setattr(yu, wo, wirft)
    assert yu.beim_start() is False
    assert "kaputt" in capsys.readouterr().out            # still darf es nicht sein


# --- Nebenlaeufigkeit --------------------------------------------------------

def test_zwei_pip_laeufe_ueberschneiden_sich_nicht(monkeypatch):
    """Zwei pip auf DIESELBE venv schreiben in dasselbe site-packages und koennen die
    Installation zerlegen. Erreichbar, seit es zwei Ausloeser gibt: der Import-Job und der
    Knopf in den Einstellungen. Gemessen wird die GLEICHZEITIGKEIT, nicht die Reihenfolge —
    welcher zuerst drankommt, ist egal."""
    laufend, hoechstens = [0], [0]

    def run(cmd, **kwargs):
        laufend[0] += 1
        hoechstens[0] = max(hoechstens[0], laufend[0])
        time.sleep(0.05)                  # Fenster, in dem sich der andere hineindraengen kann
        laufend[0] -= 1
        return subprocess.CompletedProcess(cmd, 0, "ok", "")

    monkeypatch.setattr(yu.subprocess, "run", run)
    faeden = [threading.Thread(target=yu.aktualisiere) for _ in range(3)]
    for f in faeden:
        f.start()
    for f in faeden:
        f.join()
    assert hoechstens[0] == 1


def test_merker_und_pip_nehmen_VERSCHIEDENE_locks(monkeypatch):
    """`_merken()` laeuft, waehrend die pip-Sperre noch haelt. Trueg sie denselben Namen wie
    die von `settings.save()`, stuende der Lauf hier fuer immer — deshalb der Test, nicht
    nur der Kommentar."""
    _, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    fertig = threading.Event()
    # daemon: haengt es doch, soll der Faden den Testlauf nicht am Beenden hindern — sonst
    # steht statt eines roten Tests ein haengender pytest da.
    threading.Thread(target=lambda: (yu.aktualisiere(), fertig.set()), daemon=True).start()
    assert fertig.wait(5), "aktualisiere() haengt — vermutlich Selbst-Deadlock der Sperren"


def test_pip_sperre_deckt_die_VERSCHACHTELTE_wartezeit_mit(monkeypatch):
    """#207: die Frist der pip-Sperre muss laenger sein, als ihr Abschnitt dauern KANN — sonst
    uebernimmt ein Warter sie, waehrend pip noch laeuft, und zwei `pip install` schreiben in
    dasselbe site-packages.

    Der Abschnitt ist nicht nur der pip-Lauf: `_merken()` nimmt DARIN das settings-Lock und
    wartet darauf schlimmstenfalls dessen volle Frist. Genau diese Haelfte fehlte in der
    Rechnung — `PIP_TIMEOUT + 30` ergab 155 s Frist gegen bis zu 185 s Haltedauer.

    Geprueft wird die ZUSAGE an die Sperre, nicht die Wanduhr: 185 s echter Wartezeit hat kein
    Test, und ein Nachbau mit gestauchten Konstanten pruefte die Konstanten des Nachbaus.
    """
    gesehen = {}

    @contextlib.contextmanager
    def datei(pfad, stale=sperre.STALTES_ALTER):
        gesehen[pfad] = stale
        yield True          # wie die echte: der Kontextmanager liefert, OB er haelt

    monkeypatch.setattr(yu.sperre, "datei", datei)      # trifft auch das settings-Lock in _merken
    _, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    # So lange kann der Abschnitt unter der pip-Sperre LAENGSTENS dauern — alle drei Teile,
    # nicht nur die verschachtelte Sperre: der gedeckelte pip-Lauf, der Zuschlag fuer
    # `subprocess.run`s Nach-Kill-`communicate()` (auf Windows ohne Frist) und die volle Frist
    # des settings-Locks aus `_merken()`. Ohne den mittleren Teil haette die Zusicherung
    # Schlupf — ein `stale`, das nur ZWEI der drei deckt, kaeme durch, und die 30 s bewachte
    # sonst nichts. (CodeRabbit-CLI an PR #211.)
    haltedauer = yu.PIP_TIMEOUT + 30 + sperre.frist()
    # … und so lange darf er es laut der Zusage, die die Sperre bekommen hat.
    #
    # Der Pfad steht hier als LITERAL, obwohl es seit #243 `_lockziel()` gibt — mit Absicht:
    # so pinnt der Test den Pfad selbst. Ginge er durch dieselbe Funktion wie der Code, wuerde
    # eine Umbenennung des Locks stillschweigend mitwandern, und die Anzeige aus #243 fragte
    # danach eine andere Sperre als die, die `aktualisiere()` nimmt.
    #
    # Die venv-Kennung (#254) kommt dabei aus der Funktion — sie haengt an `sys.prefix` und
    # laesst sich nicht hinschreiben. Gepinnt bleibt, was driften KANN: Reihenfolge und
    # Endung. (Der eigene Test dafuer steht bei `test_die_pip_sperre_haengt_an_der_VENV`.)
    assert sperre.frist(gesehen[f"{settings.path()}.ytdlp.{yu._venv_kennung()}"]) > haltedauer


def test_aktualisiere_sagt_es_wenn_pip_OHNE_sperre_lief(monkeypatch, tmp_path):
    """#236 — die zweite Haelfte von #194. `aktualisiere()` nahm die Sperre mit blankem `with`
    und meldete allein den Ausgang des pip-Laufs; die Einstellungsseite schrieb daraufhin
    „yt-dlp ist jetzt auf …", obwohl der Lauf ungeschuetzt war.

    Hier ist das kein verlorener Einstellungswert wie in #192, sondern die Moeglichkeit
    zweier `pip install` in dieselbe venv — genau der Schaden, gegen den diese Sperre gebaut
    ist, und der zweite Ausloeser sitzt im fetch-Subprozess.

    Ausgeuebt wird die ECHTE `sperre.datei` ueber eine DATEI am Lock-Pfad (#191: `os.mkdir`
    meldet dort dauerhaft `FileExistsError`) — eine Attrappe prueefte nur, dass wir ein
    `yield` weiterreichen, nicht dass der Fall auch wirklich so herauskommt.
    """
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    with open(tmp_path / f"settings.json.ytdlp.{yu._venv_kennung()}.lock", "w",
              encoding="utf-8") as f:
        f.write("kein Verzeichnis")
    assert yu.aktualisiere() == (True, False)
    assert len(gerufen) == 1           # pip laeuft trotzdem — die Sperre ist nicht der Zweck


def test_zustand_meldet_auch_einen_lauf_aus_einem_FREMDEN_prozess(tmp_path):
    """#243 — dieselbe Anzeige-Luege wie #225, durch die andere Tuer. `laeuft` kam aus `_lauf`,
    und das ist Modulzustand JE PROZESS: waehrend der fetch-Subprozess pippt, schreibt ein
    fremder Prozess `site-packages` um, hier stand aber `laeuft: False`. Ein `GET
    /api/settings` in pips Deinstallations-/Installationsluecke meldete dann „Nicht
    installiert — der Import steht nicht zur Verfuegung" — und die README schickt den Nutzer
    ausgerechnet dann auf diese Seite.

    Der Merker traegt hier die EIGENE PID: gebraucht wird ein nachweislich lebender Halter,
    und der Punkt des Tests ist, dass `_lauf` und die Sperre zwei verschiedene Quellen sind —
    `aktualisiere()` aus einem fremden Prozess fasst `_lauf` ebensowenig an.
    """
    assert yu.zustand()["laeuft"] is False           # Gegenprobe: ohne Lock laeuft nichts
    lock = f"{settings.path()}.ytdlp.{yu._venv_kennung()}.lock"
    os.mkdir(lock)
    with open(os.path.join(lock, sperre._HALTER), "w", encoding="utf-8") as f:
        f.write(f"{os.getpid()} {platform.node()}")
    assert yu.hintergrund_zustand()[0] is False      # der eigene Faden laeuft NICHT …
    assert yu.zustand()["laeuft"] is True            # … die Sperre sagt trotzdem: da ist wer


def test_zustand_trennt_unlesbar_von_nicht_installiert(monkeypatch):
    """`version: null` hatte zwei Bedeutungen, seit #185 auch "Metadaten nicht lesbar" — und
    die Einstellungsseite hat nur zwei Zweige: sie schrieb "Nicht installiert — der Import
    von Video-URLs steht damit nicht zur Verfuegung", waehrend yt-dlp lief und laden konnte
    (#189). Die ENTSCHEIDUNG bleibt in beiden Faellen dieselbe (kein pip auf Verdacht), nur
    die AUSKUNFT wird getrennt."""
    gerufen = []
    monkeypatch.setattr(yu.metadata, "version", _unlesbar(gerufen))
    z = yu.zustand()
    assert z["version"] is None and z["unlesbar"] is True
    # Nicht irgendein Paket, DAS richtige (siehe `_unlesbar`) — und seit #198 fragt `zustand()`
    # daneben die ZWEITE Distribution, weil `ejs_unlesbar` eine eigene Auskunft ist. Die
    # Reihenfolge bleibt in der Zusicherung: `version`/`unlesbar` gelten yt-dlp, und ein
    # vertauschter Name faellt hier weiterhin auf.
    assert gerufen[0] == "yt-dlp" and set(gerufen) == {"yt-dlp", "yt-dlp-ejs"}
    assert z["ejs_unlesbar"] is True   # dieselbe kaputte Datei trifft beide (#198)

    def fehlt(name):
        raise yu.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(yu.metadata, "version", fehlt)
    z = yu.zustand()
    assert z["version"] is None and z["unlesbar"] is False     # wirklich nicht installiert

    monkeypatch.setattr(yu.metadata, "version", lambda name: "2026.7.4")
    z = yu.zustand()
    assert z["version"] == "2026.7.4" and z["unlesbar"] is False


def test_dist_info_ohne_lesbare_metadata_gilt_als_unlesbar(monkeypatch):
    """`importlib.metadata.version()` WIRFT NICHT IMMER: an einer dist-info ohne (lesbare)
    METADATA gibt es `None` zurueck — gemessen an einer praeparierten dist-info ohne METADATA
    und an einer mit METADATA ohne `Version:`-Kopfzeile, beide Male ohne Ausnahme.

    Ohne diesen Zweig faellt genau dieser Zustand in `(None, False)` = "wirklich nicht
    installiert", und die Einstellungsseite schriebe wieder "der Import steht nicht zur
    Verfuegung", waehrend yt-dlp importierbar daliegt — die Luege aus #189 ueber den
    Geschwisterpfad. Erreichbar nach einem abgebrochenen `pip install -U yt-dlp[default]`,
    also nach genau dem Lauf, den dieses Modul selbst anstoesst."""
    monkeypatch.setattr(yu.metadata, "version", lambda name: None)
    z = yu.zustand()
    assert z["version"] is None and z["unlesbar"] is True
    assert yu.fassung() is None          # die ENTSCHEIDUNG bleibt: kein pip auf Verdacht


def test_unlesbare_ejs_metadaten_bekommen_ein_EIGENES_signal(monkeypatch, capsys):
    """#198 — die zweite Haelfte von #189. `_ejs_untauglich()` liest eine ANDERE Distribution
    (`yt-dlp-ejs`) und hat einen eigenen stillen Rueckfall: unlesbar ⇒ `False` ⇒ nicht
    faellig. Ist NUR die ejs-Metadatei kaputt, war yt-dlps eigenes `unlesbar` **False**, die
    Einstellungsseite meldete einen kerngesunden Stand — und die Erkennung untauglicher
    Loeserskripte (#179/#182) war trotzdem aus. Die einzige Spur war eine stdout-Zeile.

    Die ENTSCHEIDUNG bleibt unveraendert (`_ejs_untauglich() is False` — ein Flag, den pip
    nicht loeschen kann, waere ein taegliches pip ohne Ende); getrennt wird nur die AUSKUNFT.
    """
    monkeypatch.setattr(yu.metadata, "version",
                        lambda name: "2026.8.12" if name == "yt-dlp" else _werfe())
    monkeypatch.setattr(yu, "_ejs_untauglich", _ECHTES_EJS_UNTAUGLICH)
    z = yu.zustand()
    assert z["version"] == "2026.8.12" and z["unlesbar"] is False   # yt-dlp: alles lesbar
    assert z["ejs_unlesbar"] is True                                # … und trotzdem ein Signal
    assert yu._ejs_untauglich() is False                            # die Entscheidung: wie vorher
    assert "unlesbar" in capsys.readouterr().out


def test_lesbare_ejs_metadaten_melden_NICHTS(monkeypatch):
    """Die Gegenprobe, und ohne sie waere der Test darueber die halbe Wahrheit: ein Signal,
    das IMMER steht, ist als Daueralarm derselbe Schaden von der anderen Seite. Geprueft
    werden DREI stille Normalfaelle — das Paket ist da und passt, sein Pin ist gelockert und
    damit gar nicht vergleichbar, und es ist gar nicht installiert
    (`PackageNotFoundError` ist eine Tatsache, keine Unlesbarkeit)."""
    monkeypatch.setattr(yu, "_ejs_zeilen", lambda: ["yt-dlp-ejs==0.8.0; extra == 'default'"])
    monkeypatch.setattr(yu.metadata, "version",
                        lambda name: "2026.8.12" if name == "yt-dlp" else "0.8.0")
    assert yu.zustand()["ejs_unlesbar"] is False

    # Der teuerste der drei, und er hatte als einziger gar keine Zusicherung: ein GELOCKERTER
    # Pin ist nicht vergleichbar (`_release` -> None), der Kalenderweg entscheidet dann wie
    # bisher — das ist der dokumentierte Normalfall, kein Schaden. Wer ihn als `unlesbar`
    # meldete, haengte JEDEM Nutzer mit `>=`-Pin dauerhaft eine bernsteinfarbene Warnung an
    # die Einstellungsseite. Die Mutation dazu (`return False, True` in diesem Zweig) liess
    # vorher die ganze Suite gruen.
    monkeypatch.setattr(yu, "_ejs_zeilen", lambda: ["yt-dlp-ejs>=0.8.0; extra == 'default'"])
    assert yu._ejs_untauglich_und_lesbarkeit() == (False, False)
    assert yu.zustand()["ejs_unlesbar"] is False

    def fehlt(name):
        if name == "yt-dlp":
            return "2026.8.12"
        raise yu.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(yu.metadata, "version", fehlt)
    assert yu.zustand()["ejs_unlesbar"] is False


def _werfe():
    raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")


# --- beim_ende: der Server stirbt, das pip-Kind arbeitet weiter (#224) --------------------


def test_beim_ende_gibt_den_merker_auf_wenn_der_eigene_lauf_noch_haelt(monkeypatch, tmp_path):
    """Der ganze Zweck: nach dem Aufgeben meldet dieselbe Frage, die `beim_start()` stellt,
    weiter „es aktualisiert schon jemand" — statt eine tote PID zu zeigen, hinter der ein
    laufendes pip steht.

    `_prozess_lebt` auf False, weil der Halter eine Sekunde nach dem Aufgeben nicht mehr da
    ist und genau dieser Zustand der Gegenstand ist. Ohne das antwortet die Lebendpruefung
    mit „unsere eigene PID lebt", und der Test bliebe auch ohne den Fix gruen."""
    ziel = yu._lockziel()
    os.makedirs(os.path.dirname(ziel), exist_ok=True)
    os.mkdir(ziel + ".lock")
    with open(os.path.join(ziel + ".lock", sperre._HALTER), "wb") as f:
        f.write(sperre._mein_merker())

    assert yu.beim_ende(eigener=True) is True
    monkeypatch.setattr(sperre, "_prozess_lebt", lambda pid: False)
    assert yu.laeuft_gerade(eigener=False) is True, "der naechste Start wuerde ein zweites pip starten"


def test_beim_ende_fasst_ein_FREMDES_lock_nicht_an(monkeypatch):
    """Laeuft kein EIGENER Faden, gehoert ein liegendes Lock jemand anderem — dem
    fetch-Subprozess mit seiner Selbstheilung oder einem zweiten Serverprozess (#254). Der
    lebt weiter und braucht seine Auskunft; ohne diese Frage naehme unser Herunterfahren sie
    ihm weg."""
    monkeypatch.setattr(sperre, "merker_aufgeben",
                        lambda *a: pytest.fail("kein eigener Lauf — nichts aufzugeben"))
    assert yu.beim_ende(eigener=False) is False


def test_beim_ende_fragt_den_eigenen_lauf_selbst(monkeypatch):
    """Ohne Argument kommt die Antwort aus `hintergrund_zustand()` — der Lifespan reicht
    nichts hinein."""
    monkeypatch.setattr(yu, "hintergrund_zustand", lambda: (True, "", False))
    gerufen = []
    monkeypatch.setattr(sperre, "merker_aufgeben", lambda p: gerufen.append(p) or True)
    assert yu.beim_ende() is True
    assert gerufen == [yu._lockziel()]


# --- Der Merker eines unterbrochenen pip-Laufs (#257/#258) -------------------
#
# Gemessen, bevor irgendetwas davon gebaut wurde (Wegwerf-venv, echtes pip aus dem Cache,
# `taskkill /F /T` bei 300/500/700/900/1400 ms, je frisch aufgesetzt): zwei von fuenf Laeufen
# hinterliessen `metadata.version` -> PackageNotFoundError bei gleichzeitig vorhandenen
# Paketdateien und `import yt_dlp` -> ModuleNotFoundError. Ein zweites
# `pip install -U "yt-dlp[default]"` reparierte das (exit 0, Import laeuft) — das ist die
# Praemisse dieses ganzen Abschnitts.

def test_der_merker_haengt_an_der_VENV_nicht_nur_an_der_einstellungsdatei(monkeypatch):
    """Der Schaden ist pro venv (`aktualisiere()` ruft `sys.executable -m pip`), die
    Einstellungsdatei aber pro NUTZER: `settings.path()` kennt keinen Zweig fuer die gepackte
    App, und `electron/backend.js` setzt `TRANSKRIBOR_SETTINGS` nicht. Ohne diese Kennung
    repariert der Entwicklerserver die Repo-venv fuer einen Schaden in der App-venv — und
    verbraucht dabei den Merker, den die App noch braucht (dieselbe Zwei-Prozess-Lage wie
    #254)."""
    a = yu._pip_merker()
    monkeypatch.setattr(yu.sys, "prefix", r"C:\woanders\.venv")
    b = yu._pip_merker()
    assert a != b
    assert os.path.dirname(a) == os.path.dirname(b) == os.path.dirname(yu._lockziel())


def test_der_merker_liegt_NEBEN_der_sperre_nicht_darin():
    """Eine Datei IM Lock-Verzeichnis bekommt `sperre._wegraeumen` nicht per `os.rmdir` weg.
    Die Folge ist nicht „das Lock liegt herum", sondern (an echtem `sperre.py` gemessen):
    `datei()` faellt nach `frist(stale)` offen — 220 s Wartezeit bei JEDEM Lauf und danach
    pip OHNE Sperre, also zwei `pip install` in dieselbe venv."""
    lockdir = yu._lockziel() + ".lock"
    merker = yu._pip_merker()
    assert merker != lockdir
    assert not merker.startswith(lockdir + os.sep)


def test_setzen_und_loeschen_beantworten_die_frage():
    """Positiv- UND Negativkontrolle: ein Merker, der IMMER gilt, ist derselbe Schaden von
    der anderen Seite — ein Hintergrund-pip bei jedem Serverstart."""
    assert yu._pip_unterbrochen() is False
    yu._pip_merker_setzen()
    assert yu._pip_unterbrochen() is True
    yu._pip_merker_loeschen()
    assert yu._pip_unterbrochen() is False


def test_ein_alter_merker_gilt_nicht_mehr():
    """Die einzige verbliebene Quelle eines Dauerlaufs ist ein Merker, den `os.remove` nicht
    wegbekommt — GEMESSEN erreichbar: eine Datei mit Read-only-Attribut weist auf Windows
    `os.remove` UND `open(...,'w')` mit PermissionError ab. Dann friert sein Datum ein, und
    genau daran endet er. Ohne diese Uhr waere `faellig()` fuer immer True: die Klasse „Flag
    ohne Ende", gegen die dieses Modul an vier Stellen gebaut ist."""
    with open(yu._pip_merker(), "w", encoding="utf-8") as f:
        f.write((HEUTE - dt.timedelta(days=yu.INTERVALL_TAGE + 1)).isoformat())
    assert yu._pip_unterbrochen() is False


def test_ein_merker_am_rand_der_frist_gilt_noch():
    """Die Gegenprobe zum Test darueber — auf der Grenze, nicht daneben. Ohne ihn waere ein
    `<`-statt-`<=`-Dreher unsichtbar, und ein Merker verfiele einen Tag zu frueh."""
    with open(yu._pip_merker(), "w", encoding="utf-8") as f:
        f.write((HEUTE - dt.timedelta(days=yu.INTERVALL_TAGE)).isoformat())
    assert yu._pip_unterbrochen() is True


def test_ein_unlesbarer_oder_zukuenftiger_merker_gilt_nicht():
    """Beides heisst „keine Auskunft", und Unbekanntes flaggt dieses Modul nicht (dieselbe
    Richtung wie `_ejs_untauglich`). Ein Zukunftsdatum entsteht durch eine vorgehende
    Rechneruhr — ohne diese Wache waere es dauerhaft gueltig."""
    for inhalt in ("", "gestern", "2099-01-01"):
        with open(yu._pip_merker(), "w", encoding="utf-8") as f:
            f.write(inhalt)
        assert yu._pip_unterbrochen() is False, inhalt


def test_loeschen_ohne_merker_wirft_nicht_und_SCHWEIGT(capsys):
    """Dieses Modul darf nirgends werfen (#185) — aber „wirft nicht" allein macht den
    `except FileNotFoundError`-Zweig zur Dekoration: `FileNotFoundError` IST ein `OSError`,
    der Zweig darunter faengt ihn ebenso, und die Mutation „Zweig raus" blieb gruen
    (gemessen). Was er wirklich leistet, ist die STILLE: ohne ihn meldete jeder Lauf, dessen
    Merker-Schreibversuch scheiterte, hinterher „nicht loeschbar — die Faelligkeit bleibt
    bestehen" — eine Warnung ueber einen Zustand, den es nicht gibt."""
    yu._pip_merker_loeschen()
    yu._pip_merker_loeschen()
    assert capsys.readouterr().out == ""


def test_ein_unschreibbarer_merker_reisst_niemanden_mit(monkeypatch, capsys):
    """Best effort: ohne Merker ist der Zustand der von vor diesem Fix. Aber nicht STILL —
    ein lautlos uebersprungener Merker ist von einem gesetzten nicht zu unterscheiden
    (dieselbe Regel wie bei `sperre.datei`s fail-open)."""
    def kaputt(*a, **k):
        raise OSError("kein Platz")

    # `os.open`, nicht `builtins.open`: der Schreibpfad nimmt seit dem O_NONBLOCK-Umbau den
    # Deskriptor-Weg. Der Test hat den Umbau von selbst gemeldet (er wurde rot) — waere er
    # auf `builtins.open` stehengeblieben, haette er ab da nichts mehr geprueft.

    # `monkeypatch.context()`, NICHT `monkeypatch.undo()`: Fixture und Test teilen sich
    # dieselbe MonkeyPatch-Instanz, `undo()` nahm also die ganze `isoliert`-Fixture mit
    # zurueck — danach zeigte `TRANSKRIBOR_SETTINGS` wieder auf Marcus' echtes Profil, die
    # Zusicherung darunter las die falsche Datei (also vacuous), und `subprocess.run` war
    # wieder echt. Gemessen im Review; der Modul-Docstring warnt in genau diesen Worten.
    with pytest.MonkeyPatch.context() as m:
        m.setattr(os, "open", kaputt)
        yu._pip_merker_setzen()
    assert yu._pip_unterbrochen() is False
    assert "Merker" in capsys.readouterr().out


def _wirft(fehler):
    """Ein `subprocess.run`-Ersatz, der wirft. Eigene Funktion, weil ein `lambda` nicht
    `raise` kann und vier Faelle dieselbe Form brauchen."""
    def run(cmd, **kwargs):
        raise fehler
    return run


def test_der_merker_liegt_WAEHREND_des_pip_laufs(monkeypatch):
    """Er muss VOR pip gesetzt sein — das Fenster, um das es geht, ist der Kill mitten im
    Umschreiben. Gemessen wird IM Spion und danach ausgewertet: ein `assert` im Stub stuende
    innerhalb des `try`, um das `aktualisiere()` seine Ausnahmen legt, und der AssertionError
    wuerde von der geprueften Stelle selbst geschluckt (dieselbe Falle wie bei #185)."""
    gesehen = []
    monkeypatch.setattr(yu, "fassung", lambda: "2025.9.5")   # sonst legt aktualisiere() gar keinen Merker an

    def run(cmd, **kwargs):
        gesehen.append(yu._pip_unterbrochen())
        return subprocess.CompletedProcess(cmd, 0, "Successfully installed yt-dlp", "")

    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    assert gesehen == [True]


def test_der_merker_wird_INNERHALB_der_sperre_gesetzt(monkeypatch):
    """Nicht davor — sonst setzt ihn auch, wer nur WARTET, und ein zweiter Aktualisierer
    loescht beim Fertigwerden den Merker des ersten. Dessen pip laeuft danach ungedeckt: wird
    es abgewuergt, bleibt KEIN Merker zurueck und der Schaden wird nie erkannt. Zwei
    Aktualisierer gleichzeitig sind hier der Normalfall (Server + fetch-Subprozess, seit #254
    auch zwei Server).

    Die Sperren tragen ihren Pfad, statt nur „auf"/„zu" zu zaehlen. Seit #281 nimmt der
    pip-Abschnitt KEINE zweite Sperre mehr: der Kalendermerker ist eine Datei
    (`_merken()` → `_datum_setzen`), kein `settings.save()`. Die Folge hier nagelt beides
    fest — der Abbruch-Merker steht zwischen Sperre und pip, und es taucht KEIN
    `auf:<settings>` mehr auf. Kaeme eine Verschachtelung zurueck, stünde die #207-Frist
    (`_lock_stale()` = PIP_TIMEOUT + 30 + `frist()`) wieder auf tueurischem Papier."""
    folge = []
    monkeypatch.setattr(yu, "fassung", lambda: "2025.9.5")   # sonst legt aktualisiere() gar keinen Merker an
    echte_sperre = yu.sperre.datei

    @contextlib.contextmanager
    def datei(pfad, stale=None):
        folge.append("auf:" + os.path.basename(pfad))
        with echte_sperre(pfad, stale=stale) as gehalten:
            yield gehalten
        folge.append("zu:" + os.path.basename(pfad))

    def run(cmd, **kwargs):
        folge.append("pip")
        return subprocess.CompletedProcess(cmd, 0, "ok", "")

    monkeypatch.setattr(yu.sperre, "datei", datei)
    monkeypatch.setattr(yu.subprocess, "run", run)
    monkeypatch.setattr(yu, "_pip_merker_setzen", lambda: folge.append("merker gesetzt"))
    monkeypatch.setattr(yu, "_pip_merker_loeschen", lambda: folge.append("merker weg"))
    # Kalendermerker sichtbar machen UND zugleich wachen, dass er ohne settings.save
    # auskommt (CodeRabbit-Major an #281): `_merken()` laeuft REAL — kaeme sein alter
    # Schreiber zurueck, schriebe der Wächter hier fehl, und der Test hinge nicht an
    # einem Zufall. Nur der Dateischreibvorgang selbst ist eine Attrappe (legt nichts an).
    monkeypatch.setattr(yu.settings, "save",
                        lambda *a, **k: pytest.fail("settings.save im pip-Abschnitt"))
    monkeypatch.setattr(yu, "_datum_setzen", lambda p, *, was: folge.append(was))
    yu.aktualisiere()
    pip_lock = os.path.basename(yu._lockziel())
    # „merker weg" und „Kalendermerker" VOR „zu:<pip_lock>": beide stehen im selben
    # Abschnitt wie das pip — ein Wurf dazwischen liesse einen liegen, obwohl pip
    # sauber lief.
    assert folge == ["auf:" + pip_lock, "merker gesetzt", "pip", "merker weg",
                     "Kalendermerker", "zu:" + pip_lock]


def test_nur_ein_GELUNGENER_lauf_raeumt_den_merker_weg(monkeypatch):
    """„Der Prozess hat ueberlebt" ist das falsche Mass, und das ist GEMESSEN: `taskkill /F /T`
    toetet auf Windows das pip-KIND zuerst und laesst dem Elternprozess ein Zeitfenster. Im
    Versuch kam er bis ins `_merken()` — der Merker war weg, ausgerechnet im Szenario von
    #257. Ein abgewuergtes pip meldet nie 0, ein gelungenes immer.

    Dass der Merker nach einem ECHTEN Fehlschlag (offline) liegen bleibt, kostet nichts:
    `faellig()` verlangt zusaetzlich `fassung() is None`, und die Fassung ist dann lesbar."""
    monkeypatch.setattr(yu, "fassung", lambda: "2025.9.5")   # sonst legt aktualisiere() gar keinen Merker an
    monkeypatch.setattr(yu.subprocess, "run",
                        lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "ok", ""))
    yu.aktualisiere()
    assert yu._pip_unterbrochen() is False

    for stub in (lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, "ERROR", ""),
                 _wirft(subprocess.TimeoutExpired("pip", yu.PIP_TIMEOUT)),
                 _wirft(OSError("kein Interpreter"))):
        yu._pip_merker_loeschen()
        monkeypatch.setattr(yu.subprocess, "run", stub)
        yu.aktualisiere()
        assert yu._pip_unterbrochen() is True


def test_ein_wurf_den_niemand_faengt_laesst_den_merker_liegen(monkeypatch):
    """Der Fall, um den es geht — hier stellvertretend als `KeyboardInterrupt`: Ctrl+C schickt
    SIGINT an die ganze Vordergrund-Prozessgruppe, pip inklusive, also ist die Installation
    genauso halb wie nach einem `taskkill /F /T`. `except (OSError, SubprocessError)` faengt
    das bewusst nicht, und genau deshalb ueberlebt der Merker."""
    monkeypatch.setattr(yu, "fassung", lambda: "2025.9.5")   # sonst legt aktualisiere() gar keinen Merker an
    monkeypatch.setattr(yu.subprocess, "run", _wirft(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        yu.aktualisiere()
    assert yu._pip_unterbrochen() is True


def test_ein_unterbrochener_lauf_OHNE_schaden_macht_NICHT_faellig(monkeypatch):
    """Die zweite Haelfte der Regel, und sie spart den ueberfluessigen Lauf: ein Merker sagt
    „ein pip hat keinen Erfolg gemeldet", nicht „etwas ist kaputt". Nach einem gescheiterten
    pip (offline) ist die Fassung unveraendert lesbar — dann gibt es nichts zu reparieren.
    Ohne diese Haelfte liefe bei jedem Start eine Reparatur fuer einen Schaden, den es nicht
    gibt."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")
    _kalender_merken(HEUTE.isoformat())
    yu._pip_merker_setzen()
    assert yu._pip_unterbrochen() is True
    assert yu.faellig() is False


def test_der_merker_schlaegt_auch_den_nicht_installiert_riegel(monkeypatch):
    """Ohne Merker heisst `fassung() is None` „nicht installiert — Sache des Setups" und
    verbietet jedes pip (`test_ohne_installiertes_yt_dlp_kein_update`). Genau dieser Riegel
    machte den Schaden dauerhaft: ein abgewuergtes pip LOESCHT die Metadaten (gemessen:
    `metadata.version` wirft PackageNotFoundError, die Paketdateien liegen noch da), und
    danach hielt der Riegel die Reparatur auf. Der Merker muss deshalb VOR ihm stehen."""
    monkeypatch.setattr(yu, "fassung", lambda: None)
    assert yu.faellig() is False                       # Negativkontrolle
    yu._pip_merker_setzen()
    assert yu.faellig() is True


def test_beim_start_holt_einen_unterbrochenen_lauf_nach(monkeypatch):
    """Die Kette, an der beide Issues haengen: der naechste Serverstart repariert.
    `starte_hintergrund` gefaelscht, sonst liefe ein echter Faden mit echtem pip."""
    monkeypatch.setattr(yu, "fassung", lambda: None)
    _kalender_merken(HEUTE.isoformat())
    monkeypatch.setattr(yu, "laeuft_gerade", lambda *a: False)
    gestartet = []
    monkeypatch.setattr(yu, "starte_hintergrund", lambda **k: gestartet.append(1) or True)
    assert yu.beim_start() is False                    # Negativkontrolle
    yu._pip_merker_setzen()
    assert yu.beim_start() is True
    assert gestartet == [1]


def test_ein_liegender_merker_wird_AUFGEFRISCHT(monkeypatch):
    """#268 — die Umkehrung der frueheren Schon-Regel, und der Weg, den sie offenliess.

    Bis hierher blieb ein noch gueltiger Merker auf seinem Datum stehen. Ein spaeterer
    Abbruch ERBTE damit die Restfrist eines frueheren, ganz gewoehnlichen Fehlschlags
    (offline): regulaerer Fehlschlag an Tag 0, Abbruch an Tag 13, kein Serverstart bis
    Tag 15 — und `faellig()` sagte an Tag 16 `False`, obwohl die Installation zerlegt war.
    Dauerhaft, denn `fassung()` ist dann None und der Riegel „Sache des Setups" greift.

    Der ganze Ablauf steht hier, nicht nur das Auffrischen: ein Test allein auf das
    Merkerdatum sagt nichts darueber, ob die Reparatur am Ende wirklich laeuft.
    """
    alt = (HEUTE - dt.timedelta(days=13)).isoformat()
    with open(yu._pip_merker(), "w", encoding="utf-8") as f:
        f.write(alt)
    yu._pip_merker_setzen()
    with open(yu._pip_merker(), encoding="utf-8") as f:
        assert f.read().strip() == HEUTE.isoformat()

    # … und die Wirkung, drei Tage spaeter: ohne das Auffrischen waere der Merker jetzt
    # abgelaufen (Tag 13 + 3 > INTERVALL_TAGE ab Tag 0) und die Reparatur unterbliebe.
    monkeypatch.setattr(yu, "_heute", lambda: HEUTE + dt.timedelta(days=3))
    monkeypatch.setattr(yu, "fassung", lambda: None)
    assert yu._pip_unterbrochen() is True
    assert yu.faellig() is True


def test_ein_REPARATURlauf_frischt_den_merker_nicht_auf(monkeypatch):
    """Die Gegenprobe zum Auffrischen — sonst waere #268s Fix der Dauerlauf, gegen den die
    Schon-Regel stand: scheitert pip dauerhaft, liefe die Faelligkeit ewig.

    Erreichbar ist er nicht mehr, und das haengt an einer einzigen Zeile: `aktualisiere()`
    setzt den Merker nur bei `fassung() is not None` (Reviewbefund M1), `faellig()`s
    Merker-Zweig verlangt `fassung() is None`. Auffrischen und Auslösen schliessen sich also
    aus. Gemessen ueber 20 simulierte Serverstarts im zerlegten Zustand: das Merkerdatum
    blieb auf Tag 0, die Faelligkeit fiel an Tag 15 auf False — mit und ohne Schon-Regel
    gleich.

    Faellt die `fassung()`-Bedingung in `aktualisiere()`, wird dieser Test rot.
    """
    alt = (HEUTE - dt.timedelta(days=5)).isoformat()
    with open(yu._pip_merker(), "w", encoding="utf-8") as f:
        f.write(alt)
    monkeypatch.setattr(yu, "fassung", lambda: None)      # die Installation ist zerlegt
    _, run = _pip(returncode=1)                                 # … und pip scheitert weiter
    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    with open(yu._pip_merker(), encoding="utf-8") as f:
        assert f.read().strip() == alt                    # unangetastet: die Frist laeuft ab


def test_ohne_vorhandene_fassung_entsteht_GAR_KEIN_merker(monkeypatch):
    """Reviewbefund M1, im Review mit gefaelschtem pip gemessen. Der Merker bedeutet „wir
    haben eine LAUFENDE Installation angefasst und nicht sauber beendet". Ohne diese
    Bedingung bedeutete er bloss „ein pip ist gelaufen" — und dann feuerte `faellig()` auch
    nach einem ganz gewoehnlich gescheiterten Lauf auf einer Maschine, auf der yt-dlp NIE
    installiert war (Knopf „Jetzt aktualisieren" ohne Netz). Genau den Zustand schuetzt der
    Riegel in `faellig()` als „Sache des Setups"; der Merker haette ihn ausgehebelt und
    14 Tage lang bei jedem Serverstart einen Hintergrund-pip freigeschaltet.

    Die Positivkontrolle steht daneben, sonst waere die Zusicherung von einem generell
    kaputten Merker nicht zu unterscheiden."""
    monkeypatch.setattr(yu, "fassung", lambda: None)
    _, run = _pip(returncode=1, ausgabe="ERROR: No matching distribution found")
    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    assert yu._pip_unterbrochen() is False
    assert yu.faellig() is False

    monkeypatch.setattr(yu, "fassung", lambda: "2025.9.5")      # Positivkontrolle
    yu.aktualisiere()
    assert yu._pip_unterbrochen() is True


@pytest.mark.skipif(not hasattr(os, "mkfifo"),
                    reason="FIFOs gibt es auf Windows nicht; der unbegrenzte Fall ist dort "
                           "nicht herstellbar")
def test_ein_fifo_am_merker_pfad_haelt_den_serverstart_nicht_auf():
    """Dieselbe Klasse wie #200 in `sperre._merker_lesen`, nur eine Stufe teurer: der Aufrufer
    ist ueber `faellig()` -> `beim_start()` der Lifespan VOR dem `yield`, und dessen
    `except Exception` faengt keinen Haenger — der Server kaeme gar nicht hoch, ohne
    Fehlerseite und ohne Log.

    Gemessen wird im FADEN mit `join`, nie mit einem normalen Aufruf: ein Haenger macht keinen
    Test rot, er laesst die ganze Suite auslaufen — genau darum blieb die Klasse in #191/#200
    so lange unbemerkt.

    Geprueft wird die EIGENSCHAFT („kehrt zurueck, ohne Auskunft"), nicht ein bestimmter
    Rueckgabewert: ohne Schreiber liefert `os.read` in WSL/ext4 `b""`, nicht `None`.

    **Dieser Test laeuft nur in der Linux-CI** — dieselbe Luecke wie bei #200/#201/#222. Der
    Windows-Zweig bleibt damit unbewacht; das ist benannt, nicht uebersehen."""
    os.mkfifo(yu._pip_merker())                       # niemand schreibt je hinein
    ergebnis = []
    faden = threading.Thread(target=lambda: ergebnis.append(yu._merker_datum()), daemon=True)
    faden.start()
    faden.join(5)
    assert not faden.is_alive(), "haengt am FIFO — der Serverstart ist nicht haengerfrei"
    assert ergebnis[0] is None, "ein FIFO ist keine Auskunft, kein Datum"


def test_die_venv_kennung_ueberlebt_den_prozess():
    """`hash()` waere hier falsch: es ist pro Prozess gesalzen (PYTHONHASHSEED), der Merker
    hiesse beim naechsten Start also anders und keine Reparatur faende ihn je wieder. Ein
    Vergleich innerhalb DIESES Prozesses koennte das nicht zeigen — deshalb ein zweiter.

    Was das NICHT prueft: dass `blake2b` statt `sha1` genommen wird. Der Unterschied ist nur,
    dass `sha1` durch OpenSSL geht und unter einem FIPS-Provider wirft; hier steht kein
    FIPS-Rechner, die Wahl ist also bewusst ohne roten Test (wie `O_BINARY` in
    `sperre._merker_lesen`)."""
    fremd = _ECHTES_RUN(
        [sys.executable, "-c",
         "from webtool import ytdlp_update as yu; print(yu._venv_kennung())"],
        capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(yu.__file__)))
    assert fremd.returncode == 0, fremd.stderr
    assert fremd.stdout.strip() == yu._venv_kennung()


def test_ein_ABGELAUFENER_merker_wird_sehr_wohl_aufgefrischt(monkeypatch):
    """Die Grenze zum Test darueber, und sie ist der Unterschied zwischen „geschont" und
    „eingefroren": geschont wird nur, was noch GILT. Ohne sie bliebe ein einmal
    liegengebliebener Merker fuer immer auf seinem alten Datum stehen — eine NEUE
    Unterbrechung Wochen spaeter faende ihn abgelaufen vor, frischte ihn nicht auf, und die
    Reparatur unterbliebe dauerhaft. (CodeRabbit-CLI, Major.)"""
    with open(yu._pip_merker(), "w", encoding="utf-8") as f:
        f.write((HEUTE - dt.timedelta(days=yu.INTERVALL_TAGE + 1)).isoformat())
    assert yu._pip_unterbrochen() is False                  # abgelaufen

    monkeypatch.setattr(yu, "fassung", lambda: "2025.9.5")
    monkeypatch.setattr(yu.subprocess, "run", _wirft(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        yu.aktualisiere()                                   # neue Unterbrechung
    assert yu._pip_unterbrochen() is True, "der abgelaufene Merker wurde nicht aufgefrischt"


def test_die_merker_entscheidung_liest_den_zustand_NACH_dem_sperrerwerb(monkeypatch):
    """Der Wert aus der Protokollzeile stammt von VOR dem Sperrerwerb, und dazwischen kann ein
    anderer Prozess seinen ganzen pip-Lauf gefahren haben (#254: gepackte App neben
    Entwickler-uvicorn). Die gefaehrliche Richtung ist „vorher nichts, jetzt da": ohne die
    zweite Lesung setzten wir keinen Merker, obwohl wir gleich eine vorhandene Installation
    anfassen — und ein Kill mittendrin bliebe unerkannt. (CodeRabbit-CLI, Major.)

    Gebaut als Zustandswechsel zwischen den beiden Aufrufen, nicht als Zeitmessung: eine
    konstante Attrappe koennte den Unterschied gar nicht zeigen."""
    antworten = [None, "2025.9.5"]      # erst die Protokollzeile, dann die Entscheidung
    monkeypatch.setattr(yu, "fassung", lambda: antworten.pop(0) if antworten else "2025.9.5")
    monkeypatch.setattr(yu.subprocess, "run", _wirft(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        yu.aktualisiere()
    assert yu._pip_unterbrochen() is True, "die Entscheidung hing am veralteten Wert"


@pytest.mark.skipif(not hasattr(os, "mkfifo"),
                    reason="FIFOs gibt es auf Windows nicht; der unbegrenzte Fall ist dort "
                           "nicht herstellbar")
def test_ein_fifo_am_merker_pfad_haelt_auch_das_SCHREIBEN_nicht_auf():
    """Das Gegenstueck zum Lesetest, und der teurere Fall: `_pip_merker_setzen()` laeuft
    INNERHALB der pip-Sperre im Hintergrundfaden. Ein `open(..., "w")` auf einen FIFO wartet
    auf einen LESER, der nie kommt — der Haenger hielte die Sperre fuer immer, die
    Einstellungsseite meldete dauerhaft „eine Aktualisierung laeuft gerade" (#243), und der
    Knopf saesse bei jedem Klick die volle Frist ab.

    In WSL nachgemessen: mit `O_NONBLOCK` wirft `os.open` dort `ENXIO` (Errno 6), ohne das
    Flag kehrt der Faden binnen 5 s nicht zurueck. (CodeRabbit-CLI, Major.)"""
    os.mkfifo(yu._pip_merker())                   # niemand liest je daraus
    fertig = []
    faden = threading.Thread(target=lambda: (yu._pip_merker_setzen(), fertig.append(1)),
                             daemon=True)
    faden.start()
    faden.join(5)
    assert not faden.is_alive(), "haengt am FIFO — die pip-Sperre wuerde fuer immer gehalten"
    assert yu._pip_unterbrochen() is False, "am FIFO steht kein Datum"


# --- #254: die Sperre gehoert der venv, nicht dem Nutzer ----------------------

def test_die_pip_sperre_haengt_an_der_VENV_nicht_nur_am_nutzer(monkeypatch):
    """#254 Weg 2. `settings.path()` ist pro NUTZER — `electron/backend.js` setzt
    `TRANSKRIBOR_SETTINGS` nicht, gepackte App und Entwickler-Checkout teilten sich also
    dieselbe Sperre bei VERSCHIEDENEN venvs. Geschuetzt wird aber `site-packages`: der eine
    sass bis zu 220 s ab und meldete seiner Einstellungsseite „Eine Aktualisierung laeuft
    gerade" — fuer einen Lauf, der eine fremde venv anfasst.

    Zwei Richtungen, sonst waere der Test mit einem festen Namen zu bestehen: verschiedene
    venvs muessen verschiedene Pfade ergeben, DIESELBE venv denselben (die Kennung ist
    stabil, nicht pro Prozess gesalzen — `hash()` waere es).
    """
    # `yu.sys` IST das echte `sys`-Modul, `prefix` also prozess-global. Hier folgenlos
    # (monkeypatch dreht es zurueck, und nichts liest es dazwischen), aber wer den Test
    # erweitert, sollte es wissen: `sysconfig`/`site` lesen denselben Wert. (Reviewbefund.)
    monkeypatch.setattr(yu.sys, "prefix", r"C:\App\resources\py")
    app = yu._lockziel()
    monkeypatch.setattr(yu.sys, "prefix", r"E:\Git\Transkribor\.venv")
    checkout = yu._lockziel()
    assert app != checkout
    assert yu._lockziel() == checkout                     # stabil, nicht zufaellig
    assert os.path.dirname(app) == os.path.dirname(settings.path())


def test_zwei_schreibweisen_DERSELBEN_venv_ergeben_EINE_kennung(monkeypatch, tmp_path):
    """`realpath`, nicht `abspath` — und seit #254 ist das kein Feinschliff.

    Solange die Kennung nur den Merker trug, kostete eine zweite Schreibweise derselben venv
    eine verpasste Reparatur. Seit sie die SPERRE traegt, kostet sie zwei Sperren fuer
    dasselbe `site-packages`, also zwei gleichzeitige `pip install` hinein — genau der
    Schaden, gegen den es die Sperre gibt. Vor #254 war der Fall gedeckt: EINE Sperre je
    Nutzer deckte jede Schreibweise mit ab. (Reviewbefund; die Windows-Faelle Junction und
    `subst`-Laufwerk sind von Hand gemessen, hier steht der plattformneutrale Zwilling.)

    Der Test legt eine echte Verknuepfung an. Wo das nicht geht (Windows ohne
    Entwicklermodus), wird er uebersprungen statt still gruen zu sein.
    """
    echt = tmp_path / "echt"
    echt.mkdir()
    link = tmp_path / "verknuepft"
    try:
        os.symlink(echt, link, target_is_directory=True)
    except (OSError, NotImplementedError, AttributeError) as e:
        if os.name != "nt":
            pytest.skip(f"keine Symlinks: {e}")
        # Windows: eine Junction braucht keine erhoehten Rechte, ein Symlink schon.
        # `_ECHTES_RUN`, nicht `subprocess.run`: die Fixture verdrahtet letzteres auf
        # `pytest.fail("kein echtes pip im Test")`, und `yu.subprocess` IST dieses Modul.
        p = _ECHTES_RUN(["cmd", "/c", "mklink", "/J", str(link), str(echt)],
                        capture_output=True)
        if p.returncode != 0:
            pytest.skip("weder Symlink noch Junction moeglich")

    monkeypatch.setattr(yu.sys, "prefix", str(echt))
    direkt = yu._venv_kennung()
    monkeypatch.setattr(yu.sys, "prefix", str(link))
    ueber_link = yu._venv_kennung()
    assert direkt == ueber_link, "zwei Kennungen fuer dieselbe venv = zwei Sperren"
    # Gegenprobe: eine WIRKLICH andere venv muss weiterhin anders heissen — sonst waere die
    # Zusicherung mit einer Konstanten zu erfuellen.
    monkeypatch.setattr(yu.sys, "prefix", str(tmp_path / "andere"))
    assert yu._venv_kennung() != direkt


def test_der_abbruch_merker_traegt_die_kennung_GENAU_EINMAL():
    """Seit #254 steckt die venv-Kennung in `_lockziel()`. Stuende sie in `_pip_merker()`
    noch einmal, ergaebe das `….ytdlp.<kennung>.<kennung>.abbruch` — kein Schaden, aber der
    naechste Leser sucht die Erklaerung dafuer vergeblich.

    Wichtiger ist die zweite Zeile: der Merkerpfad ist derselbe wie VOR #254
    (`….ytdlp.<kennung>.abbruch`). Genau deshalb steht die Kennung dort, wo sie steht — eine
    andere Reihenfolge haette jeden liegenden Merker verwaist und eine Migration gebraucht.
    """
    assert yu._pip_merker().count(yu._venv_kennung()) == 1
    assert yu._pip_merker() == f"{settings.path()}.ytdlp.{yu._venv_kennung()}.abbruch"


# --- #254 Weg 3: die Faelligkeit noch einmal, UNTER der Sperre ----------------

def test_aktualisiere_prueft_die_faelligkeit_ERNEUT_unter_der_sperre(monkeypatch):
    """#254 Weg 3, samt des dorthin geschlossenen #176. Zwei Serverprozesse starten
    gleichzeitig, beide sehen `faellig()`, der zweite wartet bis zu 220 s an der Sperre und
    macht danach ein pip, das „Requirement already satisfied" meldet — waehrend seine
    Einstellungsseite die ganze Zeit „Eine Aktualisierung laeuft gerade" zeigt.

    Der Test misst BEIDES, weil nur eines davon der Fix ist: dass abgebrochen wird, und dass
    die Frage INNERHALB der Sperre gestellt wird. Vor der Sperre gestellt waere sie derselbe
    Zustand wie das advisory Tor in `beim_start()` — ein Wettlauf, kein Riegel.
    """
    gesehen = []

    def faellig():
        gesehen.append(os.path.isdir(yu._lockziel() + ".lock"))
        return False                       # inzwischen hat ein anderer Lauf aktualisiert

    monkeypatch.setattr(yu, "faellig", faellig)
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    # `None`, nicht `True`: „nicht mehr faellig" heisst NICHT „der andere hatte Erfolg" —
    # `_merken()` laeuft auch nach einem Fehlschlag. Was `True` daraus macht, steht im Test
    # darunter; hier wird der Wert selbst gepinnt.
    assert yu.aktualisiere(nur_wenn_faellig=True) == (None, True)
    assert gerufen == []                   # kein pip
    assert gesehen == [True]               # … und gefragt wurde unter der Sperre


def test_ein_uebersprungener_lauf_meldet_weder_erfolg_noch_fehler(monkeypatch):
    """Der Reviewbefund zu #254 Weg 3, am echten Pfad gemessen: „nicht mehr faellig" belegt
    NICHT, dass der andere Lauf geglueckt ist — `_merken()` laeuft am Ende von
    `aktualisiere()` unbedingt, auch nach einem Fehlschlag (offline). Nach JEDEM
    abgeschlossenen Fremdlauf desselben Tages steht `geprueft` auf heute.

    Mit `ergebnis="ok"` zeigte die Einstellungsseite dann „yt-dlp ist jetzt auf <alte
    Fassung>" — fuer einen Lauf, dessen Vorgaenger gescheitert ist und der selbst nie ein pip
    angefasst hat. Erreichbar ueber den Knopf: `starte_hintergrund` meldet `gestartet:false`,
    solange der Startlauf haengt, und das Frontend haengt seinen Poll an DIESEN Lauf.

    **`ungeschuetzt` bleibt False, obwohl die Sperre nicht hielt** — das ist die zweite
    Haelfte: die Warnung sagt „die Installation kann unvollstaendig sein", und ueber ein pip,
    das nie lief, ist das eine Warnung ohne Gegenstand.
    """
    fertig = threading.Event()

    def uebersprungen(nur_wenn_faellig=False):
        fertig.set()
        return None, False                 # nichts gelaufen, und die Sperre hielt NICHT

    monkeypatch.setattr(yu, "aktualisiere", uebersprungen)
    assert yu.starte_hintergrund(nur_wenn_faellig=True) is True
    assert fertig.wait(5)
    assert _warte_bis(lambda: yu.hintergrund_zustand()[0] is False)
    assert yu.hintergrund_zustand() == (False, "uebersprungen", False)


def test_ein_uebersprungener_lauf_ist_fuer_die_selbstheilung_ein_NEIN(monkeypatch):
    """`fetch.py` fragt „hat es sich gelohnt, es noch einmal zu versuchen". Ein Lauf, der
    nichts getan hat, gibt darauf keine Auskunft — also Nein. Ohne das `is True` waere `None`
    truthy-falsch genug, aber die Absicht staende nirgends; mit einem `bool()`-Dreher waere
    ein uebersprungener Lauf ein Ja, und `fetch.py` liefe in denselben Download zurueck.
    """
    monkeypatch.setattr(yu, "aktualisiere", lambda **k: (None, True))
    monkeypatch.setattr(yu, "faellig", lambda: True)
    assert yu.automatisch() is False
    monkeypatch.setattr(yu, "aktualisiere", lambda **k: (True, True))
    assert yu.automatisch() is True         # Gegenprobe: ein echter Erfolg bleibt ein Ja


def test_aktualisiere_OHNE_die_bedingung_laeuft_auch_wenn_nichts_faellig_ist(monkeypatch):
    """Die Gegenprobe, und sie ist der Vertrag des Knopfes „Jetzt aktualisieren": er laeuft
    bedingungslos. Ohne diesen Test waere ein `nur_wenn_faellig`, das IMMER gilt, gruen — und
    der Knopf taete dann nichts, mit Erfolgsmeldung."""
    monkeypatch.setattr(yu, "faellig", lambda: False)
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    assert yu.aktualisiere() == (True, True)
    assert len(gerufen) == 1


def test_die_selbstheilung_bricht_NIE_ab(monkeypatch):
    """`automatisch(erzwingen=True)` ist die Reparatur nach einem gescheiterten Download —
    ein Extraktor bricht nicht nach Kalender. Sie darf die Weg-3-Bremse also nie bekommen;
    `nur_wenn_faellig` ist genau die Umkehrung von `erzwingen`."""
    gesehen = []
    monkeypatch.setattr(yu, "aktualisiere",
                        lambda nur_wenn_faellig=False: gesehen.append(nur_wenn_faellig) or (True, True))
    monkeypatch.setattr(yu, "faellig", lambda: True)
    yu.automatisch(erzwingen=True)
    yu.automatisch()
    assert gesehen == [False, True]


def test_starte_hintergrund_reicht_die_bedingung_in_den_faden_durch(monkeypatch):
    """Der Faden bedient BEIDE Wege — den Knopf (bedingungslos) und die Kalenderpruefung am
    Start (#254). Bleibt das Argument hier haengen, ist der ganze Weg-3-Fix wirkungslos, und
    zwar still: `aktualisiere()` liefe dann einfach wie bisher."""
    gesehen = []
    fertig = threading.Event()

    def falsch(nur_wenn_faellig=False):
        gesehen.append(nur_wenn_faellig)
        fertig.set()
        return True, True

    monkeypatch.setattr(yu, "aktualisiere", falsch)
    assert yu.starte_hintergrund(nur_wenn_faellig=True) is True
    assert fertig.wait(5)
    assert gesehen == [True]


# --- Kalendermerker pro venv (#281) -------------------------------------------

def test_merker_haengt_an_der_venv_nicht_am_nutzer(monkeypatch):
    """#281: der Kalendermerker ist Buchhaltung DER VENV. Prozess A (andere Kennung)
    darf den Termin von B nicht verbrauchen — gemessen 2026-08-20 an der echten
    Doppel-Konstellation (Dev- und App-venv teilen eine settings.json): B faellig True,
    A merkt, B faellig False, ohne dass As pip je Bs venv angefasst hat."""
    # path/HEUTE/_ejs_untauglich deckt die autouse-Fixture `isoliert`; hier wird nur
    # gefaelscht, was den Fall TRAEGT: eine alte Fassung und zwei Kennungen.
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")          # 40 Tage vor HEUTE
    monkeypatch.setattr(yu, "_venv_kennung", lambda: "aaaa")
    assert yu.faellig() is True
    yu._merken()                                                    # Prozess A merkt
    assert yu.faellig() is False       # POSITIVkontrolle: der EIGENE Merker bremst A
    monkeypatch.setattr(yu, "_venv_kennung", lambda: "bbbb")        # Prozess B
    assert yu.faellig() is True        # master-Code: False — DER Fix-Beweis
    assert yu.geprueft() is None       # B hat keinen eigenen Merker gesehen


def test_merken_schreibt_nichts_mehr_in_die_settings_json(tmp_path):
    """Rueckfuehr-Waechter der anderen Richtung: der Merker gehoert nicht in die
    Nutzerw-Datei. Am master legt _merken() sie mit ytdlp_geprueft=heute an."""
    yu._merken()
    inhalt = ""
    if (tmp_path / "settings.json").exists():
        inhalt = (tmp_path / "settings.json").read_text(encoding="utf-8")
    assert "ytdlp_geprueft" not in inhalt


def test_kein_ytdlp_schluessel_mehr_in_defaults_oder_settings():
    """#281-Rueckfuehr-Waechter: Kalendermerker gehoert nicht in die Nutzer-Datei. Ein
    DEFAULTS-Eintrag schluege durch save()s Filter wieder in die Datei durch — und waere
    dann wieder pro Nutzer geteilt, der Fehler von dem dieser Fix handelt."""
    assert "ytdlp_geprueft" not in settings.DEFAULTS
    assert not hasattr(yu, "MERKER")
