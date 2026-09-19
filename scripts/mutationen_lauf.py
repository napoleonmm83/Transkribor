#!/usr/bin/env python3
"""Faehrt die Mutationsplaene dieses Repos — alle, oder nur die von einer Aenderung betroffenen.

WOZU. Bis #588 standen genau ZWEI Plaene fest verdrahtet im Workflow. GEMESSEN am master
davor (`git ls-tree --name-only master scripts/mutationen/`): SECHS Plaene eingecheckt, vier
davon ohne Laeufer — und vier weitere lagen ueberhaupt nur auf dem Rechner ihres Autors, nie
committet. Eine Mutationsprobe, die nur laeuft, wenn jemand daran denkt, ist eine Regel und
kein Riegel; mit genau dieser Begruendung wurde der Job eingefuehrt (#551).

(Hier stand zuerst „zehn im Repo, acht ohne Laeufer". Das beschrieb einen Zustand, den es nie
gab: die Zehn entstand erst durch den ersten Commit dieses Branches, der die vier
liegengebliebenen nachreichte. Gefunden von zwei Pruefern unabhaengig — und es ist genau die
Klasse, gegen die dieses Werkzeug gebaut ist.)

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
    # Die gemeinsame Testhuelle des Frontends. Sie steht in keinem `pfade`, traegt aber
    # Zusicherungen mehrerer Suiten — `Sidebar.test.tsx:4` holt `Huelle` von hier. Eine
    # Aenderung daran kann einen Waechter entwerten, ohne eine seiner Dateien anzufassen
    # (Befund des kalten Diff-Lesers).
    "webtool/frontend/src/lib/testHuelle.tsx",
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
    """Liest alle Plaene unter scripts/mutationen/. Wirft bei unbrauchbarer Form.

    Die Typpruefungen sind nicht Zierde. `list("webtool/jobs.py")` ist in Python eine Liste
    von ZEICHEN, nicht von Pfaden — ein `pfade`-Eintrag als blosser String ergab damit einen
    Plan, den die Auswahl nie trifft: „0 von 1 Plaenen gewaehlt", rc 0, still. Und ein
    `env`-Wert als Zahl stirbt erst im Kind (`environment can only contain strings`), also
    nach dem Aufbau und mit einem Traceback statt einer Meldung. Beides vom gegnerischen
    Pruefer gemessen.
    """
    geladen = []
    for datei in sorted((wurzel / "scripts" / "mutationen").glob("*.json")):
        roh = json.loads(datei.read_text(encoding="utf-8"))
        if not isinstance(roh, dict):
            raise ValueError(f"{datei.name}: blanke Liste — hier ist die Objektform Pflicht")
        pfade = roh.get("pfade")
        if not isinstance(pfade, list) or not pfade or not all(
                isinstance(p, str) for p in pfade):
            raise ValueError(f"{datei.name}: `pfade` muss eine nicht leere Liste von"
                             " Zeichenketten sein")
        mutationen = roh.get("mutationen")
        if not isinstance(mutationen, list):
            raise ValueError(f"{datei.name}: `mutationen` muss eine Liste sein")
        umgebung = roh.get("env") or {}
        if not isinstance(umgebung, dict) or not all(
                isinstance(k, str) and isinstance(v, str) for k, v in umgebung.items()):
            raise ValueError(f"{datei.name}: `env` nimmt nur Zeichenketten")
        geladen.append(Plan(datei=datei, test=roh["test"], pfade=list(pfade),
                            mutationen=list(mutationen), env=dict(umgebung)))
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


def teile(gewaehlt: list[Plan], nummer: int, anzahl: int) -> list[Plan]:
    """Der `nummer`-te von `anzahl` Teilen der Auswahl (1-basiert), reihum vergeben.

    WOZU. Eine Aenderung am Treiber oder an einem globalen Pfad waehlt JEDEN Plan, und die
    volle Serie kostet dann eine knappe Stunde: GEMESSEN am Lauf 35438398886, 54:22 gesamt,
    davon 53:21 Serie und 0:58 Aufbau.

    WAS ES BRINGT, und die Zahl ist nachgerechnet statt geschaetzt — alle Vergaben unten
    gegen die Einzelzeiten DESSELBEN Laufs, vier Teile, Aufbau je Teil eingerechnet:

        heute, ein Job                              54:19
        reihum in Dateireihenfolge                  25:55
        reihum nach Mutationszahl absteigend        25:21   <- gebaut
        gierig auf Mutationszahl (LPT)              31:09   <- die naheliegende „Verbesserung"
        perfekte Packung (braucht Kostentabelle)    17:26

    Also Faktor 2,1, nicht mehr. Der erste Entwurf dieser Zeile behauptete 22 min; das war
    eine Handrechnung, die die beiden teuersten Plaene in verschiedene Teile legte, und die
    echte Vergabe tut das nicht.

    DIE DRITTE ZEILE IST DER EIGENTLICHE MERKPOSTEN: LPT — jeden Plan in den bis dahin
    leichtesten Teil — ist die Lehrbuchantwort und hier MESSBAR SCHLECHTER als reihum. Der
    Grund ist der Schaetzer, nicht das Verfahren: LPT vertraut ihm mehr, und er taugt nicht.
    `weitergereichtes_then` kostet 71 s je Mutation (14 Mutationen, 16:28),
    `cross_platform_alias_identity` 7,5 s (33 Mutationen, 4:08). Wer das hier verbessern
    will, braucht echte Kosten, kein besseres Packverfahren.

    Eine Kostentabelle im Repo ist bewusst NICHT gebaut: sie waere genau die Sorte Zahl, die
    hier sonst als stille Drift beanstandet wird, und sie veraltet mit jedem neuen Test.
    Unter 17:26 kaeme ohnehin nur, wer INNERHALB eines Plans aufteilt — eigener Zuschnitt.

    Der Sortierschluessel traegt den Namen als zweites Glied, damit die Vergabe bei gleicher
    Mutationszahl stabil ist — sonst haengt es an der Dateireihenfolge, welcher Teil welchen
    Plan bekommt, und zwei Laeufe ueber denselben Commit sind nicht mehr vergleichbar.
    """
    nach_kosten = sorted(gewaehlt, key=lambda p: (-len(p.mutationen), p.name))
    return [p for i, p in enumerate(nach_kosten) if i % anzahl == nummer - 1]


def _teil_lesen(roh: str) -> tuple[int, int]:
    """`i/n` -> (i, n). Wirft `ValueError` mit Klartext, wenn die Form nicht stimmt.

    Eine falsche Angabe darf NIE als „dann eben alles" oder „dann eben nichts" durchgehen:
    beides waere ein Lauf, der etwas anderes prueft als der Aufrufer glaubt, und genau diese
    Klasse — ein Messmittel, das seinen eigenen Fehler als Ergebnis meldet — ist der Grund
    fuer die drei Rueckgabecodes dieses Skripts.
    """
    stuecke = roh.split("/")
    if len(stuecke) != 2 or not all(s.strip().isdecimal() for s in stuecke):
        raise ValueError(f"--teil erwartet die Form i/n, bekam {roh!r}")
    nummer, anzahl = (int(s) for s in stuecke)
    if anzahl < 1:
        raise ValueError(f"--teil: n muss mindestens 1 sein, bekam {anzahl}")
    if not 1 <= nummer <= anzahl:
        raise ValueError(f"--teil: i muss zwischen 1 und {anzahl} liegen, bekam {nummer}")
    return nummer, anzahl


def _lies_geaendert(pfad: pathlib.Path) -> dict[str, str]:
    """Pfad -> Status aus `git diff --name-status`; `?`, wenn die Zeile nur einen Pfad traegt.

    Der Status ist nicht Zierde: nur er unterscheidet eine LOESCHUNG (`D`) von einer
    UMBENENNUNG (`R100 alt neu`). Ohne ihn bliebe nur die Heuristik „Pfad im Diff, aber kein
    Plan geladen" — und die kann beides nicht trennen: ein PR, der einen Plan loescht UND
    einen zweiten aendert, saehe aus wie eine Umbenennung. Befund des CodeRabbit-Bots
    (major), der damit dieselbe Loesung vorschlaegt wie der Code hier.

    Beide Seiten einer Umbenennung zaehlen als geaendert — der neue Plan soll laufen, und
    der alte Pfad darf keinen Loesch-Alarm ausloesen.
    """
    eintraege: dict[str, str] = {}
    for zeile in pfad.read_text(encoding="utf-8").splitlines():
        if not zeile.strip():
            continue
        felder = [f.strip().replace("\\", "/") for f in zeile.split("\t") if f.strip()]
        if len(felder) == 1:
            eintraege[felder[0]] = "?"
            continue
        status = felder[0][0].upper()
        for p in felder[1:]:
            eintraege[p] = status
    return eintraege


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="Repo-Wurzel")
    ap.add_argument("--alle", action="store_true", help="alle Plaene fahren")
    ap.add_argument("--geaendert", type=pathlib.Path,
                    help="Datei mit geaenderten Pfaden, einer je Zeile")
    ap.add_argument("--nur-auswahl", action="store_true",
                    help="nur die Auswahl drucken, nichts fahren")
    ap.add_argument("--teil", metavar="i/n",
                    help="nur den i-ten von n Teilen der Auswahl fahren (1-basiert)")
    a = ap.parse_args(argv)

    if a.alle == bool(a.geaendert):
        print("ABBRUCH: genau eines von --alle und --geaendert.")
        return 2

    # VOR allem anderen geprueft, damit ein Tippfehler im Teiler nicht erst nach dem
    # Planladen auffaellt — und ausdruecklich NICHT als Rueckfall auf „dann eben alles".
    teil: tuple[int, int] | None = None
    if a.teil is not None:
        try:
            teil = _teil_lesen(a.teil)
        except ValueError as fehl:
            print(f"ABBRUCH: {fehl}")
            return 2

    wurzel = pathlib.Path(a.repo).resolve()
    try:
        plaene = lade_plaene(wurzel)
    except (OSError, TypeError, ValueError, KeyError, json.JSONDecodeError) as fehl:
        print(f"ABBRUCH: ein Plan ist unlesbar — {fehl}")
        return 2

    # ANTI-SCHWEIGEN, erste Haelfte: kein Plan gefunden heisst NICHT "alles bestanden".
    # Ordner umbenannt, Endung geaendert, falscher --repo — alles drei sieht ohne diese
    # Zeile aus wie ein sauberer Lauf. Dieselbe Klasse wie `tests 0` mit rc 0.
    if not plaene:
        print(f"ABBRUCH: keine Plaene unter {wurzel / 'scripts' / 'mutationen'} gefunden.")
        return 2

    eintraege: dict[str, str] = {}
    if a.geaendert:
        try:
            eintraege = _lies_geaendert(a.geaendert)
        except OSError as fehl:
            print(f"ABBRUCH: --geaendert nicht lesbar — {fehl}")
            return 2
        geaendert: set[str] | None = set(eintraege)
    else:
        geaendert = None

    gewaehlt = waehle(plaene, geaendert)

    # EINE GELOESCHTE PLANDATEI IST SONST LAUTLOS — und das war sie vor #588 NICHT.
    # Damals nannte der Workflow zwei Plaene namentlich; wer einen loeschte, machte den
    # Schritt rot. Jetzt liest der Laeufer den Ordner, und was nicht mehr da ist, kann er
    # nicht vermissen: der Diff traegt den Pfad, die Auswahl findet keinen Plan dazu, und
    # der Lauf meldet „0 von N gewaehlt", rc 0. Ein Waechter verschwindet damit, ohne dass
    # eine Zeile rot wird (Befund des kalten Diff-Lesers).
    #
    # Entschieden wird am STATUS des Diffs, nicht an einer Heuristik. Die erste Fassung
    # verglich „im Diff genannt" gegen „geladen" und nahm jede noch vorhandene Plandatei als
    # Entwarnung — womit ein PR, der einen Plan LOESCHT und einen zweiten AENDERT, den Alarm
    # verlor (CodeRabbit-Bot, major). `D` gegen `R` kann nur der Status trennen.
    if geaendert is not None:
        geloescht = sorted(p for p, s in eintraege.items()
                           if s == "D" and p.startswith("scripts/mutationen/")
                           and p.endswith(".json"))
        if geloescht:
            print("ABBRUCH: der Diff loescht Plandateien — ein Waechter waere damit lautlos"
                  " verschwunden:")
            for g in geloescht:
                print(f"         {g}")
            print("         (Eine Umbenennung traegt den Status R und faellt nicht"
                  " darunter.)")
            return 2

    # ANTI-SCHWEIGEN, zweite Haelfte: bei --alle ist eine leere Auswahl ein Widerspruch —
    # es gibt Plaene (oben geprueft), also muessen sie auch gewaehlt sein. Bei --geaendert
    # ist eine leere Auswahl dagegen der Normalfall und voellig richtig.
    if a.alle and not gewaehlt:
        print("ABBRUCH: --alle hat null Plaene gewaehlt, obwohl welche vorliegen.")
        return 2

    # DIE REIHENFOLGE IST DER GANZE PUNKT. Das Aufteilen steht HINTER dem Riegel darueber,
    # nie davor: nach dem Aufteilen ist eine leere Menge der NORMALFALL (mehr Teile als
    # Plaene, oder ein Teil trifft keinen), und der Riegel wuerde daraus rc 2 machen — also
    # jeden Lauf rot. Wer ihn deshalb aufweicht, statt ihn stehen zu lassen, bekommt das
    # Loch zurueck, gegen das er gebaut ist: eine Auswahl, die still nichts prueft.
    #
    # Der Riegel urteilt damit weiterhin ueber die VOLLE Auswahl, das Aufteilen nur ueber
    # die Verteilung auf die Jobs. Zwei Fragen, zwei Stellen.
    ganze_auswahl = len(gewaehlt)
    if teil is not None:
        gewaehlt = teile(gewaehlt, *teil)

    teil_text = f", Teil {teil[0]}/{teil[1]}" if teil else ""
    print(f"{len(gewaehlt)} von {len(plaene)} Plaenen gewaehlt{teil_text}"
          f" ({sum(len(p.mutationen) for p in gewaehlt)} Mutationen):")
    for p in gewaehlt:
        print(f"  {p.name}  --pfad {p.pfad_wurzel(wurzel)}")
    if not gewaehlt:
        if teil is not None and ganze_auswahl:
            print(f"  (keiner — die {ganze_auswahl} gewaehlten Plaene liegen in anderen"
                  f" Teilen; das ist kein Fehler)")
        else:
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
        #
        # `-u` ist nicht Kosmetik. Pythons stdout ist BLOCKGEPUFFERT, sobald es nicht auf
        # ein Terminal geht — also in jeder CI und in jeder Umleitung. Ohne den Schalter
        # erscheint die gesamte Ausgabe eines Plans erst, wenn sein Prozess ENDET; bei einer
        # Serie von 20 Minuten heisst das 20 Minuten ohne Lebenszeichen, und ein Haenger
        # saehe genauso aus wie Arbeit. Beim Bau dieses Skripts genau so beobachtet: die
        # Kopfzeile des Plans stand da, die Positivkontrolle des Kindes nicht.
        rc = subprocess.run([sys.executable, "-u", treiber, "--repo", str(wurzel),  # noqa: S603
                             "--pfad", p.pfad_wurzel(wurzel), "--plan", str(p.datei)],
                            check=False).returncode
        # EIN RUECKGABECODE AUSSERHALB VON 0/1/2 IST KEIN URTEIL, sondern das Fehlen eines
        # Urteils — und ohne diese Zeile wird er zu einem gruenen Haken.
        #
        # Auf POSIX meldet `subprocess` ein Signal als NEGATIVE Zahl: -9 fuer den
        # OOM-Killer, -2 fuer Strg-C, -15 fuer ein Timeout von aussen. `max(0, -9)` ist 0.
        # Der Laeufer haette also rc 0 gemeldet — Job gruen — waehrend seine eigene Bilanz
        # daneben „0 von 11 bestanden" druckt. Genau die Fehlerklasse, gegen die dieses
        # ganze Werkzeug gebaut ist, im Werkzeug selbst. Gefunden vom kalten Diff-Leser mit
        # gefaelschtem `subprocess.run`; die Fahrschleife hatte bis dahin keinen Test.
        if rc not in (0, 1, 2):
            print(f"  ABBRUCH {p.name}: Rueckgabecode {rc} — kein Urteil des Treibers"
                  " (negativ heisst auf POSIX: durch ein Signal beendet).")
            rc = 2
        if rc:
            gescheitert.append((p.name, rc))
        # rc 2 (konnte nicht urteilen) wiegt schwerer als rc 1 (Befund) — sonst verschwindet
        # ein Plan, der gar nicht gemessen hat, hinter einem, der ehrlich rot war.
        schlimmster = max(schlimmster, rc)

    print(f"\nBILANZ{teil_text}: {len(gewaehlt) - len(gescheitert)} von {len(gewaehlt)}"
          " bestanden")
    for name, rc in gescheitert:
        print(f"  GESCHEITERT {name} (rc {rc})")
    return schlimmster


if __name__ == "__main__":
    raise SystemExit(main())
