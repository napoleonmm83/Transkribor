"""edit.json-Dokument -> SRT-Untertitel (<base>.srt) fuer den YouTube-Upload.

Zwilling von render_md.py: gleiche Eingabe, andere Ausgabe. YouTube Studio nimmt die Datei
unter "Untertitel > Datei hochladen" und ersetzt damit das automatische Transkript.

Der Sprechername steht **nur beim Wechsel** und mit ">>" davor (Untertitel-Konvention): in
jeder Zeile frisst er den halben Schirm, ganz weggelassen verliert man bei zwei Stimmen den
Faden.
"""

from .edit_model import MUSIK

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


def _brauchbar(seg: dict) -> bool:
    """Ruecklaeufige Zeitspannen fliegen mit raus: `end < start` ist ungueltiges SRT. Ob
    YouTube dann nur den Cue oder die ganze Datei verwirft, haben wir nicht gemessen —
    beides ist schlimmer als ein fehlender Untertitel. Whisper liefert so etwas nicht,
    eine von Hand bearbeitete edit.json schon."""
    start, end = seg.get("start"), seg.get("end")
    return bool((seg.get("text") or "").strip()) and start is not None and end is not None and end >= start


def render_srt(doc: dict, sprecher: bool = True) -> str:
    """`sprecher=False` laesst die ">> Name:"-Praefixe weg — bei einem Monolog tragen sie
    nichts bei, und wer den Namen im Bild nicht haben will, soll ihn abschalten koennen."""
    segs = [s for s in doc.get("segments", []) if _brauchbar(s)]
    bloecke: list[str] = []
    letzter_sprecher = None
    i = 0
    while i < len(segs):
        text = (segs[i].get("text") or "").strip()
        start, end = segs[i]["start"], segs[i]["end"]
        if text == MUSIK:
            # Ein Gesangsblock sind schnell sechs Segmente — als sechs Cues stünde sechsmal
            # dieselbe Zeile da. Zu EINEM Cue über die ganze Spanne zusammenziehen.
            while i + 1 < len(segs) and (segs[i + 1].get("text") or "").strip() == MUSIK:
                i += 1
                end = segs[i]["end"]
            letzter_sprecher = None  # nach der Musik den Namen wieder nennen
        else:
            name = (segs[i].get("speaker") or "").strip()
            if sprecher and name and name != letzter_sprecher:
                text = f">> {name}: {text}"
            letzter_sprecher = name
        bloecke.append("\n".join([
            str(len(bloecke) + 1),
            f"{_zeit(start)} --> {_zeit(end)}",
            *_umbrechen(text),
        ]))
        i += 1
    return "\n\n".join(bloecke) + ("\n" if bloecke else "")
