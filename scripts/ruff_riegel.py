#!/usr/bin/env python3
"""Ruff-Riegel: rot, sobald ein NEUER Lint-Befund dazukommt.

Bis hierher lief ruff in diesem Repo nirgends automatisch — nicht in
`.github/workflows/`, nicht im `pre-commit`-Hook, nicht in einem npm-Skript.
Gepinnt war er trotzdem (`pyproject.toml`, `[dependency-groups]`), und Renovate
hat die Fassung gepflegt: zuletzt #543 auf 0.16.6. Ein Werkzeug, dessen Fassung
gepflegt wird und das nie laeuft, ist Dekoration.

Warum eine Baseline und nicht schlicht `ruff check .` als Riegel: der Baum traegt
132 Befunde (I001 51 · E702 20 · S603 13 · E401 10 · B904 9 · F401 6 · Rest 23,
gemessen 2026-09-03 mit 0.16.6). Ein Riegel, der ab Tag eins rot ist, wird
abgeschaltet — dieselbe Ueberlegung, die in `pyproject.toml` schon die 2357
S101-Befunde aus den Testdateien genommen hat.

Warum der Schluessel KEINE Zeilennummer traegt: `.ruff-baseline.txt` stand seit
`16d129a` unveraendert, und ein Vergleich gegen sie haette trotzdem angeschlagen —
`webtool/whispercpp.py` S603 war von Zeile 356 auf 396 gewandert, ohne dass sich am
Befund etwas geaendert hat (review-502.md, F5). Ein Riegel, der bei jeder
Verschiebung anschlaegt, meldet Rauschen und wird weggeklickt. Der Schluessel ist
deshalb `pfad:REGEL`, aber MIT Vielfachheit: ein ZWEITER S603 in derselben Datei
ist ein neuer Eintrag.

Der Preis dafuer, benannt statt verschwiegen (CodeRabbit-CLI, 2026-09-03): ein
TAUSCH innerhalb derselben (Datei, Regel) bleibt unsichtbar. Wer einen S603 in
`whispercpp.py` entfernt und an anderer Stelle derselben Datei einen neuen
einbaut, laesst die Zahl gleich — und den Riegel gruen. Festgenagelt in
`test_tausch_innerhalb_derselben_datei_und_regel_bleibt_unsichtbar`, damit die
Entscheidung beim naechsten Umbau gelesen statt neu getroffen wird.

Warum Vorwaerts-Schraegstriche: ruff druckt auf Windows `webtool\\app.py`, auf Linux
`webtool/app.py`. Ohne Normalisierung waeren ALLE Zeilen ungleich, sobald Baseline
und Riegel auf verschiedenen Plattformen laufen — genau so ist der erste Diff in
review-502 F5 ausgegangen.

    python scripts/ruff_riegel.py              vergleichen, rc 1 bei neuen Befunden
    python scripts/ruff_riegel.py --schreiben  Baseline neu erzeugen
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

STAMM = Path(__file__).resolve().parent.parent
BASELINE = STAMM / ".ruff-baseline.txt"

# `pfad:zeile:spalte: KENNUNG Rest`. Der Pfad ist nicht-gierig, damit ein
# Laufwerksbuchstabe (`E:\Git\...`) nicht als Zeilennummer durchgeht.
#
# Die KENNUNG ist bewusst NICHT `[A-Z]+\d+`. Ein Syntaxfehler heisst bei ruff
# `invalid-syntax` und traegt gar keinen Regelcode — gemessen:
#     syntax.py:1:12: invalid-syntax: Expected a parameter or the end of the …
#     Found 2 errors.                                   (ruff rc = 1)
# Mit dem engen Muster fiel diese Zeile aus dem Vergleich, `ruff_lauf()` nahm
# rc 1 als „es gibt eben Befunde" hin, und der Riegel meldete „keine neuen" mit
# rc 0. Eine .py mit Syntaxfehler, die kein Test importiert, waere gruen durch
# die CI gegangen (gefunden vom kalten Zweitleser, 2026-09-03, mit Beleg).
_BEFUND = re.compile(r"^(?P<pfad>.+?):\d+:\d+: (?P<regel>[A-Za-z][A-Za-z0-9-]*)\b")

# Ruffs Schlusszeile — der Gegenzeuge zum Muster darueber. Ohne sie heisst es
# „All checks passed!", dann sind es null.
_SUMME = re.compile(r"^Found (?P<zahl>\d+) errors?\.$")


def schluessel(zeile: str) -> str | None:
    """Eine ruff-Zeile auf `pfad/mit/slashes.py:REGEL` bringen, sonst None.

    None ist die Antwort fuer alles, was kein Befund ist: die Summenzeilen
    (`Found 199 errors.`, `[*] 77 fixable with the --fix option …`),
    `All checks passed!` und Leerzeilen.
    """
    treffer = _BEFUND.match(zeile.strip())
    if treffer is None:
        return None
    return f"{treffer['pfad'].replace(chr(92), '/')}:{treffer['regel']}"


def schluessel_liste(ausgabe: str) -> list[str]:
    """Die ganze ruff-Ausgabe in die sortierte Schluesselliste."""
    return sorted(s for s in map(schluessel, ausgabe.splitlines()) if s)


def gemeldete_zahl(ausgabe: str) -> int:
    """Was RUFF selbst zaehlt. Ohne Summenzeile null (`All checks passed!`)."""
    for zeile in ausgabe.splitlines():
        treffer = _SUMME.match(zeile.strip())
        if treffer:
            return int(treffer["zahl"])
    return 0


def fehlende_zeilen(ausgabe: str, befunde: list[str]) -> int:
    """Wie viele Befunde ruff meldet, die der Riegel NICHT verstanden hat.

    Der eigentliche Riegel gegen die eigene Blindheit: ein Muster, das eine
    Ausgabeform nicht kennt, laesst sie lautlos verschwinden — und ein leiser
    Riegel ist gruen, weil er nichts gesehen hat. Ruffs eigene Summenzeile ist
    der Gegenzeuge; weichen die Zahlen ab, bricht der Lauf ab, statt zu urteilen.
    """
    return gemeldete_zahl(ausgabe) - len(befunde)


# ponytail: Schluessel ist (Datei, Regel) mit Vielfachheit — ein TAUSCH innerhalb
# eines Schluessels faellt durch. Der Ausweg waere ein Fingerabdruck der Quellzeile
# statt der Regel allein; der macht dann aber JEDE Umformatierung einer Zeile mit
# bekanntem Befund rot, und webtool/app.py traegt 13 davon. Genau daran stirbt ein
# Riegel. Umbauen, wenn so ein Tausch real passiert ist — nicht vorher.
def vergleich(neu: list[str], alt: list[str]) -> tuple[list[str], list[str]]:
    """(neue, entfallene) — mit Vielfachheit, damit ein zweiter S603 zaehlt."""
    n, a = Counter(neu), Counter(alt)
    return sorted((n - a).elements()), sorted((a - n).elements())


def ruff_lauf() -> str:
    """ruff im Repo-Stamm fahren und seine Befundausgabe zurueckgeben."""
    # Feste Argumentliste, eigener Interpreter, keine Shell, keine Eingabe von
    # aussen — deshalb ist S603 hier nachweislich kein Fund, sondern Rauschen.
    lauf = subprocess.run(  # noqa: S603
        [sys.executable, "-m", "ruff", "check", ".", "--output-format=concise"],
        cwd=STAMM,
        capture_output=True,
        text=True,
        check=False,
    )
    # 0 = sauber, 1 = Befunde. Alles andere ist ein Fehler von ruff SELBST
    # (kaputte Konfiguration, fehlende Fassung, unbekannter Schalter) — und ein
    # Riegel, der das als "keine Befunde" liest, ist gruen, weil er nichts
    # gesehen hat. Das ist die Fehlerklasse hinter `CodeRabbit pass` bei
    # erschoepftem Kontingent und hinter `tests 0` in scripts/testlauf.mjs.
    if lauf.returncode not in (0, 1):
        sys.stderr.write(lauf.stderr or lauf.stdout)
        raise SystemExit(2)
    return lauf.stdout


def main(argv: list[str]) -> int:
    ausgabe = ruff_lauf()
    befunde = schluessel_liste(ausgabe)

    fehlend = fehlende_zeilen(ausgabe, befunde)
    if fehlend != 0:
        sys.stderr.write(
            f"ruff meldet {gemeldete_zahl(ausgabe)} Befunde, verstanden wurden "
            f"{len(befunde)} — der Riegel kennt eine Ausgabeform nicht und wuerde "
            "sie stillschweigend uebergehen. Muster in scripts/ruff_riegel.py "
            "nachziehen.\n"
        )
        return 2

    if "--schreiben" in argv:
        BASELINE.write_text("\n".join(befunde) + "\n", encoding="utf-8", newline="\n")
        print(f"{BASELINE.name}: {len(befunde)} Eintraege geschrieben")
        return 0

    if not BASELINE.exists():
        print(f"{BASELINE.name} fehlt — einmal mit --schreiben erzeugen.")
        return 2

    alt = [z for z in BASELINE.read_text(encoding="utf-8").splitlines() if z.strip()]
    neue, entfallene = vergleich(befunde, alt)

    for eintrag in entfallene:
        print(f"behoben  {eintrag}")
    for eintrag in neue:
        print(f"NEU      {eintrag}")

    if neue:
        print(
            f"\n{len(neue)} neue(r) Lint-Befund(e). Beheben — oder, wenn gewollt, mit "
            "`python scripts/ruff_riegel.py --schreiben` in die Baseline nehmen."
        )
        return 1

    # Behobenes macht NICHT rot: ein Riegel, der das Aufraeumen bestraft, wird
    # umgangen. Die Baseline haengt dann hinterher, und genau das steht da.
    if entfallene:
        print(
            f"\n{len(entfallene)} Befund(e) behoben, Baseline haengt hinterher — "
            "mit --schreiben nachziehen. Kein Fehler."
        )
    else:
        print(f"{len(befunde)} bekannte Befunde, keine neuen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
