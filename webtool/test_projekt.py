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


def test_ERBEN_entfernt_den_override_wieder(tmp_path, monkeypatch):
    """Der Rueckweg aus #166. Ohne ihn war der Schluessel, einmal geschrieben, endgueltig:
    die Datei zog bei einer Aenderung des Projekt-Standards nie wieder mit, und nichts in der
    Oberflaeche sagte, warum. `None` kann diesen Dienst NICHT tun — es heisst bereits
    "nicht anfassen" (Partial-Update), sonst liesse sich kein Feld einzeln setzen."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"mehrsprachig": True})
    projekt.setze_datei("p", "a", mehrsprachig=False)
    assert projekt.datei_mehrsprachig("p", "a") is False        # Override greift
    projekt.setze_datei("p", "a", mehrsprachig=projekt.ERBEN)
    assert projekt.datei_override_mehrsprachig("p", "a") is None
    assert projekt.datei_mehrsprachig("p", "a") is True         # ... und folgt wieder dem Projekt
    # Der Projektwert zieht jetzt auch nach: genau das, was vorher unmoeglich war.
    projekt.speichern("p", {"mehrsprachig": False})
    assert projekt.datei_mehrsprachig("p", "a") is False


def test_ERBEN_laesst_die_ANDEREN_felder_stehen(tmp_path, monkeypatch):
    """Ein Rueckweg, der nebenbei die Sprache verwirft, waere ein Datenverlust — und der
    faellt erst beim naechsten Transkriptionslauf auf."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.setze_datei("p", "a", sprache="en", korrektur="leicht", mehrsprachig=True)
    projekt.setze_datei("p", "a", mehrsprachig=projekt.ERBEN)
    assert projekt.datei_sprache("p", "a") == "en"
    assert projekt.datei_korrektur("p", "a") == "leicht"


def test_ERBEN_entfernt_auch_den_SPRACH_override(tmp_path, monkeypatch):
    """Derselbe Rueckweg fuer die Sprache (#234) — und er wiegt schwerer als beim Haken: eine
    falsche Sprache kostet eine komplette Neu-Transkription, kein blosses Umschalten des
    Decoders. Der `or`-Rueckfall in `datei_sprache` ist fuer Zeichenketten richtig (ein leerer
    String faellt durch), die Einbahnstrasse war trotzdem dieselbe: ein einmal geschriebener
    Eintrag zog bei einer Aenderung des Projekt-Standards nie wieder mit.
    """
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"sprache": "ch"})
    projekt.setze_datei("p", "a", sprache="en")
    assert projekt.datei_sprache("p", "a") == "en"              # Override greift
    projekt.setze_datei("p", "a", sprache=projekt.ERBEN)
    assert projekt.datei_ansicht("p", "a")["sprache_eigen"] is None
    assert projekt.datei_sprache("p", "a") == "ch"              # ... folgt wieder dem Projekt
    # Und zieht jetzt mit: genau das, was vorher unmoeglich war.
    projekt.speichern("p", {"sprache": "fr"})
    assert projekt.datei_sprache("p", "a") == "fr"


