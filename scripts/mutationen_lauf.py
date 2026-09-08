#!/usr/bin/env python3
"""Faehrt die Mutationsplaene dieses Repos — alle, oder nur die von einer Aenderung betroffenen.

WOZU. Bis #588 standen genau ZWEI Plaene fest verdrahtet im Workflow, waehrend zehn im Repo
lagen; acht liefen nirgends automatisch. Eine Mutationsprobe, die nur laeuft, wenn jemand
daran denkt, ist eine Regel und kein Riegel — mit genau dieser Begruendung wurde der Job
ueberhaupt eingefuehrt (#551).

WARUM EIN SKRIPT UND KEINE ZEILEN IM WORKFLOW. Dieselbe Regel wie bei `notizen.sh` und
`versionshoehe.sh`: damit ein Test genau das prueft, was in der CI laeuft. Im Workflow-Rumpf
bleibt nur Wissen ueber den LAUF (welches Ereignis, welcher Bereich).

WARUM AUSWAHL STATT IMMER ALLES. Die volle Serie ist auf 20-25 min geschaetzt. Bei jeder
Aenderung gefahren wuerde sie zur Steuer auf Arbeit, die mit den Waechtern nichts zu tun hat
— und ein Riegel, der jeden aufhaelt, wird abgeschaltet. Die billige Haelfte laeuft dafuer
IMMER: `scripts/test_mutationsplaene.py` bindet jeden Plan in Sekunden an den Baum.

Rueckgabecodes, wie ueberall in diesem Repo drei statt zwei:
    0  alle gewaehlten Plaene bestanden
    1  mindestens ein Plan ist gescheitert
    2  konnte nicht urteilen (Nutzungsfehler, kein Plan gefunden, Plan unlesbar)
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
from dataclasses import dataclass, field

# Aenderungen, die JEDEN Plan betreffen koennen, ohne in einem `pfade` zu stehen.
#
# Der Fall ist nicht erdacht: ein Fehler im TREIBER, der `_ist_fehlzeile` stumpf macht,
# entwertet jede Serie — und `scripts/mutation.py` steht nur in den `pfade` des einen
# Plans, der ihn mutiert. Ohne diese Liste liefe so eine Aenderung an neun Plaenen vorbei
# (Befund des kalten Plan-Pruefers, 2026-09-08).
#
# Dasselbe gilt fuer die Konfiguration, die JEDE Suite traegt: die Wurzel-conftest.py haelt
# den Lauf-Deckel, pyproject.toml die pytest-Sicht, die vitest-Konfiguration und
# setupTests.ts die des Frontends. `scripts/test_mutationsplaene.py` haelt fest, dass jeder
# Eintrag hier auch wirklich existiert — sonst faellt die Deckung lautlos weg.
GLOBALE_PFADE = (
    "scripts/mutation.py",
    "scripts/mutationen_lauf.py",
    "conftest.py",
    "webtool/conftest.py",
    "pyproject.toml",
    "webtool/frontend/vitest.config.ts",
    "webtool/frontend/src/setupTests.ts",
    "webtool/frontend/package.json",
    "webtool/frontend/package-lock.json",
)


@dataclass
class Plan:
    datei: pathlib.Path
    test: str
    pfade: list[str]
    mutationen: list[dict]
    env: dict[str, str] = field(default_factory=dict)

    @property
    def name(self) -> str:
        return self.datei.stem

    def pfad_wurzel(self, wurzel: pathlib.Path) -> str:
        """Der `--pfad` fuer den Treiber: der gemeinsame Ordner aller beruehrten Dateien.

        Er entscheidet, worauf Sauberkeitspruefung und Bytecode-Leeren greifen. Abgeleitet
        statt als viertes Feld gepflegt: eine Angabe, die sich aus `pfade` ergibt, waere von
        Hand nur eine weitere Stelle, die driften kann.

        Ob das Ergebnis eine Datei ist, wird auf der PLATTE nachgesehen und nicht am Punkt
        im Namen geraten: ein Ordner darf einen Punkt tragen (`src.old`), und die Heuristik
        haette ihn zum Elternordner gemacht — also die Sauberkeitspruefung stillschweigend
        verbreitert.
        """
        # Die Normalisierung gehoert VOR die Zerlegung, nicht dahinter: `commonpath` gibt
        # auf Windows Rueckstriche zurueck, und `PurePosixPath` sieht darin EINEN Namensteil
        # — `webtool\test_jobs.py`.parent waere dann `.` statt `webtool`. Genau so gemessen,
        # gefunden vom Test daneben.
        gemeinsam = os.path.commonpath([p.replace("\\", "/") for p in self.pfade])
        gemeinsam = gemeinsam.replace("\\", "/")
        if not gemeinsam:
            return "."
        # Bei EINEM Pfad ist der gemeinsame Teil die Datei selbst — dann ihr Ordner.
        if (wurzel / gemeinsam).is_file():
            gemeinsam = str(pathlib.PurePosixPath(gemeinsam).parent)
        return gemeinsam or "."


def lade_plaene(wurzel: pathlib.Path) -> list[Plan]:
    """Liest alle Plaene unter scripts/mutationen/. Wirft bei unbrauchbarer Form."""
    geladen = []
    for datei in sorted((wurzel / "scripts" / "mutationen").glob("*.json")):
        roh = json.loads(datei.read_text(encoding="utf-8"))
        if not isinstance(roh, dict):
            raise ValueError(f"{datei.name}: blanke Liste — hier ist die Objektform Pflicht")
        geladen.append(Plan(datei=datei, test=roh["test"], pfade=list(roh["pfade"]),
                            mutationen=list(roh["mutationen"]), env=dict(roh.get("env", {}))))
    return geladen


def waehle(plaene: list[Plan], geaendert: set[str] | None) -> list[Plan]:
    """`geaendert=None` heisst ALLE. Sonst: betroffen ueber `pfade`, Plandatei oder global.

    Die Plandatei selbst zaehlt mit, weil eine geaenderte Mutation genau den Plan pruefen
    soll, den sie aendert — sonst koennte man einen Waechter entschaerfen, ohne dass seine
    eigene Serie je laeuft.
    """
    if geaendert is None:
        return list(plaene)
    if geaendert & set(GLOBALE_PFADE):
        return list(plaene)
    return [p for p in plaene
            if geaendert & set(p.pfade)
            or f"scripts/mutationen/{p.datei.name}" in geaendert]


def _lies_geaendert(pfad: pathlib.Path) -> set[str]:
    zeilen = pfad.read_text(encoding="utf-8").splitlines()
    return {z.strip().replace("\\", "/") for z in zeilen if z.strip()}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="Repo-Wurzel")
    ap.add_argument("--alle", action="store_true", help="alle Plaene fahren")
    ap.add_argument("--geaendert", type=pathlib.Path,
                    help="Datei mit geaenderten Pfaden, einer je Zeile")
    ap.add_argument("--nur-auswahl", action="store_true",
                    help="nur die Auswahl drucken, nichts fahren")
    a = ap.parse_args(argv)

    if a.alle == bool(a.geaendert):
        print("ABBRUCH: genau eines von --alle und --geaendert.")
        return 2

    wurzel = pathlib.Path(a.repo).resolve()
    try:
        plaene = lade_plaene(wurzel)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as fehl:
        print(f"ABBRUCH: ein Plan ist unlesbar — {fehl}")
        return 2

    # ANTI-SCHWEIGEN, erste Haelfte: kein Plan gefunden heisst NICHT "alles bestanden".
    # Ordner umbenannt, Endung geaendert, falscher --repo — alles drei sieht ohne diese
    # Zeile aus wie ein sauberer Lauf. Dieselbe Klasse wie `tests 0` mit rc 0.
    if not plaene:
        print(f"ABBRUCH: keine Plaene unter {wurzel / 'scripts' / 'mutationen'} gefunden.")
        return 2

    if a.geaendert:
        try:
            geaendert = _lies_geaendert(a.geaendert)
        except OSError as fehl:
            print(f"ABBRUCH: --geaendert nicht lesbar — {fehl}")
            return 2
    else:
        geaendert = None

    gewaehlt = waehle(plaene, geaendert)

    # ANTI-SCHWEIGEN, zweite Haelfte: bei --alle ist eine leere Auswahl ein Widerspruch —
    # es gibt Plaene (oben geprueft), also muessen sie auch gewaehlt sein. Bei --geaendert
    # ist eine leere Auswahl dagegen der Normalfall und voellig richtig.
    if a.alle and not gewaehlt:
        print("ABBRUCH: --alle hat null Plaene gewaehlt, obwohl welche vorliegen.")
        return 2

    print(f"{len(gewaehlt)} von {len(plaene)} Plaenen gewaehlt"
          f" ({sum(len(p.mutationen) for p in gewaehlt)} Mutationen):")
    for p in gewaehlt:
        print(f"  {p.name}  --pfad {p.pfad_wurzel(wurzel)}")
    if not gewaehlt:
        print("  (keiner — die Aenderung beruehrt keinen Waechter)")
    if a.nur_auswahl:
        return 0

    treiber = str(wurzel / "scripts" / "mutation.py")
    schlimmster, gescheitert = 0, []
    for p in gewaehlt:
        print(f"\n=== {p.name} ({len(p.mutationen)} Mutationen) ===", flush=True)
        # Ohne Shell und als Argumentliste: der Treiber selbst braucht `shell=True` fuer
        # sein Testkommando, dieser Aufruf hier nicht — und was ohne Shell laeuft, laeuft
        # auf cmd.exe und sh gleich.
        rc = subprocess.run([sys.executable, treiber, "--repo", str(wurzel),  # noqa: S603
                             "--pfad", p.pfad_wurzel(wurzel), "--plan", str(p.datei)],
                            check=False).returncode
        if rc:
            gescheitert.append((p.name, rc))
        # rc 2 (konnte nicht urteilen) wiegt schwerer als rc 1 (Befund) — sonst verschwindet
        # ein Plan, der gar nicht gemessen hat, hinter einem, der ehrlich rot war.
        schlimmster = max(schlimmster, rc)

    print(f"\nBILANZ: {len(gewaehlt) - len(gescheitert)} von {len(gewaehlt)} bestanden")
    for name, rc in gescheitert:
        print(f"  GESCHEITERT {name} (rc {rc})")
    return schlimmster


if __name__ == "__main__":
    raise SystemExit(main())
