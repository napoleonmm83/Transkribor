"""Tests fuer den only=-Filter aus dem URL-Import (kein torch/whisper noetig)."""
import dataclasses
import importlib
import json
import os
import sys
import types

import pytest

import transcribe


@pytest.fixture(autouse=True)
def _autocorrect_pin(monkeypatch):
    """Der Kill-Switch wird seit #406 im Lauf selbst gelesen — ohne dieses Pinnen haengen
    alle autocorrect-Tests dieser Datei daran, ob der Entwickler gerade
    `TRANSKRIBOR_AUTOCORRECT=0` in der Shell stehen hat. Sie waeren dort gruen, ohne die
    Kette je zu erreichen (dieselbe Falle, die `test_api.py` beim Anbieter-Gate benennt).
    Ein Test, der den Schalter selbst prueft, setzt ihn im Rumpf — der spaetere Aufruf gewinnt.
    (Heisst bewusst NICHT wie `transcribe._autocorrect_an`: gleicher Name, anderes Ding.)
    """
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "1")


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


def test_opts_setzt_repetition_penalty():
    """repetition_penalty verhindert, dass Whisper bei Hintergrundmusik/Stille in endlose Schleifen verfaellt."""
    assert transcribe._opts("de")["repetition_penalty"] == 1.1


def test_bereinige_wiederholungs_schleifen_kappt_ausufernde_wiederholungen():
    """300 aufeinanderfolgende Kopien desselben Satzes muessen auf die ersten 2 reduziert werden."""
    segs = [{"id": 0, "text": "Hallo Welt", "start": 0.0, "end": 2.0}]
    for i in range(1, 301):
        segs.append({"id": i, "text": " Das war's mit dem Tandem.", "start": float(i), "end": float(i + 1)})
    segs.append({"id": 301, "text": "Abschlusswort", "start": 302.0, "end": 303.0})

    bereinigt = transcribe.bereinige_wiederholungs_schleifen(segs, max_wiederholungen=2)
    texte = [s["text"].strip() for s in bereinigt]
    assert texte.count("Das war's mit dem Tandem.") == 2
    assert texte[0] == "Hallo Welt"
    assert texte[-1] == "Abschlusswort"
    assert len(bereinigt) == 4
    assert [s["id"] for s in bereinigt] == [0, 1, 2, 3]


def test_bereinige_wiederholungs_schleifen_schont_kurze_und_unterschiedliche_texte():
    segs = [
        {"id": 0, "text": "Ja", "start": 0.0, "end": 1.0},
        {"id": 1, "text": "Ja", "start": 1.0, "end": 2.0},
        {"id": 2, "text": "Nein", "start": 2.0, "end": 3.0},
        {"id": 3, "text": "Ja", "start": 3.0, "end": 4.0},
    ]
    bereinigt = transcribe.bereinige_wiederholungs_schleifen(segs, max_wiederholungen=2)
    assert len(bereinigt) == 4



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


def test_find_audio_mit_einzelnem_string_only(tmp_path):
    proj = _projekt(tmp_path, "interview.mp3", "andere.mp3")
    got = transcribe.find_audio(proj, only="interview")
    assert [os.path.basename(f) for f in got] == ["interview.mp3"]


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
    # `transcribe.PROJEKTE` allein reicht NICHT (CodeRabbit-Bot): `_datei_sprachwahl` ruft
    # `webtool.projekt.datei_einstellungen`, und das liest `paths.projekte_root()` — also
    # TRANSKRIBOR_PROJEKTE, nicht das gepatchte Modulattribut. Ohne die Variable liefert ein
    # gleichnamiges echtes Projekt „P" des Entwicklers seine Sprache und Mehrsprachigkeit in
    # diesen Testlauf. Dieselbe Falle wie TRANSKRIBOR_SETTINGS, nur eine Ebene tiefer.
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
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


def test_lauf_meldet_seine_gesamtdauer_und_zaehlt_nur_geglueckte(tmp_path, monkeypatch, capsys):
    """Die Summenzeile der Phasenmessung. Nur sie laesst sich mit der Korrekturphase
    (`⏱ Phasen:` in correct.py) vergleichen — die Einzelzeilen daneben gibt es laengst.

    Auf der kaputten Buehne, weil die interessante Zusicherung die ZAEHLUNG ist: `n_ok` und
    `audio_gesamt` werden erst NACH dem `except continue` hochgezaehlt, eine gescheiterte
    Datei darf also weder mitzaehlen noch ihre Laenge beisteuern. Bei zwei Dateien, von denen
    eine wirft, ist „1" die einzige richtige Antwort — „2" hiesse, die Zaehler stuenden vor
    dem Fehlerzweig, und der Echtzeitfaktor waere dauerhaft geschoent."""
    _lauf_projekt(tmp_path, monkeypatch, kaputt={"a.mp3"})
    transcribe.transcribe_project("P", "large-v3", "de")
    aus = capsys.readouterr().out
    assert "1 Datei(en) transkribiert in" in aus
    assert "2 Datei(en) transkribiert in" not in aus


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

