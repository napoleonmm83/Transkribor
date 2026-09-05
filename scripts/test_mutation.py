"""Waechter fuer den Mutationstreiber — die reinen Funktionen, ohne Testlauf.

Der Treiber ist selbst ein Waechter, und fuer die gilt hier dieselbe Regel wie fuer
`ruff_riegel.py` und `mypy_riegel.py`: das Gefaehrliche ist nicht, dass er falsch
urteilt, sondern dass er URTEILT, obwohl er nichts gesehen hat. Genau das ist beim
ersten echten Lauf am 2026-09-05 passiert — er meldete dreimal `Mutation wirkungslos`,
waehrend das Testkommando gar nicht gestartet war.

Die Fixtures sind ECHTE Ausgaben, keine erfundenen: die pytest-Zeilen stammen aus einem
Lauf ueber `scripts/test_mypy_riegel.py`, die vitest-Zeilen aus dem Frontend-Lauf, und
der cmd.exe-Text ist woertlich das, was `shell=True` auf Windows zurueckgab.
"""

import sys
from pathlib import Path

# Der Pfad muss VOR dem Import stehen — E402/I001 sind hier die Folge der Reihenfolge,
# nicht der Unordnung. Dieselbe Form wie in test_mypy_riegel.py.
sys.path.insert(0, str(Path(__file__).parent))
import mutation  # noqa: E402, I001


# --- Der Riegel gegen das eigene Schweigen --------------------------------
# Ohne ihn ist "das Kommando lief nicht" von "die Mutation wirkte nicht" nicht zu
# unterscheiden: beide liefern null rote Zeilen.

def test_pytest_ausgabe_gilt_als_testlauf():
    assert mutation._sah_einen_testlauf("...\n1 failed, 45 passed in 6.02s\n")


def test_pytest_gruener_lauf_gilt_als_testlauf():
    assert mutation._sah_einen_testlauf("46 passed in 5.71s\n")


def test_vitest_ausgabe_gilt_als_testlauf():
    assert mutation._sah_einen_testlauf(" Test Files  1 failed (1)\n      Tests  1 failed | 9 passed (10)\n")


def test_tap_ausgabe_gilt_als_testlauf():
    assert mutation._sah_einen_testlauf("TAP version 13\n1..3\nok 1 - erster\n")


def test_pytest_ohne_treffer_gilt_als_testlauf():
    # "no tests ran" ist ein Ergebnis, kein Ausfall — der Treiber darf es nicht mit
    # einem nicht gestarteten Kommando verwechseln.
    assert mutation._sah_einen_testlauf("no tests ran in 0.31s\n")


def test_cmd_fehlermeldung_gilt_NICHT_als_testlauf():
    # Woertlich gemessen am 2026-09-05: `shell=True` startet cmd.exe, und cmd.exe kennt
    # kein `./`. rc 1, leeres stdout — also derselbe Rueckgabecode wie "es gibt Fehler".
    aus = ('Der Befehl "." ist entweder falsch geschrieben oder\n'
           "konnte nicht gefunden werden.\n")
    assert not mutation._sah_einen_testlauf(aus)


def test_leere_ausgabe_gilt_NICHT_als_testlauf():
    assert not mutation._sah_einen_testlauf("")


def test_import_fehler_gilt_NICHT_als_testlauf():
    # Ein Traceback ohne Testzusammenfassung heisst: die Suite kam nicht bis zum Laufen.
    aus = 'Traceback (most recent call last):\nModuleNotFoundError: No module named "pytest"\n'
    assert not mutation._sah_einen_testlauf(aus)


# --- Die Fehlzeilen-Erkennung ---------------------------------------------

def test_fehlzeilen_aller_drei_laeufer():
    assert mutation._ist_fehlzeile("not ok 101 - der Deckel ist ein Zeitfenster")
    assert mutation._ist_fehlzeile("FAILED scripts/test_x.py::test_y - assert False")
    assert mutation._ist_fehlzeile("   × jobPhases > reiht ein")
    assert mutation._ist_fehlzeile("  ✗ etwas")


def test_gruene_zeilen_sind_keine_fehlzeilen():
    assert not mutation._ist_fehlzeile("ok 12 - alles gut")
    assert not mutation._ist_fehlzeile("46 passed in 5.71s")
    assert not mutation._ist_fehlzeile("")


def test_eingerueckte_fehlzeile_zaehlt_die_TAP_form_nicht():
    # `not ok` ist bei TAP spaltentreu am Zeilenanfang; eingerueckt gehoert es zu einem
    # Unter-Test und wuerde sonst doppelt zaehlen.
    assert not mutation._ist_fehlzeile("    not ok 3 - untergeordnet")


# --- Der Anker ------------------------------------------------------------

def test_anker_genau_einmal_ist_ok():
    ok, treffer = mutation.anker_ok("aaa\nBBB\nccc\n", "BBB")
    assert ok and treffer == 1


def test_anker_zweimal_ist_nicht_ok():
    # Zwei Treffer sind so gefaehrlich wie null: `replace(..., 1)` erwischt still den
    # falschen. Genau daran ist in diesem Repo schon eine Messung gescheitert.
    ok, treffer = mutation.anker_ok("BBB\nxxx\nBBB\n", "BBB")
    assert not ok and treffer == 2


def test_anker_gar_nicht_ist_nicht_ok():
    ok, treffer = mutation.anker_ok("aaa\n", "BBB")
    assert not ok and treffer == 0


# --- Zeilenenden ----------------------------------------------------------

def test_plan_wird_an_crlf_datei_angepasst():
    assert mutation.zeilenenden_angleichen("a\r\nb\r\n", "x\ny") == "x\r\ny"


def test_plan_bleibt_bei_lf_datei_unveraendert():
    assert mutation.zeilenenden_angleichen("a\nb\n", "x\ny") == "x\ny"


def test_einzeiler_ist_von_den_zeilenenden_unberuehrt():
    assert mutation.zeilenenden_angleichen("a\r\nb\r\n", "ohne Umbruch") == "ohne Umbruch"


# --- Bytecode-Aufraeumen --------------------------------------------------

def test_pycache_wird_geleert(tmp_path):
    # Sonst gilt nach einer groessengleichen Mutation der Bytecode der MUTIERTEN Datei
    # weiter — und die gefaehrliche Richtung ist, dass ein echter Fehler dahinter
    # gruen bleibt.
    (tmp_path / "a" / "__pycache__").mkdir(parents=True)
    (tmp_path / "a" / "__pycache__" / "x.pyc").write_bytes(b"alt")
    (tmp_path / "b" / "__pycache__").mkdir(parents=True)
    assert mutation._pycache_leeren(tmp_path) == 2
    assert not list(tmp_path.rglob("__pycache__"))


def test_pycache_leeren_ohne_treffer_ist_kein_fehler(tmp_path):
    assert mutation._pycache_leeren(tmp_path) == 0
