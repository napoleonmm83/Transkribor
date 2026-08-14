import json, os
import pytest
from webtool import projekt, paths, sprachen


def test_setze_datei_ueberlebt_parallele_schreiber(tmp_path, monkeypatch):
    """Read-Modify-Write auf projekt.json muss atomar sein: zwei parallele Schreiber
    (z.B. Mehrfach-Upload) duerfen sich nicht gegenseitig den Datei-Eintrag verdraengen
    (#134). Deterministisch forciert ueber eine Pause im _write, die das Fenster aufreisst —
    beide haben gelesen, bevor einer schreibt. Ohne Lock gewinnt der letzte _write und der
    andere Eintrag ist verloren; das Lock serialisiert die RMW-Sequenzen."""
    import threading, time
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    echt = projekt._write
    def langsam(project, data):
        time.sleep(0.05)            # Fenster auf: beide haben denselben Stand gelesen
        echt(project, data)
    monkeypatch.setattr(projekt, "_write", langsam)
    fehler = []
    def schreibe(base):
        try:
            projekt.setze_datei("p", base, sprache="en")
        except Exception as e:      # pragma: no cover
            fehler.append(e)
    ts = [threading.Thread(target=schreibe, args=(b,)) for b in ("a", "b")]
    for t in ts: t.start()
    for t in ts: t.join()
    assert not fehler
    dateien = projekt.laden("p")["dateien"]
    assert set(dateien) == {"a", "b"}      # beide Eintraege ueberleben, keiner verdraengt


def test_lock_raumt_verwaistes_lock_auf(tmp_path, monkeypatch):
    """Ein liegengebliebenes Lock (Prozess im kritischen Abschnitt abgestuerzt) darf
    Schreiben nicht dauerhaft blockieren — es wird nach Alter aufgeraeumt (#134)."""
    import time
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    lockdir = projekt._pfad("p") + ".lock"
    os.makedirs(paths.project_dir("p"), exist_ok=True)
    os.mkdir(lockdir)
    # Die Mechanik liegt seit der zweiten Race (settings.json, yt-dlp-Merker) in sperre.py;
    # geprueft wird trotzdem hier durch `projekt.speichern` — die Frage ist, ob PROJEKT.JSON
    # weiter schreibbar bleibt, nicht ob eine Hilfsfunktion tut, was sie soll.
    from webtool import sperre
    alt = time.time() - sperre.STALTES_ALTER - 10             # eindeutig verwaist
    os.utime(lockdir, (alt, alt))
    projekt.speichern("p", {"sprache": "en"})                # raeumt auf + schreibt
    assert projekt.laden("p")["sprache"] == "en"
    assert not os.path.exists(lockdir)                         # Lock nach Gebrauch weg


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


def _schreibe_projekt_json(project, tmp_path, payload_obj):
    os.makedirs(paths.project_dir(project), exist_ok=True)
    with open(os.path.join(paths.project_dir(project), "projekt.json"), "w") as fh:
        json.dump(payload_obj, fh)


def test_laden_dateien_als_liste_statt_dict(tmp_path, monkeypatch):
    # gueltiges JSON, falsches Schema: dateien als nicht-leere Liste wuerde
    # frueher .items() auf einer Liste aufrufen -> AttributeError.
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    _schreibe_projekt_json("p", tmp_path, {"dateien": [{"x": 1}]})
    d = projekt.laden("p")
    assert d["dateien"] == {}
    assert d["sprache"] == sprachen.SPRACH_DEFAULT
    assert d["korrektur"] == sprachen.TIEFE_DEFAULT


