"""Vertrag des gezielten Windows-TLS-Clients für Hugging Face."""

import ssl
import sys
from types import ModuleType, SimpleNamespace

from webtool import hf_tls


def test_windows_uses_system_context_and_preserves_hub_client_contract(monkeypatch):
    seen_requests = []

    def hook(request):
        seen_requests.append(request)
    original = SimpleNamespace(event_hooks={"request": [hook]}, follow_redirects=True, timeout=None)
    factories = []
    hub = ModuleType("huggingface_hub")
    hub.get_session = lambda: original
    hub.set_client_factory = factories.append
    httpx = ModuleType("httpx")
    httpx.Client = lambda **kwargs: SimpleNamespace(**kwargs)
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    monkeypatch.setitem(sys.modules, "httpx", httpx)
    monkeypatch.setattr(hf_tls, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(hf_tls, "_configured", False)

    hf_tls.configure()
    hf_tls.configure()

    assert len(factories) == 1
    client = factories[0]()
    assert isinstance(client.verify, ssl.SSLContext)
    assert client.event_hooks == original.event_hooks
    assert client.follow_redirects is True
    assert client.timeout is None


def test_non_windows_keeps_hub_client_untouched(monkeypatch):
    monkeypatch.setattr(hf_tls, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(hf_tls, "_configured", False)
    monkeypatch.setitem(sys.modules, "huggingface_hub", None)

    hf_tls.configure()

    assert hf_tls._configured is False
