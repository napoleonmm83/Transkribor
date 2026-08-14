"""Prozessuebergreifendes Lock ueber ein Verzeichnis.

Herausgeloest aus `projekt._gesperrt` (#134/#149), als `settings.json` einen ZWEITEN
Schreiber bekam: seit der yt-dlp-Selbstaktualisierung schreibt auch der fetch-Subprozess
dorthin (den Merker), waehrend der Server denselben Read-Modify-Write fuer eine
Einstellung machen kann. Der letzte Schreiber gewinnt, die andere Aenderung ist weg —
genau der Fehler, den #134 fuer projekt.json beschreibt.

**Ein `threading.Lock` reicht dafuer nicht**: der Subprozess hat ein eigenes. `os.mkdir`
ist auf POSIX wie Windows atomar (im Gegensatz zu fcntl/msvcrt) — darum ein Verzeichnis,
ohne fremde Abhaengigkeit.

Kopieren statt herausloesen waere hier besonders teuer: eine Nebenlaeufigkeits-Primitive
zweimal zu fuehren heisst, sie beim naechsten Mal an einer Stelle falsch zu aendern
(dieselbe Regel wie bei `DateiMenue`).
"""
import contextlib
import os
import platform
import stat
import time

# Ab wann ein liegengebliebenes Lock als verwaist gilt — aber NUR, wenn sein Halter keine
# Auskunft gibt (altes Lock ohne Merker, fremder Rechner, halb geschriebene Datei). Wer sich
# meldet, wird nach seinem Zustand behandelt, nicht nach der Uhr: siehe `_lebt_laut`.
STALTES_ALTER = 60.0

# Der Merker mit der PID des Halters. Er liegt IM Lock-Verzeichnis, damit er es nicht
# ueberleben kann: als Nachbardatei stuende eine liegengebliebene PID irgendwann neben einem
# FRISCHEN Lock (aufgeraeumt wird in zwei Schritten), und der Warter risse dann genau das
# Lock weg, das er schuetzen soll. Der Preis ist, dass `os.rmdir` ein nicht mehr leeres
# Verzeichnis vorfindet — deshalb geht jedes Aufraeumen ueber `_wegraeumen`.
_HALTER = "halter"


# Wie lange ein anderer OSError als FileExistsError als voruebergehend gilt. Auf Windows
# meldet os.mkdir auf ein Verzeichnis, dessen Loeschung noch aussteht (der Halter hat gerade
# rmdir gerufen, oder ein Virenscanner/Indexer haelt ein Handle), PermissionError statt
# FileExistsError — also ausgerechnet unter Konkurrenz, dem einzigen Moment, in dem die
# Sperre zaehlt. Ein schreibgeschuetztes Elternverzeichnis meldet dasselbe dauerhaft; nach
# dieser Frist gilt es als "geht hier nicht" statt als "gleich nochmal".
_HAKELIG_S = 0.5
# Ab wann ein Warten so lang ist, dass es erklaert gehoert (verwaistes Lock nach einem
# `taskkill /F /T` auf den Job-Prozessbaum — das `finally` unten laeuft dann nie).
_LAUT_AB_S = 1.0
# Wie lange UEBER `stale` hinaus gewartet wird, bevor die Schleife aufgibt. Wer laenger
# wartet, als das Lock ueberhaupt gelten kann, kommt an das Aufraeumen nicht mehr heran:
# `os.rmdir` scheitert an einem nicht leeren Lock-Verzeichnis (Sync-Konfliktdatei,
# `desktop.ini`, Virenscanner-Handle) genauso wie an einer Datei am Lock-Pfad, und die
# Schleife hatte sonst keine Obergrenze — derselbe Haenger wie #191 ueber den zweiten Weg,
# nachgemessen. Diese Frist deckt die ganze KLASSE; der Typ-Test unten deckt nur die
# gemeldete Form, dafuer aber sofort, und das zaehlt auf dem Request-Pfad
# (`settings.save`, `POST /api/settings/ytdlp/update`). Ein legitimer Warter laeuft hier
# nie hinein: bis dahin hat der Verwaist-Zweig ein abgelaufenes Lock laengst abgeraeumt.
_AUFGEBEN_PUFFER_S = 5.0

