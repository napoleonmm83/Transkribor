"""Waechter fuer den mypy-Riegel — die reinen Funktionen, ohne mypy-Aufruf.

Geschwister von `test_ruff_riegel.py` und aus demselben Grund gebaut: der Riegel
ist ein Muster plus ein Mengenvergleich, und beides faellt STILL falsch aus,
wenn es falsch ist. Deshalb steht hier von jeder Seite ein Gegenbeispiel — eine
Zeile, die aussieht wie ein Befund und keiner ist, und ein Befund in einer Form,
die das Muster fressen muss.

Die Fixtures sind ECHTE mypy-Zeilen aus dem Lauf vom 2026-09-04 (2.3.1,
`platform = "win32"`, `no_site_packages = true`), nicht erfundene. Eine
ausgedachte Ausgabeform prueft das Muster gegen die Vorstellung ihres Autors —
und genau die war beim Ruff-Riegel zweimal falsch.

Diese Datei laeuft im `python`-Job auf BEIDEN Plattformen mit (`testpaths`
enthaelt `scripts`). Das ist die Stelle, an der der Windows-Pfadtrenner
festgenagelt ist, obwohl der Riegel selbst nur auf ubuntu laeuft.
"""

import sys
from pathlib import Path

import pytest

# Der Pfad muss VOR dem Import stehen — E402/I001 sind hier die Folge der
# Reihenfolge, nicht der Unordnung. Dieselbe Form wie in test_ruff_riegel.py.
sys.path.insert(0, str(Path(__file__).parent))
import mypy_riegel  # noqa: E402, I001


# --- Das Muster: was es fangen MUSS ---------------------------------------


def test_windows_pfad_wird_zu_vorwaerts_schraegstrichen():
    # Ohne Normalisierung waere auf Windows JEDE Zeile ungleich zur Baseline,
    # sobald diese auf Linux entstanden ist — dieselbe Fussangel wie bei ruff.
    zeile = r'webtool\sperre.py:120: error: Module has no attribute "WinDLL"  [attr-defined]'
    assert mypy_riegel.schluessel(zeile) == "webtool/sperre.py:attr-defined"


def test_linux_pfad_bleibt_unveraendert():
    zeile = 'webtool/sperre.py:120: error: Module has no attribute "WinDLL"  [attr-defined]'
    assert mypy_riegel.schluessel(zeile) == "webtool/sperre.py:attr-defined"


def test_meldung_mit_doppelpunkt_verwirrt_den_pfad_nicht():
    # Die Meldung traegt selbst einen Doppelpunkt (`hint:`) — ein gieriger Pfad
    # haette hier bis in den Text hinein gelesen.
    zeile = (
        'webtool/render_md.py:25: error: Need type annotation for "texts" '
        '(hint: "texts: list[<type>] = ...")  [var-annotated]'
    )
    assert mypy_riegel.schluessel(zeile) == "webtool/render_md.py:var-annotated"


def test_meldung_mit_klammern_verwirrt_den_code_nicht():
    # DIE mypy-eigene Falle: `[<type>]` steht MITTEN in der Meldung. Ein Muster
    # ohne `$`-Anker haette `<type>` als Fehlercode genommen — und damit einen
    # Schluessel erzeugt, den keine Baseline je enthaelt. Rot ohne Grund, bei
    # jedem `var-annotated`-Befund; der Baum traegt 14 davon.
    zeile = (
        'webtool/settings.py:54: error: Need type annotation for "gesetzt" '
        '(hint: "gesetzt: list[<type>] = ...")  [var-annotated]'
    )
    assert mypy_riegel.schluessel(zeile).endswith(":var-annotated")


def test_absoluter_windows_pfad_mit_laufwerksbuchstabe():
    # `E:` sieht wie ein Pfad-Doppelpunkt aus. Der nicht-gierige Pfad darf hier
    # NICHT nach dem Laufwerksbuchstaben abbrechen.
    zeile = r"E:\Git\Transkribor\webtool\jobs.py:134: error: irgendwas  [no-any-return]"
    assert (
        mypy_riegel.schluessel(zeile)
        == "E:/Git/Transkribor/webtool/jobs.py:no-any-return"
    )


