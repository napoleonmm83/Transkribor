from webtool import diarize     # muss OHNE installiertes pyannote importierbar sein (lazy imports)


def _raw(segs):
    return {"language": "de", "segments": [
        {"id": i, "start": s, "end": e, "text": "x", "words": []} for i, (s, e) in enumerate(segs)]}


def test_assign_two_speakers_by_max_overlap():
    raw = _raw([(0.0, 2.0), (2.0, 4.0)])
    turns = [{"start": 0.0, "end": 2.0, "cluster": "SPEAKER_00"},
             {"start": 2.0, "end": 4.0, "cluster": "SPEAKER_01"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1", 1: "Sprecher 2"}


def test_numbering_follows_first_appearance_not_raw_label():
    # SPEAKER_01 spricht zuerst -> muss "Sprecher 1" werden
    raw = _raw([(0.0, 1.0), (1.0, 2.0)])
    turns = [{"start": 0.0, "end": 1.0, "cluster": "SPEAKER_01"},
             {"start": 1.0, "end": 2.0, "cluster": "SPEAKER_00"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1", 1: "Sprecher 2"}


def test_segment_straddling_boundary_takes_bigger_overlap():
    # Segment 1.5–4.0: 0.5s bei SPEAKER_00, 2.0s bei SPEAKER_01 -> SPEAKER_01
    raw = _raw([(1.5, 4.0)])
    turns = [{"start": 0.0, "end": 2.0, "cluster": "SPEAKER_00"},
             {"start": 2.0, "end": 4.0, "cluster": "SPEAKER_01"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 2"}


def test_no_overlap_inherits_previous():
    raw = _raw([(0.0, 2.0), (10.0, 11.0)])       # zweites Segment ausserhalb aller Turns
    turns = [{"start": 0.0, "end": 2.0, "cluster": "SPEAKER_00"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1", 1: "Sprecher 1"}


def test_over_segmentation_yields_three_labels():
    raw = _raw([(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)])
    turns = [{"start": 0.0, "end": 1.0, "cluster": "A"},
             {"start": 1.0, "end": 2.0, "cluster": "B"},
             {"start": 2.0, "end": 3.0, "cluster": "C"}]
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1", 1: "Sprecher 2", 2: "Sprecher 3"}


def test_first_segment_no_overlap_falls_back_to_earliest_cluster():
    # Erstes Segment ohne Overlap, kein Vorgänger (prev=None) -> frühester Cluster (nicht "SPEAKER_00")
    raw = _raw([(10.0, 11.0)])                        # ausserhalb aller Turns
    turns = [{"start": 2.0, "end": 3.0, "cluster": "A"},
             {"start": 0.0, "end": 1.0, "cluster": "B"}]   # B erscheint zuerst -> Sprecher 1
    assert diarize.assign_clusters(raw, turns) == {0: "Sprecher 1"}


def test_modell_liegt_im_repo():
    """Das Modell wird mitgeliefert statt von Hugging Face geladen — fehlt der Ordner (oder
    faellt er aus dem extraResources-Filter), gibt es keine Sprechertrennung mehr."""
    import os
    assert os.path.exists(diarize.DIAR_MODEL), diarize.DIAR_MODEL
    ordner = os.path.dirname(diarize.DIAR_MODEL)
    for teil in ("segmentation/pytorch_model.bin", "embedding/pytorch_model.bin",
                 "plda/plda.npz", "plda/xvec_transform.npz"):
        assert os.path.exists(os.path.join(ordner, *teil.split("/"))), teil


def test_pipeline_nutzt_geraetewahl_und_lokales_modell(monkeypatch):
    """Zwei Vertraege in einem Aufruf: dasselbe Geraet wie die Transkription (sonst rechnet
    die eine auf der GPU und die andere auf der CPU), und das Modell kommt aus dem lokalen
    Ordner — eine Repo-ID wuerde Hugging Face samt Token wieder einschleppen."""
    import types
    import sys
    from webtool import device, diarize

    gewaehlt, geladen = [], []
    fake_torch = types.ModuleType("torch")
    fake_torch.device = lambda d: f"torchdevice:{d}"
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(device, "pick", lambda: "mps")

    class FakePipe:
        def to(self, d):
            gewaehlt.append(d)
            return self

    def fake_from_pretrained(*a, **k):
        geladen.append((a, k))
        return FakePipe()

    fake_pa = types.ModuleType("pyannote.audio")
    fake_pa.Pipeline = types.SimpleNamespace(from_pretrained=fake_from_pretrained)
    monkeypatch.setitem(sys.modules, "pyannote", types.ModuleType("pyannote"))
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_pa)
    monkeypatch.setattr(diarize, "_PIPELINE", None)

    diarize._pipeline()
    assert gewaehlt == ["torchdevice:mps"]
    assert geladen == [((diarize.DIAR_MODEL,), {})]     # lokaler Pfad, kein token=
    monkeypatch.setattr(diarize, "_PIPELINE", None)      # Singleton nicht vergiften


def test_diarize_file_waehlt_num_speakers_ODER_min_speakers(monkeypatch):
    """Die Zeile, an der die vorgegebene Zahl bei pyannote ANKOMMT (#264).

    Sie hatte null Abdeckung, in der Mutationsprobe nachgemessen: fest auf
    `{"min_speakers": min_speakers}` verdrahtet blieben ALLE 771 Tests gruen. Grund ist die
    Arbeitsteilung der uebrigen Tests — `test_correct.py` faelscht `diarize_file` weg und
    misst damit nur die Durchreichung BIS zur Funktionsgrenze, und in dieser Datei rief bis
    hierher kein einziger Test `diarize_file`. Die Kette war also auf ihrem letzten Meter
    ungedeckt: genau der tote Schalter, den die Sidecar-Pruefung eine Ebene hoeher verhindert.

    **Beide Richtungen**, weil ein fest verdrahtetes `num_speakers` derselbe Schaden von der
    anderen Seite waere: es klemmte jede Datei OHNE Einstellung auf eine erfundene Zahl.

    Dass `num_speakers` ALLEIN steht, ist eine Klarheits-Entscheidung, keine Notwendigkeit:
    pyannote wirft dabei NICHT (nachgemessen an 4.0.7 — `utils/diarization.py:58` ueberschreibt
    `min_speakers` mit `num_speakers`), ein mitgeschicktes `min_speakers` waere schlicht
    wirkungslos. Der Test nagelt es trotzdem fest, damit am Aufrufort keine Grenze steht, die
    nichts tut."""
    gesehen = {}

    class _Ann:                       # was pyannote zurueckgibt; leer reicht, geprueft werden die kwargs
        def itertracks(self, yield_label=True):
            return []

    monkeypatch.setattr(diarize, "_load_waveform", lambda p: "audio")
    monkeypatch.setattr(diarize, "_pipeline",
                        lambda: lambda wave, **kw: gesehen.update(kw) or _Ann())
    diarize.diarize_file("x.m4a", min_speakers=2, num_speakers=5)
    assert gesehen == {"num_speakers": 5}          # exakt, und kein min_speakers daneben
    gesehen.clear()
    diarize.diarize_file("x.m4a", min_speakers=2, num_speakers=None)
    assert gesehen == {"min_speakers": 2}          # ohne Einstellung unveraendert wie vor #264


# --- verfuegbar() (#270): pyannote-Verfügbarkeit für den Datei-Dialog ---------------

import importlib.util


class _Spec:
    """Attrappe: find_spec liefert ein Objekt oder None — Inhalt ist egal."""


def _patch_find_spec(monkeypatch, verhalten):
    """find_spec so faelschen, dass diarize.verfuegbar() die Wirklichkeit nicht braucht.

    `verhalten`: 'da' -> Objekt, 'weg' -> None, 'parent-weg' -> ModuleNotFoundError.
    """
    def fake(name, *a, **k):
        assert name == "pyannote.audio", f"unerwarteter Modulname {name}"
        if verhalten == "parent-weg":
            # Genau das wirft find_spec, wenn schon das PARENT-Paket fehlt — der Fall,
            # den die Auskunft melden soll, und die Falle aus dem Wellenplan (kein None!).
            raise ModuleNotFoundError(f"No module named {name.rsplit('.', 1)[0]!r}")
        return _Spec() if verhalten == "da" else None
    monkeypatch.setattr(importlib.util, "find_spec", fake)


def test_verfuegbar_wandelt_fehlenden_parent_nicht_in_einen_wurf(monkeypatch, tmp_path):
    """find_spec('pyannote.audio') WIRFT ModuleNotFoundError, wenn schon 'pyannote' fehlt
    (Wellenplan 3, Negativkontrolle 'gibtsnicht.audio') — es liefert nicht None. Der GET
    des Datei-Dialogs haette also ein 500 in genau dem Fall, den er melden will."""
    monkeypatch.setattr(diarize, "_VERFUEGBAR", None)
    monkeypatch.setattr(diarize, "DIAR_MODEL", str(tmp_path / "gibt-es.yaml"))
    _patch_find_spec(monkeypatch, "parent-weg")
    assert diarize.verfuegbar() is False


def test_verfuegbar_false_wenn_pyannote_fehlt(monkeypatch, tmp_path):
    monkeypatch.setattr(diarize, "_VERFUEGBAR", None)
    monkeypatch.setattr(diarize, "DIAR_MODEL", str(tmp_path / "gibt-es.yaml"))
    _patch_find_spec(monkeypatch, "weg")
    assert diarize.verfuegbar() is False


def test_verfuegbar_false_wenn_das_modell_fehlt(monkeypatch, tmp_path):
    """pyannote installiert, Modelldatei weg: dieselbe halb eingerichtete Umgebung, die
    #270 beschreibt — die Sprechertrennung wuerde still ausfallen, das Feld blieb bedienbar."""
    monkeypatch.setattr(diarize, "_VERFUEGBAR", None)
    monkeypatch.setattr(diarize, "DIAR_MODEL", str(tmp_path / "fehlt.yaml"))
    _patch_find_spec(monkeypatch, "da")
    assert diarize.verfuegbar() is False


def test_verfuegbar_true_mit_pyannote_und_modell(monkeypatch, tmp_path):
    modell = tmp_path / "config.yaml"
    modell.write_bytes(b"x")
    monkeypatch.setattr(diarize, "_VERFUEGBAR", None)
    monkeypatch.setattr(diarize, "DIAR_MODEL", str(modell))
    _patch_find_spec(monkeypatch, "da")
    assert diarize.verfuegbar() is True


def test_verfuegbar_fragt_nur_einmal_pro_prozess(monkeypatch, tmp_path):
    """Der GET laeuft bei jedem Oeffnen des Dialogs — die Antwort darf nicht jedes Mal
    find_spec + Dateistat zahlen. Vorbild: _HARDWARE in app.py (einmal je Serverlauf)."""
    modell = tmp_path / "config.yaml"
    modell.write_bytes(b"x")
    monkeypatch.setattr(diarize, "DIAR_MODEL", str(modell))
    rufe = []

    # Gezählt, aber GEFÄLSCHT: der CI-Runner hat kein pyannote, das echte find_spec
    # lieferte dort False — derselbe Läufer-Fehler wie beim `_ejs_untaeglich`-Pin in
    # test_ytdlp_update.py. Der Cache ist der Gegenstand, nicht die Installation.
    def zaehlend(name, *a, **k):
        rufe.append(name)
        return _Spec()
    monkeypatch.setattr(diarize, "_VERFUEGBAR", None)
    monkeypatch.setattr(importlib.util, "find_spec", zaehlend)
    assert diarize.verfuegbar() is True
    assert diarize.verfuegbar() is True
    assert diarize.verfuegbar() is True
    assert rufe == ["pyannote.audio"]


# --- Diagnose im Sidecar (#275): pi-Spektrum + Ueberlebensquote ---------------------
# Die Sonden greifen in FREMDE Innereien. Die Tests fahren deshalb gegen eine nachgebaute
# pyannote-Oberflaeche (das echte Paket fehlt auf dem CI-Laeufer, #270) — und EIN Waechter
# unten prueft dieselben Griffpunkte am ECHTEN Paket, uebersprungen wo es fehlt.


class _Emb:
    """Was `filter_embeddings` als erstes Argument bekommt: (chunks, speakers, dim)."""
    shape = (100, 3, 192)


class _BasisClustering:
    """Spiegelt pyannotes Aufbau: `BaseClustering` DEFINIERT `filter_embeddings` …"""
    def filter_embeddings(self, embeddings, segmentations=None, min_active_ratio=0.2):
        return ("gefiltert", list(range(195)), "speaker_idx")


class _FakeClustering(_BasisClustering):
    """… und `VBxClustering` ERBT es nur. Der Unterschied ist tragend: der Rueckbau ist
    deshalb ein `delattr` auf der Unterklasse, kein Zurueckschreiben — ein Nachbau, der die
    Methode selbst definiert, pruefte den anderen Zweig (siehe eigener Test unten)."""


class _FakePipe:
    def __init__(self):
        self.clustering = _FakeClustering()
        self.sah_patch = {}

    def __call__(self, wave, **kw):
        from pyannote.audio.pipelines import clustering as cl
        # Festhalten, WAS waehrend des Laufs installiert war — danach ist alles
        # zurueckgebaut, ein Blick von aussen koennte den Patch also nie sehen.
        self.sah_patch["vbx"] = cl.cluster_vbx is not _echtes_vbx
        self.sah_patch["filter"] = "filter_embeddings" in vars(type(self.clustering))
        cl.cluster_vbx("ahc", "fea", "phi")
        self.clustering.filter_embeddings(_Emb(), segmentations="seg")

        class _Ann:
            def itertracks(self, yield_label=True):
                return []
        return _Ann()


def _echtes_vbx(*a, **kw):
    return ("q", [0.62, 0.38, 4e-07])


def _pyannote_attrappe(monkeypatch):
    """Baut `pyannote.audio.pipelines.clustering` nach und gibt das Modul zurueck."""
    import sys, types
    cl = types.ModuleType("pyannote.audio.pipelines.clustering")
    cl.cluster_vbx = _echtes_vbx
    pipelines = types.ModuleType("pyannote.audio.pipelines")
    pipelines.clustering = cl
    audio = types.ModuleType("pyannote.audio")
    audio.pipelines = pipelines
    wurzel = types.ModuleType("pyannote")
    wurzel.audio = audio
    for name, mod in [("pyannote", wurzel), ("pyannote.audio", audio),
                      ("pyannote.audio.pipelines", pipelines),
                      ("pyannote.audio.pipelines.clustering", cl)]:
        monkeypatch.setitem(sys.modules, name, mod)
    return cl


def test_diagnose_none_setzt_keinen_patch(monkeypatch):
    """Der Default-Weg darf pyannote NICHT anfassen.

    Gemessen wird von INNEN (`sah_patch`), nicht von aussen: der Rueckbau im `finally`
    laeuft vor jeder Pruefung von aussen, ein Patch waere dort unsichtbar. Genau die Luecke,
    an der ein Waechter „vom Zufall lebt"."""
    cl = _pyannote_attrappe(monkeypatch)
    pipe = _FakePipe()
    monkeypatch.setattr(diarize, "_load_waveform", lambda p: "audio")
    monkeypatch.setattr(diarize, "_pipeline", lambda: pipe)

    diarize.diarize_file("x.m4a")                       # ohne diagnose= : heutiger Weg
    assert pipe.sah_patch == {"vbx": False, "filter": False}
    assert cl.cluster_vbx is _echtes_vbx


def test_diagnose_fuellt_pi_und_ueberlebensquote_und_baut_zurueck(monkeypatch):
    """Die eigentliche Zusicherung von #275 — und der Rueckbau in derselben Probe.

    `slots` ist die dem Filter ANGEBOTENE Menge (chunks x speakers), `durchgelassen` die
    Laenge von `chunk_idx`. Der Rueckbau gehoert dazu, weil der `cluster_vbx`-Griff
    PROZESSWEIT ist: ein haengengebliebener Patch beschriebe die naechste Datei mit den
    Zahlen dieser."""
    cl = _pyannote_attrappe(monkeypatch)
    pipe = _FakePipe()
    monkeypatch.setattr(diarize, "_load_waveform", lambda p: "audio")
    monkeypatch.setattr(diarize, "_pipeline", lambda: pipe)

    diagnose: dict = {}
    diarize.diarize_file("x.m4a", diagnose=diagnose)

    assert pipe.sah_patch == {"vbx": True, "filter": True}      # waehrend des Laufs installiert
    assert diagnose["pi"] == [0.62, 0.38, 4e-07]
    assert diagnose["slots"] == 300 and diagnose["durchgelassen"] == 195
    # ... und danach nichts mehr davon zu sehen
    assert cl.cluster_vbx is _echtes_vbx
    assert "filter_embeddings" not in vars(_FakeClustering)


def test_rueckbau_auch_wenn_die_pipeline_wirft(monkeypatch):
    """Ein Wurf mitten im Lauf darf den prozessweiten Patch nicht stehen lassen."""
    cl = _pyannote_attrappe(monkeypatch)

    class _WerfendePipe(_FakePipe):
        def __call__(self, wave, **kw):
            raise RuntimeError("GPU voll")

    monkeypatch.setattr(diarize, "_load_waveform", lambda p: "audio")
    monkeypatch.setattr(diarize, "_pipeline", lambda: _WerfendePipe())
    import pytest
    with pytest.raises(RuntimeError):
        diarize.diarize_file("x.m4a", diagnose={})
    assert cl.cluster_vbx is _echtes_vbx
    assert "filter_embeddings" not in vars(_FakeClustering)


def test_fehlender_griffpunkt_kostet_die_diagnose_nicht_den_lauf(monkeypatch):
    """Best effort: hat pyannote `cluster_vbx` nicht mehr, laeuft die Diarisierung trotzdem.

    Die Gegenrichtung waere schlimmer als keine Diagnose — ein Wurf aus einer reinen
    Protokollfunktion killte einen Lauf, der sonst durchgelaufen waere."""
    cl = _pyannote_attrappe(monkeypatch)
    del cl.cluster_vbx

    class _OhneVbx(_FakePipe):
        def __call__(self, wave, **kw):
            self.clustering.filter_embeddings(_Emb(), segmentations="seg")

            class _Ann:
                def itertracks(self, yield_label=True):
                    return []
            return _Ann()

    pipe = _OhneVbx()
    monkeypatch.setattr(diarize, "_load_waveform", lambda p: "audio")
    monkeypatch.setattr(diarize, "_pipeline", lambda: pipe)
    diagnose: dict = {}
    assert diarize.diarize_file("x.m4a", diagnose=diagnose) == []      # Lauf lebt
    assert "pi" not in diagnose                                        # nur die Diagnose fehlt
    assert diagnose["slots"] == 300                                    # die andere Sonde traegt


def test_waechter_die_griffpunkte_gibt_es_im_ECHTEN_pyannote():
    """Der Waechter, den #275 verlangt: bricht pyannote die Signatur, wird das hier rot —
    und nicht erst still, indem die Diagnose leer bleibt.

    Uebersprungen, wo pyannote fehlt (CI-Laeufer, #270) — sonst waere dieser Test dort rot
    und lokal gruen, genau die Falle aus dem `pyannote_da`-Fix."""
    import inspect, pytest
    pytest.importorskip("pyannote.audio", reason="pyannote fehlt (CI) — Waechter gilt lokal")
    from pyannote.audio.pipelines import clustering as cl

    assert callable(getattr(cl, "cluster_vbx", None)),         "cluster_vbx ist kein modulglobaler Name mehr — Sonde 1 greift ins Leere"
    quelle = inspect.getsource(cl.VBxClustering.__call__)
    assert "cluster_vbx(" in quelle, "VBxClustering ruft cluster_vbx nicht mehr"
    assert "self.filter_embeddings(" in quelle, "VBxClustering ruft filter_embeddings nicht mehr"

    sig = inspect.signature(cl.BaseClustering.filter_embeddings)
    assert list(sig.parameters)[:2] == ["self", "embeddings"],         "filter_embeddings nimmt die Einbettungen nicht mehr als erstes Argument"


def test_rueckbau_schreibt_zurueck_wenn_die_klasse_es_selbst_definiert(monkeypatch):
    """Der zweite Rueckbau-Zweig. Das echte `VBxClustering` ERBT `filter_embeddings`, hier
    greift also `delattr`. Definierte eine kuenftige pyannote-Fassung es direkt auf der
    benutzten Klasse, wuerde `delattr` die ECHTE Methode entfernen — deshalb der
    `vars()`-Test im Code und diese Probe dafuer."""
    _pyannote_attrappe(monkeypatch)

    class _EigenesClustering:
        def filter_embeddings(self, embeddings, segmentations=None, min_active_ratio=0.2):
            return ("gefiltert", list(range(7)), "sp")

    original = _EigenesClustering.filter_embeddings

    class _Pipe(_FakePipe):
        def __init__(self):
            self.clustering = _EigenesClustering()
            self.sah_patch = {}

    pipe = _Pipe()
    monkeypatch.setattr(diarize, "_load_waveform", lambda p: "audio")
    monkeypatch.setattr(diarize, "_pipeline", lambda: pipe)
    diagnose: dict = {}
    diarize.diarize_file("x.m4a", diagnose=diagnose)

    assert diagnose["durchgelassen"] == 7                       # die Sonde lief
    assert _EigenesClustering.filter_embeddings is original     # und ist sauber zurueck
