from webtool import edit_model as em


def test_compute_flags_hallucination():
    seg = {"compression_ratio": 2.5, "no_speech_prob": 0.1, "avg_logprob": -0.3}
    assert em.compute_flags(seg) == {"hallucination": True, "low_conf": False}


def test_compute_flags_kennt_kein_no_speech_prob():
    """Kein Flag darf an `no_speech_prob` hängen — Whisper hat diese Segmente schon verworfen.

    Vorher stand hier ein Test, der die tote "silence"-Flagge grün bestätigte: er fütterte ein
    handgebautes Dict, das der Decoder so nie ausgibt. Grüner Test, null Aussage.
    """
    # Genau der Fall, den die alte Flagge gesetzt haette (nsp > 0.6 UND alp < -1.0) — die
    # Dict-Gleichheit laesst eine Wiedereinfuehrung also auffliegen, statt sie durchzuwinken.
    stumm = {"compression_ratio": 1.0, "no_speech_prob": 0.99, "avg_logprob": -1.5}
    assert em.compute_flags(stumm) == {"hallucination": False, "low_conf": True}


def test_compute_flags_low_conf_only():
    seg = {"compression_ratio": 1.0, "no_speech_prob": 0.1, "avg_logprob": -1.2}
    f = em.compute_flags(seg)
    assert f == {"hallucination": False, "low_conf": True}


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
    assert seg["flags"] == {"hallucination": False, "low_conf": False}


def test_compute_flags_boundaries_are_strict():
    # exakt auf der Schwelle -> Flag NICHT gesetzt (strikte >/<)
    assert em.compute_flags(
        {"compression_ratio": 2.4, "no_speech_prob": 0.0, "avg_logprob": 0.0}
    )["hallucination"] is False
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
    assert seg["flags"] == {"hallucination": False, "low_conf": False}


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


def test_apply_correction_overlays_by_id():
    raw = {"language": "de", "segments": [
        {"id": 0, "start": 0.0, "end": 1.0, "text": " Ich bin Mathias.",
         "compression_ratio": 1.0, "no_speech_prob": 0.01, "avg_logprob": -0.3,
         "words": [{"word": " Ich", "start": 0.0, "end": 0.5, "probability": 0.4}]},
        {"id": 1, "start": 1.0, "end": 2.0, "text": " Aha.",
         "compression_ratio": 1.0, "no_speech_prob": 0.01, "avg_logprob": -0.3, "words": []},
    ]}
    correction = {
        "base": "B", "context": "Vorstellung.",
        "speakers": ["Interviewer", "Matthias"],
        "segments": [
            {"id": 0, "speaker": "Matthias", "text": "Ich bin Matthias."},
            # id 1 absichtlich NICHT korrigiert
        ],
        "annotations": ["Stelle X unklar."],
    }
    doc = em.apply_correction(raw, correction, base="B", project="P", audio="B.mp3")
    assert doc["context"] == "Vorstellung."
    assert doc["speakers"] == ["Interviewer", "Matthias"]
    assert doc["annotations"] == ["Stelle X unklar."]
    assert doc["human_edited"] is False
    s0 = doc["segments"][0]
    assert s0["text"] == "Ich bin Matthias." and s0["speaker"] == "Matthias"
    assert s0["raw_text"] == "Ich bin Mathias."  # Roh bleibt erhalten
    assert s0["words"][0]["probability"] == 0.4 and s0["flags"] == {"hallucination": False, "low_conf": False}
    s1 = doc["segments"][1]
    assert s1["text"] == "Aha." and s1["speaker"] == ""  # nicht korrigiert -> Rohtext, leerer Sprecher


def test_apply_correction_uebernimmt_die_zusammenfassung():
    """summary fiel bisher still heraus: die correction.json hatte es, die edit.json nie —
    14 von 14 echten Dateien hatten ein leeres Feld, obwohl die Korrektur eins geschrieben hat.
    `verification` bleibt draussen: Pruefprotokoll ist kein Inhalt."""
    raw = {"segments": [{"id": 0, "start": 0, "end": 1, "text": " Hallo.", "words": []}]}
    doc = em.apply_correction(raw, {"summary": "  Es geht um Brot.  ", "verification": "keine Änderung"},
                              base="B", project="P", audio="")
    assert doc["summary"] == "Es geht um Brot."
    assert "verification" not in doc


def test_apply_correction_empty_correction_keeps_raw():
    raw = {"segments": [{"id": 0, "start": 0, "end": 1, "text": " Hallo.", "words": []}]}
    doc = em.apply_correction(raw, {}, base="B", project="P", audio="")
    assert doc["segments"][0]["text"] == "Hallo." and doc["segments"][0]["speaker"] == ""
    assert doc["context"] == "" and doc["speakers"] == [] and doc["annotations"] == []
    assert doc["summary"] == ""


def test_apply_correction_empty_text_and_missing_speaker():
    raw = {"segments": [
        {"id": 0, "start": 0, "end": 1, "text": " Roh A.", "words": []},
        {"id": 1, "start": 1, "end": 2, "text": " Roh B.", "words": []},
    ]}
    correction = {"segments": [
        {"id": 0, "speaker": "X", "text": "   "},   # leerer Text -> Rohtext bleibt, Sprecher wird gesetzt
        {"id": 1, "text": "Neu B."},                # kein speaker-Key -> speaker ""
    ]}
    doc = em.apply_correction(raw, correction, base="B", project="P", audio="")
    s0, s1 = doc["segments"]
    assert s0["text"] == "Roh A." and s0["speaker"] == "X"
    assert s1["text"] == "Neu B." and s1["speaker"] == ""


def test_apply_correction_strips_residual_tags_and_drops_none_annotation():
    raw = {"segments": [{"id": 0, "start": 0, "end": 1, "text": " x", "words": []}]}
    correction = {"segments": [{"id": 0, "speaker": "A", "text": "Ich fahre nach [[Chur|0.31]]."}],
                  "annotations": [None, "  ", "echte Notiz"]}
    doc = em.apply_correction(raw, correction, base="B", project="P", audio="")
    assert doc["segments"][0]["text"] == "Ich fahre nach Chur."
    assert doc["annotations"] == ["echte Notiz"]
