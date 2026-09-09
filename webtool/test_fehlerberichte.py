"""Tests zu webtool/fehlerberichte.py (#530b) — dieselben Zusagen wie electron/fehlerberichte.test.js.

Die Maskier-Tests sind zugleich die Pflicht-Mutationsprobe aus der Spec (#530, Abschnitt 6):
ein Transkriptsatz bzw. ein Basisname in einer Meldung darf das bearbeitete Ereignis nicht
erreichen. `before_send` wird direkt als reine Funktion gerufen — das ist das Abfangen des
Transports auf Einheitsebene; der echte Versand steht im Messlauf gegen den Sammler.
"""
import json
import sys
import types

import pytest

from webtool import fehlerberichte as fb

# ---------------------------------------------------------------- lesen

def test_lesen_fehlend_und_kaputt_heisst_aus(tmp_path):
    assert fb.lesen(str(tmp_path / "gibt-es-nicht.json")) == {"automatisch": False, "gefragt": None}
    kaputt = tmp_path / "kaputt.json"
    kaputt.write_text("{kein json", encoding="utf-8")
    assert fb.lesen(str(kaputt)) == {"automatisch": False, "gefragt": None}


def test_lesen_streift_ein_bom(tmp_path):
    # PowerShells Set-Content -Encoding utf8 schreibt eines; PR (a) las dann AUS bei AN.
    datei = tmp_path / "fehlerberichte.json"
    datei.write_bytes('{"automatisch": true, "gefragt": "2026-09-03"}'.encode("utf-8-sig"))
    assert fb.lesen(str(datei)) == {"automatisch": True, "gefragt": "2026-09-03"}


def test_lesen_fremd_geformt_heisst_aus(tmp_path):
    datei = tmp_path / "fremd.json"
    datei.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    assert fb.lesen(str(datei)) == {"automatisch": False, "gefragt": None}
    datei.write_text(json.dumps({"automatisch": "ja", "gefragt": 5}), encoding="utf-8")
    assert fb.lesen(str(datei)) == {"automatisch": False, "gefragt": None}


# ---------------------------------------------------------------- basen / namen

def test_basen_nimmt_alle_punkt_praefixe():
    assert fb.basen("Dr. Mueller Interview.m4a") == ["Dr", "Dr. Mueller Interview"]


def test_namen_laengste_zuerst_und_unlesbar_leer(tmp_path):
    (tmp_path / "Mueller-Interview").mkdir()
    (tmp_path / "Mueller-Interview" / "audio").mkdir()
    (tmp_path / "Mueller-Interview" / "audio" / "Mueller Interview 12.03.2026.m4a").write_bytes(b"")
    n = fb.namen(str(tmp_path))
    assert n["projekte"] == ["Mueller-Interview"]
    # Laengste Basis zuerst: "…12.03.2026" vor "…12.03" vor "…12" (nur PUNKT-Praefixe, kein Stueckeln mitten im Wort)
    assert n["dateien"] == ["Mueller Interview 12.03.2026", "Mueller Interview 12.03", "Mueller Interview 12"]
    assert fb.namen(str(tmp_path / "gibt-es-nicht")) == {"projekte": [], "dateien": []}


# ---------------------------------------------------------------- maskiere

def test_maskiere_schluessel_aller_fuenf_familien():
    texte = [
        "Key sk-abcdefghijklmnop123",
        "Key sk-ant-abcdefghijklmnop123",
        "Key AIzaSyabcdefghijklmnopqrstuv",
        "Key gsk_abcdefghijklmnopqrstuv",
        "Key hf_abcdefghijklmnopqrstuv",
    ]
    for t in texte:
        assert fb.maskiere(t) == "Key " + fb.SCHLUESSEL_ERSATZ


def test_maskiere_pfade_in_vier_schreibweisen(tmp_path):
    ctx = {"daten": r"C:\Users\marcu\AppData\Roaming\Transkribor"}
    roh = r"C:\Users\marcu\AppData\Roaming\Transkribor\transkribor.log"
    formen = [
        roh,                                        # wie notiert
        roh.replace("\\", "/"),                     # mit Schraegstrichen
        roh.replace("\\", "\\\\"),                  # JSON-kodiert
        "C:%5CUsers%5Cmarcu%5CAppData%5CRoaming%5CTranskribor%5Clog",  # URL-kodiert, Doppelpunkt roh
    ]
    for form in formen:
        assert "<daten>" in fb.maskiere("Fehler bei " + form, ctx), form


def test_maskiere_namen_in_nfc_nfd_und_url():
    ctx = {"namen": {"projekte": ["Büro"], "dateien": []}}
    for form in ["Büro", "Büro", "B%C3%BCro", "Bu%CC%88ro"]:
        assert fb.maskiere("Projekt " + form + " gescheitert", ctx) == "Projekt <projekt> gescheitert", form


