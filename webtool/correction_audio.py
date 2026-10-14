"""Bounded local second-ASR evidence; candidates never replace transcript text."""
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from threading import Semaphore

from webtool.edit_model import LOGPROB_THRESHOLD, UNCERTAIN_TAG_THRESHOLD
from webtool.paths import atomic_write

_SAMPLE_RATE = 16000
_LIMIT = 12
_MARGIN = 12.0
_MAX_CLIP = 45.0
_SPACING = 20.0
_REVISION = 2
_LOCK = Semaphore(1)


@dataclass(frozen=True)
class AudioOptions:
    model: str
    language: str | None
    multilingual: bool = False


def _result(status, message, candidates=None) -> dict:
    return {"status": status, "message": message, "candidates": candidates or []}


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _segments(raw_bytes):
    segments = json.loads(raw_bytes).get("segments")
    if not isinstance(segments, list):
        raise ValueError("segments")
    seen = set()
    for segment in segments:
        if not isinstance(segment, dict):
            raise ValueError("segment")
        sid, start, end = (segment.get(k) for k in ("id", "start", "end"))
        if (type(sid) is not int or sid < 0 or sid in seen or not _number(start)
                or not _number(end) or not 0 <= start < end):
            raise ValueError("identity/time")
        seen.add(sid)
    return segments


def _select(segments):
    ranked = []
    for segment in segments:
        words = segment.get("words", [])
        probabilities = [w.get("probability", 1) for w in words if isinstance(w, dict)]
        probability = min((p for p in probabilities if _number(p) and 0 <= p <= 1), default=1)
        logprob = segment.get("avg_logprob", 0)
        if not _number(logprob):
            logprob = 0
        if probability < UNCERTAIN_TAG_THRESHOLD or logprob < LOGPROB_THRESHOLD:
            ranked.append((probability, logprob, segment["id"], segment))
    selected = []
    for *_, segment in sorted(ranked, key=lambda item: item[:3]):
        if all(abs(segment["start"] - prior["start"]) >= _SPACING for prior in selected):
            selected.append(segment)
            if len(selected) == _LIMIT:
                break
    return selected


def _identity(audio_path, raw_path, options):
    stat = audio_path.stat()
    return {"revision": _REVISION, "raw_sha256": hashlib.sha256(raw_path.read_bytes()).hexdigest(),
            "audio": str(audio_path.resolve()), "stat": [stat.st_ino, stat.st_size, stat.st_mtime_ns],
            "model": options.model, "language": options.language, "multilingual": options.multilingual}


def _clips(selected, duration):
    clips = []
    for segment in selected:
        start, end = max(0, segment["start"] - _MARGIN), min(duration, segment["end"] + _MARGIN)
        if end - start > _MAX_CLIP:
            start = max(0, (segment["start"] + segment["end"] - _MAX_CLIP) / 2)
            end = min(duration, start + _MAX_CLIP)
        # Store the actual sample boundaries, rather than rounded nominal times.
        clips.append({"id": segment["id"], "start": int(start * _SAMPLE_RATE) / _SAMPLE_RATE,
                      "end": int(end * _SAMPLE_RATE) / _SAMPLE_RATE})
    return clips


def _valid_candidates(candidates, clips):
    expected = {clip["id"]: clip for clip in clips}
    seen = set()
    if not isinstance(candidates, list) or not candidates or len(candidates) != len(clips):
        return False
    for candidate in candidates:
        if not isinstance(candidate, dict):
            return False
        sid = candidate.get("id")
        if type(sid) is not int or sid not in expected or sid in seen:
            return False
        if any(not _number(candidate.get(k)) or candidate[k] != expected[sid][k] for k in ("start", "end")):
            return False
        if not isinstance(candidate.get("text"), str) or not candidate["text"].strip():
            return False
        seen.add(sid)
    return True


def retry_cached(audio_path: str, raw_path: str, options: AudioOptions, *, progress=None) -> dict:
    """Return independent clip readings, using only a locally cached CPU model."""
    if progress:
        progress("audio-wait")
    with _LOCK:
        return _retry(Path(audio_path), Path(raw_path), options, progress)


