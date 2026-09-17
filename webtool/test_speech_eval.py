"""Offline text evaluation contracts using synthetic time spans."""
import importlib.util
import json
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "speech_eval", Path(__file__).resolve().parents[1] / "tools" / "speech_eval.py"
)
assert _SPEC is not None and _SPEC.loader is not None
se = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(se)


def case(reference="ein guter tag", **kwargs):
    return dict(case_id="c1", audio_id="a", start=0, end=3,
                reference=reference, reviewed=True) | kwargs


def _wortzeiten(text, start, end):
    """Woerter gleichmaessig ueber das Segment verteilt — die Form einer ASR-Ausgabe."""
    woerter = text.split()
    if not woerter:
        return []
    schritt = (end - start) / len(woerter)
    return [{"word": w, "start": start + i * schritt, "end": start + (i + 1) * schritt}
            for i, w in enumerate(woerter)]


def hypothesis(text, **kwargs):
    """Eine Hypothese MIT Wortzeiten — das ist die Normalform einer ASR-Ausgabe.

    Bis 2026-09-17 baute dieser Helfer Segmente OHNE `words`, womit JEDER Test den
    Segment-Rueckfall mass statt des Wortpfades. Genau deshalb blieb dessen Verzerrung
    unsichtbar: zwei Hypothesen mit wortgleichem Text ergaben 0,0 gegen 0,0998, und kein
    Test sah den Unterschied. Wer den Rueckfall pruefen will, nimmt
    `hypothesis_ohne_zeiten` — ausdruecklich, nicht aus Versehen.
    """
    seg = dict(start=0, end=3, text=text) | kwargs
    seg.setdefault("words", _wortzeiten(seg["text"], seg["start"], seg["end"]))
    return {"segments": [seg]}


def hypothesis_ohne_zeiten(text, **kwargs):
    """Der Segment-Rueckfall: keine Wortzeiten, also Auswahl ueber die Segmentgrenze."""
    return {"segments": [dict(start=0, end=3, text=text) | kwargs]}


def test_missing_audio_and_empty_hypothesis_are_deletions():
    for hypotheses in ({}, {"other": hypothesis("ein guter tag")}, hypothesis("")):
        report = se.score_cases([case()], hypotheses)
        assert report["reviewed"]["wer"]["deletions"] == 3
        assert report["reviewed"]["wer"]["rate"] == 1
        assert len(report["cases"]) == 1


def test_ids_and_segmentation_do_not_determine_text_matching():
    raw = {"segments": [
        {"id": 500, "start": 0, "end": 1, "text": "ein"},
        {"id": 700, "start": 1, "end": 3, "text": "guter tag"},
    ]}
    assert se.score_cases([case()], raw)["reviewed"]["wer"]["errors"] == 0


def test_interleaved_segments_follow_global_word_times():
    raw = {"segments": [
        {"start": 0, "end": 3, "text": "eins drei", "words": [
            {"start": 0, "end": 0.5, "word": "eins"},
            {"start": 2, "end": 2.5, "word": "drei"},
        ]},
        {"start": 1, "end": 2, "text": "zwei", "words": [
            {"start": 1, "end": 1.5, "word": "zwei"},
        ]},
    ]}
    assert se.score_cases([case("eins zwei drei")], raw)["reviewed"]["wer"]["errors"] == 0


def test_unreviewed_and_empty_references_do_not_claim_quality():
    report = se.score_cases([
        case(), case(case_id="draft", reviewed=False, reference="falsch"),
        case(case_id="empty", reference=" … "),
    ], hypothesis("ein guter tag"))
    assert report["reviewed"]["case_count"] == 1
    assert report["reviewed"]["wer"]["rate"] == 0
    assert report["candidate_only"]["case_count"] == 1
    assert report["coverage"]["excluded_empty_reference"] == 1
    draft = se.score_cases([case(reviewed=False)], hypothesis("ein guter tag"))
    assert draft["reviewed"]["wer"]["rate"] is None
    assert draft["quality_evidence_available"] is False