def test_fehlercodes_aller_formen():
    # Mypy-Codes sind kleingeschrieben und tragen Bindestriche — das ruff-Muster
    # (`[A-Z]+\d+`) faende KEINEN einzigen davon.
    for code in ("no-any-return", "var-annotated", "assignment", "union-attr", "syntax"):
        zeile = f"transcribe.py:1: error: irgendeine Meldung  [{code}]"
        assert mypy_riegel.schluessel(zeile) == f"transcribe.py:{code}"


def test_fehler_ohne_klammercode_verschwindet_nicht():
    # Gemessen kommt das mit 2.3.1 nicht vor — selbst Syntaxfehler tragen
    # `[syntax]`. Die Marke steht trotzdem, weil genau diese Annahme den
    # Ruff-Riegel erwischt hat: dort hiess `invalid-syntax` ploetzlich anders
    # als jeder andere Befund, fiel aus dem Muster und verschwand lautlos.
    zeile = "scripts/x.py:1: error: eine Form ohne Klammercode"
    assert mypy_riegel.schluessel(zeile) == f"scripts/x.py:{mypy_riegel.OHNE_CODE}"


# --- Das Muster: was es NICHT fangen darf ---------------------------------


def test_note_mit_klammercode_ist_kein_befund():
    # FALLE 1, und sie ist scharf: `note:`-Zeilen tragen Klammercodes wie ein
    # Fehler. Acht solche Zeilen stehen im Baum; ein Muster, das nur auf
    # `[code]` schaut, faende 73 statt der 65, die mypy selbst zaehlt — und
    # `fehlende_zeilen` haette dann eine NEGATIVE Differenz gemeldet.
    zeile = (
        r"webtool\conftest.py:214: note: By default the bodies of untyped "
        "functions are not checked, consider using --check-untyped-defs  "
        "[annotation-unchecked]"
    )
    assert mypy_riegel.schluessel(zeile) is None


def test_note_ohne_klammercode_ist_kein_befund():
    zeile = (
        r"webtool\settings.py:283: note: PEP 484 prohibits implicit Optional. "
        "Accordingly, mypy has changed its default to no_implicit_optional=True"
    )
    assert mypy_riegel.schluessel(zeile) is None


def test_summenzeilen_und_leerzeilen_sind_keine_befunde():
    for zeile in (
        "Found 65 errors in 18 files (checked 59 source files)",
        "Success: no issues found in 59 source files",
        "",
        "   ",
    ):
        assert mypy_riegel.schluessel(zeile) is None, zeile


def test_ganze_ausgabe_liefert_nur_die_befunde_sortiert():
    ausgabe = (
        "webtool/z.py:9: error: b  [no-any-return]\n"
        "webtool/a.py:3: error: a  [assignment]\n"
        "webtool/a.py:4: note: eine Anmerkung  [annotation-unchecked]\n"
        "Found 2 errors in 2 files (checked 59 source files)\n"
    )
    assert mypy_riegel.schluessel_liste(ausgabe) == [
        "webtool/a.py:assignment",
        "webtool/z.py:no-any-return",
    ]


def test_spaltenwert_wuerde_den_pfad_verfaelschen_und_faellt_deshalb_laut_auf():
    # BENANNTE DECKE, kein Versehen. mypy druckt ohne `show_column_numbers`
    # keine Spalte; schaltet sie jemand ein, wandert die Zeilennummer in den
    # Pfad und JEDER Schluessel aendert sich. Der Riegel geht dann rot (alle
    # Befunde neu, alle alten entfallen) statt still danebenzuliegen — das ist
    # der Unterschied, auf den es ankommt. Wer die Option einschaltet, faengt
    # sich eine volle Baseline-Erneuerung ein und liest hier, warum.
    zeile = "webtool/a.py:3:11: error: a  [assignment]"
    assert mypy_riegel.schluessel(zeile) == "webtool/a.py:3:assignment"


