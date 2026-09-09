"""Tests zu `renovate_regeln.py` (#539).

Zwei Ebenen, und die Trennung ist Absicht:

* Die **reinen** Tests fahren `urteile()` und `unstimmig()` gegen aufgezeichnete
  Ausgaben. Sie laufen in jeder Suite, in Millisekunden, auf jeder Plattform.
* Der **eine** markierte Test fährt einen echten Renovate-Lauf. Er ist mit
  `@pytest.mark.renovate` versehen, und `pyproject.toml` nimmt diesen Marker per
  `-m "not renovate"` aus der normalen Suite -- der eigene CI-Job holt ihn mit
  `-m renovate` wieder herein.

**Warum ein Marker und kein Umgebungsschalter:** ein übersehener Schalter lässt
den Test still überspringen, und der Job wäre grün, ohne etwas gefahren zu
haben -- genau die Klasse, gegen die dieses ganze Paket gebaut ist. Passt der
Marker nicht mehr, sammelt pytest im eigenen Job NULL Tests ein und endet mit
rc 5. Ausgeführt gemessen: `-m renovatex` ⇒ `15 deselected`, rc 5.

Die Beispielausgabe unten ist AUFGEZEICHNET, nicht erfunden: sie stammt aus dem
Lauf vom 2026-09-09 gegen Renovate 41.173.1 mit Token, samt der Verschachtelung
des `packageFiles`-Dumps -- ein geglätteter Auszug hätte die Nähe-Prüfung von
`_PYTHON_ABGESCHALTET` gegen eine Form getestet, die es so nicht gibt.
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
DEBUG: Found 4 package file(s) (repository=local)
DEBUG: packageFiles with updates (repository=local)
             {
               "datasource": "github-runners",
               "depName": "ubuntu",
               "skipReason": "invalid-version",
               "updates": [],
               "packageName": "ubuntu"
             },
             {
               "datasource": "github-releases",
               "depName": "python",
               "packageName": "actions/python-versions",
               "versioning": "npm",
               "currentValue": "3.12",
               "depType": "uses-with",
               "updates": [],
               "skipReason": "disabled"
             }
                     "branchName": "renovate/postgres-18.x"
                     "branchName": "renovate/actions-setup-python-7.x"
                     "branchName": "renovate/vitejs-plugin-react"
                     "branchName": "renovate/all-minor-patch"
                     "branchName": "renovate/major-lucide-monorepo"
DEBUG: Filtered out 1 disabled update(s). 5 update(s) remaining. (repository=local)
DEBUG: 5 flattened updates found: postgres, actions/setup-python, \
@vitejs/plugin-react, lucide-react, lucide-react (repository=local)
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

    Wären beide `None`, könnte der Riegel `nichts gefunden` nicht von
    `nicht hingesehen` unterscheiden -- die Kernklasse dieses Repos.
    """
    leer = "DEBUG: 0 flattened updates found:  (repository=local)\n"
    assert rr.flache_liste(leer) == []


def test_flache_liste_ohne_die_zeile_ist_none():
    assert rr.flache_liste("DEBUG: irgendwas ganz anderes\n") is None


# --- unstimmig: der Riegel gegen das eigene Schweigen -------------------------

def test_gemessene_ausgabe_ist_stimmig():
    """Positivkontrolle: der Riegel darf nicht ALLES für unstimmig halten."""
    assert rr.unstimmig(0, GEMESSEN) is None


def test_kleinere_dateimenge_ist_unstimmig():
    """DER Befund des gegnerischen Reviews, ausgeführt reproduziert.

    Der erste Entwurf verbot `Found 0` und liess jede kleinere Menge durch: eine
    Fixture ohne die Kontroll-Compose ergab `Found 3` -- und das Urteil lautete
    „Alle drei Regeln wirken". Wörtlich die #588-Klasse: der Riegel schweigt
    nicht, er spricht leiser.
    """
    grund = rr.unstimmig(0, GEMESSEN.replace("Found 4", "Found 3"))
    assert grund is not None and "3 Paketdateien" in grund


def test_null_paketdateien_ist_unstimmig():
    """Gemessen am 2026-09-09: Fixture ohne Commit ⇒ rc 0 und nichts gesehen."""
    grund = rr.unstimmig(0, GEMESSEN.replace("Found 4", "Found 0"))
    assert grund is not None and "0 Paketdateien" in grund


def test_fehlende_dateizeile_ist_unstimmig():
    """Falle 3: falsche node-Fassung ⇒ rc 0 ohne jede Ausgabe."""
    grund = rr.unstimmig(0, "")
    assert grund is not None and "Found N package file(s)" in grund


def test_rueckgabecode_ungleich_null_wird_gelesen():
    """Der Docstring behauptete die Prüfung, der Code hatte sie nicht."""
    grund = rr.unstimmig(1, GEMESSEN)
    assert grund is not None and "endete mit 1" in grund


def test_zahl_gegen_aufzaehlung_wird_bemerkt():
    ausgabe = GEMESSEN.replace("DEBUG: 5 flattened", "DEBUG: 9 flattened")
    grund = rr.unstimmig(0, ausgabe)
    assert grund is not None and "Ausgabeform" in grund


