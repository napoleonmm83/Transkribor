"""Tests fuer den only=-Filter aus dem URL-Import (kein torch/whisper noetig)."""
import importlib
import os
import sys
import types

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


def test_ensure_ffmpeg_findet_homebrew(monkeypatch, tmp_path):
    """macOS: GUI-Apps sehen /opt/homebrew/bin nicht im PATH."""
    import transcribe
    brew = tmp_path / "opt" / "homebrew" / "bin"
    brew.mkdir(parents=True)
    (brew / "ffmpeg").write_text("#!/bin/sh\n")

    monkeypatch.setattr(transcribe, "which", lambda n: None)
    monkeypatch.setattr(transcribe.sys, "platform", "darwin")
    monkeypatch.setattr(transcribe, "POSIX_FFMPEG_DIRS", (str(brew),))
    monkeypatch.setenv("PATH", "")

    assert transcribe.ensure_ffmpeg() is True
    assert str(brew) in os.environ["PATH"]


def test_ensure_ffmpeg_kein_winget_glob_auf_posix(monkeypatch):
    """Der winget-Pfad ist Windows-spezifisch und darf auf POSIX nicht angefasst werden."""
    import transcribe
    monkeypatch.setattr(transcribe, "which", lambda n: None)
    monkeypatch.setattr(transcribe.sys, "platform", "linux")
    monkeypatch.setattr(transcribe, "POSIX_FFMPEG_DIRS", ())

    def explodiere(*a, **k):
        raise AssertionError("glob darf auf POSIX nicht laufen")

    monkeypatch.setattr(transcribe.glob, "glob", explodiere)
    assert transcribe.ensure_ffmpeg() is False


# --- MPS-Rueckfall (Task I3) --------------------------------------------------

def _whisper_attrappe(monkeypatch, kaputt=(), nur_cpu=(), laden_scheitert_bei=()):
    """Minimales whisper/torch statt eines echten 3-GB-Modells. `kaputt` scheitert auf jedem
    Geraet (defekte Datei), `nur_cpu` nur auf mps (echte MPS-Luecke).

    `laden_scheitert_bei` nennt die NUMMERN der load_model-Aufrufe, die werfen sollen
    (1-basig) — nicht die Geraete: dasselbe Geraet wird einmal vor der Schleife geladen und
    spaeter womoeglich wiederhergestellt, und nur der zweite Fall ist interessant.

    Liefert die Liste der Geraete, auf die load_model gerufen wurde — daran haengt der Test."""
    geladen = []

    class Modell:
        def __init__(self, device):
            self.device = device

        def transcribe(self, f, **kw):
            name = os.path.basename(f)
            if name in kaputt:
                raise RuntimeError("Datei laesst sich nicht lesen")
            if self.device == "mps" and name in nur_cpu:
                raise RuntimeError("aten::_index_put_impl_ fehlt auf MPS")
            return {"text": "hallo", "segments": [{"start": 0.0, "end": 1.0, "text": "hallo"}]}

    def load_model(model, device=None):
        geladen.append(device)
        if len(geladen) in laden_scheitert_bei:
            raise RuntimeError(f"kein Speicher fuer {device}")
        return Modell(device)

    fake = types.ModuleType("whisper")
    fake.load_model = load_model
    monkeypatch.setitem(sys.modules, "whisper", fake)
    monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))
    from webtool import device as devicemod
    monkeypatch.setattr(devicemod, "pick", lambda: "mps")
    monkeypatch.setattr(devicemod, "describe",
                        lambda: {"device": "mps", "name": "Apple GPU", "torch_ok": True})
    return geladen


def _mps_projekt(tmp_path, monkeypatch, **wie):
    proj = tmp_path / "P"
    (proj / "audio").mkdir(parents=True)
    for n in ("a.mp3", "b.mp3"):
        (proj / "audio" / n).write_bytes(b"x")
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    return proj, _whisper_attrappe(monkeypatch, **wie)


