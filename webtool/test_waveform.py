import math
import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import av
import numpy as np
import pytest
from fastapi.testclient import TestClient

from webtool import waveform


def write_audio(path, seconds=2, amplitude=12000):
    samples = np.full(seconds * 8000, amplitude, dtype='<i2')
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(samples.tobytes())


def test_streamed_peaks_have_bounded_size_and_real_audio_duration(tmp_path):
    path = tmp_path / 'recording.wav'
    write_audio(path, seconds=7)
    result = waveform.get_waveform(str(path))
    assert result['duration'] == pytest.approx(7)
    assert len(result['peaks']) == 1
    assert len(result['peaks'][0]) == waveform.PEAK_COUNT
    assert all(math.isfinite(p) and 0 <= p <= 1 for p in result['peaks'][0])
    assert max(result['peaks'][0]) == pytest.approx(12000 / 32768)


def test_cache_deduplicates_and_invalidates_replaced_audio(tmp_path, monkeypatch):
    path = tmp_path / 'recording.wav'
    write_audio(path)
    decode = waveform._decode
    calls = []
    def counted(audio):
        calls.append(audio)
        return decode(audio)
    monkeypatch.setattr(waveform, '_decode', counted)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: waveform.get_waveform(str(path)), range(4)))
    assert len(calls) == 1
    assert all(r == results[0] for r in results)
    replacement = tmp_path / 'replacement.wav'
    write_audio(replacement, seconds=3, amplitude=24000)
    replacement.replace(path)
    replaced = waveform.get_waveform(str(path))
    assert len(calls) == 2
    assert replaced['duration'] == pytest.approx(3)
    assert max(replaced['peaks'][0]) > max(results[0]['peaks'][0])


def test_warm_cache_is_available_while_another_audio_decodes(tmp_path, monkeypatch):
    warm = tmp_path / 'warm.wav'
    cold = tmp_path / 'cold.wav'
    write_audio(warm)
    write_audio(cold)
    expected = waveform.get_waveform(str(warm))
    entered = threading.Event()
    release = threading.Event()
    warm_done = threading.Event()
    decode = waveform._decode
    def blocked(path):
        entered.set()
        assert release.wait(5)
        return decode(path)
    monkeypatch.setattr(waveform, '_decode', blocked)
    with ThreadPoolExecutor(max_workers=2) as pool:
        cold_result = pool.submit(waveform.get_waveform, str(cold))
        assert entered.wait(5)
        def fetch_warm():
            result = waveform.get_waveform(str(warm))
            warm_done.set()
            return result
        warm_result = pool.submit(fetch_warm)
        try:
            assert warm_done.wait(1), 'warm hit waited for unrelated cold decoding'
            assert warm_result.result() == expected
        finally:
            release.set()
        assert cold_result.result()['duration'] == pytest.approx(2)


@pytest.mark.parametrize('noise_at_end', [False, True])
def test_variable_bitrate_aac_uses_decoded_extent_and_keeps_late_pulse(tmp_path, noise_at_end):
    path = tmp_path / 'variable.aac'
    rng = np.random.default_rng(123)
    with av.open(str(path), 'w', format='adts') as output:
        stream = output.add_stream('aac', rate=48000)
        stream.layout = 'mono'
        for second in range(20):
            samples = np.zeros((1, 48000), dtype=np.float32)
            if (noise_at_end and second >= 18) or (not noise_at_end and second < 2):
                samples[:] = rng.uniform(-0.05, 0.05, samples.shape)
            if second == 15:
                samples[0, 24000:24050] = 0.9
            frame = av.AudioFrame.from_ndarray(samples, format='flt', layout='mono')
            frame.sample_rate = 48000
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)
    with av.open(str(path)) as source:
        metadata_duration = float(source.streams.audio[0].duration * source.streams.audio[0].time_base)
        decoded = np.concatenate([frame.to_ndarray().flatten() for frame in source.decode(audio=0)])
        actual_duration = len(decoded) / 48000
    assert abs(metadata_duration - actual_duration) > 1
    result = waveform.get_waveform(str(path))
    assert result['duration'] == pytest.approx(actual_duration)
    assert max(result['peaks'][0]) == pytest.approx(float(np.abs(decoded).max()), abs=0.01)
    loudest = int(np.argmax(np.abs(decoded))) / 48000
    bin_time = int(np.argmax(result['peaks'][0])) / waveform.PEAK_COUNT * result['duration']
    assert bin_time == pytest.approx(loudest, abs=actual_duration / waveform.PEAK_COUNT)


