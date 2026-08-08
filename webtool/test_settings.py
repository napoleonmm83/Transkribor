"""Einstellungen — TRANSKRIBOR_SETTINGS zeigt IMMER in tmp_path, sonst entscheidet
die echte Datei des Entwicklers ueber das Testergebnis."""
import json

import pytest

from webtool import settings


@pytest.fixture(autouse=True)
def eigene_datei(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    for name in ("WHISPER_MODEL", "WHISPER_LANG", "HF_TOKEN"):
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
