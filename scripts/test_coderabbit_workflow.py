"""Der Workflow muss den Rueckgabecode des Riegels UEBERSETZEN — und tat es nicht.

Die 31 Tests in `test_coderabbit_riegel.py` pruefen das SKRIPT: welcher Fall welchen
Code ergibt. Kaputt war die Schicht darueber — die Uebersetzung dieses Codes in ein
Job-Ergebnis. Sie steht in `.github/workflows/coderabbit.yml` und hatte bis heute
keinen einzigen Test.

GEMESSEN am Lauf 34261972330, dem ersten mit echtem Schluessel: das Skript meldete
`3 Befund(e) ueber 5 Datei(en)` und schrieb den Kommentartext — und der Schritt starb
trotzdem mit `exit code 1`, der `Kommentar`-Schritt wurde uebersprungen. Ursache:
GitHub startet jeden `run:`-Block mit `/usr/bin/bash -e {0}`, und `set -uo pipefail`
schaltet `-e` NICHT ab. Die `case`-Auswertung wurde nie erreicht. Damit waeren rc 1
(Befunde da) und rc 3 (Kontingent leer) BEIDE rot gewesen, in beiden Faellen ohne
Kommentar — der Riegel haette ausgerechnet dann geschwiegen, wenn er etwas zu sagen hat.

Der Test FUEHRT den Block deshalb AUS, statt ihn zu lesen. Ein Test, der nachsieht, ob
`|| rc=$?` dort steht, prueft die Vorstellung des Autors; der Fehler war eine
Shell-Semantik, und die sieht man nur beim Ausfuehren.

KEIN YAML-Leser: `pyyaml` steht weder in `[dependency-groups]` noch in
`requirements.txt` (gemessen) — es liegt nur zufaellig in mancher venv. Ein Import
waere in der CI rot, dieselbe Klasse wie eine Fixture auf einem gitignorierten Pfad.
`scripts/test_pytest_riegel.py` liest `test.yml` aus demselben Grund per Regex.
"""
import os
import re
import subprocess
import textwrap
from pathlib import Path

import pytest

WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "coderabbit.yml"


def _bash() -> str | None:
    """Der VOLLE Pfad einer bash — nie ein blankes `bash`.

    Aus Python heraus trifft `bash` auf einem Windows-Rechner die WSL-Bash statt Git Bash
    (CLAUDE.md: CreateProcess durchsucht System32 zuerst, der PATH ist unschuldig). Eine
    WSL-Bash saehe die Windows-Pfade dieses Tests nicht. Dieselbe Loesungsform wie
    `finde_bash()` im Guardian-Paket: bekannte Pfade abklopfen, vollen Pfad uebergeben.

    Der erste Entwurf uebersprang stattdessen auf Windows — mit einer Nebenwirkung, die
    teurer gewesen waere als der Nutzen: die Mutationsserie haette dort ihre Zeugen
    uebersprungen und den Plan als NICHT gefangen gemeldet. Ein Fehlalarm in einem
    Waechter, und Fehlalarme werden weggeklickt. Gemessen: Git Bash 5.3.15 (MINGW64)
    faehrt denselben Vertrag Zeile fuer Zeile wie die Bash des ubuntu-Laeufers.
    """
    if os.name == "nt":
        kandidaten = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ]
        # Eine Git-Installation OHNE Administratorrechte (`winget install Git.Git` ohne
        # `--scope machine`) landet im Nutzerprofil. Ohne diesen Eintrag uebersprangen
        # dort fuenf von sechs Tests — mit `1 passed, 5 skipped` und rc 0, der Grund nur
        # unter `-rs` sichtbar. Befund des gegnerischen Reviewers.
        if lokal := os.environ.get("LOCALAPPDATA"):
            kandidaten.append(str(Path(lokal) / "Programs" / "Git" / "bin" / "bash.exe"))
    else:
        kandidaten = ["/bin/bash", "/usr/bin/bash"]
    return next((p for p in kandidaten if Path(p).is_file()), None)


BASH = _bash()

hat_bash = pytest.mark.skipif(
    BASH is None,
    reason=(
        "keine geeignete bash gefunden (Windows: Git Bash, sonst /bin/bash). Ein blankes "
        "`bash` waere hier die WSL-Bash und saehe die Pfade dieses Tests nicht."
    ),
)


