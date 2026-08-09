"""whisper.cpp-Adapter — reine Funktionen, kein Binary, kein Netz.

Der CI-Job installiert weder whisper-cpp noch torch (siehe .github/workflows/test.yml).
Geprueft wird deshalb genau das, was ohne beides pruefbar ist: die Uebersetzung von
whisper.cpps JSON in den `<base>.json`-Vertrag. Genau dort sitzt auch das Risiko —
ein Formatfehler faellt sonst erst im Editor auf, an einem Transkript, das schon
geschrieben ist.
"""
import math
import os
import sys
import zlib

import pytest

from webtool import whispercpp as w


def _tok(text, p=0.9, von=0, bis=100, tid=1):
    return {"text": text, "p": p, "id": tid,
            "offsets": {"from": von, "to": bis}, "timestamps": {}}


def _seg(text, tokens, von=0, bis=1000):
    return {"text": text, "tokens": tokens,
            "offsets": {"from": von, "to": bis}, "timestamps": {}}


# --- Fortschritt ---

def test_fortschritt_liest_die_prozente():
    assert w.fortschritt("whisper_print_progress_callback: progress =  42%") == 42


def test_fortschritt_kappt_bei_hundert():
    """whisper.cpp zaehlt ueber das Ende hinaus (gemessen: 5, 11, …, 97, 103).
    Ein Balken, der 103% anzeigt, sieht nach Fehler aus."""
    assert w.fortschritt("progress = 103%") == 100


def test_fortschritt_ignoriert_andere_zeilen():
    assert w.fortschritt("ggml_metal_device_init: GPU name: Apple M1 Pro") is None


# --- Tokens zu Woertern ---

def test_worte_fasst_subword_tokens_zusammen():
    """Whisper toknisiert " Vorarlberger" als " Vor"+"arl"+"berger" — ein neues Wort
    beginnt genau dort, wo ein Token mit Leerzeichen anfaengt."""
    worte = w._worte([_tok(" Vor", von=0, bis=100), _tok("arl", von=100, bis=200),
                      _tok("berger", von=200, bis=500), _tok(" Dialekt", von=500, bis=900)])
    assert [x["word"] for x in worte] == [" Vorarlberger", " Dialekt"]


def test_worte_spannt_zeiten_ueber_das_ganze_wort():
    worte = w._worte([_tok(" Vor", von=0, bis=100), _tok("arl", von=100, bis=250)])
    assert worte[0]["start"] == 0.0 and worte[0]["end"] == 0.25   # ms -> Sekunden


def test_worte_wirft_sondertokens_weg():
    """[_BEG_] und [_TT_123] sind keine Sprache. Blieben sie drin, stuenden sie als
    eigenes "Wort" im Editor und in der [[Wort|prob]]-Markierung."""
    worte = w._worte([_tok("[_BEG_]"), _tok(" hallo"), _tok("[_TT_310]")])
    assert [x["word"] for x in worte] == [" hallo"]


def test_wortwahrscheinlichkeit_ist_das_mittel():
    """Gemessen gegen faster-whisper auf derselben Datei: Mittel markiert 9.4% der
    Woerter als unsicher (faster-whisper 6.5%), Minimum und Produkt je 15.6% — die
    haetten UNCERTAIN_TAG_THRESHOLD=0.5 still entkalibriert."""
    worte = w._worte([_tok(" un", p=0.9), _tok("sicher", p=0.5)])
    assert worte[0]["probability"] == pytest.approx(0.7)


def test_worte_ohne_tokens_ist_leer():
    assert w._worte([]) == []


# --- Segmentfelder, die edit_model liest ---

def test_kompressionsrate_wie_upstream():
    text = "hallo hallo hallo hallo"
    roh = text.encode("utf-8")
    assert w._kompressionsrate(text) == pytest.approx(len(roh) / len(zlib.compress(roh)))


def test_kompressionsrate_bei_leerem_text():
    """Ein leeres Segment darf keine ZeroDivisionError werfen — es kommt vor."""
    assert w._kompressionsrate("") == 0.0


def test_avg_logprob_ist_das_mittel_der_logs():
    seg = w._segment(0, _seg(" hallo", [_tok(" hallo", p=0.5)]))
    assert seg["avg_logprob"] == pytest.approx(math.log(0.5))


