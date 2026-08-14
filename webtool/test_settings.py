"""Einstellungen — TRANSKRIBOR_SETTINGS zeigt IMMER in tmp_path, sonst entscheidet
die echte Datei des Entwicklers ueber das Testergebnis."""
import json
import os

import pytest

from webtool import settings


@pytest.fixture(autouse=True)
def eigene_datei(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    for name in ("WHISPER_MODEL", "WHISPER_LANG"):
        monkeypatch.delenv(name, raising=False)


def test_default_bleibt_large_v3():
    """Bestandsnutzer duerfen von der neuen Einstellung nichts merken."""
    assert settings.load()["whisper_model"] == "large-v3"
    assert settings.load()["whisper_lang"] == "de"


def test_speichern_und_lesen():
    settings.save({"whisper_model": "turbo"})
    assert settings.load()["whisper_model"] == "turbo"


def test_unbekanntes_modell_faellt_auf_default(tmp_path):
    """Ein handverdrehter Wert darf whisper.load_model nicht zum Absturz bringen."""
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"whisper_model": "gibt-es-nicht"}), encoding="utf-8")
    assert settings.load()["whisper_model"] == "large-v3"


def test_handverdrehtes_aber_echtes_modell_bleibt(tmp_path):
    """'base' steht nicht in der Auswahlliste, ist aber ein gueltiges Whisper-Modell."""
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"whisper_model": "base"}), encoding="utf-8")
    assert settings.load()["whisper_model"] == "base"


def test_nicht_dekodierbare_datei_faellt_auf_defaults(tmp_path):
    """#185, zweite Runde: `load()` fing nur `(OSError, json.JSONDecodeError)`. Sind die BYTES
    nicht als UTF-8 dekodierbar, wirft schon das Lesen einen `UnicodeDecodeError` — ein
    `ValueError`, aber kein `JSONDecodeError`, also durch.

    Die Zusage im Docstring („Fehlend/kaputt -> Defaults …, nie ein Fehler") war damit falsch,
    und zwar auf zwei Wegen gleichzeitig: `fetch._hole_yt_dlp()` -> `automatisch()` ->
    `auto_an()` -> hier riss den URL-Import ab, und `GET /api/settings` gab 500.

    Bytes statt `write_text`: mit einem Encoding-Argument liesse sich der Fall gar nicht
    herstellen, genau deshalb ist er vorher niemandem aufgefallen."""
    (tmp_path / "settings.json").write_bytes(b'{"whisper_model": "caf\xe9"}')
    assert settings.load() == dict(settings.DEFAULTS)
    assert settings.public(settings.load())["has_key"] is False


def test_job_env_exportiert_die_einstellung():
    settings.save({"whisper_model": "medium", "whisper_lang": "en"})
    env = settings.job_env()
    assert env["WHISPER_MODEL"] == "medium"
    assert env["WHISPER_LANG"] == "en"


def test_echte_umgebungsvariable_gewinnt(monkeypatch):
    """Wer WHISPER_MODEL gesetzt hat (webtool.ps1 aus der .env, CI), behaelt es."""
    settings.save({"whisper_model": "tiny"})
    monkeypatch.setenv("WHISPER_MODEL", "large-v3")
    assert "WHISPER_MODEL" not in settings.job_env()


def test_public_zeigt_modell_aber_kein_geheimnis():
    settings.save({"whisper_model": "turbo", "api_key": "sk-geheim"})
    pub = settings.public()
    assert pub["whisper_model"] == "turbo"
    assert pub["has_key"] is True
    assert "api_key" not in pub


def test_auswahlliste_ist_vollstaendig_gueltig():
    for c in settings.WHISPER_CHOICES:
        assert c["id"] in settings.KNOWN_WHISPER_MODELS

# ---- .env: EIN Parser statt je einem in webtool.ps1 und electron/backend.js ----
# Jede Variable, die load_env() schreiben wird, vorher ueber monkeypatch anfassen — nur
# was monkeypatch kennt, raeumt es beim Teardown wieder weg. Sonst leckte ein gesetztes
# WHISPER_MODEL in jeden folgenden Test.

def _env(monkeypatch, tmp_path, inhalt, *namen):
    p = tmp_path / ".env"
    p.write_text(inhalt, encoding="utf-8")
    monkeypatch.setenv("TRANSKRIBOR_ENV", str(p))
    for n in namen:
        monkeypatch.setenv(n, "vorher")
    return p


