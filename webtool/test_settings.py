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


def test_default_bleibt_large_v3(capsys):
    """Bestandsnutzer duerfen von der neuen Einstellung nichts merken.

    Die `capsys`-Zeile haelt fest, dass die FEHLENDE Datei schweigt: der Rueckfall meldet sich
    seit dem #185-Nachtrag, und ohne den `FileNotFoundError`-Vorbehalt beklagte sich jeder
    erste Start ueber eine Datei, die es planmaessig noch nicht gibt."""
    assert settings.load()["whisper_model"] == "large-v3"
    assert settings.load()["whisper_lang"] == "de"
    assert capsys.readouterr().out == ""


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


def test_nicht_dekodierbare_datei_faellt_auf_defaults(tmp_path, capsys):
    """#185, zweite Runde: `load()` fing nur `(OSError, json.JSONDecodeError)`. Sind die BYTES
    nicht als UTF-8 dekodierbar, wirft schon das Lesen einen `UnicodeDecodeError` — ein
    `ValueError`, aber kein `JSONDecodeError`, also durch.

    Die Zusage im Docstring („Fehlend/kaputt -> Defaults …, nie ein Fehler") war damit falsch,
    und zwar auf zwei Wegen gleichzeitig: `fetch._hole_yt_dlp()` -> `automatisch()` ->
    `auto_an()` -> hier riss den URL-Import ab, und `GET /api/settings` gab 500.

    Bytes statt `write_text`: mit einem Encoding-Argument liesse sich der Fall gar nicht
    herstellen, genau deshalb ist er vorher niemandem aufgefallen.

    Die Datei traegt ABSICHTLICH einen noch lesbaren API-Key. Ein
    `public(load())["has_key"] is False` an einer Datei ohne Key waere Deko gewesen — es folgt
    trivial aus `load() == DEFAULTS`. Mit Key prueft dieselbe Zeile etwas Echtes: was der
    Rueckfall den Nutzer kostet. Und weil `save()` ein Read-Modify-Write ueber `load()` ist,
    ueberbuegelt der naechste Schreiber die Datei damit — deshalb muss der Rueckfall SAGEN,
    dass er greift (die Protokollzeile unten; Bewahren der Datei ist als Issue erfasst)."""
    (tmp_path / "settings.json").write_bytes(
        b'{"api_key": "sk-NOCH-LESBAR", "provider": "openai", "x": "caf\xe9"}')
    assert settings.load() == dict(settings.DEFAULTS)
    assert settings.public(settings.load())["has_key"] is False
    assert "unlesbar" in capsys.readouterr().out


def test_save_legt_die_unlesbare_datei_beiseite_statt_sie_zu_ersetzen(tmp_path):
    """#192: `save()` ist ein Read-Modify-Write ueber `load()`, und `load()` faellt seit #185
    auch bei kaputten BYTES auf Defaults zurueck — der naechste Schreiber ersetzte die Datei
    damit samt Key. (Bis #281 war der unbeaufsichtigte Schreiber der yt-dlp-Merker aus dem
    fetch-Subprozess; seitdem ist settings.json wieder allein Sache des Servers — der Fall
    bleibt: ein Absturz mitten im Schreiben.)

    Der Key ist mit blossem Auge noch lesbar — das ist der Punkt: kaputt fuer `json.load`
    heisst nicht kaputt fuer den Menschen."""
    p = tmp_path / "settings.json"
    roh = b'{"api_key": "sk-GEHEIM-\xff\xfe", "provider": "openai"}'
    p.write_bytes(roh)
    settings.save({"model": "claude-opus-5"})
    # BYTEGLEICH, nicht nur "der Key kommt drin vor": gerettet wird die Datei, nicht ein
    # Teil davon — wer sie repariert, braucht auch den Rest (CodeRabbit-CLI an PR #203).
    assert (tmp_path / "settings.json.kaputt").read_bytes() == roh
    assert json.loads(p.read_text(encoding="utf-8"))["model"] == "claude-opus-5"


