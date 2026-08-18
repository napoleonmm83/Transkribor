"""Metriken der Sprechertrennungs-Messung — rein synthetisch.

Bewusst OHNE echtes Material: der Referenzsatz liegt unter eval/ und wird nie committet
(Interviewinhalte). Die CI muss das Werkzeug trotzdem pruefen koennen.
"""
import importlib.util
import os
import sys

import pytest

_PFAD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "tools", "diar_eval.py")
_spec = importlib.util.spec_from_file_location("diar_eval", _PFAD)
de = importlib.util.module_from_spec(_spec)
sys.modules["diar_eval"] = de
_spec.loader.exec_module(de)


def test_fehlerquote_ist_null_bei_perfekter_zuordnung():
    ref = {1: "A", 2: "A", 3: "B"}
    dauer = {1: 1.0, 2: 2.0, 3: 3.0}
    assert de.fehlerquote({1: "X", 2: "X", 3: "Y"}, ref, dauer) == 0.0


def test_fehlerquote_ist_unabhaengig_von_den_etiketten():
    """Cluster-Namen sind willkuerlich ('SPEAKER_00' gegen 'Interviewer'). Eine Metrik, die
    sie vergleicht statt die PARTITION, misst die Benennung — genau das, was die Diarisierung
    gar nicht leistet. Ohne diese Zusicherung waere jede Zahl des Werkzeugs wertlos.
    """
    ref = {1: "A", 2: "B", 3: "A"}
    dauer = {1: 1.0, 2: 1.0, 3: 1.0}
    assert de.fehlerquote({1: "B", 2: "A", 3: "B"}, ref, dauer) == 0.0


def test_fehlerquote_gewichtet_nach_ZEIT_nicht_nach_anzahl():
    """Ein falsch zugeordnetes 30-Sekunden-Segment wiegt schwerer als ein falsches
    1-Sekunden-Segment.

    Alle drei Segmente landen in EINEM Cluster. Die beste Zuordnung waehlt B (6 s richtig),
    die 2 s von A sind der Fehler -> 2/8 = 0,25. Die Mutation „nach Segmentzahl zaehlen"
    waehlte A (2 von 3 Segmenten) und lieferte 1/3 — deutlich daneben, also rot.
    """
    ref = {1: "A", 2: "A", 3: "B"}
    dauer = {1: 1.0, 2: 1.0, 3: 6.0}
    quote = de.fehlerquote({1: "X", 2: "X", 3: "X"}, ref, dauer)
    assert quote == pytest.approx(2.0 / 8.0)


def test_v_measure_erkennt_ueber_UND_unterclustering():
    """Der Grund fuer V-Measure statt Trefferquote oder Reinheit: Reinheit belohnt
    Ueber-Clustering (k = n gibt 100 %), die ungarische Trefferquote bestraft es rechnerisch
    (ueberzaehlige Cluster bleiben unpaarig). V-Measure ist symmetrisch.
    """
    ref = {1: "A", 2: "A", 3: "B", 4: "B"}
    assert de.v_measure({1: "X", 2: "X", 3: "Y", 4: "Y"}, ref)[2] == pytest.approx(1.0)
    # alles in einen Topf (Unterclustering) und jedes fuer sich (Ueberclustering):
    assert de.v_measure({1: "X", 2: "X", 3: "X", 4: "X"}, ref)[2] < 0.5
    assert de.v_measure({1: "W", 2: "X", 3: "Y", 4: "Z"}, ref)[2] < 1.0


def test_metriken_ignorieren_einseitig_bekannte_segmente():
    """Die Referenz kann Segmente auslassen (unklare Stelle), der Lauf kann welche liefern,
    die es dort nicht gibt. Beides darf die Zahl nicht verschieben, sondern muss aus der
    Rechnung fallen — sonst misst man die Vollstaendigkeit der Referenz.
    """
    ref = {1: "A", 2: "B"}
    dauer = {1: 1.0, 2: 1.0, 99: 5.0}
    assert de.fehlerquote({1: "X", 2: "Y", 99: "Z"}, ref, dauer) == 0.0
    assert de.sprecherzahl({1: "X", 2: "Y"}) == 2


def test_gar_keine_gemeinsamen_segmente_ist_KEIN_bestwert():
    """Der gefaehrlichste Zustand des ganzen Werkzeugs: passen die Segment-IDs des Laufs nicht
    zur eingefrorenen Referenz (neu transkribierte Datei, verschobene IDs, ein
    --projekte-Tippfehler auf eine andere Kopie), gibt es NICHTS zu vergleichen.

    Eine 0.0 hiesse dort „fehlerfrei" — der Lauf bestuende die Abnahmekriterien 1 und 2
    lautlos, ausgerechnet weil er nichts gemessen hat. `nan` besteht keinen Vergleich, und
    `cmd_run` bricht darauf laut ab. (Das V-Measure meldet im selben Fall 0.0 = Totalversagen;
    zwei Metriken mit entgegengesetzter Bedeutung fuer dieselbe Eingabe waeren die Falle.)
    """
    import math
    assert math.isnan(de.fehlerquote({1: "X"}, {2: "A"}, {1: 1.0}))
    assert math.isnan(de.fehlerquote({}, {}, {}))