def _retry(audio_path, raw_path, options, progress=None) -> dict:
    try:
        if not options.model.strip():
            return _result("skipped", "Zweiterkennung ausgelassen: kein Modell gewaehlt.")
        if not audio_path.is_file():
            return _result("skipped", "Zweiterkennung ausgelassen: Audio fehlt.")
        raw_bytes = raw_path.read_bytes()
        segments = _segments(raw_bytes)
        selected = _select(segments)
        if not selected:
            return _result("skipped", "Keine schwachen ASR-Stellen fuer eine Zweiterkennung gefunden.")
        identity = _identity(audio_path, raw_path, options)
        if identity["raw_sha256"] != hashlib.sha256(raw_bytes).hexdigest():
            return _result("failed", "Zweiterkennung verworfen: Quelldateien wurden geaendert.")
        cache_path = raw_path.with_suffix(".audio-evidence")
        try:
            cached = json.loads(cache_path.read_bytes())
            duration = cached.get("duration")
            # Source-bound decoder metadata; validate clip bounds without decoding again.
            if (cached.get("identity") == identity and _number(duration) and duration > 0
                    and all(segment["end"] <= duration for segment in segments)
                    and _valid_candidates(cached.get("candidates"), _clips(selected, duration))):
                if _identity(audio_path, raw_path, options) != identity:
                    return _result("failed", "Zweiterkennung verworfen: Quelldateien wurden geaendert.")
                return _result("cached", "Lokale Zweiterkennung aus passendem Cache geladen.", cached["candidates"])
        except (OSError, ValueError, AttributeError, OverflowError):
            pass
        from faster_whisper import WhisperModel

        from transcribe import _opts
        if progress:
            progress("audio-model")
        try:
            model = WhisperModel(options.model, device="cpu", compute_type="int8", local_files_only=True)
        except Exception:
            return _result("skipped", "Zweiterkennung ausgelassen: lokales Modell nicht verfuegbar; kein Download.")
        try:
            from faster_whisper.audio import decode_audio
            try:
                # A miss decodes the full source once; ASR itself only sees bounded clips.
                if progress:
                    progress("audio-decode")
                samples = decode_audio(str(audio_path), sampling_rate=_SAMPLE_RATE)
            except Exception:
                return _result("failed", "Zweiterkennung ausgelassen: lokaler Audiodecoder konnte die Quelle nicht lesen.")
            duration = len(samples) / _SAMPLE_RATE
            if duration <= 0 or any(segment["end"] > duration for segment in segments):
                return _result("failed", "Zweiterkennung ausgelassen: Segmentzeiten passen nicht zum Audio.")
            if _identity(audio_path, raw_path, options) != identity:
                return _result("failed", "Zweiterkennung verworfen: Quelldateien wurden geaendert.")
            clips = _clips(selected, duration)
            decoder_options = _opts(options.language, options.multilingual)
            decoder_options.update(beam_size=10, log_progress=False)
            candidates = []
            failures = 0
            if progress:
                progress("audio-recognize", 0, len(clips))
            for completed, clip in enumerate(clips, 1):
                stream = None
                try:
                    chunk = samples[round(clip["start"] * _SAMPLE_RATE):round(clip["end"] * _SAMPLE_RATE)]
                    stream, _ = model.transcribe(chunk, **decoder_options)
                    text = " ".join(segment.text.strip() for segment in stream).strip()
                    if text:
                        candidates.append({**clip, "text": text})
                except Exception:
                    failures += 1
                finally:
                    if stream is not None and hasattr(stream, "close"):
                        try:
                            stream.close()
                        except Exception:
                            failures += 1
                    stream = None
                    if progress:
                        progress("audio-recognize", completed, len(clips))
        finally:
            del model
        if _identity(audio_path, raw_path, options) != identity:
            return _result("failed", "Zweiterkennung verworfen: Quelldateien wurden geaendert.")
        if failures or not _valid_candidates(candidates, clips):
            return _result("partial" if candidates else "failed",
                           "Zweiterkennung unvollstaendig; fehlende Stellen bleiben ohne Audiokandidat.", candidates)
        saved = True
        try:
            atomic_write(str(cache_path), json.dumps({"identity": identity, "duration": duration,
                         "candidates": candidates}, ensure_ascii=False))
        except OSError:
            saved = False
        if _identity(audio_path, raw_path, options) != identity:
            return _result("failed", "Zweiterkennung verworfen: Quelldateien wurden geaendert.")
        if not saved:
            return _result("partial", "Audiokandidaten erstellt; Cache konnte nicht gespeichert werden.", candidates)
        return _result("ready", "Lokale Audiokandidaten erstellt; sie ersetzen keinen Text automatisch.", candidates)
    except (OSError, ValueError, TypeError, AttributeError, ImportError):
        return _result("failed", "Zweiterkennung ausgelassen: Quelle oder lokaler Audiodecoder nicht verfuegbar.")
