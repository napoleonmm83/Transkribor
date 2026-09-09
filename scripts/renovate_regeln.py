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
  2  NICHT URTEILSFAEHIG (npx fehlt, kein Token, unbekannte Ausgabeform, Absturz)

JEDE ZUSICHERUNG BRAUCHT EINEN POSITIVEN BELEG, nicht nur eine Abwesenheit --
das ist die tragende Regel dieser Datei, und der erste Entwurf hat sie an drei
Stellen gebrochen. Ein gegnerisches Review hat sie ausgefuehrt statt gelesen:

* Der Riegel verbot `Found 0 package file(s)` und liess damit jede KLEINERE
  Menge durch. Mit einer Fixture ohne die Kontroll-Compose meldete Renovate
  `Found 3` -- und der Test sagte „Alle drei Regeln wirken". Das ist woertlich
  die #588-Klasse (`checked 16` statt 60): der Riegel schweigt nicht, er spricht
  leiser. Jetzt wird `Found 4` VERLANGT.
* Regel 3 zaehlte `postgres` genau einmal. Das unterscheidet „Kontrolle da,
  geschuetztes Abbild gefiltert" NICHT von „Kontrolle fehlt, nichts gefiltert" --
  die flache Liste traegt keinen Dateinamen. Jetzt zusaetzlich die Filterzeile.
* Regel 2 prueft eine ABWESENHEIT. Verschwindet der Dep aus einem anderen Grund
  (Ratengrenze, Netz weg, geaenderte Fixture), gilt die Regel als wirksam. Jetzt
  wird der positive Beleg verlangt, der im Lauf ohnehin steht: `skipReason:
  disabled` im selben Objekt wie `depName: python`.

DREI FALLEN DER UMGEBUNG, alle am 2026-09-09 gemessen:

1. **Renovate zaehlt die Dateien ueber git auf.** Ein Wegwerf-Repo ohne Commit
   ergibt `Found 0 package file(s)` und rc 0 -- ein Lauf, der NICHTS ansieht und
   sich nicht beschwert. Deshalb `git add` + `git commit` in der Fixture.
2. **Ohne GitHub-Token ist die Python-Regel unfalsifizierbar.** Renovate meldet
   dann `skipReason: github-token-required` und liefert fuer den Dep gar keine
   Aktualisierung -- MIT UND OHNE Regel. Gefunden vom kalten Plan-Pruefer, bevor
   eine Zeile davon stand.
3. **`renovate@latest` (44.x) verlangt node ^24.11 und stirbt auf node 22 mit
   rc 0 UND OHNE JEDE AUSGABE.** Deshalb ist die Fassung gepinnt.

Aufruf:
    GITHUB_COM_TOKEN=<token> python scripts/renovate_regeln.py
    python scripts/renovate_regeln.py --behalten   # Fixture stehen lassen
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

STAMM = Path(__file__).resolve().parents[1]

# Gepinnt, nicht `latest`: siehe Falle 3 im Kopf.
#
# GEMESSEN ist 41.173.1 auf **node 22** (Entwicklerrechner, 2026-09-09): laeuft,
# meldet seine Fassung, liefert die Lookup-Ausgabe. Auf **node 24** (CI) ist es
# NICHT gemessen -- der erste Lauf dieses Jobs ist die Messung. Faellt es dort
# aus, faellt es LAUT aus: `unstimmig()` fangt sowohl einen Abbruch als auch die
# stille rc-0-Form aus Falle 3.
RENOVATE = "renovate@41.173.1"

#: Wieviele Paketdateien Renovate in der Fixture sehen MUSS: zwei compose.yaml,
#: ein Workflow, ein package.json. Eine kleinere Zahl heisst, dass die Fixture
#: nicht vollstaendig angekommen ist -- und genau daran ist der erste Entwurf
#: dieses Riegels vorbeigelaufen.
ERWARTETE_DATEIEN = 4

