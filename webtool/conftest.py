"""Gemeinsame Vorkehrungen fuer die Python-Tests.

Es gab bis #459 keine `conftest.py` — sie entstand fuer genau EINEN Riegel, und der Grund war
eine Fehlerklasse, die jener PR selbst aufgemacht hat. Seit dem 02.09.2026 sind es ZWEI; der
zweite steht unten, er hat denselben Bauplan aus einem anderen Anlass.

Seit der Serverstart liegengebliebene `.weg`-Reste WEGRAEUMT, ist ein Test, der den Lifespan
betritt, ohne `TRANSKRIBOR_PROJEKTE` umzubiegen, ein LOESCHLAUF in die echten Projekte des
Entwicklers. Gefunden hat das der kalte Plan-Reviewer an
`test_start_stoesst_die_ytdlp_kalenderpruefung_an`: der nimmt die `client`-Fixture bewusst
nicht und setzte nur `TRANSKRIBOR_SETTINGS`; `paths.projekte_root()` faellt dann auf
`<repo>/projekte` zurueck. Heute liegt dort kein Rest — also gruen, bis er einmal trifft.

Die Env-Zeile in jenem Test ist die Reparatur des Falls. DIES hier ist die Reparatur der
KLASSE: der naechste Test, der den Lifespan betritt, ist von sich aus sicher, statt sich daran
erinnern zu muessen. „Der Fix gehoert in den Mechanismus, nicht in den Kopf" — und ein Riegel,
den man vergessen kann, ist genau der, den man vergisst.

Die Fixture ueberschreibt NICHTS: Tests, die die Wurzel selbst setzen (die `client`-Fixture
tut es), gewinnen, weil ihr `monkeypatch.setenv` spaeter laeuft. Sie legt nur einen sicheren
Grundwert, wo keiner gesetzt wurde. Mit `--setup-show` belegt: `SETUP _wegwerf_projektwurzel`
laeuft VOR der modul-lokalen `isoliert` in `test_ytdlp_update.py`, deren `delenv` also gewinnt.

## Der zweite Riegel: kein Testlauf startet echtes pip

Am 27.08.2026 hat ein Testlauf dieses Repos `yt-dlp` in der venv des Entwicklers von 2026.7.4
auf 2026.8.19 gehoben — ungefragt, waehrend nur Tests laufen sollten. Die Regel dagegen stand
seitdem in `CLAUDE.md` und musste von JEDER Testvorrichtung einzeln erinnert werden; genau die
Bauform, die der Absatz darueber als „der Riegel, den man vergisst" beschreibt.

Deshalb stehen hier ZWEI Vorkehrungen mit getrennten Aufgaben, und die zweite ist NICHT
ueberfluessig:

**(a) Vorbeugung** — `TRANSKRIBOR_YTDLP_UPDATE=0` in der Fixture unten. Der automatische Weg
(`ytdlp_update.automatisch`, `beim_start`) schliesst damit in `auto_an()` kurz, BEVOR Sperre,
Merker oder Subprozess angefasst werden.

**(b) Erkennung** — die Wache `_kein_echtes_pip`. Denn (a) deckt nicht alles: der Schalter
wirkt ausschliesslich in `auto_an()`. `ytdlp_update.aktualisiere()` und `starte_hintergrund()`
— der Weg des Knopfes „Jetzt aktualisieren" (`POST /api/settings/ytdlp/update`) — fragen ihn
gar nicht. Gemessen mit gespiegeltem `subprocess.run` und Schalter `0`: `aktualisiere()`
liefert True und baut dabei `pip install -U yt-dlp[default]`, `starte_hintergrund()` ebenso.
Ein kuenftiger Test gegen diesen Endpunkt ohne eigene Attrappe startete also echtes pip,
trotz (a).

Das Vorbild ist file-lokal und aelter: `test_ytdlp_update.py`s `isoliert` ersetzt
`subprocess.run` durch ein `pytest.fail`. Hier gilt es fuer alle Testmodule, aber ENGER — dort
stirbt jeder Subprozess, hier nur der, der Pakete installiert. Gemessen, dass das nichts
bricht: dieselbe Wache lief ueber die volle Suite (`webtool/` 1159 bestanden, alle testpaths
1183 bestanden), beide Male mit null abgefangenen pip-Aufrufen.

Eine dritte Grenze ist seit dem Bot-Review GESCHLOSSEN: ein `monkeypatch.undo()` im Test nahm
**BEIDE** Riegel zurueck, weil alle Fixtures eines Tests dieselbe `MonkeyPatch`-Instanz
teilen — nach `undo()` war `subprocess.Popen` wieder das Original (gemessen; hier stand zuerst
„entwertet (a), nicht (b)", falsch, gefunden vom gegnerischen Pruefer).
`test_transcribe.py:664/677/688` rufen `undo()` mitten im Test. Deshalb haengen beide Riegel
jetzt an EIGENEN `pytest.MonkeyPatch.context()`-Instanzen, die ein Test-`undo()` nicht
erreicht (`test_die_wache_ueberlebt_ein_undo_des_test_monkeypatch`).

**Zwei benannte Grenzen**, damit niemand mehr erwartet, als hier steht:

* `settings.load_env()` schreibt beim Import von `webtool.app` direkt in `os.environ` und
  laesst die `.env` gegen einen gesetzten Wert gewinnen. Das entwertet **(a)**, und **(b)**
  faengt es trotzdem ab — das ist der zweite Grund fuer die Wache.
* `testpaths` umfasst auch `build/` und `scripts/`; dorthin reicht diese Datei nicht. Und dort
  LIEGT ein pip-Weg — `scripts/osv_freeze.py:93` ruft `pip install --dry-run --report`; er
  wird von `test_osv_freeze.py` heute nur nicht erreicht. Die tragfaehige Aussage ist also
  „kein Test dort erreicht heute pip", nicht „dort liegt kein pip-Weg" (auch das der
  gegnerische Pruefer). `scripts/weg_benchmark.py` setzt den Schalter ohnehin selbst. Eine
  Wurzel-`conftest.py` waere die vollstaendige Antwort — eigene Entscheidung, eigener Radius.
"""
import os
import re
import shlex
import subprocess
import threading

