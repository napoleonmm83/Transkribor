"""Das prozessuebergreifende Lock (`sperre.datei`).

Die Nutzung steht in test_settings.py und test_ytdlp_update.py (zwei Faeden, Gleichzeitigkeit
gemessen). Hier geht es um die Raender, die dort nicht auftauchen — und die alle drei
gemeinsam haben, dass ein Fehler in ihnen die Sperre **still** ausser Kraft setzt.
"""
import os
import threading
import time

from webtool import sperre


def test_lock_wird_gehalten_und_wieder_freigegeben(tmp_path):
    ziel = str(tmp_path / "x.json")
    with sperre.datei(ziel):
        assert os.path.isdir(ziel + ".lock")
    assert not os.path.exists(ziel + ".lock")


def test_verwaistes_lock_wird_nach_frist_aufgeraeumt(tmp_path):
    """Ein `taskkill /F /T` auf den Job-Prozessbaum laesst kein `finally` laufen — ohne die
    Frist blockierte das liegengebliebene Verzeichnis fuer immer."""
    ziel = str(tmp_path / "x.json")
    os.mkdir(ziel + ".lock")
    alt = time.time() - 100
    os.utime(ziel + ".lock", (alt, alt))
    with sperre.datei(ziel, stale=60):
        pass
    assert not os.path.exists(ziel + ".lock")


def test_langes_warten_wird_gemeldet(tmp_path, monkeypatch, capsys):
    """Ein verwaistes Lock heisst: der naechste Lauf steht bis zu `stale` Sekunden still —
    beim pip-Lock sind das 150 s. Ohne diese Zeile waere das ein Haenger ohne Ausgabe, und
    genau daran ist nicht zu erkennen, was los ist."""
    monkeypatch.setattr(sperre, "_LAUT_AB_S", 0.0)
    ziel = str(tmp_path / "x.json")
    os.mkdir(ziel + ".lock")
    alt = time.time() - 100
    os.utime(ziel + ".lock", (alt, alt))
    with sperre.datei(ziel, stale=60):
        pass
    assert "warte auf" in capsys.readouterr().out


def test_voruebergehender_fehler_gibt_nicht_sofort_auf(tmp_path, monkeypatch):
    """Auf Windows meldet os.mkdir auf ein Verzeichnis, dessen Loeschung noch aussteht,
    PermissionError statt FileExistsError — also ausgerechnet unter Konkurrenz, dem einzigen
    Moment, in dem die Sperre zaehlt. Ein sofortiges Aufgeben liesse den kritischen Abschnitt
    dort ungeschuetzt laufen, wo er es am wenigsten darf."""
    versuche = []
    echt = os.mkdir

    def hakelig(pfad, *a, **k):
        versuche.append(pfad)
        if len(versuche) <= 3:
            raise PermissionError(5, "Access is denied")
        return echt(pfad, *a, **k)

    monkeypatch.setattr(sperre.os, "mkdir", hakelig)
    ziel = str(tmp_path / "x.json")
    with sperre.datei(ziel):
        assert os.path.isdir(ziel + ".lock")      # doch noch erworben, nicht uebersprungen
    assert len(versuche) == 4


def test_dauerhaft_unmoeglich_haelt_den_aufrufer_nicht_auf(tmp_path, monkeypatch, capsys):
    """Ein schreibgeschuetzter Ordner darf den Aufruf nicht blockieren — die Sperre schuetzt
    vor einer Race, sie ist nicht der Zweck des Aufrufs. Aber NICHT still: ein lautlos
    uebersprungenes Lock ist von einem gehaltenen nicht zu unterscheiden."""
    monkeypatch.setattr(sperre, "_HAKELIG_S", 0.02)

    def nie(*a, **k):
        raise PermissionError(5, "Access is denied")

    monkeypatch.setattr(sperre.os, "mkdir", nie)
    gelaufen = []
    with sperre.datei(str(tmp_path / "x.json")):
        gelaufen.append(1)
    assert gelaufen == [1]
    assert "ungeschuetzt" in capsys.readouterr().out


