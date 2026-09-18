"""Waechter fuer die Ausschluesse, die lokal und CI gleich urteilen lassen.

Beide geprueften Zusagen sind von der Sorte, die STILL falsch wird: ein
fehlendes `.gitignore`-Muster faellt niemandem auf (es erscheinen nur wieder
mehr Dateien), und ein zu weiter mypy-Ausschluss auch nicht (es wird nur
weniger geprueft). Genau deshalb steht hier von JEDER Seite ein Gegenbeispiel.

Der Test liest die echten Werte aus `.gitignore` und `pyproject.toml`, statt
sie zu wiederholen. Eine Kopie der Regel im Test prueft die Kopie, nicht die
Regel — dieselbe Ueberlegung wie bei `versionshoehe.sh` und `notizen.sh`, die
aus diesem Grund ihre Logik im Skript statt im Workflow-Rumpf tragen.

Vorgeschichte (T-174, 2026-09-18): ohne diese Ausschluesse meldete
`scripts/ruff_riegel.py` 207 Befunde, 207 von 207 aus Wegwerfordnern der
Testlaeufe, und `scripts/mypy_riegel.py` brach mit rc 2 ab, ohne eine einzige
getrackte Datei anzusehen. Beides war ausschliesslich lokal sichtbar.
"""

import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

WURZEL = Path(__file__).resolve().parent.parent

# Die vier Wegwerfordner aus T-174. Sie stehen NAMENTLICH in der .gitignore
# (kein Sammelmuster `.tmp*`), und deshalb stehen sie hier auch namentlich:
# ein Test, der das Muster nachbildet, wuerde ein Sammelmuster durchwinken.
WEGWERFORDNER = [".tmp", ".pytest-tmp", ".pytest-security-tmp", ".cg_tmp_efficiency"]


def _ignoriert(rel: str) -> bool:
    """Fragt git, ob ein Pfad ignoriert ist. Die Datei muss nicht existieren.

    Absichtlich ueber git statt ueber eigenes Mustermatching: die Frage lautet
    nicht "passt mein Regex", sondern "was tut git" — und nur die zweite
    entscheidet, was ruff und der Kalt-Review-Riegel spaeter sehen.
    """
    # S603/S607 bewusst freigestellt: das Kommando ist eine Konstante, die
    # einzige Variable ist ein Pfad aus diesem Modul, und `git` ueber PATH zu
    # suchen ist hier gewollt — ein fester Pfad waere auf Windows, Linux und
    # macOS jeweils ein anderer und macht den Test plattformgebunden.
    fertig = subprocess.run(  # noqa: S603
        ["git", "-C", str(WURZEL), "check-ignore", "-q", "--no-index", rel],  # noqa: S607
        capture_output=True,
    )
    # 0 = ignoriert, 1 = nicht ignoriert, alles andere = git hat nicht gemessen
    if fertig.returncode not in (0, 1):
        pytest.fail(
            f"git check-ignore konnte nicht urteilen (rc={fertig.returncode}): "
            f"{fertig.stderr.decode('utf-8', 'replace')[:200]}"
        )
    return fertig.returncode == 0


@pytest.mark.parametrize("ordner", WEGWERFORDNER)
def test_wegwerfordner_sind_ignoriert(ordner):
    """Eine Datei TIEF in jedem der vier Ordner muss ignoriert sein.

    Geprueft wird eine konkrete DATEI, nie die Verzeichnisform: gemessen am
    2026-09-18 meldet `git check-ignore -v -- ".tmp/"` faelschlich rc 0 und
    verweist dabei auf eine LEERZEILE der .gitignore. Wer die Verzeichnisform
    prueft, bekommt also ein Ja, das nichts bedeutet.
    """
    assert _ignoriert(f"{ordner}/tief/drin/datei.txt"), (
        f"{ordner}/ ist nicht ignoriert — ruff zaehlt dann wieder jede Datei "
        f"darin als Projektcode (waren zuletzt 207 Phantombefunde), und der "
        f"Kalt-Review-Riegel fasst jede einzeln mit fuenf Prozessstarts an."
    )


