"""Sprach-Tabelle: die EINE Quelle fuer Sprach-Code (Whisper), Dialekt-Flag und
Prompt-Ziel-Sprache. Konsumiert von transcribe.py, correct.py und dem Frontend."""

SPRACH_DEFAULT = "ch"     # Schweizerdeutsch -- preserves legacy behaviour
TIEFE_DEFAULT = "auto"    # aus der Sprache abgeleitet

# id -> {label, hint, whisper, dialekt, ziel}
# ziel = Phrase fuer den Korrektur-Prompt ("normalisieren zu <ziel>"); "" bei auto.
SPRACHEN = {
    "ch":   {"label": "Schweizerdeutsch", "hint": "Dialekt -> Standarddeutsch",
             "whisper": "de", "dialekt": True,  "ziel": "lesbarem Standarddeutsch"},
    "de":   {"label": "Deutsch", "hint": "Hochdeutsch",
             "whisper": "de", "dialekt": False, "ziel": "lesbarem Standarddeutsch"},
    "en":   {"label": "Englisch", "hint": "English",
             "whisper": "en", "dialekt": False, "ziel": "clear English"},
    "fr":   {"label": "Französisch", "hint": "Français",
             "whisper": "fr", "dialekt": False, "ziel": "français courant"},
    "it":   {"label": "Italienisch", "hint": "Italiano",
             "whisper": "it", "dialekt": False, "ziel": "italiano corretto"},
    "auto": {"label": "Automatisch", "hint": "Whisper erkennt die Sprache",
             "whisper": None, "dialekt": False, "ziel": ""},
}

TIEFEN = [
    # "auto" zuerst: es ist der Default (TIEFE_DEFAULT) und muss im Einstellungs-Dialog
    # als waehlbare Option sichtbar sein — sonst bleibt der Select-Trigger bei korrektur='auto'
    # leer (beide Dialoge mappen ueber diese Liste). correct.py fragt tiefe_effektiv ab, nicht
    # TIEFEN, darum faellt die Meta-Option im Resolver nicht auf.
    {"id": "auto",            "label": "Automatisch (aus Sprache)"},
    {"id": "voll_dialekt",    "label": "Voll (mit Dialekt-Glättung)"},
    {"id": "voll",            "label": "Voll (ohne Dialekt)"},
    {"id": "leicht",          "label": "Leicht (Zusammenfassung + Sprecher + Namen)"},
    {"id": "zusammenfassung", "label": "Nur Zusammenfassung + Sprecher"},
]


# Regeltext fuer die Korrektur-Prompts bei mehrsprachigen Aufnahmen. Steht HIER und nicht in
# correct.py: sprachbezogene Prompt-Phrasen haben eine Quelle (wie `ziel`), sonst driften
# Korrektur- und Treue-Prompt auseinander — genau der Fehler, an dem die [Musik]-Regel hing.
ZIEL_MEHRSPRACHIG = (
    "Die Aufnahme enthält mehrere Sprachen. Belasse jede Passage in der Sprache, in der sie "
    "gesprochen wurde — übersetze nichts. Innerhalb einer Passage gelten die Korrekturregeln "
    "ihrer eigenen Sprache."
)


def _eintrag(sprach_id: str) -> dict:
    return SPRACHEN.get(sprach_id, SPRACHEN[SPRACH_DEFAULT])


def whisper_code(sprach_id: str):
    return _eintrag(sprach_id)["whisper"]


def ist_dialekt(sprach_id: str) -> bool:
    return bool(_eintrag(sprach_id)["dialekt"])


def ziel_phrase(sprach_id: str) -> str:
    return _eintrag(sprach_id)["ziel"]