def test_datei_am_lock_pfad_haelt_den_aufrufer_nicht_auf(tmp_path, monkeypatch, capsys):
    """Liegt am Lock-Pfad eine DATEI statt unseres Verzeichnisses (Sync-Client, Backup,
    Quarantaene), meldet `os.mkdir` dauerhaft FileExistsError und `os.rmdir` scheitert mit
    NotADirectoryError — den schluckte das `except OSError`, und die Schleife drehte ENDLOS
    (#191). `stale` ist hier NICHT abgelaufen, `rmdir` laeuft also gar nicht erst: geprueft
    werden muss der Dateityp, nicht die Ausnahme.

    Gemessen im Faden mit `join`: ein Haenger macht keinen Test rot, er laesst die ganze
    Suite auslaufen — das ist genau der Grund, warum es niemandem aufgefallen ist.
    """
    monkeypatch.setattr(sperre, "_LAUT_AB_S", 1e9)     # ein Haenger soll nicht in fremde
    monkeypatch.setattr(sperre, "_AUFGEBEN_PUFFER_S", 1e9)   # Tests hineinprotokollieren
    ziel = str(tmp_path / "x.json")
    (tmp_path / "x.json.lock").write_text("keine Sperre, sondern eine Datei")
    gelaufen = []

    def lauf():
        with sperre.datei(ziel, stale=60):
            gelaufen.append(1)

    faden = threading.Thread(target=lauf, daemon=True)
    faden.start()
    faden.join(5)
    assert not faden.is_alive(), "sperre.datei() haengt an einer Datei am Lock-Pfad"
    assert gelaufen == [1]
    # Nicht bloss "ungeschuetzt": die Zeile muss den Grund nennen, sonst ist sie von den
    # beiden anderen Ausstiegen nicht zu unterscheiden.
    assert "ist kein Verzeichnis" in capsys.readouterr().out
    assert (tmp_path / "x.json.lock").is_file()   # fremde Datei bleibt unangetastet


def test_nicht_raeumbares_lock_haelt_den_aufrufer_nicht_auf(tmp_path, monkeypatch, capsys):
    """Dieselbe Endlosschleife ueber den ZWEITEN Weg: ein abgelaufenes Lock-VERZEICHNIS, das
    sich nicht loeschen laesst (Sync-Konfliktdatei, `desktop.ini`, Virenscanner-Handle).
    `os.rmdir` wirft `[WinError 145] Das Verzeichnis ist nicht leer`, der Verwaist-Zweig
    schluckt es, und die Schleife dreht endlos — nachgemessen, und vom Typ-Test aus #191
    NICHT gedeckt. Die Obergrenze ueber die ganze Schleife deckt die Klasse statt der
    naechsten Form.

    Wieder im Faden mit `join`: ein Haenger macht keinen Test rot, er laesst die Suite
    auslaufen.
    """
    monkeypatch.setattr(sperre, "_AUFGEBEN_PUFFER_S", 0.05)
    ziel = str(tmp_path / "x.json")
    os.mkdir(ziel + ".lock")
    (tmp_path / "x.json.lock" / "desktop.ini").write_text("fremd")
    alt = time.time() - 100
    os.utime(ziel + ".lock", (alt, alt))          # verwaist — aber nicht wegzuraeumen
    gelaufen = []

    def lauf():
        with sperre.datei(ziel, stale=0.0):
            gelaufen.append(1)

    faden = threading.Thread(target=lauf, daemon=True)
    faden.start()
    faden.join(5)
    assert not faden.is_alive(), "sperre.datei() haengt an einem nicht raeumbaren Lock"
    assert gelaufen == [1]
    assert "laesst sich nicht uebernehmen" in capsys.readouterr().out


def test_weggeraeumtes_lock_faellt_nicht_ungeschuetzt_durch(tmp_path, monkeypatch, capsys):
    """Zwei Warter raeumen dasselbe verwaiste Lock auf: einer gewinnt, der andere bekommt
    beim `rmdir` einen FileNotFoundError. Das ist Erfolg, kein Hindernis — wer daraufhin
    ungeschuetzt weiterlaeuft, schaltet die Sperre genau unter Konkurrenz ab (dieselbe
    Richtung wie Befund (5) aus PR #172). Deshalb bricht die Schleife bei einem
    gescheiterten `rmdir` NICHT sofort aus, sondern erst nach `stale + _AUFGEBEN_PUFFER_S`.
    """
    ziel = str(tmp_path / "x.json")
    os.mkdir(ziel + ".lock")
    alt = time.time() - 100
    os.utime(ziel + ".lock", (alt, alt))
    echt = os.rmdir

    def zuvorgekommen(pfad, *a, **k):
        echt(pfad, *a, **k)                       # der andere Warter war schneller
        raise FileNotFoundError(2, "No such file or directory", pfad)

    monkeypatch.setattr(sperre.os, "rmdir", zuvorgekommen)
    with sperre.datei(ziel, stale=60):
        assert os.path.isdir(ziel + ".lock")      # doch noch erworben, nicht uebersprungen
    assert "ungeschuetzt" not in capsys.readouterr().out
