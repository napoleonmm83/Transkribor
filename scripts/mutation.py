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


# Wie die vier hier benutzten Laeufer eine rote Zeile schreiben. Bewusst eine kurze Liste:
# was hier fehlt, faellt als "Mutation wirkungslos" auf und wird ergaenzt — ein zu breites
# Muster dagegen wuerde eine gruene Suite als rot lesen und die Probe wertlos machen.
def _ist_fehlzeile(z: str) -> bool:
    s = z.lstrip()
    return (z.startswith("not ok ")          # node:test, TAP-Reporter
            or s.startswith("FAILED ")       # pytest
            or s.startswith("×")             # vitest, U+00D7
            or s.startswith("✖")             # node:test, Spec-Reporter, U+2716
            or _PLAYWRIGHT_FEHL.match(s) is not None)  # Playwright: "1) [chromium] › …"

# Playwrights Fehlerliste (gemessen am Laeufer dieser Maschine, reporter=line UND default):
#   "  1) [chromium] › e2e\reflow-320.spec.ts:50:3 › Start … ────"
# Die Zahl-Klammer kennt sonst kein Laeufer hier; der Anker auf die Browser-Klammer haelt
# das Muster eng — eine gruene Suite druckt diese Form nie. Ohne diese Zeile meldete der
# Treiber JEDE Playwright-Mutation als wirkungslos (gemessen 2026-09-11: beide E2E-Plaene
# komplett FEHL bei gruener Positivkontrolle — dieselbe Klasse wie die CI-Farbungluecke
# oben, diesmal Form statt Farbe). Die Summenzeile "  7 failed" zaehlt bewusst NICHT:
# sie stuende auch in einem Lauf, der nur abgebrochene Vorbereitung meldet.
_PLAYWRIGHT_FEHL = re.compile(r"^\d+\)\s+\[")


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


def _verfolgt_geaendert(repo: str, pfad: str, *, ausser_plaene: frozenset[str] | None = None) -> str:
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
    # `None` heisst KEINE Ausnahme — nicht „leere Ausnahmeliste". Die Vorgabe stand zuerst
    # andersherum, und die Mutationsprobe hat es gefangen: ohne Argument wurden damit ALLE
    # Plaene uebergangen, also genau der fail-open, den dieser Zuschnitt verhindern soll,
    # durch die Hintertuer der Vorgabe. Wer die Ausnahme will, sagt es und nennt dabei seine
    # eigenen Ziele; wer nichts sagt, bekommt den strengen Riegel.
    uebergehen = ausser_plaene is not None
    eigene = ausser_plaene or frozenset()
    zeilen = _git(repo, "status", "--porcelain", "--", pfad).splitlines()
    return "\n".join(
        z for z in zeilen
        if not z.startswith("??")
        and not (uebergehen and _ist_mutationsplan(z) and _statuspfad(z) not in eigene)
    ).strip()


def _statuspfad(statuszeile: str) -> str:
    """Der Pfad aus einer `--porcelain`-Zeile, bei Umbenennungen das ZIEL.

    `R  alt -> neu` nennt zwei Pfade; gefragt ist, welche Datei jetzt im Baum liegt.
    """
    pfad = statuszeile[3:].strip().strip('"')
    return pfad.split(" -> ")[-1].strip().strip('"')