def test_public_nennt_die_beiseitegelegte_datei(tmp_path):
    """Eine stille Rettung ist so gut wie keine: das Frontend muss den Pfad nennen koennen,
    sonst holt niemand den Key zurueck. Gefragt wird die Platte, nicht ein Merker aus dem
    letzten `save()` — die Rettung ueberlebt den Serverneustart."""
    assert settings.public()["kaputt"] == ""
    (tmp_path / "settings.json.kaputt").write_text("{}", encoding="utf-8")
    assert settings.public()["kaputt"] == str(tmp_path / "settings.json.kaputt")


def test_gueltiges_aber_objektloses_json_wird_nicht_gerettet(tmp_path):
    """`[]` ist lesbar, nur keine Einstellung — darin steht nichts, was jemand zurueckholen
    wollte. Es zu retten kostete den einen Platz, auf dem sonst der API-Key liegt (die erste
    Rettung gewinnt)."""
    p = tmp_path / "settings.json"
    p.write_text("[]", encoding="utf-8")
    settings.save({"whisper_model": "turbo"})
    assert not (tmp_path / "settings.json.kaputt").exists()
    # Von der PLATTE gelesen, nicht ueber `load()`: gefragt ist, was der Schreiber
    # hinterlassen hat (CodeRabbit-CLI an PR #203).
    assert json.loads(p.read_text(encoding="utf-8"))["whisper_model"] == "turbo"


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
    gruen aus Zufall und beweist nichts. (CodeRabbit-CLI an #281: der Patch stand auf
    `load`, aber `save()` liest seit #203 ueber `_lesen()` — die Verzoegerung lief ins
    Leere und der Test war milder als beabsichtigt. Jetzt haengt sie am echten Pfad.)
    """
    import threading
    import time
    orig = settings._lesen

    def langsam():
        d = orig()
        time.sleep(0.05)
        return d

    monkeypatch.setattr(settings, "_lesen", langsam)
    faeden = [threading.Thread(target=settings.save, args=({"api_key": "sk-geheim"},)),
              threading.Thread(target=settings.save, args=({"whisper_model": "small"},))]
    for f in faeden:
        f.start()
    for f in faeden:
        f.join()
    cfg, _ = orig()
    assert cfg["api_key"] == "sk-geheim"
    assert cfg["whisper_model"] == "small"


def test_pfad_ohne_verzeichnisanteil_laesst_sich_speichern(tmp_path, monkeypatch):
    """`TRANSKRIBOR_SETTINGS=settings.json` (ohne Ordner) ergibt einen leeren dirname, und
    `os.makedirs("")` wirft FileNotFoundError — womit JEDES Speichern scheiterte: der PUT
    mit 500. (Bis #281 fiel daneben still der yt-dlp-Merker aus — `_merken()` fing den
    OSError ab, das Datum wurde nie gesetzt und jeder Import lief in ein pip.)

    Der cwd-Wechsel gehoert zum Fall: ein relativer Pfad ist nur zusammen mit dem
    Arbeitsverzeichnis eine Angabe, und die Datei soll in tmp_path landen, nicht im Repo.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", "settings.json")
    settings.save({"model": "claude-opus-5", "ytdlp_auto": "0"})
    assert (tmp_path / "settings.json").exists()
    cfg = settings.load()
    assert cfg["model"] == "claude-opus-5"
    assert cfg["ytdlp_auto"] == "0"                    # der zweite Key haelt, nicht nur der Aufruf


def test_nicht_dekodierbare_env_stoppt_den_serverstart_nicht(tmp_path, monkeypatch):
    """`load_env` faengt nur OSError — eine im Editor als ANSI gespeicherte `.env` mit Umlaut
    ist nicht als UTF-8 lesbar und warf `UnicodeDecodeError`. `app.py` ruft das beim IMPORT:
    ungefangen startet der Server gar nicht erst, ohne Fehlerseite, und die Electron-App
    zeigt nichts. Dieselbe Klasse wie #190/#185 — `settings.load()` zwanzig Zeilen weiter hat
    die Erweiterung dort schon bekommen, hier fehlte sie."""
    env = tmp_path / ".env"
    env.write_bytes(b"WHISPER_MODEL=gr\xdfoss\n")        # CP1252, kein UTF-8
    monkeypatch.setenv("TRANSKRIBOR_ENV", str(env))
    monkeypatch.delenv("WHISPER_MODEL", raising=False)
    assert settings.load_env() == []                     # kein Wurf, nichts gesetzt
