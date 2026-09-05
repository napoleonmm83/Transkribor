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
   -> Zurueckgespielt werden die ORIGINALBYTES aus dem Speicher. Das fasst nur die eine Datei
      an, die dieses Skript selbst geschrieben hat, und kann fremde Arbeit per Konstruktion
      nicht erreichen. Es beruehrt ausserdem den DESTRUCTIVE-Guardrail nicht (Marcus'
      Entscheidung 2026-09-04).

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

Aufruf:

    python scripts/mutation.py --repo . --test "python -m pytest scripts/test_mypy_riegel.py -q"
                               --plan scripts/mutationen/mypy_riegel.json --pfad scripts/

Der Plan ist eine JSON-Liste; `rot` sind Testnamen, die die Mutation rot machen MUSS,
`gruen` optional solche, die gruen bleiben muessen (die Gegenprobe — ohne sie belegt eine
rote Suite nur, dass IRGENDETWAS kaputtging).

Exit 0 nur, wenn JEDE Mutation ihre erwarteten Tests rot bekam, keine Gegenprobe gefallen ist,
jede Datei danach BYTEGLEICH zum Ausgangsstand ist UND der Arbeitsbaum sauber ist.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys


# Wie die drei hier benutzten Laeufer eine rote Zeile schreiben. Bewusst eine kurze Liste:
# was hier fehlt, faellt als "Mutation wirkungslos" auf und wird ergaenzt — ein zu breites
# Muster dagegen wuerde eine gruene Suite als rot lesen und die Probe wertlos machen.
def _ist_fehlzeile(z: str) -> bool:
    s = z.lstrip()
    return (z.startswith("not ok ")          # node:test / TAP
            or s.startswith("FAILED ")       # pytest
            or s.startswith("×")             # vitest
            or s.startswith("✗"))


# Woran man erkennt, dass ueberhaupt eine Testsuite gelaufen ist — unabhaengig davon, ob sie
# gruen oder rot war. Ohne diese Probe ist ein Testkommando, das gar nicht STARTET, von einer
# Mutation ohne Wirkung nicht zu unterscheiden: beide liefern null rote Zeilen.
# Gemessen am 2026-09-05, und es hat genau hier zugeschlagen: `shell=True` startet auf Windows
# cmd.exe, und cmd.exe kennt kein `./` — das Kommando `./.venv/Scripts/python.exe -m pytest …`
# endete mit rc 1, leerem stdout und `Der Befehl "." ist … nicht gefunden`. Der Treiber meldete
# daraufhin dreimal „Mutation wirkungslos", obwohl nichts gemessen worden war. Dieselbe Klasse
# wie ein fehlendes ruff (rc 1 + leeres stdout = wie „Befunde") — wer einen Riegel baut, baut
# zuerst den Riegel gegen dessen eigenes Schweigen.
_LAUFMARKEN = (" passed", " failed", "no tests ran", "Tests ", "1..")


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
_MINDESTENS_EIN_TEST = re.compile(r"\b[1-9]\d* (passed|failed)\b|^(not )?ok [1-9]", re.M)


def _lief_mindestens_ein_test(ausgabe: str) -> bool:
    if "no tests ran" in ausgabe:
        return False
    return bool(_MINDESTENS_EIN_TEST.search(ausgabe))


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


def _lauf(repo: str, kommando: str) -> str:
    # `shell=True` ist hier richtig und bleibt: `--test` IST ein Kommando, das der Entwickler
    # selbst tippt ("npm run test:electron"), keine Eingabe von aussen — es gibt keine
    # Vertrauensgrenze, ueber die es kaeme. Und ohne Shell scheitert genau der Normalfall:
    # `npm` ist auf Windows `npm.cmd`, ein argv-Aufruf findet es nicht. Wer das auf
    # `shlex.split()` umstellt, macht das Werkzeug auf der Zielplattform unbrauchbar, ohne ein
    # Loch zu schliessen. (Ein Linter markiert die Zeile trotzdem — das ist die Antwort darauf.)
    #
    # `encoding="utf-8", errors="replace"` statt `text=True`, und das ist kein Feinschliff:
    # `text=True` dekodiert mit der LOCALE. Auf einem Windows-Python ohne `PYTHONUTF8` — der
    # Voreinstellung — ist das cp1252, und dann kommt vitests `×` (UTF-8 C3 97) als `Ã—` an,
    # `_ist_fehlzeile` trifft nie, und JEDE vitest-Mutation gilt als wirkungslos. Ein in
    # cp1252 undefiniertes Byte (etwa U+274C) wirft sogar `UnicodeDecodeError`, `p.stdout`
    # wird None und die ganze Ausgabe ist weg. Gefunden vom kalten Diff-Review; dass es hier
    # trotzdem lief, lag an `PYTHONUTF8=1` auf DIESEM Rechner — also genau die Sorte Fehler,
    # die auf dem Rechner des Autors nie auftritt.
    p = subprocess.run(kommando, cwd=repo, shell=True, capture_output=True,  # noqa: S602
                       encoding="utf-8", errors="replace")
    return (p.stdout or "") + (p.stderr or "")


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
    ap.add_argument("--test", required=True, help="Testkommando, im Repo ausgefuehrt")
    ap.add_argument("--plan", required=True, help="JSON-Datei mit den Mutationen")
    ap.add_argument("--pfad", default=".", help="Auf diesen Pfad wird Sauberkeit geprueft")
    a = ap.parse_args(argv)

    plan = json.loads(pathlib.Path(a.plan).read_text(encoding="utf-8"))

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
    aus0 = _lauf(a.repo, a.test)
    if not _sah_einen_testlauf(aus0):
        print("ABBRUCH: das Testkommando hat keine erkennbare Testausgabe geliefert —")
        print("         es ist vermutlich gar nicht gestartet. NICHT als Ergebnis werten.")
        print(f"         Kommando: {a.test}")
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
        print(f"         Kommando: {a.test}")
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
        vorher = roh.decode("utf-8")
        von = zeilenenden_angleichen(vorher, m["von"])
        nach = zeilenenden_angleichen(vorher, m["nach"])

        eindeutig, treffer = anker_ok(vorher, von)
        if not eindeutig:
            print(f"ABBRUCH {m['id']}: Anker {treffer}-mal gefunden, erwartet genau 1")
            fehler += 1
            continue

        datei.write_bytes(vorher.replace(von, nach, 1).encode("utf-8"))
        try:
            aus = _lauf(a.repo, a.test)
        finally:
            # FALLE 1: aus dem SPEICHER, nicht ueber git. Fasst nur diese eine Datei an.
            datei.write_bytes(roh)
            _pycache_leeren(pathlib.Path(a.repo) / a.pfad)

        # Und die Zusicherung, die `git checkout` nie hatte: byte-genau derselbe Stand.
        # Das erkennt auch eine Mutation, die versehentlich committet wurde — die saehe
        # `git status` als sauber an.
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