def test_laden_dateien_leere_liste(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    _schreibe_projekt_json("p", tmp_path, {"dateien": []})
    assert projekt.laden("p")["dateien"] == {}


def test_laden_sprache_falscher_typ_faellt_zurueck(tmp_path, monkeypatch):
    # sprache als Zahl (5) und korrektur als null duerfen nicht durchgereicht werden.
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    _schreibe_projekt_json("p", tmp_path, {"sprache": 5, "korrektur": None})
    d = projekt.laden("p")
    assert d["sprache"] == sprachen.SPRACH_DEFAULT
    assert d["korrektur"] == sprachen.TIEFE_DEFAULT


def test_laden_typisierte_werte_bleiben_erhalten(tmp_path, monkeypatch):
    # Regressionsschutz: gueltige String-Werte werden weiterhin durchgereicht.
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    _schreibe_projekt_json("p", tmp_path, {"sprache": "en", "korrektur": "leicht",
                                           "dateien": {"v1": {"sprache": "de"}}})
    d = projekt.laden("p")
    assert d["sprache"] == "en"
    assert d["korrektur"] == "leicht"
    assert d["dateien"] == {"v1": {"sprache": "de"}}


def test_laden_setzt_mehrsprachig_auf_false(tmp_path, monkeypatch):
    # Bestehende Projekte ohne den Schluessel duerfen ihr Verhalten nicht aendern.
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    assert projekt.laden("p")["mehrsprachig"] is False


def test_laden_ignoriert_falschen_typ_bei_mehrsprachig(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    _schreibe_projekt_json("p", tmp_path, {"mehrsprachig": "ja"})
    assert projekt.laden("p")["mehrsprachig"] is False


def test_speichern_nimmt_bool_auf(tmp_path, monkeypatch):
    """Die String-Schleife in speichern() filtert auf isinstance(str) — ein bool faellt
    dort durch und waere still verworfen: das Kaestchen liesse sich auf Projektebene
    setzen, ohne dass etwas passiert."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    assert projekt.speichern("p", {"mehrsprachig": True})["mehrsprachig"] is True
    assert projekt.laden("p")["mehrsprachig"] is True


def test_setze_datei_schreibt_mehrsprachig(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.setze_datei("p", "a", mehrsprachig=True)
    assert projekt.datei_mehrsprachig("p", "a") is True


def test_datei_mehrsprachig_faellt_auf_projekt_zurueck(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"mehrsprachig": True})
    assert projekt.datei_mehrsprachig("p", "unbekannt") is True


def test_datei_false_schlaegt_projekt_true(tmp_path, monkeypatch):
    """Der Kern: ein bewusst abgewaehltes False ist falsy. Loest der Rueckfall wie
    datei_sprache ueber `or` auf, gewinnt der Projektwert — und der Haken liesse sich
    pro Datei nie wieder abwaehlen. Entscheidend ist die ANWESENHEIT des Schluessels."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"mehrsprachig": True})
    projekt.setze_datei("p", "a", mehrsprachig=False)
    assert projekt.datei_mehrsprachig("p", "a") is False


def test_nicht_dekodierbare_projekt_json_faellt_auf_defaults(tmp_path, monkeypatch):
    """`json.JSONDecodeError` deckt nur das PARSEN. Sind die BYTES nicht als UTF-8
    dekodierbar, wirft schon das Lesen im Textmodus einen `UnicodeDecodeError` — ebenfalls
    ein `ValueError`, aber KEIN `JSONDecodeError` (#190, an einer Datei mit einem einzelnen
    \xe9-Byte gemessen). `laden()` ist der Weg, ueber den Sprache und Korrektur-Tiefe JEDER
    Datei gelesen werden: ein Wurf hier reisst Transkription UND Korrektur mit.

    `write_bytes` ist Pflicht — mit `write_text` plus Encoding laesst sich der Fall gar
    nicht herstellen, und genau deshalb ist er nie jemandem aufgefallen.
    """
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(paths.project_dir("p"), exist_ok=True)
    with open(projekt._pfad("p"), "wb") as fh:
        fh.write(b'{"sprache": "\xe9n"}')
    daten = projekt.laden("p")
    assert daten["sprache"] == sprachen.SPRACH_DEFAULT      # ch
    assert daten["korrektur"] == sprachen.TIEFE_DEFAULT     # auto
    assert daten["dateien"] == {}


def test_laden_verschluckt_den_unsicheren_namen_nicht(tmp_path, monkeypatch):
    """`paths.safe_name` wirft ValueError fuer unsichere Namen. Seit der Erweiterung auf
    ValueError (#190) lag dieser Wurf im Rueckfall-Bereich, wenn der Pfadbau IM try steht —
    `laden("..")` gab dann Defaults zurueck statt zu werfen (gemessen). Eine Vertrauensgrenze
    darf nicht wie eine kaputte Datei aussehen."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    with pytest.raises(ValueError):
        projekt.laden("..")
