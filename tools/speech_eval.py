"""Offline text-span evaluation, independent of segment IDs.

Only reviewed references contribute to quality metrics. Draft agreement is
reported separately. No model or external service is called.
"""
import argparse
import json
import math
import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def normalize_text(text: object) -> str:
    if not isinstance(text, str):
        raise ValueError("text/reference must be a string")
    text = unicodedata.normalize("NFKC", text).casefold()
    characters = []
    for index, char in enumerate(text):
        if char in "-−" and index + 1 < len(text) and text[index + 1].isdecimal():
            characters.append("-")
        else:
            characters.append(" " if unicodedata.category(char).startswith("P") else char)
    return " ".join("".join(characters).split())


def _interval(item: dict, *, positive: bool = False) -> tuple:
    start: Any = item.get("start")
    end: Any = item.get("end")
    if any(isinstance(v, bool) or not isinstance(v, (int, float))
           or not math.isfinite(v) for v in (start, end)):
        raise ValueError("start/end must be finite numbers")
    if start < 0 or end < start or (positive and end == start):
        raise ValueError("invalid start/end interval")
    return start, end


def _segments(raw: dict) -> list:
    if not isinstance(raw, dict) or not isinstance(raw.get("segments"), list):
        raise ValueError("hypothesis must contain a segments list")
    for segment in raw["segments"]:
        if not isinstance(segment, dict):
            raise ValueError("segment must be an object")
        _interval(segment)
        normalize_text(segment.get("text"))
    return sorted(raw["segments"], key=lambda s: (s["start"], s["end"]))


def _timed_words(segment: dict) -> list | None:
    words = segment.get("words")
    if not isinstance(words, list) or not words:
        return None
    try:
        geklemmt = []
        for word in words:
            if not isinstance(word, dict):
                return None
            start, end = _interval(word)
            normalize_text(word.get("word"))
            # Ein Wort darf ueber die Segmentgrenze haengen — ASR-Ausgaben tun das
            # regelmaessig (an echten Whisper-Laeufen 26 von 1699 Segmenten). Frueher
            # wurden dafuer die Wortzeiten des GANZEN Segments verworfen, womit der
            # Segment-Rueckfall griff und der Text in JEDES ueberlappende Fenster wanderte
            # — der Waechter erzeugte also genau die Doppelzaehlung, gegen die er schuetzt
            # (gemessen: 28 doppelte Woerter bei 5-s-Fenstern mit, 0 ohne). Geklemmt wird
            # auf die Segmentgrenze; das haelt den Schutz und behaelt die Zeiten.
            start, end = max(start, segment["start"]), min(end, segment["end"])
            if start > end:
                return None      # Wort liegt GANZ ausserhalb seines Segments: kaputte Daten
            geklemmt.append({**word, "start": start, "end": end})
        words = sorted(geklemmt, key=lambda w: (w["start"], w["end"]))
        # Rewritten segments may retain the original ASR word payload.
        if normalize_text(" ".join(w["word"] for w in words)) != normalize_text(segment["text"]):
            return None
    except ValueError:
        return None
    return words


def _overlaps(start: float, end: float, left: float, right: float) -> bool:
    return start < right and end > left if end > start else left <= start < right


def _select(segments: list, start: float, end: float) -> tuple:
    pieces, methods = [], set()
    crossings = fallbacks = 0
    for segment in segments:
        left, right = segment["start"], segment["end"]
        if not _overlaps(left, right, start, end):
            continue
        timed = _timed_words(segment)
        if timed is None:
            beitrag = segment["text"].strip()
            # Nur ein Segment, das wirklich TEXT beisteuert, ist ein verzerrender
            # Rueckfall — ein leeres wandert in kein Fenster und erzeugt keine
            # Einfuegungen. Ohne diese Unterscheidung fiele eine leere Hypothese aus der
            # Kennzahl, obwohl sie die ehrlichste Messung ueberhaupt ist: lauter Loeschungen.
            if beitrag:
                methods.add("segment_overlap")
            crossings += int(left < start or right > end)
            fallbacks += int(bool(segment.get("words")))
            pieces.append((max(left, start), beitrag))
        else:
            methods.add("word_midpoint")
            for word in timed:
                left, right = word["start"], word["end"]
                if _overlaps(left, right, start, end):
                    crossings += int(left < start or right > end)
                terminal_point = left == right == segment["end"] and right <= end
                if start <= (left + right) / 2 < end or terminal_point:
                    pieces.append(((left + right) / 2, word["word"].strip()))
    method = next(iter(methods)) if len(methods) == 1 else "mixed" if methods else "no_overlap"
    return " ".join(text for _, text in sorted(pieces, key=lambda p: p[0]) if text), {
        "method": method, "boundary_crossings": crossings,
        "approximate": crossings > 0, "word_fallbacks": fallbacks,
    }


