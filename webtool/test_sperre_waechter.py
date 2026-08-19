"""#222: der Windows-Waechter fuer die drei Nur-Windows-Tests in `test_sperre.py`.

Der Windows-Job der CI existiert NUR fuer diese drei Tests (#201) — und nichts
prueft, dass sie laufen: ein aufgeweiteter skipif, eine Umbenennung, ein
Refactoring der Bedingung nähme sie still weg, und der Job bliebe dabei GRUEN
(``692 passed, 1 skipped``).

Warum der Waechter in einem EIGENEN Modul steht (CodeRabbit-Major an PR #291):
ein spaeteres Modul-Level ``pytestmark = pytest.mark.skipif(...)`` in
`test_sperre.py` ueberspringe die drei Zieltests UND einen dort wohnenden
Waechter gemeinsam — hier bleibt er davon unberuehrt und sieht das Modulmarker-
Attentat. Deshalb prueft er ausser den Funktionsmarkern auch die Modulmarker.

Gelesen wird das importierte Modul, nicht die pytest-Sammlung — darum trifft der
Waechter auch bei `-k`-Auswahl zu, und ein fehlender Name (umbenannt/geloescht)
wird ebenso rot wie eine Bedingung, die auf Windows ueberspringt.

NICHT abgedeckt — und in pytest nicht abdeckbar — sind das Zurueckbauen der
Matrix in test.yml selbst und ein `pytest.skip()` mitten im Testkoerper;
ersteres koennte nur die CI-Seite pruefen. Und die Kette endet HIER: diesen
Waechter selbst zu loeschen oder zu ueberspringen hat keine Folge — ein
Waechter-der-Waechter waere endlos, diese Spitze ist bewusst ungedeckt.
"""
import os

import pytest

from webtool import test_sperre as _modul

_NUR_WINDOWS = (
    "test_windows_beantwortet_beide_openprocess_ausgaenge",
    "test_freigabe_ueberlebt_einen_lesenden_warter",
    "test_freigabe_erkennt_ein_fremdes_lock_auch_OHNE_merker",
)


def _markers(objekt):
    """Funktions- wie Modul-`pytestmark` — ein einzelner Marker steht ohne Liste."""
    markers = getattr(objekt, "pytestmark", [])
    return markers if isinstance(markers, list) else [markers]


def _bedingung(marker):
    """args[0], sonst das kwargs-`condition` (CodeRabbit-Minor: beide Aufrufformen),
    sonst True — ein args-loser skipif ohne Bedingung ist ungueltig und gilt laut."""
    if marker.args:
        return marker.args[0]
    return marker.kwargs.get("condition", True)


@pytest.mark.skipif(os.name != "nt", reason="Der Waechter wacht nur dort, wo die drei laufen sollen")
def test_die_drei_nur_windows_tests_laufen_auf_windows_wirklich():
    # Erst das Modulmarker-Attentat (der Grund, warum dieser Test hier wohnt):
    # ein Modul-Level-skip/skipif/xfail nähme ALLE Tests der Datei — auch die drei.
    for marker in _markers(_modul):
        assert marker.name not in ("skip", "xfail"), (
            f"test_sperre.py traegt ein Modul-Level-{marker.name} — das ueberspringt "
            "die drei Nur-Windows-Tests gleich mit (#222)."
        )
        if marker.name == "skipif":
            assert not _bedingung(marker), (
                f"test_sperre.py traegt ein Modul-Level-skipif (Bedingung "
                f"{_bedingung(marker)!r}) — es uebersprunge die drei Nur-Windows-"
                "Tests gleich mit (#222)."
            )
    for name in _NUR_WINDOWS:
        funktion = getattr(_modul, name, None)
        assert funktion is not None, (
            f"{name} fehlt in test_sperre.py — umbenannt oder geloescht? Der "
            "Windows-Job der CI liefe ohne jeden Gegenwert weiter (Issue #222)."
        )
        for marker in _markers(funktion):
            assert marker.name != "skip", (
                f"{name} traegt ein bedingungsloses skip — auf Windows laeuft es nie (#222)."
            )
            assert marker.name != "xfail", (
                f"{name} traegt xfail — `xfail(run=False)` ueberspringt ganz, ein normales "
                "xfail macht einen FEHLER gruen; in beiden Faellen lief der Test in der "
                "Windows-CI nie wirksam (#222, CodeRabbit-Fund)."
            )
            if marker.name == "skipif":
                bedingung = _bedingung(marker)
                assert not bedingung, (
                    f"{name} wuerde auf Windows uebersprungen (Bedingung {bedingung!r}). "
                    "Policy (#222): diese drei Tests MUESSEN auf Windows laufen — ein neuer, "
                    "berechtigter Grund, einen zu ueberspringen, gehoert als bewusste Aenderung "
                    "an _NUR_WINDOWS und diesem Waechter her, nicht als Fehlalarm, den man "
                    "wegdrückt. String-Bedingungen gelten als wahr: sie sind abgekündigter "
                    "pytest-Stil und werden hier absichtlich laut."
                )
