"""Das prozessuebergreifende Lock (`sperre.datei`).

Die Nutzung steht in test_settings.py und test_ytdlp_update.py (zwei Faeden, Gleichzeitigkeit
gemessen). Hier geht es um die Raender, die dort nicht auftauchen — und die alle drei
gemeinsam haben, dass ein Fehler in ihnen die Sperre **still** ausser Kraft setzt.
"""
import builtins
import os
import platform
import subprocess
import sys
import threading
import time

import pytest

from webtool import sperre


def _merker(lockdir: str, pid: int, wirt: str | None = None) -> None:
    """Schreibt den Halter-Merker von Hand — so, wie ihn ein FREMDER Prozess hinterliesse."""
    with open(os.path.join(lockdir, sperre._HALTER), "w", encoding="utf-8") as f:
        f.write(f"{pid} {platform.node() if wirt is None else wirt}")


def _lebender_prozess() -> subprocess.Popen:
    """Lange genug, dass er keinen Test rettet, indem er mittendrin von selbst endet — mit
    30 s blieb die Wirt-Pruefung unten gruen, obwohl sie entfernt war (nachgemessen)."""
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])


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


# --- Lebendpruefung des Halters (#175) -------------------------------------------------

def test_lebendpruefung_toetet_den_geprueften_prozess_nicht():
    """Die Lebendpruefung darf den Halter nicht anfassen — sonst erschiesst ausgerechnet der
    Warter den Prozess, dessen kritischen Abschnitt er schuetzen soll.

    Deshalb steht auf Windows ctypes/OpenProcess und NICHT `os.kill(pid, 0)`: 0 und 1 sind
    dort `CTRL_C_EVENT`/`CTRL_BREAK_EVENT`, `os.kill` ist also eine Konsolen-Signal-API und
    kein Lebendtest. Gemessen auf 3.11.15/3.13.15/3.14.7: `sig 0` liess den Kindprozess zwar
    laufen, `sig 1` riss die aufrufende Shell mit (Exit 58), und die Doku sagt fuer alles
    ausser CTRL_* weiterhin TerminateProcess zu. Auf diese Zusage stuetzt sich hier nichts.
    """
    p = _lebender_prozess()
    try:
        assert sperre._prozess_lebt(p.pid) is True
        assert p.poll() is None, "die Lebendpruefung hat den geprueften Prozess beendet"
    finally:
        p.kill()
        p.wait()
    assert sperre._prozess_lebt(p.pid) is False
    assert sperre._prozess_lebt(os.getpid()) is True


@pytest.mark.skipif(os.name != "nt", reason="der ctypes-Zweig existiert nur auf Windows")
def test_windows_beantwortet_beide_openprocess_ausgaenge():
    """Der 87-Zweig ist auf Windows der HAUPT-Entscheider — er beantwortet das
    `taskkill /F /T`-Opfer, dessen Handles alle zu sind — und hatte null Abdeckung: die
    beiden anderen Tests halten ueber `Popen` absichtlich ein Handle offen und laufen
    deshalb durch `WaitForSingleObject`, nicht durch den `OpenProcess`-Fehler.

    Beide Richtungen, sonst ist die Zusicherung halb: `!= 87` → `False` (alles tot) faellt
    sonst nicht auf, `!= 87` → `True` (alles lebt) nur ueber die erste Zeile.
    """
    assert sperre._prozess_lebt(2 ** 31 - 4) is False      # diese PID gibt es nicht
    assert sperre._prozess_lebt(4) is True                 # System-Prozess: Zugriff verweigert


def test_halb_geschriebener_merker_ist_keine_auskunft():
    """Der dritte Zustand ("keine Auskunft") traegt die ganze Sicherheit dieses Moduls, und
    der halb geschriebene Merker war der einzige seiner Faelle ohne Test. Ohne das `except`
    fliegt ein `ValueError` bis zum Aufrufer — `settings.save()` sitzt auf
    `PUT /api/settings`, `fetch._hole_yt_dlp()` hat gar keinen Schutz.
    """
    assert sperre._lebt_laut(b"12") is None                # mitten im Schreiben abgebrochen
    assert sperre._lebt_laut(b"abc workstation") is None   # keine Zahl
    assert sperre._lebt_laut(b"\xff\xfe kaputt") is None   # nicht als UTF-8 dekodierbar
    assert sperre._lebt_laut(b"") is None