def test_load_env_setzt_variablen(monkeypatch, tmp_path):
    _env(monkeypatch, tmp_path,
         "# Kommentar\n\nTRANSKRIBOR_DIARIZE=0\n  WHISPER_MODEL = turbo  \n",
         "TRANSKRIBOR_DIARIZE", "WHISPER_MODEL")
    assert sorted(settings.load_env()) == ["TRANSKRIBOR_DIARIZE", "WHISPER_MODEL"]
    assert os.environ["TRANSKRIBOR_DIARIZE"] == "0"
    assert os.environ["WHISPER_MODEL"] == "turbo"          # Leerraum um Name und Wert faellt weg


def test_load_env_teilt_nur_am_ersten_gleich(monkeypatch, tmp_path):
    """Basis-URLs und Keys enthalten '=' — ein naiver split() zerschnitte sie."""
    _env(monkeypatch, tmp_path, 'TR_TEST="a=b=c"\n', "TR_TEST")
    settings.load_env()
    assert os.environ["TR_TEST"] == "a=b=c"                # Anfuehrungszeichen aussen weg


def test_load_env_ohne_datei_ist_kein_fehler(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_ENV", str(tmp_path / "gibtsnicht"))
    assert settings.load_env() == []


def test_load_env_gewinnt_gegen_gesetzte_variable(monkeypatch, tmp_path):
    """So verhielten sich beide Launcher — webtool.ps1 setzte unbedingt, backend.js legte
    die .env ueber die geerbte Umgebung. Ein Wechsel waere eine stille Verhaltensaenderung."""
    _env(monkeypatch, tmp_path, "TR_TEST=ausdatei\n", "TR_TEST")
    monkeypatch.setenv("TR_TEST", "ausshell")
    settings.load_env()
    assert os.environ["TR_TEST"] == "ausdatei"


def test_env_path_folgt_der_variablen(monkeypatch):
    """Die gepackte App legt ihre .env in userData, nicht neben den Code."""
    monkeypatch.setenv("TRANSKRIBOR_ENV", "/wo/anders/.env")
    assert settings.env_path() == "/wo/anders/.env"


def test_zwei_schreiber_verlieren_einander_nicht(monkeypatch):
    """Seit der yt-dlp-Selbstaktualisierung schreibt auch der fetch-Subprozess in diese
    Datei (den Pruef-Merker) — waehrend der Server einen API-Key aus dem Browser sichert.
    Ohne Sperre verschraenken sich load+merge+replace, der letzte gewinnt, und der Key ist
    weg (dieselbe Race wie #134 auf projekt.json).

    Das `load` wird kuenstlich verlangsamt: die echte Sequenz dauert Mikrosekunden und
    liefe auch ungesperrt fast immer durch — ein Test, der die Race nicht oeffnet, ist
    gruen aus Zufall und beweist nichts.
    """
    import threading
    import time
    orig = settings.load

    def langsam():
        d = orig()
        time.sleep(0.05)
        return d

    monkeypatch.setattr(settings, "load", langsam)
    faeden = [threading.Thread(target=settings.save, args=({"api_key": "sk-geheim"},)),
              threading.Thread(target=settings.save, args=({"ytdlp_geprueft": "2026-08-13"},))]
    for f in faeden:
        f.start()
    for f in faeden:
        f.join()
    cfg = orig()
    assert cfg["api_key"] == "sk-geheim"
    assert cfg["ytdlp_geprueft"] == "2026-08-13"


def test_pfad_ohne_verzeichnisanteil_laesst_sich_speichern(tmp_path, monkeypatch):
    """`TRANSKRIBOR_SETTINGS=settings.json` (ohne Ordner) ergibt einen leeren dirname, und
    `os.makedirs("")` wirft FileNotFoundError — womit JEDES Speichern scheiterte: der PUT
    mit 500, und der yt-dlp-Merker still (`_merken()` faengt den OSError ab, das Datum wurde
    also nie gesetzt und jeder Import lief in ein pip).

    Der cwd-Wechsel gehoert zum Fall: ein relativer Pfad ist nur zusammen mit dem
    Arbeitsverzeichnis eine Angabe, und die Datei soll in tmp_path landen, nicht im Repo.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", "settings.json")
    settings.save({"model": "claude-opus-5", "ytdlp_geprueft": "2026-08-13"})
    assert (tmp_path / "settings.json").exists()
    cfg = settings.load()
    assert cfg["model"] == "claude-opus-5"
    assert cfg["ytdlp_geprueft"] == "2026-08-13"      # der Merker haelt, nicht nur der Aufruf