def test_maskiere_datei_vor_projekt_und_laengste_zuerst():
    ctx = {"namen": {"projekte": ["Mueller"], "dateien": ["Mueller Interview"]}}
    t = fb.maskiere("Mueller Interview und Mueller", ctx)
    assert t == "<datei> und <projekt>"


def test_maskiere_laesst_fremdes_und_leeres_unberuehrt():
    ctx = {"home": "/home/marcu"}
    assert fb.maskiere("C:\\Ganz\\Anders\\Pfad.txt", ctx) == "C:\\Ganz\\Anders\\Pfad.txt"
    assert fb.maskiere("", ctx) == ""
    assert fb.maskiere(None, ctx) is None
    assert fb.maskiere(42, ctx) == 42


# ---------------------------------------------------------------- maskiere_tief / ereignis

def test_maskiere_tief_zyklus_und_nur_inhaltsfelder():
    tief = {"message": "x", "sdkProcessingMetadata": {"x": 1}}
    tief["selbst"] = tief
    aus = fb.maskiere_tief(tief, {"namen": {"projekte": [], "dateien": []}})
    assert aus["selbst"] == "[Zyklus]"
    assert aus["sdkProcessingMetadata"] == {"x": 1}  # kein Inhaltsfeld, bleibt Identitaet


def test_ereignis_maskieren_nur_inhaltsfelder():
    event = {"message": "Projekt Mueller", "event_id": "abc", "sdk": {"x": "Mueller"}}
    aus = fb.ereignis_maskieren(event, {"namen": {"projekte": ["Mueller"], "dateien": []}})
    assert aus["message"] == "Projekt <projekt>"
    assert aus["event_id"] == "abc"
    assert aus["sdk"] == {"x": "Mueller"}  # gehoert dem SDK, kein Nutzertext


# ---------------------------------------------------------------- before_send

@pytest.fixture()
def meldeweg(tmp_path, monkeypatch):
    """Schalter AN + Projekte-Wurzel mit Namen, Umgebung darauf gebogen."""
    projekte = tmp_path / "projekte"
    (projekte / "Mueller-Interview").mkdir(parents=True)
    (projekte / "Mueller-Interview" / "audio").mkdir()
    (projekte / "Mueller-Interview" / "audio" / "Mueller Interview 12.03.2026.m4a").write_bytes(b"")
    schalter = tmp_path / "fehlerberichte.json"
    schalter.write_text(json.dumps({"automatisch": True, "gefragt": "2026-09-03"}), encoding="utf-8")
    monkeypatch.setenv("TRANSKRIBOR_FEHLERBERICHTE", str(schalter))
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(projekte))
    return {"projekte": str(projekte), "schalter": str(schalter)}