def test_ohne_rechnernamen_gibt_es_keine_auskunft(monkeypatch):
    """`platform.node()` schluckt `OSError` intern und liefert dann `""`. Beide Haelften
    degradieren dann konsistent — und genau das ist die Falle: `"" == ""` ist wahr, die
    Wirt-Pruefung waere wirkungslos, und auf einem geteilten Ordner beantwortete eine LOKALE
    PID einen fremden Merker. Sagt sie "tot", ist der Fehler aus #175 wieder da.
    """
    monkeypatch.setattr(sperre.platform, "node", lambda: "")
    p = _lebender_prozess()
    try:
        assert sperre._lebt_laut(f"{p.pid} ".encode()) is None
    finally:
        p.kill()
        p.wait()


def test_halb_geschriebener_eigener_merker_haelt_das_lock_nicht_fest(tmp_path, monkeypatch):
    """Scheitert erst das `close()` (der Normalfall bei vollem Datentraeger — gepuffertes IO
    meldet einen kurzen Schreibvorgang beim Schliessen), liegt der Merker mit TEILINHALT da.
    Merkte sich der Halter dann, was er schreiben WOLLTE, passte sein Ausweis nicht mehr auf
    das, was auf der Platte steht — und er raeumte sein EIGENES Lock nicht mehr weg. Der
    Nachweis gehoert zugleich zur Zusage "scheitert das Schreiben, verhaelt sich das Lock wie
    vor #175": ohne diesen Test uebte sie kein Lauf aus.
    """
    echt = builtins.open

    class Halb:
        """Schreibt nur die Haelfte und meldet den Fehler beim Schliessen."""

        def __init__(self, f):
            self._f = f

        def write(self, daten):
            return self._f.write(daten[:3])

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self._f.close()
            raise OSError(28, "No space left on device")

    def hakelig(pfad, *a, **k):
        f = echt(pfad, *a, **k)
        schreibend = "w" in (a[0] if a else k.get("mode", "r"))
        return Halb(f) if schreibend and str(pfad).endswith(sperre._HALTER) else f

    monkeypatch.setattr(builtins, "open", hakelig)
    ziel = str(tmp_path / "x.json")
    lock = ziel + ".lock"
    with sperre.datei(ziel):
        assert os.path.isdir(lock)
        halb = sperre._merker_lesen(lock)                  # halb, wie gebaut
        assert halb == f"{os.getpid()} {platform.node()}".encode()[:3]
    assert not os.path.exists(lock), "das eigene Lock blieb liegen"


def test_unplausible_pid_gilt_als_keine_auskunft():
    """Eine kaputte Zahl im Merker darf nicht als "tot" durchgehen — dann raeumte der Warter
    das Lock SOFORT weg, und zwar an der Frist vorbei. ctypes wirft dabei nicht, es schneidet
    auf `c_uint32` ab: gemessen kam `10**25` als False zurueck (weggeraeumt) und `2**32+7`
    als True ueber die fremde PID 7. `<= 0` deckt zusaetzlich `os.kill(0, …)` auf POSIX ab —
    das traefe die ganze Prozessgruppe.
    """
    assert sperre._prozess_lebt(10 ** 25) is None
    assert sperre._prozess_lebt(2 ** 32 + 7) is None
    assert sperre._prozess_lebt(0) is None
    assert sperre._prozess_lebt(-1) is None


def test_das_gehaltene_lock_nennt_seinen_halter(tmp_path):
    """Schreiber und Leser des Merkers muessen dasselbe Format sprechen — tun sie es nicht,
    faellt die ganze Pruefung auf 'keine Auskunft' zurueck, und zwar STILL: das Lock
    verhielte sich exakt wie vor #175."""
    ziel = str(tmp_path / "x.json")
    with sperre.datei(ziel):
        assert sperre._lebt_laut(sperre._merker_lesen(ziel + ".lock")) is True


