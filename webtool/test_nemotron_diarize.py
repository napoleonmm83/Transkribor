import sys
from types import ModuleType, SimpleNamespace

import pytest

from webtool import nemotron_diarize


def test_diarize_file_converts_nemo_segments(monkeypatch):
    class Model:
        def diarize(self, **kwargs):
            assert kwargs["sample_rate"] == 16000
            assert len(kwargs["audio"]) == 1
            return [["1.800 3.250 speaker_1", "0.400 2.100 speaker_0"]]

    monkeypatch.setattr(nemotron_diarize, "_model", lambda: Model())
    # Ein eingeschleustes Modul statt des echten: der Python-Job der CI installiert kein
    # faster_whisper, und ein Patch auf "faster_whisper.decode_audio" starb dort am Import
    # (CodeRabbit-CLI). Gleiches Muster wie der nemo-Stub weiter unten.
    fw = ModuleType("faster_whisper")
    fw.decode_audio = lambda *a, **kw: [0.0, 0.1]
    monkeypatch.setitem(sys.modules, "faster_whisper", fw)
    turns = nemotron_diarize.diarize_file("ignored.mp3")
    assert turns == [
        {"start": 0.4, "end": 2.1, "cluster": "speaker_0"},
        {"start": 1.8, "end": 3.25, "cluster": "speaker_1"},
    ]


def test_invalid_model_output_is_an_error():
    with pytest.raises(ValueError):
        nemotron_diarize._parse_segments(["not a segment"])


def test_availability_does_not_break_settings_when_nemo_import_is_broken(monkeypatch):
    def broken(_name):
        raise ValueError("nemo.__spec__ is None")

    monkeypatch.setattr(nemotron_diarize, "find_spec", broken)
    assert nemotron_diarize.verfuegbar() is False


def test_model_loads_offline_configuration_lazily(monkeypatch):
    called = []

    class Model:
        def __init__(self):
            self.sortformer_modules = SimpleNamespace()

        def eval(self):
            called.append("eval")

        def to(self, device):
            called.append(("device", device))

        def _check_streaming_parameters(self):
            called.append("checked")

    class SortformerEncLabelModel:
        @staticmethod
        def from_pretrained(model_id):
            called.append(model_id)
            return Model()

    for name in ("nemo", "nemo.collections", "nemo.collections.asr", "nemo.collections.asr.models"):
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    sys.modules["nemo.collections.asr.models"].SortformerEncLabelModel = SortformerEncLabelModel
    monkeypatch.setattr("webtool.device.pick", lambda: "cuda")
    monkeypatch.setattr(nemotron_diarize, "_MODEL", None)
    model = nemotron_diarize._model()
    assert model.sortformer_modules.chunk_len == 340
    assert model.sortformer_modules.spkcache_len == 264
    assert called == [nemotron_diarize.MODEL_ID, "eval", ("device", "cuda"), "checked"]