def test_standard_edit_counts_keep_negation_and_numbers():
    row = se.score_cases([case("wir kommen nicht 200")],
                         hypothesis("wir kommen 201 heute"))["cases"][0]
    assert row["wer"]["errors"] == 2
    assert se.score_cases([case("wir kommen nicht")], hypothesis("wir kommen"))["reviewed"]["wer"]["deletions"] == 1
    assert se.score_cases([case("wir kommen")], hypothesis("wir kommen heute"))["reviewed"]["wer"]["insertions"] == 1


def test_unicode_normalization_preserves_semantic_characters():
    assert se.normalize_text("  STRAẞE, Cafe\u0301！ ２００\u00a0NICHT. ") == "strasse café 200 nicht"
    report = se.score_cases([case("Straße, Café 200 nicht")], hypothesis("STRASSE cafe\u0301 ２００ NICHT!"))
    assert report["reviewed"]["cer"]["errors"] == 0


def test_word_midpoints_choose_each_boundary_word_only_once():
    raw = hypothesis("vor mitte nach", words=[
        {"start": 0, "end": 1, "word": "vor"},
        {"start": 1, "end": 2, "word": "mitte"},
        {"start": 2, "end": 3, "word": "nach"},
    ])
    report = se.score_cases([case("vor", end=1.5), case("mitte nach", case_id="c2", start=1.5)], raw)
    assert [r["hypothesis"] for r in report["cases"]] == ["vor", "mitte nach"]
    assert all(r["selection"]["method"] == "word_midpoint" for r in report["cases"])
    assert all(r["selection"]["boundary_crossings"] == 1 for r in report["cases"])


def test_einfuegungen_zaehlen_in_errors_und_rate():
    """Die Fehlersumme MUSS die Einfuegungen enthalten — und das war unbewacht.

    Der gegnerische Pruefer konnte `errors = substitutions + deletions` schreiben, und
    alle 30 Tests blieben gruen: keiner prueft eine Rate, in der eine Einfuegung steckt.
    Das ist die teuerste Luecke des Werkzeugs, weil der Segment-Rueckfall AUSSCHLIESSLICH
    Einfuegungen erzeugt (279 bzw. 1854 an echtem Material, Loeschungen je 0) — die eine
    Kennzahl, die den Fehlbefund sichtbar gemacht haette, war blind dafuer.
    """
    bericht = se.score_cases([case("ein tag")], hypothesis("ein guter tag"))
    wer = bericht["reviewed"]["wer"]
    assert (wer["substitutions"], wer["deletions"], wer["insertions"]) == (0, 0, 1)
    assert wer["errors"] == 1
    assert wer["rate"] == 0.5          # 1 Fehler auf 2 Referenzwoerter
    # Und in der Zeichenrate ebenso, damit die Summe nicht nur an EINER Stelle stimmt.
    assert bericht["reviewed"]["cer"]["errors"] == bericht["reviewed"]["cer"]["insertions"]


