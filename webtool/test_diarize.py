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
