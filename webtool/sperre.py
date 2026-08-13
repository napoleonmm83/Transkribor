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


@contextlib.contextmanager
def datei(pfad: str, stale: float = STALTES_ALTER):
    """Sperrt `<pfad>.lock`. Der Aufrufer sorgt dafuer, dass das Elternverzeichnis existiert.

    Ein nicht anlegbares Lock (schreibgeschuetzter Ordner) darf den Aufrufer NICHT
    aufhalten: die Sperre schuetzt vor einer Race, sie ist nicht der Zweck des Aufrufs.
    Dann laeuft der Block eben ungeschuetzt — so wie vor dieser Datei auch.
    """
    lockdir = pfad + ".lock"
    gehalten = False
    while True:
        try:
            os.mkdir(lockdir)             # atomar auf allen Plattformen -> Lock erworben
            gehalten = True
            break
        except FileExistsError:
            # Verwaist? (Crash waehrend des kritischen Abschnitts.) Dann aufraeumen und
            # erneut versuchen. Ein lebender Halter wird hier nicht weggerissen.
            try:
                if time.time() - os.stat(lockdir).st_mtime > stale:
                    os.rmdir(lockdir)
            except OSError:
                pass
            time.sleep(0.01)
        except OSError:
            break                          # kein Lock moeglich -> ungeschuetzt weiter
    try:
        yield
    finally:
        if gehalten:
            try:
                os.rmdir(lockdir)
            except OSError:
                pass
