import pytest

import transcribe as transcribe_mod
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


# --- Treiber (yt-dlp gefaelscht, kein Netzwerk) ------------------------------

class _FakeYDL:
    """Minimalersatz fuer yt_dlp.YoutubeDL. Klassenattribute steuern das Verhalten."""
    title = "Mein Interview"
    video_id = "vid123"
    fehler = None          # Exception-Instanz -> wird beim Download geworfen

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=False):
        if download:
            if _FakeYDL.fehler is not None:
                raise _FakeYDL.fehler
            pfad = self.opts["outtmpl"].replace("%(ext)s", "m4a")
            with open(pfad, "wb") as fh:
                fh.write(b"fake-m4a")
        return {"title": _FakeYDL.title, "id": _FakeYDL.video_id, "ext": "m4a"}


class _FakeYtDlp:
    YoutubeDL = _FakeYDL


@pytest.fixture
def projekt(monkeypatch, tmp_path):
    """Leeres Projekt 'Demo' + gefaelschtes yt-dlp; setzt die Fake-Steuerung zurueck."""
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    (tmp_path / "Demo" / "audio").mkdir(parents=True)
    monkeypatch.setattr(fetch, "yt_dlp", _FakeYtDlp)
    _FakeYDL.title, _FakeYDL.video_id, _FakeYDL.fehler = "Mein Interview", "vid123", None
    return tmp_path


def test_download_one_legt_m4a_unter_titelnamen_ab(projekt):
    base = fetch.download_one("Demo", "https://youtu.be/vid123")
    assert base == "Mein Interview"
    assert (projekt / "Demo" / "audio" / "Mein Interview.m4a").exists()


def test_download_one_weicht_bei_kollision_aus(projekt):
    (projekt / "Demo" / "audio" / "Mein Interview.m4a").write_bytes(b"alt")
    base = fetch.download_one("Demo", "https://youtu.be/vid123")
    assert base == "Mein Interview-2"
    assert (projekt / "Demo" / "audio" / "Mein Interview.m4a").read_bytes() == b"alt"


def test_download_one_ohne_yt_dlp_meldet_klar(projekt, monkeypatch):
    monkeypatch.setattr(fetch, "yt_dlp", None)
    with pytest.raises(RuntimeError, match="yt-dlp"):
        fetch.download_one("Demo", "https://youtu.be/vid123")


def test_main_transkribiert_nur_die_geladenen(projekt, monkeypatch):
    gerufen = {}
    monkeypatch.setattr(transcribe_mod, "transcribe_project",
                        lambda name, model, lang, only=None: gerufen.update(name=name, only=only))
    monkeypatch.setattr(transcribe_mod, "ensure_ffmpeg", lambda: True)
    fetch.main(["Demo", "https://youtu.be/vid123"])
    assert gerufen["name"] == "Demo"
    assert gerufen["only"] == ["Mein Interview"]


def test_main_ohne_erfolg_exit_1_und_ohne_whisper(projekt, monkeypatch):
    _FakeYDL.fehler = RuntimeError("ERROR: Sign in to confirm you are not a bot")
    monkeypatch.setattr(transcribe_mod, "transcribe_project",
                        lambda *a, **k: pytest.fail("Whisper darf ohne Datei nicht starten"))
    with pytest.raises(SystemExit) as exc:
        fetch.main(["Demo", "https://youtu.be/vid123"])
    assert exc.value.code == 1


def test_main_teilerfolg_transkribiert_den_rest(projekt, monkeypatch, capsys):
    gerufen = {}
    monkeypatch.setattr(transcribe_mod, "transcribe_project",
                        lambda name, model, lang, only=None: gerufen.update(only=only))
    monkeypatch.setattr(transcribe_mod, "ensure_ffmpeg", lambda: True)
    # zweite URL ist eine fremde Plattform -> scheitert an check_url, erste laeuft durch
    fetch.main(["Demo", "https://youtu.be/vid123", "https://vimeo.com/1"])
    assert gerufen["only"] == ["Mein Interview"]
    assert "FEHLER" in capsys.readouterr().out


def test_login_fehler_wird_uebersetzt(projekt, capsys):
    _FakeYDL.fehler = RuntimeError("ERROR: Requested content is not available, login required")
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://www.instagram.com/reel/C8xY2pQr/"])
    assert "nicht öffentlich abrufbar" in capsys.readouterr().out
