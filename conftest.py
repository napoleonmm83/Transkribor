"""Ein Deckel fuer den GANZEN Testlauf — mit Stapelabzug statt bloss mit Abbruch (#584).

`pyproject.toml` deckelt jeden EINZELNEN Test (`faulthandler_timeout = 300`), und das
faengt den haeufigsten Fall. Es hat aber drei blinde Flecken, alle gemessen (Kalt-Review
zu PR #585, danach hier unabhaengig nachgestellt — Schwelle je 2 s, `timeout 20` aussen):

    Haenger IM Testkoerper                       rc 1    Abzug, Test benannt   -> greift
    Roter Test, danach haengender Fixture-Abbau  rc 124  kein Abzug            -> greift NICHT
    Haenger NACH dem letzten Test                rc 124  vorher "1 passed"     -> greift NICHT

Die Ursache steht in `_pytest/faulthandler.py` und ist keine Vermutung: der Zeitgeber
wird in `pytest_runtest_protocol` je Item gestellt, `pytest_exception_interact` bestellt
ihn bei einem roten Test ab, und das `finally` desselben Protokolls bestellt ihn nach
jedem Item ab. Nach einem roten Test laeuft der Abbau also ungeschuetzt, und nach dem
letzten Item wacht gar nichts mehr. Der dritte Fall ist der teuerste: **das Protokoll
behauptet Erfolg, waehrend der Prozess steht** — wer nur die Zusammenfassungszeile liest,
haelt den Lauf fuer durch. Genau die Fehlerklasse, gegen die der Riegel gebaut wurde, nur
eine Ebene hoeher.

Auch die dritte Luecke aus dem `pyproject.toml`-Block liegt hier: Sammeln und
Fixtures auf SITZUNGSebene liegen vor dem ersten Item, also ausserhalb jedes
Test-Zeitgebers.

## Warum ein eigener Faden und nicht `faulthandler.dump_traceback_later`

Weil es davon nur EINEN gibt. `dump_traceback_later` ist ein globaler Zeitgeber, und
pytest stellt ihn je Test neu — ein hier gestellter waere ab dem ersten Test weg. Ein
eigener `threading.Timer` steht daneben und wird von pytest nicht angefasst.

Der Faden ist ein **Daemon**, und wofuer das tragend ist, wurde von der Mutationsprobe
korrigiert — die naheliegende Begruendung ist FALSCH. `daemon = False` gemessen, Frist
10 s, gegen zwei Laeufe:

    gesunder Lauf   daemon=True  rc 0, 0 s      daemon=False  rc 99 nach 10 s
    Fall 3          daemon=True  rc 99, 11 s    daemon=False  rc 99 nach 10 s

Fuer Fall 3 macht es also KEINEN Unterschied: ein Zeitgeber-Faden laeuft, ob daemonisch
oder nicht, und `os._exit` beendet den Prozess so oder so. Tragend ist der Daemon fuer den
GESUNDEN Lauf — `threading._shutdown()` wartet beim Beenden auf jeden nicht-daemonischen
Faden, also auch auf den Waechter, der noch 599 Sekunden vor sich hat. Ohne `daemon = True`
stirbt damit JEDER gruene Lauf am eigenen Riegel, nach voller Frist und mit rc 99.
`test_ein_armierter_deckel_stoert_den_gesunden_lauf_nicht` haelt genau das fest.

## Die Schichtung, und warum es drei Stufen sind

    300 s  je TEST     pyproject.toml, faulthandler   Abzug, Test benannt
    600 s  je LAUF     diese Datei                    Abzug ALLER Faeden
   1200 s  je JOB      .github/workflows/test.yml     Abbruch ohne Diagnose

Jede Stufe faengt, was die darunter nicht sieht; nur die unteren beiden sagen, WO es
klemmt. Die Reihenfolge ist Pflicht, nicht Geschmack — laege der Lauf-Deckel ueber der
Job-Grenze, beendete GitHub den Job, bevor der Abzug geschrieben ist, und der Riegel
waere still wirkungslos. `scripts/test_pytest_riegel.py` haelt beide Abstaende fest.

600 s sind gemessen statt geraten: die volle Suite braucht 48 s auf diesem Rechner, der
langsamste CI-Job 134 s. Das ist ~12x Reserve nach unten und die Haelfte der Job-Grenze
nach oben.

## Grenzen, benannt statt verschwiegen

* Gegen einen VERLORENEN Laeufer hilft das hier nichts — genau das war der Vorfall aus
  #576 ("The hosted runner lost communication with the server"). Diese Datei deckt die
  Nachbarklasse ab, nicht den dokumentierten Vorfall.
* Der Abzug geht auf den beim Start duplizierten stderr-Deskriptor, nicht auf
  `sys.stderr`: unter `--capture=fd` ist Deskriptor 2 waehrend der Tests umgelenkt.
  Denselben Griff macht pytests eigenes faulthandler-Plugin an derselben Stelle.
* `os._exit` umgeht `atexit` und jedes Aufraeumen. Das ist Absicht: ein Prozess, der
  gerade nachweislich haengt, soll nicht noch durch Abbau-Code laufen, der ebenfalls
  haengen kann.
"""
import faulthandler
import os
import threading

