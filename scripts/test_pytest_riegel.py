"""Der Haenger-Riegel muss SCHARF sein — sonst ist er ein Kommentar (#576).

Die drei Einstellungen in `pyproject.toml` sind das einzige, was einen haengenden
Testlauf ueberhaupt beendet. Sie stehen in einer Konfigurationsdatei, also faellt
ihr Verschwinden niemandem auf: die Suite bleibt gruen, und der naechste Haenger
laeuft wieder still bis zur Laeufergrenze.

Warum ein Test und nicht nur `--strict-config`: die beiden decken VERSCHIEDENE
Fehler. `--strict-config` faengt einen VERTIPPTEN Schluessel (gemessen: ohne die
Option rc 124 und ein Lauf, der weiterhaengt; mit ihr rc 4 vor dem ersten Test).
Ein GELOESCHTER Schluessel ist fuer sie dagegen unauffaellig — dafuer ist dieser
Test da. Und wer `--strict-config` selbst entfernt, macht ihn ebenfalls rot.

Gefragt wird die AKTIVE Konfiguration ueber die `pytestconfig`-Fixture, nicht der
Dateiinhalt: eine Datei zu lesen bewiese nur, dass dort etwas steht — nicht, dass
pytest es auch angenommen hat. Genau diese Verwechslung ist die Fehlerklasse,
gegen die der Riegel gebaut ist.
"""
import re

import pytest


def test_der_haenger_riegel_ist_scharf(pytestconfig):
    """Die zwei ini-Optionen muessen gesetzt und wirksam sein."""
    frist = pytestconfig.getini("faulthandler_timeout")
    assert frist, "faulthandler_timeout ist nicht gesetzt — ein Haenger laeuft wieder still"
    assert float(frist) > 0, f"faulthandler_timeout={frist!r} beendet nichts"

    assert pytestconfig.getini("faulthandler_exit_on_timeout") is True, (
        "Ohne exit_on_timeout erscheint zwar ein Stapelabzug, der Lauf haengt aber "
        "weiter und wird von aussen abgewuergt — gemessen: rc 124 statt rc 1."
    )


def test_die_frist_liegt_unter_der_job_grenze(pytestconfig):
    """Die zwei Riegel sind zwei Haelften EINER Zusicherung — und koennen driften.

    `faulthandler_timeout` nuetzt nur, solange es DEUTLICH unter der Job-Grenze aus
    `.github/workflows/test.yml` liegt: liegt es darueber, beendet GitHub den Job,
    bevor pytest seinen Stapelabzug schreiben kann — der Riegel waere still
    wirkungslos, und genau dieser stille Ausfall ist der Grund, warum es ihn gibt.
    Die Gefahr ist keine Erfindung: die Zahlen stehen in ZWEI Dateien, die niemand
    zusammen liest (Befund des Bot-Reviews an PR #585).

    Geprueft wird die BEZIEHUNG, nicht der Einzelwert: eine feste 300 zu verlangen
    machte jede spaetere, legitime Anpassung rot, ohne zu sagen warum.
    """
    import re
    from pathlib import Path

    workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "test.yml"
    assert workflow.is_file(), f"{workflow} nicht gefunden — dieser Test misst dann nichts"

    treffer = re.findall(r"^\s*timeout-minutes:\s*(\d+)", workflow.read_text(encoding="utf-8"),
                         re.MULTILINE)
    # Kein Treffer heisst NICHT "in Ordnung": dann ist der Deckel weg, und der Test
    # haette stillschweigend nichts geprueft — dieselbe Fehlerklasse wie oben.
    assert treffer, "keine timeout-minutes in test.yml — der Job-Deckel fehlt"

    deckel_s = min(int(t) for t in treffer) * 60
    frist_s = float(pytestconfig.getini("faulthandler_timeout"))
    assert frist_s * 2 <= deckel_s, (
        f"faulthandler_timeout={frist_s:.0f}s gegen Job-Deckel {deckel_s}s: zu knapp. "
        "Der Job stirbt dann, bevor pytest seinen Stapelabzug schreiben kann."
    )


# Ein Jobschluessel steht auf GENAU zwei Leerzeichen. Die Zeichenklasse ist die von
# GitHub erlaubte (Buchstabe oder `_` am Anfang, danach alphanumerisch, `-`, `_`), ein
# Kommentar dahinter ist zulaessig. Die erste Fassung nahm `[a-z_-]+` und einen harten
# Zeilenschluss — damit galten `e2e:`, `Ruff:` und `typen:  # mypy` NICHT als Job: sie
# wurden dem VORIGEN Block zugeschlagen, und hatte der einen Deckel, galt der deckellose
# als gedeckt. Der Parser irrte also ausschliesslich in Richtung GRUEN (Kalt-Review).
_JOB_KOPF = re.compile(r"^  ([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(?:#.*)?$", re.MULTILINE)
# GENAU vier Leerzeichen — also Job-Ebene. Ein blosses `"timeout-minutes:" in block`
# nahm auch ein Step-Level `timeout-minutes: 5` (acht Leerzeichen) und ein
# auskommentiertes `    # timeout-minutes: 20` als Job-Deckel. Beides gemessen.
_JOB_DECKEL = re.compile(r"^    timeout-minutes:", re.MULTILINE)


