import json
import pytest
from webtool import llm, settings


@pytest.fixture
def cfg(monkeypatch, tmp_path):
    """Einstellungen ins tmp_path — nie die echte Datei des Entwicklers anfassen."""
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    return tmp_path


def _antwort(monkeypatch, payload, gesehen=None):
    def fake(url, headers, body=None, timeout=60):
        if gesehen is not None:
            gesehen.update(url=url, headers=headers, body=body)
        return payload
    monkeypatch.setattr(llm, "_request", fake)


# --- Einstellungen -----------------------------------------------------------

def test_defaults_ohne_datei(cfg):
    assert settings.load()["provider"] == "claude-cli"
    assert settings.public()["has_key"] is False
    assert llm.use_api() is False


def test_save_merge_behaelt_key(cfg):
    settings.save({"provider": "anthropic", "model": "claude-opus-5", "api_key": "sk-geheim"})
    # Modellwechsel ohne api_key im Patch darf den Key NICHT loeschen (das Frontend kennt ihn nicht)
    settings.save({"model": "claude-sonnet-5"})
    s = settings.load()
    assert s["api_key"] == "sk-geheim" and s["model"] == "claude-sonnet-5"


def test_public_verraet_den_key_nicht(cfg):
    settings.save({"provider": "openai", "api_key": "sk-geheim"})
    pub = settings.public()
    assert pub["has_key"] is True
    assert "sk-geheim" not in json.dumps(pub)


def test_kaputte_datei_faellt_auf_abo_zurueck(cfg):
    (cfg / "settings.json").write_text("{kein json", encoding="utf-8")
    assert settings.load()["provider"] == "claude-cli"   # Transkription darf daran nicht scheitern


# --- JSON aus Modellantworten ------------------------------------------------

@pytest.mark.parametrize("text", [
    '{"a": 1}',
    '```json\n{"a": 1}\n```',
    '```\n{"a": 1}\n```',
    'Hier ist das Ergebnis:\n{"a": 1}\nFertig.',
])
def test_parse_json_ueberlebt_verpackung(text):
    assert llm.parse_json(text) == {"a": 1}


def test_parse_json_ohne_json_meldet_fehler():
    with pytest.raises(llm.LLMError):
        llm.parse_json("Tut mir leid, das kann ich nicht.")


# --- HTTP-Dialekte -----------------------------------------------------------

def test_anthropic_shape(cfg, monkeypatch):
    settings.save({"provider": "anthropic", "model": "claude-opus-5", "api_key": "sk-a"})
    gesehen = {}
    _antwort(monkeypatch, {"content": [{"type": "text", "text": '{"ok": true}'}]}, gesehen)
    assert llm.complete("hallo") == '{"ok": true}'
    assert gesehen["url"] == "https://api.anthropic.com/v1/messages"
    assert gesehen["headers"]["x-api-key"] == "sk-a"
    assert gesehen["headers"]["anthropic-version"] == "2023-06-01"
    assert gesehen["body"]["model"] == "claude-opus-5"


def test_anthropic_refusal_wird_zum_fehler(cfg, monkeypatch):
    settings.save({"provider": "anthropic", "model": "claude-opus-5", "api_key": "sk-a"})
    _antwort(monkeypatch, {"stop_reason": "refusal", "content": []})
    with pytest.raises(llm.LLMError, match="abgelehnt"):
        llm.complete("hallo")


def test_openai_shape_mit_bearer(cfg, monkeypatch):
    settings.save({"provider": "openai", "model": "gpt-test", "api_key": "sk-o"})
    gesehen = {}
    _antwort(monkeypatch, {"choices": [{"message": {"content": "hi"}}]}, gesehen)
    assert llm.complete("hallo") == "hi"
    assert gesehen["url"] == "https://api.openai.com/v1/chat/completions"
    assert gesehen["headers"]["authorization"] == "Bearer sk-o"


def test_custom_base_url_gewinnt(cfg, monkeypatch):
    settings.save({"provider": "custom", "model": "llama", "base_url": "http://localhost:11434/v1/"})
    gesehen = {}
    _antwort(monkeypatch, {"choices": [{"message": {"content": "hi"}}]}, gesehen)
    llm.complete("hallo")
    assert gesehen["url"] == "http://localhost:11434/v1/chat/completions"
    assert "authorization" not in gesehen["headers"]      # lokaler Server braucht keinen Key


