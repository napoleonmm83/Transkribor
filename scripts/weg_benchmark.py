#!/usr/bin/env python
"""Misst `app._weg_reste_aufraeumen` — die Zahlen im Docstring von `_weg_aufraeumen_starten`.

WARUM DIESES SKRIPT IM REPO LIEGT, statt die Messung einmal von Hand zu fahren: eine Zahl in
einem Kommentar ohne Skript daneben driftet unsichtbar. Dieses Repo hat das bezahlt (#463: ein
Kommentar behauptete 75, gemessen waren 68 — sichtbar wurde es erst durch das versionierte
Messskript), und `notizen.sh`/`versionshoehe.sh`/`fassung.sh` tragen dieselbe Begruendung.

Es hat den Weg hierher auf demselben Weg gefunden: die erste Fassung der 31-ms-Zahl war an
einem NACHBAU aus der Planphase gemessen, nicht an dieser Funktion, und der Plan hatte die
Nachmessung zugesagt. Aufgefallen ist es dem Bot-Vorabcheck „Behauptung oder Messung", nicht
mir.

    E:\\Git\\Transkribor\\.venv\\Scripts\\python.exe scripts/weg_benchmark.py

Er fasst NIE echte Projekte an: der Baum entsteht unter dem Systemtemp und wird danach
abgeraeumt. Die Laufzeiten haengen an der Maschine — verglichen wird die GROESSENORDNUNG
gegen `list_projects` (50-115 ms, die bei jedem Poll laeuft), nicht eine Zielzahl.
"""
import argparse
import os
import pathlib
import shutil
import statistics
import sys
import tempfile
import time

PROJEKTE = 300
DATEIEN = 3605
JEDE_SECHSTE_IST_REST = 6      # so entstehen die 605-900 Loeschungen des schlechtesten Falls


def baue(wurzel: pathlib.Path, mit_resten: bool) -> int:
    """Legt den Messbaum an; gibt zurueck, wie viele Dateien entstanden sind."""
    je, rest = divmod(DATEIEN, PROJEKTE)
    gebaut = 0
    for i in range(PROJEKTE):
        tr = wurzel / f"P{i:03d}" / "transkripte"
        tr.mkdir(parents=True, exist_ok=True)
        (wurzel / f"P{i:03d}" / "audio").mkdir(parents=True, exist_ok=True)
        for k in range(je + (1 if i < rest else 0)):
            ist_rest = mit_resten and k % JEDE_SECHSTE_IST_REST == 0
            # Der Stempel liegt bewusst in der Vergangenheit (1e9 ≙ 2001), damit der Rest
            # unter JEDER Frist als alt gilt — sonst haenge die Messung an der Uhr.
            name = f"S{k}.json.1000000000.deadbeef.weg" if ist_rest else f"S{k}.json"
            (tr / name).write_text("x", encoding="utf-8")
            gebaut += 1
    return gebaut


def miss(wurzel: pathlib.Path, mit_resten: bool, laeufe: int = 3) -> tuple[list[float], int]:
    """Fuehrt den Durchgang `laeufe` mal aus; baut die Reste zwischen den Laeufen neu auf."""
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    from webtool import app as appmod

    zeiten, entfernt = [], 0
    for lauf in range(laeufe):
        if lauf:
            baue(wurzel, mit_resten)          # jeder Lauf soll dieselbe Arbeit haben
        t0 = time.perf_counter()
        entfernt = appmod._weg_reste_aufraeumen(str(wurzel))
        zeiten.append((time.perf_counter() - t0) * 1000)
    return zeiten, entfernt


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--laeufe", type=int, default=3)
    args = p.parse_args()

    os.environ.setdefault("TRANSKRIBOR_YTDLP_UPDATE", "0")
    basis = pathlib.Path(tempfile.mkdtemp(prefix="weg-benchmark-"))
    try:
        print(f"{PROJEKTE} Projekte, {DATEIEN} Dateien, {args.laeufe} Laeufe je Fall\n"
              f"Python {sys.version.split()[0]} auf {sys.platform}\n")
        for was, mit_resten in (("Normalfall (nichts zu raeumen)", False),
                                ("schlechtester Fall (jede 6. ist ein Rest)", True)):
            wurzel = basis / ("mit" if mit_resten else "ohne")
            gebaut = baue(wurzel, mit_resten)
            zeiten, entfernt = miss(wurzel, mit_resten, args.laeufe)
            roh = " / ".join(f"{z:.1f}" for z in zeiten)
            print(f"{was}\n  {gebaut} Dateien, {entfernt} entfernt\n"
                  f"  {roh} ms   (median {statistics.median(zeiten):.1f})")
    finally:
        shutil.rmtree(basis, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