# --- Der Gegenzeuge: mypys eigene Summenzeile -----------------------------


def test_gemeldete_zahl_liest_die_summenzeile():
    assert (
        mypy_riegel.gemeldete_zahl(
            "a.py:1: error: x  [misc]\nFound 65 errors in 18 files (checked 59 source files)\n"
        )
        == 65
    )


def test_summenzeile_im_singular_wird_auch_gelesen():
    # `Found 1 error in 1 file` — Einzahl an ZWEI Stellen. Ein Muster mit
    # festem `errors`/`files` haette hier nichts gefunden, und genau diese
    # Zeile druckt mypy beim Abbruch (Syntaxfehler, Duplicate Module).
    ausgabe = "a.py:1: error: x  [syntax]\nFound 1 error in 1 file (errors prevented further checking)\n"
    assert mypy_riegel.gemeldete_zahl(ausgabe) == 1


def test_ohne_summenzeile_sind_es_null():
    assert mypy_riegel.gemeldete_zahl("Success: no issues found in 59 source files\n") == 0


def test_summenzeile_unterscheidet_null_von_schweigen():
    # `gemeldete_zahl` wirft diesen Unterschied weg — genau daran haette die
    # Zaehlprobe allein das fehlende mypy nicht erkannt.
    assert mypy_riegel.summenzeile("Success: no issues found in 59 source files\n") is None
    assert mypy_riegel.summenzeile("Found 0 errors in 0 files (checked 59 source files)\n") == 0


def test_verstandene_ausgabe_hat_keine_fehlenden_zeilen():
    ausgabe = (
        "webtool/a.py:3: error: a  [assignment]\n"
        "webtool/b.py:1: error: b  [misc]\n"
        "Found 2 errors in 2 files (checked 59 source files)\n"
    )
    assert mypy_riegel.fehlende_zeilen(ausgabe, mypy_riegel.schluessel_liste(ausgabe)) == 0


def test_fehler_ohne_zeilennummer_faellt_auf_statt_zu_verschwinden():
    # Die ECHTE Form des Duplicate-Module-Abbruchs: kein `:zeile:`, also faellt
    # sie aus dem Muster. Ohne die Zaehlprobe waere sie lautlos weg — und der
    # Riegel meldete einen Befund weniger als mypy, also „Fortschritt".
    ausgabe = (
        "webtool/a.py:3: error: a  [assignment]\n"
        'webtool/__init__.py: error: Duplicate module named "webtool"\n'
        "Found 2 errors in 2 files (errors prevented further checking)\n"
    )
    assert mypy_riegel.schluessel_liste(ausgabe) == ["webtool/a.py:assignment"]
    assert mypy_riegel.fehlende_zeilen(ausgabe, mypy_riegel.schluessel_liste(ausgabe)) == 1


# --- Der Vergleich --------------------------------------------------------


def test_neuer_befund_wird_gemeldet():
    neue, entfallene = mypy_riegel.vergleich(
        ["a.py:assignment", "b.py:union-attr"], ["a.py:assignment"]
    )
    assert neue == ["b.py:union-attr"]
    assert entfallene == []


def test_behobener_befund_gilt_als_entfallen_nicht_als_neu():
    # Die Richtung ist der ganze Punkt: behoben darf NICHT rot machen.
    neue, entfallene = mypy_riegel.vergleich(
        ["a.py:assignment"], ["a.py:assignment", "b.py:union-attr"]
    )
    assert neue == []
    assert entfallene == ["b.py:union-attr"]


def test_zweiter_befund_desselben_codes_in_derselben_datei_zaehlt():
    # Ohne Vielfachheit waere ein zusaetzlicher `union-attr` in diarize.py
    # unsichtbar — der Schluessel steht dort schon achtmal.
    neue, entfallene = mypy_riegel.vergleich(
        ["d.py:union-attr", "d.py:union-attr"], ["d.py:union-attr"]
    )
    assert neue == ["d.py:union-attr"]
    assert entfallene == []