def _metric(reference, hypothesis) -> dict:
    # Rolling Levenshtein rows retain S/D/I counts; ties prefer S, then D, then I.
    previous = [(0, 0, i) for i in range(len(hypothesis) + 1)]
    for r_index, expected in enumerate(reference, 1):
        current = [(0, r_index, 0)]
        for h_index, actual in enumerate(hypothesis, 1):
            if expected == actual:
                current.append(previous[h_index - 1])
            else:
                s, d, i = previous[h_index - 1]
                substitution = (s + 1, d, i)
                s, d, i = previous[h_index]
                deletion = (s, d + 1, i)
                s, d, i = current[h_index - 1]
                insertion = (s, d, i + 1)
                current.append(min((substitution, deletion, insertion), key=sum))
        previous = current
    substitutions, deletions, insertions = previous[-1]
    errors = substitutions + deletions + insertions
    return {"reference_length": len(reference), "hypothesis_length": len(hypothesis),
            "substitutions": substitutions, "deletions": deletions, "insertions": insertions,
            "errors": errors, "rate": errors / len(reference) if reference else None}


def _silence_summary(rows: list) -> dict:
    # Absent documents are unknown output; an existing empty transcript is silence.
    available = [row for row in rows if row["selection"]["method"] != "missing_hypothesis"]
    return {
        "case_count": len(available),
        "annotated_case_seconds": sum(row["end"] - row["start"] for row in available),
        "hallucinated_word_count": sum(row["wer"]["hypothesis_length"] for row in available),
        "hallucinated_cases": sum(row["wer"]["hypothesis_length"] > 0 for row in available),
        "missing_hypothesis_cases": len(rows) - len(available),
    }


def _aggregate(rows: list) -> dict:
    result: dict[str, Any] = {"case_count": len(rows)}
    for kind in ("wer", "cer"):
        metric = {key: sum(row[kind][key] for row in rows) for key in (
            "reference_length", "hypothesis_length", "substitutions", "deletions", "insertions", "errors"
        )}
        metric["rate"] = metric["errors"] / metric["reference_length"] if metric["reference_length"] else None
        result[kind] = metric
    return result


