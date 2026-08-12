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


def test_fuer_frontend_enthaelt_alle_sechs():
    ids = {e["id"] for e in sprachen.fuer_frontend()}
    assert ids == {"ch", "de", "en", "fr", "it", "auto"}


def test_tiefen_liste_vier_stufen():
    ids = {t["id"] for t in sprachen.TIEFEN}
    assert ids == {"voll_dialekt", "voll", "leicht", "zusammenfassung"}
