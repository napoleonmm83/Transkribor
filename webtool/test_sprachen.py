from webtool import sprachen


def test_whisper_code_mapping():
    assert sprachen.whisper_code("ch") == "de"   # Schweizerdeutsch -> Whisper 'de'
    assert sprachen.whisper_code("de") == "de"
    assert sprachen.whisper_code("en") == "en"
    assert sprachen.whisper_code("fr") == "fr"
    assert sprachen.whisper_code("it") == "it"
    assert sprachen.whisper_code("auto") is None


def test_nur_ch_ist_dialekt():
    assert sprachen.ist_dialekt("ch") is True
    assert sprachen.ist_dialekt("de") is False
    assert sprachen.ist_dialekt("en") is False
    assert sprachen.ist_dialekt("auto") is False   # auto -> nie Dialekt


def test_ziel_phrase_pro_sprache():
    assert "Standarddeutsch" in sprachen.ziel_phrase("ch")
    assert "Standarddeutsch" in sprachen.ziel_phrase("de")
    assert "English" in sprachen.ziel_phrase("en")
    assert sprachen.ziel_phrase("fr") and sprachen.ziel_phrase("it")


def test_ziel_phrase_auto_ohne_konkrete_sprache():
    # auto hat keine eigene Ziel-Sprache -> Leerstring (Aufrufer loest auf)
    assert sprachen.ziel_phrase("auto") == ""


def test_von_whisper_code_erkennt_nicht_ch():
    assert sprachen.von_whisper_code("en") == "en"
    assert sprachen.von_whisper_code("de") == "de"
    assert sprachen.von_whisper_code("xx") == "de"   # unbekannt -> de (sicherer Rueckfall)


# ---- Der Projekt-Standard gewinnt bei `auto` (Spec 10.1) ----
# `ch` und `de` teilen den Whisper-Code `de`; die Detektion kann sie nicht trennen. Wer als
# Projekt-Standard `ch` gesetzt hat, meint bei erkanntem Deutsch sein Schweizerdeutsch.
# Der Vorrang steht HIER und nicht am Aufrufort: die Whisper-Code-Tabelle ist die EINE Quelle.

def test_von_whisper_code_ohne_detektion_faellt_auf_de():
    """Ohne diese Wache gewinnt `auto`: dessen Whisper-Code ist `None`, die Schleife
    ueberspringt nur `ch` — und mit einem Standard `auto` traefe schon die Vorrang-Zeile.
    Gemessen war das Ergebnis `"auto"`, eine Meta-id, entgegen dem eigenen Docstring."""
    assert sprachen.von_whisper_code(None) == "de"
    assert sprachen.von_whisper_code("") == "de"
    assert sprachen.von_whisper_code(None, "auto") == "de"
    assert sprachen.von_whisper_code(None, "ch") == "de"


def test_von_whisper_code_bevorzugt_gewinnt_bei_gleichem_whisper_code():
    assert sprachen.von_whisper_code("de", "ch") == "ch"


def test_von_whisper_code_bevorzugt_greift_nur_bei_treffer():
    # Der Standard darf eine ANDERE erkannte Sprache nicht ueberschreiben -- sonst waere
    # `auto` in einem CH-Projekt ein fest verdrahtetes `ch`, und der englische Beitrag
    # bekaeme Dialekt-Glaettung.
    assert sprachen.von_whisper_code("en", "ch") == "en"
    assert sprachen.von_whisper_code("de", "auto") == "de"    # auto hat keinen Whisper-Code
    assert sprachen.von_whisper_code("de", "quatsch") == "de"  # unbekannter Standard zaehlt nicht
    assert sprachen.von_whisper_code("de", None) == "de"       # ohne Standard wie bisher


def test_fuer_frontend_enthaelt_alle_sechs():
    ids = {e["id"] for e in sprachen.fuer_frontend()}
    assert ids == {"ch", "de", "en", "fr", "it", "auto"}


def test_tiefen_liste_enthaelt_auto_default():
    # "auto" (TIEFE_DEFAULT) ist als waehlbare Option enthalten — sonst bliebe der
    # Tiefe-Select-Trigger im Einstellungs-Dialog leer (#141). Die vier echten Tiefen bleiben.
    ids = {t["id"] for t in sprachen.TIEFEN}
    assert ids == {"auto", "voll_dialekt", "voll", "leicht", "zusammenfassung"}


def test_pruef_fehler_gueltig():
    # None-Argumente (Partial-Update) sind erlaubt — ändern nichts.
    assert sprachen.pruef_fehler() is None
    assert sprachen.pruef_fehler(sprache="ch") is None
    assert sprachen.pruef_fehler(sprache="auto") is None
    assert sprachen.pruef_fehler(korrektur="voll") is None
    assert sprachen.pruef_fehler(korrektur="auto") is None      # TIEFE_DEFAULT bleibt erlaubt
    assert sprachen.pruef_fehler(sprache="en", korrektur="leicht") is None


def test_pruef_fehler_unbekannte_sprache():
    msg = sprachen.pruef_fehler(sprache="enm")
    assert msg is not None and "enm" in msg and "Sprache" in msg


def test_pruef_fehler_unbekannte_tiefe():
    msg = sprachen.pruef_fehler(korrektur="galaktisch")
    assert msg is not None and "galaktisch" in msg and "Tiefe" in msg


def test_pruef_fehler_lehnt_nicht_bool_ab():
    msg = sprachen.pruef_fehler(mehrsprachig="ja")
    assert msg is not None and "mehrsprachig" in msg


def test_pruef_fehler_erlaubt_bool_und_none():
    # None = Feld nicht gesendet (Partial-Update), bleibt frei — wie sprache/korrektur.
    assert sprachen.pruef_fehler(mehrsprachig=True) is None
    assert sprachen.pruef_fehler(mehrsprachig=False) is None
    assert sprachen.pruef_fehler(mehrsprachig=None) is None


def test_pruef_fehler_sprecher():
    """Die Funktion ist „die EINE Quelle fuer Gueltigkeit" und wird deshalb DIREKT geprueft,
    nicht nur ueber den Endpunkt: dort faengt Pydantic (`StrictInt`) die Typfehler schon ab,
    die Typwache hier bekaeme also kein Test rot und waere Dekoration. Der Bereich dagegen
    ist ausschliesslich hier zuhause."""
    assert sprachen.pruef_fehler(sprecher=None) is None          # nicht gesendet
    assert sprachen.pruef_fehler(sprecher=1) is None             # Monolog ist gueltig
    assert sprachen.pruef_fehler(sprecher=sprachen.SPRECHER_MAX) is None
    for schlecht in (0, -1, sprachen.SPRECHER_MAX + 1, True, 2.5, "vier"):
        msg = sprachen.pruef_fehler(sprecher=schlecht)
        assert msg and "sprecher" in msg, f"{schlecht!r} haette abgewiesen werden muessen"