def test_wortzeiten_aendern_die_rate_nicht_bei_gleichem_text():
    """Der Kernbefund: die Zahl darf nicht messen, OB ein Lauf Wortzeiten mitbringt.

    Zwei Hypothesen mit wortgleichem Text ergaben 0,0 gegen 0,0998 (30-s-Fenster) und
    0,6617 bei 5 s — allein, weil einer keine Wortzeiten trug. Da die KI-Korrektur die
    Zeiten genau dort verwirft, wo sie korrigiert hat, bestrafte die Kennzahl das
    Korrigieren. Jetzt liegt der zeitlose Lauf in einem eigenen Posten statt in der Rate.
    """
    faelle = [case("ein guter tag")]
    mit = se.score_cases(faelle, hypothesis("ein guter tag"))
    ohne = se.score_cases(faelle, hypothesis_ohne_zeiten("ein guter tag"))

    assert mit["reviewed"]["wer"]["rate"] == 0
    # Der zeitlose Lauf traegt zur Rate NICHTS bei — weder gut noch schlecht.
    assert ohne["reviewed"]["case_count"] == 0
    assert ohne["reviewed"]["wer"]["rate"] is None
    assert ohne["reviewed_untimed"]["case_count"] == 1
    # Sichtbar bleibt er: wer die Rate liest, sieht daneben, worueber sie schweigt.
    assert ohne["coverage"]["untimed_fallback_cases"] == 1
    assert ohne["coverage"]["reviewed_speech_cases"] == 1     # geprueft bleibt geprueft
    assert ohne["coverage"]["scored_speech_cases"] == 0       # gewertet aber nicht
    # Die beiden Abdeckungszahlen muessen ueber DIESELBE Menge sprechen: der Fall steckt
    # in `reviewed_cases`, also auch in den Sekunden. Sonst zaehlten sie verschieden
    # (CodeRabbit-CLI) — mit der alten Zeile stand hier 0 bei einem Fall von 0 bis 3 s.
    assert ohne["coverage"]["reviewed_cases"] == 1
    assert ohne["coverage"]["reviewed_case_seconds"] == 3
    # Und der Bericht behauptet dann KEINEN Qualitaetsbeleg — faellt jeder Fall in den
    # Rueckfall, gibt es keine belastbare Zahl. Das ist die ehrlichste Antwort, die das
    # Werkzeug hier geben kann, und sie war vorher nicht moeglich: da stand eine Rate.
    assert ohne["quality_evidence_available"] is False
    assert mit["quality_evidence_available"] is True


def test_wort_ueber_der_segmentgrenze_verwirft_nicht_das_ganze_segment():
    """Ein ueberhaengendes Wort wird GEKLEMMT, nicht zum Anlass genommen, alles zu verwerfen.

    Der alte Waechter warf die Zeiten des ganzen Segments weg, sobald ein einziges Wort
    ueber die Segmentgrenze hing — an echten Whisper-Laeufen 26 von 1699 Segmenten. Damit
    griff der Segment-Rueckfall, und der erzeugte genau die Doppelzaehlung, gegen die der
    Waechter schuetzen sollte (gemessen 28 doppelte Woerter bei 5-s-Fenstern, 0 ohne ihn).
    """
    # Das Segment beginnt bei 1,0 — ein Wort davor ist ein echter Ueberhang und keine
    # kaputte Zeit (`_interval` weist negative Zeiten ohnehin ab). Genau diese Form steht
    # in echten Whisper-Ausgaben: Segment 48,0-52,8 mit einem Wort ab 47,8.
    ueberhang = hypothesis("ein guter tag", start=1, end=3, words=[
        {"start": 0.8, "end": 1.5, "word": "ein"},       # haengt vorne hinaus
        {"start": 1.5, "end": 2.0, "word": "guter"},
        {"start": 2.0, "end": 3.2, "word": "tag"},       # und hinten
    ])
    bericht = se.score_cases([case("ein guter tag")], ueberhang)
    assert bericht["cases"][0]["selection"]["method"] == "word_midpoint"
    assert bericht["reviewed"]["case_count"] == 1
    assert bericht["reviewed"]["wer"]["rate"] == 0
    assert bericht["coverage"]["untimed_fallback_cases"] == 0

    # Gegenrichtung: ein Wort GANZ ausserhalb seines Segments bleibt kaputte Daten.
    daneben = hypothesis("ein guter tag", words=[
        {"start": 9.0, "end": 9.5, "word": "ein"},
        {"start": 1.0, "end": 2.0, "word": "guter"},
        {"start": 2.0, "end": 3.0, "word": "tag"},
    ])
    assert se.score_cases([case()], daneben)["cases"][0]["selection"]["method"] == "segment_overlap"


