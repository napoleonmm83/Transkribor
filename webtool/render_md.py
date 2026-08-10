"""edit.json-Dokument -> Markdown-Export (<base>.md).

Reihenfolge: Kontext, Zusammenfassung, dann das Gespraech, Anmerkungen ans Ende. Wer die
Datei oeffnet, fragt zuerst "worum geht es hier" — nicht nach 400 Segmenten.
"""


from .edit_model import MUSIK


def render_md(doc: dict) -> str:
    segs = doc.get("segments", [])
    lines = [f"# Interview {doc.get('base', '')}", ""]
    context = (doc.get("context") or "").strip()
    if context:
        lines += [f"**Kontext:** {context}", ""]
    summary = (doc.get("summary") or "").strip()
    if summary:
        lines += ["## Zusammenfassung", "", summary, ""]
    lines += ["---", ""]

    i = 0
    while i < len(segs):
        speaker = (segs[i].get("speaker") or "").strip() or "Befragte Person"
        texts = []
        j = i
        while j < len(segs) and ((segs[j].get("speaker") or "").strip() or "Befragte Person") == speaker:
            t = (segs[j].get("text") or "").strip()
            # Sechs "[Musik]" hintereinander sind sechsmal dieselbe Information.
            if t and not (t == MUSIK and texts[-1:] == [MUSIK]):
                texts.append(t)
            j += 1
        if texts:
            lines += [f"**{speaker}:** {' '.join(texts)}", ""]
        i = j

    notes = [n.strip() for n in doc.get("annotations", []) if n.strip()]
    notes += [(s.get("note") or "").strip() for s in segs if (s.get("note") or "").strip()]
    if notes:
        lines += ["## Anmerkungen"]
        lines += [f"- {n}" for n in notes]
        lines += [""]

    return "\n".join(lines).rstrip() + "\n"
