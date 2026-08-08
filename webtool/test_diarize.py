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


def test_pipeline_nutzt_geraetewahl(monkeypatch):
    """Die Diarisierung muss dasselbe Geraet waehlen wie die Transkription —
    sonst rechnet die eine auf der GPU und die andere auf der CPU."""
    import types
    import sys
    from webtool import device, diarize

    gewaehlt = []
    fake_torch = types.ModuleType("torch")
    fake_torch.device = lambda d: f"torchdevice:{d}"
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(device, "pick", lambda: "mps")
    monkeypatch.setenv("HF_TOKEN", "hf_test")

    class FakePipe:
        def to(self, d):
            gewaehlt.append(d)
            return self

    fake_pa = types.ModuleType("pyannote.audio")
    fake_pa.Pipeline = types.SimpleNamespace(from_pretrained=lambda *a, **k: FakePipe())
    monkeypatch.setitem(sys.modules, "pyannote", types.ModuleType("pyannote"))
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_pa)
    monkeypatch.setattr(diarize, "_PIPELINE", None)

    diarize._pipeline()
    assert gewaehlt == ["torchdevice:mps"]
    monkeypatch.setattr(diarize, "_PIPELINE", None)      # Singleton nicht vergiften
