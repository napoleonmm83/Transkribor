"""Akustische Sprecher-Diarisierung (Stufe 3): Audio -> Sprecher-Cluster pro Zeitspanne.

pyannote.audio (community-1) liefert anonyme Cluster; die Zuordnung Segment->Cluster per
grösster zeitlicher Überlappung (`assign_clusters`) ist reines, unit-getestetes Python.
Die torch/pyannote-Importe liegen bewusst INNERHALB der Funktionen (lazy) — `import
webtool.diarize` bleibt leicht und ohne installiertes pyannote lauffähig (Best-effort-Fallback
im Aufrufer)."""
import os

# Das Modell liegt IM Repo (models/, ~31 MB) und wird mit der App ausgeliefert, statt bei
# Hugging Face zu haengen: dessen Gate ist ein Kontaktformular, kein Lizenzhindernis
# (CC-BY-4.0), kostete den Nutzer aber Konto + Token + Haekchen im Browser — der einzige
# Einrichtungsschritt der Desktop-App, den kein Klick loesen konnte. Die config.yaml
# referenziert ihre Gewichte als `$model/...` und `$model` ist ihr eigenes Verzeichnis,
# der Ordner ist also unveraendert verschiebbar.
DIAR_MODEL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "models", "speaker-diarization-community-1", "config.yaml")
_PIPELINE = None


def _pipeline():
    """Lazy-Singleton der pyannote-Pipeline (Modell aus models/; GPU falls vorhanden)."""
    global _PIPELINE
    if _PIPELINE is None:
        import torch
        from pyannote.audio import Pipeline
        if not os.path.exists(DIAR_MODEL):
            raise RuntimeError(f"Diarisierungsmodell fehlt: {DIAR_MODEL}")
        pipe = Pipeline.from_pretrained(DIAR_MODEL)
        if pipe is None:
            raise RuntimeError(f"pyannote-Pipeline nicht geladen ({DIAR_MODEL})")
        # Dasselbe Geraet wie die Transkription (webtool/device.py). Scheitert MPS hier,
        # bleibt es beim Best-effort-Verhalten: kein .diar.json, Korrektur laeuft wie vor
        # Stufe 3 weiter — die Sprechertrennung faellt aus, nicht der Lauf.
        from . import device as devicemod
        dev = devicemod.pick()
        if dev != "cpu":
            pipe.to(torch.device(dev))
        _PIPELINE = pipe
    return _PIPELINE


def _ensure_ffmpeg():
    """ffmpeg auf PATH sicherstellen (whisper.load_audio ruft es via subprocess).
    Bewusst dupliziert (mirror von transcribe.ensure_ffmpeg), um webtool nicht ans
    Root-Skript transcribe.py zu koppeln."""
    import glob
    import sys
    from shutil import which
    if which("ffmpeg"):
        return
    if sys.platform == "win32":
        for d in glob.glob(os.path.expandvars(
                r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg*\bin")):
            if os.path.exists(os.path.join(d, "ffmpeg.exe")):
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                return
        return
    for d in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"):
        if os.path.exists(os.path.join(d, "ffmpeg")):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return


def _load_waveform(audio_path: str) -> dict:
    """Audio -> {'waveform': (1,time) float32-Tensor, 'sample_rate': 16000} via
    whisper.load_audio (ffmpeg, 16 kHz mono). Umgeht das auf Windows kaputte
    torchcodec-Decoding von pyannote."""
    import torch
    import whisper
    _ensure_ffmpeg()
    samples = whisper.load_audio(audio_path)            # float32 numpy, 16 kHz mono
    return {"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": 16000}


def diarize_file(audio_path: str, min_speakers: int = 2) -> list:
    """Diarisiert eine Audiodatei -> [{'start','end','cluster'}] (zeitlich sortiert).
    'cluster' ist das rohe pyannote-Label (z.B. 'SPEAKER_00'). Audio wird in-memory
    geladen (torchcodec-Bypass, siehe _load_waveform)."""
    output = _pipeline()(_load_waveform(audio_path), min_speakers=min_speakers)
    # pyannote 4.x/community-1 liefert ein DiarizeOutput-Objekt; die Annotation (mit
    # itertracks) steckt in .speaker_diarization. Ältere Versionen geben die Annotation
    # direkt zurück -> getattr-Fallback macht diarize_file robust gegen beide APIs.
    annotation = getattr(output, "speaker_diarization", output)
    turns = [{"start": float(t.start), "end": float(t.end), "cluster": spk}
             for t, _, spk in annotation.itertracks(yield_label=True)]
    turns.sort(key=lambda t: (t["start"], t["end"]))
    return turns


def assign_clusters(raw: dict, turns: list) -> dict:
    """Ordne jeder Roh-Segment-ID ein 'Sprecher N'-Label zu (N nach erster zeitlicher
    Erscheinung des Clusters). Zuordnung per grösster Gesamt-Überlappung; Segmente ohne
    Überlappung erben das vorige Label (bzw. den frühesten Cluster)."""
    order = {}                                   # cluster -> 1-basige Nummer nach erster Erscheinung
    for t in sorted(turns, key=lambda t: (t["start"], t["end"])):
        order.setdefault(t["cluster"], len(order) + 1)
    label = {c: f"Sprecher {n}" for c, n in order.items()}
    earliest = min(order, key=order.get) if order else None

    out, prev = {}, None
    for seg in raw.get("segments", []):
        s, e = seg.get("start"), seg.get("end")
        by_cluster = {}
        for t in turns:
            ov = max(0.0, min(e, t["end"]) - max(s, t["start"]))
            if ov > 0:
                by_cluster[t["cluster"]] = by_cluster.get(t["cluster"], 0.0) + ov
        if by_cluster:
            # Gleichstand (exakt gleicher Overlap) ist deterministisch: max() nimmt den ersten
            # Cluster in Turn-Reihenfolge. Real quasi nie, da Overlaps praktisch nie exakt gleich sind.
            spk = label[max(by_cluster, key=by_cluster.get)]
        else:
            spk = prev if prev is not None else (label[earliest] if earliest else "Sprecher 1")
        out[seg.get("id")] = spk
        prev = spk
    return out
