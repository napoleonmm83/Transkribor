"""Waechter fuer den Laeufer der Mutationsplaene.

Das Gefaehrliche an einer AUSWAHL ist, dass sie zu wenig waehlt: ein Plan, der nicht laeuft,
sieht in der Bilanz genauso aus wie einer, der bestanden hat. Deshalb pruefen die Tests hier
beide Richtungen — waehlt sie das Richtige, UND meldet sie es, wenn sie nichts findet.

Gefahren wird ueber `--nur-auswahl`: die Auswahl ist die Logik, das Fahren ist ein
subprocess-Aufruf. Ein Test, der wirklich mutiert, braeuchte Minuten und pruefte den Treiber
statt den Laeufer.
"""

import sys
from pathlib import Path

# Der Pfad muss VOR dem Import stehen — E402/I001 sind hier die Folge der Reihenfolge,
# nicht der Unordnung. Dieselbe Form wie in test_mutation.py.
sys.path.insert(0, str(Path(__file__).parent))
import mutationen_lauf  # noqa: E402, I001

WURZEL = Path(__file__).resolve().parents[1]


def _plan(name, pfade, mutationen=1):
    return mutationen_lauf.Plan(
        datei=Path(f"scripts/mutationen/{name}.json"), test="egal", pfade=list(pfade),
        mutationen=[{"id": f"M{i}"} for i in range(mutationen)])


# --- Die Auswahl ----------------------------------------------------------

def test_globaler_pfad_zieht_ALLE_plaene():
    """Ein Treiberfehler entwertet jede Serie — er steht aber nur in EINEM `pfade`.

    Ohne diese Regel liefe eine Aenderung an `scripts/mutation.py` an neun von zehn
    Plaenen vorbei (Befund des kalten Plan-Pruefers). Dasselbe gilt fuer die
    Wurzel-conftest und die pytest-Sicht.
    """
    plaene = [_plan("a", ["webtool/jobs.py"]), _plan("b", ["scripts/mypy_riegel.py"])]
    assert mutationen_lauf.waehle(plaene, {"conftest.py"}) == plaene
    assert mutationen_lauf.waehle(plaene, {"scripts/mutation.py"}) == plaene


def test_nur_die_betroffenen_plaene():
    plaene = [_plan("a", ["webtool/jobs.py", "webtool/test_jobs.py"]),
              _plan("b", ["scripts/mypy_riegel.py"]),
              _plan("c", ["webtool/app.py", "webtool/jobs.py"])]
    gewaehlt = mutationen_lauf.waehle(plaene, {"webtool/jobs.py"})
    assert [p.name for p in gewaehlt] == ["a", "c"]


def test_eine_geaenderte_plandatei_waehlt_ihren_plan():
    """Sonst liesse sich ein Waechter entschaerfen, ohne dass seine Serie je laeuft.

    Wer eine Mutation aus dem Plan nimmt, aendert nur die JSON-Datei — keine der Dateien
    in `pfade`. Ohne diese Zeile bliebe genau diese Aenderung ungeprueft.
    """
    plaene = [_plan("a", ["webtool/jobs.py"]), _plan("b", ["scripts/mypy_riegel.py"])]
    gewaehlt = mutationen_lauf.waehle(plaene, {"scripts/mutationen/b.json"})
    assert [p.name for p in gewaehlt] == ["b"]


def test_unbeteiligte_aenderung_waehlt_nichts():
    """Der Normalfall, und er muss LEER sein duerfen — sonst waere die Auswahl sinnlos."""
    plaene = [_plan("a", ["webtool/jobs.py"])]
    assert mutationen_lauf.waehle(plaene, {"README.md"}) == []


def test_alle_waehlt_alle():
    plaene = [_plan("a", ["webtool/jobs.py"]), _plan("b", ["scripts/mypy_riegel.py"])]
    assert mutationen_lauf.waehle(plaene, None) == plaene


def test_rueckwaertsschraegstrich_wird_beim_LESEN_normalisiert(tmp_path):
    """git meldet Vorwaertsschraegstriche, ein Werkzeug daneben vielleicht nicht.

    Die Auswahl haengt an einem Zeichenkettenvergleich; ein Trennerunterschied liesse sie
    still nichts finden — und "nichts gefunden" ist hier der Normalfall, faellt also nicht
    auf. Genau die Klasse, gegen die dieser Laeufer sonst schuetzt. Geprueft wird deshalb
    `_lies_geaendert` selbst; wer hier im Test normalisiert, prueft den Test.
    """
    liste = tmp_path / "geaendert.txt"
    liste.write_text("webtool\\jobs.py\n  webtool/app.py  \n\n", encoding="utf-8")
    assert mutationen_lauf._lies_geaendert(liste) == {"webtool/jobs.py", "webtool/app.py"}

    plaene = [_plan("a", ["webtool/jobs.py"])]
    assert mutationen_lauf.waehle(plaene, mutationen_lauf._lies_geaendert(liste)) == plaene


# --- Der abgeleitete --pfad -----------------------------------------------

def test_pfad_wurzel_ist_der_gemeinsame_ordner():
    assert _plan("a", ["webtool/jobs.py", "webtool/test_jobs.py"]).pfad_wurzel(WURZEL) \
        == "webtool"


def test_pfad_wurzel_faellt_auf_die_wurzel_zurueck():
    """conftest.py liegt im Stamm — dann muss `--pfad` der Stamm sein, nicht ein Ordner."""
    assert _plan("a", ["conftest.py", "scripts/test_testdeckel.py"]).pfad_wurzel(WURZEL) == "."


