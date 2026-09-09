#!/usr/bin/env python3
"""Wirkungstest der drei `packageRules` in `renovate.json` (#539).

Die drei Regeln sind stiller Code: faellt eine aus -- Umbenennung eines Abbilds,
geaenderte Feldsemantik, ein Tippfehler in `matchPackageNames` --, merkt das
niemand. Es kommt einfach ein Vorschlag mehr, oder nie wieder einer. Bei der
Postgres-Regel ist die Richtung besonders unangenehm: faellt sie aus, schlaegt
Renovate ein Datenbank-Major fuer die Wiederherstellungsvorlage eines Live-Servers vor.

DIESER TEST PRUEFT DIE WIRKUNG, NICHT DIE FORM. Entscheidung Marcus 2026-09-09.
Der billige Weg -- `renovate-config-validator` -- prueft nur die Syntax, und ein
`matchPackageNames: "postgress"` ist syntaktisch tadellos. Das `Fertig-wenn` von
#539 verlangt ausdruecklich einen Lauf, der bei genau diesem Tippfehler rot wird.

Gefahren wird die ECHTE `renovate.json` gegen ein Wegwerf-Repo, nie eine Kopie
der Regeln: eine Nachbildung koennte von der Datei abdriften, und dann prueft der
Test seine eigene Fixture.

Rueckgabecodes -- derselbe Vertrag wie `ruff_riegel.py` und `mypy_riegel.py`:
  0  alle drei Regeln wirken
  1  mindestens eine Regel wirkt NICHT
  2  NICHT URTEILSFAEHIG (npx fehlt, kein Token, unbekannte Ausgabeform)

DREI FALLEN, alle GEMESSEN am 2026-09-09, und jede davon hat den Lauf schon
einmal gruen aussehen lassen, ohne dass er etwas gesehen hat:

1. **Renovate zaehlt die Dateien ueber git auf.** Ein Wegwerf-Repo ohne Commit
   ergibt `Found 0 package file(s)` und rc 0 -- ein Lauf, der NICHTS ansieht und
   sich nicht beschwert. Deshalb `git add` + `git commit` in der Fixture, und
   deshalb prueft `unstimmig()` genau auf diese Zeile.
2. **Ohne GitHub-Token ist die Python-Regel unfalsifizierbar.** Renovate meldet
   dann `skipReason: github-token-required` und liefert fuer den Dep gar keine
   Aktualisierung -- MIT UND OHNE Regel. Die Zusicherung waere gruen geblieben,
   auch wenn die Regel geloescht ist: ein vacuous guard, den keine Mutationsprobe
   je rot bekommt. Gefunden vom kalten Plan-Pruefer, bevor eine Zeile davon stand.
3. **`renovate@latest` (44.x) verlangt node ^24.11 und stirbt auf node 22 mit
   rc 0 UND OHNE JEDE AUSGABE.** Deshalb ist die Fassung gepinnt und die
   Ausgabeform wird gegen den Rueckgabecode geprueft.

Aufruf:
    python scripts/renovate_regeln.py
    python scripts/renovate_regeln.py --behalten   # Fixture stehen lassen
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

STAMM = Path(__file__).resolve().parents[1]

# Gepinnt, nicht `latest`: siehe Falle 3 im Kopf. 41.173.1 ist auf node 22
# (Entwicklerrechner) UND node 24 (CI) gemessen.
RENOVATE = "renovate@41.173.1"

# Renovate laedt bei jedem Lauf sein Paket und fragt Registries ab; der gemessene
# Lauf lag bei ~40 s. Die Grenze ist Deckel, nicht Erwartung.
FRIST = 600

_FLACH = re.compile(r"(\d+) flattened updates found:(?P<namen>[^(]*)\(repository=")

COMPOSE = "services:\n  db:\n    image: postgres:17\n"

WORKFLOW = (
    "name: x\n"
    "on: push\n"
    "jobs:\n"
    "  a:\n"
    "    runs-on: ubuntu-latest\n"
    "    steps:\n"
    "      - uses: actions/setup-python@v6\n"
    "        with:\n"
    "          python-version: '3.12'\n"
)

# `lucide-react` ist die KONTROLLE zu Regel 1: es muss im Sammelbuendel landen,
# waehrend `@vitejs/plugin-react` seinen eigenen Zweig bekommt. Ohne die Kontrolle
# koennte die Zusicherung auch dann gruen sein, wenn gar nicht mehr gebuendelt wird.
PAKET = {
    "name": "wegwerf",
    "private": True,
    "devDependencies": {"@vitejs/plugin-react": "6.0.3", "lucide-react": "0.500.0"},
}


def token() -> str:
    """Ein GitHub-Token, sonst ist Regel 2 nicht pruefbar (Falle 2 im Kopf)."""
    for name in ("GITHUB_COM_TOKEN", "GITHUB_TOKEN", "RENOVATE_TOKEN"):
        wert = os.environ.get(name)
        if wert:
            return wert
    gh = shutil.which("gh")
    if not gh:
        return ""
    fertig = subprocess.run([gh, "auth", "token"], capture_output=True, text=True)
    return fertig.stdout.strip() if fertig.returncode == 0 else ""


def baue_fixture(ziel: Path) -> None:
    """Ein Wegwerf-Repo mit allen drei Regelformen, samt der ECHTEN renovate.json."""
    (ziel / "docs/bugsink").mkdir(parents=True)
    (ziel / "docs/andere").mkdir(parents=True)
    (ziel / ".github/workflows").mkdir(parents=True)
    # Zwei Compose-Dateien: die geschuetzte und eine Kontrolle an anderem Pfad.
    # Ohne die Kontrolle waere nicht zu unterscheiden, ob `matchFileNames` wirkt
    # oder die Regel einfach jedes postgres stummschaltet.
    (ziel / "docs/bugsink/compose.yaml").write_text(COMPOSE, encoding="utf-8")
    (ziel / "docs/andere/compose.yaml").write_text(COMPOSE, encoding="utf-8")
    (ziel / ".github/workflows/x.yml").write_text(WORKFLOW, encoding="utf-8")
    (ziel / "package.json").write_text(json.dumps(PAKET, indent=2), encoding="utf-8")
    shutil.copy(STAMM / "renovate.json", ziel / "renovate.json")

    git = shutil.which("git")
    if not git:
        raise RuntimeError("git nicht gefunden -- die Fixture braucht ein Repo")
    subprocess.run([git, "init", "-q"], cwd=ziel, check=True)
    subprocess.run([git, "add", "-A"], cwd=ziel, check=True)
    # `.invalid` ist die dafuer reservierte Spitzendomaene (RFC 2606) -- ein Commit
    # braucht eine Identitaet, und diese kann per Konstruktion niemandem gehoeren.
    subprocess.run(
        [git, "-c", "user.email=t@example.invalid", "-c", "user.name=t",
         "commit", "-qm", "fixture"],
        cwd=ziel, check=True,
    )


def flache_liste(ausgabe: str) -> list[str] | None:
    """Die Namen aus `N flattened updates found: a, b, c`, oder None.

    None heisst NICHT `keine Updates` -- es heisst `die Zeile stand nicht da`,
    und das ist ein Grund, nicht zu urteilen.
    """
    treffer = _FLACH.search(ausgabe)
    if not treffer:
        return None
    roh = treffer.group("namen").strip()
    return [n.strip() for n in roh.split(",") if n.strip()] if roh else []


def unstimmig(rc: int, ausgabe: str) -> str | None:
    """Der Riegel gegen das eigene Schweigen. Grund als Text, sonst None."""
    if "Found 0 package file(s)" in ausgabe:
        return ("Renovate hat NULL Paketdateien gesehen -- die Fixture ist nicht "
                "angekommen. Ein Urteil darueber waere die Luege.")
    treffer = _FLACH.search(ausgabe)
    if treffer is None:
        return (f"Keine Zeile `flattened updates found` in der Ausgabe (rc {rc}). "
                "Unbekannte Ausgabeform -- moeglicherweise falsche node- oder "
                "Renovate-Fassung.")
    namen = flache_liste(ausgabe) or []
    if int(treffer.group(1)) != len(namen):
        return (f"Renovate nennt {treffer.group(1)} Updates, aufgezaehlt sind "
                f"{len(namen)} -- die Ausgabeform hat sich geaendert.")
    if "github-token-required" in ausgabe:
        return ("Kein brauchbares GitHub-Token: Regel 2 (github-actions python) "
                "ist ohne Token unfalsifizierbar -- sie saehe mit und ohne Regel "
                "gleich aus. Setze GITHUB_COM_TOKEN oder melde dich mit gh an.")
    return None


def urteile(ausgabe: str) -> tuple[int, list[str]]:
    """Wirken die drei Regeln? Rein, damit der Test sie ohne Renovate fahren kann."""
    namen = flache_liste(ausgabe) or []
    zeilen: list[str] = []
    schlecht = False

    # Regel 1 -- eigener Zweig statt Sammelbuendel, samt Kontrolle.
    eigen = "renovate/vitejs-plugin-react" in ausgabe
    buendel = "renovate/all-minor-patch" in ausgabe
    if eigen and buendel:
        zeilen.append("ok   Regel 1: @vitejs/plugin-react hat einen eigenen Zweig, "
                      "die Kontrolle laeuft im Sammelbuendel")
    else:
        schlecht = True
        zeilen.append(f"FEHL Regel 1: eigener Zweig={eigen}, Sammelbuendel={buendel} "
                      "-- erwartet beides True")

    # Regel 2 -- die CI-Python-Fassung bekommt keine Vorschlaege.
    if "python" in namen:
        schlecht = True
        zeilen.append("FEHL Regel 2: `python` steht in der Update-Liste, die Regel "
                      "haelt es also nicht mehr zurueck")
    else:
        zeilen.append("ok   Regel 2: `python` bekommt keinen Vorschlag")

    # Regel 3 -- genau EIN postgres: das geschuetzte ist weg, die Kontrolle bleibt.
    wie_oft = namen.count("postgres")
    if wie_oft == 1:
        zeilen.append("ok   Regel 3: genau ein postgres-Major -- die Kontrolle; "
                      "docs/bugsink/compose.yaml ist gefiltert")
    else:
        schlecht = True
        grund = ("beide gefiltert -- matchFileNames greift zu breit" if wie_oft == 0
                 else "die Regel filtert nichts mehr")
        zeilen.append(f"FEHL Regel 3: {wie_oft} postgres-Majors statt einem ({grund})")

    return (1 if schlecht else 0), zeilen


def fahre(ziel: Path) -> tuple[int, str]:
    """Renovate gegen das Wegwerf-Repo. Rueckgabe: (rc, stdout+stderr)."""
    npx = shutil.which("npx")
    if not npx:
        return 127, "npx nicht gefunden"
    umgebung = dict(os.environ)
    umgebung["LOG_LEVEL"] = "debug"
    tok = token()
    if tok:
        umgebung["GITHUB_COM_TOKEN"] = tok
        umgebung["RENOVATE_TOKEN"] = tok
    try:
        fertig = subprocess.run(
            [npx, "--yes", RENOVATE, "--platform=local", "--dry-run=lookup"],
            cwd=ziel, capture_output=True, text=True, env=umgebung, timeout=FRIST,
        )
    except subprocess.TimeoutExpired:
        return 124, f"Renovate hat nach {FRIST}s nicht geantwortet"
    return fertig.returncode, fertig.stdout + fertig.stderr


def main(argv: list[str]) -> int:
    behalten = "--behalten" in argv
    ordner = tempfile.mkdtemp(prefix="renovate-regeln-")
    ziel = Path(ordner)
    try:
        baue_fixture(ziel)
        rc, ausgabe = fahre(ziel)
        if rc == 127:
            print("NICHT URTEILSFAEHIG: npx nicht gefunden.", file=sys.stderr)
            return 2
        grund = unstimmig(rc, ausgabe)
        if grund:
            print(f"NICHT URTEILSFAEHIG: {grund}", file=sys.stderr)
            return 2
        code, zeilen = urteile(ausgabe)
        for zeile in zeilen:
            print(zeile)
        print("\n" + ("Alle drei Regeln wirken." if code == 0
                      else "MINDESTENS EINE REGEL WIRKT NICHT -- siehe Zeilen oben."))
        return code
    finally:
        if behalten:
            print(f"Fixture bleibt stehen: {ziel}")
        else:
            shutil.rmtree(ziel, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