def von_whisper_code(code: str, bevorzugt: str | None = None) -> str:
    """Whisper-Detektion -> Sprach-id. Unbekannt -> de.

    ponytail: 'ch' teilt sich den Whisper-Code 'de' mit 'de'. Da Whisper den
    Dialekt nicht erkennt, wird bei Detektion 'de' Standarddeutsch zurueckgegeben --
    'ch' ist als Detektion nie gueltig.

    `bevorzugt` (der Projekt-Standard, s. `correct._ziel_dialekt`) durchbricht das an
    GENAU dieser Kollision: stimmt sein Whisper-Code mit der Detektion ueberein, gewinnt
    er. Wer sein Projekt auf Schweizerdeutsch gestellt hat, meint bei erkanntem Deutsch
    sein Schweizerdeutsch. Bei JEDER anderen erkannten Sprache greift er nicht -- sonst
    waere `auto` in einem CH-Projekt ein fest verdrahtetes `ch`, und der englische
    Beitrag bekaeme Dialekt-Glaettung. Der Vorrang steht hier und nicht am Aufrufort:
    diese Tabelle ist die EINE Quelle fuer Whisper-Codes.
    """
    if bevorzugt in SPRACHEN and SPRACHEN[bevorzugt]["whisper"] == code:
        return bevorzugt
    for sid, e in SPRACHEN.items():
        if sid == "ch":
            continue
        if e["whisper"] == code:
            return sid
    return "de"


def fuer_frontend() -> list:
    return [{"id": sid, "label": e["label"], "hint": e["hint"]}
            for sid, e in SPRACHEN.items()]


def depth_label(tiefe: str) -> str:
    for t in TIEFEN:
        if t["id"] == tiefe:
            return t["label"]
    return tiefe


SPRECHER_MAX = 20     # s. pruef_fehler


def pruef_fehler(sprache: str | None = None, korrektur: str | None = None,
                 mehrsprachig=None, sprecher=None) -> str | None:
    """Liefert eine Fehlermeldung, wenn ein Wert unbekannt bzw. vom falschen Typ ist, sonst None.

    None-Argumente (nicht gesendete Felder) sind erlaubt — ein PUT ist ein Partial-Update.
    Die EINE Quelle fuer Gueltigkeit, konsumiert von beiden Einstellungs-Endpunkten (s. app.py);
    eine zweite Pruefung dort wuerde von dieser Tabelle wegdriften.

    ``mehrsprachig`` ist ein bool und wird auf den TYP geprueft, nicht gegen eine Liste —
    es gibt nur zwei gueltige Werte, und die kennt Python schon.

    ``sprecher`` ist die exakte Sprecherzahl fuer die Diarisierung (nur pro Datei, s.
    ``projekt.datei_sprecher``). Die Obergrenze ist keine fachliche Grenze, sondern eine
    Trust-Boundary: der Wert geht ungefiltert an pyannote, und eine dreistellige Zahl kostet
    GPU-Zeit fuer ein Ergebnis, das niemand wollte. 20 ist fuer Interviewmaterial reichlich.
    Untergrenze 1, nicht 2 — eine Ansprache mit genau einer Stimme ist ein gueltiger Fall,
    und die heutige feste Untergrenze von 2 erfindet dort einen zweiten Sprecher.
    """
    if sprecher is not None and (isinstance(sprecher, bool) or not isinstance(sprecher, int)
                                 or not 1 <= sprecher <= SPRECHER_MAX):
        return f"sprecher muss eine ganze Zahl von 1 bis {SPRECHER_MAX} sein, nicht {sprecher!r}"
    if sprache is not None and sprache not in SPRACHEN:
        return f"unbekannte Sprache: {sprache!r} (erlaubt: {', '.join(SPRACHEN)})"
    gueltige_tiefen = {TIEFE_DEFAULT} | {t["id"] for t in TIEFEN}
    if korrektur is not None and korrektur not in gueltige_tiefen:
        return f"unbekannte Korrektur-Tiefe: {korrektur!r} (erlaubt: {', '.join(sorted(gueltige_tiefen))})"
    if mehrsprachig is not None and not isinstance(mehrsprachig, bool):
        return f"mehrsprachig muss true oder false sein, nicht {mehrsprachig!r}"
    return None
