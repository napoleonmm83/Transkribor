"""Vertrag fuer die optionale, selbst gepflegte NeMo-Umgebung."""

import json
from contextlib import contextmanager

import pytest

from webtool import nemotron_setup, sperre, ytdlp_update


# AIRLOCK-OHNE-PLANWERKZEUG: Der Benutzer hat die automatische Installation und
# Aktualisierung beauftragt; diese Laufzeit bietet kein update_plan-Werkzeug.
def test_status_erkennt_py_pi_3_0_nicht_als_nemotron_tauglich(monkeypatch, tmp_path):
    monkeypatch.setattr(nemotron_setup, "_marker_path", lambda: tmp_path / "marker.json")
    monkeypatch.setattr(nemotron_setup, "_version", lambda name: {
        "nemo-toolkit": "3.0.0", "lhotse": "1.33.0", "triton-windows": None,
        "torch": "2.11.0+cu128",
    }.get(name))
    assert nemotron_setup.zustand()["bereit"] is False


def test_beschaedigte_paketmetadaten_lassen_settings_lesbar(monkeypatch):
    def defekt(name):
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "defekt")

    monkeypatch.setattr(nemotron_setup.metadata, "version", defekt)
    assert nemotron_setup.zustand()["bereit"] is False
    assert nemotron_setup.zustand()["version"] == ""


def test_status_erkennt_geprueften_quellstand(monkeypatch, tmp_path):
    monkeypatch.setattr(nemotron_setup, "_marker_path", lambda: tmp_path / "marker.json")
    monkeypatch.setattr(nemotron_setup, "_version", lambda name: {
        "nemo-toolkit": "3.1.0+cf724ac", "lhotse": "2.0.0a6",
        "triton-windows": "3.6.0.post26", "torch": "2.11.0+cu128",
    }.get(name))
    assert nemotron_setup.zustand()["bereit"] is True


def test_installation_nutzt_offizielle_revision_und_prueft_import(monkeypatch, tmp_path):
    monkeypatch.setattr(nemotron_setup, "_marker_path", lambda: tmp_path / "marker.json")
    monkeypatch.setattr(nemotron_setup, "_latest_revision", lambda: nemotron_setup.BASELINE_REVISION)
    monkeypatch.setattr(nemotron_setup, "_version", lambda name: {
        "nemo-toolkit": "3.0.0", "lhotse": "1.33.0", "torch": "2.11.0+cu128",
    }.get(name))
    calls = []
    monkeypatch.setattr(nemotron_setup, "_run", lambda args, timeout: calls.append(args) or None)
    nemotron_setup._install(force=True)
    assert any("codeload.github.com/NVIDIA-NeMo/Speech/zip/" in " ".join(c) for c in calls)
    assert any("triton-windows==3.6.0.post26" in " ".join(c) for c in calls)
    assert any("SortformerEncLabelModel" in " ".join(c) for c in calls)
    assert json.loads((tmp_path / "marker.json").read_text())["revision"] == nemotron_setup.BASELINE_REVISION


def test_nemo_nutzt_dieselbe_pip_sperre_wie_ytdlp(monkeypatch, tmp_path):
    monkeypatch.setattr(nemotron_setup, "_faellig", lambda: True)
    monkeypatch.setattr(ytdlp_update, "_lockziel", lambda: str(tmp_path / "pip"))
    gehalten = False

    @contextmanager
    def fake_sperre(pfad, **kwargs):
        nonlocal gehalten
        assert pfad == ytdlp_update._lockziel()
        assert kwargs["stale"] >= 10 + 900 + 300 + 120
        gehalten = True
        try:
            yield True
        finally:
            gehalten = False

    monkeypatch.setattr(sperre, "datei", fake_sperre)
    monkeypatch.setattr(nemotron_setup, "_install_gesperrt", lambda force: gehalten)
    assert nemotron_setup._install(force=True) is True
    assert gehalten is False


def test_shutdown_gibt_nur_eigenen_laufenden_pip_merker_auf(monkeypatch):
    calls = []
    monkeypatch.setattr(sperre, "merker_aufgeben", lambda ziel: calls.append(ziel) or True)
    monkeypatch.setattr(ytdlp_update, "_lockziel", lambda: "pip-lock")
    monkeypatch.setattr(nemotron_setup, "_haelt_pip_lock", False)
    assert nemotron_setup.beim_ende() is False
    assert calls == []
    monkeypatch.setattr(nemotron_setup, "_haelt_pip_lock", True)
    assert nemotron_setup.beim_ende() is True
    assert calls == ["pip-lock"]


def test_fehlgeschlagenes_upgrade_entwertet_alten_erfolgsmarker(monkeypatch, tmp_path):
    marker = tmp_path / "marker.json"
    marker.write_text(json.dumps({"revision": "0" * 40, "version": "3.1.0",
                                  "geprueft": "2026-09-24"}), encoding="utf-8")
    monkeypatch.setattr(nemotron_setup, "_marker_path", lambda: marker)
    monkeypatch.setattr(nemotron_setup, "_latest_revision", lambda: nemotron_setup.BASELINE_REVISION)
    monkeypatch.setattr(nemotron_setup, "_version", lambda name: {
        "nemo-toolkit": "3.1.0", "lhotse": "2.0.0a6", "torch": "2.11.0+cu128",
        "triton-windows": "3.6.0.post26",
    }.get(name))
    monkeypatch.setattr(nemotron_setup, "_run", lambda args, timeout: "pip gescheitert")
    with pytest.raises(RuntimeError, match="NeMo-Installation"):
        nemotron_setup._install_gesperrt(force=True)
    assert nemotron_setup.zustand()["bereit"] is False


def test_defekter_import_repariert_auch_bei_aktueller_revision(monkeypatch, tmp_path):
    marker = tmp_path / "marker.json"
    marker.write_text(json.dumps({"revision": nemotron_setup.BASELINE_REVISION,
                                  "version": "3.1.0", "geprueft": "2026-09-24"}),
                      encoding="utf-8")
    monkeypatch.setattr(nemotron_setup, "_marker_path", lambda: marker)
    monkeypatch.setattr(nemotron_setup, "_latest_revision", lambda: nemotron_setup.BASELINE_REVISION)
    monkeypatch.setattr(nemotron_setup, "_version", lambda name: {
        "nemo-toolkit": "3.1.0", "lhotse": "2.0.0a6", "torch": "2.11.0+cu128",
        "triton-windows": "3.6.0.post26",
    }.get(name))
    calls = []

    def run(args, timeout):
        calls.append(args)
        return "ImportError: kaputt" if args[0] == "-c" and len(calls) == 1 else None

    monkeypatch.setattr(nemotron_setup, "_run", run)
    assert nemotron_setup._install_gesperrt(force=True) == "installiert"
    assert any("--force-reinstall" in call for call in calls)
    assert any("lhotse==2.0.0a6" in call for call in calls)
    assert any("triton-windows==3.6.0.post26" in call for call in calls)
    assert nemotron_setup.zustand()["bereit"] is True
