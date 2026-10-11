import json

import pytest

from webtool import correct, correction_audio, correction_context, paths


@pytest.fixture
def recording(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    tdir = tmp_path / "Demo" / "transkripte"
    tdir.mkdir(parents=True)
    raw = {"language": "de", "segments": [
        {"id": i, "start": i * 2, "end": i * 2 + 1, "text": "Rohtext"}
        for i in range(4)
    ]}
    (tdir / "S1.json").write_text(json.dumps(raw), encoding="utf-8")
    assert correct.prep_single("Demo", "S1")
    return tdir


def test_evidence_is_shared_by_correct_and_verify(recording, monkeypatch):
    prompts = []

    def answer(prompt, inputs, output):
        prompts.append(prompt)
        paths.atomic_write(output, json.dumps({"base": "S1", "segments": [
            {"id": i, "speaker": "Person", "text": "Lesart"} for i in range(4)
        ]}))

    monkeypatch.setattr(correct, "_ask_llm", answer)
    correct._correct_one("S1", str(recording / "S1.tagged.txt"),
                         str(recording / "S1.correction.json"),
                         "Glossarbegriff", "Bestaetigter Ort", True,
                         evidence="Hypothese mit Segmentbeleg 2")
    assert len(prompts) == 2
    for prompt in prompts:
        assert "Glossarbegriff" in prompt
        assert "Bestaetigter Ort" in prompt
        assert "Hypothese mit Segmentbeleg 2" in prompt
    assert "ASR-KORREKTUREN" in prompts[1]
    assert "keine fehlerfreie Referenz" in prompts[1]
    assert "falsch GESAGT" in prompts[1]


def test_prepare_evidence_once_before_all_blocks(recording, monkeypatch):
    prepared, blocks = [], []
    monkeypatch.setattr(correct, "CHUNK_SEGMENTS", 2)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: False)

    def prepare(*args, **kwargs):
        prepared.append(args)
        return "Gemeinsame Belege"

    def one(base, tagged, target, glossary, context, verify, **kwargs):
        blocks.append(kwargs["evidence"])
        a, b = kwargs["id_range"]
        paths.atomic_write(target, json.dumps({"base": base, "segments": [
            {"id": i, "speaker": "Person", "text": "Lesart"} for i in range(a, b + 1)
        ]}))

    monkeypatch.setattr(correct, "_recording_evidence", prepare, raising=False)
    monkeypatch.setattr(correct, "_correct_one", one)
    correct._correct_file("Demo", "S1", "", "Nutzerwissen", True)
    assert len(prepared) == 1
    assert blocks == ["Gemeinsame Belege", "Gemeinsame Belege"]


def test_old_correction_policy_is_not_reused(recording):
    target = recording / "S1.correction.json"
    paths.atomic_write(str(target), json.dumps({"base": "S1", "segments": [{"id": 0, "text": "Alt"}]}))
    assert not correct._correction_cache_matches(str(target), str(recording / "S1.json"), "")
    correct._stamp_correction_context(str(target), "")
    assert correct._correction_cache_matches(str(target), str(recording / "S1.json"), "")


def test_partial_cache_requires_same_recording_evidence(recording):
    target = str(recording / "S1.part1.correction.json")
    paths.atomic_write(target, json.dumps({"segments": [{"id": 0, "text": "Lesart"}]}))
    correct._stamp_correction_context(target, "Ort", evidence="Beleg A")
    raw = str(recording / "S1.json")
    assert correct._correction_cache_matches(target, raw, "Ort", evidence="Beleg A")
    assert not correct._correction_cache_matches(target, raw, "Ort", evidence="Beleg B")


def test_evidence_failure_keeps_user_context_and_glossary(recording, monkeypatch, capsys):
    def broken(*args, **kwargs):
        raise ValueError("kein brauchbarer Kontext")

    monkeypatch.setattr(correct, "_recording_evidence", broken, raising=False)
    seen = []

    def one(*args, **kwargs):
        seen.append((args[3], args[4], kwargs.get("evidence", "")))

    monkeypatch.setattr(correct, "_correct_one", one)
    correct._correct_file("Demo", "S1", "Glossar", "Nutzerwissen", True)
    assert seen == [("Glossar", "Nutzerwissen", "")]
    assert "Kontext" in capsys.readouterr().out


@pytest.mark.parametrize("analysis_fails", [False, True])
@pytest.mark.parametrize("model", ["model-A", ""])
def test_evidence_builder_uses_current_settings_and_independent_audio(recording, monkeypatch, analysis_fails, model):
    seen = []
    monkeypatch.setattr(correct.settings, "load", lambda: {
        "provider": "codex", "model": model, "whisper_model": "local-ASR"})
    monkeypatch.delenv("WHISPER_MODEL", raising=False)
    monkeypatch.setattr(correct, "_audio_path", lambda *a: "clip.mp3")

    def prepare(raw, tagged, inputs, ask):
        seen.append(inputs)
        assert inputs.model  # Native CLI defaults must still reach the analysis.
        assert raw.endswith("S1.json") and tagged.endswith("S1.tagged.txt")
        assert ask is correct._ask_llm
        if analysis_fails:
            raise ValueError("invalid hypotheses")
        return "ASR-Hypothese mit Rohbeleg"

    def retry(audio, raw, options):
        assert audio == "clip.mp3"
        assert options == correction_audio.AudioOptions("local-ASR", "de", True)
        return {"message": "Lokaler Kandidat", "candidates": [
            {"id": 2, "start": 1.0, "end": 7.0, "text": "Nachbar und Ziel"}]}

    monkeypatch.setattr(correction_context, "prepare", prepare)
    monkeypatch.setattr(correction_audio, "retry_cached", retry)
    result = correct._recording_evidence("Demo", "S1", "Glossar", "Ort", ziel="Deutsch", mehrsprachig=True)
    assert seen == [correction_context.ContextInputs(
        "Ort", "Glossar", "Deutsch", "codex", model or "Anbietervoreinstellung")]
    assert ("ASR-Hypothese mit Rohbeleg" in result) is not analysis_fails
    assert '"id": 2' in result and '"start": 1.0' in result
    assert "Nachbarrede" in result and "keine Hörprüfung" in result


@pytest.mark.parametrize("entry", ["batch", "streaming"])
def test_full_entrypoints_prepare_context(recording, monkeypatch, entry):
    from webtool import projekt
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "0")
    monkeypatch.setattr(projekt, "tiefe_effektiv", lambda *a: "voll")
    monkeypatch.setattr(correct, "_glossary", lambda *a, **k: "Glossar")
    calls = []
    monkeypatch.setattr(correct, "_recording_evidence", lambda *a, **k: calls.append(a) or "Belege")

    def answer(prompt, inputs, output):
        assert "Belege" in prompt
        paths.atomic_write(output, json.dumps({"segments": [
            {"id": i, "text": "Korrektur"} for i in range(4)]}))

    monkeypatch.setattr(correct, "_ask_llm", answer)
    if entry == "batch":
        assert correct.cmd_run("Demo", verify=True) == 1
    else:
        assert correct.correct_ai_single("Demo", "S1", gjson="Glossar", verify=True) is True
    assert len(calls) == 1
