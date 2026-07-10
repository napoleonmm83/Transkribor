import os
import pytest
from webtool import paths


def test_safe_name_accepts_normal():
    assert paths.safe_name("Foodfestival-Maienfeld") == "Foodfestival-Maienfeld"
    assert paths.safe_name("C0687_01913077") == "C0687_01913077"


@pytest.mark.parametrize("bad", ["../etc", "a/b", "a\\b", "..", "", "x\x00y", "C:temp", "Z:foo"])
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
