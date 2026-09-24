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
    monkeypatch.setattr(nemotron_setup, "_latest_revision", lambda: nemotron_setup.GEPRUEFTE_REVISION)
    monkeypatch.setattr(nemotron_setup, "_version", lambda name: {
        "nemo-toolkit": "3.0.0", "lhotse": "1.33.0", "torch": "2.11.0+cu128",
    }.get(name))
    calls = []
    monkeypatch.setattr(nemotron_setup, "_run", lambda args, timeout: calls.append(args) or None)
    nemotron_setup._install(force=True)
    assert any("codeload.github.com/NVIDIA-NeMo/Speech/zip/" in " ".join(c) for c in calls)
    assert any("triton-windows==3.6.0.post26" in " ".join(c) for c in calls)
    assert any("SortformerEncLabelModel" in " ".join(c) for c in calls)
    marker = json.loads((tmp_path / "marker.json").read_text())
    assert marker["revision"] == nemotron_setup.GEPRUEFTE_REVISION
    # Der Knopf hat hier genau den Pin geholt: das gilt als Automatik-Fassung, sonst
    # erreichte ein spaeterer Pin-Wechsel diese Installation nie mehr.
    assert marker["quelle"] == "auto"


# Entscheidung Marcus 2026-09-24: automatisch nur die gepruefte Revision; eine per
# Knopf geholte Fassung fasst die Automatik nie an; eine neuere gepruefte kommt mit
# einem Transkribor-Update (= neuer Pin).
_BEREIT = {"nemo-toolkit": "3.1.0", "lhotse": "2.0.0a6", "torch": "2.11.0+cu128",
           "triton-windows": "3.6.0.post26"}


def _marker_setzen(monkeypatch, tmp_path, inhalt, versionen=_BEREIT):
    marker = tmp_path / "marker.json"
    if inhalt is not None:
        marker.write_text(json.dumps(inhalt), encoding="utf-8")
    monkeypatch.setattr(nemotron_setup, "_marker_path", lambda: marker)
    monkeypatch.setattr(nemotron_setup, "_version", lambda name: versionen.get(name))
    return marker


def _kein_github():
    raise AssertionError("die Automatik darf den neuesten NVIDIA-Stand nie abfragen")


@pytest.mark.parametrize("inhalt", ["[]", "null", '"text"', "42"])
def test_marker_der_kein_objekt_ist_gilt_als_leer(monkeypatch, tmp_path, inhalt):
    # Gueltiges JSON, aber kein Objekt: `.get` darauf warf und riss den Serverstart
    # (Lifespan -> starten -> _faellig) und jeden Settings-GET mit.
    marker = tmp_path / "marker.json"
    marker.write_text(inhalt, encoding="utf-8")
    monkeypatch.setattr(nemotron_setup, "_marker_path", lambda: marker)
    monkeypatch.setattr(nemotron_setup, "_version", lambda name: _BEREIT.get(name))
    assert nemotron_setup._marker() == {}
    assert nemotron_setup.zustand()["bereit"] is False
    assert nemotron_setup._faellig() is True


def test_github_antwort_ohne_zeichenkette_meldet_ungueltige_revision(monkeypatch):
    class Antwort:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"sha": 12345}'

    monkeypatch.setattr(nemotron_setup.urllib.request, "urlopen", lambda *a, **k: Antwort())
    with pytest.raises(ValueError, match="ungueltige NVIDIA-Revision"):
        nemotron_setup._latest_revision()


def test_automatik_installiert_den_pin_ohne_github(monkeypatch, tmp_path):
    marker = _marker_setzen(monkeypatch, tmp_path, None,
                            {"nemo-toolkit": "3.0.0", "lhotse": "1.33.0", "torch": "2.11.0+cu128"})
    monkeypatch.setattr(nemotron_setup, "_latest_revision", _kein_github)
    calls = []
    monkeypatch.setattr(nemotron_setup, "_run", lambda args, timeout: calls.append(args) or None)
    assert nemotron_setup._install_gesperrt(force=False) == "installiert"
    zip_url = f"codeload.github.com/NVIDIA-NeMo/Speech/zip/{nemotron_setup.GEPRUEFTE_REVISION}"
    assert any(zip_url in " ".join(c) for c in calls)
    daten = json.loads(marker.read_text())
    assert daten["revision"] == nemotron_setup.GEPRUEFTE_REVISION
    assert daten["quelle"] == "auto"


