"""Gemeinsame Vorkehrungen fuer die Python-Tests.

Es gab bis #459 keine `conftest.py` — sie entsteht fuer genau EINEN Riegel, und der Grund ist
eine Fehlerklasse, die dieser PR selbst aufgemacht hat.

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
Grundwert, wo keiner gesetzt wurde.
"""
import pytest


@pytest.fixture(autouse=True)
def _wegwerf_projektwurzel(monkeypatch, tmp_path):
    """Jeder Test bekommt eine Wegwerf-Projektwurzel, auch wenn er keine anfordert.

    Ohne Zutun des Tests, weil genau das Zutun die Luecke war. `TRANSKRIBOR_SETTINGS` gleich
    mit: dieselbe Familie (der Lifespan-Shutdown ruft `ytdlp_update.beim_ende()`, dessen
    Sperrpfad sonst im Profil des Entwicklers laege — das steht seit #224 als Begruendung im
    Docstring desselben Tests).
    """
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path / "_wegwerf_projekte"))
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "_wegwerf_settings.json"))
