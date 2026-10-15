"""Der echte version-Block muss vor npm version und git push abbrechen."""
import os
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/release.yml"
SHA = "0123456789abcdef0123456789abcdef01234567"


def _bash() -> str:
    if os.name == "nt":
        candidates = [Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"]
        if local := os.environ.get("LOCALAPPDATA"):
            candidates.append(Path(local) / "Programs/Git/bin/bash.exe")
    else:
        candidates = [Path("/bin/bash"), Path("/usr/bin/bash")]
    found = next((str(p) for p in candidates if p.is_file()), None)
    assert found, "Git Bash bzw. /bin/bash wird fuer die Workflow-Abnahme gebraucht"
    return found


def _block() -> str:
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = lines.index("      - id: plan")
    assert "        shell: bash" in lines[start:start + 6]
    run = lines.index("        run: |", start)
    body = []
    for line in lines[run + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= 8:
            break
        body.append(line)
    return textwrap.dedent("\n".join(body))


def _fahre(tmp_path: Path, antwort: str, *, readme: str = "Bereits verfuegbar.\n",
           freigeben: bool = True, tag: bool = False, gh_rc: int = 0):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    shutil.copyfile(ROOT / "scripts/release-vorabpruefung.sh", scripts / "release-vorabpruefung.sh")
    # Nur die anderen Release-Helfer werden ersetzt. Der neue Schutz ist echt.
    for name in ("versionshoehe", "notizen", "fassung", "macos-mindest", "release-vorabpruefung"):
        (scripts / f"{name}.test.sh").write_text("exit 0\n", encoding="utf-8")
    for name, body in (("fassung", "echo v1.0.0"), ("versionshoehe", "echo patch"), ("notizen", "exit 0")):
        (scripts / f"{name}.sh").write_text(body + "\n", encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    mocks = {
        "gh": '#!/bin/bash\nprintf "%s\\n" "$*" >> "$AUFRUFE"\nprintf "%s\\n" "$ANTWORT"\nexit "$GH_RC"\n',
        "npm": '#!/bin/bash\nprintf "npm %s\\n" "$*" >> "$AUFRUFE"\necho v1.0.1\n',
        "git": '#!/bin/bash\nprintf "git %s\\n" "$*" >> "$AUFRUFE"\n',
    }
    for name, body in mocks.items():
        p = bin_dir / name
        p.write_text(body, encoding="utf-8")
        p.chmod(0o755)
    (tmp_path / "README.md").write_text(readme, encoding="utf-8")
    calls = tmp_path / "calls"
    calls.write_text("", encoding="utf-8")
    output = tmp_path / "github_output"
    output.write_text("", encoding="utf-8")
    block = _block().replace("${{ inputs.freigeben }}", "true" if freigeben else "false")
    script = tmp_path / "plan.sh"
    # Git Bash stellt beim Start seine Programme vor den Windows-PATH.
    script.write_text('export PATH="$PWD/bin:$PATH"\n' + block + "\n", encoding="utf-8")
    env = dict(os.environ)
    env.update(ANTWORT=antwort, GH_RC=str(gh_rc), AUFRUFE=str(calls), GITHUB_OUTPUT=str(output),
               GITHUB_SHA=SHA, GITHUB_REF="refs/tags/v1.0.1" if tag else "refs/heads/master",
               GITHUB_REF_NAME="v1.0.1" if tag else "master")
    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    run = subprocess.run(  # noqa: S603 - feste Bash, lokales Fixtureskript und Timeout
                         [_bash(), "--noprofile", "--norc", "-eo", "pipefail", script.as_posix()],
                         cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30)
    return run, calls.read_text(encoding="utf-8"), output.read_text(encoding="utf-8")


@pytest.mark.parametrize("antwort", [
    "", f"{SHA}\tpush\tmaster\tin_progress\t", f"{SHA}\tpush\tmaster\tcompleted\tfailure",
    f"{SHA}\tpush\tmaster\tcompleted\tcancelled", f"{'f' * 40}\tpush\tmaster\tcompleted\tsuccess",
    f"{SHA}\tpush\tmaster\t\tcompleted\tsuccess", f"{SHA}\tpush\tmaster\tcompleted\tsuccess\t",
])
def test_keine_mutation_ohne_erfolgreiches_urteil(tmp_path, antwort):
    run, calls, output = _fahre(tmp_path, antwort)
    assert run.returncode != 0, run.stdout + run.stderr
    assert "npm version" not in calls
    assert "git push" not in calls
    assert "art=release" not in output
    assert "release-vorabpruefung:" in run.stderr


def test_api_fehler_verhindert_mutation(tmp_path):
    run, calls, _ = _fahre(tmp_path, f"{SHA}\tpush\tmaster\tcompleted\tsuccess", gh_rc=1)
    assert run.returncode != 0
    assert "npm version" not in calls


@pytest.mark.parametrize("hinweis", ["ab der nächsten Fassung", "AB DER NAECHSTEN FASSUNG",
                                    "ab der nächsten\nFassung", "ab der **nächsten**\n**Fassung**",
                                    "Nächste Fassung", "in naechster Fassung",
                                    "> ab der nächsten\n> Fassung", "in der nächsten\u00a0Fassung",
                                    "„ab der nächsten Fassung“",
                                    "in der naechsten&#160;Fassung", "in der naechsten&#xA0;Fassung",
                                    "in der naechsten&#00160;Fassung", "in der naechsten&#X00a0;Fassung",
                                    "in der naechsten&#8239;Fassung", "in der naechsten&#x202F;Fassung",
                                    "in der naechsten&#008239;Fassung", "in der naechsten&#X00202f;Fassung",
                                    "in einer der nächsten Fassungen", "NÄCHSTE FASSUNGEN",
                                    "naechsten Fassungen."])
@pytest.mark.parametrize("tag", [False, True])
def test_readme_verhindert_mutation_und_tagfreigabe(tmp_path, hinweis, tag):
    run, calls, output = _fahre(tmp_path, f"{SHA}\tpush\tmaster\tcompleted\tsuccess", readme=hinweis, tag=tag)
    assert run.returncode != 0
    assert "npm version" not in calls
    assert "git push" not in calls
    assert "art=release" not in output


def test_erfolg_erreicht_mutation_erst_nach_pruefung(tmp_path):
    run, calls, output = _fahre(tmp_path, f"{SHA}\tpush\tmaster\tcompleted\tsuccess")
    assert run.returncode == 0, run.stdout + run.stderr
    assert calls.index("run list") < calls.index("npm version") < calls.index("git push")
    assert "art=release" in output


def test_testbau_braucht_keine_liveabfrage(tmp_path):
    run, calls, output = _fahre(tmp_path, "", freigeben=False, readme="ab der nächsten Fassung")
    assert run.returncode == 0, run.stdout + run.stderr
    assert calls == ""
    assert "art=test" in output


def test_manueller_tag_prueft_readme_ohne_sha_laufabfrage(tmp_path):
    run, calls, output = _fahre(tmp_path, "", tag=True)
    assert run.returncode == 0, run.stdout + run.stderr
    assert calls == ""
    assert "art=release" in output


def test_testmatrizen_fahren_den_neuen_vertrag():
    release = WORKFLOW.read_text(encoding="utf-8")
    tests = (ROOT / ".github/workflows/test.yml").read_text(encoding="utf-8")
    assert "release-vorabpruefung" in _block().split("for t in ", 1)[1].split("; do", 1)[0].split()
    assert "bash scripts/release-vorabpruefung.test.sh" in release.split("  bauen:", 1)[1]
    assert "- run: bash scripts/release-vorabpruefung.test.sh" in tests.split("  skripte:", 1)[1]
    version = release.split("  version:", 1)[1].split("  bauen:", 1)[0]
    assert "      actions: read" in version
    assert "      contents: write" in version
    assert "GH_TOKEN: ${{ github.token }}" in version


def test_blockextraktion_haelt_die_schrittgrenze(tmp_path, monkeypatch):
    fixture = tmp_path / "workflow.yml"
    fixture.write_text(
        "      - id: plan\n        shell: bash\n        run: |\n"
        "          echo erster\n\n          echo letzter\n"
        "      - run: echo fremder-schritt\n  bauen:\n    run: echo fremder-job\n",
        encoding="utf-8",
    )
    monkeypatch.setitem(globals(), "WORKFLOW", fixture)
    assert _block().strip() == "echo erster\n\necho letzter"
    fixture.write_text("", encoding="utf-8")
    with pytest.raises(ValueError):
        _block()
