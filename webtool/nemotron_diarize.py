"""Optionaler NeMo-Adapter fuer Nemotron 3 Diarization.

NeMo und die Gewichte werden erst beim ersten gewaehlten Lauf geladen. Der Adapter
liefert dasselbe Turn-Format wie diarize.diarize_file, damit die vorhandene
Segmentzuordnung und das Sidecar-Format weiterverwendet werden koennen.
"""

import math
from importlib.util import find_spec

MODEL_ID = "nvidia/Nemotron-3-Diarization"
_MODEL = None


def verfuegbar() -> bool:
    """Schnelle Paketpruefung fuer den Einstellungsdialog, ohne NeMo zu importieren."""
    try:
        return find_spec("nemo") is not None
    except (ImportError, ValueError):
        return False


def _model():
    global _MODEL
    if _MODEL is None:
        try:
            from nemo.collections.asr.models import SortformerEncLabelModel
        except ImportError as exc:
            raise RuntimeError("Nemotron 3 braucht die optionale Installation nemo-toolkit[asr]") from exc
        model = SortformerEncLabelModel.from_pretrained(MODEL_ID)
        model.eval()
        from . import device
        model.to(device.pick())
        modules = model.sortformer_modules
        modules.spkcache_len = 264
        modules.fifo_len = 40
        modules.chunk_len = 340
        modules.chunk_right_context = 40
        modules.spkcache_update_period = 300
        model._check_streaming_parameters()
        _MODEL = model
    return _MODEL


def _parse_segments(segments) -> list[dict]:
    turns = []
    for segment in segments:
        parts = segment.split()
        if len(parts) != 3:
            raise ValueError(f"Ungueltiges Nemotron-Segment: {segment!r}")
        start, end = float(parts[0]), float(parts[1])
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end):
            raise ValueError(f"Ungueltige Nemotron-Zeitspanne: {segment!r}")
        turns.append({"start": start, "end": end, "cluster": parts[2]})
    turns.sort(key=lambda turn: (turn["start"], turn["end"]))
    return turns


def diarize_file(audio_path: str) -> list[dict]:
    from faster_whisper import decode_audio

    samples = decode_audio(audio_path, sampling_rate=16000)
    predicted = _model().diarize(audio=[samples], batch_size=1, sample_rate=16000)
    return _parse_segments(predicted[0])