def test_lebender_halter_wird_nicht_weggeraeumt(tmp_path, monkeypatch):
    """#175: die Frist zaehlt ab dem `mkdir`, nicht ab der letzten Regung des Halters — geht
    der Rechner mitten im kritischen Abschnitt schlafen, laeuft die Wanduhr weiter und er
    nicht. Vorher nahm der Warter dem LEBENDEN Halter daraufhin das Lock weg, und beide
    schrieben gleichzeitig (genau die Race, gegen die die Sperre da ist).

    Der Test misst BEIDE Haelften am selben Lauf: solange der Halter lebt, wartet der Faden
    (er darf nicht fertig sein, und das Lock muss unangetastet dastehen) — stirbt der Halter,
    laeuft derselbe Faden von selbst weiter. Nur so ist "wartet" von "haengt" unterschieden.
    Die Obergrenze ist dafuer hochgesetzt, sonst griffe der erzwungene Griff (siehe unten)
    dazwischen und der Test bewiese nichts.

    Gemessen an einem echten Prozess, nicht an einer Attrappe: die Lebendpruefung ist der
    einzige Teil dieses Moduls, der ueberhaupt aus Python heraussieht.
    """
    monkeypatch.setattr(sperre, "_AUFGEBEN_PUFFER_S", 30.0)
    ziel = str(tmp_path / "x.json")
    lock = ziel + ".lock"
    os.mkdir(lock)
    halter = _lebender_prozess()
    try:
        _merker(lock, halter.pid)
        alt = time.time() - 100
        os.utime(lock, (alt, alt))                # laengst "verwaist" nach der Frist
        gelaufen = []

        def lauf():
            with sperre.datei(ziel, stale=0.0):
                gelaufen.append(1)

        faden = threading.Thread(target=lauf, daemon=True)
        faden.start()
        faden.join(0.5)
        assert faden.is_alive(), "der Warter ist am lebenden Halter vorbeigelaufen"
        assert gelaufen == []
        assert os.path.isdir(lock), "dem lebenden Halter wurde das Lock weggenommen"
        assert os.path.exists(os.path.join(lock, sperre._HALTER))
    finally:
        halter.kill()
        halter.wait()
    faden.join(5)                                 # jetzt ist der Halter tot -> geht weiter
    assert not faden.is_alive(), "haengt, obwohl der Halter nicht mehr da ist"
    assert gelaufen == [1]


def test_nach_der_obergrenze_wird_doch_zugegriffen(tmp_path, monkeypatch, capsys):
    """Die Kehrseite: eine wiederverwendete PID sieht genauso lebendig aus wie ein echter
    Halter. Bliebe es beim Schutz, kostete ein verwaistes Lock danach JEDEN Aufruf die volle
    Frist (beim pip-Lock 155 s) und liefe anschliessend ungeschuetzt — dauerhaft. Wer laenger
    wartet, als ein kritischer Abschnitt dauern kann, greift deshalb EINMAL erzwungen zu; die
    Uhr ist der Rueckfall der Lebendpruefung, nicht durch sie abgeschaltet.
    """
    monkeypatch.setattr(sperre, "_AUFGEBEN_PUFFER_S", 0.05)
    ziel = str(tmp_path / "x.json")
    lock = ziel + ".lock"
    os.mkdir(lock)
    halter = _lebender_prozess()                  # steht fuer die neu vergebene PID
    try:
        _merker(lock, halter.pid)
        gehalten = []

        def lauf():
            with sperre.datei(ziel, stale=0.0):
                gehalten.append(sperre._merker_lesen(lock))

        faden = threading.Thread(target=lauf, daemon=True)
        faden.start()
        faden.join(5)
        assert not faden.is_alive()
        # erworben, nicht bloss ungeschuetzt weiter: im Lock steht jetzt UNSERE PID
        assert gehalten == [f"{os.getpid()} {platform.node()}".encode()]
        assert not os.path.exists(lock)
        ausgabe = capsys.readouterr().out
        assert "wird uebernommen" in ausgabe
        assert "ungeschuetzt" not in ausgabe
    finally:
        halter.kill()
        halter.wait()


def test_wegraeumen_laesst_ein_inzwischen_fremdes_lock_stehen(tmp_path):
    """Zwischen "der Halter ist tot" und dem `rmdir` liegen Systemaufrufe — darin kann ein
    anderer Warter das Lock abgeraeumt, neu angelegt und den Abschnitt betreten haben. Ohne
    den Ausweis-Vergleich raeumte man ihm sein FRISCHES Lock weg (und sein `finally` traefe
    danach einen Dritten). Deterministisch reproduziert im /code-review-Lauf zu #175.
    """
    lock = str(tmp_path / "x.json.lock")
    os.mkdir(lock)
    _merker(lock, 4711)
    sperre._wegraeumen(lock, b"333 irgendwer")    # Entscheidung galt einem anderen Inhalt
    assert os.path.isdir(lock), "fremdes Lock weggeraeumt"
    assert sperre._merker_lesen(lock) == f"4711 {platform.node()}".encode()


