import gc
import json
import sys
import types
import weakref

import pytest

from webtool import correction_audio as audio


@pytest.fixture
def recording(tmp_path, monkeypatch):
    raw = tmp_path / "Interview.json"
    source = tmp_path / "Interview.mp3"
    source.write_bytes(b"local audio")
    segments = [{"id": i, "start": i * 30.0 + 10, "end": i * 30.0 + 12,
                 "text": "Rohtext", "avg_logprob": -1.2,
                 "words": [{"probability": 0.2}]} for i in range(16)]
    raw.write_text(json.dumps({"segments": segments}), encoding="utf-8")
    state = types.SimpleNamespace(loads=[], calls=[], decodes=0, fail=set(), refs=[])

    def decode(path, sampling_rate):
        assert path == str(source)
        assert sampling_rate == 16000
        state.decodes += 1
        return range(500 * sampling_rate)

    class Model:
        def __init__(self, name, **kwargs):
            state.loads.append((name, kwargs))
            state.refs.append(weakref.ref(self))

        def transcribe(self, samples, **kwargs):
            state.calls.append((samples.start / 16000, len(samples) / 16000, kwargs))
            index = len(state.calls) - 1
            if index in state.fail:
                raise RuntimeError("decoder problem")
            return iter([types.SimpleNamespace(text=" Neue Lesart ")]), None

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=Model))
    monkeypatch.setitem(sys.modules, "faster_whisper.audio", types.SimpleNamespace(decode_audio=decode))
    return raw, source, segments, state


def run(recording, **kwargs):
    raw, source, _, _ = recording
    return audio.retry_cached(str(source), str(raw), audio.AudioOptions("large-v3", "de", **kwargs))


def rewrite(raw, segments):
    raw.write_text(json.dumps({"segments": segments}), encoding="utf-8")


def test_bounded_local_retry_preserves_raw_and_returns_candidates(recording):
    raw, _, _, state = recording
    before = raw.read_bytes()
    result = run(recording)
    assert result["status"] == "ready"
    assert [c["id"] for c in result["candidates"]] == list(range(12))
    assert state.loads == [("large-v3", {"device": "cpu", "compute_type": "int8", "local_files_only": True})]
    for start, duration, opts in state.calls:
        assert 0 <= start and duration <= 45
        assert opts["beam_size"] == 10 and opts["language"] == "de"
        assert opts["vad_filter"] is False and opts["log_progress"] is False
        assert "initial_prompt" not in opts
    assert result["candidates"][0] == {"id": 0, "start": 0.0, "end": 24.0, "text": "Neue Lesart"}
    assert raw.read_bytes() == before
    gc.collect()
    assert all(ref() is None for ref in state.refs)


def test_multilingual_decoder_keeps_language_contract(recording):
    run(recording, multilingual=True)
    opts = recording[3].calls[0][2]
    assert opts["multilingual"] is True
    assert opts["condition_on_previous_text"] is False


def test_clean_recording_never_imports_or_decodes(recording, monkeypatch):
    raw, _, segments, state = recording
    for segment in segments:
        segment["avg_logprob"] = -0.1
        segment["words"][0]["probability"] = 0.9
    rewrite(raw, segments)
    monkeypatch.delitem(sys.modules, "faster_whisper")
    result = run(recording)
    assert result["status"] == "skipped" and result["message"]
    assert result["candidates"] == [] and state.decodes == 0


def test_minimum_spacing_and_weakest_first(recording):
    raw, _, segments, state = recording
    segments = segments[:4]
    for index, segment in enumerate(segments):
        segment["start"] = 10 + index * 8
        segment["end"] = segment["start"] + 1
        segment["words"][0]["probability"] = 0.4 - index * 0.1
    rewrite(raw, segments)
    result = run(recording)
    assert [c["id"] for c in result["candidates"]] == [3, 0]
    assert len(state.calls) == 2


def test_long_segment_and_audio_end_use_actual_bounded_clips(recording):
    raw, _, segments, state = recording
    segments = segments[:2]
    segments[0].update(start=0, end=100)
    segments[1].update(start=495, end=500)
    rewrite(raw, segments)
    result = run(recording)
    assert [(c["start"], c["end"]) for c in result["candidates"]] == [(27.5, 72.5), (483.0, 500.0)]
    assert all(call[1] <= 45 for call in state.calls)