def test_automatik_laesst_knopf_fassung_stehen(monkeypatch, tmp_path):
    _marker_setzen(monkeypatch, tmp_path, {"revision": "1" * 40, "version": "3.1.0",
                                           "geprueft": "2026-09-24", "quelle": "knopf"})
    monkeypatch.setattr(nemotron_setup, "_latest_revision", _kein_github)
    assert nemotron_setup._faellig() is False
    assert nemotron_setup._install_gesperrt(force=False) == "aktuell"


def test_automatik_hebt_alte_auto_fassung_auf_den_pin(monkeypatch, tmp_path):
    _marker_setzen(monkeypatch, tmp_path, {"revision": "0" * 40, "version": "3.1.0",
                                           "geprueft": "2026-09-24", "quelle": "auto"})
    assert nemotron_setup._faellig() is True


def test_alt_marker_ohne_quelle_gilt_als_automatik(monkeypatch, tmp_path):
    # So sieht der Marker jeder Installation vor dieser Aenderung aus.
    _marker_setzen(monkeypatch, tmp_path, {"revision": "0" * 40, "version": "3.1.0",
                                           "geprueft": "2026-09-24"})
    assert nemotron_setup._faellig() is True


def test_bereiter_pin_ist_nie_faellig_auch_nach_langer_zeit(monkeypatch, tmp_path):
    _marker_setzen(monkeypatch, tmp_path, {"revision": nemotron_setup.GEPRUEFTE_REVISION,
                                           "version": "3.1.0", "geprueft": "2020-01-01",
                                           "quelle": "auto"})
    assert nemotron_setup._faellig() is False


def test_fehlschlag_bremst_die_automatik_auf_einmal_je_tag(monkeypatch, tmp_path):
    heute = nemotron_setup.dt.date.today().isoformat()
    _marker_setzen(monkeypatch, tmp_path, {"fehlgeschlagen": True, "am": heute})
    assert nemotron_setup._faellig() is False
    _marker_setzen(monkeypatch, tmp_path, {"fehlgeschlagen": True, "am": "2000-01-01"})
    assert nemotron_setup._faellig() is True
    # Ein Fehlschlag-Marker aus der Zeit vor der Bremse traegt kein Datum.
    _marker_setzen(monkeypatch, tmp_path, {"fehlgeschlagen": True})
    assert nemotron_setup._faellig() is True


def test_entwerteter_marker_traegt_das_datum_fuer_die_bremse(monkeypatch, tmp_path):
    marker = _marker_setzen(monkeypatch, tmp_path, None,
                            {"nemo-toolkit": "3.0.0", "lhotse": "1.33.0", "torch": "2.11.0+cu128"})
    monkeypatch.setattr(nemotron_setup, "_run", lambda args, timeout: "pip gescheitert")
    with pytest.raises(RuntimeError, match="NeMo-Installation"):
        nemotron_setup._install_gesperrt(force=False)
    daten = json.loads(marker.read_text())
    assert daten["fehlgeschlagen"] is True
    assert daten["am"] == nemotron_setup.dt.date.today().isoformat()


def test_knopf_mit_neuerem_stand_markiert_die_fassung_als_knopf(monkeypatch, tmp_path):
    marker = _marker_setzen(monkeypatch, tmp_path, {
        "revision": nemotron_setup.GEPRUEFTE_REVISION, "version": "3.1.0",
        "geprueft": "2026-09-24", "quelle": "auto"})
    monkeypatch.setattr(nemotron_setup, "_latest_revision", lambda: "1" * 40)
    monkeypatch.setattr(nemotron_setup, "_run", lambda args, timeout: None)
    assert nemotron_setup._install_gesperrt(force=True) == "installiert"
    daten = json.loads(marker.read_text())
    assert daten["revision"] == "1" * 40
    assert daten["quelle"] == "knopf"


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
    monkeypatch.setattr(nemotron_setup, "_install_gesperrt", lambda force, neuester: gehalten)
    assert nemotron_setup._install(force=True) is True
    assert gehalten is False