def _runblock(schrittname: str) -> str:
    """Zieht den `run: |`-Block eines benannten Schritts aus der Workflow-Datei."""
    assert WORKFLOW.is_file(), f"{WORKFLOW} nicht gefunden — dieser Test misst dann nichts"
    zeilen = WORKFLOW.read_text(encoding="utf-8").splitlines()

    start = None
    for i, zeile in enumerate(zeilen):
        if re.match(rf"^\s*-\s+name:\s+{re.escape(schrittname)}\s*$", zeile):
            start = i
            break
    # Kein Treffer heisst NICHT "in Ordnung": dann haette der Test stillschweigend
    # nichts geprueft — dieselbe Fehlerklasse, gegen die der Riegel selbst gebaut ist.
    assert start is not None, f"Schritt {schrittname!r} nicht in {WORKFLOW.name} gefunden"

    run = None
    for i in range(start + 1, len(zeilen)):
        if re.match(r"^\s*-\s+name:", zeilen[i]):
            break
        # Dieser Test faehrt den Block hart als `bash -e` — GitHubs Vorgabe. Ein eigenes
        # `shell:` am Schritt wuerde ihn mit einer ANDEREN Shell fahren, und das bliebe
        # sonst STILL: mit `shell: sh` ist es auf ubuntu dash, dort stirbt `set -o pipefail`
        # in Zeile 1 („Illegal option -o pipefail", gemessen), waehrend alle Tests hier
        # gruen blieben. Der Test prueft dann die Vorstellung des Autors ueber den Laeufer
        # statt den Laeufer. Befund des gegnerischen Reviewers.
        assert not re.match(r"^\s*shell:", zeilen[i]), (
            f"Schritt {schrittname!r} traegt ein eigenes `shell:` — dieser Test faehrt aber "
            f"`bash -e`. Beide muessen dasselbe meinen, sonst misst er den falschen Lauf."
        )
        if re.match(r"^\s*run:\s*\|\s*$", zeilen[i]):
            run = i
            break
    assert run is not None, f"Schritt {schrittname!r} hat keinen `run: |`-Block"

    einzug = len(zeilen[run]) - len(zeilen[run].lstrip())
    koerper = []
    for zeile in zeilen[run + 1:]:
        if zeile.strip() and (len(zeile) - len(zeile.lstrip())) <= einzug:
            break
        koerper.append(zeile)
    text = textwrap.dedent("\n".join(koerper)).strip("\n")
    assert text, f"der `run:`-Block von {schrittname!r} ist leer"
    return text


def _fahre(skript_rc: int, tmp_path: Path) -> tuple[int, str, str]:
    """Faehrt den Review-Block so, wie GitHub ihn faehrt: `bash -e`, mit einem
    `python` auf dem PATH, das genau `skript_rc` liefert."""
    schiene = tmp_path / "bin"
    schiene.mkdir()
    platzhalter = schiene / "python"
    platzhalter.write_text(f"#!/bin/sh\nexit {skript_rc}\n", encoding="utf-8")
    platzhalter.chmod(0o755)

    skript = tmp_path / "review.sh"
    skript.write_text(_runblock("Review") + "\n", encoding="utf-8")

    ausgabe = tmp_path / "github_output"
    ausgabe.write_text("", encoding="utf-8")

    umgebung = dict(os.environ)
    umgebung["PATH"] = f"{schiene}{os.pathsep}{umgebung.get('PATH', '')}"
    umgebung["GITHUB_OUTPUT"] = str(ausgabe)
    umgebung["RUNNER_TEMP"] = str(tmp_path)
    umgebung["BASIS"] = "0" * 40

    # `-e` ist kein Schmuck, sondern der ganze Punkt: GitHub startet den Block als
    # `bash -e {0}`, und genau daran ist er gestorben. Ohne das Flag pruefte dieser
    # Test einen Lauf, den es in der CI nicht gibt.
    assert BASH is not None, "ohne bash darf dieser Test nicht laufen, sondern uebersprungen werden"
    lauf = subprocess.run(  # noqa: S603 - fester bash-Pfad auf ein selbst geschriebenes Skript
        [BASH, "-e", skript.as_posix()],
        capture_output=True, text=True, env=umgebung, cwd=tmp_path, timeout=30,
    )
    return lauf.returncode, ausgabe.read_text(encoding="utf-8"), lauf.stdout + lauf.stderr


def test_der_runblock_ist_auffindbar():
    """Ohne diesen Waechter koennte die Extraktion still ins Leere greifen."""
    block = _runblock("Review")
    assert "coderabbit_riegel.py" in block
    assert 'case "$rc" in' in block