def test_segment_traegt_alle_schluessel_des_vertrags():
    """Dieselbe Liste, auf die test_transcribe die faster-whisper-Seite festnagelt.
    Ein fehlender Schluessel faellt sonst erst im Editor als KeyError auf."""
    seg = w._segment(3, _seg(" hallo", [_tok(" hallo")]))
    for k in ("id", "start", "end", "text", "avg_logprob", "compression_ratio",
              "no_speech_prob", "words", "seek", "tokens", "temperature"):
        assert k in seg, k
    assert seg["id"] == 3


def test_segment_rechnet_millisekunden_in_sekunden():
    seg = w._segment(0, _seg(" hallo", [_tok(" hallo")], von=1500, bis=4250))
    assert seg["start"] == 1.5 and seg["end"] == 4.25


def test_ergebnis_baut_das_rohdokument():
    roh = {"transcription": [_seg(" hallo", [_tok(" hallo")], 0, 1000),
                             _seg(" welt", [_tok(" welt")], 1000, 2000)]}
    d = w.ergebnis(roh, "de")
    assert d["text"] == " hallo welt"          # fuehrendes Leerzeichen wie bei Whisper
    assert d["language"] == "de"
    assert [s["id"] for s in d["segments"]] == [0, 1]


def test_ergebnis_passt_durch_edit_model():
    """Der eigentliche Beweis: das Dokument muss den Editor-Aufbau ueberstehen."""
    from webtool.edit_model import build_edit_doc, tag_uncertain_segments
    roh = w.ergebnis({"transcription": [_seg(" unsicher", [_tok(" unsicher", p=0.3)])]}, "de")
    doc = build_edit_doc(roh, base="a", project="P", audio="a.mp3")
    assert doc["segments"][0]["words"][0]["probability"] == pytest.approx(0.3)
    assert "[[" in tag_uncertain_segments(roh)[0]["tagged_text"]   # 0.3 < 0.5


# --- Modellwahl und Quelle ---

def test_unterstuetzt_nur_die_angebotenen_stufen():
    from webtool import settings
    for c in settings.WHISPER_CHOICES:
        assert w.unterstuetzt(c["id"]), c["id"]


def test_exotische_stufen_sind_nicht_unterstuetzt():
    """large-v1 und die .en-Varianten haengen nicht am Release — device.asr_engine
    faellt fuer sie auf faster-whisper zurueck, statt mit 404 zu sterben."""
    assert not w.unterstuetzt("large-v1")
    assert not w.unterstuetzt("medium.en")


def test_turbo_und_large_v3_turbo_meinen_dieselbe_datei():
    assert w.MODELL_DATEIEN["turbo"] == w.MODELL_DATEIEN["large-v3-turbo"]


def test_quelle_ist_das_github_release():
    assert w.quelle("ggml-tiny.bin").endswith("/modelle-v1/ggml-tiny.bin")
    assert "huggingface" not in w.quelle("ggml-tiny.bin")