def jobs_ohne_deckel(text: str) -> tuple[list[str], list[str]]:
    """(alle Jobs, Jobs ohne Zeitgrenze) aus einem Workflow-Text.

    Herausgezogen, damit ein Test das Muster mit Gegenbeispielen fuettern kann statt nur
    mit der echten Datei — an der ist jeder Parser gruen, der irgendetwas findet.
    """
    kopf = re.search(r"^jobs:$", text, re.MULTILINE)
    if not kopf:
        return [], []
    rumpf = text[kopf.end():]
    # Ein weiterer Schluessel auf Ebene 0 beendet den jobs-Block; ohne diese Grenze
    # zaehlten dessen eingerueckte Kinder als Jobs (so wie `pull_request:` unter `on:`).
    weiter = re.search(r"^[A-Za-z_]", rumpf, re.MULTILINE)
    if weiter:
        rumpf = rumpf[:weiter.start()]

    marken = list(_JOB_KOPF.finditer(rumpf))
    ohne = []
    for i, m in enumerate(marken):
        ende = marken[i + 1].start() if i + 1 < len(marken) else len(rumpf)
        if not _JOB_DECKEL.search(rumpf[m.end():ende]):
            ohne.append(m.group(1))
    return [m.group(1) for m in marken], ohne


def test_jeder_job_traegt_eine_zeitgrenze():
    """Fertig-wenn aus #583: KEIN Job laeuft gegen die Sechs-Stunden-Vorgabe.

    Die Zahl stand bis #583 an genau einem der sieben Jobs. Ein Job ohne Deckel faellt
    dabei nicht auf — er ist nur teuer, wenn er einmal haengt, und dann ist es zu spaet.
    Geprueft wird deshalb die VOLLSTAENDIGKEIT, nicht die Anwesenheit irgendeiner Zeile:
    ein achter Job, der die Zeile vergisst, macht diesen Test rot.

    Regex statt PyYAML, weil in keinem CI-Job ein YAML-Leser installiert ist — dieselbe
    Bauform wie im Test darueber. Gegengeprueft mit einem echten YAML-Leser: derselbe
    Baum liefert dort dieselben sieben Jobs mit je `timeout-minutes: 20`.
    """
    from pathlib import Path

    workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "test.yml"
    assert workflow.is_file(), f"{workflow} nicht gefunden — dieser Test misst dann nichts"

    alle, ohne = jobs_ohne_deckel(workflow.read_text(encoding="utf-8"))
    # Null Jobs waeren „alle haben einen Deckel" und damit gruen — dieselbe Klasse wie
    # ein leerer Mutationsplan, der als bestanden durchgeht.
    assert alle, "keine Jobs erkannt — die Einrueckung hat sich geaendert?"
    assert not ohne, (
        f"{len(ohne)} von {len(alle)} Jobs ohne `timeout-minutes`: {', '.join(ohne)}. "
        "Ohne Deckel kostet ein Haenger dort die volle Laeufergrenze (Vorgabe 6 h)."
    )


# Jede Zeile ist ein Fall, an dem die ERSTE Fassung des Parsers still gruen blieb; sie
# stammen samt Belegen aus dem kalten Diff-Review. Aufbau immer gleich: ein Job MIT
# Deckel, dahinter einer OHNE — der zweite muss auffallen.
_MIT_DECKEL = "  python:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - run: x\n"
_GEGENBEISPIELE = [
    ("ziffer im namen", "  e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n", "e2e"),
    ("grossbuchstabe", "  Ruff:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n", "Ruff"),
    ("kommentar hinter dem doppelpunkt",
     "  typen:  # mypy\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n", "typen"),
    ("deckel nur am STEP",
     "  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n        timeout-minutes: 5\n",
     "lint"),
    ("deckel auskommentiert",
     "  mutation:\n    runs-on: ubuntu-latest\n    # timeout-minutes: 20\n    steps:\n      - run: x\n",
     "mutation"),
]


@pytest.mark.parametrize("titel,block,erwartet", _GEGENBEISPIELE,
                         ids=[g[0] for g in _GEGENBEISPIELE])
