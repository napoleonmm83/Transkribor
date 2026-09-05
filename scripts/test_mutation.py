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

import json
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
    # Die Zeichen sind NICHT austauschbar, und die erste Fassung dieses Tests hielt eines
    # fest, das zu keinem der Laeufer gehoert (U+2717): vitest nimmt U+00D7, der
    # Spec-Reporter von node:test U+2716. Ein Zweig ohne Laeufer haelt sich sonst als
    # gruener Test am Leben, waehrend der Zweig fehlt, den die CI wirklich braucht.
    assert mutation._ist_fehlzeile("not ok 101 - der Deckel ist ein Zeitfenster")
    assert mutation._ist_fehlzeile("FAILED scripts/test_x.py::test_y - assert False")
    assert mutation._ist_fehlzeile("   × jobPhases > reiht ein")
    assert mutation._ist_fehlzeile("  ✖ faellt")


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


# --- Das URTEIL: was der Treiber am Ende zurueckgibt -----------------------
# Der kalte Diff-Review hat gezeigt, dass genau dieser Teil null Abdeckung hatte: mit
# `return 0` statt `return 0 if fehler == 0 else 1` blieben ALLE Tests UND beide
# Mutationsserien gruen, waehrend der Treiber "SERIE FEHLGESCHLAGEN" druckte. Ein Waechter,
# dessen Rueckgabecode ungeprueft ist, macht gruene CI aus roten Laeufen.

def _lauf_main(tmp_path, monkeypatch, plan, ausgaben, pfad=".", schmutzig=("", ""),
               nebenbei=None):
    """Faehrt main() mit gefaelschtem Testlauf und gefaelschtem git — ohne echtes Repo.

    `ausgaben` sind Strings (Rueckgabecode 0) oder Paare (Text, Rueckgabecode).
    `schmutzig` ist (am Anfang, am Ende) — so laesst sich der Startriegel UND die
    Schlusspruefung einzeln festhalten, ohne ein echtes Repo zu brauchen.
    `nebenbei` schreibt WAEHREND des Testlaufs in die Zieldatei — die Attrappe fuer eine
    parallel arbeitende Sitzung.
    """
    ziel = tmp_path / "ziel.py"
    ziel.write_bytes(b"WERT = 1\r\nandere = 2\r\n")          # bewusst CRLF
    plandatei = tmp_path / "plan.json"
    plandatei.write_text(json.dumps(plan), encoding="utf-8")

    rest = [a if isinstance(a, tuple) else (a, 0) for a in ausgaben]

    aufrufe = []

    def falscher_lauf(repo, kommando):
        # `nebenbei` erst AB DEM ZWEITEN Aufruf — der erste ist die Positivkontrolle, und
        # dort ist noch nichts mutiert. Die erste Fassung schrieb bei jedem Aufruf, womit
        # die Zieldatei schon vor der Mutation fremd war: der Anker passte dann nicht, der
        # Test wurde aus dem FALSCHEN Grund rot und blieb es auch ohne den geprueften
        # Waechter. Gefunden von der Mutationsprobe dieses PR (MB9) — genau ihr Zweck.
        aufrufe.append(kommando)
        if nebenbei is not None and len(aufrufe) > 1:
            ziel.write_bytes(nebenbei)
        return rest.pop(0)

    zustaende = list(schmutzig)
    monkeypatch.setattr(mutation, "_lauf", falscher_lauf)
    monkeypatch.setattr(mutation, "_verfolgt_geaendert",
                        lambda repo, p: zustaende.pop(0) if zustaende else "")
    rc = mutation.main(["--repo", str(tmp_path), "--test", "egal",
                        "--plan", str(plandatei), "--pfad", pfad])
    return rc, ziel


_GRUEN = "12 passed in 0.4s\n"
_PLAN_OK = [{"id": "T1", "datei": "ziel.py", "von": "WERT = 1", "nach": "WERT = 2",
             "rot": ["test_wert"], "gruen": ["test_andere"]}]


def test_erwarteter_test_wird_rot_ergibt_null(tmp_path, monkeypatch):
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK,
                       [_GRUEN, "FAILED x.py::test_wert - assert\n1 failed, 11 passed in 0.4s\n"])
    assert rc == 0


def test_erwarteter_test_bleibt_gruen_ergibt_eins(tmp_path, monkeypatch):
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, [_GRUEN, _GRUEN])
    assert rc == 1


def test_gegenprobe_wird_rot_ergibt_eins(tmp_path, monkeypatch):
    # Beide erwarteten Namen rot — der zweite haette gruen bleiben MUESSEN.
    aus = ("FAILED x.py::test_wert - assert\nFAILED x.py::test_andere - assert\n"
           "2 failed, 10 passed in 0.4s\n")
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, [_GRUEN, aus])
    assert rc == 1


def test_leere_rot_liste_bricht_ab(tmp_path, monkeypatch):
    plan = [{"id": "LEER", "datei": "ziel.py", "von": "WERT = 1", "nach": "WERT = 2",
             "rot": []}]
    rc, _ = _lauf_main(tmp_path, monkeypatch, plan, [_GRUEN])
    assert rc == 1


def test_datei_ausserhalb_von_pfad_bricht_ab(tmp_path, monkeypatch):
    (tmp_path / "unter").mkdir()
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, [_GRUEN], pfad="unter")
    assert rc == 1


