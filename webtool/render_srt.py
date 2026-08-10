"""edit.json-Dokument -> SRT-Untertitel (<base>.srt) fuer den YouTube-Upload.

Zwilling von render_md.py: gleiche Eingabe, andere Ausgabe. YouTube Studio nimmt die Datei
unter "Untertitel > Datei hochladen" und ersetzt damit das automatische Transkript.

Der Sprechername steht **nur beim Wechsel** und mit ">>" davor (Untertitel-Konvention): in
jeder Zeile frisst er den halben Schirm, ganz weggelassen verliert man bei zwei Stimmen den
Faden.
"""

MAX_ZEILE = 42  # Untertitel-Konvention; laengere Zeilen laufen quer ueber das Bild


def _zeit(sek: float) -> str:
    """Sekunden -> HH:MM:SS,mmm (SRT will Komma als Dezimaltrenner, nicht Punkt)."""
    ms = max(0, round(sek * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _umbrechen(text: str) -> list[str]:
    zeilen, aktuell = [], ""
    for wort in text.split():
        if aktuell and len(aktuell) + 1 + len(wort) > MAX_ZEILE:
            zeilen.append(aktuell)
            aktuell = wort
        else:
            aktuell = f"{aktuell} {wort}" if aktuell else wort
    if aktuell:
        zeilen.append(aktuell)
    return zeilen


def render_srt(doc: dict) -> str:
    bloecke: list[str] = []
    letzter_sprecher = None
    for seg in doc.get("segments", []):
        text = (seg.get("text") or "").strip()
        start, end = seg.get("start"), seg.get("end")
        if not text or start is None or end is None:
            continue  # uebersprungene Segmente duerfen keine Luecke in die Nummerierung reissen
        sprecher = (seg.get("speaker") or "").strip()
        if sprecher and sprecher != letzter_sprecher:
            text = f">> {sprecher}: {text}"
        letzter_sprecher = sprecher
        bloecke.append("\n".join([
            str(len(bloecke) + 1),
            f"{_zeit(start)} --> {_zeit(end)}",
            *_umbrechen(text),
        ]))
    return "\n\n".join(bloecke) + ("\n" if bloecke else "")
