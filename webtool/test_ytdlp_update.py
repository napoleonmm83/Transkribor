"""Selbstaktualisierung von yt-dlp.

Zwei Dinge stellt die Fixture IMMER sicher, und beide sind keine Kosmetik:
`TRANSKRIBOR_SETTINGS` zeigt in tmp_path (der Merker landet in der Einstellungsdatei —
sonst schriebe der Test in Marcus' echte), und `subprocess.run` ist gefaelscht (ein Test,
der echtes pip startet, aendert die venv des Entwicklers waehrend der Lauf laeuft).
"""
import datetime as dt
import subprocess
import threading
import time

import pytest

from webtool import settings
from webtool import ytdlp_update as yu

HEUTE = dt.date(2026, 8, 13)

# VOR jeder Fixture-Faelschung festgehalten: die Fixture pinnt `_ejs_untauglich` (s. unten),
# und der Test der Funktion selbst braucht trotzdem das Original.
_ECHTES_EJS_UNTAUGLICH = yu._ejs_untauglich


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


def _pip(returncode=0, ausgabe="Successfully installed yt-dlp-2026.8.12"):
    """Spion statt echtem pip. Liefert (Liste der Aufrufe, Ersatzfunktion)."""
    gerufen = []

    def run(cmd, **kwargs):
        gerufen.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, returncode, ausgabe, "")

    return gerufen, run


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
    settings.save({"ytdlp_geprueft": "2026-08-10"})               # vor drei Tagen geprueft
    assert yu.faellig() is False


def test_alter_merker_gibt_wieder_frei(monkeypatch):
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    settings.save({"ytdlp_geprueft": "2026-07-01"})
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
    settings.save({"ytdlp_geprueft": HEUTE.isoformat()})
    assert yu.faellig() is False


def test_kaputter_merker_blockiert_nicht(monkeypatch):
    """Ein von Hand verdrehtes Datum darf die Aktualisierung nicht fuer immer abschalten."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    settings.save({"ytdlp_geprueft": "gestern"})
    assert yu.faellig() is True


def test_merker_in_der_ZUKUNFT_blockiert_nicht(monkeypatch):
    """`(heute - g).days` wird bei einem Zukunftsdatum negativ — `faellig()` waere damit
    dauerhaft False und der Kalenderweg **still und fuer immer** abgeschaltet. Erreichbar
    per Handbearbeitung oder einer vorgehenden Rechneruhr; der API-Pfad ist verteidigt
    (`SettingsBody` kennt den Schluessel nicht), diese beiden nicht."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    settings.save({"ytdlp_geprueft": "2099-01-01"})
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
    davor hat `yt-dlp-ejs` nicht, und die Datei wird in der installierten App nie wieder
    gelesen (`setup.js:venvVollstaendig()` winkt die venv durch, ein App-Update ersetzt
    die .exe, nicht die venv). Am Kalender gemessen faellt das NIE auf: die Fassung ist
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
    settings.save({"ytdlp_geprueft": HEUTE.isoformat()})
    assert yu.faellig() is False
    settings.save({"ytdlp_geprueft": (HEUTE - dt.timedelta(days=1)).isoformat()})
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


def test_zeile_mit_WEITEREN_markern_gilt_nicht(monkeypatch):
    """`extra == 'default'` allein ist auswertbar — alles daneben nicht.

    Schriebe yt-dlp `extra == 'default' and python_version >= "3.14"`, installierte pip auf
    3.13 weiter 0.8.0, waehrend wir 0.9.0 als gefordert laesen: Dauer-True, und
    `pip install -U yt-dlp[default]` KANN daran nichts aendern — taegliches pip ohne Ende,
    genau das Verbot aus `_ejs_untauglich`. Der Marker wird nicht ausgewertet (das braeuchte
    `packaging.markers`), sondern die Zeile faellt nach fail-open."""
    _metadaten(monkeypatch, "0.8.0",
               ['yt-dlp-ejs==0.9.0; extra == \'default\' and python_version >= "3.14"'])
    assert yu._ejs_pin() is None
    assert _ECHTES_EJS_UNTAUGLICH() is False


@pytest.mark.parametrize("marker", ['extra == "default"', "EXTRA == 'DEFAULT'",
                                    "extra=='default'"])
