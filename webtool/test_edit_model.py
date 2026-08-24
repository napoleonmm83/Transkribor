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


def test_compute_flags_is_repeat():
    seg = {"compression_ratio": 0.8, "no_speech_prob": 0.0, "avg_logprob": -0.1}
    assert em.compute_flags(seg, is_repeat=True) == {"hallucination": True, "low_conf": False}


def test_build_edit_doc_flags_consecutive_repetitions():
    raw = {
        "language": "de",
        "segments": [
            {"id": 0, "start": 0.0, "end": 1.0, "text": "Hallo", "compression_ratio": 0.8, "avg_logprob": -0.2},
            {"id": 1, "start": 1.0, "end": 2.0, "text": " Das war's mit dem Tandem.", "compression_ratio": 0.8, "avg_logprob": -0.1},
            {"id": 2, "start": 2.0, "end": 3.0, "text": "Das war's mit dem Tandem!", "compression_ratio": 0.8, "avg_logprob": -0.05},
            {"id": 3, "start": 3.0, "end": 4.0, "text": "Das war's mit dem Tandem.", "compression_ratio": 0.8, "avg_logprob": -0.05},
        ]
    }
    doc = em.build_edit_doc(raw, base="B", project="P", audio="B.mp3")
    assert doc["segments"][0]["flags"]["hallucination"] is False
    assert doc["segments"][1]["flags"]["hallucination"] is False
    assert doc["segments"][2]["flags"]["hallucination"] is False
    assert doc["segments"][3]["flags"]["hallucination"] is True


def test_build_edit_doc_schont_kurze_einzelwort_interjektionen():
    raw = {
        "language": "de",
        "segments": [
            {"id": 0, "start": 0.0, "end": 1.0, "text": "Ja.", "compression_ratio": 0.8, "avg_logprob": -0.2},
            {"id": 1, "start": 1.0, "end": 2.0, "text": "Ja.", "compression_ratio": 0.8, "avg_logprob": -0.2},
        ]
    }
    doc = em.build_edit_doc(raw, base="B", project="P", audio="B.mp3")
    # Kurze Einzelwörter wie "Ja." sollen nicht sofort als Halluzination markiert werden
    assert doc["segments"][0]["flags"]["hallucination"] is False
    assert doc["segments"][1]["flags"]["hallucination"] is False




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
    """Dieser Test hielt frueher fest, dass ein leerer Text den Rohtext stehen laesst. Das war
    der Fehler, nicht der Schutz: die Korrektur leert Segmente absichtlich (ASR-Artefakte), und
    genau diese Entscheidung fiel darueber unter den Tisch. Der Schutz bleibt fuer den Fall, den
    er wirklich meinte — ein Eintrag OHNE text-Schluessel (siehe
    test_fehlender_text_schluessel_laesst_den_rohtext_stehen)."""
    raw = {"segments": [
        {"id": 0, "start": 0, "end": 1, "text": " Roh A.", "words": []},
        {"id": 1, "start": 1, "end": 2, "text": " Roh B.", "words": []},
    ]}
    correction = {"segments": [
        {"id": 0, "speaker": "X", "text": "   "},   # leerer Text -> gestrichen, Sprecher wird gesetzt
        {"id": 1, "text": "Neu B."},                # kein speaker-Key -> speaker ""
    ]}
    doc = em.apply_correction(raw, correction, base="B", project="P", audio="")
    s0, s1 = doc["segments"]
    assert s0["text"] == "" and s0["speaker"] == "X"
    assert s0["raw_text"] == "Roh A."
    assert s1["text"] == "Neu B." and s1["speaker"] == ""


def test_apply_correction_strips_residual_tags_and_drops_none_annotation():
    raw = {"segments": [{"id": 0, "start": 0, "end": 1, "text": " x", "words": []}]}
    correction = {"segments": [{"id": 0, "speaker": "A", "text": "Ich fahre nach [[Chur|0.31]]."}],
                  "annotations": [None, "  ", "echte Notiz"]}
    doc = em.apply_correction(raw, correction, base="B", project="P", audio="")
    assert doc["segments"][0]["text"] == "Ich fahre nach Chur."
    assert doc["annotations"] == ["echte Notiz"]


def _roh(*texte):
    return {"language": "de", "segments": [
        {"id": i, "start": float(i), "end": i + 1.0, "text": t, "words": [],
         "compression_ratio": 1.0, "avg_logprob": -0.2}
        for i, t in enumerate(texte)]}