# Wie oft `os.rmdir` beim Freigeben wiederholt wird, und wie lange dazwischen gewartet wird.
#
# **Windows loescht eine geoeffnete Datei nicht sofort.** `os.remove` gelingt, der Eintrag
# bleibt aber als "delete pending" im Verzeichnis stehen, bis der letzte Leser schliesst —
# `os.rmdir` scheitert solange mit `[WinError 145] Das Verzeichnis ist nicht leer`. Genau das
# passiert hier im Normalbetrieb: der Halter entfernt seinen Merker, waehrend ein Warter ihn
# gerade liest (`_merker_lesen`). Nachgemessen wurde es an einem Prueftstand, der den echten
# Ablauf nachbaut (3 Faeden, je EIN Zugriff, verschachteltes settings-Lock wie in `_merken`),
# 250 Runden: **3 von 1500** Freigaben scheiterten so — und dieselben **3** Runden hatten eine
# Wartezeit von exakt `stale + _AUFGEBEN_PUFFER_S`. Eins zu eins, das ist die Kette.
#
# Was der geschluckte Fehler anrichtet: das Lock bleibt liegen, und im Merker steht die PID des
# **noch lebenden** Prozesses — womit `_lebt_laut` "unantastbar" sagt und die Uhr gar nicht
# mehr zum Zug kommt. Der naechste Warter sitzt die volle Frist ab (pip-Lock: 155 s) und
# greift dann erzwungen zu; treffen sich dort zwei, sind beide gleichzeitig im kritischen
# Abschnitt. Das ist #205 — inklusive der 155,07 s, die im Testlauf gemessen wurden.
#
# Der Leser schliesst in Mikrosekunden, ein kurzes Wiederholen genuegt also. Mit diesen Werten
# im selben Prueftstand: **0 von 1500**, keine langen Wartezeiten mehr. Knapp gehalten, weil es
# auf dem Freigabepfad liegt (hoechstens 160 ms, und nur im Fehlerfall).
_RMDIR_VERSUCHE = 8
_RMDIR_PAUSE_S = 0.02


def _prozess_lebt(pid: int):
    """Laeuft dieser Prozess noch? True | False | None (nicht beantwortbar).

    **Auf Windows NICHT ueber `os.kill(pid, 0)`.** Dort sind 0 und 1 `CTRL_C_EVENT` bzw.
    `CTRL_BREAK_EVENT` — `os.kill` ist eine Konsolen-Signal-API und kein Lebendtest; die
    Doku sagt fuer alles ausserhalb der CTRL_*-Werte TerminateProcess zu. Gemessen auf
    3.11.15/3.13.15/3.14.7: `sig 0` liess den Kindprozess laufen, `sig 1` riss die
    aufrufende Shell mit. Eine Pruefung, die ihren Gegenstand beschaedigen KANN, hat an
    dieser Stelle nichts zu suchen — sie liefe gegen den Prozess, der gerade schreibt.
    """
    # Nur plausible PIDs werden beantwortet, und Unplausibles heisst "keine Auskunft", nie
    # "tot": ctypes schneidet den Wert auf c_uint32 ab, statt zu werfen — gemessen ergab
    # `10**25` ein **False** (das Lock waere sofort weggeraeumt worden) und `2**32+7` ein
    # True ueber PID 7. Auf POSIX faengt dieselbe Grenze `os.kill(0, …)` (das traefe die
    # ganze Prozessgruppe) und den OverflowError grosser Zahlen ab.
    if not 0 < pid < 2**31:
        return None
    if os.name == "nt":
        import ctypes
        try:
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.OpenProcess.restype = ctypes.c_void_p     # sonst schneidet ctypes das Handle ab
            k32.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
            k32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
            k32.CloseHandle.argtypes = (ctypes.c_void_p,)
            handle = k32.OpenProcess(0x00100000, False, pid)          # SYNCHRONIZE
            if not handle:
                # 87 = ERROR_INVALID_PARAMETER: diese PID gibt es nicht. Jeder andere Fehler
                # (5 = Zugriff verweigert bei fremdem Nutzer) heisst: es gibt sie.
                return ctypes.get_last_error() != 87
            try:
                return k32.WaitForSingleObject(handle, 0) != 0        # 0 = WAIT_OBJECT_0: aus
            finally:
                k32.CloseHandle(handle)
        except OSError:
            return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                                       # fremder Nutzer -> es gibt ihn
    except OSError:
        return None
    return True