def test_der_bestohlene_halter_raeumt_nicht_das_lock_des_nachfolgers(tmp_path):
    """Die zweite Haelfte derselben Kaskade: wurde uns das Lock weggenommen und neu vergeben,
    darf unser `finally` nicht das Verzeichnis des Nachfolgers loeschen — sonst spaziert der
    naechste Warter in dessen kritischen Abschnitt.
    """
    ziel = str(tmp_path / "x.json")
    lock = ziel + ".lock"
    with sperre.datei(ziel):
        os.remove(os.path.join(lock, sperre._HALTER))   # jemand nimmt uns das Lock weg
        os.rmdir(lock)
        os.mkdir(lock)                                  # ... und legt sein eigenes an
        _merker(lock, 4711)
    assert os.path.isdir(lock), "das Lock des Nachfolgers wurde abgeraeumt"
    assert sperre._merker_lesen(lock) == f"4711 {platform.node()}".encode()


def test_toter_halter_muss_die_frist_nicht_absitzen(tmp_path):
    """Die Kehrseite derselben Auskunft: ein `taskkill /F /T`-Opfer ist sofort erkennbar —
    dort auf die Frist zu warten (beim pip-Lock 150 s) heisst, einem Prozess nachzutrauern,
    den es nachweislich nicht mehr gibt. Die mtime ist hier FRISCH, die Frist also nicht
    abgelaufen; ohne die Lebendpruefung wartet dieser Lauf volle 60 s.

    Im Faden mit `join`, weil ein zu langes Warten sonst keinen Test rot macht (#191).
    """
    tot = subprocess.Popen([sys.executable, "-c", "pass"])
    # Auf Windows haelt `Popen` das Prozess-Handle, die PID bleibt also reserviert und
    # `OpenProcess` beantwortet sie als beendet. Auf POSIX gibt `wait()` den Prozess frei und
    # die PID darf neu vergeben werden — dort traegt der Test die sequenzielle Vergabe von
    # Linux, keine Zusicherung.
    tot.wait()
    ziel = str(tmp_path / "x.json")
    lock = ziel + ".lock"
    os.mkdir(lock)
    _merker(lock, tot.pid)
    gehalten = []

    def lauf():
        with sperre.datei(ziel, stale=60):
            gehalten.append(os.path.isdir(lock))

    faden = threading.Thread(target=lauf, daemon=True)
    faden.start()
    faden.join(5)
    assert not faden.is_alive(), "wartet die Frist auf einen Halter ab, den es nicht mehr gibt"
    assert gehalten == [True]                     # erworben, nicht bloss ungeschuetzt weiter
    assert not os.path.exists(lock)


def test_merker_von_einem_anderen_rechner_gilt_nicht(tmp_path, monkeypatch, capsys):
    """Liegt das Lock auf einem geteilten Ordner, kann der Merker von einem ANDEREN Rechner
    stammen — dort sagt eine lokale PID nichts, im schlimmsten Fall das Gegenteil (die Zahl
    gehoert hier einem beliebigen fremden Prozess). Dann entscheidet die Frist wie vor #175.

    Geprueft wird nicht nur, DASS aufgeraeumt wurde, sondern auf welchem WEG: ohne die
    Wirt-Pruefung gilt der fremde Merker als lebender Halter, und das Lock faellt erst dem
    erzwungenen Griff nach der Obergrenze zum Opfer — am Ende steht dasselbe Ergebnis, mit
    einer Zeile im Protokoll als einzigem Unterschied. Genau daran war dieser Test schon
    einmal vacuous (davor rettete ihn der Halter-Subprozess, der mittendrin von selbst
    endete).
    """
    # 0,5 s statt 0,05: die erste Schleifenrunde muss darunter bleiben, sonst feuert der
    # erzwungene Griff ZUSAETZLICH und die Ausgabe-Zusicherung unten scheitert — auf einer
    # belasteten Kiste mit Virenscanner erreichbar. Falsch-rot ist hier besonders teuer, weil
    # genau dieser Test schon zweimal vacuous war und als Flake abgetan wuerde.
    monkeypatch.setattr(sperre, "_AUFGEBEN_PUFFER_S", 0.5)
    ziel = str(tmp_path / "x.json")
    lock = ziel + ".lock"
    os.mkdir(lock)
    halter = _lebender_prozess()
    try:
        _merker(lock, halter.pid, wirt="ein-anderer-rechner")
        alt = time.time() - 100
        os.utime(lock, (alt, alt))
        with sperre.datei(ziel, stale=0.0):
            assert os.path.isdir(lock)            # erworben, nicht vom fremden Merker gehalten
        assert not os.path.exists(lock)
        assert capsys.readouterr().out == ""      # ueber die Frist, nicht ueber den Notgriff
    finally:
        halter.kill()
        halter.wait()