def test_ruecknahme_ist_bytegleich_auch_bei_crlf(tmp_path, monkeypatch):
    rc, ziel = _lauf_main(tmp_path, monkeypatch, _PLAN_OK,
                          [_GRUEN, "FAILED x.py::test_wert - assert\n1 failed in 0.4s\n"])
    assert rc == 0
    assert ziel.read_bytes() == b"WERT = 1\r\nandere = 2\r\n"


# --- Die Positivkontrolle -------------------------------------------------

def test_nicht_gestartetes_kommando_ergibt_zwei(tmp_path, monkeypatch):
    aus = 'Der Befehl "." ist entweder falsch geschrieben oder\n'
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, [aus])
    assert rc == 2


def test_null_ausgefuehrte_tests_ergeben_zwei(tmp_path, monkeypatch):
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, ["no tests ran in 0.31s\n"])
    assert rc == 2


def test_vorher_schon_rote_suite_ergibt_zwei(tmp_path, monkeypatch):
    aus = "FAILED x.py::test_irgendwas - assert\n1 failed, 11 passed in 0.4s\n"
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, [aus])
    assert rc == 2


def test_startriegel_haelt_schmutzigen_baum_auf(tmp_path, monkeypatch):
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, [_GRUEN],
                       schmutzig=(" M ziel.py", ""))
    assert rc == 2


def test_liegengebliebene_mutation_am_ende_ergibt_eins(tmp_path, monkeypatch):
    # Der Baum war beim Start sauber und ist es am Ende nicht — irgendetwas blieb liegen.
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK,
                       [_GRUEN, "FAILED x.py::test_wert - assert\n1 failed in 0.4s\n"],
                       schmutzig=("", " M ziel.py"))
    assert rc == 1


def test_escapte_testnamen_werden_erkannt(tmp_path, monkeypatch):
    # FALLE 3, gemessen an echter node-Ausgabe: TAP escapet die Raute im Testnamen.
    # Ohne das Entescapen findet der Abgleich die rote Zeile nie und meldet
    # faelschlich "Mutation wirkungslos".
    plan = [{"id": "T", "datei": "ziel.py", "von": "WERT = 1", "nach": "WERT = 2",
             "rot": ["faellt (#448)"]}]
    aus = "TAP version 13\nnot ok 2 - faellt (\\#448)\n1..2\n# tests 2\n# fail 1\n"
    rc, _ = _lauf_main(tmp_path, monkeypatch, plan, ["ok 1 - x\n# tests 1\n# pass 1\n", aus])
    assert rc == 0


def test_tap_ohne_planzeile_gilt_als_testlauf():
    # Der zweite Zweig von _sah_einen_testlauf: eine nackte ok-Zeile ohne 1..-Plan.
    assert mutation._sah_einen_testlauf("ok 1 - erster\nok 2 - zweiter\n")


def test_node_spec_fehlzeile_wird_erkannt():
    # Der Spec-Reporter von node:test nimmt U+2716, nicht das vitest-Kreuz U+00D7.
    assert mutation._ist_fehlzeile("  ✖ faellt (#448)")


def test_node_bilanz_gilt_als_lauf_mit_tests():
    assert mutation._lief_mindestens_ein_test("# tests 2\n# pass 1\n# fail 1\n")
    assert mutation._lief_mindestens_ein_test("ℹ tests 2\nℹ pass 1\n")


def test_node_bilanz_ohne_einen_einzigen_test_gilt_nicht():
    assert not mutation._lief_mindestens_ein_test("# tests 0\n# pass 0\n# fail 0\n")


def test_fremde_schreibung_waehrend_des_laufs_bricht_ab(tmp_path, monkeypatch):
    # Der Kern des gegnerischen Befundes: schreibt jemand WAEHREND des Testlaufs in die
    # mutierte Datei, darf die Ruecknahme sie nicht ueberschreiben. Vorher ging genau das
    # spurlos durch, mit rc 0 und der Meldung "Arbeitsbaum sauber".
    fremd = b"FREMDE ARBEIT\r\n"
    rc, ziel = _lauf_main(tmp_path, monkeypatch, _PLAN_OK,
                          [_GRUEN, "FAILED x.py::test_wert - assert\n1 failed in 0.4s\n"],
                          nebenbei=fremd)
    assert rc == 1
    assert ziel.read_bytes() == fremd      # NICHT ueberschrieben


def test_pytest_nutzungsfehler_ergibt_zwei(tmp_path, monkeypatch):
    # pytest 4 = Nutzungsfehler, 5 = keine Tests gesammelt. Der Rueckgabecode ist hier
    # eindeutig, wo die Textsuche raten muesste.
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, [("irgendwas\n", 4)])
    assert rc == 2


def test_pytest_keine_tests_gesammelt_ergibt_zwei(tmp_path, monkeypatch):
    rc, _ = _lauf_main(tmp_path, monkeypatch, _PLAN_OK, [("12 passed in 1s\n", 5)])
    assert rc == 2


def test_mehrdeutiger_anker_ergibt_eins(tmp_path, monkeypatch):
    plan = [{"id": "MEHRDEUTIG", "datei": "ziel.py", "von": "= ", "nach": "== ",
             "rot": ["test_wert"]}]
    rc, _ = _lauf_main(tmp_path, monkeypatch, plan, [_GRUEN])
    assert rc == 1