def score_cases(cases: list, hypothesis: dict) -> dict:
    """Score every case; missing audio is empty speech, never a dropped case.

    hypothesis maps audio IDs to raw documents, or is a single raw document
    for cases naming one audio. Approximate span selection is reported.
    """
    if not isinstance(cases, list) or not isinstance(hypothesis, dict):
        raise ValueError("cases must be a list and hypothesis an object")
    ids, audios = set(), set()
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("case must be an object")
        for key in ("case_id", "audio_id"):
            if not isinstance(case.get(key), str) or not case[key]:
                raise ValueError(f"{key} must be a nonempty string")
        if case["case_id"] in ids:
            raise ValueError("duplicate case_id")
        ids.add(case["case_id"])
        audios.add(case["audio_id"])
        _interval(case, positive=True)
        normalize_text(case.get("reference"))
        if not isinstance(case.get("reviewed"), bool):
            raise ValueError("reviewed must be an explicit boolean")
        kind = case.get("reference_kind", "speech")
        if kind not in ("speech", "silence"):
            raise ValueError("reference_kind must be speech or silence")
        if kind == "silence" and normalize_text(case["reference"]):
            raise ValueError("silence reference must contain no spoken text")
    if isinstance(hypothesis.get("segments"), list):
        if len(audios) != 1:
            raise ValueError("single hypothesis requires exactly one audio_id")
        hypothesis = {next(iter(audios)): hypothesis}
    prepared = {audio: _segments(hypothesis[audio]) for audio in audios if audio in hypothesis}
    rows = []
    for case in cases:
        audio = case["audio_id"]
        text, selection = _select(prepared.get(audio, []), case["start"], case["end"])
        if audio not in prepared:
            selection["method"] = "missing_hypothesis"
        reference, normalized = normalize_text(case["reference"]), normalize_text(text)
        kind = case.get("reference_kind", "speech")
        if kind == "silence":
            group = "reviewed_silence" if case["reviewed"] else "candidate_silence"
        else:
            group = "excluded_empty_reference" if not reference else "reviewed" if case["reviewed"] else "candidate_only"
        rows.append({key: case[key] for key in ("case_id", "audio_id", "start", "end", "reference", "reviewed")} | {
            "category": case.get("category"), "reference_kind": kind, "group": group, "hypothesis": text,
            "selection": selection, "wer": _metric(reference.split(), normalized.split()),
            "cer": _metric(reference, normalized),
        })
    # Faelle, in denen mindestens ein Segment ohne brauchbare Wortzeiten ausgewaehlt wurde,
    # gehen NICHT in die Kennzahl ein. Dort wandert der ganze Segmenttext in jedes
    # ueberlappende Fenster, was Einfuegungen erzeugt, die nichts ueber die Qualitaet sagen:
    # zwei Hypothesen mit WORTGLEICHEM Text ergaben 0,0 gegen 0,0998 (30-s-Fenster), 0,6617
    # bei 5 s. Und es trifft systematisch die korrigierten Laeufe — `_timed_words` verwirft
    # die Zeiten, sobald der Text nicht mehr zu den Woertern passt, also genau dort, wo
    # korrigiert wurde (an echten Laeufen 75 von 327 Segmenten gegen 25 von 1699 roh).
    # Eine Zahl, die das mitmisst, bestraft das Korrigieren. Sie stehen als eigener Posten
    # `reviewed_untimed` daneben — sichtbar, aber getrennt (Entscheidung Marcus 2026-09-17).
    UNGETIMT = ("segment_overlap", "mixed")
    reviewed_alle = [row for row in rows if row["group"] == "reviewed"]
    untimed = [row for row in reviewed_alle if row["selection"]["method"] in UNGETIMT]
    reviewed = [row for row in reviewed_alle if row["selection"]["method"] not in UNGETIMT]
    candidates = [row for row in rows if row["group"] == "candidate_only"]
    # Die Trennung gilt fuer STILLE genauso. Ein geprueftes Stillefenster, dessen Auswahl
    # auf den ganzen Segmenttext zurueckfaellt, zaehlte sonst Halluzinationen, von denen
    # kein einziges Wort im Fenster belegt ist — gemessen: ein 1-s-Fenster in einem
    # 30-s-Segment ohne Wortzeiten meldete 8 halluzinierte Woerter. Das trifft die
    # KOPFZAHL dieses Werkzeugs (halluzinierte Woerter in Stille ist die Zahl, fuer die
    # `reference_kind: silence` existiert), und es machte die eigene `scope`-Zeile falsch.
    silence_alle = [row for row in rows if row["group"] == "reviewed_silence"]
    silence_untimed = [row for row in silence_alle if row["selection"]["method"] in UNGETIMT]
    silence = [row for row in silence_alle if row["selection"]["method"] not in UNGETIMT]
    draft_alle = [row for row in rows if row["group"] == "candidate_silence"]
    draft_silence = [row for row in draft_alle if row["selection"]["method"] not in UNGETIMT]
    silence_summary = _silence_summary(silence)
    # Fuer die ABDECKUNG zaehlen auch die ungetimten Faelle: der Nutzer hat sie geprueft.
    # Getrennt wird nur, was in die KENNZAHL eingeht.
    reviewed_count = len(reviewed_alle) + len(silence_alle)
    return {
        "version": 1, "quality_evidence_available": bool(reviewed or silence_summary["case_count"]),
        "scope": "Text agreement in supplied spans only; no speaker/timing score. Explicit reviewed silence counted separately. Seconds sum case durations including overlaps. Candidate distances are not quality evidence. Cases whose span selection fell back to whole segments (no usable word times) are reported under reviewed_untimed (speech) and reviewed_silence_untimed (silence) and are NOT part of the reviewed rate or the silence hallucination counts: that fallback repeats segment text across overlapping windows, so its insertions measure timing availability, not transcript quality, and its words are not evidenced to lie inside the window at all.",
        "normalization": "NFKC, casefold (ss), numeric minus preserved/canonicalized, other punctuation to spaces, collapsed whitespace; CER includes spaces",
        "coverage": {"total_cases": len(rows), "reviewed_cases": reviewed_count,
                     "reviewed_speech_cases": len(reviewed_alle), "reviewed_silence_cases": len(silence_alle),
                     # Was von den geprueften Sprachfaellen wirklich in `reviewed` steckt —
                     # und was mangels Wortzeiten daneben liegt. Beide Zahlen zusammen
                     # ergeben `reviewed_speech_cases`; steht `untimed_fallback_cases` hoch,
                     # sagt die Rate ueber einen grossen Teil des Materials nichts.
                     "scored_speech_cases": len(reviewed),
                     "untimed_fallback_cases": len(untimed) + len(silence_untimed),
                     "candidate_cases": len(candidates) + len(draft_alle),
                     "excluded_empty_reference": sum(row["group"] == "excluded_empty_reference" for row in rows),
                     "reviewed_case_fraction": reviewed_count / len(rows) if rows else None,
                     # Dieselbe Grundgesamtheit wie `reviewed_cases` und
                     # `reviewed_case_fraction` — also MIT den ungetimten Faellen. Sie aus
                     # den Sekunden herauszunehmen, waehrend sie in der Fallzahl stehen,
                     # liesse zwei Abdeckungszahlen ueber verschiedene Mengen sprechen
                     # (CodeRabbit-CLI). Was in die KENNZAHL eingeht, sagt allein
                     # `scored_speech_cases`.
                     "reviewed_case_seconds": sum(row["end"] - row["start"] for row in reviewed_alle + silence_alle),
                     "missing_hypothesis_cases": sum(row["selection"]["method"] == "missing_hypothesis" for row in rows),
                     "boundary_uncertain_cases": sum(row["selection"]["approximate"] for row in rows)},
        "reviewed": _aggregate(reviewed), "reviewed_untimed": _aggregate(untimed),
        "candidate_only": _aggregate(candidates),
        "reviewed_silence": silence_summary, "reviewed_silence_untimed": _silence_summary(silence_untimed), "candidate_silence": _silence_summary(draft_silence), "cases": rows,
    }


