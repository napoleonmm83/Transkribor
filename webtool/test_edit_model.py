from webtool import edit_model as em


def test_compute_flags_hallucination():
    seg = {"compression_ratio": 2.5, "no_speech_prob": 0.1, "avg_logprob": -0.3}
    assert em.compute_flags(seg) == {"hallucination": True, "silence": False, "low_conf": False}


def test_compute_flags_silence_needs_both():
    seg = {"compression_ratio": 1.0, "no_speech_prob": 0.7, "avg_logprob": -1.5}
    f = em.compute_flags(seg)
    assert f["silence"] is True and f["low_conf"] is True
    # hoher no_speech_prob allein (avg_logprob gut) ist KEINE Stille
    seg2 = {"compression_ratio": 1.0, "no_speech_prob": 0.7, "avg_logprob": -0.2}
    assert em.compute_flags(seg2)["silence"] is False


def test_compute_flags_low_conf_only():
    seg = {"compression_ratio": 1.0, "no_speech_prob": 0.1, "avg_logprob": -1.2}
    f = em.compute_flags(seg)
    assert f == {"hallucination": False, "silence": False, "low_conf": True}


def test_build_edit_doc_shape():
    raw = {
        "language": "de",
        "segments": [
            {"id": 0, "start": 5.28, "end": 13.5, "text": " Ich bin da. ",
             "compression_ratio": 1.1, "no_speech_prob": 0.01, "avg_logprob": -0.4,
             "words": [{"word": " Ich", "start": 5.28, "end": 6.0, "probability": 0.13}]},
        ],
    }
    doc = em.build_edit_doc(raw, base="B", project="P", audio="B.mp3")
    assert doc["base"] == "B" and doc["project"] == "P" and doc["audio"] == "B.mp3"
    assert doc["language"] == "de" and doc["human_edited"] is False
    assert doc["speakers"] == [] and doc["annotations"] == []
    seg = doc["segments"][0]
    assert seg["raw_text"] == "Ich bin da." and seg["text"] == "Ich bin da."
    assert seg["speaker"] == "" and seg["note"] == ""
    assert seg["words"][0]["probability"] == 0.13
    assert seg["flags"] == {"hallucination": False, "silence": False, "low_conf": False}


def test_compute_flags_boundaries_are_strict():
    # exakt auf der Schwelle -> Flag NICHT gesetzt (strikte >/<)
    assert em.compute_flags(
        {"compression_ratio": 2.4, "no_speech_prob": 0.0, "avg_logprob": 0.0}
    )["hallucination"] is False
    assert em.compute_flags(
        {"compression_ratio": 1.0, "no_speech_prob": 0.6, "avg_logprob": -1.5}
    )["silence"] is False
    assert em.compute_flags(
        {"compression_ratio": 1.0, "no_speech_prob": 0.0, "avg_logprob": -1.0}
    )["low_conf"] is False


def test_build_edit_doc_edge_cases():
    # keine segments -> leere Liste, Sprache default "de"
    doc = em.build_edit_doc({}, base="B", project="P", audio="")
    assert doc["segments"] == [] and doc["language"] == "de"
    # segment ohne words + ohne Metrik-Keys -> [] bzw. alle Flags False
    raw = {"segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "x"}]}
    seg = em.build_edit_doc(raw, base="B", project="P", audio="")["segments"][0]
    assert seg["words"] == []
    assert seg["flags"] == {"hallucination": False, "silence": False, "low_conf": False}


def test_tag_uncertain_segments_wraps_low_prob():
    raw = {"segments": [
        {"id": 0, "start": 0.0, "end": 2.0, "text": " Ich fahre nach Chur.",
         "words": [
             {"word": " Ich", "start": 0.0, "end": 0.3, "probability": 0.95},
             {"word": " fahre", "start": 0.3, "end": 0.6, "probability": 0.9},
             {"word": " nach", "start": 0.6, "end": 0.8, "probability": 0.8},
             {"word": " Chur", "start": 0.8, "end": 1.2, "probability": 0.31},
         ]},
    ]}
    segs = em.tag_uncertain_segments(raw)
    assert len(segs) == 1
    s = segs[0]
    assert s["id"] == 0 and s["start"] == 0.0 and s["end"] == 2.0
    # niedrig-prob-Wort markiert, führendes Leerzeichen bleibt vor der Markierung
    assert " [[Chur|0.31]]" in s["tagged_text"]
    # sichere Wörter unverändert
    assert "Ich fahre nach" in s["tagged_text"]
    assert "[[Ich" not in s["tagged_text"] and "[[fahre" not in s["tagged_text"]


def test_tag_uncertain_segments_threshold_and_no_words():
    raw = {"segments": [
        {"id": 1, "start": 2.0, "end": 3.0, "text": " Hallo.", "words": []},
    ]}
    segs = em.tag_uncertain_segments(raw)
    assert segs[0]["tagged_text"] == "Hallo."  # keine words -> gestrippter Text
    # eigener Schwellwert: bei 0.85 wird 0.8 markiert
    raw2 = {"segments": [{"id": 0, "start": 0, "end": 1, "text": "x",
             "words": [{"word": "x", "probability": 0.8}]}]}
    assert "[[x|0.80]]" in em.tag_uncertain_segments(raw2, threshold=0.85)[0]["tagged_text"]
