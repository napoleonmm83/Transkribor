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

600 s sind gemessen statt geraten: die volle Suite braucht auf diesem Rechner **80 s**
(1419 Tests, mit den Unterprozess-Tests dieses PR — vorher 48 s bei 1395), der langsamste
CI-Job 134 s. Das ist ~7,5x Reserve nach unten und die Haelfte der Job-Grenze nach oben.
(Hier stand zuerst die 48 aus `pyproject.toml` — eine Zahl, die im SELBEN Diff veraltet
ist, weil dieser Diff sie erhoeht.)

## Grenzen, benannt statt verschwiegen

* Gegen einen VERLORENEN Laeufer hilft das hier nichts — genau das war der Vorfall aus
  #576 ("The hosted runner lost communication with the server"). Diese Datei deckt die
  Nachbarklasse ab, nicht den dokumentierten Vorfall.
* **Ein Haenger, der die GIL HAELT, ist fuer diesen Deckel unsichtbar** — und das ist die
  wichtigste Grenze, weil sie genau die Faelle trifft, fuer die er gebaut ist. `zuschlagen`
  ist Python-Code in einem `threading.Timer` und braucht die GIL; pytests
  `dump_traceback_later` ist ein C-Faden, der ohne sie auskommt. Gemessen (gegnerisches
  Review) an `re.match(r"(a+)+$", "a" * 34 + "b")` — Regex-Rueckverfolgung gibt die GIL
  nicht frei: mit Deckel (Frist 2 s) laeuft der Prozess in den aeusseren Abbruch nach 25 s
  ohne jede Ausgabe, mit pytests Riegel allein endet er nach 2,2 s mit Abzug. `time.sleep`,
  Sperren und Ein-/Ausgabe geben die GIL frei und sind gedeckt; C-Erweiterungen ohne
  Freigabe und Regex-Rueckverfolgung nicht. In den drei Luecken oben faengt so einen
  Haenger deshalb nur die Job-Grenze, ohne Diagnose. Wer das schliessen will, stellt in
  einem aeusseren `pytest_runtest_protocol`-Wrapper NACH pytests Abbestellung erneut
  `dump_traceback_later(rest, exit=True)` — eigener Zuschnitt, eigener Test.
* **Am Haltepunkt wird abbestellt** (`pytest_enter_pdb`), sonst erschiesst der Deckel jede
  laengere Fehlersuche. Danach bleibt er fuer diesen Lauf aus.
* Der Abzug geht auf den beim Start duplizierten stderr-Deskriptor, nicht auf
  `sys.stderr`: unter `--capture=fd` ist Deskriptor 2 waehrend der Tests umgelenkt.
  Denselben Griff macht pytests eigenes faulthandler-Plugin an derselben Stelle.
* `os._exit` umgeht `atexit` und jedes Aufraeumen. Das ist Absicht: ein Prozess, der
  gerade nachweislich haengt, soll nicht noch durch Abbau-Code laufen, der ebenfalls
  haengen kann.
* **Der Zeitgeber wird im normalen Sitzungsablauf nicht abbestellt** (die einzige Ausnahme
  ist der Haltepunkt weiter unten), **und das ist die unangenehmste Grenze hier.** Er muss
  die pytest-Sitzung ueberleben — sonst faellt Fall 3 wieder aus, denn der Haenger nach dem
  letzten Test liegt hinter `pytest_unconfigure`. Die Kehrseite: ein WIRT, der
  `pytest.main()` im eigenen Prozess ruft und danach weiterlebt, wird `frist` Sekunden
  nach dem ERSTEN Aufruf mit `os._exit(99)` beendet — egal, was er dann gerade tut.
  Gemessen (Kalt-Review, Frist 3 s): ein Wirt mit zwei `pytest.main()`-Sitzungen und
  anschliessendem `sleep` endet mit rc 99 und dem Stapelabzug seines eigenen `sleep`.
  Der konkrete Konsument in diesem Repo ist **mutmut** (`[tool.mutmut]` in
  `pyproject.toml`; `mutmut/__main__.py:445` ruft `pytest.main()` im Elternprozess, der
  die ganze Serie lebt). **Wer pytest in-process einbettet, setzt
  `TRANSKRIBOR_TESTDECKEL=0`** — das ist der Zweck dieses Schalters, nicht bloss eine
  Testhilfe. Verworfen wurde, die Bewaffnung an einer Erkennung des Wirts festzumachen
  (`sys.argv[0]`, `__main__`): das tauscht eine benannte Grenze gegen eine stille
  Fehlklassifikation, und ein Deckel, der sich selbst nicht bewaffnet, ist genau der
  Ausfall, gegen den diese Datei geschrieben ist.