def test_sperrfrist_deckt_den_laengsten_weg_durch_die_installation(monkeypatch, tmp_path):
    """Die Frist der gemeinsamen pip-Sperre ist eine Zusage ueber die HALTEDAUER (#207).

    Gemessen wird der laengste Weg WIRKLICH: Knopf (GitHub-Abruf), fehlschlagende
    Probe, dreifache Reparatur, zweite Probe. Gezaehlt werden die Deckel, die der Code
    an `_run` uebergibt — nicht eine hingeschriebene Summe. Eine naheliegende Summe
    MIT Triton-Nachzug (2050 s) ist unerreichbar: der Nachzug setzt `installiert`, und
    dann laeuft keine Reparatur. Genau das hat dieser Test beim Schreiben widerlegt.
    """
    _marker_setzen(monkeypatch, tmp_path, {
        "revision": nemotron_setup.GEPRUEFTE_REVISION, "version": "3.1.0",
        "geprueft": "2026-09-24", "quelle": "auto"})
    monkeypatch.setattr(nemotron_setup, "_latest_revision", lambda: nemotron_setup.GEPRUEFTE_REVISION)
    monkeypatch.setattr(nemotron_setup, "_triton_pin", lambda: "3.6.0.post26")
    deckel, aufrufe, proben = [], [], []

    def run(args, timeout):
        deckel.append(timeout)
        aufrufe.append(args)
        if args[0] == "-c":
            proben.append(args)
            return "ImportError: kaputt" if len(proben) == 1 else None
        return None

    monkeypatch.setattr(nemotron_setup, "_run", run)
    assert nemotron_setup._install_gesperrt(force=True) == "installiert"
    # Probe, Lhotse-, Triton-, NeMo-Reparatur, zweite Probe.
    assert len(deckel) == 5, f"nicht der laengste Weg gefahren: {aufrufe}"
    github_s = 10  # urlopen-Deckel in `_latest_revision`
    assert github_s + sum(deckel) < ytdlp_update._lock_stale()


def test_nemo_raeumt_eine_merkerlose_alte_sperre_nach_der_uhr(monkeypatch, tmp_path):
    """B1 (beide Kalt-Leser): `beim_ende()` gibt beim Shutdown den Merker auf und laesst die
    Sperre OHNE Auskunft liegen. Der strikte Warter raeumte die nie ab — jeder Start wartete
    32 min und scheiterte. Echte `sperre`, echtes Lock-Verzeichnis, nur die Frist verkuerzt."""
    import os
    import time
    lockziel = str(tmp_path / "pip")
    monkeypatch.setattr(ytdlp_update, "_lockziel", lambda: lockziel)
    monkeypatch.setattr(ytdlp_update, "_lock_stale", lambda: 0.2)
    monkeypatch.setattr(nemotron_setup, "_faellig", lambda: True)
    lockdir = lockziel + ".lock"
    os.mkdir(lockdir)                                   # Lock ohne Merker = keine Auskunft
    alt = time.time() - 3600
    os.utime(lockdir, (alt, alt))
    gerufen = []
    monkeypatch.setattr(nemotron_setup, "_install_gesperrt",
                        lambda force, neuester: gerufen.append((force, neuester)) or "aktuell")
    t0 = time.monotonic()
    assert nemotron_setup._install(force=True) == "aktuell"
    assert gerufen == [(True, True)]
    assert time.monotonic() - t0 < 30