@pytest.mark.parametrize("pfad", ["README.md", "webtool/correct.py", "scripts/mutation.py"])
def test_echter_code_ist_nicht_ignoriert(pfad):
    """Gegenprobe: die Muster duerfen nicht ueber ihr Ziel hinausschiessen.

    Ohne diese Richtung wuerde ein `*` in der .gitignore den Test oben
    ebenfalls bestehen lassen.
    """
    assert not _ignoriert(pfad), f"{pfad} ist ignoriert — ein Muster greift zu weit"


def test_wurzelverankerung_ist_gewollt_und_gemessen():
    """Die Muster tragen einen fuehrenden `/`, gelten also NUR in der Wurzel.

    Das ist eine Entscheidung, keine Nachlaessigkeit (ein Name ohne `/` gaelte
    in jeder Tiefe und naehme einen gleichnamigen Ordner im Projekt still mit).
    Der Test nagelt die Folge fest, damit sie beim naechsten Lesen nicht
    ueberrascht: tiefer liegende gleichnamige Ordner sind NICHT erfasst.
    """
    assert not _ignoriert("webtool/.tmp/datei.txt"), (
        "webtool/.tmp/ ist ignoriert — dann traegt das Muster keinen fuehrenden "
        "Schraegstrich mehr, und ein gleichnamiger Ordner im Projekt verschwaende still"
    )


def _mypy_ausschluss() -> str:
    with open(WURZEL / "pyproject.toml", "rb") as f:
        # str() ist nicht Kosmetik: tomllib liefert Any, und ein Rueckgabetyp,
        # der Any verspricht wo str steht, faellt bei mypy als no-any-return auf.
        return str(tomllib.load(f)["tool"]["mypy"]["exclude"])


def test_eval_ist_vom_mypy_lauf_ausgeschlossen():
    """`eval/` bricht den Lauf sonst mit rc 2 ab, ohne etwas zu pruefen.

    Der Ordner ist gitignoriert und existiert in der CI nie — ohne den
    Ausschluss urteilt also nur die CI, waehrend der Entwicklerrechner
    schweigt. Das ist die teure Richtung: ein Lauf, der nichts angesehen hat,
    sieht aus wie ein Befund.
    """
    assert re.match(_mypy_ausschluss(), "eval/dialekt-2026-09-14/baseline-correct.py")


@pytest.mark.parametrize(
    "pfad", ["evaluation.py", "eval_helper/x.py", "evaluierung/y.py", "webtool/eval.py"]
)
def test_mypy_ausschluss_trifft_nur_den_ordner(pfad):
    """Die Gegenrichtung: `eval` ist ein Praefix, kein Wort.

    Die Regex-Gruppe verlangt direkt danach einen `/`. Faellt der weg — etwa
    beim Anfuegen eines weiteren Namens —, verschwaende `evaluation.py`
    lautlos aus dem Lauf, und niemand saehe es an einer Fehlermeldung.
    """
    assert not re.match(_mypy_ausschluss(), pfad), (
        f"{pfad} wird von mypy ausgeschlossen — der Ausschluss trifft mehr als "
        f"den Ordner eval/"
    )


def test_gepruefte_menge_enthaelt_eval_nicht():
    """Der Ausschluss darf dem Lauf nichts wegnehmen, was er pruefen SOLL.

    Belegt statt behauptet: die getrackten .py-Dateien ausserhalb des Frontends
    sind die Menge, ueber die mypy urteilt — und `eval/` ist gitignoriert, also
    gar nicht darin. Ohne diese Zeile waere der Ausschluss eine Zusicherung
    ohne Gegenprobe.
    """
    fertig = subprocess.run(  # noqa: S603 — Begruendung siehe _ignoriert()
        ["git", "-C", str(WURZEL), "ls-files", "*.py"],  # noqa: S607
        capture_output=True, text=True,
    )
    assert fertig.returncode == 0, "git ls-files hat nicht gemessen"
    getrackt = [z for z in fertig.stdout.splitlines() if not z.startswith("webtool/frontend")]
    # Positivkontrolle: die Menge ist nicht leer — sonst bestuende die
    # Behauptung unten aus Abwesenheit allein.
    assert len(getrackt) > 50, f"nur {len(getrackt)} getrackte .py gefunden — misst der Aufruf?"
    assert not [z for z in getrackt if z.startswith("eval/")]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
