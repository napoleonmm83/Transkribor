"""Waechter fuer den CodeRabbit-Riegel — und der Riegel ist gegen SCHWEIGEN gebaut.

Alle Fixtures sind ECHTE Ausgaben, keine erfundenen: die Erfolgsform steht als Datei im
Repo (`.code-guardian-evidence/2026-09-08--579-…/coderabbit-cli.txt`, der Lauf zu #579), die
zwei Fehlerformen sind am 2026-09-08 an der CLI 0.7.6 gemessen worden. Das ist dieselbe
Hausregel wie in `test_mutation.py`: eine erfundene Ausgabe prueft die Vorstellung des
Autors, nicht das Werkzeug.

AUSDRUECKLICH NICHT ENTHALTEN ist eine `rate_limit`-Fixture. CLAUDE.md nennt diese Form aus
einer aelteren CLI; in 0.7.6 loest ein Limit ein `action_required`-Ereignis aus (im Binary
nachgelesen, nicht durch Erschoepfung gemessen). Statt die Form zu raten, deckt der Riegel
den Fall ueber die allgemeine Regel: ohne `review_completed` gibt es kein Urteil.
"""

import sys
from pathlib import Path

# Der Pfad muss VOR dem Import stehen — E402/I001 sind hier die Folge der Reihenfolge,
# nicht der Unordnung. Dieselbe Form wie in test_mutation.py.
sys.path.insert(0, str(Path(__file__).parent))
import coderabbit_riegel as riegel  # noqa: E402, I001

WURZEL = Path(__file__).resolve().parents[1]
EVIDENZ = (WURZEL / ".code-guardian-evidence" / "2026-09-08--579-weitergereichtes-then"
           / "coderabbit-cli.txt")

# --- Gemessen am 2026-09-08, CLI 0.7.6 ------------------------------------

# Leerer Diff: die CLI endet VOR jeder Anmeldung, mit einem UNGUELTIGEN Schluessel, rc 0.
UEBERSPRUNGEN = (
    '{"type":"review_context","reviewType":"committed","currentBranch":"master",'
    '"baseBranch":"master","baseCommit":"HEAD","workingDirectory":"/mnt/e/Git/Transkribor"}\n'
    '{"type":"status","phase":"setup","status":"review_skipped",'
    '"message":"No committed changes detected"}\n'
    '{"type":"complete","status":"review_skipped","findings":0,'
    '"message":"No committed changes detected"}\n'
)

# Ungueltiger Schluessel: drei Zeilen, keine `complete`, dazu Klartext auf stderr.
AUTHFEHLER = (
    '{"type":"review_context","reviewType":"committed","currentBranch":"master",'
    '"baseBranch":"master","baseCommit":"HEAD~1","workingDirectory":"/mnt/e/Git/Transkribor"}\n'
    '{"type":"status","phase":"connecting","status":"connecting_to_review_service"}\n'
    '{"type":"error","errorType":"connection",'
    '"message":"Connection failed: Invalid or expired API key","recoverable":true}\n'
    "Error: Invalid or expired API key\n"
)


def test_die_evidenzdatei_ist_da():
    """Der Riegel gegen das eigene Schweigen DIESER Datei.

    Faellt die Fixture weg (umbenannt, aufgeraeumt), liefen die Tests darunter ueber eine
    leere Liste und blieben gruen — dieselbe Klasse wie `tests 0` mit rc 0.
    """
    assert EVIDENZ.is_file(), f"{EVIDENZ} fehlt — die Erfolgstests messen dann nichts"


def test_erfolg_wird_als_urteil_erkannt():
    text = EVIDENZ.read_text(encoding="utf-8")
    ereignisse, complete, befunde = riegel.lies(text)
    assert complete is not None
    assert complete["status"] == "review_completed"
    assert len(befunde) == 1
    assert riegel.unstimmig(ereignisse, complete, befunde) is None


def test_review_skipped_ist_KEIN_urteil():
    """Der teuerste Fall: `complete` da, rc 0 — und trotzdem wurde nichts geprueft.

    So endet die CLI bei leerem Diff, und zwar BEVOR sie den Dienst kontaktiert. Ein
    Riegel, der nur auf die Anwesenheit der `complete`-Zeile sieht, meldet hier
    „gelaufen, keine Befunde". Gemessen mit einem absichtlich falschen Schluessel.
    """
    ereignisse, complete, befunde = riegel.lies(UEBERSPRUNGEN)
    assert complete is not None, "die complete-Zeile ist da — genau das ist die Falle"
    grund = riegel.unstimmig(ereignisse, complete, befunde)
    assert grund is not None
    assert "review_skipped" in grund
    assert "NICHT geprueft" in grund