def test_kaputte_datei_zieht_den_rest_des_laufs_nicht_auf_die_cpu(tmp_path, monkeypatch):
    """Scheitert eine Datei AUCH auf der CPU, lag es nicht an MPS — sonst macht eine
    kaputte Datei an Position 1 aus einem 20-Minuten-Lauf einen Stundenlauf."""
    proj, geladen = _mps_projekt(tmp_path, monkeypatch, kaputt={"a.mp3"})
    transcribe.transcribe_project("P", "large-v3", "de")
    assert geladen == ["mps", "cpu", "mps"]                  # Geraet wiederhergestellt
    assert not (proj / "transkripte" / "a.json").exists()    # die kaputte Datei bleibt liegen
    assert (proj / "transkripte" / "b.json").exists()        # der Rest lief weiter (auf mps)


def test_echter_mps_ausfall_bleibt_auf_der_cpu(tmp_path, monkeypatch):
    """Klappt die CPU, war es wirklich MPS — dann nicht bei jeder Datei neu ausprobieren."""
    proj, geladen = _mps_projekt(tmp_path, monkeypatch, nur_cpu={"a.mp3", "b.mp3"})
    transcribe.transcribe_project("P", "large-v3", "de")
    assert geladen == ["mps", "cpu"]                         # kein Zurueckschalten
    assert (proj / "transkripte" / "a.json").exists()
    assert (proj / "transkripte" / "b.json").exists()


def test_kein_cpu_modell_ueberspringt_die_datei_statt_den_lauf(tmp_path, monkeypatch, capsys):
    """Das load_model im except stand ungeschuetzt: wirft es, war der ganze Lauf verloren —
    wegen EINER Datei. Ueberall sonst in der Schleife gilt "Datei ueberspringen, Rest laeuft"."""
    # Aufruf 1 = mps vor der Schleife (klappt), Aufruf 2 = der CPU-Rueckfall (wirft).
    proj, geladen = _mps_projekt(tmp_path, monkeypatch,
                                 nur_cpu={"a.mp3"}, laden_scheitert_bei={2})
    transcribe.transcribe_project("P", "large-v3", "de")
    assert geladen == ["mps", "cpu"]                         # cpu versucht, gescheitert
    assert not (proj / "transkripte" / "a.json").exists()    # die eine Datei bleibt liegen
    assert (proj / "transkripte" / "b.json").exists()        # der Rest lief auf mps weiter
    assert "CPU-Modell nicht ladbar" in capsys.readouterr().out


def test_nicht_wiederherstellbares_mps_laesst_den_lauf_auf_der_cpu_weiterlaufen(
        tmp_path, monkeypatch, capsys):
    """Scheitert das Zuruecksetzen auf mps, ist der Lauf langsamer — aber nicht tot."""
    # Aufruf 1 = mps vor der Schleife, 2 = CPU-Rueckfall, 3 = das Wiederherstellen (wirft).
    proj, geladen = _mps_projekt(tmp_path, monkeypatch,
                                 kaputt={"a.mp3"}, laden_scheitert_bei={3})
    transcribe.transcribe_project("P", "large-v3", "de")
    assert geladen == ["mps", "cpu", "mps"]                  # Wiederherstellung versucht
    assert not (proj / "transkripte" / "a.json").exists()
    assert (proj / "transkripte" / "b.json").exists()        # b lief auf der CPU durch
    assert "nicht wiederherstellbar" in capsys.readouterr().out


def test_projekte_folgt_der_umgebungsvariable(tmp_path, monkeypatch):
    """Gepackt liegen die Projekte in userData, NICHT neben dem Code: backend.js setzt
    TRANSKRIBOR_PROJEKTE, paths.py liest es — transcribe.py hatte es fest verdrahtet und
    meldete im Installer bei jedem Lauf "Projekt nicht gefunden"."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    try:
        importlib.reload(transcribe)
        assert transcribe.PROJEKTE == str(tmp_path)
    finally:
        monkeypatch.delenv("TRANSKRIBOR_PROJEKTE")
        importlib.reload(transcribe)      # sonst sehen Folgetests den tmp_path