def test_fehlender_key_meldet_sich_statt_still_zu_scheitern(cfg):
    settings.save({"provider": "anthropic", "model": "claude-opus-5"})
    assert llm.use_api() is True          # KEIN stiller Rueckfall aufs Abo
    with pytest.raises(llm.LLMError, match="Kein API-Key"):
        llm.complete("hallo")


def test_fehlendes_modell_meldet_sich(cfg):
    settings.save({"provider": "anthropic", "api_key": "sk-a"})
    with pytest.raises(llm.LLMError, match="Kein Modell"):
        llm.complete("hallo")


def test_list_models_beide_dialekte(cfg, monkeypatch):
    settings.save({"provider": "anthropic", "model": "m", "api_key": "sk-a"})
    _antwort(monkeypatch, {"data": [{"id": "b"}, {"id": "a", "display_name": "A"}]})
    assert llm.list_models() == [{"id": "a", "label": "A"}, {"id": "b", "label": "b"}]


# --- Datei rein, Datei raus --------------------------------------------------

def test_complete_to_file_legt_eingaben_in_den_prompt(cfg, monkeypatch, tmp_path):
    settings.save({"provider": "openai", "model": "m", "api_key": "sk-o"})
    quelle = tmp_path / "roh.txt"
    quelle.write_text("[0] Hallo Welt", encoding="utf-8")
    ziel = tmp_path / "out.json"
    gesehen = {}
    _antwort(monkeypatch, {"choices": [{"message": {"content": '```json\n{"segments": [1]}\n```'}}]}, gesehen)

    llm.complete_to_file("Korrigiere das.", [str(quelle)], str(ziel))

    prompt = gesehen["body"]["messages"][0]["content"]
    assert "[0] Hallo Welt" in prompt          # Inhalt statt Read-Tool
    assert "KEINE Werkzeuge" in prompt
    assert json.loads(ziel.read_text(encoding="utf-8")) == {"segments": [1]}


def test_complete_to_file_schreibt_bei_muell_nichts(cfg, monkeypatch, tmp_path):
    """Halb geschriebene correction.json wuerde der naechste Lauf als 'fertig' durchwinken."""
    settings.save({"provider": "openai", "model": "m", "api_key": "sk-o"})
    quelle = tmp_path / "roh.txt"; quelle.write_text("x", encoding="utf-8")
    ziel = tmp_path / "out.json"
    _antwort(monkeypatch, {"choices": [{"message": {"content": "Kann ich nicht."}}]})
    with pytest.raises(llm.LLMError):
        llm.complete_to_file("p", [str(quelle)], str(ziel))
    assert not ziel.exists()


# --- HF_TOKEN an die Job-Subprozesse ------------------------------------------

def test_job_env_reicht_hf_token_durch(cfg, monkeypatch):
    """Ohne das faellt die Diarisierung in der Desktop-App still aus: die .env laedt nur webtool.ps1."""
    monkeypatch.delenv("HF_TOKEN", raising=False)
    settings.save({"hf_token": "hf_abc"})
    assert settings.job_env() == {"HF_TOKEN": "hf_abc", "WHISPER_MODEL": "large-v3",
                                   "WHISPER_LANG": "de"}


def test_echte_env_gewinnt_ueber_einstellung(cfg, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "hf_aus_env")
    settings.save({"hf_token": "hf_aus_datei"})
    assert settings.job_env() == {"WHISPER_MODEL": "large-v3",
                                   "WHISPER_LANG": "de"}  # webtool.ps1/.env behaelt das letzte Wort fuer HF_TOKEN


def test_job_env_leer_ohne_token(cfg, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    assert settings.job_env() == {"WHISPER_MODEL": "large-v3", "WHISPER_LANG": "de"}


def test_public_verraet_das_hf_token_nicht(cfg):
    settings.save({"hf_token": "hf_geheim"})
    pub = settings.public()
    assert pub["has_hf_token"] is True and "hf_geheim" not in json.dumps(pub)
