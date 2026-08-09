"""Geraetewahl — mit gefaelschtem torch, damit der Test ohne GPU ueberall laeuft."""
import sys
import types

from webtool import device


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
                                 "torch_ok": False, "asr": "cpu"}


def test_describe_nennt_die_gpu(monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", _torch(cuda=True, name="NVIDIA RTX 5080"))
    assert device.describe() == {"device": "cuda", "name": "NVIDIA RTX 5080",
                                 "torch_ok": True, "asr": "cuda"}


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
    """Auf einem Mac meldet device "mps" (Diarisierung), die ASR laeuft aber auf der CPU.
    Ohne dieses Feld behauptete die Oberflaeche GPU, waehrend die CPU rechnet."""
    monkeypatch.setattr(device, "pick", lambda: "mps")
    d = device.describe()
    if d["torch_ok"]:                      # ohne torch (CI-Job) ist der Fall nicht pruefbar
        assert d["device"] == "mps" and d["asr"] == "cpu"