@pytest.mark.parametrize("change", [
    {"id": True}, {"id": -1}, {"start": float("nan")}, {"end": float("inf")},
    {"start": -1}, {"end": 9}, {"end": 501},
])
def test_invalid_raw_is_rejected_before_model(recording, change):
    raw, _, segments, state = recording
    segments[0].update(change)
    rewrite(raw, segments)
    result = run(recording)
    assert result["status"] in {"skipped", "failed"}
    assert result["message"] and result["candidates"] == []
    assert not state.loads


def test_duplicate_raw_id_rejected(recording):
    raw, _, segments, state = recording
    segments[1]["id"] = segments[0]["id"]
    rewrite(raw, segments)
    assert run(recording)["candidates"] == []
    assert not state.loads


def test_missing_audio_visible_and_nonfatal(recording):
    recording[1].unlink()
    result = run(recording)
    assert result["status"] == "skipped" and result["message"]
    assert not recording[3].loads


def test_uncached_model_failure_is_not_cached_and_can_retry(recording, monkeypatch):
    _, _, _, state = recording
    original = sys.modules["faster_whisper"].WhisperModel
    def unavailable(*args, **kwargs):
        assert kwargs["local_files_only"] is True
        raise FileNotFoundError("not cached")
    monkeypatch.setattr(sys.modules["faster_whisper"], "WhisperModel", unavailable)
    result = run(recording)
    assert result["status"] == "skipped" and result["message"]
    assert not recording[0].with_suffix(".audio-evidence").exists()
    monkeypatch.setattr(sys.modules["faster_whisper"], "WhisperModel", original)
    assert run(recording)["status"] == "ready"
    assert len(state.calls) == 12


def test_cache_reuses_model_work_and_is_bound_to_raw_audio_options(recording):
    raw, source, segments, state = recording
    run(recording)
    assert run(recording)["status"] == "cached" and len(state.loads) == 1
    segments[0]["text"] = "geaendert"
    rewrite(raw, segments)
    run(recording)
    assert len(state.loads) == 2
    source.write_bytes(b"changed audio")
    run(recording)
    assert len(state.loads) == 3
    audio.retry_cached(str(source), str(raw), audio.AudioOptions("small", None))
    assert state.loads[-1][0] == "small" and len(state.loads) == 4


@pytest.mark.parametrize("tamper", ["id", "time", "duplicate", "empty"])
def test_tampered_cache_is_discarded(recording, tamper):
    run(recording)
    cache = recording[0].with_suffix(".audio-evidence")
    payload = json.loads(cache.read_text(encoding="utf-8"))
    candidate = payload["candidates"][0]
    if tamper == "id":
        candidate["id"] = True
    elif tamper == "time":
        candidate["end"] = 900
    elif tamper == "duplicate":
        payload["candidates"].append(candidate.copy())
    else:
        candidate["text"] = "  "
    cache.write_text(json.dumps(payload), encoding="utf-8")
    assert run(recording)["status"] == "ready"
    assert len(recording[3].loads) == 2


def test_partial_clip_failure_keeps_other_candidates_and_does_not_cache(recording):
    state = recording[3]
    state.fail.add(2)
    result = run(recording)
    assert result["status"] == "partial" and result["message"]
    assert len(result["candidates"]) == 11
    assert 2 not in [c["id"] for c in result["candidates"]]
    assert not recording[0].with_suffix(".audio-evidence").exists()
    gc.collect()
    assert all(ref() is None for ref in state.refs)
    state.fail.clear()
    assert run(recording)["status"] == "ready"


def test_source_change_during_decode_discards_evidence(recording, monkeypatch):
    decoder = sys.modules["faster_whisper.audio"].decode_audio
    def changed(*args, **kwargs):
        samples = decoder(*args, **kwargs)
        recording[1].write_bytes(b"changed while reading")
        return samples
    monkeypatch.setattr(sys.modules["faster_whisper.audio"], "decode_audio", changed)
    result = run(recording)
    assert result["status"] == "failed" and result["candidates"] == []
    assert not recording[0].with_suffix(".audio-evidence").exists()