def _merker_lesen(lockdir: str):
    """Der Merker als ROHE Bytes, oder None. Er ist zugleich der Ausweis dieses Locks: nur
    wer denselben Inhalt wiederfindet, darf es wegraeumen (siehe `_wegraeumen`).

    **Der einzige Aufruf in der Warteschleife, der BLOCKIEREN kann**: `mkdir`/`lstat`/`rmdir`
    kehren zurueck, ein `open()` auf einer nicht mehr erreichbaren Netzfreigabe haengt bis zum
    Netz-Timeout (und `TRANSKRIBOR_PROJEKTE` darf dorthin zeigen). Die Obergrenze deckt das
    NICHT — sie wird zwischen den Runden geprueft, nicht innerhalb eines Systemaufrufs. Bewusst
    nicht behoben (ein Timeout um einen Dateizugriff hiesse Faden oder `O_NONBLOCK`), aber
    benannt: die Schleife ist seitdem nicht mehr beweisbar haengerfrei.
    """
    try:
        with open(os.path.join(lockdir, _HALTER), "rb") as f:
            return f.read(200)
    except OSError:
        return None


def _lebt_laut(merker):
    """Lebt der Prozess, den dieser Merker nennt? None = keine Auskunft -> die Frist entscheidet.

    Keine Auskunft heisst hier immer "wie vor #175", nie "ist tot": ein Merker, der fehlt
    (altes Lock, oder der Halter kam zwischen `mkdir` und Schreiben nicht weiter), halb
    geschrieben ist oder von einem ANDEREN Rechner stammt (geteilter Ordner — dort gehoert
    die Zahl hier einem beliebigen fremden Prozess), darf kein Lock abraeumen.
    """
    if merker is None:
        return None
    try:
        pid_text, _, wirt = merker.decode("utf-8").strip().partition(" ")
        pid = int(pid_text)
    except ValueError:                            # UnicodeDecodeError IST einer (#185/#190)
        return None
    # `wirt and`, nicht bloss der Vergleich: `platform.node()` schluckt `OSError` intern und
    # liefert dann `""` — beide Haelften degradierten konsistent, `"" == ""` waere wahr, und
    # auf einem geteilten Ordner beantwortete eine LOKALE PID einen fremden Merker. Sagt sie
    # dann "tot", nimmt der Warter einem Lebenden das Lock weg: genau der Fehler, gegen den
    # das hier gebaut ist, durch eine neue Tuer.
    return _prozess_lebt(pid) if wirt and wirt == platform.node() else None


def _verzeichnis_kennung(pfad: str):
    """`(st_dev, st_ino)` des Verzeichnisses, oder None wenn es dazu keine Auskunft gibt.

    Das ist die Identitaet des Verzeichnisses SELBST — ein gleichnamiger Nachfolger hat eine
    andere. Auf Windows gemessen: nach `rmdir` + `mkdir` am selben Pfad unterscheiden sich die
    Werte (NTFS-Dateiindex). Wo `st_ino` 0 ist (manche Netz-/FAT-Pfade), gibt es keine
    Auskunft — dann gilt wie ueberall hier: nicht raten, sondern den Fall behandeln wie vorher.
    """
    try:
        z = os.lstat(pfad)
    except OSError:
        return None
    return (z.st_dev, z.st_ino) if z.st_ino else None


def _ist_noch(pfad: str, kennung) -> bool:
    """Liegt an `pfad` noch DASSELBE Verzeichnis wie bei `kennung`? Ohne Auskunft: ja (wie bisher)."""
    if kennung is None:
        return True
    return _verzeichnis_kennung(pfad) == kennung