def test_freigabe_wiederholt_ein_gescheitertes_rmdir(tmp_path, monkeypatch):
    """#205: `os.rmdir` scheitert beim Freigeben VORUEBERGEHEND, und der Fehler wird beim
    Aufrufer geschluckt — das Lock bleibt liegen. Weil in seinem Merker die PID des noch
    LEBENDEN Prozesses steht, sagt `_lebt_laut` danach "unantastbar": die Uhr kommt gar nicht
    mehr zum Zug, und der naechste Warter sitzt die volle Frist ab (beim pip-Lock 155 s).

    Der Ausloeser ist Windows-eigen (eine geoeffnete Datei wird erst beim Schliessen wirklich
    geloescht, `os.rmdir` meldet solange WinError 145) — die WIEDERHOLUNG laesst sich aber
    plattformunabhaengig pruefen, und genau darum geht es hier. Der echte Ablauf steht im
    Test darunter.
    """
    versuche = []
    echt = os.rmdir

    def hakelig(pfad):
        versuche.append(pfad)
        if len(versuche) < 3:                     # die ersten beiden scheitern, dann geht es
            raise OSError(41, "Das Verzeichnis ist nicht leer")
        echt(pfad)

    monkeypatch.setattr(sperre, "_RMDIR_PAUSE_S", 0.001)
    monkeypatch.setattr(os, "rmdir", hakelig)
    ziel = str(tmp_path / "x.json")
    with sperre.datei(ziel):
        pass
    assert len(versuche) == 3                     # zweimal daneben, beim dritten Mal weg
    assert not os.path.exists(ziel + ".lock")     # und das Lock ist wirklich fort


def test_freigabe_gibt_bei_dauerhaftem_fehler_auf(tmp_path, monkeypatch):
    """Die Gegenprobe: die Wiederholung darf nicht zur Endlosschleife werden. Ein dauerhaft
    scheiterndes `rmdir` (Datei am Lock-Pfad, schreibgeschuetzter Ordner) muss nach
    `_RMDIR_VERSUCHE` durchgereicht werden — der Aufrufer entscheidet dann (im `finally` von
    `datei` wird es geschluckt, das Lock bleibt liegen und die Frist raeumt es spaeter ab).
    """
    monkeypatch.setattr(sperre, "_RMDIR_PAUSE_S", 0.001)
    monkeypatch.setattr(os, "rmdir", lambda p: (_ for _ in ()).throw(OSError(41, "nicht leer")))
    lock = str(tmp_path / "x.json") + ".lock"
    os.mkdir(lock)
    with pytest.raises(OSError):
        sperre._wegraeumen(lock, None)


def test_freigabe_faesst_ein_inzwischen_FREMDES_lock_nicht_an(tmp_path, monkeypatch):
    """Die Wiederholung streckt das Fenster von Mikrosekunden auf bis zu 160 ms — und darin
    kann ein Warter das Lock uebernommen haben (Notgriff). Dann steht an diesem Pfad ein
    FREMDES Verzeichnis, und die naechste Runde loeschte dessen frisches Lock: genau die
    Kaskade, gegen die der Merker gebaut ist. Der Merker-INHALT taugt dafuer nicht — zwei
    Faeden eines Prozesses schreiben denselben (#207), und nach dem `os.remove` ist er weg.

    (CodeRabbit-CLI an PR #206, als kritisch gemeldet — zu Recht.)
    """
    lock = str(tmp_path / "x.json") + ".lock"
    os.mkdir(lock)
    _merker(lock, os.getpid())
    meiner = sperre._merker_lesen(lock)
    echt = os.rmdir
    getan = []

    def tauscht(pfad):
        if not getan:                     # erster Versuch: scheitert — und der Pfad wechselt
            getan.append(True)
            echt(pfad)                    # unser Verzeichnis ist weg …
            os.mkdir(pfad)                # … und ein FREMDES steht am selben Pfad,
            _merker(pfad, os.getpid())    # mit BYTEGLEICHEM Merker (derselbe Prozess)
            raise OSError(41, "nicht leer")
        echt(pfad)                        # pragma: no cover — darf nie drankommen

    monkeypatch.setattr(sperre, "_RMDIR_PAUSE_S", 0.001)
    monkeypatch.setattr(os, "rmdir", tauscht)
    sperre._wegraeumen(lock, meiner)
    assert os.path.isdir(lock)            # das fremde Lock steht noch
    assert os.path.exists(os.path.join(lock, sperre._HALTER))   # samt seinem Merker


