"""Waechter fuer `scripts/weg_benchmark.py`.

GEPRUEFT WIRD DER AUFBAU, NICHT DIE ZEIT. Eine Zusicherung ueber Millisekunden haenge an der
Maschine und waere auf dem CI-Laeufer entweder flatterig oder so weit gefasst, dass sie nichts
mehr sagt. Was still driften KANN, ist die Messanordnung: baut der Benchmark irgendwann eine
andere Menge, oder erzeugt der „schlechteste Fall" gar keine Reste mehr, dann misst er weiter
brav etwas — nur nicht mehr das, was der Docstring behauptet. Genau diese Form hat dieses Repo
schon bezahlt („eine Messung ohne Fund belegt nichts, solange der Sensor den Fall nicht sehen
kann").
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import weg_benchmark as wb          # noqa: E402


def test_der_baum_hat_die_menge_die_der_docstring_nennt(tmp_path):
    """300 Projekte, 3605 Dateien — die Zahlen, mit denen die Docstring-Messung beschriftet
    ist. Mutation, die ihn rot macht: `DATEIEN` oder `PROJEKTE` aendern, ohne den Docstring
    von `_weg_aufraeumen_starten` nachzuziehen."""
    gebaut = wb.baue(tmp_path, mit_resten=False)
    assert gebaut == wb.DATEIEN == 3605
    assert wb.PROJEKTE == 300
    assert len(list(tmp_path.iterdir())) == wb.PROJEKTE


def test_die_beiden_faelle_unterscheiden_sich_wirklich(tmp_path):
    """Der eigentliche Sensor: „Normalfall" muss NULL Reste enthalten und „schlechtester Fall"
    viele. Ohne diese Zusicherung koennte der Benchmark zweimal dasselbe messen und zwei
    Zahlen ausgeben, die sich nur durch Rauschen unterscheiden — eine Messung, die ihren
    eigenen Gegenstand verloren hat."""
    ohne, mit = tmp_path / "ohne", tmp_path / "mit"
    wb.baue(ohne, mit_resten=False)
    wb.baue(mit, mit_resten=True)

    n_ohne = len(list(ohne.rglob("*.weg")))
    n_mit = len(list(mit.rglob("*.weg")))
    assert n_ohne == 0, "der Normalfall darf keinen einzigen Rest enthalten"
    assert n_mit > 500, f"der schlechteste Fall traegt nur {n_mit} Reste — zu wenig zum Messen"


def test_der_stempel_liegt_in_der_vergangenheit(tmp_path):
    """Der Rest muss unter JEDER Frist als alt gelten, sonst haenge die Messung an der Uhr des
    Laeufers — und `_weg_reste_aufraeumen` entfernte je nach Tageszeit unterschiedlich viel.
    Mutation: den Stempel auf `time.time()` setzen ⇒ dieser Test rot."""
    import webtool.app as appmod
    wb.baue(tmp_path, mit_resten=True)
    ein_rest = next(tmp_path.rglob("*.weg"))
    alter = appmod._weg_alter(str(ein_rest))
    assert alter is not None, "der Benchmark baut einen Namen, den _weg_alter nicht liest"
    assert alter > 365 * 24 * 3600, "der Stempel ist nicht alt genug, um fristunabhaengig zu sein"