def _korr(*eintraege):
    return {"context": "", "speakers": [], "annotations": [], "segments": list(eintraege)}


def _bau(roh, korr):
    return em.apply_correction(roh, korr, base="B", project="P", audio="a.m4a")


def test_leerer_text_streicht_das_segment():
    """Ein leerer Text ist eine Entscheidung, kein fehlender Wert. Vorher fiel sie unter den
    Tisch: die Korrektur leerte das ASR-Artefakt 'ARD Text im Auftrag von Funk', und der
    Rohtext stand danach trotzdem im Export."""
    doc = _bau(_roh("ARD Text im Auftrag von Funk", "Echte Aussage."),
               _korr({"id": 0, "speaker": "X", "text": ""},
                     {"id": 1, "speaker": "X", "text": "Echte Aussage."}))
    assert doc["segments"][0]["text"] == ""
    assert doc["segments"][0]["raw_text"] == "ARD Text im Auftrag von Funk"  # Roh bleibt erhalten
    assert doc["segments"][1]["text"] == "Echte Aussage."


def test_fehlender_text_schluessel_laesst_den_rohtext_stehen():
    """Nur der Sprecher wurde geliefert -> das Segment war nicht Thema, Text bleibt Roh."""
    doc = _bau(_roh("Hallo Welt."), _korr({"id": 0, "speaker": "X"}))
    assert doc["segments"][0]["text"] == "Hallo Welt."
    assert doc["segments"][0]["speaker"] == "X"


def test_musik_varianten_werden_auf_eine_schreibweise_gebracht():
    doc = _bau(_roh("a", "b", "c", "d"),
               _korr({"id": 0, "text": "[Musik]"}, {"id": 1, "text": "[Musik: Rocksong]"},
                     {"id": 2, "text": "♪"}, {"id": 3, "text": "(Applaus)"}))
    assert [s["text"] for s in doc["segments"]] == ["[Musik]"] * 4


def test_musik_faengt_keine_echten_saetze():
    doc = _bau(_roh("a", "b"),
               _korr({"id": 0, "text": "Die Musik war laut."},
                     {"id": 1, "text": "[Musik] und dann sprach er weiter."}))
    assert [s["text"] for s in doc["segments"]] == [
        "Die Musik war laut.", "[Musik] und dann sprach er weiter."]


def test_luecken_reisen_ins_editor_dokument():
    """#83: Das Mittelstueck der Kette. Gerechnet wird beim Transkribieren (nur dort ist die
    Audiodauer bekannt), gezeigt wird im Editor — faellt diese eine Zeile weg, ist der
    Waechter still abgeschaltet, ohne dass an einem der beiden Enden etwas fehlt.

    Ein EIGENES Feld und nicht `annotations`: die ersetzt `apply_correction` vollstaendig
    durch die Liste des LLM (siehe unten), der Hinweis waere nach dem ersten Korrekturlauf
    weg — also genau dann, wenn jemand das Transkript zum ersten Mal liest."""
    roh = {"segments": [], "language": "de",
           "luecken": [{"start": 12.0, "end": 30.0, "dauer": 18.0}]}
    doc = em.build_edit_doc(roh, base="a", project="P", audio="a.mp3")
    assert doc["luecken"] == [{"start": 12.0, "end": 30.0, "dauer": 18.0}]
    # Und der Korrekturlauf darf sie nicht wegraeumen — er ersetzt `annotations` vollstaendig.
    nach = em.apply_correction(roh, {"annotations": ["etwas ganz anderes"], "segments": []},
                               base="a", project="P", audio="a.mp3")
    assert nach["annotations"] == ["etwas ganz anderes"]      # die Liste IST ersetzt …
    assert nach["luecken"] == [{"start": 12.0, "end": 30.0, "dauer": 18.0}]   # … der Hinweis nicht


def test_altes_rohtranskript_bekommt_eine_leere_liste():
    """Vor diesem Feature geschriebene `<base>.json` haben den Schluessel nicht. `None` waere
    im Frontend nicht falsch (der Kasten prueft auf Laenge), aber das Dokument soll ueberall
    dieselbe Form haben — `annotations` macht es genauso."""
    doc = em.build_edit_doc({"segments": [], "language": "de"}, base="a", project="P", audio="a.mp3")
    assert doc["luecken"] == []
