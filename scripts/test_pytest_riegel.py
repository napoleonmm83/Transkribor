"""Der Haenger-Riegel muss SCHARF sein — sonst ist er ein Kommentar (#576).

Die drei Einstellungen in `pyproject.toml` sind das einzige, was einen haengenden
Testlauf ueberhaupt beendet. Sie stehen in einer Konfigurationsdatei, also faellt
ihr Verschwinden niemandem auf: die Suite bleibt gruen, und der naechste Haenger
laeuft wieder still bis zur Laeufergrenze.

Warum ein Test und nicht nur `--strict-config`: die beiden decken VERSCHIEDENE
Fehler. `--strict-config` faengt einen VERTIPPTEN Schluessel (gemessen: ohne die
Option rc 124 und ein Lauf, der weiterhaengt; mit ihr rc 4 vor dem ersten Test).
Ein GELOESCHTER Schluessel ist fuer sie dagegen unauffaellig — dafuer ist dieser
Test da. Und wer `--strict-config` selbst entfernt, macht ihn ebenfalls rot.

Gefragt wird die AKTIVE Konfiguration ueber die `pytestconfig`-Fixture, nicht der
Dateiinhalt: eine Datei zu lesen bewiese nur, dass dort etwas steht — nicht, dass
pytest es auch angenommen hat. Genau diese Verwechslung ist die Fehlerklasse,
gegen die der Riegel gebaut ist.
"""


def test_der_haenger_riegel_ist_scharf(pytestconfig):
    """Die zwei ini-Optionen muessen gesetzt und wirksam sein."""
    frist = pytestconfig.getini("faulthandler_timeout")
    assert frist, "faulthandler_timeout ist nicht gesetzt — ein Haenger laeuft wieder still"
    assert float(frist) > 0, f"faulthandler_timeout={frist!r} beendet nichts"

    assert pytestconfig.getini("faulthandler_exit_on_timeout") is True, (
        "Ohne exit_on_timeout erscheint zwar ein Stapelabzug, der Lauf haengt aber "
        "weiter und wird von aussen abgewuergt — gemessen: rc 124 statt rc 1."
    )


def test_die_frist_liegt_unter_der_job_grenze(pytestconfig):
    """Die zwei Riegel sind zwei Haelften EINER Zusicherung — und koennen driften.

    `faulthandler_timeout` nuetzt nur, solange es DEUTLICH unter der Job-Grenze aus
    `.github/workflows/test.yml` liegt: liegt es darueber, beendet GitHub den Job,
    bevor pytest seinen Stapelabzug schreiben kann — der Riegel waere still
    wirkungslos, und genau dieser stille Ausfall ist der Grund, warum es ihn gibt.
    Die Gefahr ist keine Erfindung: die Zahlen stehen in ZWEI Dateien, die niemand
    zusammen liest (Befund des Bot-Reviews an PR #585).

    Geprueft wird die BEZIEHUNG, nicht der Einzelwert: eine feste 300 zu verlangen
    machte jede spaetere, legitime Anpassung rot, ohne zu sagen warum.
    """
    import re
    from pathlib import Path

    workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "test.yml"
    assert workflow.is_file(), f"{workflow} nicht gefunden — dieser Test misst dann nichts"

    treffer = re.findall(r"^\s*timeout-minutes:\s*(\d+)", workflow.read_text(encoding="utf-8"),
                         re.MULTILINE)
    # Kein Treffer heisst NICHT "in Ordnung": dann ist der Deckel weg, und der Test
    # haette stillschweigend nichts geprueft — dieselbe Fehlerklasse wie oben.
    assert treffer, "keine timeout-minutes in test.yml — der Job-Deckel fehlt"

    deckel_s = min(int(t) for t in treffer) * 60
    frist_s = float(pytestconfig.getini("faulthandler_timeout"))
    assert frist_s * 2 <= deckel_s, (
        f"faulthandler_timeout={frist_s:.0f}s gegen Job-Deckel {deckel_s}s: zu knapp. "
        "Der Job stirbt dann, bevor pytest seinen Stapelabzug schreiben kann."
    )


def test_strict_config_haelt_einen_vertipper_auf(pytestconfig):
    """Der Riegel gegen das Schweigen der beiden Zeilen darueber.

    Ohne `--strict-config` meldet pytest einen unbekannten ini-Schluessel nur in
    der Zusammenfassung — die ein haengender Lauf nie erreicht.
    """
    assert "--strict-config" in pytestconfig.getini("addopts"), (
        "Ohne --strict-config schaltet ein Buchstabendreher im Schluessel den "
        "Haenger-Riegel still ab (gemessen: rc 124 statt rc 4)."
    )
