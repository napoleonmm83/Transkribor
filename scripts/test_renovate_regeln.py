"""Tests zu `renovate_regeln.py` (#539).

Zwei Ebenen, und die Trennung ist Absicht:

* Die **reinen** Tests fahren `urteile()` und `unstimmig()` gegen aufgezeichnete
  Ausgaben. Sie laufen in jeder Suite, in Millisekunden, auf jeder Plattform.
* Der **eine** markierte Test fährt einen echten Renovate-Lauf. Er ist mit
  `@pytest.mark.renovate` versehen, und `pyproject.toml` nimmt diesen Marker per
  `-m "not renovate"` aus der normalen Suite -- der eigene CI-Job holt ihn mit
  `-m renovate` wieder herein.

**Warum ein Marker und kein Umgebungsschalter:** ein uebersehener Schalter laesst
den Test still ueberspringen, und der Job waere gruen, ohne etwas gefahren zu
haben -- genau die Klasse, gegen die dieses ganze Paket gebaut ist. Passt der
Marker nicht mehr, sammelt pytest im eigenen Job NULL Tests ein und endet mit
rc 5. Der Ausfall ist damit rot statt gruen, ohne dass jemand etwas dazubauen musste.

Die Beispielausgabe unten ist AUFGEZEICHNET, nicht erfunden: sie stammt aus dem
Lauf vom 2026-09-09 gegen Renovate 41.173.1 mit Token.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

# Der Pfad muss VOR dem Import stehen — E402/I001 sind hier die Folge der
# Reihenfolge, nicht der Unordnung. Dieselbe Form wie in test_mypy_riegel.py.
sys.path.insert(0, str(Path(__file__).parent))
import renovate_regeln as rr  # noqa: E402, I001


GEMESSEN = """\
DEBUG: Filtered out 1 disabled update(s). 5 update(s) remaining. (repository=local)
DEBUG: 5 flattened updates found: postgres, actions/setup-python, \
@vitejs/plugin-react, lucide-react, lucide-react (repository=local)
                     "branchName": "renovate/postgres-18.x"
                     "branchName": "renovate/actions-setup-python-7.x"
                     "branchName": "renovate/vitejs-plugin-react"
                     "branchName": "renovate/all-minor-patch"
                     "branchName": "renovate/major-lucide-monorepo"
                 "depName": "python",
                 "skipReason": "disabled"