def _ist_mutationsplan(statuszeile: str) -> bool:
    """Zeigt die Statuszeile auf eine Plandatei unter `scripts/mutationen/`?

    Beide Riegel nehmen fremde Plaene aus, keiner nimmt die ZIELE dieses Laufs aus — und
    dieser Zuschnitt ist in zwei Anlaeufen entstanden, beide fremd korrigiert. Der erste nahm
    Plaene UEBERALL aus, begruendet damit, ein Plan sei nie ein Mutationsziel: **widerlegt**
    (gegnerischer Review, ausgefuehrt) — `scripts/mutationen/mutationen_lauf.json` mutiert
    `scripts/mutationen/deckel_finally.json` an drei Stellen, am Schlussriegel waere das ein
    fail-open gewesen. Der zweite nahm sie nur am START aus; dann meldete der Schluss den
    fremden Plan als Rest, und die Serie wurde rot statt durchzulaufen (eigener Test).

    Was bleibt, ist die exakte Form: was DIESER Lauf anfasst, zaehlt immer; jede andere
    Plandatei nie. Der Aufrufer reicht die `datei`-Felder seiner Mutationen als `ausser_plaene`
    durch.

    Der Anlass, gemessen am 2026-09-19 und groesster Einzelposten jener Sitzung: ein
    editierter, uncommitteter Plan liess `fehlerberichte-python` (`--pfad .`) am START mit
    ABBRUCH enden — knapp vier Minuten ohne Urteil, komplett wiederholt. Der eigene Plan
    (`--pfad webtool`) sah die Datei nicht, ein fremder mit weiterem Pfad schon; welcher Plan
    abbrach, hing an einem Pfadpraefix, das mit der Sache nichts zu tun hat.

    ZU UMBENENNUNGEN — hier stand zweimal das Gegenteil des Codes, beide Male fremd gefunden.
    Die Statuszeile einer Umbenennung traegt `alt -> neu`, und geprueft wird die GANZE
    Zeichenkette: `R  scripts/mutationen/a.json -> scripts/mutationen/b.json` ergibt True
    (beginnt mit dem Praefix, endet auf `.json`), `-> scripts/weg.json` ebenfalls, `-> x.py`
    dagegen False. Am Startriegel ist das durchweg harmlos — dort geht es nur darum, ob der
    Mensch an einer Plandatei gearbeitet hat, und das hat er in allen drei Formen.

    Die Statuszeile hat die Form `XY pfad`; `--porcelain` liefert Vorwaertsschraegstriche,
    auch auf Windows, und quotet Pfade mit Sonderzeichen.
    """
    roh = statuszeile[3:].strip()
    # BEIDE Seiten einer Umbenennung, nicht die ganze Zeichenkette (CodeRabbit-CLI, zweimal
    # gemeldet). `R  scripts/x.py -> scripts/mutationen/neu.json` beginnt sonst mit `scripts/x`
    # und gaelte nicht als Plan; `R  scripts/mutationen/a.json -> scripts/x.py` endet auf `.py`
    # und ebenso wenig. Beide Male war die Wirkung die sichere (der Riegel haelt an), aber der
    # Docstring behauptete etwas ueber Umbenennungen, das der Code nicht tat — und eine
    # Plandatei, die in den Ordner hinein umbenannt wird, IST eine Planaenderung.
    teile = [t.strip().strip('"') for t in roh.split(" -> ")]
    return any(t.startswith("scripts/mutationen/") and t.endswith(".json") for t in teile)


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
    # DER INTERPRETER REIST MIT — und das ist der Grund, warum die Umgebung jetzt IMMER gebaut
    # wird (bis zum 2026-09-19 nur, wenn ein Plan `env` mitbrachte).
    #
    # `shell=True` startet auf Windows cmd.exe, und dort entscheidet der PATH, was `python`
    # ist. Jeder committete Plan schreibt `python -m pytest …`; auf diesem Rechner traf das
    # ein System-3.14 OHNE pytest. Gemessen am 2026-09-19: ALLE SECHS ueber `--geaendert`
    # gewaehlten Plaene brachen mit rc 2 ab, Ausgabe je
    # `C:\Python314\python.exe: No module named pytest`, und die Bilanzzeile lautete
    # `0 von 6 bestanden` mit `GESCHEITERT` an jedem Plan — wer nur sie liest, sucht den
    # Fehler im eigenen Diff. Zweites Vorkommen in zwei Tagen; im Reibungsjournal steht die
    # Klasse beim 6. Mal.
    #
    # Das Verzeichnis von `sys.executable` VORNE anzustellen ist sicher, weil der Treiber
    # ohnehin unter genau diesem Interpreter laeuft (`mutationen_lauf.py` startet ihn mit
    # `sys.executable`): lokal ist das die venv, in der CI das setup-python — dort also ein
    # No-op, weil `python` schon darauf zeigt. VORNE und nicht hinten, denn ein System-Python
    # frueher im PATH ist genau der gemessene Fall.
    #
    # WAS DAS NEU ERLAUBT, benannt und nachgemessen (gegnerischer Review): der FALSCHE Treiber
    # bindet das Kind jetzt an sich. Wer `py scripts/mutation.py` in einer aktivierten venv
    # startet, bekam bisher ueber den PATH doch noch das venv-Python; jetzt erbt das Kind den
    # Interpreter des Elternteils. Das ist die richtige Richtung und NICHT still — gemessen
    # mit `C:/Python314/python.exe scripts/mutation.py` bei venv vorn im PATH: rc **2**, also
    # „konnte nicht urteilen", mit `No module named pytest` und der Zeile „es ist vermutlich
    # gar nicht gestartet. NICHT als Ergebnis werten". Der Anti-Schweigen-Riegel faengt den
    # Fall; was vorher zufaellig funktionierte, scheitert jetzt sichtbar.
    #
    # Der frueher hier stehende Grund gegen ein unbedingtes `env` („ein Unterschied, den man
    # nicht braucht, ist einer, den man spaeter sucht") gilt weiter — er trifft nur nicht
    # mehr zu: der Unterschied wird jetzt GEBRAUCHT, und er steht hier.
    umgebung = {**os.environ, **(zusatz or {})}
    umgebung["PATH"] = os.path.dirname(sys.executable) + os.pathsep + umgebung.get("PATH", "")
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

    # Der Startriegel bleibt, obwohl die Ruecknahme ihn nicht mehr BRAUCHT: eine Serie auf
    # schmutzigem Baum kann zwar nichts mehr loeschen, aber die Schlusspruefung
    # (`_verfolgt_geaendert`) koennte fremde Aenderungen nicht von einer nicht
    # zurueckgenommenen Mutation unterscheiden. Der Riegel haelt die Aussage sauber.
    #
    # Er steht VOR der Ankerpruefung, und das ist eine Entscheidung: wer eine Zeile
    # geaendert und nicht committet hat, kann damit einen Anker verschoben haben. „Der Plan
    # ist veraltet" waere dann zwar wahr, aber der zweite Schritt — zu tun ist zuerst das
    # Committen. Die teurere Meldung gehoert nach hinten.
    # Ein fremder Mutationsplan ist die VORLAGE eines Laufs, nicht sein Ziel — dass jemand
    # einen editiert hat, darf den Start nicht aufhalten. Genau das kostete am 2026-09-19 den
    # groessten Einzelposten der Sitzung: ein uncommitteter Plan liess eine Serie mit `--pfad .`
    # abbrechen, knapp vier Minuten ohne Urteil, komplett wiederholt.
    #
    # `ziele` ist die AUSNAHME VON DER AUSNAHME, und ohne sie waere das hier fail-open:
    # ein Plan KANN sehr wohl Mutationsziel sein — `scripts/mutationen/mutationen_lauf.json`
    # mutiert `scripts/mutationen/deckel_finally.json` an drei Stellen (gegnerischer Review,
    # ausgefuehrt). Waere er pauschal ausgenommen, meldete der Schlussriegel unten eine
    # haengengebliebene Mutation als „sauber" — in genau dem Riegel, der das Gegenteil
    # zusichert. Was DIESER Lauf anfasst, zaehlt also weiterhin; alles andere unter
    # `scripts/mutationen/` nicht.
    ziele = frozenset(str(m.get("datei", "")).replace("\\", "/") for m in plan)
    schmutzig = _verfolgt_geaendert(a.repo, a.pfad, ausser_plaene=ziele)
    if schmutzig:
        print(f"ABBRUCH: getrackte Aenderungen unter {a.pfad} — erst committen, DANN mutieren.")
        print(schmutzig)
        print("(Sonst laesst sich am Ende nicht sagen, ob eine Mutation haengen blieb.)")
        return 2

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
    #
    # Die Datei wird JE MUTATION gelesen, nicht einmal je Datei. Bei 24 Mutationen auf einer
    # Datei sind das 24 Lesevorgaenge von wenigen Kilobyte — gemessen unter einer Sekunde,
    # gegen eine Serie von Minuten. Ein Zwischenspeicher waere hier Zustand ohne Gegenwert.
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

    # DIESELBE Ausnahme wie am Startriegel, und aus demselben Grund: ein fremder Plan, den
    # jemand nebenher editiert hat, ist kein Rest DIESES Laufs. Die Ziele dieses Plans sind
    # ausgenommen — auch wenn eines davon selbst eine Plandatei ist (das gibt es, siehe die
    # Begruendung oben). Damit bleibt die Zusage dieses Riegels vollstaendig: was wir angefasst
    # haben, sehen wir.
    rest = _verfolgt_geaendert(a.repo, a.pfad, ausser_plaene=ziele)
    print(f"\nArbeitsbaum nach der Serie ({a.pfad}): "
          f"{'NICHT SAUBER:' + chr(10) + rest if rest else 'sauber'}")
    if rest:
        fehler += 1
    print(f"SERIE BESTANDEN ({len(plan)} Mutationen)" if fehler == 0
          else f"SERIE FEHLGESCHLAGEN ({fehler})")
    return 0 if fehler == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
