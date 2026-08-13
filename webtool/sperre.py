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
import time

# Ab wann ein liegengebliebenes Lock als verwaist gilt (Prozess im kritischen Abschnitt
# abgestorben). Die RMW-Sequenz selbst dauert Mikrosekunden — wer hier landet, ist eine
# Crash-Hinterlassenschaft.
STALTES_ALTER = 60.0


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


@contextlib.contextmanager
def datei(pfad: str, stale: float = STALTES_ALTER):
    """Sperrt `<pfad>.lock`. Der Aufrufer sorgt dafuer, dass das Elternverzeichnis existiert.

    Ein dauerhaft nicht anlegbares Lock (schreibgeschuetzter Ordner) darf den Aufrufer NICHT
    aufhalten: die Sperre schuetzt vor einer Race, sie ist nicht der Zweck des Aufrufs. Dann
    laeuft der Block ungeschuetzt weiter — aber mit einer Zeile im Protokoll, nicht still:
    ein lautlos uebersprungenes Lock ist von einem gehaltenen nicht zu unterscheiden.
    """
    lockdir = pfad + ".lock"
    gehalten = False
    seit = time.time()
    hakelig_seit = None
    gemeldet = False
    while True:
        try:
            os.mkdir(lockdir)             # atomar auf allen Plattformen -> Lock erworben
            gehalten = True
            break
        except FileExistsError:
            hakelig_seit = None
            # Verwaist? (Crash waehrend des kritischen Abschnitts, oder `taskkill /F /T` auf
            # einen Job — dort laeuft kein `finally`.) Dann aufraeumen und erneut versuchen.
            # Ein lebender Halter wird hier nicht weggerissen.
            try:
                if time.time() - os.stat(lockdir).st_mtime > stale:
                    os.rmdir(lockdir)
            except OSError:
                pass
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
        time.sleep(0.01)
    try:
        yield
    finally:
        if gehalten:
            try:
                os.rmdir(lockdir)
            except OSError:
                pass