def test_authfehler_ist_kein_urteil():
    ereignisse, complete, befunde = riegel.lies(AUTHFEHLER)
    assert complete is None
    grund = riegel.unstimmig(ereignisse, complete, befunde)
    assert grund is not None
    assert "connection" in grund and "Invalid or expired API key" in grund


def test_abbruch_ohne_jede_meldung_ist_kein_urteil():
    """Timeout, Kill, abgeschnittene Ausgabe — kein `complete`, keine `error`-Zeile."""
    teil = UEBERSPRUNGEN.splitlines()[0] + "\n"
    ereignisse, complete, befunde = riegel.lies(teil)
    grund = riegel.unstimmig(ereignisse, complete, befunde)
    assert grund is not None and "keine `complete`-Zeile" in grund


def test_action_required_wird_benannt():
    """0.7.6 meldet ein erschoepftes Kontingent als Handlungsaufforderung, nicht als Fehler.

    Die Form stammt aus dem Binary (`onDemandReviewAvailable` … `rerun_with_use_credits`),
    nicht aus einem erschoepften Kontingent — deshalb steht hier nur das Geruest, und der
    Riegel faengt den Fall ueber die allgemeine Regel „ohne review_completed kein Urteil".
    """
    text = ('{"type":"action_required","status":"awaiting_confirmation",'
            '"action":"rerun_with_use_credits","command":"coderabbit review --use-credits"}\n')
    ereignisse, complete, befunde = riegel.lies(text)
    grund = riegel.unstimmig(ereignisse, complete, befunde)
    assert grund is not None
    assert "rerun_with_use_credits" in grund and "Kontingent" in grund


def test_die_zahlen_muessen_stimmen():
    """Der zweite Zeuge: `findings: N` gegen die Zahl der finding-Zeilen.

    Eine abgeschnittene Ausgabe kann eine gueltige `complete`-Zeile tragen und trotzdem
    Befunde verloren haben. Dieselbe Bauform wie `fehlende_zeilen` in `ruff_riegel.py`.
    """
    text = ('{"type":"finding","severity":"minor","fileName":"a.py",'
            '"codegenInstructions":"x"}\n'
            '{"type":"complete","status":"review_completed","findings":2,'
            '"reviewedFiles":["a.py"]}\n')
    ereignisse, complete, befunde = riegel.lies(text)
    grund = riegel.unstimmig(ereignisse, complete, befunde)
    assert grund is not None and "gezaehlt sind 1" in grund


def test_markdown_zaeunt_fremden_text_ein():
    """Der Befundtext ist FREMDER Text — er wird eingezaeunt, nicht eingebettet.

    CodeRabbit sagt selbst, er sei „untrusted review data". In einem Codeblock kann er
    weder das Markdown des Kommentars kapern noch als Anweisung gelesen werden. Und der
    feste Vorspann, der sich an das Werkzeug richtet, faellt weg.
    """
    text = EVIDENZ.read_text(encoding="utf-8")
    _, _, befunde = riegel.lies(text)
    md = riegel.markdown(befunde)
    assert "```text" in md, "der fremde Text muss eingezaeunt sein"
    assert riegel.VORSPANN not in md, "der Vorspann richtet sich an das Werkzeug"
    assert "webtool/jobs.py" in md and "minor" in md


def test_markdown_ist_leer_ohne_befunde():
    assert riegel.markdown([]) == ""


def test_auszug_benennt_die_leere_ausgabe():
    assert riegel.auszug("") == ["(keine Ausgabe)"]
    assert riegel.auszug("a\nb\nc\n", zeilen=2) == ["b", "c"]


# --- main(): die Wege, die keine Ausgabe haben ----------------------------

def test_leerer_schluessel_ergibt_zwei_und_startet_die_cli_NICHT(monkeypatch, capsys):
    """Ohne Schluessel wartet die CLI auf eine Browser-Anmeldung, bis der Job stirbt.

    Gemessen: `HOME=/tmp/leer coderabbit review --agent …` ohne `--api-key` endet nach
    120 s mit rc 124 (von aussen gekillt) und den Zeilen `starting_login` /
    `awaiting_browser_auth`. Deshalb wird sie hier gar nicht erst gestartet — was der Test
    dadurch belegt, dass `--kommando` auf etwas zeigt, das es nicht gibt: wuerde sie
    gestartet, stuende „nicht gefunden" in der Meldung.
    """
    monkeypatch.setenv("CODERABBIT_API_KEY", "   ")
    rc = riegel.main(["--base-commit", "HEAD~1", "--kommando", "gibt-es-nicht-xyz"])
    assert rc == 2
    ausgabe = capsys.readouterr().out
    assert "CODERABBIT_API_KEY ist leer" in ausgabe
    assert "nicht gefunden" not in ausgabe, "die CLI darf gar nicht gestartet worden sein"


