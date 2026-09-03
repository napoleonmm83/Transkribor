"""Waechter fuer den Ruff-Riegel — die reinen Funktionen, ohne ruff-Aufruf.

Der Riegel selbst ist ein Muster plus ein Mengenvergleich; beides faellt still
falsch aus, wenn es falsch ist. Deshalb steht hier von JEDER Seite ein
Gegenbeispiel: eine Zeile, die aussieht wie ein Befund und keiner ist, und ein
Befund in einer Form, die das Muster fressen muss.
"""

import sys
from pathlib import Path

# Der Pfad muss VOR dem Import stehen — E402/I001 sind hier die Folge der
# Reihenfolge, nicht der Unordnung. Dieselbe Form wie in test_coderabbit_status.py.
sys.path.insert(0, str(Path(__file__).parent))
import ruff_riegel  # noqa: E402, I001


# --- Das Muster: was es fangen MUSS ---------------------------------------


def test_windows_pfad_wird_zu_vorwaerts_schraegstrichen():
    # Genau die Fussangel aus review-502 F5: ohne Normalisierung waeren auf
    # Windows ALLE Zeilen ungleich zur auf Linux erzeugten Baseline.
    zeile = r"webtool\app.py:12:5: I001 [*] Import block is un-sorted or un-formatted"
    assert ruff_riegel.schluessel(zeile) == "webtool/app.py:I001"


def test_linux_pfad_bleibt_unveraendert():
    zeile = "webtool/app.py:12:5: I001 [*] Import block is un-sorted or un-formatted"
    assert ruff_riegel.schluessel(zeile) == "webtool/app.py:I001"


def test_meldung_mit_doppelpunkt_verwirrt_den_pfad_nicht():
    # S108 traegt selbst einen Doppelpunkt in der Meldung — ein gieriger Pfad
    # haette hier bis in den Text hinein gelesen.
    zeile = (
        "webtool/test_whispercpp.py:137:57: S108 Probable insecure usage of "
        'temporary file or directory: "/tmp/out"'
    )
    assert ruff_riegel.schluessel(zeile) == "webtool/test_whispercpp.py:S108"


def test_absoluter_windows_pfad_mit_laufwerksbuchstabe():
    # `E:` sieht wie ein Pfad-Doppelpunkt aus. Der nicht-gierige Pfad darf hier
    # NICHT nach dem Laufwerksbuchstaben abbrechen.
    zeile = r"E:\Git\Transkribor\webtool\app.py:12:5: B904 Within an `except` clause"
    assert ruff_riegel.schluessel(zeile) == "E:/Git/Transkribor/webtool/app.py:B904"


def test_regelkuerzel_aller_laengen():
    # Vier Buchstaben-/Ziffernformen, die in diesem Projekt real vorkommen bzw.
    # in ruff existieren — das Muster darf keine davon verlieren.
    for kuerzel in ("E702", "I001", "UP031", "ASYNC230", "PLW1514", "S101"):
        zeile = f"transcribe.py:1:1: {kuerzel} irgendeine Meldung"
        assert ruff_riegel.schluessel(zeile) == f"transcribe.py:{kuerzel}"


def test_syntaxfehler_ist_ein_befund():
    # Ein Syntaxfehler traegt bei ruff GAR KEINEN Regelcode, sondern die Kennung
    # `invalid-syntax` (gemessen mit 0.16.6). Mit dem urspruenglichen Muster
    # `[A-Z]+\d+` fiel die Zeile lautlos aus dem Vergleich — eine .py, die kein
    # Test importiert, waere gruen durch die CI gegangen, obwohl ruff rot war.
    zeile = "scripts/x.py:1:12: invalid-syntax: Expected a parameter or the end"
    assert ruff_riegel.schluessel(zeile) == "scripts/x.py:invalid-syntax"


# --- Der Gegenzeuge: ruffs eigene Summenzeile -----------------------------


def test_gemeldete_zahl_liest_die_summenzeile():
    assert ruff_riegel.gemeldete_zahl("a.py:1:1: F401 x\nFound 1 error.\n") == 1
    assert ruff_riegel.gemeldete_zahl("Found 199 errors.\n") == 199


def test_ohne_summenzeile_sind_es_null():
    assert ruff_riegel.gemeldete_zahl("All checks passed!\n") == 0


def test_verstandene_ausgabe_hat_keine_fehlenden_zeilen():
    ausgabe = (
        "webtool/a.py:3:1: I001 unsorted\n"
        "scripts/x.py:1:12: invalid-syntax: Expected a parameter\n"
        "Found 2 errors.\n"
    )
    assert ruff_riegel.fehlende_zeilen(ausgabe, ruff_riegel.schluessel_liste(ausgabe)) == 0