def _wegraeumen(lockdir: str, erwartet) -> None:
    """Lock samt Merker entfernen — aber NUR, wenn es noch dasselbe Lock ist.

    Zwischen der Entscheidung ("der Halter ist tot") und dieser Zeile liegen Systemaufrufe,
    und in dieser Luecke kann ein anderer Warter das Lock laengst abgeraeumt, neu angelegt
    und den kritischen Abschnitt betreten haben. Ohne den Vergleich raeumte man ihm sein
    frisches Lock weg — und sein eigenes `finally` traefe danach einen Dritten: aus der
    Sperre wuerde eine Kaskade. Deshalb ist der Merker-Inhalt der Ausweis, `erwartet=None`
    heisst "es lag keiner da". Der Merker MUSS vor dem `rmdir` weg (nicht leeres
    Verzeichnis) — ein Lock von einem fremden Rechner waere sonst gar nicht mehr raeumbar.
    """
    if _merker_lesen(lockdir) != erwartet:
        return                                    # gehoert inzwischen jemand anderem
    kennung = _verzeichnis_kennung(lockdir)
    merkerpfad = os.path.join(lockdir, _HALTER)
    entfernt = erwartet is None          # kein Merker zu entfernen -> gilt als erledigt
    for versuch in range(_RMDIR_VERSUCHE):
        # Der Ausweis wird bei JEDEM Versuch neu geprueft, nicht nur einmal vorher: die
        # Wiederholung streckt das Fenster von Mikrosekunden auf bis zu 160 ms, und darin kann
        # ein Warter das Lock uebernommen haben (Notgriff) — dann steht an diesem Pfad ein
        # FREMDES Verzeichnis, und die naechste Runde loeschte dessen frisches Lock. Genau die
        # Kaskade, gegen die der Merker da ist. (CodeRabbit-CLI an PR #206, kritisch.)
        #
        # **`st_ino` traegt das auf Windows, auf ext4 NICHT** — gemessen: nach `rmdir`+`mkdir`
        # am selben Pfad ist die Inode dort in **200 von 200** Faellen dieselbe, auf dem
        # Windows-Dateisystem in **0 von 200**. Genau daran ist der erste Anlauf in der
        # Linux-CI umgefallen. Auf POSIX schuetzt stattdessen `entfernt` (siehe unten): dort
        # gelingt das `os.remove` immer, wir fassen den fremden Merker also nicht mehr an, und
        # ohne ihn wegzuraeumen bekommen wir das fremde Verzeichnis nicht leer. Was auf ext4
        # OFFEN bleibt: ein fremdes Lock, dessen Merker noch nicht geschrieben ist — dieses
        # Fenster ist dort nicht erkennbar, und das gehoert hier hingeschrieben statt hinter
        # einem gruenen Test versteckt.
        if versuch and not _ist_noch(lockdir, kennung):
            return
        # Das Entfernen gehoert MIT in die Schleife, nicht nur das `rmdir`: haelt ein Warter den
        # Merker offen, scheitert schon `os.remove`. Auf dieser Maschine gemessen: `os.remove`
        # gibt dann `PermissionError [WinError 32]` (die Datei ist in Benutzung), `os.rmdir`
        # `[WinError 145]`. Nur das `rmdir` zu wiederholen half deshalb NIE — die Datei liegt ja
        # noch da. Erst mit dem Umbau bestand der Windows-Test darunter.
        #
        # `entfernt` ist nicht Buchhaltung, sondern die zweite Haelfte der Wache: ist UNSER
        # Merker einmal weg, wird nicht noch einmal geloescht — ein Merker, der danach an
        # diesem Pfad auftaucht, gehoert einem ANDEREN. Auf POSIX ist das der einzige Schutz
        # (die Inode taugt dort nicht, s. o.): ohne seinen Merker bekommen wir sein
        # Verzeichnis nicht leer, `rmdir` scheitert, wir geben auf — statt ihm sein frisches
        # Lock wegzuraeumen. In WSL gegengeprueft.
        if not entfernt:
            try:
                os.remove(merkerpfad)
                entfernt = True
            except FileNotFoundError:
                entfernt = True          # schon weg — nichts mehr zu tun
            except OSError:
                pass                     # noch offen -> naechste Runde
        try:
            os.rmdir(lockdir)
            return
        except (FileNotFoundError, NotADirectoryError):
            raise            # weg bzw. gar kein Verzeichnis — Wiederholen aendert daran nichts
        except OSError:
            # „Nicht leer" (delete pending) und „Zugriff verweigert" (Handle eines Scanners)
            # sind VORUEBERGEHEND, siehe _RMDIR_VERSUCHE. Beim letzten Versuch durchreichen:
            # der Aufrufer entscheidet, ob er das schluckt.
            if versuch == _RMDIR_VERSUCHE - 1:
                raise
            time.sleep(_RMDIR_PAUSE_S)


