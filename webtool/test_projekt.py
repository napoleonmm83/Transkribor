import json, os
from webtool import projekt, paths, sprachen


def _neues_projekt(tmp_path, name="p"):
    os.makedirs(paths.project_dir(name), exist_ok=True)  # nutzt TRANSKRIBOR_PROJEKTE-Testumgebung
    return name


def test_laden_default_wenn_fehlt(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    d = projekt.laden("x")
    assert d["sprache"] == sprachen.SPRACH_DEFAULT
    assert d["korrektur"] == sprachen.TIEFE_DEFAULT
    assert d["dateien"] == {}


def test_speichern_und_laden(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"sprache": "en"})
    assert projekt.laden("p")["sprache"] == "en"


def test_setze_datei_schreibt_nur_abweichend(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.setze_datei("p", "v1", sprache="en", korrektur="leicht")
    d = projekt.laden("p")
    assert d["dateien"]["v1"] == {"sprache": "en", "korrektur": "leicht"}


def test_datei_sprache_kette(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"sprache": "de"})
    projekt.setze_datei("p", "a", sprache="en")
    assert projekt.datei_sprache("p", "a") == "en"      # Datei gewinnt
    assert projekt.datei_sprache("p", "b") == "de"      # Projekt-Standard
    assert projekt.datei_sprache("q", "c") == "ch"      # Default


def test_tiefe_effektiv_auto_aufloesung(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"sprache": "ch"})           # auto + ch -> voll_dialekt
    assert projekt.tiefe_effektiv("p", "a") == "voll_dialekt"
    projekt.speichern("p", {"sprache": "en"})           # auto + en -> voll
    assert projekt.tiefe_effektiv("p", "a") == "voll"
    projekt.setze_datei("p", "a", korrektur="leicht")   # explizit schlaegt auto
    assert projekt.tiefe_effektiv("p", "a") == "leicht"


def test_laden_tolerant_bei_kaputtem_json(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(paths.project_dir("p"), exist_ok=True)
    with open(os.path.join(paths.project_dir("p"), "projekt.json"), "w") as fh:
        fh.write("{ nicht json")
    assert projekt.laden("p")["sprache"] == "ch"        # kein Crash, Default