def test_decoder_failure_is_visible_and_can_retry(recording, monkeypatch):
    module = sys.modules["faster_whisper.audio"]
    decoder = module.decode_audio
    def broken(*args, **kwargs):
        raise RuntimeError("private source name")
    monkeypatch.setattr(module, "decode_audio", broken)
    result = run(recording)
    assert result["status"] == "failed" and result["message"]
    assert "private source name" not in result["message"]
    assert not recording[0].with_suffix(".audio-evidence").exists()
    monkeypatch.setattr(module, "decode_audio", decoder)
    assert run(recording)["status"] == "ready"


def test_lazy_stream_failure_closes_and_releases_model(recording, monkeypatch):
    state = recording[3]
    original = sys.modules["faster_whisper"].WhisperModel
    closed = []
    class Streaming(original):
        def transcribe(self, samples, **kwargs):
            def stream():
                try:
                    yield types.SimpleNamespace(text=str(self.__class__.__name__))
                    raise RuntimeError("lazy decoding failed")
                finally:
                    closed.append(True)
            return stream(), None
    monkeypatch.setattr(sys.modules["faster_whisper"], "WhisperModel", Streaming)
    result = run(recording)
    assert result["status"] == "failed" and result["candidates"] == []
    assert len(closed) == 12
    gc.collect()
    assert all(ref() is None for ref in state.refs)


def test_cache_write_failure_keeps_evidence_and_reports_it(recording, monkeypatch):
    def denied(*args, **kwargs):
        raise PermissionError("write denied")
    monkeypatch.setattr(audio, "atomic_write", denied)
    result = run(recording)
    assert result["status"] == "partial" and len(result["candidates"]) == 12
    assert result["message"]


def test_logprob_alone_can_select_a_segment(recording):
    raw, _, segments, _ = recording
    for segment in segments:
        segment["words"] = []
        segment["avg_logprob"] = 0
    segments[5]["avg_logprob"] = -1.01
    rewrite(raw, segments)
    assert [c["id"] for c in run(recording)["candidates"]] == [5]


def test_language_and_multilingual_each_invalidate_cache(recording):
    raw, source, _, state = recording
    run(recording)
    audio.retry_cached(str(source), str(raw), audio.AudioOptions("large-v3", "fr"))
    assert len(state.loads) == 2
    audio.retry_cached(str(source), str(raw), audio.AudioOptions("large-v3", "fr", True))
    assert len(state.loads) == 3
    cache = raw.with_suffix(".audio-evidence")
    payload = json.loads(cache.read_text(encoding="utf-8"))
    payload["identity"]["revision"] = -1
    cache.write_text(json.dumps(payload), encoding="utf-8")
    audio.retry_cached(str(source), str(raw), audio.AudioOptions("large-v3", "fr", True))
    assert len(state.loads) == 4


def test_raw_change_during_transcription_discards_all_candidates(recording, monkeypatch):
    raw, _, segments, _ = recording
    original = sys.modules["faster_whisper"].WhisperModel
    class Changed(original):
        def transcribe(self, *args, **kwargs):
            result = super().transcribe(*args, **kwargs)
            segments[0]["text"] = "source replaced during retry"
            rewrite(raw, segments)
            return result
    monkeypatch.setattr(sys.modules["faster_whisper"], "WhisperModel", Changed)
    result = run(recording)
    assert result["status"] == "failed" and result["candidates"] == []
    assert not raw.with_suffix(".audio-evidence").exists()


def test_cpu_models_are_serialized(recording, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    original = sys.modules["faster_whisper"].WhisperModel
    entered, release, second_entered = Event(), Event(), Event()
    class Blocking(original):
        def __init__(self, name, **kwargs):
            self.name = name
            super().__init__(name, **kwargs)
            if name == "second":
                second_entered.set()

        def transcribe(self, *args, **kwargs):
            if self.name == "first":
                entered.set()
                assert release.wait(3)
            return super().transcribe(*args, **kwargs)

    monkeypatch.setattr(sys.modules["faster_whisper"], "WhisperModel", Blocking)
    raw, source, _, _ = recording
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(audio.retry_cached, str(source), str(raw), audio.AudioOptions("first", "de"))
        assert entered.wait(2)
        second = pool.submit(audio.retry_cached, str(source), str(raw), audio.AudioOptions("second", "de"))
        try:
            assert not second_entered.wait(0.1)
        finally:
            release.set()
        assert first.result()["status"] == "ready"
        assert second.result()["status"] == "ready"
    assert second_entered.is_set()