def test_missing_duration_metadata_uses_two_bounded_decodes(tmp_path, monkeypatch):
    path = tmp_path / 'unknown.wav'
    write_audio(path, seconds=3)
    open_audio = av.open
    calls = []
    class NoDuration:
        def __enter__(self):
            self.audio = open_audio(str(path))
            self.duration = None
            self.streams = SimpleNamespace(audio=[SimpleNamespace(duration=None, time_base=None)])
            calls.append(path)
            return self
        def __exit__(self, *args):
            self.audio.close()
        def decode(self, _stream):
            return self.audio.decode(audio=0)
    monkeypatch.setattr(waveform.av, 'open', lambda _: NoDuration())
    result = waveform.get_waveform(str(path))
    assert len(calls) == 2
    assert result['duration'] == pytest.approx(3)
    assert max(result['peaks'][0]) == pytest.approx(12000 / 32768)


def test_audio_replacement_during_decode_is_not_cached(tmp_path, monkeypatch):
    path = tmp_path / 'recording.wav'
    write_audio(path)
    decode = waveform._decode
    def replace_during_decode(audio):
        result = decode(audio)
        write_audio(path, seconds=3)
        return result
    monkeypatch.setattr(waveform, '_decode', replace_during_decode)
    with pytest.raises(ValueError, match='geändert'):
        waveform.get_waveform(str(path))


def test_stereo_negative_transients_and_silence_keep_their_position(tmp_path):
    path = tmp_path / 'stereo.wav'
    samples = np.zeros((16000, 2), dtype='<i2')
    samples[8000, 1] = -16384
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(samples.tobytes())
    peaks = waveform.get_waveform(str(path))['peaks'][0]
    assert peaks[1000] == pytest.approx(0.5)
    assert sum(p != 0 for p in peaks) == 1


def test_cache_has_a_fixed_entry_limit(tmp_path):
    for index in range(waveform._CACHE_SIZE + 2):
        path = tmp_path / f'{index}.wav'
        write_audio(path, seconds=1)
        waveform.get_waveform(str(path))
    assert len(waveform._cache) == waveform._CACHE_SIZE


def test_waveform_endpoint_missing_invalid_and_broken_audio(tmp_path, monkeypatch):
    from webtool.app import app
    monkeypatch.setenv('TRANSKRIBOR_PROJEKTE', str(tmp_path))
    (tmp_path / 'Demo' / 'audio').mkdir(parents=True)
    client = TestClient(app)
    assert client.get('/api/projects/Demo/audio/Missing/waveform').status_code == 404
    assert client.get('/api/projects/Demo/audio/bad%5Cname/waveform').status_code == 400
    path = tmp_path / 'Demo' / 'audio' / 'Clip.wav'
    write_audio(path, seconds=3)
    response = client.get('/api/projects/Demo/audio/Clip/waveform')
    assert response.status_code == 200
    assert response.json()['duration'] == pytest.approx(3)
    path.write_bytes(b'broken')
    response = client.get('/api/projects/Demo/audio/Clip/waveform')
    assert response.status_code == 422
    assert 'Wellenform' in response.json()['detail']


def test_waveform_endpoint_rejects_truncated_ogg_without_server_error(tmp_path, monkeypatch):
    from webtool.app import app
    monkeypatch.setenv('TRANSKRIBOR_PROJEKTE', str(tmp_path))
    audio = tmp_path / 'Demo' / 'audio'
    audio.mkdir(parents=True)
    (audio / 'Clip.ogg').write_bytes(b'OggS')
    response = TestClient(app, raise_server_exceptions=False).get('/api/projects/Demo/audio/Clip/waveform')
    assert response.status_code == 422
    assert response.json()['detail'] == 'Wellenform konnte nicht geladen werden'
