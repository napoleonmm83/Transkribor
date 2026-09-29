"""Probe des echten Audio-Decoders, bevor die Einrichtung als fertig gilt."""

import io
import wave


def pruefen() -> None:
    from faster_whisper.audio import decode_audio

    audio = io.BytesIO()
    with wave.open(audio, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(bytes(320))
    audio.seek(0)
    samples = decode_audio(audio)
    if len(samples) != 160:
        raise RuntimeError("Audio-Decoder liefert keine vollständigen Samples")
