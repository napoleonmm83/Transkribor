#!/usr/bin/env python3
"""Erzeugt das AUFGELOESTE Python-Abbild fuer den OSV-Scan (Issue #284).

WARUM: requirements.txt ist bewusst ungepinnt — ein Manifest-Scan loest via
deps.dev auf und meldet dann Versionen, die niemand faehrt. Gemessen 2026-08-18
(osv-scanner 2.5.1): Manifest-Scan 44 Funde, davon 38 gegen Phantom-Versionen
(torch 2.9.1 statt 2.11.0+cu128, pillow 9.5.0 statt 12.3.0); der Scan gegen das
echte Abbild meldete 12 echte Funde. Also: Abbild scannen, nie das Manifest.

WIE: zwei Dry-Run-Reports (PEP-658-Metadaten — kein Wheel-Download, gemessen
3,4 s bzw. 9,7 s statt eines 3-GB-Installationslaufs):
  1. -r requirements.txt          ueber PyPI
  2. torch torchaudio             ueber den cu128-Index (electron/setup.js-Ordnung)
Merge-Regel: nur Eintraege mit lokalem Suffix (+cu128) gewinnen aus dem cu128-Report
— nur der externe Index erzeugt solche Suffixe, alles andere hat pip dort gegen
denselben Bestand geloest. Suffix-lose Eintraege uebernimmt der Union-Fallback nur,
wenn der PyPI-Report sie nicht liefert.

WAECHTER: < 100 Pakete ist kein Abbild (echtes 117, Manifest ~12) -> Exit 1.
Ein leerer Report wuerde sonst als grüner Scan ueber nichts durchgehen.
Zweiter Wächter: torch MUSS ein +cu128-Suffix tragen — dient der cu128-Index
je einen suffixlosen Build (oder versagt die URL-Regel), gewaenne still der
PyPI-torch (CPU-Rad, falsche Version), die Paketzahl bliebe gleich und das
falsche Abbild scannte gruen (Review-Fund 2026-08-18).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

CU128_INDEX = "https://download.pytorch.org/whl/cu128"
MIN_PAKETE = 100  # echtes Abbild 2026-08-18: 117 (PyPI) + torch-Baum; Manifest: 12
ZIEL = "requirements-resolved.txt"


def normalisiere(name: str) -> str:
    """PEP 503 — pip freeze und OSV rechnen mit Bindestrich-Form."""
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def lies_report(pfad: str) -> dict:
    with open(pfad, encoding="utf-8") as f:
        daten = json.load(f)
    return {normalisiere(i["metadata"]["name"]): i["metadata"]["version"]
            for i in daten.get("install", [])}


def verschmelze(pypi: dict, cu128: dict) -> dict:
    """Installations-Reihenfolge aus electron/setup.js: torch zuerst aus dem
    cu128-Index, danach -r requirements.txt (pip behaelte das installierte torch).
    Erkennungsmerkmal des Overrides: das lokale Versionssuffix. Suffix-lose
    cu128-Einträge gewinnen NICHT (pip loeste sie dort gegen denselben Bestand,
    die PyPI-Aufloesung ist frischer) — aber sie werden uebernommen, wenn der
    PyPI-Report sie gar nicht liefert (Union-Fallback, Aussenstimme-Fund: ein
    Paket, das NUR im cu128-Baum steht, fiele sonst durchs Raster)."""
    ergebnis = dict(pypi)
    for name, version in cu128.items():
        if "+" in version:
            ergebnis[name] = version
        else:
            ergebnis.setdefault(name, version)
    return ergebnis


def pruefe_anzahl(n: int) -> None:
    if n < MIN_PAKETE:
        # Nicht nur die Zahl nennen: benennen, was wahrscheinlich passiert ist —
        # die Fehlermeldung ist der einzige Unterschied zu einem stillen Ausfall.
        print(f"NUR {n} PAKETE aufgeloest (Erwartung >= {MIN_PAKETE}) — vermutlich "
              f"das Manifest statt des Baums oder ein leerer pip-Report. "
              f"Scan abgebrochen: gruen ueber nichts ist schlimmer als rot.", file=sys.stderr)
        raise SystemExit(1)


def pruefe_torch(abbild: dict) -> None:
    """torch ohne +cu128-Suffix ist der PyPI-Build — die Paketzahl wuerde ihn
    nicht auffallen (Review-Fund: der Zaehler prueft Menge, nicht Eigenschaft)."""
    if "+" not in abbild.get("torch", ""):
        print(f"torch fehlt im Abbild oder traegt kein lokales Suffix "
              f"(got '{abbild.get('torch', '<fehlt>')}') — das waere der PyPI-CPU-Build, "
              f"nicht der ausgelieferte CUDA-Build. Scan abgebrochen.", file=sys.stderr)
        raise SystemExit(1)


def _pip_report(ziel: str, *argumente: str) -> None:
    """Dry-Run-Report erzeugen; wirft bei pip-Fehler (subprocess.CalledProcessError) —
    ein rot endender Job ist hier gewollt: kein Scan ist besser als ein Scan ueber
    ein halbes Abbild, und ein grüner Lauf über nichts wäre der schlimmste Fall."""
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--dry-run", "--quiet",
         "--ignore-installed", f"--report={ziel}", *argumente],
        check=True)


def haupt() -> None:
    _pip_report("req-report.json", "-r", "requirements.txt")
    _pip_report("torch-report.json", "torch", "torchaudio",
                "--index-url", CU128_INDEX)
    abbild = verschmelze(lies_report("req-report.json"), lies_report("torch-report.json"))
    pruefe_anzahl(len(abbild))
    pruefe_torch(abbild)
    zeilen = sorted(f"{name}=={version}" for name, version in abbild.items())
    Path(ZIEL).write_text("\n".join(zeilen) + "\n", encoding="utf-8")
    print(f"{ZIEL}: {len(zeilen)} Pakete")


if __name__ == "__main__":
    haupt()
