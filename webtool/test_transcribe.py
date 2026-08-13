"""Tests fuer den only=-Filter aus dem URL-Import (kein torch/whisper noetig)."""
import dataclasses
import importlib
import json
import os
import sys
import types

import transcribe


def test_opts_reicht_die_sprache_durch():
    o = transcribe._opts("en")
    assert o["language"] == "en"
    assert o["word_timestamps"] is True      # Grundlage fuer die Audio-Synchronisation


def test_opts_gibt_whisper_KEINEN_initial_prompt():
    """Der Prompt beendete ein 30-Sekunden-Fenster vorzeitig; Whisper ruckte den Lesezeiger
    daraufhin um das ganze Fenster weiter und las die restliche Sprache darin nie.

    Gemessen an ganzen Dateien, sonst identische Parameter: 1226 -> 1346 Woerter (01172464),
    454 -> 590 (C0701), 140 -> 158 (C0761). In einem Fall fehlten 18 s am Stueck. Nichts im
    Ergebnis zeigte das an — kein Flag, keine Warnung, nur fehlender Text. 17 von 37
    vorhandenen Aufnahmen trugen die Signatur.

    Der Test steht hier, weil die Zeile zum Wiedereinbau EINLAEDT: sie sah nuetzlich aus
    ("biast Whisper auf Eigennamen") und ihr Schaden ist unsichtbar. kontext.md gehoert in
    die LLM-Korrektur, nicht in den Decoder."""
    assert "initial_prompt" not in transcribe._opts("de")


def test_opts_haelt_den_fortschrittsbalken_an():
    """log_progress speist den tqdm-Balken, aus dem jobPhases.ts die Prozente liest —
    ohne ihn zeigt die Oberflaeche waehrend der ganzen Transkription keinen Fortschritt."""
    assert transcribe._opts("de")["log_progress"] is True


def test_opts_schaltet_vad_aus():
    """VAD wuerde Stille ueberspringen und die Segmentzeiten gegen das Audio verschieben —
    der Editor synchronisiert Text und Wiedergabe ueber genau diese Zeiten."""
    assert transcribe._opts("de")["vad_filter"] is False


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


# --- faster-whisper: Ergebnisform und Lauf-Robustheit ------------------------
# Die <base>.json ist ein VERTRAG (edit_model.build_edit_doc / tag_uncertain_segments lesen
# daraus), deshalb wird ihre Form hier gegen eine Attrappe geprueft statt gegen ein 3-GB-Modell.

@dataclasses.dataclass
class _Wort:
    start: float
    end: float
    word: str
    probability: float


@dataclasses.dataclass
class _Segment:
    id: int
    seek: int
    start: float
    end: float
    text: str
    tokens: list
    avg_logprob: float
    compression_ratio: float
    no_speech_prob: float
    words: list
    temperature: float


def _segment(i, text=" hallo"):
    return _Segment(id=i, seek=0, start=float(i), end=i + 1.0, text=text, tokens=[1, 2],
                    avg_logprob=-0.3, compression_ratio=1.1, no_speech_prob=0.01,
                    words=[_Wort(start=float(i), end=i + 0.5, word=text, probability=0.42)],
                    temperature=0.0)


class _Info:
    language = "de"
    duration = 2.0


def _faster_attrappe(monkeypatch, kaputt=()):
    """Minimales faster_whisper. Liefert die Liste der transkribierten Dateinamen."""
    gesehen = []

    class WhisperModel:
        def __init__(self, model, device=None, compute_type=None):
            self.device, self.compute_type = device, compute_type

        def transcribe(self, f, **kw):
            name = os.path.basename(f)
            gesehen.append(name)
            if name in kaputt:
                raise RuntimeError("Datei laesst sich nicht lesen")
            return iter([_segment(0), _segment(1, " welt")]), _Info()

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = WhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))
    from webtool import device as devicemod
    monkeypatch.setattr(devicemod, "pick_asr", lambda: "cpu")
    monkeypatch.setattr(devicemod, "describe",
                        lambda m="": {"device": "cpu", "name": "CPU", "torch_ok": True,
                                      "asr": "cpu", "asr_engine": "faster-whisper"})
    # Sonst haengt dieser Test an der Maschine: auf einem Entwickler-Mac mit installiertem
    # whisper-cli waehlt asr_engine() whisper.cpp, und die Attrappe oben liefe ins Leere.
    monkeypatch.setattr(devicemod, "asr_engine", lambda m: "faster-whisper")
    return gesehen


def _lauf_projekt(tmp_path, monkeypatch, **wie):
    proj = tmp_path / "P"
    (proj / "audio").mkdir(parents=True)
    for n in ("a.mp3", "b.mp3"):
        (proj / "audio" / n).write_bytes(b"x")
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    return proj, _faster_attrappe(monkeypatch, **wie)


