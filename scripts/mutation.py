#!/usr/bin/env python3
"""Mutationsprobe fahren, ohne dabei Arbeit zu verlieren oder blind zu messen.

Eine Mutationsprobe ist in diesem Repo Pflicht: Logik raus -> genau dieser Test rot. Der
Aufbau dafuer wurde bisher je Lauf neu getippt (Issue #551), und dabei sind VIER Fallen
wiederholt zugeschlagen. Jede davon sieht von aussen aus wie ein Ergebnis, nicht wie ein
Defekt:

1. DIE RUECKNAHME LOESCHT FREMDE ARBEIT. Der Vorlaeufer dieses Skripts nahm die Mutation mit
   `git checkout -- <datei>` zurueck. Das spielt auf HEAD zurueck und unterscheidet nicht,
   WESSEN Arbeit im Arbeitsbaum steht. Am 2026-09-04 loeschte ein Review-Subagent damit drei
   uncommittete Aenderungen der HAUPTsitzung. Der Vorlaeufer hatte dagegen einen Riegel — er
   verweigert den Start auf schmutzigem Baum —, und der greift hier zu kurz: er prueft EINMAL,
   am Anfang. Eine parallel laufende Sitzung schreibt WAEHREND der Serie, und was es beim
   Start nicht gab, kann kein Startriegel sehen.
   -> Zurueckgespielt werden die ORIGINALBYTES aus dem Speicher, und zwar NUR, wenn in der
      Datei noch unsere Mutation steht. Es beruehrt ausserdem den DESTRUCTIVE-Guardrail nicht
      (Marcus' Entscheidung 2026-09-04).

      **Die Grenze gehoert dazu, und die erste Fassung dieses Absatzes hat sie falsch
      gezogen.** Sie behauptete, die Speicher-Ruecknahme koenne fremde Arbeit „per
      Konstruktion nicht erreichen". Das stimmt fuer JEDE ANDERE Datei — aber nicht fuer die
      eine, die gerade mutiert ist: wer waehrend des Testlaufs genau dort hineinschreibt,
      verlor seine Zeile beim Zurueckspielen, und der Lauf meldete dazu „Arbeitsbaum sauber".
      Gemessen vom gegnerischen Pruefer, nicht erdacht. Deshalb der Vergleich vor der
      Ruecknahme: steht dort etwas anderes, bleibt die Datei unangetastet und der Lauf sagt
      es. Was bleibt, ist die eigentliche Verbesserung gegenueber `git checkout`: der fasste
      Dateien an, die mit dieser Mutation nichts zu tun hatten.

2. ZEILENENDEN. Der Arbeitsbaum steht auf Windows haeufig auf CRLF. Ein mehrzeiliger Anker mit
   `\\n` findet dann NICHTS — und ein nicht gefundener Anker ist von "die Stelle gibt es nicht"
   nicht zu unterscheiden. -> Anker werden an die Zeilenenden der Datei angepasst, und ein
   Anker, der nicht GENAU EINMAL passt, bricht ab (`mutationsanker-muss-eindeutig-sein`).
   Gelesen wird in BYTES und selbst dekodiert, nicht ueber `read_text`: dessen Voreinstellung
   uebersetzt `\\r\\n` still zu `\\n`, und dann schreibt die Ruecknahme eine Datei zurueck, die
   `git status` als geaendert und `git diff` als unveraendert meldet.

3. ESCAPTE TESTNAMEN. TAP escapet `#` in Testnamen zu `\\#` (gemessen: `not ok 101 - … (\\#448)`).
   Ein Abgleich auf den rohen Namen findet die rote Zeile nie und meldet "Mutation wirkungslos".
   Das ist die Fehlerklasse `escaping-ueber-schichten`. -> Die Ausgabe wird entescapet, bevor
   irgendetwas darin gesucht wird.

4. ALTER BYTECODE. Python invalidiert eine `.pyc` an (mtime in ganzen Sekunden, Dateigroesse).
   Eine Mutation, die einen Block nur verschiebt, laesst die Groesse gleich — wird sie in
   derselben Sekunde zurueckgespielt, gilt der Bytecode der MUTIERTEN Datei weiter. Gemessen an
   PR #180: `git diff` leer, Test trotzdem rot, eine halbe Stunde Suche. Die Gegenrichtung ist
   schlimmer: ein echter Fehler bleibt hinter gueltig aussehendem Altbytecode gruen.
   -> Nach jeder Ruecknahme werden die `__pycache__`-Ordner unter `--pfad` geleert.

5. ANSI-FARBE. Die drei Proben unten lesen die Ausgabe als Text. Ist sie gefaerbt — in der CI
   ist sie das, lokal meist nicht —, scheitern zwei von ihnen an den Steuerzeichen, und der
   Lauf meldet "NULL Tests" ueber eine Suite, die 126 Tests gefahren hat (T-070, vier CI-
   Laeufe). -> Die Ausgabe wird in `_lauf` EINMAL entfaerbt, bevor sie irgendwer ansieht.

Aufruf:

    python scripts/mutation.py --repo . --plan scripts/mutationen/mypy_riegel.json --pfad scripts/

Der Plan ist ein JSON-OBJEKT und traegt sein Kommando selbst:

    {"test": "python -m pytest scripts/test_mypy_riegel.py -q",
     "pfade": ["scripts/mypy_riegel.py", "scripts/test_mypy_riegel.py"],
     "env": {"TRANSKRIBOR_TESTDECKEL": "0"},
     "mutationen": [ … ]}

`pfade` sagt, welche Aenderungen diesen Plan betreffen (der Laeufer waehlt danach aus),
`env` seine Zusatzumgebung. Eine blanke JSON-Liste bleibt zulaessig — dann kommen Kommando
und Umgebung ueber `--test` und `--env` von aussen; das ist der Ad-hoc-Plan von Hand.
Der Waechter `scripts/test_mutationsplaene.py` verlangt fuer alles unter
`scripts/mutationen/` die Objektform.

`rot` sind Testnamen, die die Mutation rot machen MUSS, `gruen` optional solche, die gruen
bleiben muessen (die Gegenprobe — ohne sie belegt eine rote Suite nur, dass IRGENDETWAS
kaputtging).

Exit 0 nur, wenn JEDE Mutation ihre erwarteten Tests rot bekam, keine Gegenprobe gefallen ist,
jede Datei danach BYTEGLEICH zum Ausgangsstand ist UND der Arbeitsbaum sauber ist.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

# ANSI-Steuerfolgen (CSI). Sie muessen WEG, bevor irgendeine der drei Proben unten die
# Ausgabe ansieht — und das ist kein Feinschliff, sondern die Ursache von T-070:
#
# GEMESSEN (2026-09-08, an genau diesen drei Funktionen):
#     Zeile "\x1b[32m126 passed\x1b[39m"
#       _sah_einen_testlauf        -> True   (der Teilstring " passed" steht ja da)
#       _lief_mindestens_ein_test  -> False  (`\b` scheitert: links der 1 steht ein `m`)
#       _ist_fehlzeile             -> False  (`lstrip()` entfernt kein ESC)
# Genau diese Kombination ergibt „gelaufen, aber NULL Tests" — der Abbruch, den die
# Frontend-Serie in der CI VIER Mal meldete (Laeufe 34179774574, 34180726821, 34181093282,
# 34181500162), waehrend derselbe Befehl als eigener Workflow-Schritt 126 Tests fand.
# Lokal fiel es nie auf, weil dort keine Farbe entsteht.
#
# Die gefaehrlichere Haelfte gehoert dazu: haette nur `_ist_fehlzeile` gebrochen, waere die
# Serie NICHT abgebrochen — sie haette jede Mutation als „wirkungslos" gemeldet, ueber eine
# Messung, die nie stattgefunden hat. Dass es auffiel, verdankt sich allein dem
# Anti-Schweigen-Riegel.
_ANSI = re.compile(r"\x1b\[[0-9;:?]*[ -/]*[@-~]")


def ohne_farbe(text: str) -> str:
    """Entfernt ANSI-CSI-Folgen. Eigene Funktion, damit ein Test sie ohne Subprozess prueft."""
    return _ANSI.sub("", text)


# Wie die drei hier benutzten Laeufer eine rote Zeile schreiben. Bewusst eine kurze Liste:
# was hier fehlt, faellt als "Mutation wirkungslos" auf und wird ergaenzt — ein zu breites
# Muster dagegen wuerde eine gruene Suite als rot lesen und die Probe wertlos machen.
def _ist_fehlzeile(z: str) -> bool:
    s = z.lstrip()
    return (z.startswith("not ok ")          # node:test, TAP-Reporter
            or s.startswith("FAILED ")       # pytest
            or s.startswith("×")             # vitest, U+00D7
            or s.startswith("✖"))            # node:test, Spec-Reporter, U+2716


# Woran man erkennt, dass ueberhaupt eine Testsuite gelaufen ist — unabhaengig davon, ob sie
# gruen oder rot war. Ohne diese Probe ist ein Testkommando, das gar nicht STARTET, von einer
# Mutation ohne Wirkung nicht zu unterscheiden: beide liefern null rote Zeilen.
# Gemessen am 2026-09-05, und es hat genau hier zugeschlagen: `shell=True` startet auf Windows
# cmd.exe, und cmd.exe kennt kein `./` — das Kommando `./.venv/Scripts/python.exe -m pytest …`
# endete mit rc 1, leerem stdout und `Der Befehl "." ist … nicht gefunden`. Der Treiber meldete
# daraufhin dreimal „Mutation wirkungslos", obwohl nichts gemessen worden war. Dieselbe Klasse
# wie ein fehlendes ruff (rc 1 + leeres stdout = wie „Befunde") — wer einen Riegel baut, baut
# zuerst den Riegel gegen dessen eigenes Schweigen.
#
# `# tests ` und `ℹ tests ` sind die Bilanzzeilen von node:test in seinen ZWEI Formen: der
# TAP-Reporter schreibt `# tests 2 / # pass 1 / # fail 1`, der Spec-Reporter dieselben Zahlen
# mit `ℹ`. Beide stehen hier, weil node die Voreinstellung zwischen Fassungen verschoben hat
# und dieses Werkzeug auf beiden laufen muss. GEMESSEN habe ich nur die TAP-Form (node
# v22.23.2, lokal und durch scripts/testlauf.mjs); die Spec-Form ist ein Reviewbefund von
# node 24.20.0 — der Fassung, die `setup-node` in der CI laedt — und hier NICHT nachgestellt,
# weil diese Maschine kein node 24 hat. Beide Formen zu tragen kostet nichts; sich auf eine
# zu verlassen kostete ein falsches Rot auf genau dem Kommando, das der Docstring nennt.
_LAUFMARKEN = (" passed", " failed", "no tests ran", "Tests ", "1..", "# tests ", "ℹ tests ")


def _sah_einen_testlauf(ausgabe: str) -> bool:
    if any(marke in ausgabe for marke in _LAUFMARKEN):
        return True
    return any(z.startswith(("ok ", "not ok ")) for z in ausgabe.splitlines())


# Zweite, SCHAERFERE Frage — und sie ist nicht dieselbe wie die erste: `no tests ran` IST
# eine Testausgabe (`_sah_einen_testlauf` sagt zu Recht ja), aber es sind null Tests
# gelaufen. Ein Tippfehler im Testpfad oder ein `-k` ohne Treffer kommt so durch die
# Positivkontrolle, und danach meldet jede Mutation "NICHT rot geworden" mit einem Hinweis,
# der in die falsche Richtung zeigt — die eine wahre Ursache steht nirgends.
# Gefunden vom kalten Diff-Review, mit Reproduktion.
# Die node-Zweige tragen `[1-9]` aus demselben Grund wie der pytest-Zweig: `# pass 0` neben
# `# fail 0` heisst NULL Tests, und genau das soll hier nicht als Lauf gelten.
_MINDESTENS_EIN_TEST = re.compile(
    r"\b[1-9]\d* (passed|failed)\b"     # pytest, vitest
    r"|^(not )?ok [1-9]"                # TAP, einzelne Testzeile
    r"|^[#ℹ] (pass|fail) [1-9]",   # node:test, Bilanz beider Reporter
    re.M)


def _lief_mindestens_ein_test(ausgabe: str) -> bool:
    if "no tests ran" in ausgabe:
        return False
    return bool(_MINDESTENS_EIN_TEST.search(ausgabe))


AUSZUG_ZEILEN = 20


def ausgabe_auszug(ausgabe: str, zeilen: int = AUSZUG_ZEILEN) -> list[str]:
    """Die letzten Zeilen der Werkzeugausgabe — der Auszug fuer eine ABBRUCH-Meldung.

    Warum es das gibt: die Meldung nannte bisher das KOMMANDO, aber nicht seine Ausgabe.
    Auf dem eigenen Rechner ist das folgenlos (man tippt es nach), in der CI ist es der
    Unterschied zwischen einer Diagnose und Rateversuchen — am 2026-09-08 gemessen: DREI
    CI-Anlaeufe (Laeufe 34179774574, 34180726821, 34181093282) bekamen dieselbe
    nichtssagende Meldung, und die Ursache fand erst ein zusaetzlicher Workflow-Schritt
    daneben, der dasselbe Kommando nackt fuhr. Die Ausgabe liegt hier laengst vor: `_lauf`
    gibt stdout UND stderr zurueck.

    Von HINTEN, und das ist der Punkt: ein Testlaeufer meldet sein Scheitern am ENDE
    (Bilanzzeile, npm-Fehler, Traceback-Schluss). Der vorhandene Auszug im Zweig „gar nicht
    gestartet" nimmt bewusst den ANFANG — dort ist die erste Zeile die Diagnose (`command
    not found`), und was danach kommt, gibt es meist nicht.

    Leere Ausgabe wird BENANNT, nicht verschwiegen: „keine Ausgabe" ist selbst ein Befund
    (so sieht ein Werkzeug aus, das gar nicht erst startete), und eine leere Liste laesse
    die Meldung so aussehen, als haette niemand nachgesehen.

    Eigene Funktion statt drei Schleifen an den Abbruchstellen, damit ein Test sie ohne
    Dateisystem und ohne Subprozess pruefen kann — dieselbe Form wie `anker_ok`.
    """
    roh = [z.rstrip() for z in ausgabe.splitlines() if z.strip()]
    if not roh:
        return ["(keine Ausgabe)"]
    return roh[-zeilen:]


def _git(repo: str, *args: str) -> str:
    # S603: die Argumente kommen aus diesem Skript und aus `--repo`, das der Entwickler selbst
    # tippt. Es gibt keine Vertrauensgrenze, ueber die hier etwas hereinkaeme.
    # S607: `git` bewusst OHNE vollen Pfad. Ein fester Pfad waere hier nicht sicherer, nur
    # unbrauchbar — er unterscheidet sich zwischen Windows-Entwicklerrechner und ubuntu-Laeufer,
    # und beide muessen dieses Skript fahren. Dieselbe Abwaegung wie in jedem git-Aufruf des
    # Repos; die Alternative waere eine Pfadtabelle, die bei der ersten neuen Plattform driftet.
    return subprocess.run(["git", "-C", repo, *args],  # noqa: S603, S607
                          capture_output=True, text=True, check=True).stdout


def _verfolgt_geaendert(repo: str, pfad: str) -> str:
    """Nur VERFOLGTE Aenderungen — die EINE Quelle fuer beide Sauberkeitspruefungen.

    UNTRACKED (`??`) zaehlt bewusst nicht: eine untracked Datei ist von einer Mutation nicht
    betroffen. Wuerde sie zaehlen, schluege der Riegel in diesem Repo staendig an
    (Reviewberichte, PR-Texte und die gitignorierte CLAUDE.md liegen dauerhaft untracked
    herum) — und ein Waechter mit Fehlalarmen wird weggeklickt, danach schuetzt er nichts
    mehr, waehrend alle glauben, er tue es.

    Als EINE Funktion, weil die erste Fassung den Filter nur am Anfang hatte und am Ende nicht:
    die Gegenprobe mit einer untracked Datei lief sauber durch und meldete danach trotzdem
    `SERIE FEHLGESCHLAGEN`. Zwei Stellen fuer eine Regel driften.
    """
    zeilen = _git(repo, "status", "--porcelain", "--", pfad).splitlines()
    return "\n".join(z for z in zeilen if not z.startswith("??")).strip()


def _lauf(repo: str, kommando: str, zusatz: dict[str, str] | None = None) -> tuple[str, int]:
    """Gibt (Ausgabe, Rueckgabecode) zurueck — den Code NICHT wegwerfen.

    Der Rueckgabecode des Laeufers ist der ehrlichste Zeuge, den es hier gibt: pytest
    unterscheidet damit „Tests sind rot" (1) von „Nutzungsfehler" (4) und „keine Tests
    gesammelt" (5), und das ist eindeutig, wo eine Textsuche raten muss. Die erste Fassung
    verwarf ihn und stuetzte sich allein auf Zeilenmuster; darauf hat der gegnerische Pruefer
    zu Recht gezeigt.
    """
    # `shell=True` ist hier richtig und bleibt: `--test` IST ein Kommando, das der Entwickler
    # selbst tippt ("npm run test:electron"), keine Eingabe von aussen — es gibt keine
    # Vertrauensgrenze, ueber die es kaeme. Und ohne Shell scheitert genau der Normalfall:
    # `npm` ist auf Windows `npm.cmd`, ein argv-Aufruf findet es nicht. Wer das auf
    # `shlex.split()` umstellt, macht das Werkzeug auf der Zielplattform unbrauchbar, ohne ein
    # Loch zu schliessen. (Ein Linter markiert die Zeile trotzdem — das ist die Antwort darauf.)
    #
    # `encoding="utf-8", errors="replace"` statt `text=True`, und das ist kein Feinschliff:
    # `text=True` dekodiert mit der LOCALE, auf einem Windows-Python ohne `PYTHONUTF8` also
    # mit cp1252 — und das ist die Voreinstellung.
    #
    # GEMESSEN (2026-09-05, PYTHONUTF8=0, Elternteil meldet `preferred encoding: cp1252`):
    # schreibt das Kind ein in cp1252 UNDEFINIERTES Byte — etwa U+274C, also E2 9D 8C —,
    # stirbt der Leser-Thread mit
    #     UnicodeDecodeError: 'charmap' codec can't decode byte 0x9d in position 3
    # und `p.stdout` kommt als LEERER String zurueck. Die ganze Testausgabe ist damit weg,
    # und der Treiber saehe null rote Zeilen, wo eine ganze Suite gelaufen ist.
    # HERGELEITET, nicht sauber messbar durch eine cp1252-Konsole: dasselbe trifft die
    # vitest-Zeile `×` (C3 97) als Mojibake, womit `_ist_fehlzeile` nie greift.
    #
    # Dass es hier trotzdem lief, lag an `PYTHONUTF8=1` auf DIESEM Rechner — genau die
    # Sorte Fehler, die auf dem Rechner des Autors nie auftritt.
    # `env` nur, wenn wirklich etwas dazukommt: `env=os.environ.copy()` waere zwar
    # gleichwertig, ersetzt aber die geerbte Umgebung durch eine Kopie — und ein Unterschied,
    # den man nicht braucht, ist einer, den man spaeter sucht.
    umgebung = {**os.environ, **zusatz} if zusatz else None
    p = subprocess.run(kommando, cwd=repo, shell=True, capture_output=True,  # noqa: S602
                       encoding="utf-8", errors="replace", env=umgebung)
    # EINE Stelle fuer die Entfaerbung, nicht drei: alle drei Proben und der Abgleich der
    # Testnamen lesen dieselbe Zeichenkette. Waere sie je Probe entfaerbt, koennte die
    # naechste hinzukommende sie vergessen — genau so ist T-070 entstanden.
    return ohne_farbe((p.stdout or "") + (p.stderr or "")), p.returncode


def _pycache_leeren(wurzel: pathlib.Path) -> int:
    """FALLE 4. Gibt die Zahl der geleerten Ordner zurueck, damit ein Test sie sehen kann."""
    n = 0
    for ordner in wurzel.rglob("__pycache__"):
        if ordner.is_dir():
            shutil.rmtree(ordner, ignore_errors=True)
            n += 1
    return n


def anker_ok(inhalt: str, von: str) -> tuple[bool, int]:
    """FALLE 2, zweite Haelfte: der Anker muss GENAU EINMAL passen.

    Getrennt herausgezogen, damit ein Test ihn ohne Dateisystem pruefen kann. Zwei Treffer
    sind so gefaehrlich wie null: bei zwei ersetzt `replace(..., 1)` still den falschen.
    """
    treffer = inhalt.count(von)
    return treffer == 1, treffer


def zeilenenden_angleichen(inhalt: str, text: str) -> str:
    """FALLE 2, erste Haelfte: den Plan an die Datei anpassen, nie umgekehrt."""
    return text.replace("\n", "\r\n") if "\r\n" in inhalt else text


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, help="Repo-Wurzel")
    ap.add_argument("--test", help="Testkommando; schlaegt das Feld `test` des Plans")
    ap.add_argument("--plan", required=True, help="JSON-Datei mit den Mutationen")
    ap.add_argument("--pfad", default=".", help="Auf diesen Pfad wird Sauberkeit geprueft")
    ap.add_argument("--env", action="append", default=[], metavar="NAME=WERT",
                    help="Zusatzvariable fuer das Testkommando; mehrfach erlaubt")
    a = ap.parse_args(argv)

    # ZWEI Planformen, und das ist Absicht statt Uebergangszustand:
    #   * OBJEKT — traegt sein Testkommando, seine Pfade und seine Umgebung selbst. Nur so
    #     kann ein Laeufer alle Plaene fahren, ohne dass je Plan eine Workflow-Zeile
    #     dazukommt; genau diese Tabelle waere die naechste, die still hinterherhinkt.
    #   * LISTE — der Ad-hoc-Plan, den jemand von Hand tippt, mit `--test` von aussen.
    # Streng ist der WAECHTER (scripts/test_mutationsplaene.py verlangt fuer alles unter
    # scripts/mutationen/ die Objektform), nicht der Treiber.
    roh = json.loads(pathlib.Path(a.plan).read_text(encoding="utf-8"))
    plan_test: str | None = None
    plan_env: dict[str, str] = {}
    if isinstance(roh, dict):
        plan = roh.get("mutationen")
        plan_test = roh.get("test")
        plan_env = roh.get("env") or {}
    else:
        plan = roh

    # Den Plan GANZ pruefen, bevor die erste Datei angefasst wird. Sonst stirbt der Lauf
    # mitten in der Serie an einem Traceback — und dann laufen weder die restlichen
    # Mutationen noch die Schlusspruefung auf einen sauberen Baum. Ein LEERER Plan waere
    # ausserdem eine Serie mit null Mutationen und ginge als „bestanden" durch: dieselbe
    # Klasse wie eine leere `rot`-Liste, nur eine Ebene hoeher. Beides vom Bot gefunden.
    pflicht = {"id", "datei", "von", "nach", "rot"}
    if not isinstance(plan, list) or not plan:
        print("ABBRUCH: --plan braucht eine nicht leere Mutationsliste — entweder als"
              " JSON-Liste oder als Objekt mit dem Schluessel `mutationen`.")
        return 2
    unbrauchbar = [m for m in plan if not isinstance(m, dict) or not pflicht <= m.keys()]
    if unbrauchbar:
        print(f"ABBRUCH: {len(unbrauchbar)} Eintrag/Eintraege ohne die Pflichtfelder"
              f" {sorted(pflicht)}:")
        for m in unbrauchbar[:3]:
            print(f"         {m!r}"[:160])
        return 2

    test = a.test or plan_test
    if not test:
        print("ABBRUCH: kein Testkommando — weder --test noch das Feld `test` im Plan.")
        return 2
    zusatz = dict(plan_env)
    for zuweisung in a.env:
        name, trenner, wert = zuweisung.partition("=")
        if not trenner or not name:
            print(f"ABBRUCH: --env {zuweisung!r} ist kein NAME=WERT.")
            return 2
        zusatz[name] = wert

    # ANKER VOR DER ERSTEN SCHREIBUNG (T-074). Bisher fiel ein veralteter Anker erst IN der
    # Schleife auf — und weil davor die Positivkontrolle steht, war die Suite zu dem
    # Zeitpunkt schon einmal ganz gelaufen. GEMESSEN am 2026-09-08: Serie 06:27:47Z
    # gestartet, Abbruch 06:37:01Z. Zehn Minuten Testlaeufe gegen einen Plan, der ab
    # Sekunde 0 veraltet war.
    #
    # Das ist eine VERHALTENSAENDERUNG, kein Zusatz: vorher zaehlte ein schlechter Anker als
    # EIN Fehler, die Serie lief weiter und endete mit rc 1. Jetzt bricht der ganze Lauf mit
    # rc 2 ab, bevor irgendetwas geschrieben oder gemessen wurde — rc 2 heisst in diesem
    # Skript durchgehend „konnte nicht urteilen", und genau das ist der Fall.
    fehlstellen: list[tuple[str, str]] = []
    for m in plan:
        datei = pathlib.Path(a.repo) / m["datei"]
        try:
            inhalt = datei.read_bytes().decode("utf-8")
        except FileNotFoundError:
            fehlstellen.append((m["id"], f"{m['datei']} gibt es nicht"))
            continue
        except UnicodeDecodeError as fehl:
            fehlstellen.append((m["id"], f"{m['datei']} ist nicht UTF-8 ({fehl})"))
            continue
        eindeutig, treffer = anker_ok(inhalt, zeilenenden_angleichen(inhalt, m["von"]))
        if not eindeutig:
            fehlstellen.append((m["id"], f"Anker {treffer}-mal gefunden, erwartet genau 1"))
    if fehlstellen:
        print(f"ABBRUCH: {len(fehlstellen)} Anker passen nicht mehr zum Baum — der Plan ist"
              " veraltet. Es wurde nichts geschrieben und nichts gemessen.")
        for kennung, grund in fehlstellen:
            print(f"         {kennung}: {grund}")
        return 2

    # Der Startriegel bleibt, obwohl die Ruecknahme ihn nicht mehr BRAUCHT: eine Serie auf
    # schmutzigem Baum kann zwar nichts mehr loeschen, aber die Schlusspruefung
    # (`_verfolgt_geaendert`) koennte fremde Aenderungen nicht von einer nicht
    # zurueckgenommenen Mutation unterscheiden. Der Riegel haelt die Aussage sauber.
    schmutzig = _verfolgt_geaendert(a.repo, a.pfad)
    if schmutzig:
        print(f"ABBRUCH: getrackte Aenderungen unter {a.pfad} — erst committen, DANN mutieren.")
        print(schmutzig)
        print("(Sonst laesst sich am Ende nicht sagen, ob eine Mutation haengen blieb.)")
        return 2

    # POSITIVKONTROLLE, unmutiert, vor der Serie. Sie beantwortet zwei Fragen, die eine
    # Mutationsserie sonst offen laesst und still falsch beantwortet:
    #   * Laeuft das Testkommando ueberhaupt? Eines, das gar nicht startet, liefert null rote
    #     Zeilen — genau wie eine Mutation ohne Wirkung.
    #   * Ist die Suite VORHER gruen? Auf einer schon roten Suite belegt eine rote Mutation
    #     nichts.
    aus0, rc0 = _lauf(a.repo, test, zusatz)
    # Der Rueckgabecode zuerst, weil er eindeutig ist, wo die Textsuche raten muss: pytest
    # meldet mit 4 einen Nutzungsfehler und mit 5 „keine Tests gesammelt" — beides heisst
    # „nichts gemessen", und beides kommt mit einer Ausgabe, die harmlos aussieht.
    if rc0 in (4, 5):
        print(f"ABBRUCH: das Testkommando endete mit {rc0} — bei pytest heisst das"
              " Nutzungsfehler bzw. keine Tests gesammelt.")
        print(f"         Kommando: {test}")
        print("         Ausgabe (Ende):")
        for z in ausgabe_auszug(aus0):
            print(f"           {z}")
        return 2
    if not _sah_einen_testlauf(aus0):
        print("ABBRUCH: das Testkommando hat keine erkennbare Testausgabe geliefert —")
        print("         es ist vermutlich gar nicht gestartet. NICHT als Ergebnis werten.")
        print(f"         Kommando: {test}")
        print("         Ausgabe (Anfang):")
        for z in aus0.splitlines()[:5]:
            print(f"           {z}")
        if not aus0.strip():
            print("           (leer)")
        print("         Hinweis: `shell=True` startet auf Windows cmd.exe. Dort gibt es kein"
              " `./`, und ein Pfad mit fuehrendem `./` scheitert stumm mit rc 1.")
        return 2
    if not _lief_mindestens_ein_test(aus0):
        print("ABBRUCH: das Testkommando ist gelaufen, hat aber NULL Tests ausgefuehrt —")
        print("         ein Tippfehler im Pfad oder eine Auswahl ohne Treffer. Eine Serie")
        print("         darauf meldete jede Mutation als wirkungslos, und der Grund stuende")
        print("         nirgends. NICHT als Ergebnis werten.")
        print(f"         Kommando: {test}")
        # Das ENDE, nicht der Anfang: hier ist das Werkzeug gelaufen, seine Bilanz oder sein
        # Fehler steht also hinten. Genau dieser Zweig hat am 2026-09-08 dreimal in der CI
        # gefeuert, und dreimal stand die Ursache nicht da.
        print("         Ausgabe (Ende):")
        for z in ausgabe_auszug(aus0):
            print(f"           {z}")
        return 2
    vorlauf_rot = [z for z in aus0.splitlines() if _ist_fehlzeile(z)]
    if vorlauf_rot:
        print(f"ABBRUCH: die Suite ist schon OHNE Mutation rot ({len(vorlauf_rot)} Zeilen) —")
        print("         auf einer roten Suite belegt eine rote Mutation nichts.")
        for z in vorlauf_rot[:5]:
            print(f"           {z.strip()}")
        return 2
    print(f"Positivkontrolle: Suite laeuft und ist gruen ({len(plan)} Mutationen folgen)")

    fehler = 0
    pfad_wurzel = (pathlib.Path(a.repo) / a.pfad).resolve()
    for m in plan:
        # Eine Mutation ohne erwarteten roten Test besteht sonst BEDINGUNGSLOS: `offen` ist
        # leer, also gilt sie als OK — egal was der Testlauf tat. Der Plan waere damit die
        # eine Stelle, an der sich die Probe still entwerten laesst, und der Treiber saehe
        # es nicht. Gefunden vom kalten Diff-Review, mit Reproduktion.
        if not m.get("rot"):
            print(f"ABBRUCH {m['id']}: `rot` ist leer — eine Mutation ohne erwarteten roten"
                  " Test belegt nichts.")
            fehler += 1
            continue

        datei = pathlib.Path(a.repo) / m["datei"]
        # Eine Datei ausserhalb von `--pfad` faellt aus BEIDEN Nachkontrollen: die
        # Sauberkeitspruefung am Ende sieht sie nicht, und ihr Bytecode wird nicht geleert.
        # Lieber laut abbrechen als still halb pruefen.
        if pfad_wurzel not in datei.resolve().parents:
            print(f"ABBRUCH {m['id']}: {m['datei']} liegt ausserhalb von --pfad {a.pfad} —"
                  " dort greifen weder die Sauberkeitspruefung noch das Bytecode-Leeren.")
            fehler += 1
            continue
        # FALLE 2: Bytes lesen und SELBST dekodieren. `read_text` uebersetzt CRLF still.
        roh = datei.read_bytes()
        try:
            vorher = roh.decode("utf-8")
        except UnicodeDecodeError as fehl:
            # Als ABBRUCH statt als Traceback: sonst reisst eine einzige nicht-UTF-8-Datei
            # die ganze Serie ab, die restlichen Mutationen laufen nie, und die Endpruefung
            # auf einen sauberen Baum entfaellt.
            print(f"ABBRUCH {m['id']}: {m['datei']} ist nicht UTF-8 ({fehl}).")
            fehler += 1
            continue
        von = zeilenenden_angleichen(vorher, m["von"])
        nach = zeilenenden_angleichen(vorher, m["nach"])

        eindeutig, treffer = anker_ok(vorher, von)
        if not eindeutig:
            print(f"ABBRUCH {m['id']}: Anker {treffer}-mal gefunden, erwartet genau 1")
            fehler += 1
            continue

        mutiert = vorher.replace(von, nach, 1).encode("utf-8")
        # Die Schreibung liegt IM try: sonst laesst eine Ausnahme zwischen ihr und dem try
        # (oder ein Strg-C genau dort) die Mutation im Baum liegen, und der naechste Start
        # raet dann zum Committen der Mutation. Gefunden vom gegnerischen Pruefer.
        fremd = False
        try:
            datei.write_bytes(mutiert)
            aus, _rc = _lauf(a.repo, test, zusatz)
        finally:
            # FALLE 1: aus dem SPEICHER, nicht ueber git — das fasst nur DIESE Datei an.
            #
            # Aber blind zurueckschreiben waere derselbe Fehler eine Ebene tiefer, und genau
            # darauf hat der gegnerische Pruefer gezeigt: steht in der Datei inzwischen etwas
            # ANDERES als unsere Mutation, hat jemand waehrend des Testlaufs hineingeschrieben
            # — eine parallele Sitzung, ein Formatierer, der Testlauf selbst. Wir schrieben
            # ihm die Arbeit weg und meldeten dazu „Arbeitsbaum sauber". Gemessen: ein
            # Testkommando, das eine Zeile anhaengt, verlor sie spurlos bei rc 0.
            # Deshalb: nur zurueckschreiben, wenn noch UNSERE Mutation dasteht.
            jetzt = datei.read_bytes()
            if jetzt == mutiert:
                datei.write_bytes(roh)
            elif jetzt != roh:
                fremd = True
                print(f"ABBRUCH {m['id']}: {m['datei']} wurde WAEHREND des Laufs veraendert —")
                print("         nicht von uns. Die Datei bleibt, wie sie ist; der Ausgangs-")
                print("         stand steht in git. NICHT ueberschrieben, damit nichts")
                print("         verlorengeht.")
                fehler += 1
            _pycache_leeren(pathlib.Path(a.repo) / a.pfad)

        # Nach einer Fremdschreibung ist die AUSWERTUNG sinnlos: die Datei trug beim Testlauf
        # nicht mehr unsere Mutation, also sagt „rot" oder „gruen" nichts ueber sie aus. Ohne
        # dieses `continue` zaehlte derselbe Vorfall zweimal (Fremdschreibung plus
        # fehlgeschlagener Bytevergleich) und produzierte dazu ein widerspruechliches Urteil.
        # Vom Bot gefunden.
        if fremd:
            continue

        # Byte-genau derselbe Stand — die Zusicherung, die `git checkout` nie hatte.
        # WAS SIE NICHT KANN, damit es niemand glaubt: eine Mutation, die der Testlauf
        # versehentlich COMMITTET hat, sieht sie nicht — sie vergleicht mit dem, was zwei
        # Zeilen vorher geschrieben wurde. Diesen Fall faengt `_verfolgt_geaendert` am Ende
        # der Serie. (Der Pruefer hat die Behauptung an dieser Zeile widerlegt; sie stimmt
        # fuer die Serie, nicht fuer diese Pruefung.)
        if datei.read_bytes() != roh:
            print(f"FEHL {m['id']}: Ruecknahme nicht bytegleich — {m['datei']}")
            fehler += 1

        # FALLE 3 — entescapen, BEVOR gesucht wird.
        rote = [z.replace("\\#", "#") for z in aus.splitlines() if _ist_fehlzeile(z)]
        offen = [n for n in m["rot"] if not any(n in z for z in rote)]
        falsch_rot = [n for n in m.get("gruen", []) if any(n in z for z in rote)]

        ok = not offen and not falsch_rot
        fehler += 0 if ok else 1
        print(f"{'OK  ' if ok else 'FEHL'} {m['id']}  (rot: {len(rote)})")
        for n in offen:
            print(f"      NICHT rot geworden: {n}")
        for n in falsch_rot:
            print(f"      faelschlich rot: {n}")
        if not rote and offen:
            # Die Diagnose muss die drei Faelle auseinanderhalten, sonst zeigt sie in die
            # falsche Richtung — sie sehen alle drei nach "null rote Zeilen" aus.
            if not _sah_einen_testlauf(aus):
                print("      Achtung: die Suite ist gar nicht GELAUFEN — die Mutation hat sie"
                      " vermutlich unlesbar gemacht (Syntaxfehler, Importfehler). Das ist"
                      " KEINE Aussage ueber den Test.")
            elif not _lief_mindestens_ein_test(aus):
                print("      Achtung: die Suite lief, hat aber NULL Tests ausgefuehrt — die"
                      " Mutation hat vermutlich das Einsammeln gebrochen.")
            else:
                print("      Hinweis: KEINE rote Zeile erkannt. Entweder wirkte die Mutation"
                      " nicht, oder _ist_fehlzeile kennt die Form dieses Laeufers nicht —"
                      " nachsehen, bevor daraus ein Befund wird.")

    rest = _verfolgt_geaendert(a.repo, a.pfad)
    print(f"\nArbeitsbaum nach der Serie ({a.pfad}): "
          f"{'NICHT SAUBER:' + chr(10) + rest if rest else 'sauber'}")
    if rest:
        fehler += 1
    print(f"SERIE BESTANDEN ({len(plan)} Mutationen)" if fehler == 0
          else f"SERIE FEHLGESCHLAGEN ({fehler})")
    return 0 if fehler == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
