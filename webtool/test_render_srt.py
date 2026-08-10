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
        _seg(3, 4, "", "Zweites."),
    ]}
    srt = render_srt(doc)
    assert srt.startswith("1\n") and "\n2\n" in srt and "\n3\n" not in srt
    assert "Ohne Start." not in srt


def test_lange_zeilen_werden_an_wortgrenzen_umbrochen():
    text = "Wir haben den Betrieb im Jahr neunzehnhundertachtundneunzig uebernommen und seither ausgebaut."
    srt = render_srt({"segments": [_seg(0, 5, "", text)]})
    zeilen = srt.strip().split("\n")[2:]
    assert len(zeilen) > 1
    assert all(len(z) <= MAX_ZEILE for z in zeilen)
    assert " ".join(zeilen) == text  # kein Wort verloren, keins zerschnitten


def test_leeres_dokument():
    assert render_srt({"segments": []}) == ""