def test_roh_json_behaelt_die_form_die_edit_model_liest(tmp_path, monkeypatch):
    proj, _ = _lauf_projekt(tmp_path, monkeypatch)
    transcribe.transcribe_project("P", "large-v3", "de")
    roh = json.loads((proj / "transkripte" / "a.json").read_text(encoding="utf-8"))
    assert roh["language"] == "de"
    # Segmenttexte aneinandergehaengt — mit fuehrendem Leerzeichen, genau wie openai-whispers
    # result["text"]. transcribe_project schreibt .raw.txt ohnehin mit .strip().
    assert roh["text"] == " hallo welt"
    s = roh["segments"][0]
    # Genau die Schluessel, an denen edit_model haengt — plus die, die nicht still wegfallen duerfen.
    for k in ("id", "start", "end", "text", "avg_logprob", "compression_ratio",
              "no_speech_prob", "words", "seek", "tokens", "temperature"):
        assert k in s, k
    assert s["words"][0]["probability"] == 0.42            # Grundlage des [[Wort|prob]]-Taggings

    from webtool.edit_model import build_edit_doc, tag_uncertain_segments
    doc = build_edit_doc(roh, base="a", project="P", audio="a.mp3")
    assert doc["segments"][0]["words"][0]["probability"] == 0.42
    assert "[[" in tag_uncertain_segments(roh)[0]["tagged_text"]   # 0.42 < 0.5 -> markiert


def test_nebenausgaben_werden_geschrieben(tmp_path, monkeypatch):
    proj, _ = _lauf_projekt(tmp_path, monkeypatch)
    transcribe.transcribe_project("P", "large-v3", "de")
    t = proj / "transkripte"
    assert t.joinpath("a.raw.txt").read_text(encoding="utf-8").strip() == "hallo welt"
    assert t.joinpath("a.segments.txt").read_text(encoding="utf-8").startswith("[0:00 - 0:01] hallo")


def test_kaputte_datei_ueberspringt_nur_sich_selbst(tmp_path, monkeypatch, capsys):
    """Die einzige Regel, die vom geloeschten MPS-Rueckfall uebrig bleibt."""
    proj, gesehen = _lauf_projekt(tmp_path, monkeypatch, kaputt={"a.mp3"})
    transcribe.transcribe_project("P", "large-v3", "de")
    assert gesehen == ["a.mp3", "b.mp3"]                    # der Lauf ging weiter
    assert not (proj / "transkripte" / "a.json").exists()
    assert (proj / "transkripte" / "b.json").exists()
    assert "FEHLER a" in capsys.readouterr().out


def test_compute_type_haengt_am_geraet(monkeypatch):
    """float16 ist auf der CPU teils nicht implementiert und sonst langsam."""
    _faster_attrappe(monkeypatch)
    assert transcribe._modell("tiny", "cuda").compute_type == "float16"
    assert transcribe._modell("tiny", "cpu").compute_type == "int8"


def test_cuda_dlls_nur_auf_windows(monkeypatch, tmp_path):
    """CTranslate2 bringt cuBLAS nicht mit, torch schon — aber nur Windows sucht ueber PATH.
    os.add_dll_directory() reicht dort NICHT (CTranslate2 laedt per plainem LoadLibrary)."""
    lib = tmp_path / "torch" / "lib"
    lib.mkdir(parents=True)
    fake_torch = types.ModuleType("torch")
    fake_torch.__file__ = str(tmp_path / "torch" / "__init__.py")
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    monkeypatch.setattr(transcribe.sys, "platform", "linux")
    monkeypatch.setenv("PATH", "")
    transcribe._cuda_dlls_auf_pfad()
    assert str(lib) not in os.environ["PATH"]

    monkeypatch.setattr(transcribe.sys, "platform", "win32")
    transcribe._cuda_dlls_auf_pfad()
    assert str(lib) in os.environ["PATH"]


def test_ohne_torch_kein_absturz(monkeypatch):
    """Der Python-CI-Job laeuft bewusst ohne torch — _cuda_dlls_auf_pfad darf das aushalten."""
    monkeypatch.setitem(sys.modules, "torch", None)   # None -> import wirft ImportError
    transcribe._cuda_dlls_auf_pfad()                  # kein Crash