def test_before_send_aus_verwirft_ganz(meldeweg, monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_FEHLERBERICHTE", meldeweg["schalter"] + ".aus")
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", meldeweg["projekte"])
    assert fb.before_send({"message": "x"}) is None


def test_before_send_streicht_request_ganz(meldeweg):
    aus = fb.before_send({"message": "x", "request": {"url": "http://127.0.0.1/api/projects/Mueller-Interview"}})
    assert "request" not in aus


def test_before_send_plichtprobe_namen_erreichen_das_ereignis_nicht(meldeweg):
    """Spec 6, Pflicht-Mutationsprobe: Transkriptsatz und Basisname duerfen nicht durch."""
    event = {
        "message": "Fehler in C:\\x\\projekte\\Mueller-Interview\\audio\\Mueller Interview 12.03.2026.m4a",
        "extra": {"kontext": "Wir haben dann im Mueller-Interview besprochen, wie es weitergeht"},
        "exception": {"values": [{"type": "RuntimeError", "value": "Mueller Interview 12.03.2026 failed"}]},
    }
    aus = fb.before_send(event)
    zusammen = json.dumps(aus)
    assert "Mueller" not in zusammen
    assert "<projekt>" in zusammen and "<datei>" in zusammen


def test_before_send_llm_fragment_wird_zu_typ_und_kategorie(meldeweg):
    event = {"exception": {"values": [{
        "type": "RuntimeError",
        "value": "Antwort des Modells war muell: sk-ant-abcdefghijklmno undmehr text",
        "stacktrace": {"frames": [{"filename": "E:/Git/Transkribor/webtool/llm.py", "function": "complete"}]},
    }]}}
    aus = fb.before_send(event)
    wert = aus["exception"]["values"][0]["value"]
    assert wert == "[RuntimeError: unbekannt]"
    assert "sk-ant-" not in wert


# ---------------------------------------------------------------- init

def test_init_ohne_die_drei_variablen_ist_noop_und_importiert_nichts(monkeypatch):
    for var in ("TRANSKRIBOR_BUGSINK_DSN", "TRANSKRIBOR_VERSION", "TRANSKRIBOR_FEHLERBERICHTE"):
        monkeypatch.delenv(var, raising=False)
    sys.modules.pop("sentry_sdk", None)
    assert fb.init() is False
    assert fb.aktiv() is False
    assert "sentry_sdk" not in sys.modules


@pytest.fixture()
def sentry_attrappe(monkeypatch):
    """Ein fake sentry_sdk in sys.modules, das init()-Aufrufe mitzaehlt."""
    aufrufe = {}
    modul = types.ModuleType("sentry_sdk")
    modul.init = lambda **kwargs: aufrufe.setdefault("init", kwargs)
    modul.capture_exception = lambda e: aufrufe.setdefault("capture", str(e))
    modul.flush = lambda t: aufrufe.setdefault("flush", t) or True
    for name in ("dedupe", "excepthook", "atexit", "threading", "asyncio", "starlette"):
        teile = types.ModuleType(f"sentry_sdk.integrations.{name}")
        klassenname = {"dedupe": "DedupeIntegration", "excepthook": "ExcepthookIntegration",
                       "atexit": "AtexitIntegration", "threading": "ThreadingIntegration",
                       "asyncio": "AsyncioIntegration", "starlette": "StarletteIntegration"}[name]
        setattr(teile, klassenname, type(klassenname, (), {}))
        monkeypatch.setitem(sys.modules, f"sentry_sdk.integrations.{name}", teile)
        monkeypatch.setattr(modul, "integrations", types.ModuleType("sentry_sdk.integrations"), raising=False)
    monkeypatch.setitem(sys.modules, "sentry_sdk", modul)
    try:
        yield aufrufe
    finally:
        fb._zuruecksetzen()


def test_init_mit_allem_initialisiert_und_laesst_probe_nur_bei_exakt_eins(monkeypatch, tmp_path, sentry_attrappe):
    monkeypatch.setenv("TRANSKRIBOR_BUGSINK_DSN", "http://k@127.0.0.1:9/1")
    monkeypatch.setenv("TRANSKRIBOR_VERSION", "0.0.0-test")
    monkeypatch.setenv("TRANSKRIBOR_FEHLERBERICHTE", str(tmp_path / "fehlerberichte.json"))
    monkeypatch.setenv("TRANSKRIBOR_FEHLERPROBE", "true")  # NICHT "1" — darf nicht werfen
    assert fb.init() is True
    assert fb.aktiv() is True
    assert "capture" not in sentry_attrappe
    kwargs = sentry_attrappe["init"]
    assert kwargs["release"] == "transkribor@0.0.0-test"
    assert kwargs["environment"] == "gepackt"
    assert kwargs["send_default_pii"] is False
    assert kwargs["include_local_variables"] is False
    assert kwargs["auto_session_tracking"] is False
    assert kwargs["default_integrations"] is False
    assert len(kwargs["integrations"]) == 6
    monkeypatch.setenv("TRANSKRIBOR_FEHLERPROBE", "1")
    assert fb.init() is True
    assert sentry_attrappe["capture"] == fb.FEHLERPROBE


def test_init_wirft_nie_auch_bei_kaputtem_sdk(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_BUGSINK_DSN", "http://k@127.0.0.1:9/1")
    monkeypatch.setenv("TRANSKRIBOR_VERSION", "0.0.0-test")
    monkeypatch.setenv("TRANSKRIBOR_FEHLERBERICHTE", str(tmp_path / "fehlerberichte.json"))

    class Boese(types.ModuleType):
        def __getattr__(self, name):
            raise RuntimeError("SDK kaputt")

    monkeypatch.setitem(sys.modules, "sentry_sdk", Boese("sentry_sdk"))
    assert fb.init() is False  # nicht Wurf: der Serverstart/Job darf nie daran sterben


def test_erlaubnisliste_gegen_das_installierte_paket():
    """Jeder Name der Erlaubnisliste muss es im installierten Paket geben — ein Name, den es
    nicht gibt, ist ein stilles Loch in der Liste (Lehre aus LocalVariablesAsync)."""
    pytest.importorskip("sentry_sdk", reason="sentry-sdk erst mit der gepackten venv Pflicht")
    import importlib
    pfade = {
        "DedupeIntegration": "sentry_sdk.integrations.dedupe",
        "ExcepthookIntegration": "sentry_sdk.integrations.excepthook",
        "AtexitIntegration": "sentry_sdk.integrations.atexit",
        "ThreadingIntegration": "sentry_sdk.integrations.threading",
        "AsyncioIntegration": "sentry_sdk.integrations.asyncio",
        "StarletteIntegration": "sentry_sdk.integrations.starlette",
    }
    assert set(fb.ERLAUBT) == set(pfade), "ERLAUBT und der Test muessen dieselben sechs Namen tragen"
    for name, pfad in pfade.items():
        assert hasattr(importlib.import_module(pfad), name), f"{pfad}.{name} fehlt im Paket"