import pytest

# `pip`, `pip3`, `pip3.13`, `…/pip.exe` — die Schreibweisen, unter denen derselbe Installer
# laeuft. Verglichen wird der Dateiname ohne `.exe`, damit auch ein absoluter Pfad trifft.
_PIP_WORT = re.compile(r"pip[0-9.]*$")
# BEIDE Trenner, nicht `os.path.basename`: das ist auf Linux `posixpath` und kennt den
# Rueckstrich nicht. Gemessen an `C:/Git/…/Scripts/pip.exe` in Windows-Schreibweise —
# ntpath liefert `pip.exe`, posixpath den GANZEN Pfad, und der Vergleich scheitert. Der
# CI-Laeufer ist ubuntu: ohne diese Zeile waere der Windows-Pfad-Fall der Testtabelle
# lokal gruen und in der CI rot (CodeRabbit-CLI, Major).
_TRENNER = re.compile(r"[\\/]")
# Nur was die Umgebung VERAENDERT. `pip list`/`pip --version` duerfen laufen: die Wache steht
# gegen die Veraenderung der venv, nicht gegen pip.
_PIP_VERBEN = {"install", "uninstall"}


def _ist_pip_installation(kommando) -> bool:
    """Wuerde dieses Kommando Pakete in die venv schreiben?

    Die Form, um die es wirklich geht, ist `ytdlp_update.py:958`:
    `[sys.executable, "-m", "pip", "install", "-U", …, "yt-dlp[default]"]`. Eine Zeichenkette
    (`shell=True`) wird zerlegt, sonst rutschte sie am Listenvergleich vorbei.

    Wirft bei den geprueften Eingaben nicht (`None`, `bytes`, unbalancierte
    Anfuehrungszeichen, nicht iterierbar — die Tabelle in `test_pip_erkennung_laesst_alles_andere_durch`):
    die Wache liegt vor JEDEM `subprocess.Popen` der Suite, ein Fehler hier machte beliebige
    fremde Tests rot — im Zweifel gilt „kein pip" und der Aufruf laeuft durch. Ein Iterable,
    das beim Durchlaufen selbst wirft, reicht seine Ausnahme durch; das ist nicht abgedeckt.
    """
    if isinstance(kommando, (str, bytes)):
        text = kommando.decode(errors="replace") if isinstance(kommando, bytes) else kommando
        try:
            teile = shlex.split(text)
        except ValueError:                      # unbalancierte Anfuehrungszeichen
            teile = text.split()
    else:
        try:
            teile = list(kommando)
        except TypeError:                       # kein iterables Kommando
            return False
    worte = []
    for teil in teile:
        # `os.fsdecode`, nicht `str`: eine Argumentliste darf `bytes` und `os.PathLike`
        # enthalten, und `str(b"pip")` ergibt `"b'pip'"` — das trifft kein Muster mehr.
        # Gemessen am Gegenbeispiel `[b"python", b"-m", b"pip", b"install", b"x"]`: mit `str`
        # rutschte es durch, also ein echtes pip an einer Wache vorbei, die gruen meldet.
        try:
            roh = os.fsdecode(teil)
        except TypeError:                       # weder str/bytes noch PathLike
            roh = str(teil)
        wort = _TRENNER.split(roh)[-1].lower()
        worte.append(wort[:-4] if wort.endswith(".exe") else wort)
    return any(_PIP_WORT.match(w) for w in worte) and bool(_PIP_VERBEN.intersection(worte))


