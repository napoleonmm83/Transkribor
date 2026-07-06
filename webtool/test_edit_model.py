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