# Renovate laedt bei jedem Lauf sein Paket und fragt Registries ab. GEMESSEN mit
# WARMEM npx-Zwischenspeicher: der markierte Test lief in 5,7 s. Ein kalter
# Zwischenspeicher laedt ~100 MB dazu und ist NICHT gestoppt.
#
# DIE ZAHL MUSS UNTER 300 LIEGEN, und das ist der ganze Grund fuer sie. Der
# erste Entwurf stand auf 600 -- unter pytest unerreichbar, weil
# `faulthandler_timeout = 300` (pyproject.toml) davor steht. Ein haengendes
# Renovate haette dort einen faulthandler-Stapelabzug mit **rc 1** ergeben, also
# „mindestens eine Regel wirkt nicht", und das Enkelkind waere weitergelaufen.
# In einem Paket, dessen ganzer Zweck ist, dass ein Rueckgabecode sagt was er
# meint, ist das die falsche Antwort. Gefunden vom blinden Zweitleser, ausgefuehrt
# belegt (`-o faulthandler_timeout=3`).
#
# Gestaffelt wie der Testdeckel in conftest.py, jede Stufe faengt was die
# darunter nicht sieht -- und nur die unteren beiden sagen, WO es klemmt:
#     240 s  dieser Lauf      eigene Meldung, rc 2 „nicht urteilsfaehig"
#     270 s  der Test         subprocess-Zeitgrenze, benennt das Kind
#     300 s  pytest           faulthandler-Abzug, rc 1
FRIST = 240

_FLACH = re.compile(r"(\d+) flattened updates found:(?P<namen>[^(]*)\(repository=")
_GEFUNDEN = re.compile(r"Found (\d+) package file\(s\)")
_GEFILTERT = re.compile(r"Filtered out (\d+) disabled update\(s\)")

# Der positive Beleg fuer Regel 2, so wie er im gemessenen Lauf steht: beide
# Felder im SELBEN Objekt des packageFiles-Dumps. `[^}]` haelt die Suche
# innerhalb des Objekts -- ohne das koennte sie ueber einen fremden Dep
# hinweggreifen und die Regel fuer wirksam halten, weil irgendwo anders etwas
# abgeschaltet ist.
_PYTHON_ABGESCHALTET = re.compile(
    r'"depName":\s*"python",[^}]{0,600}?"skipReason":\s*"disabled"', re.S
)
_PYTHON_ERKANNT = re.compile(r'"depName":\s*"python"')

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


class NichtUrteilsfaehig(Exception):
    """Ich konnte nicht hinsehen -- rc 2, nicht rc 1."""


def token() -> str:
    """Ein GitHub-Token aus der Umgebung, sonst nichts.

    BEWUSST OHNE Rueckfall auf `gh auth token` -- das war im ersten Entwurf drin
    und ist nach dem gegnerischen Review heraus. Der Grund: das Token geht in
    einen per `npx --yes` FRISCH aufgeloesten Abhaengigkeitsbaum ohne Lockfile,
    und `gh auth token` liefert das persoenliche OAuth-Token des Entwicklers mit
    `repo`, `workflow` und `write:packages`. Renovate braucht hier nur
    oeffentliche Lesezugriffe. Wer ein Token hergibt, soll entscheiden, WELCHES.
    """
    for name in ("GITHUB_COM_TOKEN", "GITHUB_TOKEN", "RENOVATE_TOKEN"):
        wert = os.environ.get(name)
        if wert:
            return wert
    return ""


