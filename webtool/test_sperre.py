"""Das prozessuebergreifende Lock (`sperre.datei`).

Die Nutzung steht in test_settings.py und test_ytdlp_update.py (zwei Faeden, Gleichzeitigkeit
gemessen). Hier geht es um die Raender, die dort nicht auftauchen — und die alle drei
gemeinsam haben, dass ein Fehler in ihnen die Sperre **still** ausser Kraft setzt.
"""
import os
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