def test_unverstandene_zeile_faellt_auf_statt_zu_verschwinden():
    # Eine Ausgabeform ohne Zeile:Spalte — wie sie eine kuenftige ruff-Fassung
    # bringen koennte. Der Riegel darf sie NICHT stillschweigend uebergehen:
    # ein Muster, das eine Form nicht kennt, ist sonst gruen, weil es nichts sah.
    ausgabe = (
        "webtool/a.py:3:1: I001 unsorted\n"
        "webtool/b.py: etwas ohne Zeile und Spalte\n"
        "Found 2 errors.\n"
    )
    assert ruff_riegel.schluessel_liste(ausgabe) == ["webtool/a.py:I001"]
    assert ruff_riegel.fehlende_zeilen(ausgabe, ruff_riegel.schluessel_liste(ausgabe)) == 1


# --- Das Muster: was es NICHT fangen darf ---------------------------------


def test_summenzeilen_und_leerzeilen_sind_keine_befunde():
    for zeile in (
        "Found 199 errors.",
        "[*] 77 fixable with the `--fix` option (3 hidden fixes can be enabled "
        "with the `--unsafe-fixes` option).",
        "All checks passed!",
        "",
        "   ",
    ):
        assert ruff_riegel.schluessel(zeile) is None, zeile


def test_ganze_ausgabe_liefert_nur_die_befunde_sortiert():
    ausgabe = (
        "webtool/z.py:9:1: F401 unused\n"
        "webtool/a.py:3:1: I001 unsorted\n"
        "Found 2 errors.\n"
        "[*] 1 fixable with the `--fix` option.\n"
    )
    assert ruff_riegel.schluessel_liste(ausgabe) == [
        "webtool/a.py:I001",
        "webtool/z.py:F401",
    ]


# --- Der Vergleich --------------------------------------------------------


def test_neuer_befund_wird_gemeldet():
    neue, entfallene = ruff_riegel.vergleich(
        ["a.py:I001", "b.py:S603"], ["a.py:I001"]
    )
    assert neue == ["b.py:S603"]
    assert entfallene == []


def test_behobener_befund_gilt_als_entfallen_nicht_als_neu():
    # Die Richtung ist der ganze Punkt: behoben darf NICHT rot machen.
    neue, entfallene = ruff_riegel.vergleich(
        ["a.py:I001"], ["a.py:I001", "b.py:S603"]
    )
    assert neue == []
    assert entfallene == ["b.py:S603"]


def test_zweiter_befund_derselben_regel_in_derselben_datei_zaehlt():
    # Ohne Vielfachheit waere ein zusaetzlicher S603 in whispercpp.py unsichtbar —
    # der Schluessel steht dort schon.
    neue, entfallene = ruff_riegel.vergleich(
        ["w.py:S603", "w.py:S603"], ["w.py:S603"]
    )
    assert neue == ["w.py:S603"]
    assert entfallene == []


def test_tausch_innerhalb_derselben_datei_und_regel_bleibt_unsichtbar():
    # BENANNTE DECKE, kein Versehen (CodeRabbit-CLI, 2026-09-03; Begruendung an
    # vergleich() im Riegel). Die Eingaben unterscheiden sich real — Zeile 396
    # faellt weg, dafuer kommt ein ANDERER subprocess-Aufruf in Zeile 512 dazu —
    # und der Riegel sieht es trotzdem nicht. Wer den Schluessel je aendert, muss
    # diesen Test anfassen und liest dabei, warum er so steht.
    vorher = ruff_riegel.schluessel_liste(
        "webtool/whispercpp.py:174:5: S603 subprocess call\n"
        "webtool/whispercpp.py:396:16: S603 subprocess call\n"
    )
    nachher = ruff_riegel.schluessel_liste(
        "webtool/whispercpp.py:174:5: S603 subprocess call\n"
        "webtool/whispercpp.py:512:9: S603 subprocess call\n"
    )
    assert ruff_riegel.vergleich(nachher, vorher) == ([], [])


def test_zeilenverschiebung_allein_erzeugt_keinen_befund():
    # Derselbe Fund, andere Zeile — genau der Fall, an dem ein
    # zeilennummern-basierter Vergleich in review-502 F5 angeschlagen haette.
    alt = ruff_riegel.schluessel_liste("webtool/whispercpp.py:356:16: S603 subprocess")
    neu = ruff_riegel.schluessel_liste("webtool/whispercpp.py:396:16: S603 subprocess")
    assert ruff_riegel.vergleich(neu, alt) == ([], [])
