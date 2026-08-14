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
# meldet, wird nach seinem Zustand behandelt, nicht nach der Uhr: siehe `_halter_lebt`.
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


def _halter_lebt(lockdir: str):
    """Lebt der Prozess, der dieses Lock haelt? None = keine Auskunft -> die Frist entscheidet.

    Keine Auskunft heisst hier immer "wie vor #175", nie "ist tot": ein Merker, der fehlt
    (altes Lock, oder der Halter kam zwischen `mkdir` und Schreiben nicht weiter), halb
    geschrieben ist oder von einem ANDEREN Rechner stammt (geteilter Ordner — dort gehoert
    die Zahl hier einem beliebigen fremden Prozess), darf kein Lock abraeumen.
    """
    try:
        with open(os.path.join(lockdir, _HALTER), encoding="utf-8") as f:
            pid_text, _, wirt = f.read(200).strip().partition(" ")
        pid = int(pid_text)
    except (OSError, ValueError):
        return None
    return _prozess_lebt(pid) if wirt == platform.node() else None


def _wegraeumen(lockdir: str) -> None:
    """Lock samt Merker entfernen. Der Merker MUSS zuerst weg — sonst scheitert `os.rmdir`
    an einem nicht leeren Verzeichnis, und das Lock waere gar nicht mehr abzuraeumen."""
    with contextlib.suppress(OSError):
        os.remove(os.path.join(lockdir, _HALTER))
    os.rmdir(lockdir)


@contextlib.contextmanager
def datei(pfad: str, stale: float = STALTES_ALTER):
    """Sperrt `<pfad>.lock`. Der Aufrufer sorgt dafuer, dass das Elternverzeichnis existiert.

    Ein dauerhaft nicht anlegbares Lock (schreibgeschuetzter Ordner) darf den Aufrufer NICHT
    aufhalten: die Sperre schuetzt vor einer Race, sie ist nicht der Zweck des Aufrufs. Dann
    laeuft der Block ungeschuetzt weiter — aber mit einer Zeile im Protokoll, nicht still:
    ein lautlos uebersprungenes Lock ist von einem gehaltenen nicht zu unterscheiden.

    **Was #175 NICHT aufhebt:** haelt ein nachweislich lebender Halter laenger als
    `stale + _AUFGEBEN_PUFFER_S` durch, laeuft der Warter ebenfalls ungeschuetzt weiter — er
    nimmt ihm das Lock nur nicht mehr weg (kein Kaskadeneffekt: der Halter raeumt danach sein
    eigenes Verzeichnis ab, nicht das eines Dritten). Auf die Obergrenze zu verzichten hiesse,
    auf eine wiederverwendete PID unbegrenzt zu warten, und ein Haenger ist schlimmer als eine
    ungeschuetzte Sequenz (#191) — erst recht auf dem Request-Pfad (`settings.save`).
    """
    lockdir = pfad + ".lock"
    merker = os.path.join(lockdir, _HALTER)
    gehalten = False
    seit = time.time()
    hakelig_seit = None
    gemeldet = False
    while True:
        try:
            os.mkdir(lockdir)             # atomar auf allen Plattformen -> Lock erworben
            gehalten = True
            # Best effort: scheitert das Schreiben, verhaelt sich das Lock wie vor #175
            # (keine Auskunft -> die Frist entscheidet). Die Sperre darf am Merker nicht
            # haengen, sie ist auch ohne ihn gueltig.
            with contextlib.suppress(OSError):
                with open(merker, "w", encoding="utf-8") as f:
                    f.write(f"{os.getpid()} {platform.node()}")
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
                lebt = _halter_lebt(lockdir)
                if lebt is False or (lebt is None
                                     and time.time() - zustand.st_mtime > stale):
                    with contextlib.suppress(OSError):
                        _wegraeumen(lockdir)
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
            print(f"[sperre] {lockdir} laesst sich nicht uebernehmen — ungeschuetzt weiter",
                  flush=True)
            break
        time.sleep(0.01)
    try:
        yield
    finally:
        if gehalten:
            try:
                _wegraeumen(lockdir)
            except OSError:
                pass