@contextlib.contextmanager
def datei(pfad: str, stale: float = STALTES_ALTER):
    """Sperrt `<pfad>.lock`. Der Aufrufer sorgt dafuer, dass das Elternverzeichnis existiert.

    Ein dauerhaft nicht anlegbares Lock (schreibgeschuetzter Ordner) darf den Aufrufer NICHT
    aufhalten: die Sperre schuetzt vor einer Race, sie ist nicht der Zweck des Aufrufs. Dann
    laeuft der Block ungeschuetzt weiter — aber mit einer Zeile im Protokoll, nicht still:
    ein lautlos uebersprungenes Lock ist von einem gehaltenen nicht zu unterscheiden.

    **Die Lebendpruefung schaltet die Uhr nicht ab, sie stellt sie nur hintan** (#175): wer
    sich als lebend meldet, wird nicht angetastet — bis der Warter laenger gewartet hat, als
    ein kritischer Abschnitt ueberhaupt dauern kann. Dann greift er EINMAL erzwungen zu und
    laeuft erst danach ungeschuetzt weiter. Das ist der Preis fuer die wiederverwendete PID:
    ohne diesen Griff koennte ein verwaistes Lock mit einer neu vergebenen PID **dauerhaft**
    jeden Aufruf die volle Frist kosten und ihn danach ungeschuetzt laufen lassen — schlimmer
    als der Fall, den die Pruefung verhindert.
    """
    lockdir = pfad + ".lock"
    mein_merker = None                # was in UNSEREM Lock steht (None = nichts geschrieben)
    gehalten = False
    seit = time.time()
    hakelig_seit = None
    gemeldet = False
    erzwungen = False
    while True:
        try:
            os.mkdir(lockdir)             # atomar auf allen Plattformen -> Lock erworben
            gehalten = True
            # Best effort: scheitert das Schreiben, verhaelt sich das Lock wie vor #175
            # (keine Auskunft -> die Frist entscheidet). Die Sperre darf am Merker nicht
            # haengen, sie ist auch ohne ihn gueltig.
            inhalt = f"{os.getpid()} {platform.node()}".encode("utf-8", "replace")
            with contextlib.suppress(OSError):
                with open(os.path.join(lockdir, _HALTER), "wb") as f:
                    f.write(inhalt)
            # Der Ausweis ist, was WIRKLICH auf der Platte steht — nicht, was wir schreiben
            # wollten. Bricht das Schreiben halb ab (gepuffertes IO meldet einen kurzen
            # Schreibvorgang typisch erst beim Schliessen), laege dort ein Teilinhalt, unser
            # eigenes `finally` erkennte sein Lock nicht wieder und liesse es liegen —
            # gemessen mit einem `close()`, das ENOSPC wirft.
            mein_merker = _merker_lesen(lockdir)
            break
        except FileExistsError:
            hakelig_seit = None
            # Verwaist? (Crash waehrend des kritischen Abschnitts, oder `taskkill /F /T` auf
            # einen Job — dort laeuft kein `finally`.) Dann aufraeumen und erneut versuchen.
            # Ein lebender Halter wird hier nicht weggerissen.
            try:
                zustand = os.lstat(lockdir)
            except OSError:
                zustand = None            # inzwischen weg -> naechster mkdir-Versuch
            if zustand is not None and not stat.S_ISDIR(zustand.st_mode):
                # Am Lock-Pfad liegt eine DATEI (Sync-Client, Backup, Quarantaene) statt
                # unseres Verzeichnisses: `os.mkdir` meldet dauerhaft FileExistsError,
                # `os.rmdir` scheitert mit NotADirectoryError — den schluckte das `except
                # OSError` hier, und die Schleife drehte ENDLOS (#191). Ein Haenger ist
                # schlimmer als eine Ausnahme: kein `except` beim Aufrufer faengt ihn. Der
                # Zustand ist nicht voruebergehend, also ohne _HAKELIG_S-Frist wie "nicht
                # anlegbar" behandeln. Geprueft wird der Typ statt der rmdir-Ausnahme, sonst
                # haenge es bis `stale` (beim pip-Lock 150 s), bevor rmdir ueberhaupt laeuft.
                print(f"[sperre] {lockdir} ist kein Verzeichnis — ungeschuetzt weiter",
                      flush=True)
                break
            if zustand is not None:
                # Ein LEBENDER Halter ist unantastbar (#175): die Frist zaehlt ab dem
                # `mkdir`, nicht ab seiner letzten Regung — geht der Rechner mitten im
                # kritischen Abschnitt schlafen, laeuft die Wanduhr weiter und er nicht.
                # Wer ihm dann das Lock wegnimmt, stellt genau die Race her, gegen die es
                # da ist. Umgekehrt ist ein `taskkill /F /T`-Opfer SOFORT erkennbar und muss
                # seine Frist nicht absitzen (beim pip-Lock 150 s). Nur "keine Auskunft"
                # entscheidet noch die Uhr.
                fremd = _merker_lesen(lockdir)
                lebt = _lebt_laut(fremd)
                if lebt is False or (lebt is None
                                     and time.time() - zustand.st_mtime > stale):
                    with contextlib.suppress(OSError):
                        _wegraeumen(lockdir, fremd)
        except OSError as e:
            # NICHT sofort aufgeben: sonst faellt die Sperre genau unter Konkurrenz aus.
            jetzt = time.time()
            hakelig_seit = hakelig_seit or jetzt
            if jetzt - hakelig_seit > _HAKELIG_S:
                print(f"[sperre] {lockdir} nicht anlegbar ({e}) — ungeschuetzt weiter",
                      flush=True)
                break
        if not gemeldet and time.time() - seit > _LAUT_AB_S:
            gemeldet = True
            print(f"[sperre] warte auf {lockdir} (raeume nach {stale:.0f}s auf, falls "
                  f"verwaist) …", flush=True)
        if time.time() - seit > stale + _AUFGEBEN_PUFFER_S:
            if erzwungen:
                print(f"[sperre] {lockdir} laesst sich nicht uebernehmen — ungeschuetzt "
                      f"weiter", flush=True)
                break
            # Ein Halter, der sich als lebend MELDET und dabei laenger haelt, als ein
            # kritischer Abschnitt dauern sollte (Mikrosekunden bei settings/projekt; der
            # pip-Lauf ist mit `timeout=PIP_TIMEOUT` gedeckelt, 120 s gegen 155 s — der
            # darin verschachtelte settings-Lock aus `_merken()` ist in dieser Rechnung NICHT
            # enthalten, und `subprocess.run`s Nach-Kill-`communicate()` laeuft auf Windows
            # ohne Frist; siehe webtool/CLAUDE.md), ist wahrscheinlicher eine
            # WIEDERVERWENDETE PID als ein langsamer Prozess. Ohne diesen einen erzwungenen
            # Griff kostete so ein Lock danach JEDEN Aufruf dauerhaft diese Frist und liesse
            # ihn anschliessend ungeschuetzt laufen — die Uhr ist der Rueckfall der
            # Lebendpruefung, nicht durch sie abgeschaltet.
            erzwungen = True
            print(f"[sperre] {lockdir} wird uebernommen (der gemeldete Halter haelt laenger, "
                  f"als ein Abschnitt dauern kann) …", flush=True)
            # Der Ausweis ist hier pro forma (der Griff SOLL zugreifen) — er kostet nichts
            # und haelt die eine Zeile ein. Trifft er das Zeitfenster zwischen `mkdir` und
            # Merker eines frischen Halters, raeumt er dessen Lock ab; das ist der Preis des
            # Griffs, nicht ein zweiter Mechanismus.
            with contextlib.suppress(OSError):
                _wegraeumen(lockdir, _merker_lesen(lockdir))
            continue
        time.sleep(0.01)
    try:
        yield
    finally:
        if gehalten:
            # Auch hier zaehlt der Ausweis: wurde uns das Lock zwischendurch weggenommen und
            # neu vergeben, raeumten wir sonst das Lock des NACHFOLGERS ab — der naechste
            # Warter spaziert in dessen kritischen Abschnitt hinein, und dessen `finally`
            # trifft wieder einen anderen. Genau diese Kaskade ist reproduziert worden.
            try:
                _wegraeumen(lockdir, mein_merker)
            except OSError:
                pass