def test_fehlende_cli_ergibt_zwei(monkeypatch, capsys):
    monkeypatch.setenv("CODERABBIT_API_KEY", "cr-egal")
    rc = riegel.main(["--base-commit", "HEAD~1", "--kommando", "gibt-es-nicht-xyz"])
    assert rc == 2
    assert "nicht gefunden" in capsys.readouterr().out


def test_befunde_ergeben_eins_und_schreiben_das_markdown(monkeypatch, tmp_path, capsys):
    """Der Erfolgsweg, gefahren ueber main() mit gefaelschtem Subprozess."""
    class Ergebnis:
        returncode = 0
        stdout = EVIDENZ.read_text(encoding="utf-8")
        stderr = ""

    monkeypatch.setenv("CODERABBIT_API_KEY", "cr-egal")
    monkeypatch.setattr(riegel.subprocess, "run", lambda *a, **k: Ergebnis())
    ziel = tmp_path / "befunde.md"
    rc = riegel.main(["--base-commit", "HEAD~1", "--markdown", str(ziel)])
    assert rc == 1
    assert "```text" in ziel.read_text(encoding="utf-8")
    assert "1 Befund(e)" in capsys.readouterr().out


def test_kein_befund_ergibt_null(monkeypatch, capsys):
    class Ergebnis:
        returncode = 0
        stdout = ('{"type":"complete","status":"review_completed","findings":0,'
                  '"reviewedFiles":["a.py"]}\n')
        stderr = ""

    monkeypatch.setenv("CODERABBIT_API_KEY", "cr-egal")
    monkeypatch.setattr(riegel.subprocess, "run", lambda *a, **k: Ergebnis())
    assert riegel.main(["--base-commit", "HEAD~1"]) == 0
    assert "0 Befund(e)" in capsys.readouterr().out


def test_der_rueckgabecode_der_cli_entscheidet_NICHT(monkeypatch, capsys):
    """rc 1 bei gueltiger Ausgabe ist kein Grund zur Panik — und rc 0 kein Freibrief.

    Gemessen: derselbe Aufruf mit demselben falschen Schluessel endet mit rc 0, wenn ein
    Login gespeichert ist, und mit rc 1, wenn keiner da ist. Das Urteil haengt allein an
    der Ausgabeform.
    """
    class MitEins:
        returncode = 1
        stdout = EVIDENZ.read_text(encoding="utf-8")
        stderr = ""

    monkeypatch.setenv("CODERABBIT_API_KEY", "cr-egal")
    monkeypatch.setattr(riegel.subprocess, "run", lambda *a, **k: MitEins())
    assert riegel.main(["--base-commit", "HEAD~1"]) == 1, "rc 1 der CLI darf nicht durchschlagen"

    class MitNullUndUebersprungen:
        returncode = 0
        stdout = UEBERSPRUNGEN
        stderr = ""

    monkeypatch.setattr(riegel.subprocess, "run", lambda *a, **k: MitNullUndUebersprungen())
    assert riegel.main(["--base-commit", "HEAD~1"]) == 2, "rc 0 der CLI ist kein Urteil"


def test_der_schluessel_steht_nicht_in_der_ausgabe(monkeypatch, capsys):
    """Ein Geheimnis, das der Riegel druckt, steht danach im Job-Protokoll."""
    gesehen = {}

    class Ergebnis:
        returncode = 0
        stdout = UEBERSPRUNGEN
        stderr = ""

    def falscher_lauf(kommando, **k):
        gesehen["kommando"] = kommando
        return Ergebnis()

    monkeypatch.setenv("CODERABBIT_API_KEY", "cr-streng-geheim-123")
    monkeypatch.setattr(riegel.subprocess, "run", falscher_lauf)
    riegel.main(["--base-commit", "HEAD~1"])
    assert "cr-streng-geheim-123" in gesehen["kommando"], "er muss ankommen"
    assert "cr-streng-geheim-123" not in capsys.readouterr().out, "aber nicht gedruckt werden"


def test_json_umgebung_stoert_nicht():
    """Klartextzeilen zwischen den Ereignissen sind normal (stderr der CLI)."""
    text = "irgendein Klartext\n" + UEBERSPRUNGEN + "Error: noch mehr Klartext\n"
    ereignisse, complete, _ = riegel.lies(text)
    assert len(ereignisse) == 3 and complete is not None