def test_SPRACH_ERBEN_laesst_die_anderen_felder_stehen(tmp_path, monkeypatch):
    """Spiegelbild zum Test oben: der Rueckweg der Sprache darf Tiefe und Haken nicht mitnehmen."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.setze_datei("p", "a", sprache="en", korrektur="leicht", mehrsprachig=True)
    projekt.setze_datei("p", "a", sprache=projekt.ERBEN)
    assert projekt.datei_korrektur("p", "a") == "leicht"
    assert projekt.datei_mehrsprachig("p", "a") is True


def test_die_ansicht_trennt_geerbte_von_gleichlautender_sprache(tmp_path, monkeypatch):
    """`sprache` allein kann das nicht: ein Override, der zufaellig dasselbe sagt, sieht
    identisch aus wie eine Erbschaft — und nur der eine haelt die Datei fest, wenn sich der
    Projekt-Standard aendert. Genau daran haengt die Beschriftung im Dialog (#234).
    """
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"sprache": "ch"})
    projekt.setze_datei("p", "a", sprache="ch")        # gleichlautend, aber EIGEN
    a = projekt.datei_ansicht("p", "a")
    assert (a["sprache"], a["sprache_eigen"], a["sprache_projekt"]) == ("ch", "ch", "ch")
    b = projekt.datei_ansicht("p", "b")                # nie angefasst -> erbt
    assert (b["sprache"], b["sprache_eigen"], b["sprache_projekt"]) == ("ch", None, "ch")

    # **Ein LEERER Eintrag ist ein Eintrag** — `""` bleibt `""`, es wird NICHT zu `None`
    # normalisiert (CodeRabbit schlug das an PR #240 vor). Gemessen, warum nicht: der Dialog
    # macht daraus `null` und haelt damit `sprachWahl !== sprache_eigen` — der Speichern-Knopf
    # bleibt scharf und raeumt den Alt-Eintrag beim ersten Oeffnen weg. Normalisiert der Server,
    # sind beide `null`, der Knopf ist grau, und der Eintrag steht fuer immer unsichtbar in der
    # Datei. `sprache_eigen` sagt, was WIRKLICH dort steht; das Aufraeumen ist der Dialog.
    # Ohne diese Zeile blieben ALLE Backend-Tests unter der Aenderung gruen (nachgemessen).
    projekt.setze_datei("p", "c", sprache="")
    c = projekt.datei_ansicht("p", "c")
    assert c["sprache_eigen"] == "", "leerer Eintrag darf nicht zu None normalisiert werden"
    assert c["sprache"] == "ch", "... wirkt aber wie geerbt, solange er dasteht"


def test_ERBEN_auf_einer_datei_OHNE_override_wirft_nicht(tmp_path, monkeypatch):
    """Zweimal zuruecksetzen ist kein Fehler — `pop` mit Default statt `del`.

    Beide Felder, nicht nur der Haken: ueber HTTP ist der Fall erreichbar
    (`PUT {"sprache": null}` auf eine nie angefasste Datei), und ein `del` gaebe dort 500.
    Ohne die zweite Zeile bliebe die Mutation `pop` -> `del` fuer `sprache` gruen — der einzige
    andere Test, der `sprache=ERBEN` faehrt, setzt vorher einen Override.
    """
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.setze_datei("p", "a", mehrsprachig=projekt.ERBEN)
    assert projekt.datei_override_mehrsprachig("p", "a") is None
    projekt.setze_datei("p", "a", sprache=projekt.ERBEN)
    assert projekt.datei_ansicht("p", "a")["sprache_eigen"] is None


def test_override_unterscheidet_gleichlautend_von_geerbt(tmp_path, monkeypatch):
    """`datei_mehrsprachig` allein kann das nicht: ein Override, der zufaellig dasselbe sagt
    wie das Projekt, sieht dort identisch aus wie "folgt dem Projekt" — die Oberflaeche
    koennte den Rueckweg also weder anzeigen noch beschriften."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.speichern("p", {"mehrsprachig": True})
    projekt.setze_datei("p", "a", mehrsprachig=True)         # gleichlautender Override
    assert projekt.datei_mehrsprachig("p", "a") is True
    assert projekt.datei_override_mehrsprachig("p", "a") is True
    assert projekt.datei_override_mehrsprachig("p", "b") is None   # nie angefasst


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


def test_nicht_lesbare_projekt_json_meldet_sich(tmp_path, monkeypatch, capsys):
    """Der Rueckfall auf Defaults ist richtig — aber nicht still: `speichern`/`setze_datei`
    sind Read-Modify-Write ueber `laden()`, der naechste Upload ueberbuegelt die Datei also
    mit Defaults. Gemessen: Sprache und Tiefe ALLER Dateien waren danach weg, englische
    Aufnahmen liefen wieder als Schweizerdeutsch. Zwilling von #192 (settings.json).

    Ein fehlender Eintrag (Legacy-Projekt) schweigt weiterhin — sonst stuende die Zeile bei
    jedem Projekt ohne projekt.json im Log und waere wertlos."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(paths.project_dir("p"), exist_ok=True)
    assert projekt.laden("p")["sprache"] == sprachen.SPRACH_DEFAULT
    assert capsys.readouterr().out == ""                    # Datei fehlt -> kein Laerm
    with open(projekt._pfad("p"), "wb") as fh:
        fh.write(b'{"sprache": "\xe9n"}')
    projekt.laden("p")
    assert "nicht lesbar" in capsys.readouterr().out


def test_upload_legt_die_unlesbare_projekt_json_beiseite(tmp_path, monkeypatch):
    """#196: `setze_datei` ist ein Read-Modify-Write ueber `laden()` und ersetzte die kaputte
    Datei durch Defaults plus seinen einen Eintrag — Sprache und Tiefe ALLER anderen Dateien
    waren danach weg, englische Aufnahmen liefen wieder auf Schweizerdeutsch. Die Schreiber
    sind haeufig und unbeaufsichtigt: jeder Audio-Upload und jeder URL-Import.

    Geprueft wird beides — dass der alte Inhalt erhalten bleibt UND dass der Upload trotzdem
    durchlaeuft. Ein Schreibpfad, der bei kaputter Datei verweigert, liesse den Upload
    scheitern; das waere die schlechtere Richtung."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(paths.project_dir("p"), exist_ok=True)
    with open(projekt._pfad("p"), "wb") as fh:
        fh.write(b'{"sprache": "en", "korrektur": "leicht", '
                 b'"dateien": {"a": {"sprache": "fr"}}, "x": "caf\xe9"}')
    projekt.setze_datei("p", "c", sprache="de")
    gerettet = (tmp_path / "p" / "projekt.json.kaputt").read_bytes()
    assert b'"fr"' in gerettet and b'"leicht"' in gerettet
    assert projekt.datei_sprache("p", "c") == "de"          # der Upload selbst ging durch


def test_laden_verschluckt_den_unsicheren_namen_nicht(tmp_path, monkeypatch):
    """`paths.safe_name` wirft ValueError fuer unsichere Namen. Seit der Erweiterung auf
    ValueError (#190) lag dieser Wurf im Rueckfall-Bereich, wenn der Pfadbau IM try steht —
    `laden("..")` gab dann Defaults zurueck statt zu werfen (gemessen). Eine Vertrauensgrenze
    darf nicht wie eine kaputte Datei aussehen."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    with pytest.raises(ValueError):
        projekt.laden("..")


# ---- Sprecheranzahl fuer die Diarisierung (#264) ----

def test_sprecher_wird_pro_datei_gespeichert_und_gelesen(tmp_path, monkeypatch):
    """pyannote findet an Kameramikrofon-Aufnahmen zu wenige Sprecher (gemessen: 2 statt 4,
    3 statt 5). Die einzige Stellschraube, die kontrolliert wirkt, ist die vorgegebene Anzahl —
    die Clustering-Parameter tun es NICHT (threshold 0.60/0.55/0.50 lieferte identische Cluster,
    Fb=0.3 sprengte eine 5-Personen-Aufnahme auf 9)."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    assert projekt.datei_sprecher("p", "a") is None          # Vorgabe: automatisch wie bisher
    projekt.setze_datei("p", "a", sprecher=5)
    assert projekt.datei_sprecher("p", "a") == 5
    assert projekt.datei_sprecher("p", "b") is None          # streng pro Datei, kein Uebertrag


def test_sprecher_laesst_sich_wieder_auf_automatisch_stellen(tmp_path, monkeypatch):
    """`ERBEN` entfernt den Schluessel — hier heisst das nicht „folgt dem Projekt" (es gibt
    bewusst keinen Projekt-Standard), sondern „wieder automatisch". Ohne den Rueckweg bliebe
    eine einmal getippte Zahl fuer immer stehen; ueber `None` geht es nicht, das ist das
    Partial-Update-Signal."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.setze_datei("p", "a", sprecher=4)
    projekt.setze_datei("p", "a", sprache="de")               # Partial-Update fasst es nicht an
    assert projekt.datei_sprecher("p", "a") == 4
    projekt.setze_datei("p", "a", sprecher=projekt.ERBEN)
    assert projekt.datei_sprecher("p", "a") is None
    assert projekt.datei_sprache("p", "a") == "de"            # nur der eine Schluessel ist weg


def test_sprecher_ueberlebt_kaputte_werte_in_der_datei(tmp_path, monkeypatch):
    """Schema-Toleranz wie bei `sprache`/`mehrsprachig`: ein Nicht-int (von Hand editiert, aus
    einer aelteren Fassung) darf nicht bis in `diarize_file` durchreisen — dort waere er ein
    Wurf mitten im GPU-Lauf. `True` ist dabei der fiese Fall: `isinstance(True, int)` ist in
    Python wahr, ein Haken wuerde also als „1 Sprecher" durchgehen."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(paths.project_dir("p"), exist_ok=True)
    for wert in ('"fuenf"', "0", "-1", "true", "2.5", "null"):
        with open(projekt._pfad("p"), "w", encoding="utf-8") as fh:
            fh.write('{"dateien": {"a": {"sprecher": %s}}}' % wert)
        assert projekt.datei_sprecher("p", "a") is None, f"{wert} haette abgewiesen werden muessen"


def test_datei_ansicht_liefert_sprecher_aus_demselben_lesevorgang(tmp_path, monkeypatch):
    """Der Dialog liest ALLES ueber eine Datei aus EINEM `laden()` — ein separater Aufruf
    koennte zwischen den Werten einen fremden Schreiber erwischen (dieselbe Begruendung wie
    bei `mehrsprachig_eigen`, #234)."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    projekt.setze_datei("p", "a", sprecher=3)
    assert projekt.datei_ansicht("p", "a")["sprecher"] == 3
    assert projekt.datei_ansicht("p", "b")["sprecher"] is None
