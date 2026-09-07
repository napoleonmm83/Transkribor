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
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

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
    feste Schalter. Deshalb steht hier ein `noqa` fuer S603 statt einer Umschreibung, und
    deshalb gibt es genau EINE solche Stelle in dieser Datei.

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


@pytest.mark.parametrize("fall", sorted(FAELLE))
def test_der_deckel_beendet_den_lauf_und_sagt_wo(tmp_path, fall):
    """Alle drei Faelle: eigener Rueckgabecode, Markerzeile, Stapelabzug."""
    from conftest import DECKEL_RC

    rc, aus = _haenger(tmp_path, FAELLE[fall])

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
    from conftest import DECKEL_RC

    rc, aus = _haenger(tmp_path, FAELLE["nach_dem_letzten_test"])

    assert "1 passed" in aus, f"Der Aufbau stimmt nicht mehr — der Test lief gar nicht:\n{aus}"
    assert rc == DECKEL_RC, (
        f"rc {rc}: Protokoll meldet Erfolg, der Lauf steht, und niemand merkt es."
    )


def test_null_schaltet_den_deckel_ab(tmp_path):
    """Der Ausweg muss ein Ausweg sein — sonst baut sich jemand einen eigenen."""
    p = _lauf(tmp_path, "def test_ok():\n    assert True\n", "0")
    assert p.returncode == 0, p.stdout + p.stderr
    assert "[testdeckel]" not in (p.stdout + p.stderr)


def test_unlesbare_frist_bricht_ab_statt_still_zurueckzufallen(tmp_path):
    """Ein Tippfehler im Schalter darf nicht auf die Vorgabe zurueckfallen.

    Sonst laeuft jemand mit einem Deckel, den er abgeschaltet zu haben glaubt — oder
    umgekehrt. Dieselbe Regel wie `--strict-config` in `pyproject.toml`: wer einen Riegel
    baut, baut zuerst den Riegel gegen dessen eigenes Schweigen.
    """
    p = _lauf(tmp_path, "def test_ok():\n    assert True\n", "spaeter")
    assert p.returncode != 0, "Ein unlesbarer Wert lief still durch"
    assert "TRANSKRIBOR_TESTDECKEL" in (p.stdout + p.stderr)