"""
import faulthandler
import math
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
#: einem dieser Ausgaenge verwechseln. **Vor allem muss er ungleich 0 sein**, und dafuer
#: gibt es einen eigenen Waechter: die Tests vergleichen `rc` gegen genau diese Konstante,
#: waeren mit `DECKEL_RC = 0` also alle gruen — bei einem Lauf, der auf einen Haenger mit
#: einem gruenen Haken antwortet. Genau die Fehlerklasse, gegen die diese Datei gebaut
#: ist, im eigenen Pruefstand (gemessen im gegnerischen Review: 7 von 7 Tests ueberlebten
#: `DECKEL_RC = 0`).
DECKEL_RC = 99

#: Damit ein Waechter die AKTIVE Konfiguration fragen kann statt den Dateiinhalt. Eine
#: Datei zu lesen bewiese nur, dass dort etwas steht — nicht, dass es auch scharf ist.
deckel_key = pytest.StashKey[float]()
#: Der laufende Waechter, damit `pytest_enter_pdb` ihn abbestellen kann.
wache_key = pytest.StashKey[threading.Timer]()


def _frist() -> float:
    roh = os.environ.get(_DECKEL_ENV)
    if roh is None:
        return _DECKEL_VORGABE
    try:
        frist = float(roh)
    except ValueError as fehl:
        # Laut statt still: ein unlesbarer Wert darf nicht auf die Vorgabe zurueckfallen,
        # sonst laeuft jemand mit einem Deckel, den er abgeschaltet zu haben glaubt.
        raise pytest.UsageError(f"{_DECKEL_ENV}={roh!r} ist keine Zahl") from fehl

    # `float()` allein reicht NICHT, und die drei Faelle sind gemessen (Kalt-Review):
    #   `inf`, `1e12`  -> bestehen float() und `<= 0`, der Timer-Faden stirbt dann still
    #                     mit `OverflowError: timestamp out of range for C PyTime_t`.
    #                     Der Deckel ist inert, der Stash traegt eine truthy Zahl, und der
    #                     Waechtertest haelt ihn fuer scharf.
    #   `nan`          -> feuert SOFORT (jeder Vergleich mit nan ist falsch, auch `<= 0`):
    #                     rc 99 nach 0,2 s mit der Meldung "steht seit nans".
    # Beides ist genau das stille Versagen, gegen das die Zeile darueber argumentiert.
    # Eine NEGATIVE Frist ist derselbe Fall noch einmal: `-1` ist endlich und klein genug,
    # laeuft unten in `frist <= 0` und schaltet den Deckel ab — waehrend zum Abschalten
    # ausdruecklich die `0` reserviert ist. Wer sich vertippt, laeuft also ohne Deckel und
    # haelt ihn fuer scharf (CodeRabbit-Bot).
    if frist < 0 or not math.isfinite(frist) or frist > threading.TIMEOUT_MAX:
        raise pytest.UsageError(
            f"{_DECKEL_ENV}={roh!r} ist keine brauchbare Frist "
            f"(0 zum Abschalten, sonst endlich und hoechstens {threading.TIMEOUT_MAX:.0f}s)"
        )
    return frist


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
        # `finally`, weil der Waechter sonst ausgerechnet dann versagt, wenn seine
        # Diagnose nicht ankommt: ist der Leser des stderr-Rohrs weg (`pytest 2>&1 | head`,
        # ein Elternprozess, der stderr zumacht), wirft `os.write` — der Timer-Faden stirbt
        # an der Ausnahme, `os._exit` wird nie erreicht, und der Prozess haengt genau so
        # weiter wie ohne Deckel. Gemessen im Kalt-Review: Kind lebt nach 12 s trotz
        # Frist 2 s. Das BEENDEN ist die tragende Haelfte, der Abzug die Kuer.
        try:
            os.write(fd, f"\n[testdeckel] Der Lauf steht seit {frist:.0f}s. Abzug aller "
                         f"Faeden, danach Abbruch mit {DECKEL_RC}.\n".encode())
            faulthandler.dump_traceback(file=fd, all_threads=True)
        finally:
            os._exit(DECKEL_RC)

    wache = threading.Timer(frist, zuschlagen)
    wache.daemon = True
    wache.start()
    config.stash[wache_key] = wache


def pytest_enter_pdb(config: pytest.Config) -> None:
    """Am Haltepunkt wird abbestellt — sonst erschiesst der Deckel die Fehlersuche.

    pytests eigenes faulthandler-Plugin tut genau das (`pytest_enter_pdb`, dort seit
    jeher); dieser Deckel tat es nicht, und damit hat der Fix etwas NEUES kaputtgemacht:
    wer laenger als die Frist an einem Haltepunkt steht — oder `--pdb` bei einem roten
    Test benutzt —, verliert den Prozess mit rc 99 und Stapelabzug. Gemessen im
    gegnerischen Review (Frist 2 s, Test mit `breakpoint()`, stdin offen): rc 99 nach
    2,2 s, waehrend derselbe Lauf mit pytests Riegel allein am Haltepunkt stehenbleibt.

    Bewusst OHNE `pytest_leave_pdb`: nach einer Fehlersuche ist der Deckel fuer den Rest
    des Laufs aus. Das ist die laxere Richtung, und sie ist die richtige — ein Lauf unter
    dem Debugger ist ohnehin keiner, dessen Laufzeit etwas bedeutet.
    """
    wache = config.stash.get(wache_key, None)
    if wache is not None:
        wache.cancel()