def _weg_damit(funktion, pfad, fehler) -> None:  # noqa: ARG001 -- onexc-Form
    """Schreibgeschuetztes wegraeumen. Git legt `.git/objects` read-only an.

    Ohne diesen Handler bleibt die Fixture auf Windows STILL liegen:
    `ignore_errors=True` verschluckt den Fehler, und es sammeln sich Ordner an
    (gemessen: neun Altlasten nach einem halben Tag Entwicklung). In der CI
    (ubuntu) tritt es nicht auf -- deshalb saehe es dort nie jemand.
    """
    os.chmod(pfad, stat.S_IWRITE)
    funktion(pfad)


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
        raise NichtUrteilsfaehig("git nicht gefunden -- die Fixture braucht ein Repo")
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
    if rc != 0:
        return (f"Renovate endete mit {rc} -- ein Lookup-Lauf, der nicht sauber "
                "endet, liefert kein Urteil.")

    gefunden = _GEFUNDEN.search(ausgabe)
    if not gefunden:
        return ("Keine Zeile `Found N package file(s)` -- unbekannte Ausgabeform. "
                "Moeglicherweise falsche node- oder Renovate-Fassung.")
    if int(gefunden.group(1)) != ERWARTETE_DATEIEN:
        return (f"Renovate hat {gefunden.group(1)} Paketdateien gesehen, erwartet "
                f"sind {ERWARTETE_DATEIEN}. Die Fixture ist nicht vollstaendig "
                "angekommen -- ein Urteil ueber eine kleinere Menge waere die Luege.")

    treffer = _FLACH.search(ausgabe)
    if treffer is None:
        return (f"Keine Zeile `flattened updates found` in der Ausgabe (rc {rc}). "
                "Unbekannte Ausgabeform.")
    namen = flache_liste(ausgabe) or []
    if int(treffer.group(1)) != len(namen):
        return (f"Renovate nennt {treffer.group(1)} Updates, aufgezaehlt sind "
                f"{len(namen)} -- die Ausgabeform hat sich geaendert.")

    if "github-token-required" in ausgabe:
        return ("Kein brauchbares GitHub-Token: Regel 2 (github-actions python) "
                "ist ohne Token unfalsifizierbar -- sie saehe mit und ohne Regel "
                "gleich aus. Setze GITHUB_COM_TOKEN.")
    if not _PYTHON_ERKANNT.search(ausgabe):
        return ("Der github-actions-Manager hat den Dep `python` gar nicht "
                "erkannt -- Regel 2 ist damit nicht pruefbar, egal wie ihr "
                "Ergebnis aussieht.")
    # Die Kontrolle zu Regel 1 haengt an der AUSSENWELT: den Zweig
    # `renovate/all-minor-patch` gibt es nur, solange fuer `lucide-react` ueberhaupt
    # eine Minor-Aktualisierung angeboten wird. Faellt die weg, waere „Zweig fehlt"
    # ein FEHL fuer eine Regel, die tadellos wirkt -- ein Fehlalarm, und ein Riegel
    # mit Fehlalarmen wird weggeklickt. Nicht pruefbar ist nicht verletzt.
    # (CodeRabbit-CLI, major.)
    if "lucide-react" not in namen:
        return ("Die Kontrolle fuer Regel 1 (`lucide-react`) hat gar keine "
                "Aktualisierung -- ohne sie gibt es kein Sammelbuendel, gegen das "
                "sich der eigene Zweig abheben koennte. Nicht pruefbar, nicht "
                "verletzt: Fixture-Fassung anheben.")
    return None


def urteile(ausgabe: str) -> tuple[int, list[str]]:
    """Wirken die drei Regeln? Rein, damit der Test sie ohne Renovate fahren kann.

    Jede Regel braucht einen POSITIVEN Beleg und eine Kontrolle -- eine blosse
    Abwesenheit hat zu viele Ursachen.
    """
    namen = flache_liste(ausgabe) or []
    zeilen: list[str] = []
    schlecht = False

    # Regel 1 -- eigener Zweig statt Sammelbuendel, samt Kontrolle.
    # Verankert an der Feldform `"branchName": "..."`, nicht am blossen Vorkommen
    # der Zeichenkette: die Debug-Ausgabe enthaelt den Config-Dump samt unserer
    # eigenen `description`-Texte, und wer dort einmal einen Zweignamen erwaehnt,
    # macht den Sensor sonst vacuous (gegnerisches Review, K4).
    eigen = '"branchName": "renovate/vitejs-plugin-react"' in ausgabe
    buendel = '"branchName": "renovate/all-minor-patch"' in ausgabe
    if eigen and buendel:
        zeilen.append("ok   Regel 1: @vitejs/plugin-react hat einen eigenen Zweig, "
                      "die Kontrolle laeuft im Sammelbuendel")
    else:
        schlecht = True
        zeilen.append(f"FEHL Regel 1: eigener Zweig={eigen}, Sammelbuendel={buendel} "
                      "-- erwartet beides True")

    # Regel 2 -- Abwesenheit UND positiver Beleg. Ohne den zweiten Teil gaelte
    # die Regel auch dann als wirksam, wenn der Dep aus einem ganz anderen Grund
    # aus der Liste faellt (Ratengrenze, Netz weg, geaenderte Fixture).
    abgeschaltet = bool(_PYTHON_ABGESCHALTET.search(ausgabe))
    if "python" not in namen and abgeschaltet:
        zeilen.append("ok   Regel 2: `python` bekommt keinen Vorschlag, und der "
                      "Grund steht als skipReason `disabled` daneben")
    else:
        schlecht = True
        zeilen.append(f"FEHL Regel 2: in der Liste={'python' in namen}, "
                      f"skipReason disabled={abgeschaltet} -- erwartet False/True")

    # Regel 3 -- genau EIN postgres UND die Filterzeile. Die Zahl allein
    # unterscheidet „Kontrolle da, geschuetztes Abbild gefiltert" nicht von
    # „Kontrolle fehlt, nichts gefiltert": die flache Liste traegt keinen
    # Dateinamen. Am zweiten Fall ist der erste Entwurf gemessen vorbeigelaufen.
    wie_oft = namen.count("postgres")
    gefiltert = _GEFILTERT.search(ausgabe)
    anzahl = int(gefiltert.group(1)) if gefiltert else 0
    if wie_oft == 1 and anzahl == 1:
        zeilen.append("ok   Regel 3: genau ein postgres-Major (die Kontrolle), und "
                      "genau eines wurde gefiltert -- docs/bugsink/compose.yaml")
    else:
        schlecht = True
        zeilen.append(f"FEHL Regel 3: {wie_oft} postgres-Majors in der Liste, "
                      f"{anzahl} gefiltert -- erwartet 1 und 1")

    return (1 if schlecht else 0), zeilen