def test_unaligned_segments_are_included_with_explicit_boundary_uncertainty():
    """Ohne Wortzeiten bleibt nur die Segmentgrenze — der Fall ist hier ABSICHT."""
    bericht = se.score_cases([case("guter", start=1, end=2)], hypothesis_ohne_zeiten("ein guter tag"))
    row = bericht["cases"][0]
    assert row["hypothesis"] == "ein guter tag"
    assert row["selection"]["method"] == "segment_overlap"
    assert row["selection"]["boundary_crossings"] == 1
    assert row["selection"]["approximate"] is True
    # Und er zaehlt NICHT in die Kennzahl, sondern daneben: der ganze Segmenttext in
    # einem 1-s-Fenster erzeugt Einfuegungen, die nichts ueber die Qualitaet sagen.
    assert bericht["reviewed"]["case_count"] == 0
    assert bericht["reviewed_untimed"]["case_count"] == 1
    assert bericht["coverage"]["untimed_fallback_cases"] == 1
    assert bericht["coverage"]["reviewed_speech_cases"] == 1   # geprueft bleibt geprueft


def test_stale_or_incomplete_word_text_falls_back_to_segment_text():
    raw = hypothesis("wir kommen nicht", words=[
        {"start": 0, "end": 1, "word": "wir"}, {"start": 1, "end": 2, "word": "kommen"},
    ])
    row = se.score_cases([case("wir kommen nicht")], raw)["cases"][0]
    assert row["hypothesis"] == "wir kommen nicht"
    assert row["selection"]["word_fallbacks"] == 1
    assert row["wer"]["errors"] == 0


def test_half_open_spans_exclude_neighbour_segments():
    raw = {"segments": [
        {"start": 0, "end": 1, "text": "vor"},
        {"start": 1, "end": 2, "text": "hier"},
        {"start": 2, "end": 3, "text": "nach"},
    ]}
    assert se.score_cases([case("hier", start=1, end=2)], raw)["cases"][0]["hypothesis"] == "hier"


def test_numeric_signs_preserve_changed_meaning():
    assert se.normalize_text("-200 −200 －200 +200 foo-bar") == "-200 -200 -200 +200 foo bar"
    for actual in ("200", "+200"):
        assert se.score_cases([case("-200")], hypothesis(actual))["reviewed"]["wer"]["substitutions"] == 1
    assert se.score_cases([case("−200")], hypothesis("-200"))["reviewed"]["wer"]["errors"] == 0


def test_explicit_reviewed_silence_exposes_hallucinations_outside_wer():
    cases = [case("ja", end=1), case("", case_id="quiet", start=1, end=3, reference_kind="silence")]
    # MIT Wortzeiten, sonst faellt der Sprachfall in den Segment-Rueckfall und damit aus
    # der Kennzahl — hier soll aber genau sie geprueft werden.
    raw = {"segments": [{"start": 0, "end": 1, "text": "ja",
                         "words": _wortzeiten("ja", 0, 1)},
                        {"start": 1, "end": 3, "text": "danke fuer zuschauen",
                         "words": _wortzeiten("danke fuer zuschauen", 1, 3)}]}
    report = se.score_cases(cases, raw)
    assert report["reviewed"]["wer"]["reference_length"] == 1
    assert report["reviewed"]["wer"]["rate"] == 0
    assert report["reviewed_silence"] == {
        "case_count": 1, "annotated_case_seconds": 2, "hallucinated_word_count": 3,
        "hallucinated_cases": 1, "missing_hypothesis_cases": 0,
    }
    assert report["coverage"]["excluded_empty_reference"] == 0
    assert report["coverage"]["reviewed_cases"] == 2
    quiet = se.score_cases([cases[1]], {"segments": []})
    assert quiet["quality_evidence_available"] is True
    assert quiet["reviewed"]["wer"]["rate"] is None
    assert quiet["reviewed_silence"]["hallucinated_word_count"] == 0
    absent = se.score_cases([cases[1]], {})
    assert absent["reviewed_silence"]["case_count"] == 0
    assert absent["reviewed_silence"]["missing_hypothesis_cases"] == 1
    assert absent["quality_evidence_available"] is False