def test_ohne_token_wird_nicht_geurteilt():
    """Ohne Token ist Regel 2 unfalsifizierbar -- dann lieber gar kein Urteil."""
    ausgabe = GEMESSEN.replace('"skipReason": "disabled"',
                               '"skipReason": "github-token-required"')
    grund = rr.unstimmig(0, ausgabe)
    assert grund is not None and "Token" in grund


def test_nicht_erkannter_python_dep_wird_nicht_geurteilt():
    """Ein Lookup-Fehler, der NICHT `github-token-required` heisst, nimmt den
    Dep ebenfalls aus der Liste -- ohne diesen Riegel gälte Regel 2 als wirksam.
    """
    grund = rr.unstimmig(0, ohne(GEMESSEN, '"depName": "python",'))
    assert grund is not None and "gar nicht erkannt" in grund


# --- urteile: je Regel positiver Beleg UND Kontrolle ---------------------------

def test_urteil_ist_gruen_wenn_alle_drei_wirken():
    code, zeilen = rr.urteile(GEMESSEN)
    assert code == 0, zeilen
    assert sum(z.startswith("ok") for z in zeilen) == 3


def test_regel1_faellt_auf_wenn_der_eigene_zweig_fehlt():
    """Ohne die Regel landet das Paket im Sammelbündel -- der Zweig verschwindet."""
    code, zeilen = rr.urteile(
        ohne(GEMESSEN, '"branchName": "renovate/vitejs-plugin-react"'))
    assert code == 1
    assert any("FEHL Regel 1" in z for z in zeilen)


def test_regel1_faellt_auf_wenn_gar_nicht_mehr_gebuendelt_wird():
    """Die Kontrolle: ohne Sammelbündel sähe Regel 1 sonst grün aus."""
    code, zeilen = rr.urteile(
        ohne(GEMESSEN, '"branchName": "renovate/all-minor-patch"'))
    assert code == 1
    assert any("FEHL Regel 1" in z for z in zeilen)


def test_regel1_zaehlt_nur_die_feldform_nicht_jede_erwaehnung():
    """Der Config-Dump enthält unsere eigenen `description`-Texte.

    Nennt eine künftige Beschreibung den Zweignamen, wäre ein Substring-Sensor
    vacuous. Verankert wird deshalb an `"branchName": "..."`.
    """
    nur_prosa = ohne(GEMESSEN, '"branchName": "renovate/vitejs-plugin-react"') + (
        '  "description": "siehe Zweig renovate/vitejs-plugin-react"\n')
    code, zeilen = rr.urteile(nur_prosa)
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


def test_regel2_faellt_auf_wenn_der_positive_beleg_fehlt():
    """Abwesenheit allein genügt nicht -- sie hat zu viele Ursachen.

    Verschwindet der Dep aus einem anderen Grund als der Regel, fehlt der
    `skipReason: disabled` daneben, und genau daran fällt es auf.
    """
    code, zeilen = rr.urteile(ohne(GEMESSEN, '"skipReason": "disabled"'))
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
    assert any("FEHL Regel 3" in z for z in zeilen)


def test_regel3_faellt_auf_wenn_matchfilenames_zu_breit_greift():
    """Die Gegenrichtung: ohne `matchFileNames` wäre JEDES postgres stumm."""
    ausgabe = GEMESSEN.replace(
        "flattened updates found: postgres, ", "flattened updates found: "
    ).replace("DEBUG: 5 flattened", "DEBUG: 4 flattened")
    code, zeilen = rr.urteile(ausgabe)
    assert code == 1
    assert any("FEHL Regel 3" in z for z in zeilen)


def test_regel3_faellt_auf_wenn_gar_nichts_gefiltert_wurde():
    """Der zweite Befund des gegnerischen Reviews, ausgeführt reproduziert.

    Die Zahl allein unterscheidet nicht: „Kontrolle da, geschütztes Abbild
    gefiltert" und „Kontrolle fehlt, nichts gefiltert" ergeben BEIDE genau ein
    postgres. Die flache Liste trägt keinen Dateinamen -- deshalb zusätzlich
    die Filterzeile.
    """
    code, zeilen = rr.urteile(ohne(GEMESSEN, "Filtered out 1 disabled update(s)."))
    assert code == 1
    assert any("0 gefiltert" in z for z in zeilen)


# --- der echte Lauf -----------------------------------------------------------

@pytest.mark.renovate
def test_die_drei_regeln_wirken_am_echten_lauf():
    """Fährt die ECHTE renovate.json gegen ein Wegwerf-Repo.

    Nicht in der normalen Suite (Marker + `-m "not renovate"`); der eigene
    CI-Job holt ihn mit `-m renovate` herein. rc 2 ist hier ausdrücklich KEIN
    Erfolg -- es heisst `konnte nicht urteilen` und fällt genauso durch.
    """
    # +30 statt +60: die Staffelung muss unter pytests `faulthandler_timeout`
    # von 300 s bleiben (240 < 270 < 300). Sonst gewinnt der faulthandler, und
    # aus „konnte nicht urteilen" (rc 2) wird ein Stapelabzug mit rc 1.
    fertig = subprocess.run(
        [sys.executable, str(rr.STAMM / "scripts/renovate_regeln.py")],
        capture_output=True, text=True, timeout=rr.FRIST + 30,
    )
    assert fertig.returncode == 0, (
        f"rc={fertig.returncode}\nstdout:\n{fertig.stdout}\nstderr:\n{fertig.stderr}"
    )