def fahre(ziel: Path) -> tuple[int, str]:
    """Renovate gegen das Wegwerf-Repo. Rueckgabe: (rc, stdout+stderr)."""
    npx = shutil.which("npx")
    if not npx:
        raise NichtUrteilsfaehig("npx nicht gefunden")
    umgebung = dict(os.environ)
    umgebung["LOG_LEVEL"] = "debug"
    tok = token()
    if tok:
        umgebung["GITHUB_COM_TOKEN"] = tok
        umgebung["RENOVATE_TOKEN"] = tok
    try:
        fertig = subprocess.run(
            [npx, "--yes", RENOVATE, "--platform=local", "--dry-run=lookup"],
            cwd=ziel, capture_output=True, text=True,
            # Hausform (`mutation.py`): ohne beides haengt die Dekodierung an
            # `PYTHONUTF8`, und die Ausgabe traegt Gedankenstriche aus unserem
            # eigenen Config-Dump.
            encoding="utf-8", errors="replace",
            env=umgebung, timeout=FRIST,
        )
    except subprocess.TimeoutExpired as fehl:
        raise NichtUrteilsfaehig(
            f"Renovate hat nach {FRIST}s nicht geantwortet") from fehl
    return fertig.returncode, fertig.stdout + fertig.stderr


def main(argv: list[str]) -> int:
    behalten = "--behalten" in argv
    ordner = tempfile.mkdtemp(prefix="renovate-regeln-")
    ziel = Path(ordner)
    try:
        baue_fixture(ziel)
        rc, ausgabe = fahre(ziel)
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
    except NichtUrteilsfaehig as fehl:
        print(f"NICHT URTEILSFAEHIG: {fehl}", file=sys.stderr)
        return 2
    except Exception as fehl:  # noqa: BLE001
        # rc 1 ist auch Pythons Absturzcode -- ohne diesen Fang saehe ein
        # Traceback aus wie „mindestens eine Regel wirkt nicht". Dieselbe Stelle
        # hat `coderabbit_riegel.py` seit fb1b747.
        print(f"NICHT URTEILSFAEHIG: {type(fehl).__name__}: {fehl}", file=sys.stderr)
        return 2
    finally:
        if behalten:
            print(f"Fixture bleibt stehen: {ziel}")
        else:
            # Der Fang ist NICHT Vorsicht, sondern eine Korrektur: hilft `chmod`
            # nicht (Datei von einem Prozess gehalten -- auf Windows nach dem
            # Zeitgrenzen-Pfad realistisch), wirft `_weg_damit` weiter. Eine
            # Ausnahme im `finally` ERSETZT den Rueckgabewert von `main()` --
            # aus einem sauberen 0 oder einem ehrlichen 2 wuerde dann rc 1,
            # also „eine Regel wirkt nicht". Aufraeumen darf kein Urteil faellen.
            try:
                shutil.rmtree(ziel, onexc=_weg_damit)
            except OSError as fehl:
                print(f"Fixture blieb liegen ({fehl}): {ziel}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
