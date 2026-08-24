"""Whisper-Rohausgabe (<base>.json) -> kanonisches edit.json-Dokument."""

import re

_TAG_RE = re.compile(r"\[\[(.+?)\|[0-9.]+\]\]")

MUSIK = "[Musik]"
# Gesungenes transkribiert Whisper zu selbstbewusstem Unsinn — gemessen an einem Open-Air-Mitschnitt:
# "Find the Strub!" sechsmal in Folge, dabei compression_ratio 1.80 und avg_logprob -0.34, also weit
# innerhalb aller Schwellen. Kein Zahlenfilter kann das finden; die LLM-Korrektur erkennt es dagegen
# von selbst. Sie markiert solche Stellen mit "[Musik]" — hier auf EINE Schreibweise gebracht, damit
# die Exporte aufeinanderfolgende Musikblöcke zusammenziehen können.
_MUSIK_RE = re.compile(r"^[\[(]\s*(musik|music|gesang|singt|instrumental|applaus|jubel|♪+)\b[^\])]*[\])]$|^♪+$", re.I)

COMPRESSION_RATIO_THRESHOLD = 2.4
LOGPROB_THRESHOLD = -1.0


def compute_flags(segment: dict, *, is_repeat: bool = False) -> dict:
    """Auffälligkeiten je Segment für die Editor-Anzeige.

    - "hallucination": compression_ratio > 2.4 ODER aufeinanderfolgende Textwiederholung (ASR-Loop)
    - "low_conf": avg_logprob < -1.0
    """
    cr = segment.get("compression_ratio", 0.0)
    alp = segment.get("avg_logprob", 0.0)
    return {
        "hallucination": bool(is_repeat or cr > COMPRESSION_RATIO_THRESHOLD),
        "low_conf": alp < LOGPROB_THRESHOLD,
    }


def build_edit_doc(raw: dict, *, base: str, project: str, audio: str) -> dict:
    segments = []
    letzter_norm = None
    wiederholungs_zaehler = 0
    for seg in raw.get("segments", []):
        text = (seg.get("text") or "").strip()
        norm = re.sub(r"[^\w\s]", "", text.lower()).strip()
        if norm and norm == letzter_norm:
            wiederholungs_zaehler += 1
        else:
            letzter_norm = norm if norm else None
            wiederholungs_zaehler = 0
        is_repeat = bool(wiederholungs_zaehler >= 2 and (len(norm.split()) > 1 or len(norm) > 4))
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
            "flags": compute_flags(seg, is_repeat=is_repeat),
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
        # Aus dem Rohtranskript durchgereicht (#83), NICHT hier berechnet: die Dauer der
        # Aufnahme steht nur dort, und ohne sie waere ein uebersprungenes Fenster am Dateiende
        # unsichtbar. Ein eigenes Feld und nicht `annotations` — die ersetzt
        # `apply_correction` vollstaendig durch die Liste des LLM, der Hinweis waere nach dem
        # ersten Korrekturlauf weg. Alte Roh-JSON haben es nicht: dann leer.
        "luecken": raw.get("luecken") or [],
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


_META_PATTERNS = [
    re.compile(r"\b(halluzinations[- ]?schleife|asr[- ]?halluzination|wiederholungsschleife des satzes)\b", re.I),
    re.compile(r"\b(in diesem block|dieser abschnitt|dieser teil).*(keinen verwertbaren inhalt|keinen gesprächsinhalt|keinen inhalt)\b", re.I),
    re.compile(r"\b(tonspur|transkription).*(keinen verwertbaren inhalt|halluzination)\b", re.I),
]


def _ist_reiner_halluzinations_kommentar(text: str) -> bool:
    return any(p.search(text) for p in _META_PATTERNS)


def bereinige_summary(text: str) -> str:
    """Entfernt Meta-Kommentare über leere Blöcke oder Halluzinationsschleifen aus der Zusammenfassung."""
    if not text:
        return ""
    saetze = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    saetze_bereinigt = [s for s in saetze if not _ist_reiner_halluzinations_kommentar(s)]
    return " ".join(saetze_bereinigt).strip()


def apply_correction(raw: dict, correction: dict, *, base: str, project: str, audio: str) -> dict:
    """edit.json aus Roh bauen und die segment-genaue Korrektur (Text/Sprecher je id)
    sowie context/speakers/annotations einweben. Nicht korrigierte Segmente behalten Rohtext."""
    doc = build_edit_doc(raw, base=base, project=project, audio=audio)
    doc["context"] = (correction.get("context") or "").strip()
    # summary fiel bisher still heraus: die correction.json hatte es, die edit.json nie —
    # der Korrektur-Pass schrieb also 14 von 14 Zusammenfassungen in den Papierkorb.
    # `verification` bleibt bewusst in der correction.json: das ist Prüfprotokoll, kein Inhalt.
    doc["summary"] = bereinige_summary((correction.get("summary") or "").strip())
    doc["speakers"] = list(correction.get("speakers") or [])
    doc["annotations"] = [str(a).strip() for a in (correction.get("annotations") or []) if a is not None and str(a).strip()]
    by_id = {c.get("id"): c for c in (correction.get("segments") or [])}
    for seg in doc["segments"]:
        c = by_id.get(seg["id"])
        if c is not None:
            # Ein leerer Text ist eine ENTSCHEIDUNG ("streich das"), kein fehlender Wert — aber nur,
            # wenn der Schlüssel überhaupt dasteht. Vorher stand hier `if text:`, und damit fiel
            # jede Streichung unter den Tisch: die Korrektur leerte vier Segmente mit dem
            # ASR-Artefakt "ARD Text im Auftrag von Funk" (Untertitel-Floskel aus Whispers
            # Trainingsdaten, im Ton nicht vorhanden) — im Export standen sie trotzdem alle vier.
            if "text" in c:
                text = _TAG_RE.sub(r"\1", (c.get("text") or "")).strip()  # evtl. uebrige [[Wort|prob]]-Marker entfernen
                seg["text"] = MUSIK if _MUSIK_RE.match(text) else text
            seg["speaker"] = (c.get("speaker") or "").strip()
    return doc