def _mit_executable(args, executable):
    """`executable=` ersetzt das Programm aus `args[0]` (POSIX: execvpe-Verhalten) — ein
    `Popen(["egal", "install", "x"], executable=".../pip")` startet also pip, ohne dass `args`
    das Wort traegt. Fuer die Erkennung wird das Programm an die Wortliste gehaengt. Bei einer
    Zeichenkette (`shell=True`) ist `executable` die Shell und traegt nichts bei
    (CodeRabbit-Bot, Major, PR #529)."""
    if executable is None or isinstance(args, (str, bytes)):
        return args
    try:
        return [*args, executable]
    except TypeError:                           # kein iterables Kommando
        return args


# Beide Riegel haengen an EIGENEN `MonkeyPatch`-Kontexten, nicht am `monkeypatch` des Tests:
# alle Fixtures eines Tests teilen sich sonst dieselbe Instanz, und `test_transcribe.py:664/
# 677/688` rufen `monkeypatch.undo()` mitten im Test — gemessen nahm das Schalter UND Wache
# mit, `subprocess.Popen` war danach das Original (CodeRabbit-Bot, Major, PR #529). Ein
# pip-Aufruf hinter so einem `undo()` liefe ins Echte. `test_die_wache_ueberlebt_ein_undo_des_
# test_monkeypatch` haelt das fest.
@pytest.fixture(autouse=True)
def _wegwerf_projektwurzel(tmp_path):
    """Jeder Test bekommt eine Wegwerf-Projektwurzel, auch wenn er keine anfordert.

    Ohne Zutun des Tests, weil genau das Zutun die Luecke war. `TRANSKRIBOR_SETTINGS` gleich
    mit: dieselbe Familie (der Lifespan-Shutdown ruft `ytdlp_update.beim_ende()`, dessen
    Sperrpfad sonst im Profil des Entwicklers laege — das steht seit #224 als Begruendung im
    Docstring desselben Tests). `TRANSKRIBOR_YTDLP_UPDATE` ist Vorkehrung (a) aus dem
    Docstring dieser Datei — dieselbe Familie ein drittes Mal.
    """
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path / "_wegwerf_projekte"))
        mp.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "_wegwerf_settings.json"))
        mp.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
        yield