def test_datei_sprachwahl_liefert_projektdefault(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    with open(os.path.join(tmp_path, "p", "projekt.json"), "w") as fh:
        json.dump({"sprache": "en", "korrektur": "auto", "dateien": {}}, fh)
    assert transcribe._datei_sprachwahl(os.path.join(tmp_path, "p"), "v1", "de") == ("en", False)


def test_datei_sprachwahl_auto_ist_none(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    os.makedirs(os.path.join(tmp_path, "p"), exist_ok=True)
    with open(os.path.join(tmp_path, "p", "projekt.json"), "w") as fh:
        json.dump({"sprache": "auto", "korrektur": "auto", "dateien": {}}, fh)
    assert transcribe._datei_sprachwahl(os.path.join(tmp_path, "p"), "v1", "de") == (None, False)


def test_datei_sprachwahl_fallback_wenn_import_scheitert(tmp_path, monkeypatch):
    # Der Fallback-Zweig (except Exception: return fallback) ist der Wächter, der das
    # Skript ohne webtool-Paket lauffaehig haelt. Nur dieser Weg darf hier durchkommen:
    # datei_sprache zum Werfen zwingen, dann MUSS der Helfer auf 'fallback' zurueckfallen.
    # Mutationstest: ohne die except-Klausel wirft der Helfer selbst -> Test rot.
    import webtool.projekt
    def _boom(*a, **k):
        raise RuntimeError("simulated")
    monkeypatch.setattr(webtool.projekt, "datei_sprache", _boom)
    assert transcribe._datei_sprachwahl(str(tmp_path), "v1", "de") == ("de", False)


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


class _FakeCt2:
    """Nachbau des ct2-Modells: liefert vorgegebene Erkennungen der Reihe nach. Gegen das
    echte Modell zu testen hiesse, 3 GB zu laden und Audio zu brauchen — geprueft wird hier
    die Klemm-Logik, nicht Whisper."""

    def __init__(self, folge):
        self.folge = list(folge)

    def detect_language(self, enc):
        code, p = self.folge.pop(0)
        return [[(f"<|{code}|>", p)]]


def _erkannt(ergebnis):
    return ergebnis[0][0][0][2:-2]


def test_schwelle_klemmt_unsicheren_wechsel_auf_den_anker():
    """Unter der Schwelle gilt der Anker.

    Die Zahl 0.29 stammt aus einer Messung an echtem Material: so sicher war sich der
    Detektor ueber dem Abspann (keine Sprache). Echtes Deutsch liegt dort bei 0.98-1.00,
    eine echte englische Interviewpassage bei 0.565 — siehe
    test_vorgabeschwelle_laesst_echtes_interview_englisch_durch. Frueher stand hier, 0.289
    UND 0.432 seien Falschmeldungen auf einem einsprachigen Video gewesen; das war falsch
    (0.432 war die englische Passage, das Video nicht einsprachig)."""
    p = transcribe._Sprachschwelle(_FakeCt2([("en", 0.29)]), "de", 0.7)
    assert _erkannt(p.detect_language(None)) == "de"


def test_schwelle_laesst_sicheren_wechsel_durch():
    p = transcribe._Sprachschwelle(_FakeCt2([("en", 0.938)]), "de", 0.7)
    assert _erkannt(p.detect_language(None)) == "en"


def test_schwelle_klemmt_nicht_bei_gleicher_sprache():
    """Unsicheres Deutsch bleibt Deutsch — es gibt nichts zu klemmen.

    Geprueft wird die WAHRSCHEINLICHKEIT, nicht der Sprachcode: klemmt der Proxy, erfindet
    er ein glattes 1.0; laesst er durch, steht der echte Wert da. Der Code allein ist hier
    blind, weil geklemmt und durchgelassen beide 'de' ergeben — mit einer Zusicherung auf
    den Code blieb dieser Test gruen, obwohl die halbe Bedingung entfernt war
    (Mutationsprobe, genau dafuer ist sie da)."""
    p = transcribe._Sprachschwelle(_FakeCt2([("de", 0.4)]), "de", 0.7)
    ergebnis = p.detect_language(None)
    assert _erkannt(ergebnis) == "de"
    assert ergebnis[0][0][1] == 0.4              # durchgereicht, nicht erfunden
    assert p.fenster == [["de", 0.4, "de"]]


def test_schwelle_ohne_anker_nimmt_die_erste_erkennung():
    """Sprache 'auto': die ERSTE Erkennung wird zum Anker, auch eine unsichere.

    Nicht „die erste sichere": faster-whisper legt `info.language` am ERSTEN Fenster fest,
    und `correct._ziel_dialekt` loest 'auto' spaeter daraus auf. Wartete der Anker auf ein
    besonders sicheres Fenster, koennte er auf einer spaeteren Sprache einrasten als der in
    der Roh-JSON — ab da klemmte jedes unsichere Fenster auf die falsche. Gilt unabhaengig
    davon, wo MIX_SCHWELLE steht."""
    p = transcribe._Sprachschwelle(_FakeCt2([("fr", 0.3), ("en", 0.95), ("de", 0.2)]), None, 0.7)
    assert _erkannt(p.detect_language(None)) == "fr"     # unsicher, aber Anker
    assert _erkannt(p.detect_language(None)) == "en"     # sicher -> echter Wechsel
    assert _erkannt(p.detect_language(None)) == "fr"     # unsicheres de -> auf den Anker


def test_schwelle_ohne_anker_klemmt_ab_dem_zweiten_fenster():
    """Gegenprobe zum vorigen: der Anker aus Fenster 1 wirkt sofort, nicht erst nach einer
    sicheren Erkennung."""
    p = transcribe._Sprachschwelle(_FakeCt2([("de", 0.55), ("en", 0.29)]), None, 0.7)
    assert _erkannt(p.detect_language(None)) == "de"
    assert _erkannt(p.detect_language(None)) == "de"     # 0.29 wird geklemmt, nicht uebernommen


def test_schwelle_protokolliert_jedes_fenster():
    p = transcribe._Sprachschwelle(_FakeCt2([("en", 0.29), ("de", 0.99)]), "de", 0.7)
    p.detect_language(None)
    p.detect_language(None)
    assert p.fenster == [["en", 0.29, "de"], ["de", 0.99, "de"]]


def test_schwelle_reicht_unbekannte_attribute_durch():
    """Der Proxy haengt am Platz des ct2-Modells — alles, was faster-whisper sonst
    daran ruft, muss weiter ankommen."""
    echt = _FakeCt2([])
    echt.is_multilingual = True
    assert transcribe._Sprachschwelle(echt, "de", 0.7).is_multilingual is True


def test_sprachwahl_liefert_code_und_flag(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    from webtool import projekt
    projekt.setze_datei("p", "a", sprache="en", mehrsprachig=True)
    assert transcribe._datei_sprachwahl(str(tmp_path / "p"), "a", "de") == ("en", True)


def test_sprachwahl_faellt_ohne_projektdatei_zurueck(tmp_path, monkeypatch):
    """Das Grund-Skript laeuft ohne projekt.json — dann gilt das globale --language
    und nicht mehrsprachig (Legacy-Verhalten)."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    assert transcribe._datei_sprachwahl(str(tmp_path / "fehlt"), "a", "de") == ("de", False)


class _FakeModell:
    """Nachbau von WhisperModel: merkt sich die Optionen, liefert ein leeres Ergebnis."""

    def __init__(self):
        self.model = types.SimpleNamespace(name="ct2")
        self.gesehen = []

    def transcribe(self, f, **opts):
        self.gesehen.append(opts)
        # `duration` gehoert zu faster-whispers TranscriptionInfo und wird seit #83 gelesen —
        # eine Attrappe ohne das Feld waere eine Attrappe der Vorgaengerfassung.
        return iter(()), types.SimpleNamespace(language="de", duration=12.0)


def test_datei_lauf_haengt_den_proxy_wieder_aus():
    """Der Proxy darf NICHT haengen bleiben: das Modell wird pro Projektlauf einmal geladen
    und von allen Dateien geteilt — die naechste, einsprachige Datei bekaeme sonst die
    Klemmung auf eine fremde Ankersprache ab."""
    m = _FakeModell()
    echt = m.model
    transcribe._transkribiere_datei(m, "faster-whisper", "a.m4a", "de", True, "large-v3")
    assert m.model is echt
    assert m.gesehen[0]["multilingual"] is True


def test_datei_lauf_haengt_auch_nach_fehler_wieder_aus():
    """Rueckbau im finally, nicht am Ende: eine kaputte Datei ueberspringt der Lauf und
    macht weiter — mit einem haengengebliebenen Proxy am geteilten Modell."""
    import pytest
    m = _FakeModell()
    echt = m.model

    def kaputt(f, **opts):
        raise RuntimeError("kaputte Datei")

    m.transcribe = kaputt
    with pytest.raises(RuntimeError):
        transcribe._transkribiere_datei(m, "faster-whisper", "a.m4a", "de", True, "large-v3")
    assert m.model is echt


def test_datei_lauf_schreibt_window_languages():
    m = _FakeModell()
    result = transcribe._transkribiere_datei(m, "faster-whisper", "a.m4a", "de", True, "large-v3")
    assert "window_languages" in result


def test_einsprachige_datei_bekommt_keine_window_languages():
    m = _FakeModell()
    result = transcribe._transkribiere_datei(m, "faster-whisper", "a.m4a", "de", False, "large-v3")
    assert "window_languages" not in result
    assert "multilingual" not in m.gesehen[0]


def test_gemischte_datei_faellt_von_whispercpp_auf_faster_whisper(monkeypatch):
    """DER Mac-Test. whisper.cpp ruft whisper-cli mit einem festen -l und kann keine
    Erkennung pro Fenster. Ohne diesen Rueckfall bekaeme ein Mac-Nutzer ein einsprachiges
    Transkript, ohne dass irgendwo etwas fehlschlaegt."""
    from webtool import whispercpp
    m = _FakeModell()
    gerufen = []
    monkeypatch.setattr(whispercpp, "transkribiere",
                        lambda *a, **k: gerufen.append(a) or {"segments": []})
    # Der Aufrufer laedt das Modell, sobald _braucht_faster_whisper True sagt; dieser Test
    # bildet das nach — m wird hineingereicht, nicht in der Funktion erzeugt.
    assert transcribe._braucht_faster_whisper("whisper.cpp", True) is True
    transcribe._transkribiere_datei(m, "whisper.cpp", "a.m4a", "de", True, "large-v3")
    assert gerufen == []                          # whisper.cpp NICHT gerufen
    assert m.gesehen[0]["multilingual"] is True


def test_einsprachige_datei_bleibt_bei_whispercpp(monkeypatch):
    """Positivkontrolle zum vorigen Test: ohne sie koennte der Rueckfall auch ALLE Dateien
    von whisper.cpp wegziehen und der Test oben bliebe trotzdem gruen."""
    from webtool import whispercpp
    gerufen = []
    monkeypatch.setattr(whispercpp, "transkribiere",
                        lambda *a, **k: gerufen.append(a) or {"segments": []})
    transcribe._transkribiere_datei(None, "whisper.cpp", "a.m4a", "de", False, "large-v3")
    assert len(gerufen) == 1


def test_projektlauf_auf_whispercpp_stuerzt_nicht_ab(tmp_path, monkeypatch):
    """Regression: `mehr` ist eine Schleifen-Variable und darf in der Engine-Entscheidung
    VOR der Schleife nicht vorkommen — sonst stirbt jeder Apple-Silicon-Lauf mit
    UnboundLocalError, und zwar VOR der Schleife, also ausserhalb des try/except, das eine
    kaputte Datei abfaengt: kein Transkript, nicht eine Datei.

    Auf Windows/Linux ist der Fehler unsichtbar, weil `engine != "whisper.cpp"` das `and`
    kurzschliesst — 482 gruene Tests haben ihn deshalb nicht gesehen. Der Fix pro Datei
    liegt in _transkribiere_datei und wird davon nicht beruehrt."""
    proj = tmp_path / "P"
    (proj / "audio").mkdir(parents=True)
    (proj / "audio" / "a.mp3").write_bytes(b"x")
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))
    from webtool import device as devicemod, whispercpp
    monkeypatch.setattr(devicemod, "asr_engine", lambda m: "whisper.cpp")
    gerufen = []
    monkeypatch.setattr(whispercpp, "transkribiere",
                        lambda *a, **k: (gerufen.append(a), {"text": "hallo", "segments": [],
                                                             "language": "de"})[1])
    transcribe.transcribe_project("P", "large-v3", "de")
    assert len(gerufen) == 1                      # die Datei lief ueber whisper.cpp
    assert (proj / "transkripte" / "a.json").exists()


def test_vorgabeschwelle_laesst_echtes_interview_englisch_durch(monkeypatch):
    """Regressionswaechter fuer den Wert selbst — er stand auf 0.7 und war falsch.

    An echtem Material (12:24-Beitrag, deutscher Sprecherton, englisches Interview bei 4:00)
    erkennt faster-whisper die englische Passage mit p=0.565; deutsche Fenster liegen bei
    0.980-1.000, Stille bei 0.289. Mit 0.7 wurde die Passage zurueckgeklemmt — die Funktion
    versagte an genau dem Video, fuer das sie gebaut wurde. Die Zahl 0.565 stammt aus einer
    Messung, nicht aus einer Schaetzung; ein hoeherer Default macht das Feature wieder kaputt.

    Kalibriert war 0.7 an TTS-Englisch (p=0.938) — sauberer Studioton. Genau diese Luecke
    zwischen synthetischem und echtem Material haelt dieser Test offen.

    `delenv` VOR dem reload, und das ist der Punkt: reload fuehrt die Modulzeile neu aus und
    liest die Umgebungsvariable damit ERNEUT. Ohne das Loeschen prueft der Test, was in der
    Umgebung steht, nicht die ausgelieferte Vorgabe — und die .env des Repos landet ueber
    settings.load_env() in os.environ, sobald irgendein Test webtool.app importiert. Ein
    Entwickler mit TRANSKRIBOR_MIX_SCHWELLE=0.8 saehe einen roten Test, der die Vorgabe
    beschuldigt; mit 0.55 einen gruenen, der nichts beweist."""
    monkeypatch.delenv("TRANSKRIBOR_MIX_SCHWELLE", raising=False)
    importlib.reload(transcribe)
    try:
        assert transcribe.MIX_SCHWELLE <= 0.565     # echtes Interview-Englisch kommt durch
        assert transcribe.MIX_SCHWELLE > 0.289      # Stille wird weiterhin geklemmt
        p = transcribe._Sprachschwelle(_FakeCt2([("en", 0.565)]), "de", transcribe.MIX_SCHWELLE)
        assert _erkannt(p.detect_language(None)) == "en"
    finally:
        # `undo()` VOR dem reload: monkeypatch stellt die Variable erst NACH dem Testkoerper
        # wieder her. Ein reload hier ohne undo laedt das Modul mit noch geloeschter
        # Umgebung — Folgetests saehen dann die Vorgabe statt des Werts, den der Entwickler
        # gesetzt hat. Genau das, was diese Zeile verhindern soll.
        monkeypatch.undo()
        importlib.reload(transcribe)


def test_schwelle_lehnt_nicht_endliche_werte_ab(monkeypatch):
    """`float("nan")` wirft KEIN ValueError, und jeder Vergleich mit nan ist falsch:
    `max(0.0, nan)` liefert 0.0. Ohne die isfinite-Pruefung waere die Klemmung damit still
    ganz abgeschaltet — genau der Zustand, den der Kommentar an der Konstante als Fehler
    beschreibt. Gefunden von CodeRabbit."""
    for wert in ("nan", "inf", "-inf"):
        monkeypatch.setenv("TRANSKRIBOR_MIX_SCHWELLE", wert)
        importlib.reload(transcribe)
        assert transcribe.MIX_SCHWELLE == 0.5, wert
    monkeypatch.undo()
    importlib.reload(transcribe)


def test_schwelle_klemmt_werte_ausserhalb_der_spanne(monkeypatch):
    """Gegenprobe: gueltige, aber unsinnige Zahlen werden geklemmt statt verworfen —
    =2 haette jeden Sprachwechsel abgeschaltet, =-1 die Klemmung."""
    for wert, erwartet in (("2", 1.0), ("-1", 0.0), ("0.42", 0.42)):
        monkeypatch.setenv("TRANSKRIBOR_MIX_SCHWELLE", wert)
        importlib.reload(transcribe)
        assert transcribe.MIX_SCHWELLE == erwartet, wert
    monkeypatch.undo()
    importlib.reload(transcribe)


# --- Abdeckung: uebersprungene Whisper-Fenster (#83) -------------------------
#
# Der Wert dieser Wache liegt an den RAENDERN, und genau die sind ohne echtes Audio pruefbar:
# ein Loch am Anfang (vor dem ersten Segment), eines am Ende (nach dem letzten — dafuer braucht
# es die Audiodauer, sonst ist es unsichtbar) und der Extremfall, dass ueberhaupt nichts kam.

def _seg(start, end):
    return {"start": start, "end": end}


def test_luecke_mitten_im_transkript_wird_gemeldet():
    """Der belegte Fall aus #82: 18 s am Stueck fehlten, ausgerechnet die Antwort auf die
    erste Interviewfrage. Kein Flag, kein auffaelliger avg_logprob — nur die Abdeckung."""
    luecken = transcribe.luecken([_seg(0, 12), _seg(30, 40)], dauer=40)
    assert luecken == [{"start": 12, "end": 30, "dauer": 18}]


def test_kurze_pause_ist_keine_luecke():
    """Die Gegenprobe, ohne die der Hinweis bei jedem Interview stuende: eine Denkpause, ein
    Themenwechsel, das Umsetzen des Mikrofons. Ein Daueralarm ist derselbe Schaden von der
    anderen Seite — er wird weggesehen."""
    assert transcribe.luecken([_seg(0, 12), _seg(26, 40)], dauer=40) == []


def test_luecke_VOR_dem_ersten_segment_wird_gemeldet():
    """Der Anfang zaehlt ab 0, nicht ab dem ersten Segment — sonst waere ausgerechnet der
    belegte Fall (die erste Antwort fehlt) der eine, den die Wache nicht sieht."""
    assert transcribe.luecken([_seg(20, 30)], dauer=30)[0] == {"start": 0.0, "end": 20, "dauer": 20}


def test_luecke_NACH_dem_letzten_segment_braucht_die_dauer():
    """Ohne Audiodauer ist ein uebersprungenes Fenster am Dateiende nicht bemerkbar: das
    Transkript endet einfach frueher, und nichts widerspricht. Deshalb reist `duration` aus
    BEIDEN Engines mit."""
    segs = [_seg(0, 10)]
    assert transcribe.luecken(segs, dauer=60) == [{"start": 10, "end": 60, "dauer": 50}]
    assert transcribe.luecken(segs, dauer=None) == []          # unbekannt -> nicht raten


def test_ganz_ohne_segmente_ist_die_datei_EINE_luecke():
    """Der Extremfall. Whisper liefert eine leere Liste, `text` ist "" — im Editor sieht das
    aus wie eine stille Aufnahme, und ohne diese Zeile behauptet der Lauf 'fertig'."""
    assert transcribe.luecken([], dauer=600) == [{"start": 0.0, "end": 600, "dauer": 600}]


def test_ueberlappende_segmente_erfinden_keine_luecke():
    """`max(stand, ende)` statt `ende`: zieht ein kuerzeres Folgesegment die Marke zurueck,
    meldete ausgerechnet DICHTES Material eine Luecke. Whisper liefert bei Temperatur-
    Rueckfall gelegentlich solche Ueberlappungen."""
    assert transcribe.luecken([_seg(0, 40), _seg(5, 10), _seg(40, 50)], dauer=50) == []


def test_segment_ohne_zeiten_verschiebt_die_marke_nicht():
    """Ein Segment ohne start/end sagt ueber Abdeckung nichts. Es zu ueberspringen ist
    richtig; es als `0` zu lesen zoege die Marke auf den Dateianfang zurueck."""
    assert transcribe.luecken([_seg(0, 10), {"text": "x"}, _seg(12, 20)], dauer=20) == []


def test_roh_json_traegt_die_luecken(tmp_path, monkeypatch):
    """Die Verdrahtung: gerechnet wird an der Stelle, an der beide Engines zusammenlaufen und
    geschrieben wird. Die Attrappe liefert Segmente 0-1 und 1-2 bei `duration` 2.0 — also
    keine Luecke; der Schluessel muss trotzdem dastehen, sonst haengt der Editor an
    `undefined` statt an einer leeren Liste."""
    proj, _ = _lauf_projekt(tmp_path, monkeypatch)
    transcribe.transcribe_project("P", "large-v3", "de")
    roh = json.loads((proj / "transkripte" / "a.json").read_text(encoding="utf-8"))
    assert roh["luecken"] == []
    assert roh["duration"] == 2.0


def test_lauf_meldet_die_luecke_und_die_ECHTE_audiolaenge(tmp_path, monkeypatch, capsys):
    """Zwei Behauptungen in einer Zeile, beide vorher falsch bzw. abwesend: die Meldung nennt
    die Luecke, und `Audio` ist die Laenge der AUFNAHME. Bis eben stand dort das Ende des
    letzten Segments — fehlen die letzten Fenster, meldet genau das die zu kurze Zahl, die den
    Verlust verdeckt."""
    proj, _ = _lauf_projekt(tmp_path, monkeypatch)
    # Die Attrappe transkribiert 2 s; hier steht eine 5 Minuten lange Aufnahme dahinter —
    # also 298 s, zu denen Whisper nichts geliefert hat.
    monkeypatch.setattr(_Info, "duration", 300.0)
    transcribe.transcribe_project("P", "large-v3", "de")
    roh = json.loads((proj / "transkripte" / "a.json").read_text(encoding="utf-8"))
    assert roh["luecken"] == [{"start": 2.0, "end": 300.0, "dauer": 298.0}]
    aus = capsys.readouterr().out
    assert "Abschnitt(e) ohne Transkript" in aus
    assert "Audio 5:00" in aus                    # nicht 0:02 — das war die verdeckende Zahl


def test_unsortierte_segmente_erfinden_keine_luecke():
    """Der Kommentar behauptete das schon, der Code konnte es nicht (CodeRabbit an PR #212).

    Ohne Sortieren laeuft die Marke am ersten Eintrag auf 40 und sieht das spaetere 0-12 nie:
    gemeldet wuerde `0-30 fehlt` statt richtig `12-30`. Ein Waechter gegen stillen Verlust,
    der selbst Falsches meldet, verbraucht genau das Vertrauen, von dem er lebt — und beim
    naechsten echten Fund sieht jemand darueber hinweg."""
    assert transcribe.luecken([_seg(30, 40), _seg(0, 12)], dauer=40) == [
        {"start": 12, "end": 30, "dauer": 18}]


def test_die_grenze_selbst_zaehlt_als_luecke():
    """Grenzen prueft man AUF der Grenze, nicht daneben. `LUECKE_MIN_S` heisst „ab", das Issue
    sagt „ab 15 s" — mit `>` fiele genau dieser Wert heraus (CodeRabbit an PR #212). Beide
    Richtungen, sonst ist es nur die halbe Aussage."""
    grenze = transcribe.LUECKE_MIN_S
    knapp = grenze - 0.1
    # Verglichen wird das GANZE Objekt, nicht nur `dauer`: die Laenge kann stimmen, waehrend
    # die Luecke an der falschen Stelle steht — und die Zeitmarke ist der ganze Nutzen des
    # Hinweises im Editor (CodeRabbit an PR #212).
    # In der Mitte …
    assert transcribe.luecken([_seg(0, 10), _seg(10 + grenze, 40)], dauer=40) == [
        {"start": 10, "end": 10 + grenze, "dauer": grenze}]
    assert transcribe.luecken([_seg(0, 10), _seg(10 + knapp, 40)], dauer=40) == []
    # … und am DATEIENDE, das ist eine eigene Vergleichszeile: die Mutationsprobe fand sie
    # ungedeckt (`>=` dort zurueck auf `>` liess alle Tests gruen).
    assert transcribe.luecken([_seg(0, 10)], dauer=10 + grenze) == [
        {"start": 10, "end": 10 + grenze, "dauer": grenze}]
    assert transcribe.luecken([_seg(0, 10)], dauer=10 + knapp) == []


def test_alle_drei_laeufer_konfigurieren_ihren_stdout_um(monkeypatch):
    """Der Wurf, den es gab: `transcribe.py` war der EINZIGE Laeufer ohne diese Zeilen, und
    seine Phasenzeile traegt U+23F1. Bei umgeleitetem stdout auf Windows ist
    `sys.stdout.encoding` die ANSI-Codepage (gemessen: cp1252) — der Lauf schrieb alle
    Transkripte, warf dann `UnicodeEncodeError` und endete mit Exit 1. Wer den Exitcode
    auswertet, haelt einen fertigen Lauf fuer gescheitert.

    Geprueft werden ALLE DREI, nicht nur der reparierte: die Fehlerklasse ist „ein Laeufer
    ohne reconfigure", und die beiden Zwillinge hatten dafuer ebenfalls keinen Test.

    Gefahren wird mit einem ungueltigen Argument: argparse wirft dann `SystemExit`, und weil
    `reconfigure` VOR dem Parsen steht, ist es zu dem Zeitpunkt bereits gelaufen. Damit misst
    der Test zugleich die REIHENFOLGE — dahinter gesetzt liefe die Umkonfiguration bei jedem
    Fehlaufruf zu spaet.

    **Nicht mit einer Attrappe auf `sys.stdout.reconfigure`**: das echte `sys.stdout` von
    pytest ist ein `EncodedFile` ohne diese Methode, der `except AttributeError`-Zweig
    verschluckte den Aufruf also still. Deshalb ein eigenes Objekt.
    """
    import importlib

    class Merker:
        def __init__(self): self.aufrufe = []
        def reconfigure(self, **kw): self.aufrufe.append(kw)
        def write(self, *a): pass
        def flush(self): pass

    for modul, argv in (("transcribe", ["x", "--gibt-es-nicht"]),
                        ("webtool.correct", ["x", "--gibt-es-nicht"]),
                        ("webtool.fetch", ["x", "--gibt-es-nicht"])):
        m = importlib.import_module(modul)
        merker = Merker()
        monkeypatch.setattr(m.sys, "stdout", merker)
        monkeypatch.setattr(m.sys, "argv", argv)
        with pytest.raises(SystemExit):
            m.main()
        assert merker.aufrufe, f"{modul}.main() konfiguriert sys.stdout nicht um"
        assert merker.aufrufe[0]["encoding"] == "utf-8", modul

        # Dieselbe Frage fuer die Huelle aus #344 (EIN write je Zeile): auch sie ist eine
        # Zeile, die in EINEM der drei Laeufer fehlen kann, ohne dass sonst etwas auffaellt
        # — dieselbe Fehlerklasse, deretwegen dieser Test alle drei prueft. Abgegriffen
        # wird INNERHALB des Laufs; `monkeypatch` stellt danach das alte Objekt zurueck.
        from webtool import druck
        assert isinstance(m.sys.stdout, druck.Zeilenweise), (
            f"{modul}.main() legt die Zeilen-Huelle nicht um sys.stdout (#344)")
        # ... und zwar um GENAU diesen Strom. Ohne die zweite Zusicherung waere ein
        # `sys.stdout = druck.zeilenweise(irgendwas)` gruen.
        assert m.sys.stdout.__dict__["_strom"] is merker, modul


def test_transcribe_project_meldet_active_done_und_ueberspringt_geloeschtes_audio(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    proj_dir = tmp_path / "Demo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    f1 = audio_dir / "S1.mp3"
    f1.write_bytes(b"audio1")
    f2 = audio_dir / "S2.mp3"
    f2.write_bytes(b"audio2")

    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    
    # S2 vor der Transkription loeschen, um Loeschung waehrend Batch zu simulieren
    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        if "S1" in audio_file and f2.exists():
            f2.unlink()
        return {"text": "Hallo", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "Hallo"}], "duration": 1.0}

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)

    transcribe.transcribe_project("Demo", "tiny", "de")
    out = capsys.readouterr().out
    assert "[scope] S1\tS2" in out
    assert "[active] S1" in out
    assert "[done] S1" in out
    assert "skip (Audio nicht mehr vorhanden): S2" in out
    assert (proj_dir / "transkripte" / "S1.json").exists()
    assert not (proj_dir / "transkripte" / "S2.json").exists()


@pytest.mark.parametrize("roh_da,erwartet_scope,erwartet_gesehen,erwartet_ki", [
    # POSITIVKONTROLLE: ohne fremde Roh-JSON nimmt der Lauf `b` sehr wohl mit — der Sensor
    # sieht die zweite Aufnahme also, und der Nullbefund darunter ist etwas wert.
    (False, ["a", "b"], ["a.mp3", "b.mp3"], ["a", "b"]),
    # Die eigentliche Zusicherung: `b.json` liegt schon da (ein `correct run` haette es also
    # in seinem Bereich) — `b` bleibt vollstaendig draussen.
    (True, ["a"], ["a.mp3"], ["a"]),
])
def test_transcribe_project_nimmt_keine_base_mit_vorhandener_roh_json(
        tmp_path, monkeypatch, capsys, roh_da, erwartet_scope, erwartet_gesehen, erwartet_ki):
    """Die andere Haelfte der Disjunktheit zu `correct.cmd_run` (#496).

    `cmd_run` fixiert seinen Bereich beim Start auf die Basen MIT Roh-JSON (Zwilling:
    `test_correct.py`, `test_cmd_run_fixiert_seinen_bereich_beim_start`). Damit die beiden
    Laeufe eines Projekts sich nie dieselbe Aufnahme teilen, muss `transcribe_project` die
    Gegenrichtung halten: keine Base MIT Roh-JSON — weder transkribieren noch korrigieren.

    Geprueft werden deshalb DREI Stellen, denn jede fuer sich koennte fallen:
      * `[scope]` (`transcribe.py`, `offen_paare`) — was der Lauf als Bereich MELDET; danach
        gibt `jobs.py` alle uebrigen Aufnahmen zum Loeschen/Umbenennen frei (#80).
      * `gesehen` (der `pending`-Filter der Runde) — was er wirklich ANFASST. Faellt nur
        dieser, ueberschreibt der Lauf eine fremde Roh-JSON, waehrend `[scope]` noch schweigt.
      * die KI-Uebergabe (`ai_pool.submit(correct_ai_single, …)`) — der Pool bekommt nur, was
        DIESE Schleife frisch transkribiert hat. Ein spaeterer „am Ende alles korrigieren"-Pass
        liesse die beiden oberen gruen und kollidierte trotzdem mit `cmd_run`.
    Dazu die Unversehrtheit der fremden Datei: sie ist der Schaden, um den es in #496 geht.

    `transcribe_project` scannt in JEDER Runde neu (anders als `cmd_run`) — die Disjunktheit
    haengt auf dieser Seite also allein an diesem Filter.
    """
    from webtool import correct as _c
    from webtool import llm
    proj, gesehen = _lauf_projekt(tmp_path, monkeypatch)
    tdir = proj / "transkripte"
    tdir.mkdir(parents=True, exist_ok=True)
    fremd = {"language": "de", "segments": [], "text": "fremde Roh-JSON"}
    if roh_da:
        (tdir / "b.json").write_text(json.dumps(fremd), encoding="utf-8")
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "0")     # hermetisch: kein echtes pyannote
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    ki = []
    monkeypatch.setattr(_c, "prep_single", lambda p, b: True)
    monkeypatch.setattr(_c, "correct_ai_single", lambda p, b, **kw: (ki.append(b), True)[1])

    transcribe.transcribe_project("P", "large-v3", "de", autocorrect=True)

    aus = capsys.readouterr().out
    if roh_da:
        # ZUERST, nicht zuletzt. Das ist der SCHADEN aus #496 — eine fremde Roh-JSON wird
        # ueberschrieben —, und `gesehen` darunter ist nur sein Symptom. Als LETZTE der vier
        # Zusicherungen war die Zeile unerreichbar: wer `b` ueberschreibt, muss `b`
        # transkribieren, und dann faellt `gesehen` vorher. Sie benennt jetzt beim
        # Fehlschlag die Sache statt des Anzeichens.
        assert json.loads((tdir / "b.json").read_text(encoding="utf-8")) == fremd
    assert [z for z in aus.splitlines() if z.startswith("[scope] ")] == \
        ["[scope] " + "\t".join(erwartet_scope)]
    assert gesehen == erwartet_gesehen
    assert sorted(ki) == erwartet_ki                   # Poolreihenfolge ist nicht zugesichert


def test_transcribe_project_autocorrect_streaming_pipeline(monkeypatch, tmp_path, capsys):
    """Verifiziert die End-to-End Streaming-Pipeline in transcribe_project(autocorrect=True):
    - Whisper und Diarisierung laufen sequenziell (max_hw == 1).
    - Sobald eine Datei lokal fertig ist, startet ihr KI-Call sofort parallel zu nachfolgenden Dateien."""
    import threading
    import time
    from webtool import correct, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 4)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "Demo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    tdir = proj_dir / "transkripte"
    tdir.mkdir(parents=True)

    for b in ("S1", "S2"):
        (audio_dir / f"{b}.mp3").write_bytes(b"audio")

    hw_active = 0
    hw_max = 0
    hw_lock = threading.Lock()

    ki_trafen = threading.Barrier(2, timeout=2)
    ki_getroffen = threading.Event()

    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        nonlocal hw_active, hw_max
        with hw_lock:
            hw_active += 1
            if hw_active > hw_max:
                hw_max = hw_active
        time.sleep(0.05)
        with hw_lock:
            hw_active -= 1
        return {"text": "Hallo", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "Hallo"}], "duration": 1.0}

    def fake_diarize(project, only_bases=None):
        nonlocal hw_active, hw_max
        with hw_lock:
            hw_active += 1
            if hw_active > hw_max:
                hw_max = hw_active
        time.sleep(0.03)
        with hw_lock:
            hw_active -= 1
        return 1

    def fake_correct_ai_single(project, b, **kw):
        # #461: Überlappung ERZWUNGEN statt per Schlafzeiten erhofft. Das alte Fenster
        # war 20 ms breit (KI 0,10 s gegen Hardware 0,08 s je Datei) und kippte auf
        # ausgelasteten Läufern, obwohl die Zusicherung stimmte — CI 33175210498,
        # 1 failed/1075 passed, ubuntu-Bein grün, Re-Run grün. BrokenBarrierError
        # (Dritter/Durchhänger) ist geschluckt: das Urteil trägt ki_getroffen.
        try:
            ki_trafen.wait()
            ki_getroffen.set()
        except threading.BrokenBarrierError:
            pass
        (tdir / f"{b}.edit.json").write_text(json.dumps({"segments": [{"id": 0, "text": "Korrigiert"}]}), encoding="utf-8")
        return True

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)
    monkeypatch.setattr(correct, "cmd_diarize", fake_diarize)
    monkeypatch.setattr(correct, "correct_ai_single", fake_correct_ai_single)

    transcribe.transcribe_project("Demo", "tiny", "de", autocorrect=True)
    out = capsys.readouterr().out
    assert "[scope] S1\tS2" in out
    assert "[active] S1" in out
    assert "[done] S1" in out
    assert "[active] S2" in out
    assert "[done] S2" in out

    assert (tdir / "S1.json").exists()
    assert (tdir / "S2.json").exists()
    assert (tdir / "S1.edit.json").exists()
    assert (tdir / "S2.edit.json").exists()

    # Hardware war streng serialisiert (Whisper + Diarisierung sequenziell)
    assert hw_max == 1
    # Cloud-KI lief überlappend/parallel — ERZWUNGEN per Barrier, nicht erhofft (#461)
    assert ki_getroffen.is_set(), "die KI-Phasen beider Dateien muessen sich ueberlappen"


def test_transcribe_project_staggered_order_exact_sequence(monkeypatch, tmp_path):
    """Prüft die exakte chronologische Überlappung:
    Datei 1 wird transkribiert -> diarisiert -> KI übergeben.
    Datei 2 wird transkribiert & diarisiert WÄHREND Datei 1 noch in der KI-Korrektur rechnet."""
    import time
    from webtool import correct, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 4)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "StaggerDemo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    tdir = proj_dir / "transkripte"
    tdir.mkdir(parents=True)

    for b in ("D1", "D2"):
        (audio_dir / f"{b}.mp3").write_bytes(b"audio")

    events = []

    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        base = os.path.splitext(os.path.basename(audio_file))[0]
        events.append(f"start_transcribe_{base}")
        time.sleep(0.04)
        events.append(f"end_transcribe_{base}")
        return {"text": "Text", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "Text"}], "duration": 1.0}

    def fake_diarize(project, only_bases=None):
        base = only_bases[0] if only_bases else "all"
        events.append(f"start_diarize_{base}")
        time.sleep(0.04)
        events.append(f"end_diarize_{base}")
        return 1

    def fake_correct_ai_single(project, b, **kw):
        events.append(f"start_ai_{b}")
        # KI braucht länger (120ms), sodass D2 während D1-KI transkribiert und diarisiert wird
        time.sleep(0.12)
        events.append(f"end_ai_{b}")
        return True

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)
    monkeypatch.setattr(correct, "cmd_diarize", fake_diarize)
    monkeypatch.setattr(correct, "correct_ai_single", fake_correct_ai_single)

    transcribe.transcribe_project("StaggerDemo", "tiny", "de", autocorrect=True)

    # Prüfen, dass start_transcribe_D2 und start_diarize_D2 VOR end_ai_D1 stattfinden!
    idx_end_ai_d1 = events.index("end_ai_D1")
    idx_start_transcribe_d2 = events.index("start_transcribe_D2")
    idx_start_diarize_d2 = events.index("start_diarize_D2")

    assert idx_start_transcribe_d2 < idx_end_ai_d1, "Transkription D2 muss starten, bevor KI D1 fertig ist"
    assert idx_start_diarize_d2 < idx_end_ai_d1, "Diarisierung D2 muss starten, bevor KI D1 fertig ist"

    # Reihenfolge pro Datei strikt: Transcribe D1 -> Diarize D1 -> AI D1
    assert events.index("end_transcribe_D1") < events.index("start_diarize_D1")
    assert events.index("end_diarize_D1") < events.index("start_ai_D1")
    # Und D2 erst nach Diarize D1:
    assert events.index("end_diarize_D1") < events.index("start_transcribe_D2")


def test_transcribe_project_dynamically_picks_up_new_uploads(monkeypatch, tmp_path):
    """Simuliert den Fall, dass während der Transkription von D1 eine neue Datei D2 hochgeladen wird."""
    import time
    from webtool import correct, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 4)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "DynamicDemo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    tdir = proj_dir / "transkripte"
    tdir.mkdir(parents=True)

    # Initial nur D1 vorhanden
    (audio_dir / "D1.mp3").write_bytes(b"audio")

    processed = []

    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        base = os.path.splitext(os.path.basename(audio_file))[0]
        processed.append(base)
        if base == "D1":
            # Während D1 transkribiert wird, trifft D2 ein (z.B. zweiter File-Upload)
            (audio_dir / "D2.mp3").write_bytes(b"audio")
        return {"text": f"Text {base}", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": f"Text {base}"}], "duration": 1.0}

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)
    monkeypatch.setattr(correct, "cmd_diarize", lambda *a, **kw: 1)
    monkeypatch.setattr(correct, "correct_ai_single", lambda *a, **kw: True)

    transcribe.transcribe_project("DynamicDemo", "tiny", "de", autocorrect=True)

    assert "D1" in processed
    assert "D2" in processed, "D2 wurde während des Laufs hochgeladen und muss dynamisch mitverarbeitet werden"
    assert (tdir / "D1.json").exists()
    assert (tdir / "D2.json").exists()


def test_transcribe_project_meldet_spaete_uploads_als_bereichs_nachtrag(monkeypatch, tmp_path, capsys):
    """Der Lauf traegt nach, was er ZUSAETZLICH anfassen wird (`[scope+]`).

    `[scope]` wird EINMAL gedruckt, bevor die Schleife das erste Mal `find_audio` ruft —
    D2 existiert da noch nicht. Verarbeitet wird sie trotzdem (der Test darueber misst genau
    das). Fuer die Oberflaeche war sie damit weder im Bereich noch (bis zu ihrem ersten
    `[active]`) gesehen und stand auf „Nur Audio — noch nicht transkribiert", waehrend der
    Lauf sie sicher noch verarbeitet.

    Zwei Haelften, und die zweite ist die wichtigere: der Nachtrag nennt NUR die neue Datei.
    Wuerde er in jeder Runde den ganzen offenen Rest melden, haenge der Druck des Laufs an
    seiner Rundenzahl statt an dem, was wirklich dazukam.

    Deshalb kommen ZWEI Dateien spaet dazu und nicht eine — Befund des CodeRabbit-Bots, und
    er trifft: mit nur D2 faellt „alle offenen melden" mit „nur die neuen melden" zusammen,
    sobald D1 durch ist (offen ist dann genau D2). Der Waechter war damit auf ein Zufallsdetail
    angewiesen. Mit D2 UND D3 meldet die kaputte Fassung D3 in der dritten Runde ein zweites
    Mal — das sieht der Test.
    """
    from webtool import correct, jobs, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 4)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "NachtragDemo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    (proj_dir / "transkripte").mkdir(parents=True)
    (audio_dir / "D1.mp3").write_bytes(b"audio")

    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        base = os.path.splitext(os.path.basename(audio_file))[0]
        if base == "D1":
            (audio_dir / "D2.mp3").write_bytes(b"audio")
            (audio_dir / "D3.mp3").write_bytes(b"audio")
        return {"text": f"Text {base}",
                "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": f"Text {base}"}],
                "duration": 1.0}

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)
    monkeypatch.setattr(correct, "cmd_diarize", lambda *a, **kw: 1)
    monkeypatch.setattr(correct, "correct_ai_single", lambda *a, **kw: True)

    transcribe.transcribe_project("NachtragDemo", "tiny", "de", autocorrect=True)

    zeilen = capsys.readouterr().out.splitlines()
    erst = [z for z in zeilen if z.startswith(jobs.SCOPE_PREFIX)]
    nach = [z for z in zeilen if z.startswith(jobs.SCOPE_ADD_PREFIX)]
    assert len(erst) == 1 and erst[0][len(jobs.SCOPE_PREFIX):].split("\t") == ["D1"]
    assert len(nach) == 1, \
        f"genau EIN Nachtrag erwartet — ein zweiter hiesse, D3 wurde doppelt gemeldet: {nach}"
    assert nach[0][len(jobs.SCOPE_ADD_PREFIX):].split("\t") == ["D2", "D3"], \
        "nur die NEUEN Aufnahmen, sortiert — D1 wurde bereits gemeldet"


def test_transcribe_project_meldet_eine_zurueckgekehrte_aufnahme_erneut(monkeypatch, tmp_path, capsys):
    """Die Merkliste des Nachtrags muss vergessen, was der LESER vergessen hat.

    Befund des kalten Diff-Lesers. `jobs.remove_base` nimmt eine geloeschte Aufnahme aus
    `bases`, und Loeschen ist waehrend des Laufs erlaubt, solange gerade nicht an ihr
    gerechnet wird. Legt jemand danach eine Datei DESSELBEN Namens neu an, verarbeitet die
    Schleife sie wieder — ohne diesen Fix unterdrueckte `angekuendigt` aber die zweite
    Meldung, und nichts truege sie in `bases` zurueck. `betrifft()` saehe sie als frei,
    waehrend der Lauf sie schreibt; die README-Zusage (409 beim Umbenennen und
    Neu-Transkribieren) haelt auf diesem Pfad dann nicht.

    Der Ablauf legt den Austausch bewusst in EINE Runde — der schwere Fall, den eine
    Anwesenheits-Pruefung nicht sehen kann (die Schleife steckt dann in Whisper und die
    Luecke existiert fuer sie nie). Verglichen wird deshalb die IDENTITAET (`_kennung`):
      Runde 1: D1  (legt D2, D3, D4 an)              -> `[scope+] D2 D3 D4`
      Runde 2: D2  (loescht D3 UND legt es neu an)   -> Identitaet von D3 wechselt
      Runde 3: D3                                    -> `[scope+] D3`
      Runde 4: D4                                    -> nichts (unveraendert)
    """
    from webtool import correct, jobs, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 4)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "RueckkehrDemo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    (proj_dir / "transkripte").mkdir(parents=True)
    (audio_dir / "D1.mp3").write_bytes(b"audio")

    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        base = os.path.splitext(os.path.basename(audio_file))[0]
        if base == "D1":
            for n in ("D2", "D3", "D4"):
                (audio_dir / f"{n}.mp3").write_bytes(b"audio")
        elif base == "D2":
            # Geloescht waehrend sie wartet UND unter demselben Namen neu hochgeladen —
            # beides in derselben Runde, die Schleife sieht die Luecke also nie. Die neue
            # Datei ist ANDERS LANG, damit sich die Kennung deterministisch unterscheidet
            # (keine Annahme ueber Inode-Wiederverwendung oder mtime-Aufloesung).
            (audio_dir / "D3.mp3").unlink()
            (audio_dir / "D3.mp3").write_bytes(b"anderes, laengeres audio")
        return {"text": f"Text {base}",
                "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": f"Text {base}"}],
                "duration": 1.0}

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)
    monkeypatch.setattr(correct, "cmd_diarize", lambda *a, **kw: 1)
    monkeypatch.setattr(correct, "correct_ai_single", lambda *a, **kw: True)

    transcribe.transcribe_project("RueckkehrDemo", "tiny", "de", autocorrect=True)

    nach = [z[len(jobs.SCOPE_ADD_PREFIX):].split("\t")
            for z in capsys.readouterr().out.splitlines()
            if z.startswith(jobs.SCOPE_ADD_PREFIX)]
    assert (proj_dir / "transkripte" / "D3.json").exists(), \
        "Vorbedingung: der Lauf hat die zurueckgekehrte Aufnahme wirklich verarbeitet"
    assert nach == [["D2", "D3", "D4"], ["D3"]], \
        f"die Rueckkehr muss erneut gemeldet werden, sonst fehlt sie im Bereich: {nach}"


def test_kennung_unterscheidet_austausch_und_schweigt_bei_fehlern(tmp_path):
    """`_kennung` direkt — der Test daneben faelscht die Funktion ganz und uebt ihren
    `except OSError`-Pfad deshalb NICHT aus (CodeRabbit-Bot). Beide Richtungen:

    - dieselbe Datei ergibt denselben Wert (sonst meldete jede Runde einen Nachtrag),
    - eine unter demselben Namen NEU angelegte Datei einen anderen (das ist der Zweck),
    - und ein fehlender Pfad wirft nicht, sondern liefert `None` — die Funktion laeuft im
      Schleifenrumpf eines Laufs, ein Wurf risse ihn ab.
    """
    p = tmp_path / "A.mp3"
    p.write_bytes(b"eins")
    erst = transcribe._kennung(str(p))
    assert erst is not None and transcribe._kennung(str(p)) == erst, "stabil bei gleicher Datei"

    # Die neue Datei ist ANDERS LANG — damit unterscheidet sich die Kennung deterministisch,
    # ohne Annahme ueber Inode-Wiederverwendung oder mtime-Aufloesung. Ein `time.sleep()` stand
    # hier zuerst mit dem Kommentar „damit st_mtime_ns sicher wechselt": das ist eine
    # Behauptung ueber das Dateisystem, keine Messung (Vorab-Check des Bots) — auf einer
    # Ablage mit grober Zeitaufloesung waere der Test damit flatterhaft geworden. In der
    # Wirklichkeit tragen Inode und Zeit die Unterscheidung, hier traegt sie die Groesse.
    p.unlink()
    p.write_bytes(b"zwei und laenger")
    assert transcribe._kennung(str(p)) != erst, "ausgetauscht heisst andere Kennung"

    assert transcribe._kennung(str(tmp_path / "gibtsnicht.mp3")) is None, "wirft nicht"


def test_transcribe_project_meldet_auch_bei_unlesbarer_kennung(monkeypatch, tmp_path, capsys):
    """`_kennung` liefert `None`, wenn `os.stat` wirft — und „nie gemeldet" darf davon nicht
    ununterscheidbar werden.

    Ohne den eigenen Platzhalter (`angekuendigt.get(b)` statt `get(b, _UNBEKANNT)`) waere der
    Vergleich `None != None` falsch, und eine NIE gemeldete Aufnahme mit unlesbarer Datei
    bekaeme gar keine Meldung — sie fehlte im Bereich, obwohl der Lauf sie anfasst. Die
    Mutationsprobe fand genau diese Zeile zuerst unbewacht.
    """
    from webtool import correct, jobs, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(transcribe, "_kennung", lambda _p: None)   # jede Kennung unlesbar
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 4)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "UnlesbarDemo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    (proj_dir / "transkripte").mkdir(parents=True)
    (audio_dir / "D1.mp3").write_bytes(b"audio")

    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        base = os.path.splitext(os.path.basename(audio_file))[0]
        if base == "D1":
            (audio_dir / "D2.mp3").write_bytes(b"audio")
        return {"text": f"Text {base}",
                "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": f"Text {base}"}],
                "duration": 1.0}

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)
    monkeypatch.setattr(correct, "cmd_diarize", lambda *a, **kw: 1)
    monkeypatch.setattr(correct, "correct_ai_single", lambda *a, **kw: True)

    transcribe.transcribe_project("UnlesbarDemo", "tiny", "de", autocorrect=True)

    nach = [z[len(jobs.SCOPE_ADD_PREFIX):].split("\t")
            for z in capsys.readouterr().out.splitlines()
            if z.startswith(jobs.SCOPE_ADD_PREFIX)]
    assert (proj_dir / "transkripte" / "D2.json").exists(), "Vorbedingung: D2 wurde verarbeitet"
    assert ["D2"] in nach, \
        f"eine nie gemeldete Aufnahme muss auch mit unlesbarer Kennung gemeldet werden: {nach}"


def test_transcribe_project_diarize_error_does_not_block_next_file(monkeypatch, tmp_path, capsys):
    """Wenn bei D1 die Diarisierung fehlschlägt, muss D2 trotzdem transkribiert und diarisiert werden."""
    from webtool import correct, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 4)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "ErrDemo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    tdir = proj_dir / "transkripte"
    tdir.mkdir(parents=True)

    for b in ("D1", "D2"):
        (audio_dir / f"{b}.mp3").write_bytes(b"audio")

    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        base = os.path.splitext(os.path.basename(audio_file))[0]
        return {"text": f"Text {base}", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": f"Text {base}"}], "duration": 1.0}

    def fake_diarize(project, only_bases=None):
        base = only_bases[0] if only_bases else "all"
        if base == "D1":
            raise RuntimeError("GPU out of memory in diarize D1")
        return 1

    corrected = []

    def fake_correct_ai_single(project, b, **kw):
        corrected.append(b)
        return True

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)
    monkeypatch.setattr(correct, "cmd_diarize", fake_diarize)
    monkeypatch.setattr(correct, "correct_ai_single", fake_correct_ai_single)

    transcribe.transcribe_project("ErrDemo", "tiny", "de", autocorrect=True)
    out = capsys.readouterr().out

    assert "Autocorrect-Fehler bei D1: GPU out of memory" in out
    assert (tdir / "D1.json").exists()
    assert (tdir / "D2.json").exists()
    assert "D2" in corrected


def test_transcribe_project_diarize_runs_even_if_ai_unavailable(monkeypatch, tmp_path, capsys):
    """Wenn KI nicht erreichbar ist (z.B. Offline / kein API-Key), soll Diarisierung auf der GPU trotzdem pro Datei laufen."""
    from webtool import correct, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda: (False, "kein KI-Anbieter konfiguriert"))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 4)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "OfflineDemo"
    audio_dir = proj_dir / "audio"
    audio_dir.mkdir(parents=True)
    tdir = proj_dir / "transkripte"
    tdir.mkdir(parents=True)

    for b in ("D1", "D2"):
        (audio_dir / f"{b}.mp3").write_bytes(b"audio")

    diarized = []

    def fake_transkribiere(_m, _engine, audio_file, _sprache, _mehr, _model):
        base = os.path.splitext(os.path.basename(audio_file))[0]
        return {"text": f"Text {base}", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": f"Text {base}"}], "duration": 1.0}

    def fake_diarize(project, only_bases=None):
        base = only_bases[0] if only_bases else "all"
        diarized.append(base)
        return 1

    monkeypatch.setattr(transcribe, "_transkribiere_datei", fake_transkribiere)
    monkeypatch.setattr(correct, "cmd_diarize", fake_diarize)

    transcribe.transcribe_project("OfflineDemo", "tiny", "de", autocorrect=True)
    out = capsys.readouterr().out

    assert diarized == ["D1", "D2"]
    # #406: der Ausfall der KI-Phase war STILL. Die Diarisierung laeuft weiter (ihr Sidecar
    # spart dem spaeteren `correct run` die GPU-Minuten), aber der Grund gehoert ins Protokoll.
    assert "[autocorrect] KI-Phase uebersprungen — kein KI-Anbieter konfiguriert" in out
    assert (tdir / "D1.json").exists()
    assert (tdir / "D2.json").exists()






def test_autocorrect_faellt_bei_kill_switch_ganz_aus(monkeypatch, tmp_path, capsys):
    """#406: `TRANSKRIBOR_AUTOCORRECT=0` war auf dem Live-Weg wirkungslos.

    Bis v0.48.0 las den Schalter `app._autocorrect`; die gestaffelte Pipeline haengt die
    Korrektur seitdem direkt hier an und fragte ihn nirgends mehr — `_autocorrect` hatte
    danach keinen einzigen Aufrufer. Geprueft wird die GANZE Kette, nicht nur der LLM-Aufruf:
    `cmd_diarize` kostet pyannote-Minuten auf der GPU, und wer den Schalter setzt, um die
    Maschine ohne KI zu fahren, will genau die nicht.

    `llm.available` steht bewusst auf TRUE — sonst wuerde der Anbieter-Riegel die Kette
    anhalten und der Test bliebe gruen, ohne den Schalter je zu beruehren.
    """
    from webtool import correct, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", "0")
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda *_a: (True, ""))
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)

    proj_dir = tmp_path / "AusDemo"
    (proj_dir / "audio").mkdir(parents=True)
    tdir = proj_dir / "transkripte"
    tdir.mkdir(parents=True)
    (proj_dir / "audio" / "K1.mp3").write_bytes(b"audio")

    angefasst = []
    monkeypatch.setattr(transcribe, "_transkribiere_datei", lambda *a: {
        "text": "Text", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "Text"}], "duration": 1.0})
    monkeypatch.setattr(correct, "cmd_diarize", lambda *a, **k: angefasst.append("diarize"))
    monkeypatch.setattr(correct, "prep_single", lambda *a, **k: angefasst.append("prep") or True)
    monkeypatch.setattr(correct, "correct_ai_single", lambda *a, **k: angefasst.append("ki"))

    transcribe.transcribe_project("AusDemo", "tiny", "de", autocorrect=True)
    out = capsys.readouterr().out

    assert angefasst == [], f"Kill-Switch gesetzt, trotzdem gelaufen: {angefasst}"
    assert "[autocorrect] uebersprungen — TRANSKRIBOR_AUTOCORRECT=0" in out
    # Gegenkontrolle: der Schalter stoppt die KORREKTUR, nicht die Transkription.
    assert (tdir / "K1.json").exists()


@pytest.mark.parametrize("wert,an", [
    (None, True), ("", True), ("1", True), ("ja", True),
    ("0", False), ("false", False), ("FALSE", False), ("no", False),
])
def test_autocorrect_an_kennt_alle_dokumentierten_schreibweisen(monkeypatch, wert, an):
    """Der Schalter hat vier Aus-Schreibweisen, nicht eine — `0`/`false`/`no`, Gross egal.

    Der Verhaltenstest oben faehrt nur `0` durch. Eine Vereinfachung auf `== "0"` bliebe
    dort gruen und liesse `TRANSKRIBOR_AUTOCORRECT=false` still wirkungslos werden — genau
    die Klasse Fehler, aus der #406 entstand.
    """
    if wert is None:
        monkeypatch.delenv("TRANSKRIBOR_AUTOCORRECT", raising=False)
    else:
        monkeypatch.setenv("TRANSKRIBOR_AUTOCORRECT", wert)
    assert transcribe._autocorrect_an() is an


def test_autocorrect_grund_bleibt_auf_einer_zeile(monkeypatch, tmp_path, capsys):
    r"""Der Grund im `[autocorrect]`-Protokoll ist FREMDTEXT — eine Anbietermeldung.

    Gedeckt ist GENAU EINE Klasse: ein Zeilenumbruch darin machte aus einer Zeile zwei, und
    die zweite begaenne mit fremdem Inhalt am Zeilenanfang — sie koennte also jedes der
    `^`-verankerten Muster in `jobPhases.ts` bedienen. Nach dem Falten gibt es keine zweite
    Zeile mehr.

    Die EINZEILIGE Variante derselben Nutzlast deckt dieser Test nicht — sie wird im Parser
    abgewehrt (`^\[[^\]]+\] ` in `jobPhases.ts`, eigener Test dort). Die Nutzlast traegt
    hier trotzdem die ECHTE gefaehrliche Form statt einer harmlosen Marke, damit beide
    Schichten an derselben Zeichenkette gemessen werden.
    """
    from webtool import correct, llm

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available",
                        lambda *_a: (False,
                                     "kein Anbieter" + chr(10) + "] fertig D1: x"))
    monkeypatch.setattr(correct, "diarize_enabled", lambda: False)
    monkeypatch.setattr(correct, "cmd_diarize", lambda *a, **k: 0)
    monkeypatch.setattr(correct, "prep_single", lambda *a, **k: True)

    proj_dir = tmp_path / "InjektDemo"
    (proj_dir / "audio").mkdir(parents=True)
    (proj_dir / "transkripte").mkdir(parents=True)
    (proj_dir / "audio" / "I1.mp3").write_bytes(b"audio")
    monkeypatch.setattr(transcribe, "_transkribiere_datei", lambda *a: {
        "text": "T", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "T"}], "duration": 1.0})

    transcribe.transcribe_project("InjektDemo", "tiny", "de", autocorrect=True)
    zeilen = capsys.readouterr().out.splitlines()

    assert "] fertig D1: x" not in zeilen, "Fremdtext hat eine eigene Zeile bekommen"
    # Verschluckt wird der Grund NICHT — er steht vollstaendig auf EINER Zeile.
    assert "[autocorrect] KI-Phase uebersprungen — kein Anbieter ] fertig D1: x" in zeilen


def test_autocorrect_ausnahmetext_bleibt_auf_einer_zeile(monkeypatch, tmp_path, capsys):
    """Der Zwilling des Tests darueber — fuer den `except`-Zweig.

    Es braucht ihn, weil die Mutationsprobe es gezeigt hat: `{ex}` ungefiltert zu drucken
    liess den Grund-Test GRUEN. Zwei Interpolationen, zwei Wege, zwei Sensoren — und der
    zweite ist der gefaehrlichere: ein Ausnahmetext ist unbegrenzt, waehrend die fuenf
    Gruende aus `llm.available()` einzeilige Literale sind. Gedeckt und NICHT gedeckt genau
    wie im Test darueber.
    """
    from webtool import correct, llm

    def platzt(*_a):
        raise RuntimeError("Paket kaputt" + chr(10) + "] fertig W1: x")

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", platzt)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: False)
    monkeypatch.setattr(correct, "cmd_diarize", lambda *a, **k: 0)
    monkeypatch.setattr(correct, "prep_single", lambda *a, **k: True)

    proj_dir = tmp_path / "WurfDemo"
    (proj_dir / "audio").mkdir(parents=True)
    (proj_dir / "transkripte").mkdir(parents=True)
    (proj_dir / "audio" / "W1.mp3").write_bytes(b"audio")
    monkeypatch.setattr(transcribe, "_transkribiere_datei", lambda *a: {
        "text": "T", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "T"}], "duration": 1.0})

    transcribe.transcribe_project("WurfDemo", "tiny", "de", autocorrect=True)
    zeilen = capsys.readouterr().out.splitlines()

    assert "] fertig W1: x" not in zeilen, "Ausnahmetext hat eine eigene Zeile bekommen"
    assert "[autocorrect] KI-Phase uebersprungen — Paket kaputt ] fertig W1: x" in zeilen
    # Und der Wurf bleibt ein Wurf: die Transkription selbst laeuft weiter.
    assert (proj_dir / "transkripte" / "W1.json").exists()


def test_autocorrect_fehler_je_datei_bleibt_auf_einer_zeile(monkeypatch, tmp_path, capsys):
    """Der dritte Fremdtext-Weg — und der einzige, der einen ANGREIFER hat.

    `{ex}` an den beiden Stellen oben entsteht am Laufstart aus Import- und
    Verfuegbarkeitsfehlern, bevor irgendein Transkript gelesen ist. Hier nicht: `cmd_diarize`
    und `prep_single` LESEN Transkriptdateien, und die koennen aus einem URL-Import stammen.
    Ein UnicodeDecodeError oder KeyError traegt dann Inhaltsfragmente — samt Umbruechen.

    Die Mutationsprobe hat den Test erzwungen: `{ex}` hier ungefiltert zu drucken liess die
    beiden Tests darueber GRUEN. Dritte Interpolation, dritter Sensor.
    """
    from webtool import correct, llm

    def platzt(*_a, **_k):
        raise RuntimeError("Transkript kaputt" + chr(10) + "] fertig Z1: x")

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(llm, "available", lambda *_a: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 1)
    monkeypatch.setattr(correct, "diarize_enabled", lambda: True)
    monkeypatch.setattr(correct, "cmd_diarize", platzt)
    monkeypatch.setattr(correct, "prep_single", lambda *a, **k: True)
    monkeypatch.setattr(correct, "correct_ai_single", lambda *a, **k: True)

    proj_dir = tmp_path / "PlatzDemo"
    (proj_dir / "audio").mkdir(parents=True)
    (proj_dir / "transkripte").mkdir(parents=True)
    (proj_dir / "audio" / "Z1.mp3").write_bytes(b"audio")
    monkeypatch.setattr(transcribe, "_transkribiere_datei", lambda *a: {
        "text": "T", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "T"}], "duration": 1.0})

    transcribe.transcribe_project("PlatzDemo", "tiny", "de", autocorrect=True)
    zeilen = capsys.readouterr().out.splitlines()

    assert "] fertig Z1: x" not in zeilen, "Fremdtext aus dem Transkript hat eine eigene Zeile bekommen"
    assert any(z.endswith("Autocorrect-Fehler bei Z1: Transkript kaputt ] fertig Z1: x")
               for z in zeilen), zeilen
    # Gegenkontrolle: ein geplatzter Korrekturschritt haelt den Lauf nicht auf.
    assert (proj_dir / "transkripte" / "Z1.json").exists()


def test_transkriptionsfehler_bleibt_auf_einer_zeile(monkeypatch, tmp_path, capsys):
    """Der vierte und letzte Fremdtext-Weg derselben Funktion: `FEHLER {base}: {e}`.

    `e` kommt aus dem Transkribieren selbst — PyAV/ffmpeg beim Dekodieren einer Audiodatei,
    die ein URL-Import geliefert hat. Auch hier hat die Mutationsprobe den Test erzwungen:
    ungefiltert blieben die drei Tests darueber gruen. Vier Interpolationen, vier Sensoren —
    ein Riegel ohne eigenen Sensor ist in diesem PR zweimal durchgerutscht.
    """
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")

    def platzt(*_a):
        raise RuntimeError("Dekodierfehler" + chr(10) + "] fertig Q1: x")

    monkeypatch.setattr(transcribe, "_transkribiere_datei", platzt)
    proj_dir = tmp_path / "DekodDemo"
    (proj_dir / "audio").mkdir(parents=True)
    (proj_dir / "transkripte").mkdir(parents=True)
    (proj_dir / "audio" / "Q1.mp3").write_bytes(b"audio")

    transcribe.transcribe_project("DekodDemo", "tiny", "de")
    zeilen = capsys.readouterr().out.splitlines()

    assert "] fertig Q1: x" not in zeilen, "Dekodierfehler hat eine eigene Zeile bekommen"
    assert any(z.endswith("FEHLER Q1: Dekodierfehler ] fertig Q1: x") for z in zeilen), zeilen


# ─────────────────────────────────────────────────────────────────────────────────────────
# Der Ausgang des gestaffelten Laufs (#417/#414). Die Fixture ist dreimal dieselbe: ein
# Projekt, zwei Aufnahmen, gefaelschtes Whisper — was sich unterscheidet, ist einzig, was
# `correct_ai_single` zurueckgibt und wann `llm.available()` gruen wird.
# ─────────────────────────────────────────────────────────────────────────────────────────

def _ki_projekt(monkeypatch, tmp_path, name, bases=("S1", "S2"), diarize_druckt=False):
    """Zwei Aufnahmen, gefaelschtes Whisper, gefaelschte Diarisierung — bereit fuer autocorrect.

    `diarize_druckt=True` laesst die Attrappe die ECHTEN Zeilenformen von `cmd_diarize`
    drucken (`[active]`/`[done]` je Datei) — #443: die stumme Grundform nahm Tests genau den
    Sensor, an dem die #418/#444-Buchfuehrung haengt, und genau daran lief der erste
    #418-Fix unbemerkt wirkungslos vorbei. Der Default bleibt stumm, weil 14 der 18 Tests
    auf dieser Fixture Reihenfolgen und Zeilenformen zaehlen (z.B. `out.index("[done] …")`,
    das dann diarizes Marke faengt statt der der Freigabe) — wer BUCHFUEHRUNG misst,
    schaltet zu; beide Richtungen haben einen eigenen Waechter direkt unter dieser Fixture.
    """
    from webtool import correct

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    # CLAUDE.md-Regel: sonst kann ein Testlauf echtes pip gegen die venv des Entwicklers
    # starten (keine conftest, der Schutz ist je Test/Fixture — der Nachbar-Test uebernimmt
    # dieselbe Zeile). Bot an PR #493.
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    monkeypatch.setattr(transcribe, "PROJEKTE", str(tmp_path))
    monkeypatch.setattr(transcribe, "_modell", lambda *a, **kw: "fake_model")
    monkeypatch.setattr(transcribe, "_transkribiere_datei", lambda *a, **kw: {
        "text": "Hallo", "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "Hallo"}],
        "duration": 1.0,
    })

    def _diarize_druckt_attrappe(_proj, only_bases, **kw):
        for b in (only_bases or []):
            print(f"[active] {b}", flush=True)
            print(f"[done] {b}", flush=True)
        return len(only_bases or [])

    monkeypatch.setattr(correct, "cmd_diarize",
                        _diarize_druckt_attrappe if diarize_druckt else
                        (lambda *a, **kw: 1))
    monkeypatch.setattr(correct, "prep_single", lambda *a, **kw: True)
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 2)

    proj = tmp_path / name
    (proj / "audio").mkdir(parents=True)
    (proj / "transkripte").mkdir(parents=True)
    for b in bases:
        (proj / "audio" / f"{b}.mp3").write_bytes(b"audio")
    return proj


def test_ki_projekt_kann_diarize_marken_drucken(monkeypatch, tmp_path, capsys):
    """#443-Waechter: die Fixture KANN die echten Marken — die Faehigkeit darf nicht
    still verschwinden. Genau eine durchgaengig stumme Attrappe nahm jedem Test den
    Sensor fuer die [active]/[done]-Buchfuehrung; der erste #418-Fix lief daran
    unbemerkt wirkungslos vorbei (14 Tests, alle gruen)."""
    _ki_projekt(monkeypatch, tmp_path, "FixturDemo", diarize_druckt=True)
    from webtool import correct
    correct.cmd_diarize("FixturDemo", ["S1", "S2"])
    out = capsys.readouterr().out
    # PAAR je Datei (Bot an PR #493): nur [active] S1 + [done] S2 bliebe auch gruen, wenn
    # S1 nie freigibt und S2 sich nie meldet — dann wuesste der Waechter nichts ueber
    # die Paarform, an der die Buchfuehrung haengt. Reihenfolge MITgeprueft: [active]
    # vor [done] je Datei, sonst waere auch ein inverser Drucker „echt".
    for b in ("S1", "S2"):
        assert f"[active] {b}" in out and f"[done] {b}" in out, out
        assert out.index(f"[active] {b}") < out.index(f"[done] {b}"), out


def test_ki_projekt_ist_standardmaessig_stumm(monkeypatch, tmp_path, capsys):
    """Gegenprobe: der Default bleibt stumm — 14 der 18 Tests zaehlen Reihenfolgen und
    Zeilenformen; ungefragte Marken wuerden ihre Indizes verschieben (kein Daueralarm)."""
    _ki_projekt(monkeypatch, tmp_path, "FixturStumm")
    from webtool import correct
    correct.cmd_diarize("FixturStumm", ["S1"])
    assert capsys.readouterr().out == ""


def test_totalausfall_der_korrektur_endet_rot(monkeypatch, tmp_path, capsys):
    """#417 — der Kern: `_wait_futures` wartete, las aber nie `future.result()`.

    `correct_ai_single` meldet an vier Stellen False; der Wert fiel ersatzlos weg. Ein Lauf,
    in dem JEDE Korrektur scheiterte, endete mit Exitcode 0 -> `jobs.py` machte daraus `done`
    -> die Oberflaeche meldete den Lauf als vollstaendig durchgelaufen. Der einzige Hinweis
    waren einzelne `✗`-Zeilen, die niemand liest, der auf den gruenen Zustand schaut. Das ist
    eine Regression gegen den Weg vor v0.48.0: damals lief die Korrektur als eigener Job ueber
    `correct.main`, und der wirft `SystemExit(1)`, sobald Dateien versucht wurden und keine gelang.

    Gedeckt sind BEIDE Ausfallformen in einem Lauf, weil sie zwei verschiedene Zeilen im Code
    sind: S1 meldet regulaer False (der haeufige Fall — ungueltige `correction.json`, Apply
    gescheitert), S2 WIRFT. Der Wurf landet nicht in `correct_ai_single`s eigenem `except`,
    sondern erst in `fut.result()` — ohne den `try` dort risse er die Bilanz mit, also genau
    die Zeile, die den Ausfall meldet.
    """
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "RotDemo")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))

    def ki(_project, b, **_kw):
        if b == "S2":
            raise RuntimeError("Anbieter weg")
        return False

    monkeypatch.setattr(correct, "correct_ai_single", ki)

    assert transcribe.transcribe_project("RotDemo", "tiny", "de", autocorrect=True) == (0, 2)
    out = capsys.readouterr().out
    assert "[RotDemo] Korrektur: 0 von 2 Datei(en) korrigiert" in out
    assert "[RotDemo] Autocorrect-Fehler bei S2: Anbieter weg" in out
    # Die Transkription selbst IST gelungen und ihr Ergebnis liegt auf der Platte — der rote
    # Ausgang gilt der Korrektur, nicht ihr.
    assert (tmp_path / "RotDemo" / "transkripte" / "S1.json").exists()

    # Und derselbe Zustand ueber `main()` — dort wird aus der Bilanz der Exitcode, den `jobs.py`
    # auf `error` abbildet. EIGENES Projekt: „RotDemo" ist oben durchgelaufen, ein zweiter Lauf
    # darueber stiege bei „nichts zu tun" aus und der Test waere vacuous gruen (passiert).
    _ki_projekt(monkeypatch, tmp_path, "RotMain")
    monkeypatch.setattr(transcribe, "ensure_ffmpeg", lambda: None)
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "RotMain", "--autocorrect",
                                      "--model", "tiny"])
    with pytest.raises(SystemExit) as ex:
        transcribe.main()
    assert ex.value.code == 1
    assert "korrektur: FEHLER — 0 von 2 versuchten Datei(en) korrigiert" in capsys.readouterr().out


def test_teilausfall_der_korrektur_bleibt_gruen(monkeypatch, tmp_path, capsys):
    """Negativkontrolle zum Test darueber — ohne sie waere „jeder Fehlschlag macht rot" ein
    genauso guter Fix, und er waere falsch.

    Die Schwelle ist dieselbe wie in `correct.main`: rot NUR, wenn Dateien versucht wurden und
    KEINE gelang. Ein Teilausfall bleibt gruen; er steht in der Bilanzzeile, und die Oberflaeche
    fuehrt die einzelne Datei ueber ihre eigenen `✗`-Zeilen. (Dass die Bilanz selbst noch
    ungelesen ist, steht als getragene Grenze im INVENTAR und als #421.)
    """
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "TeilDemo")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "correct_ai_single", lambda _p, b, **_kw: b == "S1")

    assert transcribe.transcribe_project("TeilDemo", "tiny", "de", autocorrect=True) == (1, 2)
    assert "[TeilDemo] Korrektur: 1 von 2 Datei(en) korrigiert" in capsys.readouterr().out

    # Ueber `main()` derselbe Ausgang, an einem FRISCHEN Projekt (siehe Begruendung oben).
    _ki_projekt(monkeypatch, tmp_path, "TeilMain")
    monkeypatch.setattr(transcribe, "ensure_ffmpeg", lambda: None)
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "TeilMain", "--autocorrect",
                                      "--model", "tiny"])
    transcribe.main()                                        # kein SystemExit
    out = capsys.readouterr().out
    assert "[TeilMain] Korrektur: 1 von 2 Datei(en) korrigiert" in out   # der Lauf hat gearbeitet
    assert "korrektur: FEHLER" not in out


def test_spaet_eingestellter_anbieter_greift_noch_im_selben_lauf(monkeypatch, tmp_path, capsys):
    """#414 — die Anbieterlage wurde nur EINMAL am Laufstart gelesen.

    Sie steht aber in einer Datei, die der Server jederzeit neu schreibt. Wer einen langen Lauf
    startet, dabei merkt, dass kein Anbieter eingestellt ist, und ihn WAEHREND des Laufs
    konfiguriert, bekam fuer diesen Lauf keine Korrektur — auch nicht fuer Dateien, die er
    danach hochlaedt und die dieselbe Schleife noch aufnimmt (sie ruft `find_audio` in jeder
    Runde neu). Bis v0.48.0 galt das von selbst: die Korrektur hing als eigener Job am ENDE.

    Gemessen wird beides, was der Fix verspricht: die zweite Datei wird korrigiert (S2 in
    `gesehen`), UND der Grund steht trotz Pruefung je Datei nur EINMAL im Protokoll — sonst
    waere aus dem Fix eine Zeile je Aufnahme geworden, die genau die Zeilen zudeckt, wegen
    derer man ins Protokoll sieht.
    """
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "SpaetDemo")
    runden = []

    def available():
        runden.append(1)
        # Erst ab der dritten Frage gruen: einmal vorab, einmal fuer S1 — S2 bekommt ihn.
        return (len(runden) >= 3, "kein KI-Anbieter konfiguriert")

    gesehen = []
    monkeypatch.setattr(llm, "available", available)
    monkeypatch.setattr(correct, "correct_ai_single",
                        lambda _p, b, **_kw: (gesehen.append(b), True)[1])

    assert transcribe.transcribe_project("SpaetDemo", "tiny", "de", autocorrect=True) == (1, 1)
    assert gesehen == ["S2"], gesehen
    zeilen = capsys.readouterr().out.splitlines()
    assert [z for z in zeilen if z.startswith("[autocorrect] ")] == [
        "[autocorrect] KI-Phase uebersprungen — kein KI-Anbieter konfiguriert"
    ], zeilen


def test_geschuetzte_datei_faerbt_den_lauf_NICHT_rot(monkeypatch, tmp_path, capsys):
    """Ein Schutzpfad ist kein Fehlschlag — auch nicht im Nenner (#417-Review, I1).

    `correct_ai_single` steigt vor jeder Arbeit aus, wenn die `edit.json` `human_edited=true`
    traegt. Das meldete es als `False`, und die Bilanz zaehlte JEDE uebergebene Datei: eine
    einzelne geschuetzte Aufnahme ergab `0 von 1`, `transcribe.main` schloss daraus auf einen
    Totalausfall und beendete mit **Exitcode 1 dafuer, dass die Handarbeit des Nutzers
    erfolgreich geschuetzt wurde**. Gemessen, bevor dieser Test entstand.

    Es ist derselbe Fehler wie der, den #412 sechs Zeilen weiter unten gerade vermieden hatte
    (`!= "missing"` statt `!= "written"`), nur spiegelverkehrt — und er stand damit INNERHALB
    einer Funktion, in genau der, die dieser Fix dafuer angefasst hat. `correct.main` rechnet
    seit jeher richtig: sein `attempted` zieht die Schutz-Skips aus dem Nenner.

    Erreichbar, wenn die Roh-`.json` verschwindet und die `edit.json` bleibt — von Hand
    aufgeraeumt, ein halb abgebrochenes Loeschen, eine Wiederherstellung aus einer Sicherung.
    Der Knopf im Browser raeumt beides zusammen weg (`app._datei_weg`), ueber ihn entsteht der
    Fall also nicht.

    Der Test prueft BEIDE Zaehler: `(0, 0)` statt `(0, 1)`. Nur den Exitcode zu pruefen
    genuegte nicht — ein Nenner, der die Datei mitzaehlt, aber `ki_ok` faelschlich erhoeht,
    waere ebenfalls gruen und trotzdem falsch.
    """
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "SchutzDemo", bases=("X",))
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    # Die Roh-JSON fehlt (sie entsteht erst im Lauf), die handbearbeitete edit.json liegt da.
    (tmp_path / "SchutzDemo" / "transkripte" / "X.edit.json").write_text(
        json.dumps({"human_edited": True, "segments": []}), encoding="utf-8")

    assert transcribe.transcribe_project("SchutzDemo", "tiny", "de", autocorrect=True) == (0, 0)
    out = capsys.readouterr().out
    assert "↷ SKIP X (human_edited=true" in out, "Vorbedingung: der Schutzpfad hat gegriffen"
    # Keine Bilanzzeile: es wurde nichts versucht, und „0 von 0" waere eine Meldung ueber nichts.
    assert "Korrektur:" not in out, out

    # FRISCHES Projekt fuer den `main()`-Durchgang. „SchutzDemo" ist oben durchgelaufen; ein
    # zweiter Lauf darueber stiege bei „nichts zu tun" aus (transcribe.py:502-509), noch bevor
    # die Bilanzrechnung erreicht waere — die Zusicherung darunter bliebe dann auch bei
    # kaputtem Zaehler gruen. Genau diese Falle steht in `test_totalausfall_…` als Warnung, und
    # genau hier war sie nicht befolgt (CodeRabbit-Bot am PR).
    _ki_projekt(monkeypatch, tmp_path, "SchutzMain", bases=("Y",))
    (tmp_path / "SchutzMain" / "transkripte" / "Y.edit.json").write_text(
        json.dumps({"human_edited": True, "segments": []}), encoding="utf-8")
    monkeypatch.setattr(transcribe, "ensure_ffmpeg", lambda: None)
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "SchutzMain", "--autocorrect",
                                      "--model", "tiny"])
    transcribe.main()                    # kein SystemExit — der Schutz IST der Erfolg
    out2 = capsys.readouterr().out
    assert "↷ SKIP Y (human_edited=true" in out2, "Vorbedingung: der Lauf hat Y ueberhaupt erreicht"
    assert "korrektur: FEHLER" not in out2


def test_correct_ai_single_trennt_nicht_versucht_von_gescheitert(monkeypatch, tmp_path):
    """Der dritte Rueckgabewert direkt an der Quelle — die Zusicherung, auf der die Bilanz steht.

    Der Test darueber misst die Wirkung ueber den ganzen Lauf; dieser nagelt den Vertrag fest,
    damit ein spaeterer vierter Ausstieg nicht still auf `False` faellt. `None` heisst „gar
    nicht erst versucht", `False` heisst „versucht und gescheitert" — die Unterscheidung ist
    der Unterschied zwischen einem gruenen und einem roten Lauf.
    """
    from webtool import correct

    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    # Pflicht laut CLAUDE.md, auch wenn heute kein Zweig hier einen Anbieter ruft: sonst
    # entscheidet die echte Einstellungsdatei des Entwicklers ueber den KI-Anbieter.
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    tdir = tmp_path / "P" / "transkripte"
    tdir.mkdir(parents=True)

    # 1. kein Roh-Transkript -> nicht versucht
    assert correct.correct_ai_single("P", "A") is None

    # 2. human_edited -> nicht versucht (und der Wert ist NICHT False)
    (tdir / "B.json").write_text(json.dumps({"segments": []}), encoding="utf-8")
    (tdir / "B.edit.json").write_text(json.dumps({"human_edited": True}), encoding="utf-8")
    assert correct.correct_ai_single("P", "B") is None

    # 3. versucht und gescheitert -> False, nicht None
    (tdir / "C.json").write_text(json.dumps({"segments": []}), encoding="utf-8")
    monkeypatch.setattr(correct, "_context", lambda *a: "")
    monkeypatch.setattr(correct, "_correct_file", lambda *a, **kw: None)   # schreibt nichts
    assert correct.correct_ai_single("P", "C") is False


def test_wurf_in_der_vorbereitung_zaehlt_als_gescheiterter_versuch(monkeypatch, tmp_path, capsys):
    """Der Totalausfall EINE PHASE FRUEHER — gefunden vom kalten Zweitleser zu diesem PR.

    Der Fix las die Ergebnisse der KI-Futures aus. Wirft aber schon die VORBEREITUNG
    (`cmd_diarize` / `prep_single`), wird die Datei nie an den Pool uebergeben: `ai_futures`
    blieb leer, `transcribe_project` lieferte `(0, 0)`, `main()` endete mit 0, der Job stand
    auf `done`. Also genau die Falschmeldung, gegen die dieser Zweig angetreten ist — nur vor
    der Stelle, die er repariert hatte. GEMESSEN, bevor dieser Test entstand: zwei Dateien,
    `cmd_diarize` wirft fuer beide, Rueckgabe `(0, 0)`.

    Der Kommentar im Drain-Zweig sagte laengst „ein Wurf IST ein gescheiterter Versuch", und
    `cmd_run.one()` wertet einen Prep-Ausfall ebenso — der Widerspruch stand innerhalb
    derselben Funktion.
    """
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "WurfVorDemo")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))

    def platzt(*_a, **_kw):
        raise RuntimeError("GPU weg")

    monkeypatch.setattr(correct, "cmd_diarize", platzt)
    monkeypatch.setattr(correct, "correct_ai_single", lambda *a, **kw: True)

    assert transcribe.transcribe_project("WurfVorDemo", "tiny", "de", autocorrect=True) == (0, 2)
    out = capsys.readouterr().out
    assert "[WurfVorDemo] Autocorrect-Fehler bei S1: GPU weg" in out
    assert "[WurfVorDemo] Korrektur: 0 von 2 Datei(en) korrigiert" in out


def test_wurf_in_der_vorbereitung_OHNE_anbieter_bleibt_gruen(monkeypatch, tmp_path, capsys):
    """Negativkontrolle — und sie ist die teurere Haelfte.

    Ohne nutzbaren Anbieter ist die LLM-Phase BEWUSST abgeschaltet; Diarisierung und Prep
    laufen trotzdem, weil ihr Sidecar idempotent ist und dem spaeteren `correct run` GPU-Minuten
    spart. Wirft die Vorbereitung in diesem Zustand, darf das den Lauf NICHT rot faerben —
    ein absichtlich ausgelassener Schritt ist nie ein Fehlschlag (dieselbe Regel wie beim
    Kill-Switch). Ohne diese Zeile waere `ki_versucht += 1` im except ein Zaehler, der einen
    abgeschalteten Weg anklagt.

    SEIT #405/#421 GILT DAS AUCH FUER DIE ZEILE, nicht nur fuer den Zaehler. Beide Faelle
    druckten dieselbe Form; solange der Parser sie ignorierte, war das folgenlos. Seit die
    Oberflaeche die Korrektur je Datei liest, meldete sie damit eine Aufnahme als gescheitert,
    deren Korrektur niemand angefordert hat — spiegelverkehrt derselbe Fehler wie ein rotes
    Exitcode fuer eine geschuetzte `human_edited`-Datei. Aus der gemeinsamen Form ist der
    Unterschied nicht entscheidbar: sie ist in beiden Faellen byteweise dieselbe.
    """
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "WurfOhneDemo")
    monkeypatch.setattr(llm, "available", lambda: (False, "kein KI-Anbieter konfiguriert"))

    def platzt(*_a, **_kw):
        raise RuntimeError("GPU weg")

    monkeypatch.setattr(correct, "cmd_diarize", platzt)

    assert transcribe.transcribe_project("WurfOhneDemo", "tiny", "de", autocorrect=True) == (0, 0)
    out = capsys.readouterr().out
    assert ("[WurfOhneDemo] Vorbereitung gescheitert bei S1 (ohne KI-Phase): GPU weg" in out), \
        "Vorbedingung: der Wurf ist passiert — und er sagt es"
    # Die eigentliche Zusicherung: NICHT die Form, die der Parser als Fehlschlag liest.
    assert "Autocorrect-Fehler" not in out, out
    assert "Korrektur:" not in out, out


def test_prep_single_False_geht_denselben_weg_wie_ein_wurf(monkeypatch, tmp_path, capsys):
    """`prep_single` MELDET seinen Fehlschlag nicht durch eine Ausnahme, sondern per `bool`.

    Der Rueckgabewert fiel weg (CodeRabbit an PR #433) — damit war der except-Zweig darunter
    samt seinen ZWEI Zeilenformen (#421) fuer diesen Weg unerreichbar, obwohl `prep_single`
    genau hier `False` liefert (`OSError`/`ValueError` beim Lesen des Transkripts). Seine
    eigene Meldung `prep: SKIP …` wird vom Parser BEWUSST ignoriert, half also nicht.

    Folge vorher: die Datei ging unvorbereitet an den Pool, `correct_ai_single` scheiterte am
    fehlenden `.tagged.txt` und verbrannte einen LLM-Slot fuer ein Ergebnis, das nach der
    ersten Zeile feststand.

    BEIDE Richtungen, sonst ist die halbe Regel unbewacht — die zweite ist die teurere: ohne
    Anbieter ist die LLM-Phase bewusst aus, und ein absichtlich ausgelassener Schritt darf den
    Lauf nicht rot faerben (dieselbe Regel wie beim Kill-Switch).
    """
    from webtool import correct, llm

    # (1) Pool steht: gescheiterter VERSUCH — Zeile UND Zaehler.
    _ki_projekt(monkeypatch, tmp_path, "PrepFalschDemo")
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "cmd_diarize", lambda *a, **kw: None)
    monkeypatch.setattr(correct, "prep_single", lambda *a, **kw: False)
    monkeypatch.setattr(correct, "correct_ai_single", lambda *a, **kw: True)

    assert transcribe.transcribe_project("PrepFalschDemo", "tiny", "de", autocorrect=True) == (0, 2)
    out = capsys.readouterr().out
    assert "[PrepFalschDemo] Autocorrect-Fehler bei S1: Vorbereitung fehlgeschlagen" in out, out
    assert "[PrepFalschDemo] Korrektur: 0 von 2 Datei(en) korrigiert" in out, out

    # (2) Kein Anbieter: BEWUSST ausgelassen — nicht die Form, die der Parser als Fehlschlag liest.
    # `_ki_projekt` setzt `prep_single` SELBST auf True (Zeile 1410) — die Attrappe muss also
    # DANACH kommen, sonst nimmt die Fixture dem zweiten Teil seinen Sensor und er ist vacuous.
    _ki_projekt(monkeypatch, tmp_path, "PrepFalschOhneDemo")
    monkeypatch.setattr(llm, "available", lambda: (False, "kein KI-Anbieter konfiguriert"))
    monkeypatch.setattr(correct, "prep_single", lambda *a, **kw: False)

    assert transcribe.transcribe_project("PrepFalschOhneDemo", "tiny", "de",
                                         autocorrect=True) == (0, 0)
    out = capsys.readouterr().out
    assert ("[PrepFalschOhneDemo] Vorbereitung gescheitert bei S1 (ohne KI-Phase)" in out), \
        "Vorbedingung: die Vorbereitung ist gescheitert — und sie sagt es"
    assert "Autocorrect-Fehler" not in out, out
    assert "Korrektur:" not in out, out


def test_anbieterlage_wird_VOR_der_vorbereitung_gefragt(monkeypatch, tmp_path, capsys):
    """Die Zusage „je Datei neu gefragt" (#414) galt im WURF-Pfad nicht.

    `_ai_pool_oeffnen()` stand hinter `cmd_diarize`/`prep_single`. Wirft eine der beiden, ist
    der Pool noch zu — und der except-Zweig druckt „ohne KI-Phase", auch wenn der Anbieter
    inzwischen verfuegbar ist. Gemessen: `available()` wurde in einem Lauf ueber zwei Dateien
    GENAU EINMAL gerufen (der Vorablauf am Anfang), beide Dateien falsch beschriftet.

    Die Richtung war sicher (nie ein falsches Rot), die Beschriftung nicht. Und seit die
    Oberflaeche die Korrektur je Datei liest (#405), ist die Beschriftung der Unterschied
    zwischen „Aufnahme gescheitert" und „Korrektur war gar nicht angefordert".
    """
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "SpaetDemo")
    gefragt = []

    def lage():
        gefragt.append(1)
        # Beim Laufstart noch kein Anbieter, ab der ersten Datei schon.
        return (len(gefragt) > 1, "" if len(gefragt) > 1 else "kein KI-Anbieter konfiguriert")

    monkeypatch.setattr(llm, "available", lage)
    monkeypatch.setattr(correct, "cmd_diarize", _wirf("GPU weg"))

    transcribe.transcribe_project("SpaetDemo", "tiny", "de", autocorrect=True)
    out = capsys.readouterr().out
    assert len(gefragt) >= 2, f"nur {len(gefragt)}x gefragt — die Lage wird nicht je Datei geholt"
    # Der Pool steht ab der ersten Datei, also ist der Wurf ein VERSUCH und wird so benannt.
    assert "Autocorrect-Fehler bei S1: GPU weg" in out, out
    assert "Vorbereitung gescheitert" not in out, out


def _wirf(text):
    def platzt(*_a, **_kw):
        raise RuntimeError(text)
    return platzt


def test_all_verrechnet_projekte_nicht_gegeneinander(monkeypatch, tmp_path, capsys):
    """`--all`: ein erfolgreiches Projekt darf den Totalausfall eines anderen nicht zudecken.

    Summiert man ueber alle Projekte, ergibt „A: 0 von 1" plus „B: 1 von 1" zusammen
    `ki_ok=1, ki_versucht=2` — und die Schwelle „versucht und keine gelang" greift nicht mehr.
    Exitcode 0, obwohl in A keine einzige Korrektur gelang. Dieselbe Verrechnung, gegen die
    dieser Zweig angetreten ist, eine Ebene hoeher; nur der CLI-Weg ist betroffen (Server-Jobs
    laufen je Projekt).

    Gezaehlt werden deshalb nur die Versuche der Projekte OHNE einen einzigen Erfolg — damit
    bleibt die Meldung „0 von N versuchten" auch bei `--all` woertlich wahr.
    """
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "AAusfall", bases=("A1",))
    _ki_projekt(monkeypatch, tmp_path, "BErfolg", bases=("B1",))
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    # A scheitert, B gelingt — in der Summe waere das "1 von 2" und damit gruen.
    monkeypatch.setattr(correct, "correct_ai_single", lambda _p, b, **_kw: b == "B1")
    monkeypatch.setattr(transcribe, "ensure_ffmpeg", lambda: None)
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "--all", "--autocorrect",
                                      "--model", "tiny"])

    with pytest.raises(SystemExit) as ex:
        transcribe.main()
    assert ex.value.code == 1
    out = capsys.readouterr().out
    assert "korrektur: FEHLER — 0 von 1 versuchten Datei(en) korrigiert" in out, out
    # Gegenprobe: B wurde trotzdem transkribiert — der Lauf bricht nicht beim ersten Ausfall ab.
    assert (tmp_path / "BErfolg" / "transkripte" / "B1.json").exists()


def test_done_kommt_erst_nach_der_inline_korrektur(monkeypatch, tmp_path, capsys):
    """`[done]` gibt die Aufnahme frei — und darf das erst, wenn NIEMAND mehr schreibt (#418).

    `jobs.py` nimmt den Basisnamen bei dieser Zeile aus `active_bases`, und
    `betrifft(..., active_only=True)` haengt daran: die 409-Sperre von
    `DELETE .../files/{base}`. Bis zu diesem Fix stand die Zeile bedingungslos im `finally`
    der Schleife, also unmittelbar hinter `ai_pool.submit(...)` — die Aufnahme galt damit
    schon als frei, waehrend sie noch in der Poolschlange auf einen Arbeiter wartete.

    Dieser Test sichert NUR die verschobene Freigabe. Er allein genuegt nicht: mit
    eingeschalteter Diarisierung gibt `cmd_diarize` die Aufnahme schon vorher frei, und dann
    ist das Verschieben wirkungslos. Diese Haelfte deckt
    `test_aufnahme_bleibt_bis_zum_ende_der_korrektur_gesperrt` ab — die beiden gehoeren
    zusammen, und genau die Luecke dazwischen ist im Review aufgefallen.

    Die Waise aus der Ausgangsmeldung entsteht NICHT (`correct_ai_single` prueft die Roh-JSON
    beim Eintritt selbst). Gesichert wird die Sperr-Semantik, kein belegter Datenverlust.

    Der Sensor ist die REIHENFOLGE auf stdout, nicht die blosse Anwesenheit der Zeile — genau
    die war vorher schon da. `KI-FERTIG` druckt die Attrappe als LETZTES, aus demselben
    Poolthread, der gleich darauf den Rueckruf ausloest; die Ordnung ist damit zugesichert und
    nicht vom Scheduler geliehen.
    """
    import time
    from webtool import correct, llm

    _ki_projekt(monkeypatch, tmp_path, "FreigabeDemo", bases=("S1",))
    monkeypatch.setattr(llm, "available", lambda: (True, ""))

    def langsame_korrektur(project, b, **kw):
        time.sleep(0.15)          # das Fenster, in dem frueher geloescht werden konnte
        print(f"KI-FERTIG {b}", flush=True)
        return True

    monkeypatch.setattr(correct, "correct_ai_single", langsame_korrektur)

    transcribe.transcribe_project("FreigabeDemo", "tiny", "de", autocorrect=True)
    out = capsys.readouterr().out
    assert "KI-FERTIG S1" in out, out
    assert "[done] S1" in out, out
    assert out.index("[done] S1") > out.index("KI-FERTIG S1"), (
        "die Aufnahme wurde freigegeben, waehrend die Korrektur noch schrieb: " + out)


def test_ohne_future_wird_die_aufnahme_trotzdem_freigegeben(monkeypatch, tmp_path, capsys):
    """Die Gegenrichtung zu #418 — und der teurere Fall.

    Haelt kein Future die Datei, gibt es auch niemanden, der sie spaeter freigibt: dann MUSS
    das `finally` drucken. Ohne diese Haelfte bliebe ein Fix gruen, der die Aufnahme bis
    Jobende in `active_bases` stehen laesst — ihr Loeschen antwortete dauerhaft mit 409, und
    zwar ausgerechnet dort, wo gar nichts mehr an ihr arbeitet.

    Beide Gruende, aus denen kein Future entsteht, sonst ist die halbe Regel unbewacht.
    """
    from webtool import correct, llm

    # (1) Pool steht, aber die Vorbereitung scheitert -> `submit` wird nie erreicht.
    #     `_ki_projekt` setzt `prep_single` SELBST auf True, die Attrappe muss also DANACH
    #     kommen — sonst nimmt die Fixture dem Test seinen Sensor.
    _ki_projekt(monkeypatch, tmp_path, "OhneFutureDemo", bases=("S1",))
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "prep_single", lambda *a, **kw: False)
    gerufen = []
    monkeypatch.setattr(correct, "correct_ai_single",
                        lambda *a, **kw: gerufen.append(1) or True)

    transcribe.transcribe_project("OhneFutureDemo", "tiny", "de", autocorrect=True)
    out = capsys.readouterr().out
    assert not gerufen, "Vorbedingung: ohne Vorbereitung geht nichts an den Pool"
    assert "[done] S1" in out, out



def test_ohne_anbieter_wird_die_aufnahme_trotzdem_freigegeben(monkeypatch, tmp_path, capsys):
    """Zweiter Grund, aus dem kein Future entsteht: es gibt ueberhaupt keinen Pool.

    Eigener Test statt eines zweiten Blocks im vorigen (Review M4): faellt er, soll der Name
    sagen, WELCHE Haelfte — und die Attrappen der einen Haelfte sollen nicht in die andere
    lecken.
    """
    from webtool import llm

    _ki_projekt(monkeypatch, tmp_path, "OhneKiDemo", bases=("S1",))
    monkeypatch.setattr(llm, "available", lambda: (False, "kein KI-Anbieter konfiguriert"))

    transcribe.transcribe_project("OhneKiDemo", "tiny", "de", autocorrect=True)
    out = capsys.readouterr().out
    assert "[done] S1" in out, out


def test_aufnahme_bleibt_bis_zum_ende_der_korrektur_gesperrt(monkeypatch, tmp_path, capsys):
    """Der Standardpfad — und der Test, der in der ersten Fassung dieses Fixes FEHLTE.

    `cmd_diarize` druckt auf jedem Pfad, auf dem es die Datei wirklich anfasst, ein eigenes
    `[active]`/`[done]`-Paar (`correct.py:325` und `:334`/`:356`/`:364`/`:368`; seine vier
    stillen Ausstiege drucken beides nicht und sind damit unschaedlich). Bei ihm heisst `[done]` „dieser Schritt ist fertig",
    `jobs.py` liest aber „der Lauf ist mit der Datei fertig" und verwirft sie aus
    `active_bases`. Die Aufnahme war damit frei, waehrend sie noch in der Poolschlange auf
    einen Arbeiter wartete — und das blosse Verschieben des `finally`-Drucks aendert daran
    NICHTS, weil dort nur ein zweites Mal verworfen wurde, was laengst weg war.

    WARUM DAS AN DEN VORHANDENEN TESTS VORBEILIEF: `_ki_projekt` faelscht `cmd_diarize` mit
    einer STUMMEN Attrappe. Die Fixture nimmt dem Test damit genau den Sensor, um den es
    hier geht. Deshalb druckt die Attrappe unten die echten Zeilenformen.

    Und die Buchung laeuft durch `jobs.buche_aktive` — dieselbe Funktion, die der Server in
    `_run` fahrt. Die Regel im Test nachzubauen hiesse, die Attrappe gegen die Attrappe zu
    pruefen.
    """
    import threading
    import time
    from webtool import correct, jobs, llm

    _ki_projekt(monkeypatch, tmp_path, "SperrDemo", bases=("S1", "S2"))
    monkeypatch.setattr(llm, "available", lambda: (True, ""))
    monkeypatch.setattr(correct, "CLAUDE_PARALLEL", 1)   # S2 MUSS in der Schlange warten

    s2_vorbereitet = threading.Event()

    def diarize_wie_echt(project, only_bases=None):
        for b in (only_bases or []):
            print(f"[active] {b}", flush=True)
            print(f"→ Diarisiere {b} …", flush=True)
            print(f"[done] {b}", flush=True)         # <- gibt frei, correct.py:356
        return len(only_bases or [])

    def prep_wie_echt(project, b, **kw):
        if b == "S2":
            s2_vorbereitet.set()
        return True

    def korrektur_wie_echt(project, b, **kw):
        print(f"[active] {b}", flush=True)           # correct.py:1076
        if b == "S1":
            # Deterministisch statt per Uhr: S1 haelt den einzigen Arbeiter besetzt, bis S2
            # die Vorbereitung durch hat und in der Schlange steht.
            assert s2_vorbereitet.wait(10), "Vorbedingung: S2 erreichte die Schlange nicht"
        print(f"apply: {b} -> edit.json + md (1 Segmente)", flush=True)
        print(f"[done] {b}", flush=True)             # correct.py:1117 (finally)
        return True

    monkeypatch.setattr(correct, "cmd_diarize", diarize_wie_echt)
    monkeypatch.setattr(correct, "prep_single", prep_wie_echt)
    monkeypatch.setattr(correct, "correct_ai_single", korrektur_wie_echt)

    transcribe.transcribe_project("SperrDemo", "tiny", "de", autocorrect=True)
    zeilen = capsys.readouterr().out.splitlines()

    aktive = {}
    gesehen = set()
    verlauf = []
    for zeile in zeilen:
        jobs.buche_aktive(aktive, zeile, gesehen)
        verlauf.append((zeile, dict(aktive)))

    # Vorbedingung: S2 war fertig diarisiert, BEVOR S1s Korrektur endete. Ohne sie waere die
    # Zusicherung unten vacuous — dann haette S2 die Schlange nie erreicht.
    idx_diar_s2 = [i for i, (z, _) in enumerate(verlauf) if z == "→ Diarisiere S2 …"]
    idx_apply_s1 = [i for i, (z, _) in enumerate(verlauf)
                    if z == "apply: S1 -> edit.json + md (1 Segmente)"]
    assert idx_diar_s2 and idx_apply_s1, zeilen
    assert idx_diar_s2[0] < idx_apply_s1[0], (
        "Vorbedingung: S2 muss die Schlange erreichen, waehrend S1 noch korrigiert wird")

    # #452-Waechter: das diarize-[done] darf die Buchung nicht leeren — die Transkription
    # (ihr [active] VOR der Transkription) haelt die Aufnahme noch. Auf der Menge war genau
    # hier das Loch aus zwei benachbarten Schreibvorgangen; der Zaehler traegt die
    # Verschachtelung. Das ERSTE "[done] S1" ist diarizes (die Korrektur folgt spaeter).
    i_diar_done_s1 = zeilen.index("[done] S1")
    assert "S1" in verlauf[i_diar_done_s1][1], (
        "diarize-[done] leert die Buchung, obwohl der aeussere Drucker haelt — #452"
        + chr(10) + chr(10).join(f"{z!r} -> {sorted(a)}" for z, a in verlauf[:i_diar_done_s1 + 1]))

    # DIE ZUSICHERUNG: mitten in S1s Korrektur wartet S2 in der Schlange — und gilt als
    # bearbeitet. Vor dem Fix war sie hier frei, `DELETE` kam mit 200 durch.
    _, zustand = verlauf[idx_apply_s1[0]]
    assert "S2" in zustand, (
        "S2 wartet in der Poolschlange und gilt trotzdem als frei — genau das Loch aus #418."
        + chr(10) + chr(10).join(f"{z!r} -> {sorted(a)}" for z, a in verlauf))

    # Und am Ende ist wirklich alles freigegeben — sonst bliebe Loeschen dauerhaft bei 409.
    # Als Zaehler-Bilanz ist das zugleich der Wächter gegen ein drittes [active] ohne
    # [done]: jedes unpaarige active bliebe hier sichtbar stehen (#452).
    assert verlauf[-1][1] == {}, verlauf[-1]

    # Die ZWEITE Menge gegen dieselbe echte Druckfolge (#475): sie darf am Ende gerade NICHT
    # leer sein. Der synthetische Drucker in test_jobs.py prueft die Buchung, dieser hier
    # prueft sie gegen die Zeilen, die `transcribe_project` wirklich schreibt -- genau die
    # Luecke, an der #418 vorbeilief.
    assert {"S1", "S2"} <= gesehen, sorted(gesehen)