def test_marker_auch_in_abweichender_schreibweise(monkeypatch, marker):
    """Dieselbe Vorsorge wie beim Paketnamen — und aus demselben Grund getestet statt nur
    behauptet: `_NUR_DEFAULT_RE` traegt `['\\"]` und `IGNORECASE`, beide hatten NULL
    Abdeckung. Gemessen: die Regex auf einfache Anfuehrungszeichen verengt liess alle 50
    Tests gruen, `IGNORECASE` entfernt ebenfalls.

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
    """`_PAKET` bestimmt, welches Extra pip installiert; `_NUR_DEFAULT_RE` bestimmt, welchem
    Extra-Pin wir glauben. Beide muessen dasselbe Extra nennen — verbunden ist da nichts.
    Wer `_PAKET` aendert, laese sonst still den falschen Pin: fail-open, also weder Test noch
    Logzeile. Ein Waechter statt einer Abstraktion, die sich hier nicht lohnt.

    Auf Gleichheit, nicht auf Teilstring: `"default" in "yt-dlp[default,pin]"` waere wahr, und
    genau dann laege der Fall vor, den der Waechter melden soll — pip installierte zwei Extras,
    geglaubt wuerde weiterhin nur dem `default`-Pin. Ein Waechter, der bei der Aenderung
    schweigt, fuer die es ihn gibt, ist Deko (CodeRabbit an PR #183)."""
    assert yu._PAKET == "yt-dlp[default]"
    assert yu._NUR_DEFAULT_RE.fullmatch("extra == 'default'")


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


def test_weitere_marker_gelten_auch_beim_FEHLEN_nicht(monkeypatch):
    """Der geteilte `_gilt_fuer_uns` wirkt auch hier — und die Kosten sind hier UMGEKEHRT
    zum Pin-Pfad: dort heisst fail-open „der Kalender entscheidet", hier faellt #179 fuer
    diese Datei bis zum 14-Tage-Takt still aus, obwohl pip auf einer passenden
    Python-Fassung sehr wohl installierte.

    Bewusst so gelassen (yt-dlp schreibt heute einen blanken Marker; zwei verschiedene
    Marker-Regeln fuer zwei Fragen waeren die teurere Verwechslungsquelle) — und deshalb
    hier festgehalten statt stillschweigend hingenommen."""
    _ohne_ejs(monkeypatch,
              ['yt-dlp-ejs==0.8.0; extra == \'default\' and python_version >= "3.9"'])
    assert _ECHTES_EJS_UNTAUGLICH() is False


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

def _unlesbar(name):
    """Was `importlib.metadata` bei einer nicht als UTF-8 dekodierbaren METADATA wirft.
    KEIN PackageNotFoundError — genau darum ging es: die drei Lesestellen fingen nur den."""
    raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")


def test_unlesbare_fassung_wirft_nicht(monkeypatch, capsys):
    """`fassung()` haengt an DREI HTTP-Handlern (`zustand()`) und an `fetch._hole_yt_dlp()`,
    das keinen Schutz hat. Ungefangen waere das eine 500er-Einstellungsseite bzw. ein
    abgerissener URL-Import — statt des im Modul-Docstring zugesagten best effort.

    Unbekannt heisst „nicht installiert", und damit NICHT faellig: ein pip auf Verdacht
    liefe hier taeglich, ohne den Zustand zu aendern."""
    monkeypatch.setattr(yu.metadata, "version", _unlesbar)
    assert yu.fassung() is None
    assert yu.faellig() is False
    assert "unlesbar" in capsys.readouterr().out


def test_unlesbare_anforderungen_werfen_nicht(monkeypatch):
    """Zweite Lesestelle (`metadata.requires`). Fail-open wie beim fehlenden Pin: keine
    Zeilen heisst kein #182 und kein #184, der Kalenderweg entscheidet wie bisher."""
    monkeypatch.setattr(yu.metadata, "version", lambda name: "0.8.0")
    monkeypatch.setattr(yu.metadata, "requires", _unlesbar)
    assert _ECHTES_EJS_UNTAUGLICH() is False
    assert yu._ejs_pin() is None
    assert yu._ejs_verlangt() is False


def test_unlesbares_ejs_wird_NICHT_geflaggt(monkeypatch):
    """Die dritte Lesestelle faellt in die ANDERE Richtung — das ist der Kern von #185.

    Der `PackageNotFoundError`-Zweig daneben flaggt (ueber `_ejs_verlangt`), weil „nicht
    installiert" eine Tatsache ist. Eine unlesbare METADATA ist dagegen nur „unbekannt", und
    Unbekanntes flaggt dieses Modul nicht: ob ein pip die kaputte Datei ueberhaupt ersetzt,
    ist offen — bleibt sie liegen, laeuft das taegliche pip dauerhaft weiter.

    yt-dlp verlangt hier ausdruecklich ejs, `_ejs_verlangt()` waere also True. Wer den neuen
    Zweig auf `return _ejs_verlangt()` umschreibt, macht genau diesen Test rot."""
    monkeypatch.setattr(yu.metadata, "version",
                        lambda name: _unlesbar(name) if name == yu._EJS else "2026.7.4")
    monkeypatch.setattr(yu.metadata, "requires",
                        lambda name: ["yt-dlp-ejs==0.8.0; extra == 'default'"])
    assert yu._ejs_verlangt() is True          # Positivkontrolle: der Flag WAERE erreichbar
    assert _ECHTES_EJS_UNTAUGLICH() is False


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
    assert yu.aktualisiere() is True
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
    assert settings.load()["ytdlp_geprueft"] == "2026-08-13"


def test_merker_auch_nach_fehlschlag(monkeypatch):
    """Sonst liefe der naechste Import in denselben Timeout."""
    def kaputt(*a, **k):
        raise subprocess.TimeoutExpired("pip", 120)
    monkeypatch.setattr(yu.subprocess, "run", kaputt)
    assert yu.aktualisiere() is False
    assert settings.load()["ytdlp_geprueft"] == "2026-08-13"


def test_pip_exitcode_ungleich_null_ist_kein_erfolg(monkeypatch):
    _, run = _pip(returncode=1, ausgabe="ERROR: Could not find a version")
    monkeypatch.setattr(yu.subprocess, "run", run)
    assert yu.aktualisiere() is False


def test_fehlschlag_wirft_nicht_und_wird_protokolliert(monkeypatch, capsys):
    """Best effort: ein Rechner ohne Netz darf durch dieses Feature nicht schlechter
    dastehen als vorher. Der Import laeuft danach mit der vorhandenen Fassung weiter."""
    def kaputt(*a, **k):
        raise OSError("kein Netz")
    monkeypatch.setattr(yu.subprocess, "run", kaputt)
    assert yu.aktualisiere() is False
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
    assert yu.aktualisiere() is True            # pip laeuft trotzdem …
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
    assert yu.aktualisiere() is True


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
    settings.save({"ytdlp_geprueft": HEUTE.isoformat()})
    assert yu.automatisch(erzwingen=True) is True
    assert len(gerufen) == 1


def test_erzwingen_uebergeht_den_schalter_NICHT(monkeypatch):
    """Wer seine venv selbst verwaltet, will auch keine Selbstheilung darin."""
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    assert yu.automatisch(erzwingen=True) is False


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
