"""Waechter fuer die Mutationsplaene selbst — bindet sie an den Baum, in Sekunden.

WOZU. Ein Mutationsplan ankert woertlich in Quelltext. Verschiebt jemand die Stelle,
schreibt sie um oder verdoppelt sie, ist der Plan still veraltet — und das faellt heute
erst auf, wenn die volle Serie laeuft: minutenlange Testlaeufe, die nichts mehr messen.
GEMESSEN am 2026-09-08: eine Serie lief von 06:27:47Z bis 06:37:01Z gegen einen Plan, der
ab Sekunde 0 nicht mehr passte. Dieser Waechter kostet Sekunden und laeuft bei JEDER
Aenderung mit, weil `testpaths` in pyproject.toml `scripts` enthaelt.

Damit teilt sich die Absicherung sauber auf:
  * hier   — passt der Plan noch zum Baum? (billig, jede Aenderung, beide Plattformen)
  * Serie  — schlaegt der Waechter wirklich an? (teuer, nur wenn er betroffen ist)

Es ist dieselbe Klasse wie `tabelle-hinkt-still-hinterher` (#536): eine Nachschlagetabelle
gegen die Aussenwelt veraltet lautlos, und der Riegel dagegen ist ein Test, der sie an
ihren Konsumenten bindet.

CRLF ist kein Detail: ein Teil der Anker ist MEHRZEILIG, und der Arbeitsbaum steht auf
Windows auf CRLF. (Die genaue Zahl steht hier bewusst nicht: sie aendert sich mit jedem
Plan, und eine Zahl in einem Kommentar driftet unsichtbar — dieselbe Lehre wie #536. Wer
sie braucht, zaehlt sie.) Ohne `zeilenenden_angleichen` findet ein mehrzeiliger Anker NICHTS —
und "nicht gefunden" ist von "die Stelle gibt es nicht mehr" nicht zu unterscheiden.
Deshalb wird hier dieselbe Funktion benutzt wie im Treiber, nicht eine zweite Fassung
daneben: zwei Stellen fuer eine Regel driften.
"""

import json
import sys
from pathlib import Path

# Der Pfad muss VOR dem Import stehen — E402/I001 sind hier die Folge der Reihenfolge,
# nicht der Unordnung. Dieselbe Form wie in test_mutation.py.
sys.path.insert(0, str(Path(__file__).parent))
import mutation  # noqa: E402, I001
import mutationen_lauf  # noqa: E402, I001

WURZEL = Path(__file__).resolve().parents[1]
PLANORDNER = WURZEL / "scripts" / "mutationen"
PFLICHT = {"id", "datei", "von", "nach", "rot"}


def plaene() -> list[Path]:
    return sorted(PLANORDNER.glob("*.json"))


