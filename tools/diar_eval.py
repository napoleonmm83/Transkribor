"""Messwerkzeug fuer die Sprechertrennung — freeze / run / vergleich.

KEIN Teil des Produkts: der Server importiert das hier nie. Es liest Marcus' echtes Material
und schreibt AUSSCHLIESSLICH nach eval/ (gitignoriert) — insbesondere ruft es
`diarize.diarize_file` direkt und NIE `correct.cmd_diarize`, das Sidecars in echte Projekte
schreiben wuerde.

Drei Zahlen je Datei, ihre Wahl ist begruendet in
docs/superpowers/specs/2026-08-17-transkribor-diarisierung-verbessern-design.md:
  Sprecherzahl  — die Zaehlung (laut #264 der einzige Knopf, der exakt trifft)
  V-Measure     — die Trennung, symmetrisch gegen Ueber- und Unterclustering
  Fehlerquote   — zeitgewichtet, das was der Nutzer merkt

Die Fehlerquote ist KEIN DER: es fehlen der VAD- und der Overlap-Term, und die Aufloesung ist
das Whisper-Segment statt des Rahmens. Sie wird deshalb nirgends so genannt. Die Aufloesung ist
Absicht — sie ist die Grenze, an der das Ergebnis den Nutzer erreicht.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _gemeinsam(vorhersage: dict, referenz: dict) -> list:
    """IDs, die BEIDE Seiten kennen. Einseitige fallen aus der Rechnung — sonst misst man die
    Vollstaendigkeit der Referenz statt die Guete des Laufs."""
    return sorted(i for i in referenz if i in vorhersage and referenz[i])


def sprecherzahl(zuordnung: dict) -> int:
    return len({v for v in zuordnung.values() if v})


def v_measure(vorhersage: dict, referenz: dict) -> tuple:
    """(Homogenitaet, Vollstaendigkeit, V-Measure). Alle drei einzeln, weil sie verschiedene
    Fehler benennen: niedrige Homogenitaet = Cluster mischt Personen, niedrige
    Vollstaendigkeit = eine Person auf mehrere Cluster verteilt (genau #267)."""
    from sklearn.metrics import homogeneity_completeness_v_measure
    ids = _gemeinsam(vorhersage, referenz)
    if not ids:
        return (0.0, 0.0, 0.0)
    return tuple(homogeneity_completeness_v_measure([referenz[i] for i in ids],
                                                    [vorhersage[i] for i in ids]))


def fehlerquote(vorhersage: dict, referenz: dict, dauer: dict) -> float:
    """Anteil der Redezeit, die einem falschen Sprecher zugeordnet wurde (0.0 = perfekt).

    Die beste Cluster->Sprecher-Zuordnung wird ueber die ungarische Methode auf der
    ZEITgewichteten Kontingenztabelle bestimmt: Cluster-Etiketten sind willkuerlich, verglichen
    wird die Partition. Gewichtet wird nach Dauer, nicht nach Segmentzahl — ein falsch
    zugeordneter 30-Sekunden-Block wiegt schwerer als ein 'Mhm'.
    """
    import numpy as np
    from scipy.optimize import linear_sum_assignment
    ids = _gemeinsam(vorhersage, referenz)
    gesamt = sum(dauer.get(i, 0.0) for i in ids)
    if not ids or gesamt <= 0:
        # NICHT 0.0 — das hiesse „fehlerfrei" und liesse einen Lauf, der gar nichts vergleichen
        # konnte, die Abnahme lautlos bestehen. `nan` besteht keinen Groessenvergleich.
        return float("nan")
    cs = sorted({vorhersage[i] for i in ids})
    ns = sorted({referenz[i] for i in ids})
    m = np.zeros((len(cs), len(ns)))
    ci = {c: k for k, c in enumerate(cs)}
    ni = {n: k for k, n in enumerate(ns)}
    for i in ids:
        m[ci[vorhersage[i]], ni[referenz[i]]] += dauer.get(i, 0.0)
    zeile, spalte = linear_sum_assignment(-m)
    return 1.0 - float(m[zeile, spalte].sum()) / gesamt
