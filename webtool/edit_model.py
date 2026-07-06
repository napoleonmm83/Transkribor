"""Whisper-Rohausgabe (<base>.json) -> kanonisches edit.json-Dokument."""

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
