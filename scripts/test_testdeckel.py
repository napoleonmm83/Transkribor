"""Der Lauf-Deckel aus der Wurzel-`conftest.py` muss die drei Luecken wirklich schliessen (#584).

Geprueft wird END-TO-END in einem Wegwerf-Unterprozess, nicht am Quelltext: die Zusicherung
ist ein VERHALTEN des laufenden pytest (Zeitgeber, Faden, Prozessende), und davon liesse
sich durch Lesen nichts belegen. Die `conftest.py` wird dafuer neben die erzeugte Testdatei
kopiert — derselbe Aufbau, mit dem die drei Faelle in #584 gemessen wurden.

NEGATIVKONTROLLE, vor dem Bau gefahren und hier festgehalten, weil ein Test ohne sie nur
behauptet, etwas zu messen (Schwelle 2 s, `timeout 20` aussen, ohne die Wurzel-conftest):

    Haenger im Testkoerper                       rc 1     der pytest-eigene Riegel greift
    Roter Test, danach haengender Fixture-Abbau  rc 124   er greift NICHT
    Haenger nach dem letzten Test                rc 124   er greift NICHT, vorher "1 passed"

Behauptet wird hier nur das AUSLOESEN, nie das Nicht-Ausloesen. Ein Test in der
Gegenrichtung ("bei 600 s laeuft die Suite durch") haengt an der Laufzeit der Maschine und
waere unter Last flatterig — dieses Repo hat dafuer zwei offene Belege (#558, #569).

Der Wegwerf-Ordner bekommt bewusst KEINE `pytest.ini`: ohne sie ist der pytest-eigene
`faulthandler_timeout` aus, und was den Prozess beendet, kann nur der Deckel aus der
`conftest.py` gewesen sein.

## Die Mutationsprobe, samt der Umgebung, ohne die sie zehn Minuten kostet

Zwei Serien, und sie brauchen VERSCHIEDENE Umgebungen — das steht hier, weil eine
Plandatei ihr Kommando nicht mitfuehrt und der naechste Leser es sonst raet
(Kalt-Review):

    TRANSKRIBOR_TESTDECKEL=0 python scripts/mutation.py --repo . --pfad . \
      --test "<venv>\\Scripts\\python.exe -m pytest scripts/test_testdeckel.py -q" \
      --plan scripts/mutationen/testdeckel.json

    python scripts/mutation.py --repo . --pfad . \
      --test "<venv>\\Scripts\\python.exe -m pytest scripts/test_testdeckel.py \
              scripts/test_pytest_riegel.py -q" \
      --plan scripts/mutationen/testdeckel_riegel.json

Das `TRANSKRIBOR_TESTDECKEL=0` der ERSTEN Serie ist Pflicht: sie mutiert unter anderem
`wache.daemon = True` zu `False`, und der aeussere pytest-Lauf des Treibers laedt dieselbe
mutierte Wurzel-`conftest.py`. Ohne den Schalter wartet er nach der letzten Zeile seiner
Ausgabe die volle Vorgabe von 600 s auf den nicht mehr daemonischen Waechter — die Probe
besteht, kostet aber zehn Minuten, und `scripts/mutation.py` hat kein `timeout=`.
Die ZWEITE Serie darf ihn nicht setzen: sie prueft ueber den Stash, dass der Deckel
scharf ist. Rueckstriche und kein fuehrendes `./` im `--test`, weil der Treiber es mit
`shell=True` faehrt — auf Windows also durch cmd.exe.
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import DECKEL_RC

WURZEL = Path(__file__).resolve().parents[1]

# Die drei Luecken aus #584, als je eine Testdatei.
FAELLE = {
    "koerper": (
        "import time\n"
        "\n"
        "def test_haengt_im_koerper():\n"
        "    time.sleep(3600)\n"
    ),
    "abbau_nach_rotem_test": (
        "import time\n"
        "import pytest\n"
        "\n"
        "@pytest.fixture\n"
        "def sperre():\n"
        "    yield\n"
        "    time.sleep(3600)\n"
        "\n"
        "def test_rot_dann_haengender_abbau(sperre):\n"
        "    assert False\n"
    ),
    "nach_dem_letzten_test": (
        "import threading\n"
        "import time\n"
        "\n"
        "def test_startet_einen_faden_der_bleibt():\n"
        "    threading.Thread(target=time.sleep, args=(3600,), daemon=False).start()\n"
    ),
}


def _lauf(tmp_path: Path, quelle: str, frist: str) -> subprocess.CompletedProcess:
    """Einen pytest-Lauf im Wegwerf-Ordner fahren, mit der Wurzel-conftest daneben.

    Das Kommando ist woertlich und traegt keine Eingabe von aussen — `sys.executable` und
    feste Schalter. Deshalb steht hier ein `noqa` fuer S603 statt einer Umschreibung; die
    zweite und einzige weitere Stelle ist der Rohr-Test, der `Popen` direkt braucht, weil
    er waehrend des Laufs an das Leseende muss.

    `timeout=60` ist ein RUECKFALL, keine Messgroesse: greift er, hat der Deckel versagt —
    genau das melden die Aufrufer dann auch. 60 s sind das 30-fache der Pruef-Frist.
    """
    shutil.copy(WURZEL / "conftest.py", tmp_path / "conftest.py")
    ziel = tmp_path / "test_haenger.py"
    ziel.write_text(quelle, encoding="utf-8")

    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(ziel)],
        cwd=tmp_path, env={**os.environ, "TRANSKRIBOR_TESTDECKEL": frist},
        capture_output=True, encoding="utf-8", errors="replace", timeout=60, check=False,
    )


def _haenger(tmp_path: Path, quelle: str) -> tuple[int, str]:
    try:
        p = _lauf(tmp_path, quelle, "2")
    except subprocess.TimeoutExpired:
        pytest.fail("Der Lauf-Deckel hat NICHT zugeschlagen — der Prozess hing 60 s lang, "
                    "obwohl die Frist auf 2 s stand. Genau der Ausfall, gegen den er da ist.")
    return p.returncode, p.stdout + p.stderr


def test_der_abbruchcode_ist_selbst_ein_roter_ausgang():
    """Der Waechter ueber der Zusicherung aller anderen Tests hier.

    Alle Haenger-Tests vergleichen `rc == DECKEL_RC` — und holen die Konstante aus
    derselben Datei, die sie pruefen. Das ist selbstbezueglich: mit `DECKEL_RC = 0` endet
    ein Haenger mit rc 0, der gruene Haken auf einen stehenden Prozess, und **kein
    einziger der sieben Tests wird rot** (im gegnerischen Review gemessen, 7 passed).
    Genau die Fehlerklasse, gegen die #584 gebaut ist, im eigenen Pruefstand.

    Deshalb wird der Wert hier direkt befragt statt nur verglichen: ungleich 0, und
    ausserhalb von pytests belegtem Bereich 0-5, damit ein Abbruch durch den Deckel nicht
    als Nutzungsfehler oder als leere Sammlung gelesen wird.
    """
    assert DECKEL_RC != 0, (
        "DECKEL_RC = 0 macht aus jedem Haenger einen gruenen Lauf — und alle Tests hier "
        "bliebe gruen, weil sie gegen genau diese Konstante vergleichen."
    )
    assert DECKEL_RC not in range(6), (
        f"DECKEL_RC = {DECKEL_RC} liegt in pytests eigenem Bereich 0-5 und ist damit von "
        "einem Nutzungsfehler oder einer leeren Sammlung nicht zu unterscheiden."
    )


@pytest.mark.parametrize("fall", sorted(FAELLE))
def test_der_deckel_beendet_den_lauf_und_sagt_wo(tmp_path, fall):
    """Alle drei Faelle: eigener Rueckgabecode, Markerzeile, Stapelabzug."""
    rc, aus = _haenger(tmp_path, FAELLE[fall])

    # Zuerst die Eigenschaft, die nicht an der Konstante haengt: der Ausgang ist ROT.
    assert rc != 0, f"Fall {fall}: der Lauf hing und endete trotzdem gruen.\n{aus[-2000:]}"
    assert rc == DECKEL_RC, (
        f"Fall {fall}: rc {rc} statt {DECKEL_RC}. "
        f"124 hiesse, dass erst der aeussere timeout gegriffen hat.\n{aus[-2000:]}"
    )
    assert "[testdeckel]" in aus, f"Fall {fall}: keine Markerzeile im Protokoll.\n{aus[-2000:]}"
    # Ein Abbruch OHNE Abzug waere derselbe Zustand wie `timeout-minutes` — der ganze Zweck
    # dieses Riegels ist die Diagnose, nicht das Beenden.
    assert "Thread 0x" in aus, f"Fall {fall}: kein Stapelabzug im Protokoll.\n{aus[-2000:]}"


def test_der_dritte_fall_meldet_sonst_erfolg(tmp_path):
    """Die teuerste der drei Luecken bekommt eine eigene Zusicherung.

    Bei einem Haenger NACH dem letzten Test steht `1 passed` schon im Protokoll, bevor der
    Prozess stehenbleibt. Ohne Deckel ist das ein Lauf, den jeder fuer gruen haelt und der
    von aussen abgewuergt wird (gemessen: rc 124). Hier wird festgehalten, dass hinter der
    Erfolgsmeldung trotzdem ein roter Ausgang steht — die Zusammenfassungszeile ist in
    diesem Fall also NICHT die Wahrheit, der Rueckgabecode ist es.
    """
    rc, aus = _haenger(tmp_path, FAELLE["nach_dem_letzten_test"])

    assert "1 passed" in aus, f"Der Aufbau stimmt nicht mehr — der Test lief gar nicht:\n{aus}"
    assert rc != 0, "Protokoll meldet Erfolg, der Lauf steht — und der Ausgang ist gruen."
    assert rc == DECKEL_RC, (
        f"rc {rc}: Protokoll meldet Erfolg, der Lauf steht, und niemand merkt es."
    )


def test_der_deckel_beendet_auch_wenn_niemand_mehr_zuhoert(tmp_path):
    """Der Waechter darf nicht daran sterben, dass seine Diagnose nicht ankommt.

    Ist der Leser des stderr-Rohrs weg — `pytest 2>&1 | head`, ein Elternprozess, der
    stderr zumacht —, wirft `os.write`. Ohne `finally` stirbt der Timer-Faden an dieser
    Ausnahme, `os._exit` wird nie erreicht, und der Prozess haengt danach genau so weiter
    wie ohne jeden Deckel: der Riegel versagt ausgerechnet dann, wenn man ihn am
    wenigsten beobachten kann.

    GEMESSEN, gleicher Aufbau wie hier: ohne `finally` lebt das Kind nach 12 s noch, mit
    `finally` endet es mit 99. Das BEENDEN ist die tragende Haelfte, der Abzug die Kuer.
    Befund des kalten Diff-Reviews.
    """
    shutil.copy(WURZEL / "conftest.py", tmp_path / "conftest.py")
    ziel = tmp_path / "test_haenger.py"
    ziel.write_text("import time\n\ndef test_haengt():\n    time.sleep(3600)\n",
                    encoding="utf-8")

    p = subprocess.Popen(  # noqa: S603
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(ziel)],
        cwd=tmp_path, env={**os.environ, "TRANSKRIBOR_TESTDECKEL": "2"},
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    try:
        time.sleep(1.5)          # noch vor Fristende, damit der Faden das Rohr tot vorfindet
        p.stderr.close()
        rc = p.wait(timeout=30)  # 15-fache Frist; greift der, hat der Waechter versagt
    except subprocess.TimeoutExpired:
        p.kill()
        pytest.fail("Der Lauf haengt weiter, obwohl der Deckel abgelaufen ist — der "
                    "Waechter ist am eigenen Schreibversuch gestorben.")
    finally:
        p.kill()
    assert rc == DECKEL_RC, f"rc {rc} statt {DECKEL_RC}"


def test_am_haltepunkt_wird_abbestellt(tmp_path):
    """Der Deckel darf keine Fehlersuche erschiessen.

    pytests eigenes faulthandler-Plugin bestellt seinen Zeitgeber bei `pytest_enter_pdb`
    ab; dieser Deckel tat es zuerst NICHT — wer laenger als die Frist an einem Haltepunkt
    steht, verlor den Prozess mit rc 99 und Stapelabzug. Das war kein Altschaden, sondern
    etwas, das der Fix NEU kaputtgemacht hat (gegnerisches Review, gemessen: rc 99 nach
    2,2 s bei Frist 2 s).

    Dieser Test behauptet ausnahmsweise ein NICHT-Ausloesen. Das ist hier vertretbar, weil
    die Zusicherung nicht an einer knappen Uhr haengt: die Frist steht auf 1 s, geprueft
    wird nach 5 s, und `pdb` wartet ohne Eingabe unbegrenzt. Ein zurueckgebauter Hook
    schlaegt in dieser Spanne sicher zu.
    """
    shutil.copy(WURZEL / "conftest.py", tmp_path / "conftest.py")
    ziel = tmp_path / "test_haltepunkt.py"
    ziel.write_text("def test_haelt_an():\n    breakpoint()\n", encoding="utf-8")

    p = subprocess.Popen(  # noqa: S603
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(ziel)],
        cwd=tmp_path, env={**os.environ, "TRANSKRIBOR_TESTDECKEL": "1"},
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        rc = p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        rc = None                      # steht noch am Haltepunkt — genau richtig
    finally:
        p.kill()
        if p.stdin:
            p.stdin.close()
    assert rc is None, (
        f"Der Lauf endete mit rc {rc}, statt am Haltepunkt zu warten — der Deckel hat "
        "die Fehlersuche erschossen."
    )


def test_ein_armierter_deckel_stoert_den_gesunden_lauf_nicht(tmp_path):
    """Der Waechterfaden muss ein DAEMON sein — sonst stirbt jeder gruene Lauf an ihm.

    Diesen Test hat die Mutationsprobe erzwungen, und sie hat dabei die Begruendung im
    Kopf der `conftest.py` widerlegt: `daemon = False` faellt bei den drei Haenger-Faellen
    NICHT auf (der Zeitgeber feuert ohnehin, der Prozess endet so wie so mit 99). Auffallen
    tut es hier — `threading._shutdown()` wartet beim Beenden auf jeden nicht-daemonischen
    Faden, also auch auf den Waechter mit seiner Restfrist.

    GEMESSEN, Frist 10 s: gesunder Lauf mit Daemon rc 0 in 0 s, ohne Daemon rc 99 nach
    10 s. Die Zusicherung haengt deshalb am RUECKGABECODE, nicht an einer Uhr — eine
    Zeitschranke waere auf einem langsamen Laeufer flatterig, dieser Unterschied ist es
    nicht.

    Die Frist ist mit 30 s bewusst laenger als der Lauf: bei `0` gaebe es gar keinen
    Faden, und der Test koennte den Unterschied nicht sehen (genau das ist der Test
    darunter).
    """
    p = _lauf(tmp_path, "def test_ok():\n    assert True\n", "30")
    assert p.returncode == 0, (
        "Ein gesunder Lauf ist am eigenen Waechter gestorben — der Faden wird beim "
        f"Beenden gejoint statt losgelassen.\n{p.stdout + p.stderr}"
    )
    assert "[testdeckel]" not in (p.stdout + p.stderr)


def test_null_schaltet_den_deckel_ab(tmp_path):
    """Der Ausweg muss ein Ausweg sein — sonst baut sich jemand einen eigenen.

    Anders als der Test darueber laeuft hier GAR KEIN Waechterfaden; das ist der
    Unterschied zwischen `abgeschaltet` und `armiert, aber unauffaellig`.
    """
    p = _lauf(tmp_path, "def test_ok():\n    assert True\n", "0")
    assert p.returncode == 0, p.stdout + p.stderr
    assert "[testdeckel]" not in (p.stdout + p.stderr)


@pytest.mark.parametrize("wert", ["spaeter", "inf", "nan", "1e12"])
def test_unbrauchbare_frist_bricht_ab_statt_still_zurueckzufallen(tmp_path, wert):
    """Ein unbrauchbarer Schalterwert darf nicht auf die Vorgabe zurueckfallen.

    Sonst laeuft jemand mit einem Deckel, den er abgeschaltet zu haben glaubt — oder
    umgekehrt. Dieselbe Regel wie `--strict-config` in `pyproject.toml`: wer einen Riegel
    baut, baut zuerst den Riegel gegen dessen eigenes Schweigen.

    Die drei Zahlenformen stehen hier, weil `float()` allein sie ALLE durchlaesst und der
    Kalt-Review sie gemessen hat: `inf` und `1e12` liegen ueber `threading.TIMEOUT_MAX`,
    der Zeitgeber-Faden stirbt dann still mit `OverflowError` und der Deckel ist inert —
    waehrend der Stash eine truthy Zahl traegt und der Waechter ihn fuer scharf haelt.
    `nan` ist die Gegenrichtung: jeder Vergleich damit ist falsch, auch `frist <= 0`, also
    feuert der Deckel SOFORT und toetet einen kerngesunden Lauf.

    Geprueft wird rc **4**, nicht bloss „ungleich 0": mit `nan` waere ein Lauf auch ohne
    den Riegel ungleich 0 (naemlich 99, erschossen vom eigenen Deckel) — die Zusicherung
    haette den Fehler dann nicht von seiner Wirkung unterscheiden koennen.
    """
    p = _lauf(tmp_path, "def test_ok():\n    assert True\n", wert)
    assert p.returncode == 4, (
        f"{wert!r}: rc {p.returncode} statt 4 (pytest-Nutzungsfehler). "
        f"99 hiesse, der Deckel hat einen gesunden Lauf erschossen; 0 hiesse, er ist "
        f"still inert.\n{(p.stdout + p.stderr)[-1500:]}"
    )
    assert "TRANSKRIBOR_TESTDECKEL" in (p.stdout + p.stderr)
