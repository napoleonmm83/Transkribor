import os
import pathlib
import pytest
from webtool import paths


def test_safe_name_accepts_normal():
    assert paths.safe_name("Foodfestival-Maienfeld") == "Foodfestival-Maienfeld"
    assert paths.safe_name("C0687_01913077") == "C0687_01913077"


@pytest.mark.parametrize("bad", [
    "../etc", "a/b", "a\\b", "..", "", "x\x00y", "C:temp", "Z:foo",
    "a\tb", "a\rb", "a\nb", "x\x1fy", "test\tfile", "name\nwith\nnewline",
    "del\x7ffile",
])
def test_safe_name_rejects_traversal(bad):
    with pytest.raises(ValueError):
        paths.safe_name(bad)


def test_safe_name_rejects_bare_dot_and_dotdot():
    # "." -> project_dir() == projekte_root() selbst -> rmtree würde die ganze
    # projekte/-Wurzel löschen (Task 4 Review-Fund). ".." war schon vorher über
    # die Substring-Prüfung abgedeckt, hier zusätzlich explizit gesperrt.
    with pytest.raises(ValueError):
        paths.safe_name(".")
    with pytest.raises(ValueError):
        paths.safe_name("..")


def test_sicherer_projektname_strip_dann_pruefen():
    """Kaltleser-Befund zu PR #491: das strip-then-check-Verhalten pinnt kein Test.
    Der Streich liegt VOR der Mengenpruefung — " active " ist also reserviert, nicht
    ein Whitespace-Zwilling; und getrimmte saubere Namen kommen normalisiert zurueck."""
    with pytest.raises(ValueError, match="reserviert"):
        paths.sicherer_projektname(" active ")
    assert paths.sicherer_projektname("  Weisstannen ") == "Weisstannen"
    with pytest.raises(ValueError, match="Klammern"):
        paths.sicherer_projektname("A]B")
    with pytest.raises(ValueError, match="Klammern"):
        paths.sicherer_projektname("A[B")
    # Nur-druckende Marken ohne Parse-Zweig und Gross-/Kleinschreibung kommen durch:
    assert paths.sicherer_projektname("Active") == "Active"
    assert paths.sicherer_projektname("autocorrect") == "autocorrect"


def test_reservierte_namen_entsprechen_den_parser_marken():
    """Vertrag (Kaltleser-Befund zu PR #491): die Menge ist aus den KONSUMENTEN
    abgeleitet — Backend UND Frontend. jobs.py parst vier Marken (Konstanten),
    jobPhases.ts ausserdem [fetch]; die Frontend-Seite wird aus dem QUELLTEXT
    geerntet (startsWith('[marke]'-Literale), nicht abgeschrieben — dieselbe Form
    wie das INVENTAR des Vertragstests. Baut jemand eine Marke in einem der beiden
    Parser dazu, ohne sie hier aufzunehmen, wird dieser Test rot — und umgekehrt."""
    import re
    from webtool import jobs
    aus_marken = {p.strip("[] ") for p in (jobs.SCOPE_PREFIX, jobs.SCOPE_ADD_PREFIX,
                                           jobs.ACTIVE_PREFIX, jobs.DONE_PREFIX)}
    ts = (pathlib.Path(__file__).parent / "frontend" / "src" / "lib" / "jobPhases.ts"
          ).read_text(encoding="utf-8")
    aus_frontend = set(re.findall(r"startsWith\('\[([^\]]+)\]", ts))
    assert aus_frontend, "Ernte leer — hat jobPhases.ts die Literale gewandelt?"
    assert paths.RESERVIERTE_NAMEN == aus_marken | aus_frontend


def test_projekte_root_respects_env(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    assert paths.projekte_root() == str(tmp_path)


def test_project_dir_joins(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    assert paths.project_dir("P") == os.path.join(str(tmp_path), "P")


def test_atomic_write_creates_file_and_no_tmp(tmp_path):
    target = tmp_path / "out.txt"
    paths.atomic_write(str(target), "hällo\n")
    assert target.read_text(encoding="utf-8") == "hällo\n"
    assert not (tmp_path / "out.txt.tmp").exists()  # tmp wurde umbenannt


def test_transcript_bases_excludes_derived(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    t = tmp_path / "P" / "transkripte"
    t.mkdir(parents=True)
    for n in ["S1.json", "S1.edit.json", "S1.correction.json", "S1.diar.json", "S2.json", "_glossar.json"]:
        (t / n).write_text("{}", encoding="utf-8")
    assert paths.transcript_bases("P") == ["S1", "S2"]  # _glossar.json ist Meta, kein Transkript


def test_beiseitelegen_rettet_den_inhalt(tmp_path):
    """#192/#196: der Retter fuer Dateien, die ein Read-Modify-Write sonst durch Defaults
    ersetzt. Bytes, kein Text — der Fall, fuer den es die Funktion gibt, ist eine Datei, die
    sich gar nicht als UTF-8 lesen laesst."""
    p = tmp_path / "settings.json"
    p.write_bytes(b'{"api_key": "sk-NOCH-LESBAR-\xff"}')
    ziel = paths.beiseitelegen(str(p))
    assert ziel == str(tmp_path / "settings.json.kaputt")
    assert not p.exists()                                        # der Weg ist frei fuers Neuschreiben
    assert b"sk-NOCH-LESBAR" in (tmp_path / "settings.json.kaputt").read_bytes()


def test_beiseitelegen_haelt_die_erste_rettung_fest(tmp_path):
    """Die ERSTE Rettung gewinnt. Nach ihr steht in der Datei nur noch Default-Inhalt — eine
    zweite Beschaedigung ueberschriebe also genau das, was man retten wollte (den API-Key).
    Rueckgabe "" heisst dabei „nichts gerettet", nicht „nichts da"."""
    p = tmp_path / "settings.json"
    (tmp_path / "settings.json.kaputt").write_bytes(b'{"api_key": "sk-DER-ECHTE"}')
    p.write_bytes(b'{"api_key": ""}')                            # die Default-Fassung danach
    assert paths.beiseitelegen(str(p)) == ""
    assert b"sk-DER-ECHTE" in (tmp_path / "settings.json.kaputt").read_bytes()


def test_beiseitelegen_haelt_den_schreiber_nicht_auf(tmp_path):
    """Best effort: es schuetzt vor einem Verlust, es ist nicht der Zweck des Aufrufs. Eine
    Datei, die gar nicht da ist (anderer Schreiber war schneller), darf nicht werfen —
    `settings.save()` gaebe sonst 500 und `setze_datei` liesse einen Upload scheitern."""
    assert paths.beiseitelegen(str(tmp_path / "gibt-es-nicht.json")) == ""