def test_lauf_meldet_nur_die_noch_offenen_aufnahmen(tmp_path, monkeypatch, capsys):
    """Vertrag mit jobs.py (Issue #80): gemeldet wird, was der Lauf ANFASSEN wird — bereits
    transkribierte Aufnahmen bleiben damit loesch- und umbenennbar. Das Praefix steht hier
    als Literal (transcribe.py laeuft ohne die Job-Registry), dieser Test haelt beide Seiten
    zusammen."""
    from webtool import jobs
    proj, _ = _lauf_projekt(tmp_path, monkeypatch)
    (proj / "transkripte").mkdir(parents=True, exist_ok=True)
    (proj / "transkripte" / "a.json").write_text("{}", encoding="utf-8")   # a ist fertig
    transcribe.transcribe_project("P", "large-v3", "de")
    zeilen = [z for z in capsys.readouterr().out.splitlines() if z.startswith(jobs.SCOPE_PREFIX)]
    assert len(zeilen) == 1
    assert set(zeilen[0][len(jobs.SCOPE_PREFIX):].split("\t")) == {"b"}


def test_lauf_ohne_offene_aufnahme_meldet_einen_leeren_bereich(tmp_path, monkeypatch, capsys):
    """Der Leerlauf-Fall nach dem Auto-Trigger: nichts zu tun heisst auch nichts gesperrt."""
    from webtool import jobs
    proj, _ = _lauf_projekt(tmp_path, monkeypatch)
    (proj / "transkripte").mkdir(parents=True, exist_ok=True)
    for n in ("a", "b"):
        (proj / "transkripte" / f"{n}.json").write_text("{}", encoding="utf-8")
    transcribe.transcribe_project("P", "large-v3", "de")
    aus = capsys.readouterr().out
    assert jobs.SCOPE_PREFIX in aus and "nichts zu tun" in aus
    zeile = [z for z in aus.splitlines() if z.startswith(jobs.SCOPE_PREFIX)][0]
    assert zeile[len(jobs.SCOPE_PREFIX):].strip() == ""


# --- Sprache pro Datei aus projekt.json -------------------------------------
# Eine projekt.json mitsprache=de ueberschreibt WHISPER_LANG nicht mehr fuer alle
# Dateien gleich, sondern pro Datei. 'auto' -> None (Whisper erkennt selbst).

def test_datei_whisper_code_liefert_projektdefault(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    with open(os.path.join(tmp_path, "p", "projekt.json"), "w") as fh:
        json.dump({"sprache": "en", "korrektur": "auto", "dateien": {}}, fh)
    assert transcribe._datei_whisper_code(os.path.join(tmp_path, "p"), "v1", "de") == "en"


def test_datei_whisper_code_auto_ist_none(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    with open(os.path.join(tmp_path, "p", "projekt.json"), "w") as fh:
        json.dump({"sprache": "auto", "korrektur": "auto", "dateien": {}}, fh)
    assert transcribe._datei_whisper_code(os.path.join(tmp_path, "p"), "v1", "de") is None


def test_datei_whisper_code_fallback_wenn_import_scheitert(tmp_path, monkeypatch):
    # Der Fallback-Zweig (except Exception: return fallback) ist der Wächter, der das
    # Skript ohne webtool-Paket lauffaehig haelt. Nur dieser Weg darf hier durchkommen:
    # datei_sprache zum Werfen zwingen, dann MUSS der Helfer auf 'fallback' zurueckfallen.
    # Mutationstest: ohne die except-Klausel wirft der Helfer selbst -> Test rot.
    import webtool.projekt
    def _boom(*a, **k):
        raise RuntimeError("simulated")
    monkeypatch.setattr(webtool.projekt, "datei_sprache", _boom)
    assert transcribe._datei_whisper_code(str(tmp_path), "v1", "de") == "de"


def test_opts_vorgabe_ist_unveraendert():
    """Constraint-Test: die einsprachige Pipeline muss byte-identisch bleiben. Ohne ihn
    faellt eine versehentliche Umstellung niemandem auf — das Ergebnis waere weiterhin
    plausibler Text, nur schlechter (gemessen: 206 -> 89 identische Segmenttexte)."""
    o = transcribe._opts("de")
    assert o["condition_on_previous_text"] is True
    assert "multilingual" not in o


def test_opts_mehrsprachig_setzt_multilingual():
    assert transcribe._opts("de", mehrsprachig=True)["multilingual"] is True


def test_opts_mehrsprachig_schaltet_kontext_ab():
    """Zwei getrennte Tests, weil es zwei getrennte Fehlermoeglichkeiten sind. Nur
    multilingual: Whisper erkennt Englisch korrekt (p=0.938 gemessen) und gibt es
    trotzdem auf Deutsch zurueck, weil der deutsche Vorlauf als Prompt mitreist."""
    assert transcribe._opts("de", mehrsprachig=True)["condition_on_previous_text"] is False