def test_tausch_innerhalb_derselben_datei_und_desselben_codes_bleibt_unsichtbar():
    # BENANNTE DECKE, kein Versehen (Begruendung an `vergleich()` im Riegel).
    # Die Eingaben unterscheiden sich real — Zeile 124 faellt weg, dafuer kommt
    # ein ANDERER union-attr in Zeile 301 dazu — und der Riegel sieht es nicht.
    # Wer den Schluessel je aendert, muss diesen Test anfassen und liest dabei,
    # warum er so steht.
    vorher = mypy_riegel.schluessel_liste(
        "webtool/diarize.py:88: error: x  [union-attr]\n"
        "webtool/diarize.py:124: error: y  [union-attr]\n"
    )
    nachher = mypy_riegel.schluessel_liste(
        "webtool/diarize.py:88: error: x  [union-attr]\n"
        "webtool/diarize.py:301: error: z  [union-attr]\n"
    )
    assert mypy_riegel.vergleich(nachher, vorher) == ([], [])


def test_zeilenverschiebung_allein_erzeugt_keinen_befund():
    # Derselbe Fund, andere Zeile — der Fall, an dem ein zeilennummern-basierter
    # Vergleich Rauschen meldet und deshalb weggeklickt wird.
    alt = mypy_riegel.schluessel_liste("webtool/app.py:356: error: x  [no-any-return]")
    neu = mypy_riegel.schluessel_liste("webtool/app.py:396: error: x  [no-any-return]")
    assert mypy_riegel.vergleich(neu, alt) == ([], [])


# --- Die ENTSCHEIDUNG: was der Riegel am Ende zurueckgibt ------------------
#
# Beim Ruff-Riegel war genau dieser Teil zuerst unbewacht, und das war messbar:
# sechs Mutationen liessen alle Tests gruen, darunter `return 1` -> `return 0`
# beim Fund. Getestet wird ueber `mypy_lauf`, damit kein mypy noetig ist.


def _riegel(monkeypatch, tmp_path, ausgabe, baseline, argv=()):
    ziel = tmp_path / "baseline.txt"
    if baseline is not None:
        ziel.write_text("".join(f"{z}\n" for z in baseline), encoding="utf-8")
    monkeypatch.setattr(mypy_riegel, "BASELINE", ziel)
    monkeypatch.setattr(mypy_riegel, "mypy_lauf", lambda: ausgabe)
    return mypy_riegel.main(list(argv)), ziel


_EIN_BEFUND = "a.py:1: error: x  [assignment]\nFound 1 error in 1 file (checked 59 source files)\n"


def test_neuer_befund_macht_rot(monkeypatch, tmp_path):
    rc, _ = _riegel(
        monkeypatch,
        tmp_path,
        "a.py:1: error: x  [assignment]\n"
        "b.py:2: error: y  [union-attr]\n"
        "Found 2 errors in 2 files (checked 59 source files)\n",
        ["a.py:assignment"],
    )
    assert rc == 1


def test_nur_behobenes_bleibt_gruen(monkeypatch, tmp_path):
    rc, _ = _riegel(
        monkeypatch, tmp_path, _EIN_BEFUND, ["a.py:assignment", "b.py:union-attr"]
    )
    assert rc == 0


def test_unveraendert_bleibt_gruen(monkeypatch, tmp_path):
    rc, _ = _riegel(monkeypatch, tmp_path, _EIN_BEFUND, ["a.py:assignment"])
    assert rc == 0


def test_unverstandene_zeile_bricht_mit_zwei_ab(monkeypatch, tmp_path):
    # Nicht rc 1: „ich habe eine Form nicht verstanden" ist kein Typfehler,
    # sondern ein Defekt des Riegels — und muss anders aussehen.
    rc, _ = _riegel(
        monkeypatch,
        tmp_path,
        "a.py:1: error: x  [assignment]\n"
        'webtool/__init__.py: error: Duplicate module named "webtool"\n'
        "Found 2 errors in 2 files (checked 59 source files)\n",
        ["a.py:assignment"],
    )
    assert rc == 2