def extract_candidates(raw: dict, corrected: dict, edited: dict, audio_id: str) -> list:
    """Find text edits for review; human_edited never means verified gold.

    Untimed correction output inherits raw times by ID within this pipeline.
    Compare edited spans by time, even if the editor renumbered them.
    """
    from webtool.edit_model import apply_correction

    original, edits = _segments(raw), _segments(edited)
    if not isinstance(corrected, dict) or not isinstance(corrected.get("segments"), list):
        raise ValueError("corrected must contain a segments list")
    if any(not isinstance(segment, dict) for segment in corrected["segments"]):
        raise ValueError("correction segment must be an object")
    # The editor retains raw text when correction text/IDs are absent and treats
    # explicit empty text as deletion. Use that contract, including tag cleanup.
    automatic = _segments(apply_correction(raw, corrected, base=audio_id, project="", audio=""))
    candidates = []
    for index, segment in enumerate(edits):
        start, end = _interval(segment, positive=True)
        auto, auto_selection = _select(automatic, start, end)
        if normalize_text(auto) == normalize_text(segment["text"]):
            continue
        raw_text, raw_selection = _select(original, start, end)
        candidates.append({"case_id": f"{audio_id}-{index}", "audio_id": audio_id,
                           "start": start, "end": end, "reference": segment["text"],
                           "reviewed": False, "category": "manual_text_edit_candidate",
                           "raw": raw_text, "auto": auto,
                           "selection": {"raw": raw_selection, "auto": auto_selection}})
    return candidates


def _read(path) -> dict:
    value: object = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("JSON document must contain an object")
    return value


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    score = commands.add_parser("score", help="Score reviewed spans; report drafts separately")
    score.add_argument("--manifest", required=True, type=Path)
    score.add_argument("--hypothesis", type=Path)
    score.add_argument("--audio-id")
    extract = commands.add_parser("extract", help="Extract unreviewed manual-edit candidates")
    for name in ("raw", "corrected", "edited"):
        extract.add_argument(f"--{name}", required=True, type=Path)
    extract.add_argument("--audio-id", required=True)
    for command in (score, extract):
        command.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "extract":
            result = {"version": 1, "cases": extract_candidates(
                _read(args.raw), _read(args.corrected), _read(args.edited), args.audio_id)}
        else:
            manifest = _read(args.manifest)
            if not isinstance(manifest, dict) or not isinstance(manifest.get("cases"), list):
                raise ValueError("manifest must contain a cases list")
            if args.hypothesis:
                hypotheses = _read(args.hypothesis)
                if args.audio_id:
                    hypotheses = {args.audio_id: hypotheses}
            else:
                if args.audio_id:
                    raise ValueError("--audio-id requires --hypothesis")
                paths = manifest.get("hypotheses", {})
                if not isinstance(paths, dict):
                    raise ValueError("manifest hypotheses must map audio IDs to paths")
                # Das Manifest ist eine Vertrauensgrenze: es wird von Hand geschrieben.
                # Ein Nicht-String (Zahl, null, Liste) liesse `parent / path` mit TypeError
                # werfen, und den faengt das umgebende `except (OSError, ValueError)` NICHT —
                # der Nutzer saehe einen Traceback statt einer Fehlermeldung (CodeRabbit).
                if any(not isinstance(path, str) or not path for path in paths.values()):
                    raise ValueError("manifest hypotheses must map audio IDs to non-empty path strings")
                hypotheses = {audio: _read(args.manifest.parent / path) for audio, path in paths.items()}
            result = score_cases(manifest["cases"], hypotheses)
        content = json.dumps(result, ensure_ascii=args.output is None, indent=2, allow_nan=False) + "\n"
        if args.output:
            args.output.write_text(content, encoding="utf-8")
        else:
            print(content, end="")
    except (OSError, ValueError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