def _testkommando_fehler(plan: dict, wurzel: Path) -> str | None:
    """Prueft die Projekt-Befehlsformen ohne Tests oder Frontend-Pakete zu starten.

    Der Python-CI-Job sammelt diesen Waechter ein, installiert aber kein npm. Deshalb
    pruefen wir npm-Skripte am Manifest; der echte Vorlauf prueft die Laufumgebung.
    """
    ci = plan.get("nur_ci")
    if ci is not None and (not isinstance(ci, str) or not ci.strip()):
        return "`nur_ci` braucht einen nichtleeren Grund"
    kommando = plan.get("test")
    if not isinstance(kommando, str) or not kommando.strip():
        return "`test` fehlt oder ist leer"
    teile = mutation._direkte_kommando_teile(kommando)
    if not teile:
        return "Testkommando ist nicht direkt startbar"
    if teile[:3] == ["python", "-m", "pytest"]:
        optionen_mit_wert = {
            "-k", "-m", "-c", "-o", "-p", "--rootdir", "--basetemp",
            "--confcutdir", "--ignore", "--ignore-glob", "--deselect", "--maxfail",
        }
        index = 3
        while index < len(teile):
            teil = teile[index]
            if teil in optionen_mit_wert:
                if index + 1 == len(teile) or teile[index + 1].startswith("-"):
                    return f"Pytest-Option {teil} braucht einen Wert"
                index += 2
                continue
            if not teil.startswith("-"):
                pfad = teil.split("::", 1)[0]
                if not (wurzel / pfad).exists():
                    return f"Testpfad {pfad} existiert nicht"
            index += 1
        return None
    if len(teile) >= 4 and teile[:2] == ["npm", "--prefix"]:
        paket = wurzel / teile[2] / "package.json"
        if not paket.is_file():
            return f"npm-Paket {paket} existiert nicht"
        skript = teile[3] if teile[3] != "run" else (teile[4] if len(teile) > 4 else "")
        try:
            manifest = json.loads(paket.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return f"npm-Paket {paket} ist kein lesbares JSON-Manifest"
        scripts = manifest.get("scripts") if isinstance(manifest, dict) else None
        if not isinstance(scripts, dict) or skript not in scripts:
            return f"npm-Skript {skript!r} ist in {paket} nicht definiert"
        if not mutation._npm_testlaeufer(teile, wurzel):
            return f"npm-Skript {skript!r} startet keinen unterstuetzten Testlaeufer"
        return None
    if ci is None:
        return f"Testkommando {teile[0]!r} ist lokal nicht aufloesbar; `nur_ci` begruenden"
    return None


def test_es_gibt_ueberhaupt_plaene():
    """Der Riegel gegen das eigene Schweigen — er steht bewusst VOR allen anderen.

    Jeder Test darunter iteriert ueber `plaene()`. Ist die Liste leer — Ordner
    umbenannt, Endung geaendert, Glob vertippt —, laufen sie alle durch, ohne etwas
    angesehen zu haben, und melden gruen. Dieselbe Klasse wie `tests 0` mit rc 0 und
    wie `CodeRabbit pass` bei erschoepftem Kontingent.

    KEINE feste Mindestzahl: ein Waechter, den jeder neue Plan nachziehen muss, wird
    weggeklickt. Gezaehlt wird "mehr als null", nicht "so viele wie gestern" — die
    getragene Grenze dazu steht im Modul-Docstring von scripts/testlauf.mjs, und sie
    gilt hier genauso: verschwindet EIN Plan, faellt das hier nicht auf.
    """
    assert plaene(), f"keine Mutationsplaene unter {PLANORDNER} gefunden"


def test_jeder_plan_traegt_die_objektform():
    """Nur mit `test`/`pfade` kann ein Laeufer alle Plaene fahren, ohne eine Tabelle.

    Die blanke Liste bleibt im TREIBER zulaessig (Ad-hoc-Plan von Hand); streng ist der
    Waechter — hier, wo die Plaene liegen, die die CI faehrt.
    """
    for datei in plaene():
        plan = json.loads(datei.read_text(encoding="utf-8"))
        assert isinstance(plan, dict), (
            f"{datei.name}: blanke Liste. Unter scripts/mutationen/ braucht ein Plan die"
            " Objektform mit test/pfade/mutationen — sonst findet ihn der Laeufer nicht.")
        assert isinstance(plan.get("test"), str) and plan["test"].strip(), (
            f"{datei.name}: `test` fehlt oder ist leer")
        assert isinstance(plan.get("pfade"), list) and plan["pfade"], (
            f"{datei.name}: `pfade` fehlt oder ist leer — dann waehlt der Laeufer ihn nie")
        assert all(isinstance(p, str) for p in plan["pfade"]), f"{datei.name}: pfade"
        assert isinstance(plan.get("mutationen"), list) and plan["mutationen"], (
            f"{datei.name}: `mutationen` fehlt oder ist leer — eine Serie mit null"
            " Mutationen geht als bestanden durch")
        umgebung = plan.get("env", {})
        assert isinstance(umgebung, dict), f"{datei.name}: `env` muss ein Objekt sein"
        assert all(isinstance(k, str) and isinstance(v, str) for k, v in umgebung.items()), (
            f"{datei.name}: `env` nimmt nur Zeichenketten — eine Zahl kaeme als"
            " TypeError im subprocess-Aufruf heraus, nicht als Meldung")


def test_jede_mutation_traegt_ihre_pflichtfelder():
    for datei in plaene():
        plan = json.loads(datei.read_text(encoding="utf-8"))
        for m in plan["mutationen"]:
            fehlend = PFLICHT - m.keys()
            assert not fehlend, f"{datei.name}/{m.get('id', '?')}: fehlt {sorted(fehlend)}"
            assert m["rot"], (
                f"{datei.name}/{m['id']}: `rot` ist leer — eine Mutation ohne erwarteten"
                " roten Test besteht BEDINGUNGSLOS und belegt nichts")


def test_jede_mutierte_datei_steht_in_pfaden():
    """Sonst waehlt der Laeufer den Plan nicht aus, obwohl die Aenderung ihn trifft.

    Das ist die eine Zusicherung, die `pfade` ueberhaupt verlaesslich macht: die Liste
    ist von Hand gepflegt, und eine von Hand gepflegte Liste vergisst.
    """
    for datei in plaene():
        plan = json.loads(datei.read_text(encoding="utf-8"))
        pfade = set(plan["pfade"])
        for m in plan["mutationen"]:
            assert m["datei"] in pfade, (
                f"{datei.name}/{m['id']}: {m['datei']} fehlt in `pfade` — eine Aenderung"
                " daran wuerde diesen Plan nicht ausloesen")


def test_jeder_pfad_existiert():
    for datei in plaene():
        plan = json.loads(datei.read_text(encoding="utf-8"))
        for p in plan["pfade"]:
            assert (WURZEL / p).is_file(), f"{datei.name}: {p} gibt es nicht (mehr)"


def test_jeder_plan_hat_ein_startbares_testkommando_oder_ci_vermerk():
    for datei in plaene():
        plan = json.loads(datei.read_text(encoding="utf-8"))
        grund = _testkommando_fehler(plan, WURZEL)
        assert grund is None, f"{datei.name}: {grund}"


def test_renovate_plan_traegt_seine_ci_voraussetzung():
    plan = json.loads((PLANORDNER / "renovate_regeln.json").read_text(encoding="utf-8"))
    assert isinstance(plan.get("nur_ci"), str) and plan["nur_ci"].strip()


def test_unstartbares_kommando_braucht_ci_vermerk(tmp_path):
    assert _testkommando_fehler({"test": "unbekanntes-programm --run"}, tmp_path)
    assert _testkommando_fehler({"test": "python -m pytest fehlt.py -q"}, tmp_path)
    assert _testkommando_fehler({"test": "python -m pytest fehlt -q"}, tmp_path)
    assert _testkommando_fehler({"test": "python -m pytest fehlt.py::test_x -q"}, tmp_path)
    assert _testkommando_fehler({"test": "python -m pytest -k"}, tmp_path)
    assert _testkommando_fehler({"test": "python -m pytest -k -q"}, tmp_path)
    assert _testkommando_fehler({"test": "npm --prefix frontend run unbekannt"}, tmp_path)
    assert _testkommando_fehler({"test": "unbekanntes-programm", "nur_ci": " "}, tmp_path)
    assert _testkommando_fehler({"test": "unbekanntes-programm",
                                "nur_ci": "braucht externen CI-Dienst"}, tmp_path) is None


def test_pytest_filter_sind_keine_dateipfade(tmp_path):
    (tmp_path / "tests").mkdir()
    assert _testkommando_fehler(
        {"test": 'python -m pytest tests -k "ein test" -m smoke -q'}, tmp_path
    ) is None


def test_npm_skript_am_rand_der_befehlsform(tmp_path):
    paket = tmp_path / "frontend"
    paket.mkdir()
    (paket / "package.json").write_text(
        json.dumps({"scripts": {"test": "vitest run", "e2e": "playwright test"}}),
        encoding="utf-8",
    )
    assert _testkommando_fehler({"test": "npm --prefix frontend test"}, tmp_path) is None
    assert _testkommando_fehler({"test": "npm --prefix frontend run e2e"}, tmp_path) is None
    assert _testkommando_fehler({"test": "npm --prefix frontend run"}, tmp_path)
    assert _testkommando_fehler({"test": "npm --prefix frontend test && fehlt"}, tmp_path)
    assert _testkommando_fehler({"test": "npm --prefix frontend test &&"}, tmp_path)
    assert _testkommando_fehler({"test": "npm --prefix frontend test\necho 1 passed"}, tmp_path)
    assert _testkommando_fehler(
        {"test": "python -m pytest --version -k \"$(echo 1 passed)\""}, tmp_path
    )
    assert _testkommando_fehler(
        {"test": "python -m pytest --version -k 'a&echo 1 passed'"}, tmp_path
    )
    assert _testkommando_fehler({"test": 'npm --prefix frontend test -- -t "a|b"'}, tmp_path) is None
    (paket / "package.json").write_text(
        json.dumps({"scripts": {"test": "echo 1 passed"}}), encoding="utf-8"
    )
    assert _testkommando_fehler({"test": "npm --prefix frontend test"}, tmp_path)
    (paket / "package.json").write_text("[]", encoding="utf-8")
    assert _testkommando_fehler({"test": "npm --prefix frontend test"}, tmp_path)


def test_jeder_anker_passt_genau_einmal():
    """Der eigentliche Riegel: der Plan gegen den heutigen Baum.

    Passt ein Anker nicht mehr genau einmal, ist der Plan veraltet — und zwar SOFORT
    sichtbar, statt erst nach zehn Minuten Serie. Wer Code umbaut, zieht den Plan im
    selben PR nach; das ist der Preis und er ist gewollt.
    """
    for datei in plaene():
        plan = json.loads(datei.read_text(encoding="utf-8"))
        for m in plan["mutationen"]:
            ziel = WURZEL / m["datei"]
            inhalt = ziel.read_bytes().decode("utf-8")
            von = mutation.zeilenenden_angleichen(inhalt, m["von"])
            eindeutig, treffer = mutation.anker_ok(inhalt, von)
            assert eindeutig, (
                f"{datei.name}/{m['id']}: Anker passt {treffer}-mal auf {m['datei']},"
                " erwartet genau 1 — der Plan ist veraltet.")


def test_jeder_rot_und_gruen_name_existiert_wirklich():
    """Ein vertippter `gruen`-Name ist eine Gegenprobe, die es nicht gibt — und sie schweigt.

    Der Treiber sucht die `gruen`-Namen in den ROTEN Zeilen der Ausgabe: taucht der Name
    dort auf, ist die Mutation zu breit. Ein Name, den es gar nicht gibt, taucht nie auf —
    die Gegenprobe gilt damit als erfuellt, ohne je etwas geprueft zu haben. Bei `rot` ist
    derselbe Tippfehler laut (die Mutation gilt als wirkungslos), bei `gruen` ist er stumm.
    Genau die Asymmetrie macht ihn gefaehrlich.

    Gesucht wird in den Dateien aus `pfade` — nicht ueber das Testkommando geparst. Das hat
    zwei Gruende: der Befehl kann `npm --prefix … --` heissen und seine Pfade relativ zu
    einem anderen Wurzelverzeichnis nennen, und ein Testname, der in KEINER der Dateien
    steht, die den Plan betreffen, gehoert ohnehin nicht hierher.

    Verglichen wird der Name VOR der eckigen Klammer: pytest haengt dort die Parameter an
    (`test_x[fall_a]`), und die stehen im Quelltext nicht als Text.

    Befund des kalten Diff-Lesers; zum Zeitpunkt des Einbaus waren alle Namen vorhanden.
    """
    fehlend = []
    geprueft = 0
    for datei in plaene():
        plan = json.loads(datei.read_text(encoding="utf-8"))
        texte = []
        for p in plan["pfade"]:
            ziel = WURZEL / p
            if ziel.is_file():
                texte.append(ziel.read_text(encoding="utf-8", errors="replace"))
        zusammen = "\n".join(texte)
        for m in plan["mutationen"]:
            for art in ("rot", "gruen"):
                for name in m.get(art, []):
                    geprueft += 1
                    if name.split("[")[0] not in zusammen:
                        fehlend.append(f"{datei.name}/{m['id']}: {art} `{name}`")
    # Ohne diese Zahl waere der Test gruen, wenn die Schleife nie etwas ansieht.
    assert geprueft > 0, "kein einziger rot/gruen-Name geprueft — die Schleife lief leer"
    assert not fehlend, (
        f"{len(fehlend)} von {geprueft} Testnamen stehen in keiner Datei aus `pfade`:\n  "
        + "\n  ".join(fehlend[:10]))


def test_globale_pfade_existieren_und_ziehen_JEDEN_plan():
    """Die Liste, die ALLE Plaene ausloest, darf weder ins Leere zeigen noch teilwirken.

    Sie deckt, was kein `pfade`-Eintrag deckt: der Treiber selbst, die Wurzel-conftest,
    die pytest-Konfiguration, die vitest-Konfiguration, die gemeinsame Testhuelle. Aendert
    sich dort etwas, kann JEDER Plan seine Aussagekraft verlieren, ohne dass eine seiner
    Dateien angefasst wurde.

    Geprueft wird JEDER Eintrag einzeln, nicht zwei von neun: die vorige Fassung haette es
    nicht gemerkt, wenn jemand `pyproject.toml` oder `setupTests.ts` aus der Liste nimmt
    (Befund des gegnerischen Pruefers). Und die Existenz allein genuegt nicht — ein Eintrag,
    der da ist, aber nicht mehr auswaehlt, deckt genauso wenig.
    """
    # Das Weglassen eines Eintrags bliebe sonst gruen: die Schleife unten prueft nur, was
    # DA ist. Fuer „vollstaendig" gibt es kein Orakel — also wird die begruendete Menge
    # festgenagelt. Hinzufuegen bleibt frei (Obermenge), Herausnehmen wird eine bewusste
    # Handlung mit einem roten Test davor. Dieselbe Bauform wie eine Linter-Baseline.
    pflicht = {
        "scripts/mutation.py",              # ein Treiberfehler entwertet JEDE Serie
        "scripts/mutationen_lauf.py",       # dito fuer die Auswahl
        "conftest.py",                      # Lauf-Deckel und Fixtures aller pytest-Plaene
        "pyproject.toml",                   # die pytest-Sicht selbst
        "webtool/frontend/vitest.config.ts",  # die des Frontends
    }
    fehlend = pflicht - set(mutationen_lauf.GLOBALE_PFADE)
    assert not fehlend, (
        f"aus GLOBALE_PFADE verschwunden: {sorted(fehlend)} — damit faellt die Deckung fuer"
        " ALLE Plaene weg, und zwar lautlos. Wenn das gewollt ist, hier mit begruenden.")

    assert mutationen_lauf.GLOBALE_PFADE, "die Liste ist leer — dann deckt sie nichts"
    alle = mutationen_lauf.lade_plaene(WURZEL)
    assert alle, "keine Plaene geladen — der Test misst dann nichts"
    for p in mutationen_lauf.GLOBALE_PFADE:
        assert (WURZEL / p).exists(), f"globaler Pfad {p} gibt es nicht (mehr)"
        gewaehlt = mutationen_lauf.waehle(alle, {p})
        assert len(gewaehlt) == len(alle), (
            f"{p} steht in GLOBALE_PFADE, waehlt aber nur {len(gewaehlt)} von {len(alle)}")
