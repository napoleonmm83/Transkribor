"""Small waveform envelopes; audio frames are never retained after aggregation."""
import math
import os
import threading
from collections import OrderedDict

import av
import numpy as np

PEAK_COUNT = 2000
_CACHE_SIZE = 8
_cache: OrderedDict[tuple, dict[str, object]] = OrderedDict()
_lock = threading.Lock()
_decode_lock = threading.Lock()


def _identity(path):
    stat = os.stat(path)
    return (os.path.realpath(path), stat.st_dev, stat.st_ino,
            stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def _decode(path, measured_duration=None):
    with av.open(path) as audio:
        if not audio.streams.audio:
            raise ValueError('kein Audiokanal')
        stream = audio.streams.audio[0]
        duration = measured_duration if measured_duration is not None else (float(stream.duration * stream.time_base)
                    if stream.duration is not None and stream.time_base is not None
                    else float(audio.duration / av.time_base) if audio.duration else 0)
        if not math.isfinite(duration) or duration <= 0:
            duration = 0
        peaks = np.zeros(PEAK_COUNT, dtype=np.float32)
        # Reformat only one frame at a time. Keep all channels' extrema, including
        # packed integer input, without retaining the full recording's PCM.
        elapsed = 0.0
        frame_tolerance = 0.0
        converter = av.AudioResampler(format='fltp')
        for frame in audio.decode(stream):
            samples = converter.resample(frame)[0].to_ndarray()
            values = np.max(np.abs(samples), axis=0)
            start = elapsed
            elapsed += frame.samples / frame.sample_rate
            frame_tolerance = max(frame_tolerance, frame.samples / frame.sample_rate)
            if not duration:
                continue
            first = min(PEAK_COUNT - 1, int(start / duration * PEAK_COUNT))
            last = min(PEAK_COUNT - 1, int(elapsed / duration * PEAK_COUNT))
            for index in range(first, last + 1):
                left = max(0, math.ceil((index * duration / PEAK_COUNT - start) * frame.sample_rate))
                right = min(frame.samples, math.ceil(((index + 1) * duration / PEAK_COUNT - start) * frame.sample_rate))
                if right > left:
                    peaks[index] = max(peaks[index], float(values[left:right].max()))
        if elapsed <= 0:
            raise ValueError('keine Audiodaten')
        # ADTS/AAC duration can be a bitrate estimate rather than the audio's
        # extent. Re-bin against measured samples in a second bounded pass only
        # when the estimate differs by more than one decoder frame.
        if measured_duration is None and (not duration or abs(duration - elapsed) > frame_tolerance):
            return _decode(path, elapsed)
        return {'duration': duration, 'peaks': [np.clip(peaks, 0, 1).tolist()]}


def _cached(identity):
    with _lock:
        if identity in _cache:
            _cache.move_to_end(identity)
            return _cache[identity]
    return None


def get_waveform(path):
    # Warm envelopes never wait behind an unrelated cold decode. One cold
    # decoder at a time still bounds memory and deduplicates identical requests.
    identity = _identity(path)
    cached = _cached(identity)
    if cached is not None:
        return cached
    with _decode_lock:
        identity = _identity(path)
        cached = _cached(identity)
        if cached is not None:
            return cached
        result = _decode(path)
        if _identity(path) != identity:
            raise ValueError('Audio während der Berechnung geändert')
        with _lock:
            _cache[identity] = result
            while len(_cache) > _CACHE_SIZE:
                _cache.popitem(last=False)
        return result