def test_knopf_fassung_bleibt_auch_bei_triton_abweichung(monkeypatch, tmp_path):
    # B3: `_bereit` war False (nur Triton weicht ab) und stand VOR der Knopf-Pruefung — die
    # Automatik ersetzte dann die Knopf-Fassung durch den Pin.
    _marker_setzen(monkeypatch, tmp_path, {"revision": "1" * 40, "version": "3.1.0",
                                           "geprueft": "2026-09-24", "quelle": "knopf"},
                   {**_BEREIT, "triton-windows": "0.0.1"})
    monkeypatch.setattr(nemotron_setup, "_triton_pin", lambda: "3.6.0.post26")
    assert nemotron_setup._bereit(nemotron_setup._marker()) is False
    assert nemotron_setup._faellig() is False


def test_unpassendes_torch_scheitert_vor_jedem_pip(monkeypatch, tmp_path):
    # B4: torch ausserhalb der Triton-Tabelle. Vorher lief erst das 900-s-pip von NeMo, dann
    # warf `_triton_pin` — taeglich. Jetzt: nicht faellig, Grund sichtbar, und ein Knopf
    # scheitert, BEVOR pip startet.
    _marker_setzen(monkeypatch, tmp_path, None)
    grund = "Keine gepruefte Triton-Windows-Fassung fuer PyTorch 2.15.0+cu128"

    def pin():
        raise RuntimeError(grund)

    monkeypatch.setattr(nemotron_setup, "_triton_pin", pin)
    calls = []
    monkeypatch.setattr(nemotron_setup, "_run", lambda args, timeout: calls.append(args))
    assert nemotron_setup._faellig() is False
    assert nemotron_setup.zustand()["fehler"] == grund
    with pytest.raises(RuntimeError, match="Triton-Windows"):
        nemotron_setup._install_gesperrt(force=True, neuester=False)
    assert calls == []


def test_gepruefter_knopf_uebergeht_die_tagesbremse_und_bleibt_auf_dem_pin(monkeypatch, tmp_path):
    # B7: nach einem Fehlschlag fuehrte am selben Tag nur der ungepruefte Knopf weiter.
    heute = nemotron_setup.dt.date.today().isoformat()
    marker = _marker_setzen(monkeypatch, tmp_path, {"fehlgeschlagen": True, "am": heute},
                            {"nemo-toolkit": "3.0.0", "lhotse": "1.33.0", "torch": "2.11.0+cu128"})
    monkeypatch.setattr(nemotron_setup, "_latest_revision", _kein_github)
    calls = []
    monkeypatch.setattr(nemotron_setup, "_run", lambda args, timeout: calls.append(args) or None)
    assert nemotron_setup._faellig() is False           # die Automatik bleibt gebremst
    assert nemotron_setup._install_gesperrt(force=True, neuester=False) == "installiert"
    zip_url = f"codeload.github.com/NVIDIA-NeMo/Speech/zip/{nemotron_setup.GEPRUEFTE_REVISION}"
    assert any(zip_url in " ".join(c) for c in calls)
    assert json.loads(marker.read_text())["quelle"] == "auto"


def test_ytdlp_zustand_meldet_die_nemo_sperre(monkeypatch):
    # B2: die Sperre ist geteilt; ohne das Feld sagte die yt-dlp-Zeile "laeuft gerade".
    monkeypatch.setattr(nemotron_setup, "_haelt_pip_lock", True)
    assert ytdlp_update.zustand()["nemo_haelt"] is True
    monkeypatch.setattr(nemotron_setup, "_haelt_pip_lock", False)
    assert ytdlp_update.zustand()["nemo_haelt"] is False


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
    monkeypatch.setattr(nemotron_setup, "_latest_revision", lambda: nemotron_setup.GEPRUEFTE_REVISION)
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
    marker.write_text(json.dumps({"revision": nemotron_setup.GEPRUEFTE_REVISION,
                                  "version": "3.1.0", "geprueft": "2026-09-24"}),
                      encoding="utf-8")
    monkeypatch.setattr(nemotron_setup, "_marker_path", lambda: marker)
    monkeypatch.setattr(nemotron_setup, "_latest_revision", lambda: nemotron_setup.GEPRUEFTE_REVISION)
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
