# scripts/test_osv_freeze.py
"""Tests fuer osv_freeze.py — laeuft als eigener CI-Schritt (python scripts/test_osv_freeze.py),
pytest sammelt scripts/ nicht (norecursedirs). Vorbild: scripts/versionshoehe.test.sh.
Assert-basiert ohne Framework: das Skript ist CI-Werkzeug, kein App-Code."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import osv_freeze as of


def _report_datei(eintraege):
    """Baut eine pip-Report-Datei im minimalen Schema; gibt Pfad zurueck (tempfile, nicht
    neben dem Skript — sonst landet Muell im Baum und der naechste Commit nimmt ihn mit)."""
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump({"install": [{"metadata": {"name": n, "version": v}} for n, v in eintraege]},
              handle)
    handle.close()
    return handle.name


def test_pep503_normalisierung():
    # pip freeze schreibt Bindestriche, der Report Punkte/Unterstriche (pyannote.audio
    # gegen pyannote-audio). OSV matcht auf die freeze-Form.
    assert of.normalisiere("pyannote.audio") == "pyannote-audio"
    assert of.normalisiere("torch_pitch_shift") == "torch-pitch-shift"
    assert of.normalisiere("PyCryptodomeX") == "pycryptodomex"


def test_report_lesen():
    pfad = _report_datei([("pyannote.audio", "4.0.7"), ("torch", "2.13.0")])
    assert of.lies_report(pfad) == {"pyannote-audio": "4.0.7", "torch": "2.13.0"}


def test_nur_lokale_suffixe_gewinnen_aus_cu128():
    # torch==2.11.0+cu128 ueberschreibt PyPIs 2.13.0 (setup.js-Reihenfolge);
    # setuptools 78.1.0 OHNE Suffix tut es NICHT — pip loeste das dort gegen
    # denselben PyPI-Bestand, die PyPI-Aufloesung ist frischer.
    pypi = {"torch": "2.13.0", "setuptools": "78.3.0", "fastapi": "0.139.0"}
    cu128 = {"torch": "2.11.0+cu128", "torchaudio": "2.11.0+cu128", "setuptools": "78.1.0",
             "nur-im-cu128-baum": "1.2.3"}
    ergebnis = of.verschmelze(pypi, cu128)
    assert ergebnis["torch"] == "2.11.0+cu128"
    assert ergebnis["torchaudio"] == "2.11.0+cu128"
    assert ergebnis["setuptools"] == "78.3.0"   # PyPI gewinnt: kein Suffix
    assert ergebnis["fastapi"] == "0.139.0"
    assert ergebnis["nur-im-cu128-baum"] == "1.2.3"  # Union-Fallback: PyPI kennt es nicht


def test_waechter_schlaegt_unter_100_an():
    # Der Wächter unterscheidet "nichts aufgeloest" (Manifest-Laenge ~12) von
    # "aufgeloest" (~127). Ohne ihn wäre ein leerer Report ein grüner Scan über
    # nichts — der "pass heisst nicht geschaut"-Fehler aus den CodeRabbit-Limits.
    try:
        of.pruefe_anzahl(12)
    except SystemExit as e:
        assert e.code == 1
    else:
        raise AssertionError("Wächter hat 12 Pakete durchgelassen")
    of.pruefe_anzahl(127)  # wirft nicht


def test_torch_waechter_verlangt_cu128_suffix():
    # Der Zaehler prueft Menge, nicht Eigenschaft: ein suffixloser torch-Eintrag
    # waere der PyPI-CPU-Build bei unveraenderter Paketzahl — gruen ueber ein
    # falsches Abbild. Beide Richtungen: gut durch, schlecht raus (Review-Fund).
    of.pruefe_torch({"torch": "2.11.0+cu128", "fastapi": "0.139.0"})  # wirft nicht
    for schlecht in ({"torch": "2.13.0"}, {}, {"torchaudio": "2.11.0+cu128"}):
        try:
            of.pruefe_torch(schlecht)
        except SystemExit as e:
            assert e.code == 1
        else:
            raise AssertionError(f"Waechter hat {schlecht} durchgelassen")


def _alle():
    for name in sorted(globals()):
        if name.startswith("test_") and callable(globals()[name]):
            globals()[name]()
            print(f"ok {name}")


if __name__ == "__main__":
    _alle()
    print("alle Tests gruen")