def test_ein_eigenes_shell_am_schritt_faellt_auf(tmp_path, monkeypatch):
    """Die `shell:`-Wache muss FEUERN, nicht bloss dastehen.

    Gemessen auf einer Kopie: mit `shell: sh` faehrt GitHub den Block auf ubuntu als dash,
    und dort stirbt `set -o pipefail` in Zeile 1 („Illegal option"). Alle uebrigen Tests
    hier blieben dabei gruen — sie fahren ja `bash`. Genau deshalb braucht die Wache einen
    eigenen Zeugen, sonst ist sie eine Zeile ohne Beweis.
    """
    zeilen = WORKFLOW.read_text(encoding="utf-8").splitlines()
    for i, zeile in enumerate(zeilen):
        if zeile.strip() == "- name: Review":
            zeilen.insert(i + 2, "        shell: sh")
            break
    else:
        raise AssertionError("Schritt Review nicht gefunden — dieser Test misst dann nichts")

    kopie = tmp_path / "coderabbit.yml"
    kopie.write_text("\n".join(zeilen) + "\n", encoding="utf-8")
    monkeypatch.setitem(globals(), "WORKFLOW", kopie)

    with pytest.raises(AssertionError, match="shell:"):
        _runblock("Review")


def test_ein_shell_im_NACHBARschritt_ist_kein_fehlalarm(tmp_path, monkeypatch):
    """Die Wache darf nur den eigenen Schritt sehen — sonst ist sie ein Fehlalarm."""
    zeilen = WORKFLOW.read_text(encoding="utf-8").splitlines()
    for i, zeile in enumerate(zeilen):
        if zeile.strip() == "- name: Kommentar":
            zeilen.insert(i + 2, "        shell: sh")
            break
    else:
        raise AssertionError("Schritt Kommentar nicht gefunden — dieser Test misst dann nichts")

    kopie = tmp_path / "coderabbit.yml"
    kopie.write_text("\n".join(zeilen) + "\n", encoding="utf-8")
    monkeypatch.setitem(globals(), "WORKFLOW", kopie)

    assert "coderabbit_riegel.py" in _runblock("Review")


@hat_bash
def test_kein_befund_bleibt_gruen(tmp_path):
    rc, ausgabe, text = _fahre(0, tmp_path)
    assert rc == 0, f"rc 0 des Skripts muss gruen bleiben, war {rc}:\n{text}"
    assert "kommentar=ja" not in ausgabe, "ohne Befunde darf kein Kommentar angefordert werden"


@hat_bash
def test_befunde_bleiben_GRUEN_und_loesen_den_kommentar_aus(tmp_path):
    """Der Fall aus Lauf 34261972330 — der Riegel urteilt, der Job wirft es weg."""
    rc, ausgabe, text = _fahre(1, tmp_path)
    assert rc == 0, (
        f"rc 1 heisst GEPRUEFT, Befunde da — das ist gruen. War {rc}. "
        f"Genau hier stirbt der Schritt, wenn `-e` noch greift:\n{text}"
    )
    assert "kommentar=ja" in ausgabe, (
        "ohne diese Zeile wird der Kommentar-Schritt uebersprungen und die Befunde "
        "verschwinden mit dem Laeufer-Temp"
    )


@hat_bash
def test_kontingent_bleibt_GRUEN_und_loest_den_kommentar_aus(tmp_path):
    rc, ausgabe, text = _fahre(3, tmp_path)
    assert rc == 0, f"rc 3 (Kontingent leer) ist gruen mit Warnung, war {rc}:\n{text}"
    assert "kommentar=ja" in ausgabe
    assert "::warning::" in text, "ein erschoepftes Kontingent muss sichtbar warnen"


@hat_bash
def test_kein_urteil_faerbt_ROT(tmp_path):
    rc, ausgabe, text = _fahre(2, tmp_path)
    assert rc == 1, f"rc 2 muss der Schritt selbst zu 1 machen, war {rc}:\n{text}"
    assert "::error::" in text
    assert "kommentar=ja" not in ausgabe, "ohne Urteil gibt es nichts zu kommentieren"


@hat_bash
def test_code_ausserhalb_des_vertrags_faerbt_ROT(tmp_path):
    """127, 137, 139, 143 — der Zweig, der in der ersten Fassung ganz fehlte."""
    rc, ausgabe, text = _fahre(127, tmp_path)
    assert rc == 1, f"ein Code ausserhalb 0/1/2/3 muss rot werden, war {rc}:\n{text}"
    assert "ausserhalb seines Vertrags" in text
    assert "kommentar=ja" not in ausgabe
