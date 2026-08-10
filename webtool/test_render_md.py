from webtool.render_md import render_md


def _seg(id, spk, text, note=""):
    return {"id": id, "speaker": spk, "text": text, "note": note}


def test_groups_consecutive_same_speaker():
    doc = {"base": "B", "context": "", "annotations": [], "segments": [
        _seg(0, "Interviewer", "Frage eins?"),
        _seg(1, "Hans", "Antwort A."),
        _seg(2, "Hans", "Und noch B."),
        _seg(3, "Interviewer", "Frage zwei?"),
    ]}
    md = render_md(doc)
    assert "# Interview B" in md
    assert "**Interviewer:** Frage eins?" in md
    assert "**Hans:** Antwort A. Und noch B." in md
    assert md.index("Frage eins?") < md.index("Antwort A.") < md.index("Frage zwei?")


def test_context_and_empty_speaker():
    doc = {"base": "B", "context": "Worum es geht.", "annotations": [],
           "segments": [_seg(0, "", "Hallo.")]}
    md = render_md(doc)
    assert "**Kontext:** Worum es geht." in md
    assert "**Befragte Person:** Hallo." in md


def test_zusammenfassung_steht_vor_dem_gespraech():
    doc = {"base": "B", "context": "", "summary": "Es geht um Brot.", "annotations": [],
           "segments": [_seg(0, "Hans", "Hallo.")]}
    md = render_md(doc)
    assert "## Zusammenfassung" in md and "Es geht um Brot." in md
    assert md.index("Es geht um Brot.") < md.index("Hallo.")


def test_ohne_zusammenfassung_keine_leere_rubrik():
    """Vor diesem Feature geschriebene edit.json haben den Schluessel gar nicht."""
    doc = {"base": "B", "context": "", "annotations": [], "segments": [_seg(0, "Hans", "Hallo.")]}
    assert "Zusammenfassung" not in render_md(doc)


def test_annotations_only_when_present():
    doc0 = {"base": "B", "context": "", "annotations": [], "segments": [_seg(0, "A", "x")]}
    assert "## Anmerkungen" not in render_md(doc0)
    doc1 = {"base": "B", "context": "", "annotations": ["Unsichere Stelle."],
            "segments": [_seg(0, "A", "x", note="Segment-Notiz.")]}
    md = render_md(doc1)
    assert "## Anmerkungen" in md
    assert "- Unsichere Stelle." in md and "- Segment-Notiz." in md


def test_skips_interior_empty_text_in_run():
    doc = {"base": "B", "context": "", "annotations": [], "segments": [
        _seg(0, "Hans", "Erster Teil."),
        _seg(1, "Hans", "   "),
        _seg(2, "Hans", "Zweiter Teil."),
    ]}
    assert "**Hans:** Erster Teil. Zweiter Teil." in render_md(doc)


def test_all_empty_turn_omitted():
    doc = {"base": "B", "context": "", "annotations": [], "segments": [
        _seg(0, "Hans", "   "),
        _seg(1, "Interviewer", "Frage?"),
    ]}
    md = render_md(doc)
    assert "**Hans:**" not in md
    assert "**Interviewer:** Frage?" in md


def test_empty_segments_and_speaker_none():
    assert "# Interview B" in render_md(
        {"base": "B", "context": "", "annotations": [], "segments": []})
    doc = {"base": "B", "context": "", "annotations": [],
           "segments": [{"id": 0, "speaker": None, "text": "Hallo."}]}
    assert "**Befragte Person:** Hallo." in render_md(doc)


def test_whitespace_context_omitted():
    doc = {"base": "B", "context": "   ", "annotations": [], "segments": [_seg(0, "A", "x")]}
    assert "**Kontext:**" not in render_md(doc)


def test_aufeinanderfolgende_musik_steht_nur_einmal():
    doc = {"base": "B", "context": "", "annotations": [], "segments": [
        _seg(0, "Bühnenstimme", "[Musik]"), _seg(1, "Bühnenstimme", "[Musik]"),
        _seg(2, "Bühnenstimme", "[Musik]"), _seg(3, "Interviewer", "Und weiter."),
    ]}
    md = render_md(doc)
    assert md.count("[Musik]") == 1
    assert "**Bühnenstimme:** [Musik]" in md
