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
    # Alles in einen Topf (Unterclustering): gemessen 0.0.
    assert de.v_measure({1: "X", 2: "X", 3: "X", 4: "X"}, ref)[2] < 0.1
    # Jedes fuer sich (Ueberclustering): gemessen 0.667. Die Schranke stand auf `< 1.0` und
    # war damit fast wertlos — ein Vertauschen von V gegen die blosse HOMOGENITAET waere
    # durchgekommen, und genau die belohnt Ueberclustering mit 1.0.
    h, c, v = de.v_measure({1: "W", 2: "X", 3: "Y", 4: "Z"}, ref)
    assert v < 0.75
    # Die strukturelle Aussage, unabhaengig von der sklearn-Fassung: Homogenitaet allein sieht
    # hier ein perfektes Ergebnis, V nicht. Das IST der Grund fuer V statt Reinheit.
    assert h == pytest.approx(1.0) and v < h


def test_metriken_ignorieren_einseitig_bekannte_segmente():
    """Die Referenz kann Segmente auslassen (unklare Stelle), der Lauf kann welche liefern,
    die es dort nicht gibt. Beides darf die Zahl nicht verschieben, sondern muss aus der
    Rechnung fallen — sonst misst man die Vollstaendigkeit der Referenz.

    `sprecherzahl` bekommt hier BEWUSST das ungefilterte Dict samt der 99 — genau so steht es
    an der Aufrufstelle in `cmd_run`. Vorher stand hier ein vorgefiltertes `{1,2}`, womit der
    Test seine eigene Zusicherung („beides darf die Zahl nicht verschieben") fuer
    `sprecherzahl` nicht ausuebte: er war vacuous, und `cmd_run` zaehlte tatsaechlich einen
    Cluster zu viel gegen `sprecher_wahr` (Review, gemessen).
    """
    ref = {1: "A", 2: "B"}
    dauer = {1: 1.0, 2: 1.0, 99: 5.0}
    vorhersage = {1: "X", 2: "Y", 99: "Z"}
    assert de.fehlerquote(vorhersage, ref, dauer) == 0.0
    assert de.sprecherzahl(de.nur_gemeinsame(vorhersage, ref)) == 2


def test_sprecherzahl_zaehlt_leere_etiketten_NICHT():
    """`assign_clusters` liefert fuer ein Segment ohne ueberlappenden Turn ein leeres Etikett.
    Als eigener „Sprecher" gezaehlt verschoebe es die Zahl, die Abnahmekriterium 3 traegt.

    Ohne diesen Test hat der `if v`-Filter NULL Abdeckung — im Review nachgemessen: entfernt
    man ihn, bleiben alle Tests gruen. Scharf wird er, sobald in der Handkorrektur ein
    Sprecher geleert wird (unklare Stelle, `[Musik]`).
    """
    assert de.sprecherzahl({1: "A", 2: "", 3: None, 4: "B"}) == 2


def test_gemeinsam_laesst_sprecherlose_REFERENZsegmente_aus():
    """Ein Referenzsegment ohne Sprecher ist keine Aussage, gegen die man messen kann.

    Zweiter Waechter mit vorher NULL Abdeckung (`and referenz[i]`): ohne ihn zaehlte ein
    leerer Referenz-Sprecher als eigene Klasse und verschoebe V-Measure wie Fehlerquote.
    """
    ref = {1: "A", 2: "", 3: "B"}
    dauer = {1: 1.0, 2: 99.0, 3: 1.0}
    # Segment 2 faellt raus -> perfekte Zuordnung der restlichen zwei.
    assert de.fehlerquote({1: "X", 2: "X", 3: "Y"}, ref, dauer) == 0.0


def test_summe_meldet_auf_einem_LEEREN_lauf_keinen_bestwert():
    """Dieselbe Falle wie beim `nan`: `V 0.000` heisst Totalversagen, `Fehler 0.0 %` heisst
    fehlerfrei — fuer dieselbe Eingabe. `cmd_run` schreibt zwar nie einen leeren Lauf, aber
    `cmd_vergleich` liest seine Laeufe aus DATEIEN, und die kann jemand von Hand anlegen.
    """
    summe = de._summe("leer", {})
    assert summe["fehler_zeitgewichtet"] is None
    assert summe["v_mittel_je_datei"] is None


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


def test_unter_eval_weist_pfade_AUSSERHALB_ab():
    r"""Die Wache, an der der wichtigste Constraint des ganzen Vorhabens haengt: „nie nach
    projekte\ schreiben". Sie war nur durch Ausfuehrung geprueft, nicht durch einen Test —
    und ein Werkzeug, das echtes Interviewmaterial liest, darf seinen Schreibpfad nicht bloss
    durch Disziplin sichern.

    Geprueft wird der AUFGELOESTE Pfad: `eval/../projekte/x` sieht harmlos aus und zeigt
    woanders hin.
    """
    with pytest.raises(SystemExit):
        de._unter_eval(os.path.join("..", "projekte", "x.json"))
    with pytest.raises(SystemExit):
        de._unter_eval(os.path.join(de.EVAL, "..", "projekte", "x.json"))
    # Der erlaubte Fall muss durchkommen, sonst waere die Wache ein Totalriegel.
    assert de._unter_eval(os.path.join(de.EVAL, "laeufe", "x.json")).startswith(de.EVAL)


def test_eval_haengt_am_REPO_nicht_am_arbeitsverzeichnis(tmp_path, monkeypatch):
    r"""`os.path.abspath("eval")` wurde beim Import ausgewertet und meinte `$CWD/eval` — ein
    `cd projekte` und das Werkzeug legte `projekte\eval\` an, waehrend der Moduldocstring
    „schreibt AUSSCHLIESSLICH nach eval/" verspricht.
    """
    monkeypatch.chdir(tmp_path)
    assert de.EVAL == os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(de.__file__))), "eval")
    assert not de.EVAL.startswith(str(tmp_path))


def test_lauf_name_laesst_keine_pfadanteile_durch():
    """Der Laufname geht ungeprueft in einen Dateipfad. Ohne diese Wache schriebe
    `run ../../projekte/x` genau dorthin, wo es verboten ist."""
    # Der Backslash MUSS doppelt stehen: `"a\b"` ist ein BACKSPACE-Zeichen, und der Test
    # pruefte damit etwas anderes, als er behauptet — er blieb gruen, weil auch ein Backspace
    # kein `isalnum()` ist. Sichtbar wird das nur beim Kompilieren (SyntaxWarning „invalid
    # escape sequence"), nicht am Testergebnis.
    # GEZIELT `argparse.ArgumentTypeError`, nicht `Exception`: ein Tippfehler im Testnamen
    # (`de._lauf_nmae`) wuerfe einen AttributeError, und der Test bliebe gruen — er prueft
    # dann, dass irgendetwas schiefgeht, nicht dass die WACHE greift.
    import argparse
    for schlecht in ("../x", "a/b", "a\\b", ".versteckt", "", "a:b", "..", "x/../y"):
        with pytest.raises(argparse.ArgumentTypeError):
            de._lauf_name(schlecht)
    for gut in ("nullpunkt", "kandidat-1", "v0.2_test"):
        assert de._lauf_name(gut) == gut