def test_quelle_laesst_sich_umbiegen(monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_GGML_URL", "http://spiegel.example/{datei}")
    assert w.quelle("ggml-tiny.bin") == "http://spiegel.example/ggml-tiny.bin"


def test_ssl_kontext_nutzt_certifi():
    """python.org-Python nutzt auf macOS NICHT die System-Keychain — ohne eigenes
    CA-Bundle scheitert urlopen mit CERTIFICATE_VERIFY_FAILED, und genau so ein Python
    legt electron/setup.js die venv an. Der Fehler traf jeden Mac-Nutzer, nicht nur
    eine Entwicklermaschine."""
    import ssl as ssl_modul
    k = w.ssl_kontext()
    assert isinstance(k, ssl_modul.SSLContext)
    assert k.verify_mode == ssl_modul.CERT_REQUIRED     # niemals ungeprueft laden


def test_ssl_kontext_ohne_certifi_faellt_auf_die_vorgabe(monkeypatch):
    """Fehlt certifi, ist Pythons Vorgabe immer noch besser als ein Absturz beim
    Import — auf Linux und Windows traegt sie ohnehin."""
    monkeypatch.setitem(sys.modules, "certifi", None)
    assert w.ssl_kontext() is None


def test_verfuegbar_braucht_binary_und_stufe(monkeypatch):
    monkeypatch.setattr(w, "binaer", lambda: "/usr/local/bin/whisper-cli")
    assert w.verfuegbar("large-v3")
    assert not w.verfuegbar("large-v1")
    monkeypatch.setattr(w, "binaer", lambda: "")
    assert not w.verfuegbar("large-v3")


def test_modell_datei_laedt_nicht_neu_wenn_da(monkeypatch, tmp_path):
    """Ein vorhandenes Modell darf keinen Netzzugriff ausloesen — sonst zahlt jeder
    Start 1 GB."""
    monkeypatch.setenv("TRANSKRIBOR_GGML", str(tmp_path))
    (tmp_path / w.MODELL_DATEIEN["large-v3"]).write_bytes(b"ggml")
    def keinnetz(*a, **k):
        raise AssertionError("es wurde geladen, obwohl das Modell da ist")
    monkeypatch.setattr(w.urllib.request, "urlopen", keinnetz)
    assert w.modell_datei("large-v3") == str(tmp_path / w.MODELL_DATEIEN["large-v3"])


def test_modell_datei_meldet_die_url_im_fehler(monkeypatch, tmp_path):
    """Scheitert der Download, muss die Meldung sagen WO er scheiterte — sonst sucht
    der Nutzer den Fehler in seiner Einrichtung statt am fehlenden Release-Asset."""
    monkeypatch.setenv("TRANSKRIBOR_GGML", str(tmp_path))
    def kaputt(*a, **k):
        raise OSError("kein Netz")
    monkeypatch.setattr(w.urllib.request, "urlopen", kaputt)
    with pytest.raises(RuntimeError, match="modelle-v1"):
        w.modell_datei("large-v3", onLine=lambda z: None)


class _Antwort:
    """urlopen-Attrappe, die WENIGER liefert als ihr Content-Length verspricht."""

    def __init__(self, bytes_gesagt, bytes_geliefert):
        self.headers = {"Content-Length": str(bytes_gesagt)}
        self._rest = b"x" * bytes_geliefert

    def read(self, n):
        block, self._rest = self._rest[:n], self._rest[n:]
        return block

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_abgeschnittener_download_wird_verworfen(monkeypatch, tmp_path):
    """Liefert der Server weniger als angekuendigt, endet die Leseschleife regulaer.
    Ohne Laengenpruefung landete die halbe Datei im Cache und JEDER folgende Start
    haette sie als fertig akzeptiert — whisper-cli waere dauerhaft kaputt, ohne dass
    jemand auf die Idee kaeme, ein "vorhandenes" Modell zu loeschen."""
    monkeypatch.setenv("TRANSKRIBOR_GGML", str(tmp_path))
    monkeypatch.setattr(w.urllib.request, "urlopen",
                        lambda *a, **k: _Antwort(1000, 400))
    with pytest.raises(RuntimeError, match="nicht ladbar"):
        w.modell_datei("large-v3", onLine=lambda z: None)
    assert list(tmp_path.iterdir()) == []          # auch die .teil-Datei ist weg


def test_vollstaendiger_download_wird_uebernommen(monkeypatch, tmp_path):
    """Der Gegenfall — sonst prueft der Test darueber nur, dass ueberhaupt etwas wirft."""
    monkeypatch.setenv("TRANSKRIBOR_GGML", str(tmp_path))
    monkeypatch.setattr(w.urllib.request, "urlopen",
                        lambda *a, **k: _Antwort(1000, 1000))
    ziel = w.modell_datei("large-v3", onLine=lambda z: None)
    assert os.path.getsize(ziel) == 1000
    assert not os.path.exists(ziel + ".teil")


def test_download_ohne_content_length_wird_uebernommen(monkeypatch, tmp_path):
    """Ohne Content-Length gibt es nichts zu vergleichen — dann darf die Pruefung nicht
    faelschlich anschlagen und einen gueltigen Download wegwerfen."""
    monkeypatch.setenv("TRANSKRIBOR_GGML", str(tmp_path))
    antwort = _Antwort(0, 500)
    antwort.headers = {}
    monkeypatch.setattr(w.urllib.request, "urlopen", lambda *a, **k: antwort)
    assert os.path.getsize(w.modell_datei("large-v3", onLine=lambda z: None)) == 500


def test_abgebrochener_download_hinterlaesst_keine_halbe_datei(monkeypatch, tmp_path):
    """Eine halbe Datei saehe beim naechsten Start "da" aus und liesse whisper-cli mit
    einer unverstaendlichen Meldung sterben."""
    monkeypatch.setenv("TRANSKRIBOR_GGML", str(tmp_path))
    def kaputt(*a, **k):
        raise OSError("Verbindung weg")
    monkeypatch.setattr(w.urllib.request, "urlopen", kaputt)
    with pytest.raises(RuntimeError):
        w.modell_datei("large-v3", onLine=lambda z: None)
    assert list(tmp_path.iterdir()) == []