import pytest

#: Wieviele Sekunden der GANZE Lauf stehen darf. `0` schaltet den Deckel ab.
#: Der Schalter ist kein Beiwerk: `scripts/test_testdeckel.py` faehrt die drei Faelle
#: oben mit 2 s nach, und ohne ihn waere der Riegel nur behauptet.
_DECKEL_ENV = "TRANSKRIBOR_TESTDECKEL"
_DECKEL_VORGABE = 600.0

#: Ausserhalb von pytests belegtem Bereich 0-5 (OK, Tests rot, unterbrochen, interner
#: Fehler, Nutzungsfehler, nichts gesammelt) — ein eigener Code laesst sich nicht mit
#: einem dieser Ausgaenge verwechseln.
DECKEL_RC = 99

#: Damit ein Waechter die AKTIVE Konfiguration fragen kann statt den Dateiinhalt. Eine
#: Datei zu lesen bewiese nur, dass dort etwas steht — nicht, dass es auch scharf ist.
deckel_key = pytest.StashKey[float]()


def _frist() -> float:
    roh = os.environ.get(_DECKEL_ENV)
    if roh is None:
        return _DECKEL_VORGABE
    try:
        return float(roh)
    except ValueError as fehl:
        # Laut statt still: ein unlesbarer Wert darf nicht auf die Vorgabe zurueckfallen,
        # sonst laeuft jemand mit einem Deckel, den er abgeschaltet zu haben glaubt.
        raise pytest.UsageError(f"{_DECKEL_ENV}={roh!r} ist keine Zahl") from fehl


def pytest_configure(config: pytest.Config) -> None:
    frist = _frist()
    config.stash[deckel_key] = frist
    if frist <= 0:
        return

    # Dupliziert JETZT, weil die globale Ausgabe-Umlenkung waehrend `pytest_configure`
    # ausgesetzt ist — Deskriptor 2 zeigt hier noch auf das echte stderr. Bleibt bis zum
    # Prozessende offen; dasselbe tut pytests faulthandler-Plugin mit seiner Kopie.
    fd = os.dup(2)

    def zuschlagen() -> None:
        os.write(fd, f"\n[testdeckel] Der Lauf steht seit {frist:.0f}s. Abzug aller "
                     f"Faeden, danach Abbruch mit {DECKEL_RC}.\n".encode())
        faulthandler.dump_traceback(file=fd, all_threads=True)
        os._exit(DECKEL_RC)

    wache = threading.Timer(frist, zuschlagen)
    wache.daemon = True
    wache.start()
