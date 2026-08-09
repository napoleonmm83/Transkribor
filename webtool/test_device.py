"""Geraetewahl — mit gefaelschtem torch, damit der Test ohne GPU ueberall laeuft."""
import sys
import types

import pytest

from webtool import device


@pytest.fixture(autouse=True)
def kein_apple_silicon(monkeypatch):
    """Standardmaessig NICHT auf einem M-Mac.

    Ohne das haengen die describe()-Tests an der Maschine: auf einem Entwickler-Mac mit
    installiertem whisper-cli meldet asr_engine() "whisper.cpp" und `asr` wird "metal",
    in der Linux-CI dagegen nicht. Ein Test, der nur auf einem der beiden Rechner gruen
    ist, prueft nichts. Die Apple-Silicon-Faelle setzen die Sperre gezielt zurueck.
    """
    monkeypatch.setattr(device, "apple_silicon", lambda: False)


def _torch(cuda=False, mps=False, name="Fake GPU"):
    """Minimales torch-Double: nur was device.py anfasst."""
    t = types.ModuleType("torch")
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda,
                                   get_device_name=lambda i: name)
    t.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: mps))
    return t


def test_cuda_gewinnt_vor_mps(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=True, mps=True))
    assert device.pick() == "cuda"


def test_mps_wenn_kein_cuda(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=False, mps=True))
    assert device.pick() == "mps"


def test_cpu_wenn_nichts_da(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=False, mps=False))
    assert device.pick() == "cpu"


def test_alte_torch_version_ohne_mps_backend(monkeypatch):
    """torch < 1.12 kennt torch.backends.mps nicht — darf nicht werfen."""
    t = _torch()
    t.backends = types.SimpleNamespace()
    monkeypatch.setitem(sys.modules, "torch", t)
    assert device.pick() == "cpu"


def test_ohne_torch_kein_absturz(monkeypatch):
    """sys.modules[name] = None laesst `import torch` ein ImportError werfen."""
    monkeypatch.setitem(sys.modules, "torch", None)
    assert device.pick() == "cpu"
    assert device.describe() == {"device": "cpu", "name": "PyTorch nicht installiert",
                                 "torch_ok": False, "asr": "cpu",
                                 "asr_engine": "faster-whisper"}


def test_describe_nennt_die_gpu(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=True, name="NVIDIA RTX 5080"))
    assert device.describe() == {"device": "cuda", "name": "NVIDIA RTX 5080",
                                 "torch_ok": True, "asr": "cuda",
                                 "asr_engine": "faster-whisper"}


def test_describe_apple(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(mps=True))
    d = device.describe()
    assert d["device"] == "mps" and d["torch_ok"] is True


def test_pick_asr_faellt_von_mps_auf_cpu(monkeypatch):
    """CTranslate2 (faster-whisper) kennt nur cpu/cuda. Wuerde pick() durchgereicht,
    lehnte es "mps" ab — auf einem Mac liefe gar keine Transkription mehr."""
    monkeypatch.setattr(device, "pick", lambda: "mps")
    assert device.pick_asr() == "cpu"


def test_pick_asr_behaelt_cuda(monkeypatch):
    monkeypatch.setattr(device, "pick", lambda: "cuda")
    assert device.pick_asr() == "cuda"


def test_describe_nennt_asr_getrennt(monkeypatch):
    """Auf einem Mac OHNE whisper.cpp meldet device "mps" (Diarisierung), die ASR laeuft
    aber auf der CPU. Ohne dieses Feld behauptete die Oberflaeche GPU, waehrend die CPU
    rechnet."""
    monkeypatch.setattr(device, "pick", lambda: "mps")
    d = device.describe()
    if d["torch_ok"]:                      # ohne torch (CI-Job) ist der Fall nicht pruefbar
        assert d["device"] == "mps" and d["asr"] == "cpu"


# --- Engine-Wahl: faster-whisper oder whisper.cpp ---

def _wcpp(monkeypatch, binaer="/opt/homebrew/bin/whisper-cli"):
    """whispercpp so faelschen, dass keine echte Platte und kein echtes Binary noetig ist."""
    from webtool import whispercpp
    monkeypatch.setattr(whispercpp, "binaer", lambda: binaer)
    return whispercpp


def test_engine_ausserhalb_apple_silicon_immer_faster_whisper(monkeypatch):
    """Windows und Linux fahren mit CUDA besser — dort wird nie verzweigt."""
    _wcpp(monkeypatch)
    monkeypatch.setattr(device, "apple_silicon", lambda: False)
    assert device.asr_engine("large-v3") == "faster-whisper"


def test_engine_auf_apple_silicon_ist_whispercpp(monkeypatch):
    _wcpp(monkeypatch)
    monkeypatch.setattr(device, "apple_silicon", lambda: True)
    assert device.asr_engine("large-v3") == "whisper.cpp"


def test_engine_ohne_binary_faellt_zurueck(monkeypatch):
    """Wer `brew install whisper-cpp` nicht ausgefuehrt hat, soll transkribieren koennen —
    langsam, aber ueberhaupt."""
    _wcpp(monkeypatch, binaer="")
    monkeypatch.setattr(device, "apple_silicon", lambda: True)
    assert device.asr_engine("large-v3") == "faster-whisper"


def test_engine_faellt_bei_unbekannter_stufe_zurueck(monkeypatch):
    """large-v1 und die .en-Varianten liegen nicht am GitHub-Release. Ohne diesen
    Rueckfall stuerbe so eine Stufe mit einem 404 statt langsam zu rechnen."""
    _wcpp(monkeypatch)
    monkeypatch.setattr(device, "apple_silicon", lambda: True)
    assert device.asr_engine("large-v1") == "faster-whisper"


def test_describe_meldet_metal_wenn_whispercpp_rechnet(monkeypatch):
    """Die Anzeige darf nicht "cpu" behaupten, waehrend Metal rechnet — dieselbe Regel,
    aus der `asr` ueberhaupt entstanden ist."""
    _wcpp(monkeypatch)
    monkeypatch.setattr(device, "apple_silicon", lambda: True)
    monkeypatch.setattr(device, "pick", lambda: "mps")
    d = device.describe("large-v3")
    assert d["asr"] == "metal" and d["asr_engine"] == "whisper.cpp"


def test_describe_ohne_torch_meldet_trotzdem_metal(monkeypatch):
    """whisper.cpp braucht kein torch. Eine Umgebung ohne torch verliert die
    Sprechertrennung, nicht die Transkription — die Anzeige muss das unterscheiden."""
    _wcpp(monkeypatch)
    monkeypatch.setattr(device, "apple_silicon", lambda: True)
    monkeypatch.setitem(sys.modules, "torch", None)
    d = device.describe("large-v3")
    assert d["torch_ok"] is False and d["asr"] == "metal"