@pytest.mark.skipif(os.name != "nt", reason="delete-pending gibt es nur auf Windows; auf POSIX "
                                            "loescht os.remove den Eintrag sofort")
def test_freigabe_ueberlebt_einen_lesenden_warter(tmp_path, monkeypatch):
    """Der ECHTE Ablauf aus #205, ohne Attrappe: ein Warter liest den Merker (`_merker_lesen`
    macht genau das), waehrend der Halter freigibt. Auf dieser Maschine gemessen scheitert dann
    schon `os.remove` mit `[WinError 32]`, und `os.rmdir` mit `[WinError 145]` — ohne die
    Wiederholung bleibt das Lock liegen.

    **Kein fester Zeitgeber**: der Warter schliesst, sobald das `rmdir` WIRKLICH gescheitert
    ist, und am Ende steht die Positivkontrolle (`gescheitert.is_set()`). Ohne sie liefe der
    Test auch dann gruen durch, wenn der Fall gar nicht eingetreten waere — eine Suche, deren
    Ergebnis "nicht gefunden" sein darf, braucht eine Probe, die gefunden werden MUSS.
    (CodeRabbit-CLI an PR #206.)

    Auf POSIX ist der Fall nicht herstellbar, deshalb der `skipif` — die CI faehrt Ubuntu und
    sieht diesen Test also NIE (dieselbe Luecke wie #201). Der plattformunabhaengige Test
    darueber deckt die Wiederholung ab.
    """
    lock = str(tmp_path / "x.json") + ".lock"
    os.mkdir(lock)
    _merker(lock, os.getpid())
    merker = sperre._merker_lesen(lock)
    offen = open(os.path.join(lock, sperre._HALTER), "rb")   # der lesende Warter
    gescheitert = threading.Event()
    echt = os.rmdir

    def beobachtet(pfad):
        try:
            echt(pfad)
        except OSError:
            gescheitert.set()                                # jetzt darf der Warter schliessen
            raise

    monkeypatch.setattr(os, "rmdir", beobachtet)
    schliesser = threading.Thread(target=lambda: (gescheitert.wait(5), offen.close()))
    schliesser.start()
    try:
        sperre._wegraeumen(lock, merker)                     # darf nicht werfen
    finally:
        gescheitert.set()                                    # kein haengender Faden im Fehlerfall
        schliesser.join(5)
        offen.close()
    assert gescheitert.is_set()          # Positivkontrolle: der Fall ist wirklich eingetreten
    assert not os.path.exists(lock)


def test_ohne_verzeichnis_kennung_wird_trotzdem_freigegeben(tmp_path, monkeypatch):
    """Die Identitaetspruefung braucht `st_ino` — auf manchen Netz- und FAT-Pfaden ist der 0,
    also keine Auskunft. Dann gilt hier wie ueberall: nicht raten. Beide Haelften einzeln
    geprueft, weil beide ohne Test gruen blieben (Mutationsprobe an PR #206):

    - `_verzeichnis_kennung` muss bei `st_ino == 0` **None** liefern, nicht `(dev, 0)` — sonst
      verglichen zwei verschiedene Verzeichnisse als "dasselbe", und die Wache waere schlimmer
      als keine.
    - `_ist_noch` muss ohne Auskunft **True** sagen. Die falsche Richtung waere teuer: die
      Freigabe braeche sofort ab, JEDES Lock bliebe liegen, und nur noch die Frist raeumte auf
      — genau der Zustand, gegen den #205 gebaut ist.
    """
    lock = str(tmp_path / "x.json") + ".lock"
    os.mkdir(lock)
    _merker(lock, os.getpid())
    meiner = sperre._merker_lesen(lock)

    class _OhneIno:                       # was ein FAT-/Netzpfad liefert
        st_dev, st_ino = 1, 0

    echt = os.lstat
    monkeypatch.setattr(os, "lstat", lambda p: _OhneIno() if p == lock else echt(p))
    assert sperre._verzeichnis_kennung(lock) is None
    assert sperre._ist_noch(lock, None) is True
    sperre._wegraeumen(lock, meiner)      # und die Freigabe laeuft trotzdem durch
    assert not os.path.exists(lock)