def test_pfad_wurzel_einer_einzelnen_datei_ist_ihr_ordner():
    """Sonst bekaeme der Treiber eine DATEI als --pfad, und die Sauberkeitspruefung liefe
    gegen einen Pfad, unter dem per Konstruktion nichts liegt."""
    assert _plan("a", ["webtool/test_jobs.py"]).pfad_wurzel(WURZEL) == "webtool"


# --- Das Anti-Schweigen ---------------------------------------------------

def _leeres_repo(tmp_path):
    (tmp_path / "scripts" / "mutationen").mkdir(parents=True)
    return tmp_path


def test_kein_plan_gefunden_ergibt_zwei(tmp_path, capsys):
    """Ordner umbenannt, Endung geaendert, falscher --repo: alles drei saehe sonst aus wie
    ein sauberer Lauf. Dieselbe Klasse wie `tests 0` mit rc 0."""
    rc = mutationen_lauf.main(["--repo", str(_leeres_repo(tmp_path)), "--alle"])
    assert rc == 2
    assert "keine Plaene" in capsys.readouterr().out


def test_blanke_liste_unter_mutationen_ergibt_zwei(tmp_path, capsys):
    repo = _leeres_repo(tmp_path)
    (repo / "scripts" / "mutationen" / "alt.json").write_text("[]", encoding="utf-8")
    rc = mutationen_lauf.main(["--repo", str(repo), "--alle"])
    assert rc == 2
    assert "unlesbar" in capsys.readouterr().out


def test_beide_schalter_oder_keiner_ergibt_zwei(tmp_path, capsys):
    repo = str(_leeres_repo(tmp_path))
    assert mutationen_lauf.main(["--repo", repo]) == 2
    assert mutationen_lauf.main(["--repo", repo, "--alle",
                                 "--geaendert", "irgendwas.txt"]) == 2
    assert "genau eines" in capsys.readouterr().out


def test_ein_signal_getoeteter_treiber_meldet_NICHT_gruen(tmp_path, monkeypatch, capsys):
    """Die Fahrschleife hatte keinen Test — und darin steckte ein gruener Haken.

    `subprocess` meldet ein Signal auf POSIX als NEGATIVE Zahl (-9 OOM-Killer, -2 Strg-C,
    -15 Timeout von aussen). Die Aggregation war `max(schlimmster, rc)`, und `max(0, -9)`
    ist 0: der Laeufer haette rc 0 gemeldet — Job gruen — waehrend seine eigene Bilanz
    daneben „0 von N bestanden" druckt.

    Gefunden vom kalten Diff-Leser. Der Test faelscht `subprocess.run`, weil ein echtes
    Signal plattformabhaengig waere und der Fehler es nicht ist.
    """
    class Ergebnis:
        def __init__(self, rc):
            self.returncode = rc

    monkeypatch.setattr(mutationen_lauf.subprocess, "run", lambda *a, **k: Ergebnis(-9))
    rc = mutationen_lauf.main(["--repo", str(WURZEL), "--alle"])
    assert rc == 2, "ein Signal ist kein Urteil und darf nicht als bestanden durchgehen"
    ausgabe = capsys.readouterr().out
    assert "Rueckgabecode -9" in ausgabe, "der Grund muss dastehen, nicht nur die Farbe"
    assert "GESCHEITERT" in ausgabe


def test_die_rueckgabecodes_der_plaene_werden_zum_schlimmsten_verdichtet(monkeypatch):
    """rc 2 wiegt schwerer als rc 1: ein Plan, der nicht gemessen hat, darf nicht hinter
    einem verschwinden, der ehrlich rot war."""
    codes = iter([1, 2, 0])

    class Ergebnis:
        def __init__(self):
            self.returncode = next(codes)

    monkeypatch.setattr(mutationen_lauf.subprocess, "run", lambda *a, **k: Ergebnis())
    monkeypatch.setattr(mutationen_lauf, "lade_plaene",
                        lambda w: [_plan("a", ["x"]), _plan("b", ["y"]), _plan("c", ["z"])])
    assert mutationen_lauf.main(["--repo", str(WURZEL), "--alle"]) == 2


def test_echte_plaene_werden_alle_geladen():
    """Bindet den Laeufer an die WIRKLICHEN Plaene, nicht nur an gebaute.

    Ein Formfehler in einem echten Plan faellt hier auf, ohne dass eine Serie laeuft.
    """
    plaene = mutationen_lauf.lade_plaene(WURZEL)
    assert len(plaene) == len(list((WURZEL / "scripts" / "mutationen").glob("*.json")))
    assert all(p.test.strip() for p in plaene)


def test_auswahl_ueber_echte_plaene_und_echte_datei(tmp_path, capsys):
    """Der Weg, den die CI geht: eine Datei mit geaenderten Pfaden, Auswahl daraus."""
    liste = tmp_path / "geaendert.txt"
    liste.write_text("webtool/jobs.py\n", encoding="utf-8")
    rc = mutationen_lauf.main(["--repo", str(WURZEL), "--geaendert", str(liste),
                               "--nur-auswahl"])
    assert rc == 0
    ausgabe = capsys.readouterr().out
    assert "eingereiht_abschluss" in ausgabe
    assert "weitergereichtes_then" in ausgabe
    assert "mypy_riegel" not in ausgabe, "ein unbeteiligter Plan darf nicht mitlaufen"