"""


def ohne(text: str, weg: str) -> str:
    return text.replace(weg, "")


# --- flache_liste: die drei Zustaende muessen unterscheidbar bleiben -----------

def test_flache_liste_liest_die_namen():
    assert rr.flache_liste(GEMESSEN) == [
        "postgres", "actions/setup-python", "@vitejs/plugin-react",
        "lucide-react", "lucide-react",
    ]


def test_flache_liste_bei_null_updates_ist_leer_nicht_none():
    """`keine Updates` und `Zeile fehlt` sind verschiedene Dinge.

    Aufgezeichnet aus dem ersten Spike-Lauf, in dem die Fixture nicht ankam.
    Waeren beide `None`, koennte der Riegel `nichts gefunden` nicht von
    `nicht hingesehen` unterscheiden -- die Kernklasse dieses Repos.
    """
    leer = "DEBUG: 0 flattened updates found:  (repository=local)\n"
    assert rr.flache_liste(leer) == []


def test_flache_liste_ohne_die_zeile_ist_none():
    assert rr.flache_liste("DEBUG: irgendwas ganz anderes\n") is None


# --- unstimmig: der Riegel gegen das eigene Schweigen -------------------------

def test_gemessene_ausgabe_ist_stimmig():
    """Positivkontrolle: der Riegel darf nicht ALLES fuer unstimmig halten."""
    assert rr.unstimmig(0, GEMESSEN) is None


def test_null_paketdateien_ist_unstimmig():
    """Gemessen am 2026-09-09: Fixture ohne Commit ⇒ rc 0 und nichts gesehen."""
    ausgabe = ("DEBUG: Found 0 package file(s) (repository=local)\n"
               "DEBUG: 0 flattened updates found:  (repository=local)\n")
    grund = rr.unstimmig(0, ausgabe)
    assert grund is not None and "NULL Paketdateien" in grund


def test_fehlende_ausgabezeile_ist_unstimmig():
    """Falle 3: falsche node-Fassung ⇒ rc 0 ohne jede Ausgabe."""
    grund = rr.unstimmig(0, "")
    assert grund is not None and "flattened updates found" in grund


def test_zahl_gegen_aufzaehlung_wird_bemerkt():
    ausgabe = "DEBUG: 9 flattened updates found: postgres (repository=local)\n"
    grund = rr.unstimmig(0, ausgabe)
    assert grund is not None and "Ausgabeform" in grund


def test_ohne_token_wird_nicht_geurteilt():
    """Ohne Token ist Regel 2 unfalsifizierbar -- dann lieber gar kein Urteil."""
    ausgabe = GEMESSEN + '                 "skipReason": "github-token-required"\n'
    grund = rr.unstimmig(0, ausgabe)
    assert grund is not None and "Token" in grund


# --- urteile: je Regel beide Richtungen ---------------------------------------

def test_urteil_ist_gruen_wenn_alle_drei_wirken():
    code, zeilen = rr.urteile(GEMESSEN)
    assert code == 0, zeilen
    assert sum(z.startswith("ok") for z in zeilen) == 3


def test_regel1_faellt_auf_wenn_der_eigene_zweig_fehlt():
    """Ohne die Regel landet das Paket im Sammelbuendel -- der Zweig verschwindet."""
    code, zeilen = rr.urteile(ohne(GEMESSEN, "renovate/vitejs-plugin-react"))
    assert code == 1
    assert any("FEHL Regel 1" in z for z in zeilen)


def test_regel1_faellt_auf_wenn_gar_nicht_mehr_gebuendelt_wird():
    """Die Kontrolle: ohne Sammelbuendel saehe Regel 1 sonst gruen aus."""
    code, zeilen = rr.urteile(ohne(GEMESSEN, "renovate/all-minor-patch"))
    assert code == 1
    assert any("FEHL Regel 1" in z for z in zeilen)


def test_regel2_faellt_auf_wenn_python_vorgeschlagen_wird():
    ausgabe = GEMESSEN.replace(
        "flattened updates found: postgres",
        "flattened updates found: python, postgres",
    ).replace("DEBUG: 5 flattened", "DEBUG: 6 flattened")
    code, zeilen = rr.urteile(ausgabe)
    assert code == 1
    assert any("FEHL Regel 2" in z for z in zeilen)


def test_regel3_faellt_auf_wenn_das_geschuetzte_postgres_durchkommt():
    """Ohne die Regel stehen ZWEI postgres in der Liste, nicht eines."""
    ausgabe = GEMESSEN.replace(
        "flattened updates found: postgres",
        "flattened updates found: postgres, postgres",
    ).replace("DEBUG: 5 flattened", "DEBUG: 6 flattened")
    code, zeilen = rr.urteile(ausgabe)
    assert code == 1
    assert any("filtert nichts mehr" in z for z in zeilen)


def test_regel3_faellt_auf_wenn_matchfilenames_zu_breit_greift():
    """Die Gegenrichtung: ohne `matchFileNames` waere JEDES postgres stumm."""
    ausgabe = GEMESSEN.replace(
        "flattened updates found: postgres, ", "flattened updates found: "
    ).replace("DEBUG: 5 flattened", "DEBUG: 4 flattened")
    code, zeilen = rr.urteile(ausgabe)
    assert code == 1
    assert any("zu breit" in z for z in zeilen)


# --- der echte Lauf -----------------------------------------------------------

@pytest.mark.renovate
def test_die_drei_regeln_wirken_am_echten_lauf():
    """Faehrt die ECHTE renovate.json gegen ein Wegwerf-Repo.

    Nicht in der normalen Suite (Marker + `-m "not renovate"`); der eigene
    CI-Job holt ihn mit `-m renovate` herein. rc 2 ist hier ausdruecklich KEIN
    Erfolg -- es heisst `konnte nicht urteilen` und faellt genauso durch.
    """
    fertig = subprocess.run(
        [sys.executable, str(rr.STAMM / "scripts/renovate_regeln.py")],
        capture_output=True, text=True, timeout=rr.FRIST + 60,
    )
    assert fertig.returncode == 0, (
        f"rc={fertig.returncode}\nstdout:\n{fertig.stdout}\nstderr:\n{fertig.stderr}"
    )