def test_unreviewed_silence_and_blank_speech_are_distinct():
    report = se.score_cases([case("", reviewed=False, reference_kind="silence"),
                            case("", case_id="unfinished")], hypothesis("erfundener text"))
    assert report["reviewed_silence"]["case_count"] == 0
    assert report["candidate_silence"]["hallucinated_word_count"] == 2
    assert report["coverage"]["excluded_empty_reference"] == 1
    assert report["quality_evidence_available"] is False


def test_inconsistent_reference_kinds_are_rejected():
    with pytest.raises(ValueError, match="silence"):
        se.score_cases([case("hoerbare sprache", reference_kind="silence")], {})
    with pytest.raises(ValueError, match="reference_kind"):
        se.score_cases([case(reference_kind="unknown")], {})


def test_terminal_point_word_is_retained_in_its_segment_only():
    raw = hypothesis("ja nein", words=[
        {"start": 0, "end": 2, "word": "ja"},
        {"start": 3, "end": 3, "word": "nein"},
    ])
    rows = se.score_cases([case("ja nein"), case("", case_id="next", start=3, end=4)], raw)["cases"]
    assert [row["hypothesis"] for row in rows] == ["ja nein", ""]


def test_corpus_metrics_weight_reference_lengths_not_case_ratios():
    report = se.score_cases([
        case("eins", audio_id="short"),
        case("eins zwei drei vier fünf sechs sieben acht neun", case_id="c2", audio_id="long"),
    ], {"short": hypothesis("falsch"), "long": hypothesis("eins zwei drei vier fünf sechs sieben acht neun")})
    assert report["reviewed"]["wer"]["rate"] == 0.1
    assert report["reviewed"]["wer"]["reference_length"] == 10


@pytest.mark.parametrize("changes", [
    {"reviewed": "true"}, {"start": float("nan")}, {"end": -1}, {"start": 3}, {"reference": None},
])
def test_invalid_cases_are_rejected_not_silently_removed(changes):
    with pytest.raises(ValueError):
        se.score_cases([case(**changes)], hypothesis("a"))


def test_duplicate_cases_and_ambiguous_single_audio_are_rejected():
    with pytest.raises(ValueError, match="case_id"):
        se.score_cases([case(), case()], {})
    with pytest.raises(ValueError, match="audio"):
        se.score_cases([case(), case(case_id="c2", audio_id="b")], hypothesis("a"))


def test_audio_id_segments_is_a_valid_mapping_key():
    report = se.score_cases([case(audio_id="segments")], {"segments": hypothesis("ein guter tag")})
    assert report["reviewed"]["wer"]["errors"] == 0


def test_extraction_never_promotes_a_human_edited_file_to_gold():
    raw = {"segments": [{"id": 8, "start": 4, "end": 6, "text": "im tal"}]}
    auto = {"segments": [{"id": 8, "text": "im Tal"}]}
    edited = {"human_edited": True, "segments": [{"id": 99, "start": 4, "end": 6, "text": "in Mels"}]}
    result = se.extract_candidates(raw, auto, edited, "audio-x")
    assert len(result) == 1
    assert result[0]["reviewed"] is False
    assert result[0]["raw"] == "im tal"
    assert result[0]["auto"] == "im Tal"
    assert result[0]["reference"] == "in Mels"
    assert result[0]["start"] == 4


@pytest.mark.parametrize("correction", [
    {"segments": [{"id": 0, "speaker": "A"}, {"id": 1, "speaker": "A"}]},
    {"segments": [{"id": 0, "text": "Ich komme"}]},
])
def test_extraction_uses_applied_correction_semantics(correction):
    from webtool.edit_model import apply_correction
    raw = {"segments": [
        {"id": 0, "start": 0, "end": 1, "text": "ich komme"},
        {"id": 1, "start": 1, "end": 2, "text": "morgen"},
    ]}
    edited = apply_correction(raw, correction, base="test", project="demo", audio="")
    assert se.extract_candidates(raw, correction, edited, "x") == []


