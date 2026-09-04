#!/usr/bin/env python3
"""mypy-Riegel: rot bei Typfehlern, die die Baseline nicht kennt.

Geschwister-Skript von `scripts/ruff_riegel.py` (#543/PR #547), gleiche Form,
gleicher Rueckgabecode-Vertrag — aber mypys Ausgabe hat eigene Fallen, und die
sind unten je einzeln benannt. Bewusst KEINE geteilte Abstraktion: das Repo
haelt schon vier Geschwister-Skripte an denselben Laeufern (`versionshoehe`,
`notizen`, `fassung`, `macos-mindest`) statt eines generalisierten, und zwei
ist kein Muster.

Warum es diesen Riegel gibt: `pyproject.toml` pinnt mypy seit #499 exakt
(`mypy==2.3.1`), und die Begruendung dort lautet „ein Riegel, der je Rechner
anders urteilt, ist kein Riegel". Den Riegel gab es fuer mypy nicht — nicht in
`.github/workflows/`, nicht im `pre-commit`-Hook, nicht in `package.json`.
Renovate pflegte also die Fassung eines Werkzeugs, das nie lief (#546).

Warum eine Baseline und nicht schlicht „mypy muss gruen sein": der Baum traegt
65 Befunde in 18 Dateien (no-any-return 15 · var-annotated 14 · assignment 9 ·
union-attr 8 · arg-type 6 · attr-defined 5 · return-value 3 · index 3 ·
operator 1 · no-redef 1; gemessen 2026-09-04 mit 2.3.1). Kein dominanter
Billigfall, den man in einem Zug wegraeumt — und ein Riegel, der ab Tag eins rot
ist, wird abgeschaltet statt gelesen.

Diese Zahl gilt NUR mit der festgenagelten Sicht aus `pyproject.toml`
(`platform = "win32"`, `no_site_packages = true`). Ohne sie misst derselbe Baum
68 (Standardlauf auf Windows) oder 70 (unter Linux) — die Begruendung samt
Messtabelle steht dort im `[tool.mypy]`-Block. Wer hier 65 liest und 68 misst,
hat die Konfiguration nicht mitgenommen, nicht den Baum geaendert.

DIE VIER MYPY-EIGENEN FALLEN, alle gemessen:

1. `note:`-Zeilen enden auf eine eckige Klammer, die wie ein Fehlercode
   aussieht. ACHT solche Zeilen traegt dieser Baum, SIEBEN davon
   `[annotation-unchecked]` — die achte endet auf einen TYP:
       webtool\\auth.py:92: note:     def __add__(self, list[str], /) -> list[str]
   Keine davon ist ein Fehler; mypy zaehlt 65, ein Muster auf `[code]` allein
   faende 73. Deshalb verlangt `_BEFUND` das woertliche `: error: `; `note:`
   faellt damit von selbst heraus. (Die erste Fassung dieser Zeile schrieb alle
   acht dem Code `annotation-unchecked` zu — die Summe stimmte, die Zuordnung
   nicht. Nachgemessen vom kalten Review, F3.)

2. Kein Spaltenwert. mypy druckt `pfad:zeile: error:`, ruff dagegen
   `pfad:zeile:spalte:`. Das Muster von `ruff_riegel.py` faende hier NICHTS,
   und weil `fehlende_zeilen` das bemerkt, waere der Riegel rc 2 statt still —
   aber eben auch nie gruen.

3. Ein Syntaxfehler beendet mypy mit rc 2, nicht 1:
       kaputt.py:1: error: '(' was never closed  [syntax]
       Found 1 error in 1 file (errors prevented further checking)   rc 2
   Dieselbe Form hat der Duplicate-Module-Abbruch, der diesen Baum ohne den
   `dist`-Ausschluss in `pyproject.toml` trifft. Beide sehen aus wie „ein
   Fehler gefunden" und bedeuten „nichts angesehen". Wuerde der Riegel das
   gegen die Baseline vergleichen, meldete er **67 behoben** und rc 0 — gruen,
   weil er blind war. Darum ist rc 2 ein Abbruch, kein Urteil.

4. Fehlt mypy, endet `python -m mypy` mit **rc 1 und leerem stdout** (gemessen)
   — derselbe Code wie „es gibt Typfehler". Genau die Luecke, die im
   Ruff-Riegel der gegnerische Pruefer fand (F2). Gegenzeuge ist die
   Summenzeile: rc 1 ohne `Found N errors in M files` ist ein fehlendes Modul.

Warum der Schluessel KEINE Zeilennummer traegt: dieselbe Begruendung wie beim
Ruff-Riegel — eine Verschiebung ist keine Aenderung am Befund, und ein Riegel,
der bei jeder Verschiebung anschlaegt, wird weggeklickt. Der Schluessel ist
`pfad:FEHLERCODE`, aber MIT Vielfachheit: ein ZWEITER `union-attr` in derselben
Datei ist ein neuer Eintrag.

Warum Vorwaerts-Schraegstriche: mypy druckt auf Windows `webtool\\app.py`, auf
Linux `webtool/app.py`. Ohne Normalisierung waere jede Zeile ungleich, sobald
Baseline und Riegel auf verschiedenen Plattformen laufen.

    python scripts/mypy_riegel.py              vergleichen, rc 1 bei neuen Befunden
    python scripts/mypy_riegel.py --schreiben  Baseline neu erzeugen
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

STAMM = Path(__file__).resolve().parent.parent
BASELINE = STAMM / ".mypy-baseline.txt"

# `pfad:zeile: error: Rest`. Der Pfad ist nicht-gierig, damit ein
# Laufwerksbuchstabe (`C:\Users\...`) nicht als Zeilennummer durchgeht.
#
# Das woertliche `: error: ` ist die Falle-1-Abwehr: `: note: ` sieht sonst
# genauso aus und traegt bei `annotation-unchecked` sogar einen Klammercode.
_BEFUND = re.compile(r"^(?P<pfad>.+?):\d+: error: (?P<rest>.*)$")

# Der Fehlercode steht am ZEILENENDE, und nur dort darf er gesucht werden: die
# Meldung selbst enthaelt Klammern (`Need type annotation for "y" (hint: "y:
# list[<type>] = ...")`), ein Muster ohne `$` griffe `[<type>]`.
_CODE = re.compile(r"\[(?P<code>[a-z][a-z0-9-]*)\]$")

# mypys Schlusszeile — der Gegenzeuge zum Muster darueber. Ohne sie heisst es
# `Success: no issues found in N source files`, dann sind es null.
# Kein `$`: der Rest der Zeile ist `(checked N source files)` oder
# `(errors prevented further checking)`, und beide sollen matchen.
_SUMME = re.compile(r"^Found (?P<zahl>\d+) errors? in \d+ files?\b")

_SAUBER = "Success: no issues found"

# Wie viele Dateien mypy ANGESEHEN hat. Zwei Formen, weil mypy die Zahl bei
# Befunden in Klammern hinter die Summenzeile haengt und bei einem sauberen Baum
# in den Erfolgssatz schreibt:
#     Found 65 errors in 18 files (checked 60 source files)
#     Success: no issues found in 60 source files
# Beim Abbruch steht dort `(errors prevented further checking)` und gar keine
# Zahl — dieser Fall faellt schon vorher durch `unstimmig`.
_GEPRUEFT = re.compile(r"\(checked (?P<zahl>\d+) source files?\)")
_GEPRUEFT_SAUBER = re.compile(r"^Success: no issues found in (?P<zahl>\d+) source files?")

# Kopfzeile der Baseline. Sie traegt die Dateizahl des Laufs, aus dem die
# Baseline stammt — der zweite Waechter neben der Befundmenge (siehe
# `zu_wenig_gesehen`).
_KOPF = re.compile(r"^# geprueft (?P<zahl>\d+) Dateien$")

# mypys eigenes Abbruchwort. rc 2 faengt denselben Fall schon ab; diese Marke
# ist der zweite Riegel fuer den Tag, an dem mypy dabei mit 1 endet.
_ABBRUCH = "errors prevented further checking"

# Ein Fehler ohne Klammercode. Gemessen kommt das mit 2.3.1 nicht vor (selbst
# Syntaxfehler tragen `[syntax]`) — die Marke steht trotzdem, weil genau diese
# Annahme den Ruff-Riegel erwischt hat: dort hiess `invalid-syntax` ploetzlich
# anders als jeder andere Befund, fiel aus dem Muster und verschwand lautlos.
OHNE_CODE = "ohne-code"


def schluessel(zeile: str) -> str | None:
    """Eine mypy-Zeile auf `pfad/mit/slashes.py:CODE` bringen, sonst None.

    None ist die Antwort fuer alles, was kein FEHLER ist: `note:`-Zeilen (auch
    die mit Klammercode), die Summenzeile, `Success: …` und Leerzeilen.
    """
    treffer = _BEFUND.match(zeile.strip())
    if treffer is None:
        return None
    code = _CODE.search(treffer["rest"].strip())
    kennung = code["code"] if code else OHNE_CODE
    return f"{treffer['pfad'].replace(chr(92), '/')}:{kennung}"


def schluessel_liste(ausgabe: str) -> list[str]:
    """Die ganze mypy-Ausgabe in die sortierte Schluesselliste."""
    return sorted(s for s in map(schluessel, ausgabe.splitlines()) if s)


def summenzeile(ausgabe: str) -> int | None:
    """Mypys eigene Zahl — oder None, wenn er gar keine Summenzeile gedruckt hat.

    Der Unterschied zwischen „null Befunde" und „hat nichts gesagt" traegt den
    Riegel gegen ein fehlendes mypy (siehe `unstimmig`); `gemeldete_zahl` wirft
    ihn absichtlich weg, die Stimmigkeitsprobe braucht ihn.
    """
    for zeile in ausgabe.splitlines():
        treffer = _SUMME.match(zeile.strip())
        if treffer:
            return int(treffer["zahl"])
    return None


def gepruefte_dateien(ausgabe: str) -> int | None:
    """Wie viele Dateien mypy angesehen hat — oder None, wenn es das nicht sagt.

    None ist die ehrliche Antwort und darf NICHT als 0 durchgehen: beim Abbruch
    druckt mypy `(errors prevented further checking)` statt der Zahl, und 0
    waere dort eine Behauptung ueber einen Lauf, der nichts gemessen hat.
    """
    for zeile in ausgabe.splitlines():
        treffer = _GEPRUEFT.search(zeile) or _GEPRUEFT_SAUBER.match(zeile.strip())
        if treffer:
            return int(treffer["zahl"])
    return None


def zu_wenig_gesehen(ausgabe: str, kopfzahl: int | None) -> str | None:
    """Hat mypy WENIGER Dateien angesehen als beim Erzeugen der Baseline? Dann der Grund.

    Der vierte Fall, den der Riegel bis zum kalten Review (F2) nicht kannte —
    und er ist nicht Schweigen, sondern LEISERES SPRECHEN: eine in sich stimmige
    Summenzeile ueber einen kleineren Baum. Gemessen mit echtem mypy:

        python -m mypy . --exclude '^webtool/' --follow-imports=silent
        -> rc 1, `Found 5 errors in 2 files (checked 16 source files)`
        -> Riegel ohne diesen Waechter: „60 Typfehler behoben … Kein Fehler", rc 0

    Es braucht dafuer keinen Absturz, nur eine Zeile mehr in `[tool.mypy]`
    (`exclude`, `files`, `follow_imports`) oder ein `# mypy: ignore-errors` am
    Dateikopf. `unstimmig` sieht davon nichts, `fehlende_zeilen` auch nicht:
    beide pruefen die FORM der Ausgabe, und die Form ist tadellos.

    Dieselbe Konstruktion wie beim OSV-Scan (#284), aus demselben Grund: dort
    stehen ZWEI Waechter — mindestens 100 Pakete UND das cu128-Suffix —, „weil
    die Zahl nichts ueber die Eigenschaft sagt". Hier war es umgekehrt: der
    Riegel hatte die Eigenschaft (stimmige Form) und keine Zahl.

    Die Untergrenze steht in der Baseline-Kopfzeile und wird mit `--schreiben`
    fortgeschrieben. Faellt die Zahl, weil jemand wirklich eine `.py` geloescht
    hat, ist `--schreiben` die Antwort — dieselbe wie bei jeder anderen
    gewollten Aenderung an der Baseline; die Meldung sagt das.
    """
    if kopfzahl is None:
        return (
            f"{BASELINE.name} hat keine Kopfzeile `# geprueft N Dateien` — sie "
            "stammt aus einer aelteren Fassung des Riegels. Einmal mit "
            "--schreiben erneuern."
        )
    jetzt = gepruefte_dateien(ausgabe)
    if jetzt is None:
        return "mypy hat nicht gesagt, wie viele Dateien es angesehen hat"
    if jetzt < kopfzahl:
        return (
            f"mypy hat {jetzt} Dateien angesehen, die Baseline stammt aus einem "
            f"Lauf ueber {kopfzahl}. Ein Lauf ueber weniger Dateien meldet die "
            "fehlenden Befunde als behoben, und das ist kein Fortschritt, sondern "
            "ein kleinerer Baum. Ursache suchen (exclude, files, follow_imports, "
            "ein ignore-errors-Kommentar am Dateikopf); ist die Verkleinerung "
            "gewollt, mit --schreiben nachziehen."
        )
    return None


def gemeldete_zahl(ausgabe: str) -> int:
    """Was MYPY selbst zaehlt. Ohne Summenzeile null (`Success: …`)."""
    zahl = summenzeile(ausgabe)
    return 0 if zahl is None else zahl


def unstimmig(rc: int, ausgabe: str) -> str | None:
    """Passt mypys Rueckgabecode zu dem, was er gedruckt hat? Sonst der Grund.

    Vier Faelle, alle gemessen (2026-09-04, mypy 2.3.1):

    * `python -m mypy` OHNE installiertes mypy endet mit **rc 1 und leerem
      stdout** — derselbe Code wie „es gibt Typfehler". Ohne diese Probe waere
      `befunde` leer, die ganze Baseline gaelte als „behoben", und der Riegel
      meldete rc 0. Die Zaehlprobe in `fehlende_zeilen` hilft dagegen NICHT:
      ohne Summenzeile ist auch die erwartete Zahl null.
    * rc 0 ohne `Success: no issues found` — mypy sagt sonst immer etwas.
    * `errors prevented further checking` — der Lauf hat abgebrochen, bevor er
      fertig war (Syntaxfehler, Duplicate Module). Heute traegt so ein Lauf
      schon rc 2 und faellt ohnehin durch; die Marke ist der Riegel fuer den
      Tag, an dem mypy das aendert.
    * **Jeder andere Rueckgabecode**, insbesondere rc 2 mit LEEREM stdout.
      Nachtrag des kalten Reviews (F1), und er schliesst eine echte Luecke: eine
      ungueltige Regex in `[tool.mypy] exclude` beendet mypy mit rc 2, stdout
      leer, Meldung nur auf stderr — gemessen:
          error: The exclude ^( is an invalid regular expression …
      Der Fall hing sonst allein an `mypy_lauf`s `returncode not in (0, 1)`, und
      der sieht neben `unstimmig` redundant aus. Faellt er bei einem Umbau,
      meldet der Riegel „65 Typfehler behoben" und rc 0 — gruen, weil er nichts
      gesehen hat. Jetzt hat die Entscheidung EINE Heimat, und die Meldung
      benennt den Absturz, statt ueber ihn zu schweigen.
    """
    if rc == 1 and summenzeile(ausgabe) is None:
        return (
            "mypy endete mit 1, druckte aber keine Zeile `Found N errors in M "
            "files` — so sieht ein fehlendes Modul aus, nicht ein Typfehler "
            "(oder eine Ausgabeform mit Farbcodes, etwa unter MYPY_FORCE_COLOR)"
        )
    if rc == 0 and _SAUBER not in ausgabe:
        return "mypy endete mit 0, druckte aber kein `Success: no issues found`"
    if _ABBRUCH in ausgabe:
        return (
            "mypy meldet `errors prevented further checking` — der Lauf hat "
            "abgebrochen, statt den Baum zu pruefen"
        )
    if rc not in (0, 1):
        return (
            f"mypy endete mit {rc} — das ist kein Urteil ueber den Baum, sondern "
            "ein Abbruch von mypy selbst (kaputte Konfiguration, unlesbare Datei)"
        )
    return None


def fehlende_zeilen(ausgabe: str, befunde: list[str]) -> int:
    """Wie viele Fehler mypy meldet, die der Riegel NICHT verstanden hat.

    Der eigentliche Riegel gegen die eigene Blindheit: ein Muster, das eine
    Ausgabeform nicht kennt, laesst sie lautlos verschwinden — und ein leiser
    Riegel ist gruen, weil er nichts gesehen hat. Mypys eigene Summenzeile ist
    der Gegenzeuge; weichen die Zahlen ab, bricht der Lauf ab, statt zu urteilen.

    Faengt unter anderem den Fehler OHNE Zeilennummer:
        webtool/__init__.py: error: Duplicate module named "webtool"
    Der faellt aus `_BEFUND` (keine `:zeile:`), und die Zahlen gehen auseinander.
    """
    return gemeldete_zahl(ausgabe) - len(befunde)


# ponytail: Schluessel ist (Datei, Fehlercode) mit Vielfachheit — ein TAUSCH
# innerhalb eines Schluessels faellt durch, genau wie beim Ruff-Riegel. Der
# Ausweg waere ein Fingerabdruck der Meldung statt des Codes allein; der macht
# dann aber jede Umformulierung durch eine neue mypy-Fassung rot. Umbauen, wenn
# so ein Tausch real passiert ist — nicht vorher.
def vergleich(neu: list[str], alt: list[str]) -> tuple[list[str], list[str]]:
    """(neue, entfallene) — mit Vielfachheit, damit ein zweiter Befund zaehlt."""
    n, a = Counter(neu), Counter(alt)
    return sorted((n - a).elements()), sorted((a - n).elements())


def mypy_lauf() -> str:
    """mypy im Repo-Stamm fahren und seine Befundausgabe zurueckgeben.

    `.` statt einer Dateiliste: die Auswahl steht damit in `pyproject.toml`
    (`[tool.mypy] exclude`) an EINER Stelle, und eine neue Datei ist von selbst
    mitgeprueft — ein Riegel mit gepflegter Dateiliste uebersieht genau das,
    was frisch dazukommt.
    """
    # Feste Argumentliste, eigener Interpreter, keine Shell, keine Eingabe von
    # aussen. (Eine Unterdrueckung `noqa: S603` stand hier und war
    # ueberfluessig: gemessen mit `ruff check --extend-select RUF100` →
    # „Unused directive (unused: S603)". Was nichts unterdrueckt, behauptet eine
    # Gefahr, die der Linter nicht sieht — dieselbe Zeile fiel in
    # `ruff_riegel.py` aus demselben Grund weg.
    #
    # Das Doppelkreuz fehlt hier mit Absicht: ruff liest die Marke AUCH mitten
    # in Prosa und meldet dann „Invalid directive … expected code to consist of
    # uppercase letters followed by digits only". Genau das tat die Schwester-
    # datei seit PR #547 bei jedem cachefreien Lauf — also in jeder CI, wo es
    # keinen Cache gibt; lokal verdeckte ihn `.ruff_cache`, weshalb es niemand
    # sah. Nachgemessen mit `ruff check scripts/ruff_riegel.py --no-cache`.)
    lauf = subprocess.run(
        [sys.executable, "-m", "mypy", "."],
        cwd=STAMM,
        capture_output=True,
        text=True,
        check=False,
    )
    # 0 = sauber, 1 = Befunde — aber NUR, wenn die Ausgabe dazu passt. Alles
    # andere ist ein Fehler von mypy SELBST (Syntaxfehler, Duplicate Module,
    # kaputte Konfiguration, fehlende Fassung), und ein Riegel, der das als
    # „keine neuen Befunde" liest, ist gruen, weil er nichts gesehen hat.
    grund = unstimmig(lauf.returncode, lauf.stdout)
    if lauf.returncode not in (0, 1) or grund:
        if grund:
            sys.stderr.write(grund + "\n")
        sys.stderr.write(lauf.stderr or lauf.stdout)
        raise SystemExit(2)
    return lauf.stdout


def main(argv: list[str]) -> int:
    """Der Riegel. Rueckgabecode ist der Vertrag:

    0 — kein Schluessel haeufiger als in der Baseline (Behobenes wird gemeldet,
        macht nicht rot)
    1 — mindestens ein Schluessel `pfad:CODE` haeufiger als in der Baseline
    2 — der Riegel selbst ist nicht urteilsfaehig: mypy fehlt oder bricht ab
        (`unstimmig`), eine Ausgabeform wurde nicht verstanden
        (`fehlende_zeilen`), mypy hat WENIGER Dateien angesehen als beim
        Erzeugen der Baseline (`zu_wenig_gesehen`), oder es gibt noch gar keine
        Baseline

    Die Trennung von 1 und 2 ist der Kern: „ich habe einen Fehler gefunden" und
    „ich konnte nicht hinsehen" duerfen nicht gleich aussehen — sonst ist ein
    kaputter Riegel von einem sauberen Baum nicht zu unterscheiden. Bei mypy
    ist dieser Fall nicht theoretisch: ein einziger Syntaxfehler irgendwo im
    Baum beendet den ganzen Lauf mit rc 2 und einer Zeile, die wie ein Ergebnis
    aussieht.

    „Haeufiger als in der Baseline" ist woertlich zu nehmen und NICHT dasselbe
    wie „ein Befund, den die Baseline nicht kennt": ein TAUSCH innerhalb eines
    Schluessels laesst die Zahl gleich und damit den Riegel gruen. Warum die
    Position trotzdem nicht in den Schluessel wandert, steht bei `vergleich`.
    """
    ausgabe = mypy_lauf()
    befunde = schluessel_liste(ausgabe)

    fehlend = fehlende_zeilen(ausgabe, befunde)
    if fehlend != 0:
        sys.stderr.write(
            f"mypy meldet {gemeldete_zahl(ausgabe)} Fehler, verstanden wurden "
            f"{len(befunde)} — der Riegel kennt eine Ausgabeform nicht und wuerde "
            "sie stillschweigend uebergehen. Muster in scripts/mypy_riegel.py "
            "nachziehen.\n"
        )
        return 2

    if "--schreiben" in argv:
        kopf = f"# geprueft {gepruefte_dateien(ausgabe)} Dateien"
        BASELINE.write_text(
            "\n".join([kopf, *befunde]) + "\n", encoding="utf-8", newline="\n"
        )
        print(f"{BASELINE.name}: {len(befunde)} Eintraege geschrieben ({kopf[2:]})")
        return 0

    if not BASELINE.exists():
        print(f"{BASELINE.name} fehlt — einmal mit --schreiben erzeugen.")
        return 2

    zeilen = [z for z in BASELINE.read_text(encoding="utf-8").splitlines() if z.strip()]
    kopftreffer = next((_KOPF.match(z) for z in zeilen if _KOPF.match(z)), None)
    kopfzahl = int(kopftreffer["zahl"]) if kopftreffer else None

    # ZWEITER Waechter neben der Befundmenge: hat mypy ueberhaupt so viel
    # angesehen wie beim Erzeugen der Baseline? Ein Teil-Lauf ist in der Form
    # tadellos und liest sich als Fortschritt (kalter Review, F2).
    zu_wenig = zu_wenig_gesehen(ausgabe, kopfzahl)
    if zu_wenig:
        sys.stderr.write(zu_wenig + "\n")
        return 2

    alt = [z for z in zeilen if not z.startswith("#")]
    neue, entfallene = vergleich(befunde, alt)

    for eintrag in entfallene:
        print(f"behoben  {eintrag}")
    for eintrag in neue:
        print(f"NEU      {eintrag}")

    if neue:
        print(
            f"\n{len(neue)} neue(r) Typfehler. Beheben — oder, wenn gewollt, mit "
            "`python scripts/mypy_riegel.py --schreiben` in die Baseline nehmen."
        )
        return 1

    # Behobenes macht NICHT rot: ein Riegel, der das Aufraeumen bestraft, wird
    # umgangen. Die Baseline haengt dann hinterher, und genau das steht da.
    if entfallene:
        print(
            f"\n{len(entfallene)} Typfehler behoben, Baseline haengt hinterher — "
            "mit --schreiben nachziehen. Kein Fehler."
        )
    else:
        print(f"{len(befunde)} bekannte Typfehler, keine neuen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
