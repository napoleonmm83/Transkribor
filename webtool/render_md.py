"""edit.json-Dokument -> Markdown-Export (<base>.md).

Reihenfolge: Kontext, Zusammenfassung, dann das Gespraech, Anmerkungen ans Ende. Wer die
Datei oeffnet, fragt zuerst "worum geht es hier" — nicht nach 400 Segmenten.
"""


import math

from .edit_model import MUSIK

# AIRLOCK-OHNE-PLANWERKZEUG: Chat-Plan wurde vorgelegt und am 28.09.2026 freigegeben.


def _zeit(sekunden: float) -> str:
    ms = max(0, round(sekunden * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _ist_zeit(wert) -> bool:
    return isinstance(wert, (int, float)) and not isinstance(wert, bool) and math.isfinite(wert)


def _mit_zeit(text: str, start: float | None, end: float | None) -> str:
    if not (_ist_zeit(start) and _ist_zeit(end) and end >= start):
        return text
    return f"[{_zeit(start)}–{_zeit(end)}] {text}"


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
        teile = []
        j = i
        while j < len(segs) and ((segs[j].get("speaker") or "").strip() or "Befragte Person") == speaker:
            seg = segs[j]
            t = (seg.get("text") or "").strip()
            # Sechs "[Musik]" hintereinander sind sechsmal dieselbe Information.
            if t == MUSIK and teile and teile[-1][0] == MUSIK:
                anfang, ende = teile[-1][1:]
                naechster_anfang, naechstes_ende = seg.get("start"), seg.get("end")
                if (_ist_zeit(anfang) and _ist_zeit(ende) and
                        _ist_zeit(naechster_anfang) and _ist_zeit(naechstes_ende) and
                        anfang <= ende and naechster_anfang <= ende <= naechstes_ende):
                    teile[-1] = (MUSIK, anfang, naechstes_ende)
                elif anfang is ende is naechster_anfang is naechstes_ende is None:
                    pass
                else:
                    teile.append((t, naechster_anfang, naechstes_ende))
            elif t:
                teile.append((t, seg.get("start"), seg.get("end")))
            j += 1
        if teile:
            lines += [f"**{speaker}:** {' '.join(_mit_zeit(*teil) for teil in teile)}", ""]
        i = j

    notes = [n.strip() for n in doc.get("annotations", []) if n.strip()]
    notes += [(s.get("note") or "").strip() for s in segs if (s.get("note") or "").strip()]
    if notes:
        lines += ["## Anmerkungen"]
        lines += [f"- {n}" for n in notes]
        lines += [""]

    return "\n".join(lines).rstrip() + "\n"