def test_fehlende_baseline_bricht_mit_zwei_ab(monkeypatch, tmp_path):
    # Auch das ist „nicht urteilsfaehig", nicht „alles in Ordnung": ohne
    # Vergleichsmenge kann der Riegel nichts ueber neue Befunde sagen.
    rc, _ = _riegel(monkeypatch, tmp_path, _EIN_BEFUND, None)
    assert rc == 2


def test_schreiben_legt_die_baseline_neu_an(monkeypatch, tmp_path):
    rc, ziel = _riegel(
        monkeypatch,
        tmp_path,
        "b.py:2: error: y  [union-attr]\n"
        "a.py:1: error: x  [assignment]\n"
        "Found 2 errors in 2 files (checked 59 source files)\n",
        ["voellig:anders"],
        argv=["--schreiben"],
    )
    assert rc == 0
    assert ziel.read_text(encoding="utf-8") == "a.py:assignment\nb.py:union-attr\n"


# --- Der Riegel gegen das eigene Schweigen --------------------------------


def test_fehlendes_mypy_bricht_ab_statt_alles_als_behoben_zu_melden(monkeypatch):
    # GEMESSEN: `python -m mypy` ohne installiertes mypy endet mit rc 1 und
    # LEEREM stdout — derselbe Code wie „es gibt Typfehler". Ohne die
    # Stimmigkeitsprobe waere `befunde` leer, die ganzen 65 Eintraege der
    # Baseline gaelten als behoben, und der Riegel meldete rc 0.
    class Lauf:
        returncode = 1
        stdout = ""
        stderr = "python.exe: No module named mypy\n"

    monkeypatch.setattr(mypy_riegel.subprocess, "run", lambda *a, **k: Lauf())
    with pytest.raises(SystemExit) as ausgang:
        mypy_riegel.mypy_lauf()
    assert ausgang.value.code == 2


def test_abbruch_des_laufs_bricht_ab_statt_zu_urteilen(monkeypatch):
    # FALLE 3: ein Syntaxfehler irgendwo im Baum beendet mypy mit rc 2 und
    # einer Zeile, die wie ein Ergebnis AUSSIEHT. Wuerde der Riegel sie gegen
    # die Baseline vergleichen, meldete er „64 behoben" und rc 0 — gruen, weil
    # er blind war.
    class Lauf:
        returncode = 2
        stdout = (
            "kaputt.py:1: error: '(' was never closed  [syntax]\n"
            "Found 1 error in 1 file (errors prevented further checking)\n"
        )
        stderr = ""

    monkeypatch.setattr(mypy_riegel.subprocess, "run", lambda *a, **k: Lauf())
    with pytest.raises(SystemExit) as ausgang:
        mypy_riegel.mypy_lauf()
    assert ausgang.value.code == 2


def test_abbruchmarke_gilt_auch_ohne_rueckgabecode_zwei():
    # Der zweite Riegel fuer den Tag, an dem mypy denselben Abbruch mit 1
    # meldet. Heute traegt so ein Lauf rc 2 und faellt schon vorher durch —
    # ohne diesen Test waere die Marke unbewacht und koennte spurlos entfallen.
    grund = mypy_riegel.unstimmig(
        1,
        "kaputt.py:1: error: '(' was never closed  [syntax]\n"
        "Found 1 error in 1 file (errors prevented further checking)\n",
    )
    assert grund is not None
    assert "abgebrochen" in grund


def test_rueckgabecode_null_ohne_erfolgsmeldung_ist_unstimmig():
    # mypy sagt bei rc 0 immer `Success: no issues found`. Schweigt es, ist
    # etwas anderes passiert als ein sauberer Baum.
    assert mypy_riegel.unstimmig(0, "") is not None


def test_stimmige_ausgabe_geht_durch():
    # Negativkontrolle zu den drei Tests darueber: ohne sie belegten die nur,
    # dass `unstimmig` irgendetwas ablehnt.
    assert mypy_riegel.unstimmig(1, _EIN_BEFUND) is None
    assert mypy_riegel.unstimmig(0, "Success: no issues found in 59 source files\n") is None
