import pytest

from webtool import fetch


# --- check_url ---------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=abc123",
    "https://youtu.be/abc123",
    "https://m.youtube.com/watch?v=abc123",
    "https://www.instagram.com/reel/C8xY2pQr/",
    "  https://instagram.com/reel/C8xY2pQr/  ",     # wird getrimmt
])
def test_check_url_erlaubt_youtube_und_instagram(url):
    assert fetch.check_url(url) == url.strip()


@pytest.mark.parametrize("url", [
    "http://www.youtube.com/watch?v=abc123",         # kein https
    "https://vimeo.com/12345",                       # fremde Plattform
    "https://youtube.com.boese.example/watch?v=1",   # Host-Suffix-Trick
    "file:///C:/Windows/System32/drivers/etc/hosts", # kein http(s)
    "nonsens",
])
def test_check_url_lehnt_alles_andere_ab(url):
    with pytest.raises(ValueError):
        fetch.check_url(url)


# --- safe_base ---------------------------------------------------------------

def test_safe_base_transliteriert_umlaute():
    # 'raus' heisst umschreiben, nicht loeschen -- 'Mller' waere unlesbar
    assert fetch.safe_base("Interview mit Hans Müller", "yt-1") == "Interview mit Hans Mueller"
    assert fetch.safe_base("Grüße aus Zürich", "yt-1") == "Gruesse aus Zuerich"
    assert fetch.safe_base("ÄÖÜ Test", "yt-1") == "AeOeUe Test"


def test_safe_base_wirft_emoji_und_akzente_raus():
    assert fetch.safe_base("Reel 🎬 aus Bern", "yt-1") == "Reel aus Bern"
    assert fetch.safe_base("Café Niño", "yt-1") == "Cafe Nino"


def test_safe_base_ergebnis_ist_reines_ascii():
    got = fetch.safe_base("Ø 漢字 Ünter", "yt-1")
    assert got.isascii()


def test_safe_base_entfernt_pfad_und_windows_zeichen():
    got = fetch.safe_base('Best of: Bern/2024 <live> | "Teil 1"?', "yt-1")
    for verboten in '\\/:*?"<>|':
        assert verboten not in got
    assert "Bern" in got and "2024" in got


def test_safe_base_entfernt_punkte():
    # '..' waere von paths.safe_name verboten; einzelne Punkte wuerden splitext stoeren
    got = fetch.safe_base("Folge 2.1 ... Finale", "yt-1")
    assert "." not in got


def test_safe_base_kuerzt_auf_80_zeichen():
    got = fetch.safe_base("A" * 200, "yt-1")
    assert len(got) == 80


def test_safe_base_faellt_bei_leerem_ergebnis_zurueck():
    assert fetch.safe_base("🎬🎬🎬", "youtube-dQw4w9WgXcQ") == "youtube-dQw4w9WgXcQ"
    assert fetch.safe_base("", "youtube-dQw4w9WgXcQ") == "youtube-dQw4w9WgXcQ"


def test_safe_base_ergebnis_ueberlebt_safe_name():
    from webtool import paths
    got = fetch.safe_base("../../etc/passwd", "yt-1")
    assert paths.safe_name(got) == got


# --- unique_base -------------------------------------------------------------

def test_unique_base_ohne_kollision(tmp_path):
    assert fetch.unique_base(str(tmp_path), "Talk") == "Talk"


def test_unique_base_zaehlt_hoch(tmp_path):
    (tmp_path / "Talk.m4a").write_bytes(b"x")
    (tmp_path / "Talk-2.mp3").write_bytes(b"x")     # andere Endung zaehlt auch als belegt
    assert fetch.unique_base(str(tmp_path), "Talk") == "Talk-3"
