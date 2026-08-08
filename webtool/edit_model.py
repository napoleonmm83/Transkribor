"""Whisper-Rohausgabe (<base>.json) -> kanonisches edit.json-Dokument."""

import re

_TAG_RE = re.compile(r"\[\[(.+?)\|[0-9.]+\]\]")

COMPRESSION_RATIO_THRESHOLD = 2.4
NO_SPEECH_THRESHOLD = 0.6
LOGPROB_THRESHOLD = -1.0


def compute_flags(segment: dict) -> dict:
    cr = segment.get("compression_ratio", 0.0)
    nsp = segment.get("no_speech_prob", 0.0)
    alp = segment.get("avg_logprob", 0.0)
    return {
        "hallucination": cr > COMPRESSION_RATIO_THRESHOLD,
        "silence": nsp > NO_SPEECH_THRESHOLD and alp < LOGPROB_THRESHOLD,
        "low_conf": alp < LOGPROB_THRESHOLD,
    }


def build_edit_doc(raw: dict, *, base: str, project: str, audio: str) -> dict:
    segments = []
    for seg in raw.get("segments", []):
        text = (seg.get("text") or "").strip()
        segments.append({
            "id": seg.get("id"),
            "start": seg.get("start"),
            "end": seg.get("end"),
            "speaker": "",
            "raw_text": text,
            "text": text,
            "words": [
                {"word": w.get("word", ""), "start": w.get("start"),
                 "end": w.get("end"), "probability": w.get("probability", 1.0)}
                for w in seg.get("words", [])
            ],
            "flags": compute_flags(seg),
            "note": "",
        })
    return {
        "base": base,
        "project": project,
        "audio": audio,
        "language": raw.get("language", "de"),
        "human_edited": False,
        "context": "",
        "summary": "",
        "speakers": [],
        "segments": segments,
        "annotations": [],
    }


UNCERTAIN_TAG_THRESHOLD = 0.5


def tag_uncertain_segments(raw: dict, threshold: float = UNCERTAIN_TAG_THRESHOLD) -> list:
    """Pro Roh-Segment ein {id,start,end,tagged_text}; Wörter mit
    probability < threshold inline als [[Wort|0.pp]] markiert (für die LLM-Korrektur)."""
    out = []
    for seg in raw.get("segments", []):
        words = seg.get("words", [])
        if words:
            parts = []
            for w in words:
                word = w.get("word", "")
                prob = w.get("probability", 1.0)
                stripped = word.strip()
                if stripped and prob < threshold:
                    lead = word[: len(word) - len(word.lstrip())]  # führende Leerzeichen erhalten
                    parts.append(f"{lead}[[{stripped}|{prob:.2f}]]")
                else:
                    parts.append(word)
            tagged = "".join(parts).strip()
        else:
            tagged = (seg.get("text") or "").strip()
        out.append({
            "id": seg.get("id"),
            "start": seg.get("start"),
            "end": seg.get("end"),
            "tagged_text": tagged,
        })
    return out


def apply_correction(raw: dict, correction: dict, *, base: str, project: str, audio: str) -> dict:
    """edit.json aus Roh bauen und die segment-genaue Korrektur (Text/Sprecher je id)
    sowie context/speakers/annotations einweben. Nicht korrigierte Segmente behalten Rohtext."""
    doc = build_edit_doc(raw, base=base, project=project, audio=audio)
    doc["context"] = (correction.get("context") or "").strip()
    # summary fiel bisher still heraus: die correction.json hatte es, die edit.json nie —
    # der Korrektur-Pass schrieb also 14 von 14 Zusammenfassungen in den Papierkorb.
    # `verification` bleibt bewusst in der correction.json: das ist Prüfprotokoll, kein Inhalt.
    doc["summary"] = (correction.get("summary") or "").strip()
    doc["speakers"] = list(correction.get("speakers") or [])
    doc["annotations"] = [str(a).strip() for a in (correction.get("annotations") or []) if a is not None and str(a).strip()]
    by_id = {c.get("id"): c for c in (correction.get("segments") or [])}
    for seg in doc["segments"]:
        c = by_id.get(seg["id"])
        if c is not None:
            text = _TAG_RE.sub(r"\1", (c.get("text") or "")).strip()  # evtl. uebrige [[Wort|prob]]-Marker entfernen
            if text:
                seg["text"] = text
            seg["speaker"] = (c.get("speaker") or "").strip()
    return doc
