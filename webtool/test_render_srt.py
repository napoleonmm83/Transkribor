from webtool.render_srt import MAX_ZEILE, render_srt


def _seg(start, end, spk, text):
    return {"start": start, "end": end, "speaker": spk, "text": text}


def test_zeitformat_mit_stunden():
    doc = {"segments": [_seg(3661.5, 3663.007, "", "Spaet im Interview.")]}
    assert render_srt(doc) == "1\n01:01:01,500 --> 01:01:03,007\nSpaet im Interview.\n"


def test_sprecher_nur_beim_wechsel():
    doc = {"segments": [
        _seg(0, 1, "Interviewer", "Frage eins?"),
        _seg(1, 2, "Hans", "Antwort A."),
        _seg(2, 3, "Hans", "Und noch B."),
        _seg(3, 4, "Interviewer", "Frage zwei?"),
    ]}
    srt = render_srt(doc)
    assert ">> Interviewer: Frage eins?" in srt
    assert ">> Hans: Antwort A." in srt
    assert srt.count(">> Hans:") == 1  # Folgesegment desselben Sprechers bleibt nackt
    assert "Und noch B." in srt and ">> Hans: Und noch B." not in srt
    assert srt.count(">> Interviewer:") == 2  # nach dem Wechsel wieder benannt


def test_leere_segmente_reissen_keine_luecke_in_die_nummerierung():
    doc = {"segments": [
        _seg(0, 1, "", "Erstes."),
        _seg(1, 2, "", "   "),            # kein Text
        _seg(None, 3, "", "Ohne Start."),  # keine Zeit
        _seg(9, 8, "", "Rueckwaerts."),    # end < start -> YouTube wiese sonst die ganze Datei ab
        _seg(3, 4, "", "Zweites."),
    ]}
    srt = render_srt(doc)
    assert srt.startswith("1\n") and "\n2\n" in srt and "\n3\n" not in srt
    assert "Ohne Start." not in srt and "Rueckwaerts." not in srt


def test_lange_zeilen_werden_an_wortgrenzen_umbrochen():
    text = "Wir haben den Betrieb im Jahr neunzehnhundertachtundneunzig uebernommen und seither ausgebaut."
    srt = render_srt({"segments": [_seg(0, 5, "", text)]})
    zeilen = srt.strip().split("\n")[2:]
    assert len(zeilen) > 1
    assert all(len(z) <= MAX_ZEILE for z in zeilen)
    assert " ".join(zeilen) == text  # kein Wort verloren, keins zerschnitten


def test_leeres_dokument():
    assert render_srt({"segments": []}) == ""


def _musik(start, end):
    return _seg(start, end, "Bühnenstimme", "[Musik]")


def test_musikblock_wird_zu_einem_cue_ueber_die_ganze_spanne():
    """Sechs gesungene Segmente -> ein Cue. Als sechs Cues stuende sechsmal dieselbe Zeile da."""
    doc = {"segments": [
        _seg(0, 5, "Interviewer", "Und jetzt spielt die Band."),
        _musik(89.5, 92.6), _musik(92.6, 95.7), _musik(95.7, 99.7),
        _musik(99.7, 100.1), _musik(100.1, 102.0), _musik(102.0, 103.1),
        _seg(103.1, 110.7, "Interviewer", "Das ganze Dorf ist da."),
    ]}
    srt = render_srt(doc)
    assert srt.count("[Musik]") == 1
    assert "00:01:29,500 --> 00:01:43,100\n[Musik]" in srt  # 89,5 s bis 103,1 s am Stueck
    assert len(srt.strip().split("\n\n")) == 3  # Rede, Musik, Rede


def test_musikcue_traegt_keinen_sprecher_und_der_name_kehrt_zurueck():
    doc = {"segments": [
        _seg(0, 5, "Interviewer", "Und jetzt spielt die Band."),
        _musik(5, 20),
        _seg(20, 25, "Interviewer", "Weiter im Text."),
    ]}
    zeilen = render_srt(doc).split("\n")
    assert zeilen[2] == ">> Interviewer: Und jetzt spielt die Band."
    assert zeilen[6] == "[Musik]"          # kein ">> Buehnenstimme:" davor
    assert zeilen[10] == ">> Interviewer: Weiter im Text."  # nach der Musik wieder benannt
