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


def test_annotations_only_when_present():
    doc0 = {"base": "B", "context": "", "annotations": [], "segments": [_seg(0, "A", "x")]}
    assert "## Anmerkungen" not in render_md(doc0)
    doc1 = {"base": "B", "context": "", "annotations": ["Unsichere Stelle."],
            "segments": [_seg(0, "A", "x", note="Segment-Notiz.")]}
    md = render_md(doc1)
    assert "## Anmerkungen" in md
    assert "- Unsichere Stelle." in md and "- Segment-Notiz." in md