@pytest.fixture(autouse=True)
def _kein_echtes_pip():
    """Vorkehrung (b): ein Test, der pip starten wollte, wird ROT statt die venv zu aendern.

    Abgefangen wird **nur `subprocess.Popen`**, und das ist keine Sparsamkeit, sondern die
    engste Stelle: `subprocess.run`, `check_output` und `call` bauen ihren Prozess alle ueber
    den Modul-globalen Namen `Popen`, laufen also durch diese eine Huelle. **Gemessen an der
    eigenen Mutationsprobe** — der erste Entwurf hatte eine zweite Wache auf `subprocess.run`,
    und die Probe, die sie entfernte, blieb GRUEN: der Riegel hielt weiter ueber `Popen`. Eine
    Wache, die keine Mutation rot bekommt, ist Dekoration, also ist sie raus. Nebenbei ist
    `Popen` auch die robustere Stelle: ein Modul mit `from subprocess import run` haelt seinen
    eigenen Namen und waere von einem `run`-Patch gar nicht erreicht worden.

    Alles, was nicht nach einer pip-Installation aussieht, laeuft unveraendert durch
    (`jobs.py` startet echte Subprozesse und muss das duerfen).

    **Die Wache ist eine KLASSE, keine Funktion — das ist der teuerste Punkt hier.** Der erste
    Entwurf setzte eine Funktion an die Stelle von `subprocess.Popen`, und damit bricht jeder
    Code, der davon ERBT: `yt_dlp/utils/_utils.py:842` macht `class Popen(subprocess.Popen)`
    beim Import, und der stirbt dann mit `TypeError: function() argument 'code' must be code,
    not str`. Heute traf das keinen Test (alle `test_fetch.py`-Stellen ersetzen
    `_importiere_yt_dlp`, ein Modulkopf-Import existiert nicht — daher 1201 gruen), aber jeder
    kuenftige Test mit echtem yt-dlp-Import waere daran gestorben, und in der CI NIE, weil
    dort kein yt-dlp installiert ist. Als Unterklasse erbt sich die Wache wie das Original.
    Gefunden vom gegnerischen Pruefer, ausgefuehrt statt gelesen. Der erste Parameter heisst
    `args` wie im Original, damit auch `Popen(args=[…])` weiter traegt.

    **Zwei Wege, den Test rot zu bekommen, und beide werden gebraucht.** `pytest.fail` wirkt
    sofort und ist eine `BaseException` — ein `except Exception` auf dem Weg (davon hat
    `ytdlp_update` mehrere) verschluckt sie also nicht. Der Aufruf kann aber auch aus einem
    NEBENFADEN kommen (`jobs.py` fuehrt seine Prozesse dort), und dort raeumt eine Ausnahme nur
    den Faden ab — deshalb wird ein Treffer aus einem Nebenfaden aufgezeichnet und beim Abbau
    geprueft.

    **Was die Wache NICHT leistet — hergeleitet aus der Lebensdauer der Fixture, nicht
    gemessen:** ein Faden aus Test A, der waehrend Test B feuert, macht **B** rot, nicht A
    (die Wache ist zu dem Zeitpunkt die von B); und ein Faden, der nach dem letzten Test
    feuert, laeuft in das echte `Popen` (die Fixture ist abgebaut). Die Zusage lautet also
    „rot, solange der eigene Test lebt", nicht „nie". Dieselbe Grenze hatte die file-lokale
    `isoliert`-Fixture schon immer; einen Test dafuer gibt es nicht.
    Ebenfalls offen: `jobs._run_proc` faengt beim Start `except Exception` — `pytest.fail`
    kommt zwar durch, der Job bliebe aber `running`, und ein pollender Test haenge statt rot
    zu werden. Trifft nur ein pip-foermiges JOB-Kommando; heute gibt es keines.
    """
    versuche: list[str] = []
    echt = subprocess.Popen

    class Wache(echt):
        # Sonst wirft `Popen.__del__` ein "Exception ignored", wenn `pytest.fail` VOR
        # `super().__init__` zuschlaegt: das Attribut entsteht erst dort.
        _child_created = False

        def __init__(self, args, *rest, **kwargs):
            if _ist_pip_installation(_mit_executable(args, kwargs.get("executable"))):
                if threading.current_thread() is not threading.main_thread():
                    # Im Hauptfaden traegt `pytest.fail` allein; aufgezeichnet wird nur, was
                    # sonst still bliebe — sonst meldete derselbe Treffer FAILED *und* ERROR.
                    versuche.append(repr(args))
                pytest.fail(f"Ein Test wollte echtes pip starten: {args!r}. Das schreibt in "
                            "die venv des Entwicklers — die Begruendung steht im Docstring "
                            "von webtool/conftest.py.")
            super().__init__(args, *rest, **kwargs)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(subprocess, "Popen", Wache)
        yield
    assert not versuche, "pip-Aufruf aus einem Nebenfaden: " + " | ".join(versuche)