def test_editor_only_split_is_not_a_manual_text_change():
    raw = {"segments": [{"id": 0, "start": 0, "end": 2, "text": "eins zwei", "words": [
        {"start": 0, "end": 1, "word": "eins"},
        {"start": 1, "end": 2, "word": "zwei"},
    ]}]}
    edited = {"segments": [{"id": 5, "start": 0, "end": 1, "text": "eins"},
                           {"id": 6, "start": 1, "end": 2, "text": "zwei"}]}
    assert se.extract_candidates(raw, {"segments": []}, edited, "x") == []


def test_extraction_ignores_automatic_changes_and_keeps_deleted_text():
    raw = {"segments": [{"id": 8, "start": 4, "end": 6, "text": "im tal"}]}
    auto = {"segments": [{"id": 8, "text": "in Mels"}]}
    edited = {"segments": [{"id": 8, "start": 4, "end": 6, "text": "in Mels"}]}
    assert se.extract_candidates(raw, auto, edited, "x") == []
    edited["segments"][0]["text"] = ""
    assert se.extract_candidates(raw, auto, edited, "x")[0]["reference"] == ""


@pytest.mark.parametrize("pfad", [3, None, ["hyp.json"], ""])
def test_cli_weist_nicht_string_pfade_im_manifest_ab(tmp_path, capsys, pfad):
    """Das Manifest ist eine Vertrauensgrenze — es wird von Hand geschrieben.

    Ein Nicht-String liess `args.manifest.parent / path` mit `TypeError` werfen, und den
    faengt das umgebende `except (OSError, ValueError)` NICHT: der Nutzer bekam einen
    Traceback statt einer Fehlermeldung (CodeRabbit). Der leere String steht mit in der
    Liste, weil `parent / ""` KEINEN TypeError wirft, sondern still das Elternverzeichnis
    ergibt — ein anderer Weg, derselbe unbrauchbare Ausgang.
    """
    manifest = tmp_path / "cases.json"
    manifest.write_text(json.dumps({"cases": [case()], "hypotheses": {"a": pfad}}), encoding="utf-8")
    with pytest.raises(SystemExit) as abbruch:
        se.main(["score", "--manifest", str(manifest)])
    assert abbruch.value.code == 2                      # argparse-Fehler, kein Traceback
    assert "hypotheses" in capsys.readouterr().err


def test_cli_reads_manifest_relative_paths_and_writes_valid_json(tmp_path):
    (tmp_path / "hyp.json").write_text(json.dumps(hypothesis("ein guter tag")), encoding="utf-8")
    manifest = tmp_path / "cases.json"
    manifest.write_text(json.dumps({"cases": [case()], "hypotheses": {"a": "hyp.json"}}), encoding="utf-8")
    output = tmp_path / "report.json"
    assert se.main(["score", "--manifest", str(manifest), "--output", str(output)]) == 0
    assert json.loads(output.read_text(encoding="utf-8"))["reviewed"]["wer"]["rate"] == 0


def test_cli_single_hypothesis_keeps_missing_other_audio_cases(tmp_path):
    manifest = tmp_path / "cases.json"
    manifest.write_text(json.dumps({"cases": [case(), case(case_id="c2", audio_id="b")]}), encoding="utf-8")
    hyp = tmp_path / "hyp.json"
    hyp.write_text(json.dumps(hypothesis("ein guter tag")), encoding="utf-8")
    output = tmp_path / "report.json"
    assert se.main(["score", "--manifest", str(manifest), "--hypothesis", str(hyp), "--audio-id", "a", "--output", str(output)]) == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["reviewed"]["case_count"] == 2
    assert report["reviewed"]["wer"]["rate"] == 0.5
