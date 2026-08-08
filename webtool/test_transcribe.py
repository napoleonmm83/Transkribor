"""Tests fuer den only=-Filter aus dem URL-Import (kein torch/whisper noetig)."""
import os

import transcribe


def test_opts_fp16_nur_bei_cuda():
    """fp16 auf MPS oder CPU wuerde werfen bzw. still falsch rechnen."""
    assert transcribe._opts("prompt", "de", "cuda")["fp16"] is True
    assert transcribe._opts("prompt", "de", "mps")["fp16"] is False
    assert transcribe._opts("prompt", "de", "cpu")["fp16"] is False


def test_opts_reicht_prompt_und_sprache_durch():
    o = transcribe._opts("Kontext hier", "en", "cpu")
    assert o["initial_prompt"] == "Kontext hier"
    assert o["language"] == "en"
    assert o["word_timestamps"] is True      # Grundlage fuer die Audio-Synchronisation


def _projekt(tmp_path, *namen):
    adir = tmp_path / "audio"
    adir.mkdir()
    for n in namen:
        (adir / n).write_bytes(b"x")
    return str(tmp_path)


def test_find_audio_ohne_only_liefert_alles(tmp_path):
    proj = _projekt(tmp_path, "a.mp3", "b.m4a", "notiz.txt")
    namen = [os.path.basename(f) for f in transcribe.find_audio(proj)]
    assert namen == ["a.mp3", "b.m4a"]          # .txt ist kein Audio


def test_find_audio_mit_only_filtert_auf_basisnamen(tmp_path):
    proj = _projekt(tmp_path, "a.mp3", "b.m4a", "c.wav")
    got = transcribe.find_audio(proj, only=["b", "c"])
    namen = sorted(os.path.basename(f) for f in got)
    assert namen == ["b.m4a", "c.wav"]


def test_find_audio_mit_leerem_only_liefert_nichts(tmp_path):
    # Wichtig: fuehrt in transcribe_project zum fruehen Ausstieg VOR whisper.load_model()
    proj = _projekt(tmp_path, "a.mp3")
    assert transcribe.find_audio(proj, only=[]) == []


def test_find_audio_only_unbekannter_name_ist_leer(tmp_path):
    proj = _projekt(tmp_path, "a.mp3")
    assert transcribe.find_audio(proj, only=["gibtsnicht"]) == []