def test_der_job_parser_uebersieht_diese_formen_nicht(titel, block, erwartet):
    """Der Waechter darf nur in Richtung ROT irren, nie in Richtung GRUEN.

    Ein Parser, der einen Job nicht als Job erkennt, schlaegt ihn dem vorigen Block zu —
    und weil der einen Deckel hat, meldet er „alles gedeckt". Genau diese Richtung ist
    die gefaehrliche: ein uebersehener Job kostet im Ernstfall die volle Laeufergrenze,
    ein faelschlich gemeldeter kostet eine Minute Nachsehen.
    """
    alle, ohne = jobs_ohne_deckel("jobs:\n" + _MIT_DECKEL + block)
    assert erwartet in alle, f"{titel}: `{erwartet}` gar nicht als Job erkannt (alle: {alle})"
    assert erwartet in ohne, f"{titel}: `{erwartet}` hat keinen Job-Deckel, gilt aber als gedeckt"


def test_der_job_parser_zaehlt_nur_den_jobs_block():
    """Was VOR oder NACH `jobs:` steht, ist kein Job — auch wenn es gleich eingerueckt ist.

    `on:` traegt mit `pull_request:` und `push:` zwei Schluessel auf genau zwei
    Leerzeichen; ohne die Schnitte zaehlte der Parser sie mit und meldete 9 statt 7.
    """
    text = ("on:\n  pull_request:\n  push:\n    branches: [master]\n"
            "jobs:\n" + _MIT_DECKEL + "\ndefaults:\n  run:\n    shell: bash\n")
    alle, ohne = jobs_ohne_deckel(text)
    assert alle == ["python"], alle
    assert ohne == [], ohne


def test_der_lauf_deckel_liegt_zwischen_test_frist_und_job_grenze(pytestconfig):
    """Die dritte Stufe (#584) — und ihre Reihenfolge ist die ganze Zusicherung.

    Drei Deckel greifen ineinander: je TEST (`faulthandler_timeout`), je LAUF (die
    Wurzel-`conftest.py`) und je JOB (`test.yml`). Rutscht der mittlere ueber den
    aeusseren, beendet GitHub den Job, bevor der Stapelabzug geschrieben ist; rutscht er
    unter den inneren, stirbt der Lauf, bevor pytest den haengenden Test BENENNEN kann.
    In beiden Richtungen bliebe der Riegel formal stehen und waere still wirkungslos.

    Gefragt wird die AKTIVE Konfiguration ueber den Stash, nicht der Dateiinhalt —
    dieselbe Regel wie im Docstring dieser Datei.
    """
    import re
    from pathlib import Path

    from conftest import deckel_key

    lauf_s = pytestconfig.stash.get(deckel_key, None)
    assert lauf_s, (
        "Der Lauf-Deckel aus der Wurzel-conftest.py ist nicht scharf. Ohne ihn bleibt ein "
        "Haenger nach dem letzten Test unentdeckt — mit `1 passed` im Protokoll (#584)."
    )

    workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "test.yml"
    treffer = re.findall(r"^\s*timeout-minutes:\s*(\d+)", workflow.read_text(encoding="utf-8"),
                         re.MULTILINE)
    assert treffer, "keine timeout-minutes in test.yml — der Job-Deckel fehlt"
    job_s = min(int(t) for t in treffer) * 60

    # Die Relation ist eine Plausibilitaet, keine Garantie ueber die Reihenfolge: ein
    # Haenger, der erst nach 350 s Laufzeit beginnt, wird bei 600 s vom Lauf-Deckel
    # beendet, waehrend der Test-Zeitgeber erst bei 650 s kaeme. Der Lauf-Deckel benennt
    # die Stelle dann trotzdem — sein Abzug traegt Datei und Zeile. Was die Relation
    # wirklich sichert: der feinere Riegel bekommt ueberhaupt eine Chance, zuerst zu
    # feuern. (Der Text hier versprach zuerst mehr; gefunden im gegnerischen Review.)
    test_s = float(pytestconfig.getini("faulthandler_timeout"))
    assert test_s <= lauf_s, (
        f"faulthandler_timeout={test_s:.0f}s ueber dem Lauf-Deckel {lauf_s:.0f}s: der "
        "feinere Riegel kaeme dann nie zum Zug, obwohl er die genauere Meldung hat."
    )
    assert lauf_s * 2 <= job_s, (
        f"Lauf-Deckel {lauf_s:.0f}s gegen Job-Grenze {job_s}s: zu knapp. Der Job stirbt "
        "dann, bevor der Stapelabzug geschrieben ist."
    )


def test_strict_config_haelt_einen_vertipper_auf(pytestconfig):
    """Der Riegel gegen das Schweigen der beiden Zeilen darueber.

    Ohne `--strict-config` meldet pytest einen unbekannten ini-Schluessel nur in
    der Zusammenfassung — die ein haengender Lauf nie erreicht.
    """
    assert "--strict-config" in pytestconfig.getini("addopts"), (
        "Ohne --strict-config schaltet ein Buchstabendreher im Schluessel den "
        "Haenger-Riegel still ab (gemessen: rc 124 statt rc 4)."
    )
