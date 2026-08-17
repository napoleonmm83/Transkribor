import os
import pathlib
import sys

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
    gesehen = []           # Optionen JEDER Runde (Metadaten + Download), fuer #162
    node_modus = []        # ELECTRON_RUN_AS_NODE WAEHREND jeder Runde, fuer #171

    def __init__(self, opts):
        self.opts = opts
        _FakeYDL.gesehen.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=False):
        # Der Zeitpunkt ist der ganze Punkt: yt-dlp startet die Laufzeit WAEHREND dieses
        # Aufrufs. Ein Blick auf die Umgebung davor oder danach sagt darueber nichts.
        _FakeYDL.node_modus.append(os.environ.get("ELECTRON_RUN_AS_NODE"))
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
    """Leeres Projekt 'Demo' + gefaelschtes yt-dlp; setzt die Fake-Steuerung zurueck.

    ffmpeg gehoert mit in die Faelschung: `download_one` prueft es VOR dem Download, und
    ohne den Patch borgen sich diese Tests das ffmpeg des Entwicklerrechners. Auf einem
    Runner ohne ffmpeg fielen drei von ihnen um — und `test_login_fehler_wird_uebersetzt`
    pruefte in Wahrheit nie die Login-Meldung, weil der ffmpeg-Fehler vorher kam.
    Wer ffmpeg selbst zum Thema hat, patcht spaeter im Testkoerper und gewinnt damit.
    """
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path))
    # Kein echtes pip aus einem Test: der Selbstaktualisierer wuerde sonst die venv des
    # Entwicklers waehrend des Laufs anfassen. Wer die Aktualisierung selbst zum Thema hat,
    # patcht `ytdlp_update.automatisch` spaeter im Testkoerper und gewinnt damit.
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    (tmp_path / "Demo" / "audio").mkdir(parents=True)
    monkeypatch.setattr(fetch, "yt_dlp", _FakeYtDlp)
    monkeypatch.setattr(transcribe_mod, "ensure_ffmpeg", lambda: True)
    _FakeYDL.title, _FakeYDL.video_id, _FakeYDL.fehler = "Mein Interview", "vid123", None
    _FakeYDL.gesehen = []
    _FakeYDL.node_modus = []
    return tmp_path


def test_download_one_legt_m4a_unter_titelnamen_ab(projekt):
    base = fetch.download_one("Demo", "https://youtu.be/vid123")
    assert base == "Mein Interview"
    assert (projekt / "Demo" / "audio" / "Mein Interview.m4a").exists()


def test_download_one_gibt_beiden_runden_eine_js_laufzeit(projekt):
    """#162: ohne JS-Laufzeit antwortet YouTube mit 403.

    Beide yt-dlp-Runden extrahieren (Metadaten UND Download), die Option muss also in
    beiden stehen — nur in `_ydl_opts(outtmpl)` waere sie an der falschen Haelfte.
    """
    fetch.download_one("Demo", "https://youtu.be/vid123")
    assert len(_FakeYDL.gesehen) == 2
    assert all("node" in o.get("js_runtimes", {}) for o in _FakeYDL.gesehen)


def test_download_one_weicht_bei_kollision_aus(projekt):
    (projekt / "Demo" / "audio" / "Mein Interview.m4a").write_bytes(b"alt")
    base = fetch.download_one("Demo", "https://youtu.be/vid123")
    assert base == "Mein Interview-2"
    assert (projekt / "Demo" / "audio" / "Mein Interview.m4a").read_bytes() == b"alt"


def test_download_one_stellt_ffmpeg_vor_dem_download_sicher(projekt, monkeypatch):
    # E2E-Fund: der FFmpegExtractAudio-Postprocessor laeuft WAEHREND download_one.
    # ensure_ffmpeg erst in main() (nach allen Downloads) ist zu spaet -> yt-dlp bricht mit
    # "ffprobe and ffmpeg not found" ab, obwohl die .m4a schon auf der Platte liegt.
    reihenfolge = []
    monkeypatch.setattr(transcribe_mod, "ensure_ffmpeg",
                        lambda: reihenfolge.append("ffmpeg") or True)
    orig = _FakeYDL.extract_info

    def spy(self, url, download=False):
        if download:
            reihenfolge.append("download")
        return orig(self, url, download=download)

    monkeypatch.setattr(_FakeYDL, "extract_info", spy)
    fetch.download_one("Demo", "https://youtu.be/vid123")
    assert reihenfolge.index("ffmpeg") < reihenfolge.index("download")


def test_download_one_ohne_ffmpeg_bricht_vor_dem_download_ab(projekt, monkeypatch):
    # ensure_ffmpeg() liefert False, statt zu werfen. Ohne Auswertung liefe yt-dlp trotzdem
    # los und der Postprocessor scheiterte hinterher mit "ffprobe and ffmpeg not found".
    monkeypatch.setattr(transcribe_mod, "ensure_ffmpeg", lambda: False)
    monkeypatch.setattr(_FakeYDL, "extract_info",
                        lambda *a, **k: pytest.fail("ohne ffmpeg darf nichts geladen werden"))
    with pytest.raises(RuntimeError, match="ffmpeg"):
        fetch.download_one("Demo", "https://youtu.be/vid123")


def test_download_one_ohne_yt_dlp_meldet_klar(projekt, monkeypatch):
    # Seit dem faulen Import reicht `yt_dlp = None` nicht mehr: _hole_yt_dlp() wuerde das
    # echte, auf diesem Rechner installierte yt-dlp nachladen. Der Import selbst muss leer
    # ausgehen — genau das tut er auf einem Rechner ohne das Paket.
    monkeypatch.setattr(fetch, "yt_dlp", None)
    monkeypatch.setattr(fetch, "_importiere_yt_dlp", lambda: None)
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


def test_rohmeldung_bewahrt_was_human_error_wegwirft(projekt, capsys):
    """#173: `_human_error` nimmt nur die LETZTE Zeile — die Formulierung, an der
    `_EXTRAKTOR_RE` nachzuziehen waere, steht bei yt-dlp aber oft davor. Ohne die Rohzeile
    gibt es bei einem echten Bruch keine Evidenz, und die Liste bleibt fuer immer geraten."""
    _FakeYDL.fehler = RuntimeError(
        "WARNING: [youtube] nsig extraction failed: Some formats may be missing\n"
        "ERROR: unable to download video data")
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://youtu.be/vid123"])
    # Zeilengenau statt per `partition`: die Rohzeile steht seit dem Reviewbefund VOR der
    # FEHLER-Zeile, und ein „nicht enthalten" gegen den falschen Textblock waere vacuous.
    zeilen = capsys.readouterr().out.splitlines()
    fehlerzeile = next(z for z in zeilen if z.startswith("[fetch] FEHLER"))
    rohzeile = next(z for z in zeilen if z.startswith("[fetch] roh"))
    assert "nsig extraction failed" not in fehlerzeile      # `_human_error` wirft es weg
    assert "nsig extraction failed" in rohzeile
    # Das Urteil gehoert dazu: ohne es ist die Zeile nur Text, mit ihm beantwortet sie die
    # offene Frage aus #173 (haette die Positivliste diesen Fall getroffen?).
    assert "extraktor-verdacht=True" in rohzeile


def test_rohmeldung_meldet_AUCH_einen_fall_den_die_liste_NICHT_trifft(projekt, capsys):
    """Der eigentliche Ertrag: ein Fehlschlag, den `_EXTRAKTOR_RE` verfehlt, ist der Fall,
    den #173 sucht — er loest keine Selbstheilung aus und war bisher unsichtbar."""
    _FakeYDL.fehler = RuntimeError("ERROR: Sorry, this content isn't available right now")
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://www.instagram.com/reel/C8xY2pQr/"])
    rohzeile = next(z for z in capsys.readouterr().out.splitlines()
                    if z.startswith("[fetch] roh"))
    assert "extraktor-verdacht=False" in rohzeile
    assert "isn't available right now" in rohzeile


# Zeitmarke im Protokoll, gegen die die Reihenfolge geprueft wird. Bewusst OHNE
# `[fetch] `-Praefix: sie soll sich von den echten Zeilen unterscheiden lassen.
_MARKE = "[test] heilungsversuch startet"


def test_rohmeldung_der_AUSLOESENDEN_meldung_geht_nicht_verloren(projekt, monkeypatch, capsys):
    """Loest der erste Fehlschlag die Selbstheilung aus, ueberschreibt der Wiederholversuch
    `fehler`. Stuende die Rohzeile nur am Schleifenende, fehlte ausgerechnet die AUSLOESENDE
    Meldung — also genau die, an der `_EXTRAKTOR_RE` nachzuziehen waere. Der Zweck von #173
    waere damit ausgehebelt, und das Protokoll laese sich obendrein widerspruechlich:
    „yt-dlp aktualisiert" direkt ueber einem `extraktor-verdacht=False`.

    Gefunden vom Reviewer-Subagenten an PR #223 (M1), nicht von einem roten Test.
    """
    _FakeYDL.fehler = RuntimeError("ERROR: nsig extraction failed; player abc123")

    def heilen(erzwingen=False):
        print(_MARKE, flush=True)      # Zeitmarke: ab hier laeuft der Heilungsversuch
        _FakeYDL.fehler = RuntimeError("ERROR: Sorry, this content isn't available")
        return True
    monkeypatch.setattr(fetch.ytdlp_update, "automatisch", heilen)
    monkeypatch.setattr(fetch, "_importiere_yt_dlp", lambda: _FakeYtDlp)   # fuer _neu_laden()
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://youtu.be/vid123", "--download-only"])

    zeilen = capsys.readouterr().out.splitlines()
    rohzeilen = [z for z in zeilen if z.startswith("[fetch] roh")]
    assert len(rohzeilen) == 2
    # Die ERSTE Rohzeile muss VOR dem Heilungsversuch stehen. Ohne diese Zusicherung bestuende
    # der Test auch, wenn die Ausnahme bloss zwischengespeichert und spaeter protokolliert
    # wuerde — dann waere die Zeile aber keine Diagnose des Augenblicks mehr, sondern eine
    # Rekonstruktion, und der naechste Umbau duerfte sie beliebig verschieben.
    # (CodeRabbit an PR #223.)
    assert zeilen.index(rohzeilen[0]) < zeilen.index(_MARKE)
    assert "nsig extraction failed" in rohzeilen[0] and "verdacht=True" in rohzeilen[0]
    assert "isn't available" in rohzeilen[1] and "verdacht=False" in rohzeilen[1]


def test_rohmeldung_ist_einzeilig_und_gedeckelt():
    """Zeilenweise gelesen (`jobPhases.ts`) und im Browser angezeigt — beides vertraegt
    weder Umbrueche noch eine ganze HTTP-Antwort."""
    assert "\n" not in fetch._rohmeldung(RuntimeError("a\nb\n  c"))
    assert fetch._rohmeldung(RuntimeError("a\nb\n  c")) == "a b c"
    lang = fetch._rohmeldung(RuntimeError("x" * 5000))
    # Die Kuerzungsmarke zaehlt MIT in die Grenze — sonst waere `_ROH_MAX` nicht das Maximum.
    assert len(lang) == fetch._ROH_MAX and lang.endswith(" …")
    # Leere Meldung: der Klassenname, sonst stuende dort gar nichts.
    assert fetch._rohmeldung(ValueError("")) == "ValueError"


_403 = RuntimeError("ERROR: unable to download video data: HTTP Error 403: Forbidden")


def test_403_ohne_js_laufzeit_nennt_die_echte_ursache(monkeypatch):
    """#162: der 403 liest sich wie ein gesperrtes Video, kommt aber von der fehlenden
    JS-Laufzeit — und die Warnung, die das erklaert, schluckt `no_warnings`."""
    # Ohne delenv entschiede die Umgebung des Entwicklers mit: seit #171 zaehlt eine
    # mitgereichte Laufzeit als vorhanden (dieselbe Leck-Klasse wie beim `client`-Fixture
    # in test_api.py).
    monkeypatch.delenv("TRANSKRIBOR_JS_RUNTIME", raising=False)
    monkeypatch.setattr(fetch.shutil, "which", lambda _: None)
    assert "JavaScript-Laufzeit" in fetch._human_error(_403)


def test_403_mit_js_laufzeit_raet_NICHT_zur_laufzeit(monkeypatch):
    """Gegenrichtung: liegt node vor, hat der 403 eine andere Ursache — dann waere der Rat
    ('installiere Node') ein Irrweg. Ohne diesen Test bliebe die Bedingung ungeprueft."""
    monkeypatch.delenv("TRANSKRIBOR_JS_RUNTIME", raising=False)
    monkeypatch.setattr(fetch.shutil, "which", lambda name: r"C:\node\node.exe")
    assert "JavaScript-Laufzeit" not in fetch._human_error(_403)


# --- Mitgereichte JS-Laufzeit (#171) -----------------------------------------

def test_ydl_opts_reicht_die_mitgelieferte_laufzeit_an_yt_dlp_durch(tmp_path, monkeypatch):
    """#171: die gepackte App hat weder node noch deno auf dem PATH — aber Electrons eigenes
    Binary IST ein Node. Der Pfad muss als `path` bei `node` ankommen, sonst sucht yt-dlp
    weiter nur den PATH ab (`_determine_runtime_path` nimmt `path` nur, wenn es gesetzt ist).
    `deno` bleibt daneben stehen: liegt eines auf dem PATH, hat es hoehere Prioritaet."""
    exe = tmp_path / "Transkribor.exe"
    exe.write_bytes(b"")
    monkeypatch.setenv("TRANSKRIBOR_JS_RUNTIME", str(exe))
    for opts in (fetch._ydl_opts(), fetch._ydl_opts("ziel.%(ext)s")):
        assert opts["js_runtimes"]["node"] == {"path": str(exe)}
        assert "deno" in opts["js_runtimes"]


def test_beide_yt_dlp_runden_laufen_im_node_modus(projekt, monkeypatch):
    """Ohne `ELECTRON_RUN_AS_NODE` startet Electrons Binary das GUI, statt das Loeserskript zu
    rechnen — der Pfad allein nuetzt also nichts. Gesetzt wird es hier und nicht in
    `backend.js`: dort landete es in der Server-Umgebung, die `jobs.py` an JEDEN Subprozess
    weitergibt (transcribe, correct, `claude`/`codex`), gebraucht wird es aber nur von dem
    einen node-Aufruf aus DIESEM Prozess.

    Gemessen wird WAEHREND der Aufrufe, in beiden Runden: dann startet yt-dlp die Laufzeit.
    Und danach ist es wieder weg — der direkte CLI-Aufruf transkribiert im selben Prozess
    weiter, und schon der ffmpeg-Postprocessor ist ein Kindprozess."""
    monkeypatch.delenv("ELECTRON_RUN_AS_NODE", raising=False)
    monkeypatch.setenv("TRANSKRIBOR_JS_RUNTIME", str(projekt / "electron.exe"))
    (projekt / "electron.exe").write_bytes(b"")
    fetch.download_one("Demo", "https://youtu.be/vid123")
    assert _FakeYDL.node_modus == ["1", "1"]
    assert "ELECTRON_RUN_AS_NODE" not in os.environ


def test_ein_vorhandener_node_modus_wird_zurueckgegeben(projekt, monkeypatch):
    """Der Wiederherstell-Zweig, den ein blosses `pop` verfehlt haette: wer die Variable selbst
    gesetzt hat (.env, CI), behaelt sie — dieselbe Regel wie ueberall hier."""
    monkeypatch.setenv("ELECTRON_RUN_AS_NODE", "0")
    monkeypatch.setenv("TRANSKRIBOR_JS_RUNTIME", str(projekt / "electron.exe"))
    (projekt / "electron.exe").write_bytes(b"")
    fetch.download_one("Demo", "https://youtu.be/vid123")
    assert _FakeYDL.node_modus == ["1", "1"]
    assert os.environ["ELECTRON_RUN_AS_NODE"] == "0"


def test_ohne_laufzeit_bleibt_der_electron_modus_aus(projekt, monkeypatch):
    """Gegenrichtung: ohne mitgereichte Laufzeit hat der fetch-Prozess keinen Grund, das Flag
    zu setzen — ein Rechner ohne die gepackte App bekommt es also nicht untergeschoben."""
    monkeypatch.delenv("ELECTRON_RUN_AS_NODE", raising=False)
    monkeypatch.delenv("TRANSKRIBOR_JS_RUNTIME", raising=False)
    fetch.download_one("Demo", "https://youtu.be/vid123")
    assert _FakeYDL.node_modus == [None, None]
    assert "ELECTRON_RUN_AS_NODE" not in os.environ


def test_ein_toter_laufzeitpfad_gilt_als_keine_laufzeit(monkeypatch):
    """Ein blosser String genuegt nicht. Sonst ginge dreierlei still schief: yt-dlp meldet die
    Laufzeit als nicht vorhanden, sucht wegen des gesetzten `path` aber NICHT mehr auf dem
    PATH — ein echtes node faellt also weg —, und `_js_laufzeit_da()` unterdrueckte dazu den
    403-Hinweis, der als einziger die Ursache nennt. Erreichbar ueber die `.env`: eine Zeile
    dort gewinnt bewusst gegen eine bereits gesetzte Variable (`settings.load_env`)."""
    monkeypatch.setenv("TRANSKRIBOR_JS_RUNTIME", r"C:\gibt\es\nicht\node.exe")
    monkeypatch.setattr(fetch.shutil, "which", lambda _: None)
    assert fetch._ydl_opts()["js_runtimes"]["node"] == {}
    assert fetch._js_laufzeit_da() is False
    assert "JavaScript-Laufzeit" in fetch._human_error(_403)


def test_ohne_mitgelieferte_laufzeit_bleiben_die_optionen_die_alten(monkeypatch):
    """Constraint: im Entwickler-Checkout (Variable nicht gesetzt) muss es byte-identisch
    beim Verhalten von #162 bleiben — ein leeres `path` waere ein Pfad "" und damit ein
    Laufzeitfund, den es nicht gibt."""
    monkeypatch.delenv("TRANSKRIBOR_JS_RUNTIME", raising=False)
    assert fetch._ydl_opts()["js_runtimes"] == {"deno": {}, "node": {}}


def test_403_mit_mitgelieferter_laufzeit_raet_NICHT_zur_installation(tmp_path, monkeypatch):
    """Sonst riete die Meldung ausgerechnet im gepackten Lauf zu einer Node-Installation —
    dort, wo bereits eine benutzt wird. PATH ist hier leer, die Laufzeit kommt allein aus
    der Umgebung."""
    exe = tmp_path / "Transkribor.exe"
    exe.write_bytes(b"")
    monkeypatch.setenv("TRANSKRIBOR_JS_RUNTIME", str(exe))
    monkeypatch.setattr(fetch.shutil, "which", lambda _: None)
    assert "JavaScript-Laufzeit" not in fetch._human_error(_403)


def test_der_pip_rat_nennt_das_extra_mit():
    """Der Hinweis wird dem Nutzer zweimal gezeigt (nach jedem nicht-403-Fehlschlag und wenn
    yt-dlp fehlt) — ohne `[default]` fuehrt genau dieses Abtippen zurueck in #170: yt-dlp
    steigt ueber die Fassung, zu der seine Loeserskripte passen, und verwirft sie dann still."""
    assert "yt-dlp[default]" in fetch._PIP_HINWEIS


def test_requirements_nennt_yt_dlp_ejs():
    """#170: ohne dieses Paket hat yt-dlps Challenge-Loeser OFFLINE keine Quelle — die
    Reihenfolge in `jsc/_builtin/ejs.py:_iter_script_sources` ist PyPI-Paket -> Cache ->
    mitgeliefert -> GitHub, und die letzte ist per Default gesperrt (`remote_components`
    ist leer). Mitgeliefert ist nur `yt.solver.core.js`; `yt.solver.lib.js`, das die
    node-Laufzeit braucht, fehlt im yt-dlp-Paket. Faellt das Extra heraus, ist die
    JS-Laufzeit aus #162 wieder wirkungslos — und zwar lautlos, weil der Download auf
    Player-Clients ohne Signatur ausweicht und meistens trotzdem klappt.

    Geprueft wird das EXTRA, nicht eine eigene `yt-dlp-ejs`-Zeile: die Fassung muss exakt zu
    `jsc/_builtin/vendor/_info.py:VERSION` passen, und diesen Pin fuehrt yt-dlp selbst
    (`yt-dlp-ejs==0.8.0` in `[default]`). Eine freie Zeile daneben driftet davon."""
    req = (pathlib.Path(__file__).resolve().parent.parent / "requirements.txt").read_text("utf-8")
    assert any(z.strip().startswith("yt-dlp[default]") for z in req.splitlines())


# --- Selbstaktualisierung ----------------------------------------------------

def test_yt_dlp_wird_erst_beim_download_importiert(projekt, monkeypatch):
    """Der Kern des Mechanismus: pip tauscht die Dateien auf der PLATTE aus. Ein am
    Modulkopf importiertes yt-dlp laege bereits im Speicher — die Aktualisierung wirkte
    dann erst beim naechsten Lauf, also nie fuer den Import, der sie ausgeloest hat. Genau
    darauf baut `_neu_laden()` in der Selbstheilung auf.

    **Bis #253 hiess dieser Test `test_import_laeuft_erst_NACH_dem_update`** und pruefte
    `reihenfolge == ["update", "import"]`. Die erste Haelfte ist mit der Kalenderpruefung an
    den Serverstart gezogen (`ytdlp_update.beim_start()`); den Rest der Zusicherung — der
    Import passiert beim DOWNLOAD, nicht beim Laden des Moduls — braucht die Selbstheilung
    weiterhin, und ohne ihn haette der Umbau die Lazy-Regel still mitgenommen.
    """
    reihenfolge = []
    monkeypatch.setattr(fetch, "yt_dlp", None)
    monkeypatch.setattr(fetch, "_importiere_yt_dlp",
                        lambda: reihenfolge.append("import") or _FakeYtDlp)
    assert reihenfolge == []                  # Modul laengst geladen — noch kein yt-dlp
    fetch.download_one("Demo", "https://youtu.be/vid123")
    assert reihenfolge == ["import"]


def test_selbstheilung_aktualisiert_und_laedt_doch_noch(projekt, monkeypatch):
    """403 -> yt-dlp aktualisieren -> denselben Download noch einmal. Genau der Fall, der
    am 13.8. eine Stunde gekostet hat (#162); der 14-Tage-Takt kaeme dafuer zu spaet."""
    _FakeYDL.fehler = _403
    versuche = []

    def heilen(erzwingen=False):
        versuche.append(erzwingen)
        _FakeYDL.fehler = None          # das Update repariert den Extraktor
        return True

    monkeypatch.setattr(fetch.ytdlp_update, "automatisch", heilen)
    monkeypatch.setattr(fetch, "_importiere_yt_dlp", lambda: _FakeYtDlp)   # _neu_laden()
    fetch.main(["Demo", "https://youtu.be/vid123", "--download-only"])
    assert versuche == [True]           # erzwungen: der Merker darf nicht bremsen
    assert (projekt / "Demo" / "audio" / "Mein Interview.m4a").exists()


def test_selbstheilung_NICHT_bei_login_pflicht(projekt, monkeypatch):
    """Ein privates Video schlaegt auch fehl — ein Update repariert das nie. Ohne diese
    Bedingung kostete jeder solche Versuch ein pip von bis zu 120 s fuer nichts."""
    _FakeYDL.fehler = RuntimeError("ERROR: Requested content is not available, login required")
    monkeypatch.setattr(fetch.ytdlp_update, "automatisch",
                        lambda *a, **k: pytest.fail("kein Update bei Login-Pflicht"))
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://www.instagram.com/reel/C8xY2pQr/"])


def test_login_veto_schlaegt_den_extraktor_verdacht(projekt):
    """Der einzige Test, der das `and not _LOGIN_RE` wirklich ausuebt.

    Die beiden Tests darunter treffen `_EXTRAKTOR_RE` gar nicht (nachgemessen) — sie waeren
    auch ohne das Veto gruen, es liess sich ersatzlos loeschen. Diese Meldung trifft BEIDE
    Muster: `nsig` steht in der Positivliste, `cookies` im Veto. Ein Update repariert eine
    fehlende Anmeldung nie, also darf sie keine Selbstheilung ausloesen.
    """
    e = RuntimeError("ERROR: Unable to extract nsig; use --cookies-from-browser")
    assert fetch._EXTRAKTOR_RE.search(str(e))      # Positivliste trifft …
    assert fetch._LOGIN_RE.search(str(e))          # … und das Veto auch
    assert fetch._extraktor_verdacht(e) is False   # … das Veto gewinnt


def test_formatfehler_wird_nicht_als_extraktor_verdacht_geraten(projekt):
    """`requested format is not available` stand in _EXTRAKTOR_RE und war TOTER CODE:
    `_LOGIN_RE` enthaelt `not available` und schlug die Positivliste. Der Zweig ist raus;
    dieser Test haelt fest, was daraus folgt — die Meldung gilt als Login-Fall (#173).

    **Er prueft NICHT das Veto**: seit der Streichung trifft die Meldung `_EXTRAKTOR_RE` gar
    nicht mehr, er waere also auch ohne das Veto gruen. Dafuer gibt es den Test darueber.
    """
    e = RuntimeError("ERROR: [youtube] abc: Requested format is not available. Use --list-formats")
    assert fetch._extraktor_verdacht(e) is False
    assert "nicht öffentlich abrufbar" in fetch._human_error(e)


def test_kein_update_versprechen_im_log_wenn_nichts_passiert(projekt, monkeypatch, capsys):
    """Bei abgeschaltetem Automatismus stand frueher 'aktualisiere yt-dlp und versuche es
    noch einmal' im Job-Log — eine Zusage, die niemand einloest, ausgerechnet in dem
    Protokoll, das der Nutzer liest, wenn ein Import fehlschlaegt."""
    _FakeYDL.fehler = _403
    monkeypatch.setattr(fetch.ytdlp_update, "automatisch", lambda *a, **k: False)
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://youtu.be/vid123"])
    out = capsys.readouterr().out
    assert "noch einmal" not in out
    assert "FEHLER" in out


def test_selbstheilung_NICHT_bei_fremder_plattform(projekt, monkeypatch):
    """check_url wirft ValueError, bevor yt-dlp ueberhaupt gefragt wird — auch das ist kein
    Extraktor-Problem. Die Positivliste haelt beide Faelle draussen."""
    monkeypatch.setattr(fetch.ytdlp_update, "automatisch",
                        lambda *a, **k: pytest.fail("kein Update bei fremder Plattform"))
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://vimeo.com/12345"])


def test_selbstheilung_hoechstens_einmal_pro_lauf(projekt, monkeypatch):
    """Drei URLs mit demselben kaputten Extraktor loesen EIN pip aus, nicht drei."""
    _FakeYDL.fehler = _403
    rufe = []
    monkeypatch.setattr(fetch.ytdlp_update, "automatisch",
                        lambda *a, **k: rufe.append(1) or False)
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://youtu.be/a", "https://youtu.be/b", "https://youtu.be/c"])
    assert len(rufe) == 1


def test_ohne_update_kein_zweiter_versuch(projekt, monkeypatch):
    """Hat pip nichts ausgerichtet (offline), waere ein erneuter Download derselbe Fehler
    ein zweites Mal — plus die Wartezeit."""
    _FakeYDL.fehler = _403
    downloads = []
    orig = fetch.download_one
    monkeypatch.setattr(fetch, "download_one",
                        lambda p, u: downloads.append(u) or orig(p, u))
    monkeypatch.setattr(fetch.ytdlp_update, "automatisch", lambda *a, **k: False)
    with pytest.raises(SystemExit):
        fetch.main(["Demo", "https://youtu.be/vid123"])
    assert len(downloads) == 1


def test_import_waehrend_einer_aktualisierung_sagt_das_auch(projekt, monkeypatch):
    """**Das ist, was #253 NEU aufmacht.** Der Kalenderlauf liegt jetzt im Serverprozess und
    kann laufen, waehrend `download_one` importiert. Faellt der Import in pips
    Deinstallations-/Installationsluecke, ist yt-dlp fuer einen Moment weg — vorher gab es
    das nicht, weil der Import das pip gerade abwartete.

    Ohne diese Abfrage saehe der Nutzer drei falsche Dinge auf einmal: „nicht installiert",
    waehrend gerade INSTALLIERT wird; keine Selbstheilung (`_EXTRAKTOR_RE` trifft den Text
    nicht); und einen Rat, der ein DRITTES pip auf dieselbe venv startet.
    """
    monkeypatch.setattr(fetch, "yt_dlp", None)
    monkeypatch.setattr(fetch, "_importiere_yt_dlp", lambda: None)   # pips Luecke
    monkeypatch.setattr(fetch.ytdlp_update, "laeuft_gerade", lambda *a: True)
    with pytest.raises(RuntimeError, match="wird gerade aktualisiert"):
        fetch.download_one("Demo", "https://youtu.be/vid123")


def test_ohne_laufende_aktualisierung_bleibt_es_bei_nicht_installiert(projekt, monkeypatch):
    """Die Gegenrichtung, und sie ist keine Formalie: eine Meldung „wird gerade
    aktualisiert", die IMMER kommt, verdeckt den echten Fall (yt-dlp fehlt wirklich) samt
    dem einzigen Rat, der dann hilft."""
    monkeypatch.setattr(fetch, "yt_dlp", None)
    monkeypatch.setattr(fetch, "_importiere_yt_dlp", lambda: None)
    monkeypatch.setattr(fetch.ytdlp_update, "laeuft_gerade", lambda *a: False)
    with pytest.raises(RuntimeError, match="nicht installiert"):
        fetch.download_one("Demo", "https://youtu.be/vid123")


def test_url_import_wartet_NICHT_mehr_auf_die_kalenderpruefung(monkeypatch, tmp_path):
    """#253: `_hole_yt_dlp()` ruft `automatisch()` nicht mehr.

    Vorher lag zwischen „Adresse eingefuegt" und „Download beginnt" ein pip von bis zu 120 s
    (mit Sperrwartezeit >=340 s) — an der einzigen Stelle der App, an der jemand aktiv auf
    ein Ergebnis wartet. Die Vorsorge macht jetzt `ytdlp_update.beim_start()`.

    **Das ist die Negativkontrolle eines PAARES.** Der Gegenpart in `test_api.py`
    (`test_start_stoesst_die_ytdlp_kalenderpruefung_an`) haelt fest, dass sie beim
    Serverstart LAEUFT — und `test_selbstheilung_aktualisiert_und_laedt_doch_noch` weiter
    unten, dass die SELBSTHEILUNG unberuehrt bleibt. Ohne diese drei zusammen waere
    „verschoben" nicht von „ersatzlos entfernt" zu unterscheiden.

    Bewusst OHNE die `projekt`-Fixture: die schaltet den Automatismus per
    `TRANSKRIBOR_YTDLP_UPDATE=0` ab — dann bewiese der Test die Env, nicht den Umbau.
    (Bis #253 stand hier `test_kaputte_metadaten_reissen_den_url_import_nicht_mit`, der
    #185 auf diesem Pfad end-to-end pruefte. Sein Gegenstand ist mit dem Aufruf
    weitergezogen: `test_ytdlp_update.py::test_beim_start_wirft_NIE` haelt dieselbe Zusage
    jetzt dort, wo ein Wurf teurer ist — er liesse den Server nicht hochkommen. Ihn hier
    stehen zu lassen waere ein Waechter ohne Gegenstand geworden: gruen, weil nichts mehr
    passiert.)
    """
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.delenv("TRANSKRIBOR_YTDLP_UPDATE", raising=False)
    monkeypatch.setattr(fetch.ytdlp_update, "automatisch",
                        lambda *a, **k: pytest.fail("keine Kalenderpruefung vor dem Import"))
    monkeypatch.setattr(fetch, "yt_dlp", None)
    monkeypatch.setattr(fetch, "_importiere_yt_dlp", lambda: "modul")
    assert fetch._hole_yt_dlp() == "modul"


def test_neu_laden_raeumt_sys_modules_und_importiert_frisch(monkeypatch):
    """Nach dem pip liegt das ALTE Modul noch im Speicher; ein blosses `import` bekaeme
    weiter den Eintrag aus sys.modules und der zweite Versuch liefe mit dem alten Extraktor.
    Auch die Untermodule muessen weg — sie halten sonst Verweise auf den alten Code."""
    monkeypatch.setitem(sys.modules, "yt_dlp", _FakeYtDlp)
    monkeypatch.setitem(sys.modules, "yt_dlp.utils", _FakeYtDlp)
    monkeypatch.setattr(fetch, "yt_dlp", _FakeYtDlp)
    monkeypatch.setattr(fetch, "_importiere_yt_dlp", lambda: "frisch")
    fetch._neu_laden()
    assert "yt_dlp" not in sys.modules and "yt_dlp.utils" not in sys.modules
    assert fetch.yt_dlp == "frisch"


def test_env_parser_liest_beide_richtungen(monkeypatch):
    """Der Env-Wert ist ein STRING, und "0" ist truthy — ein blosses bool(env) gaebe einer
    bewusst einsprachig markierten Datei den Haken doch. Nicht gesetzt = None = kein
    Datei-Override (dann gilt der Projekt-Standard)."""
    monkeypatch.delenv("TRANSKRIBOR_FETCH_MEHRSPRACHIG", raising=False)
    assert fetch._mehrsprachig_aus_env() is None
    for wert, erwartet in (("1", True), ("true", True), ("YES", True),
                           ("0", False), ("no", False), ("", False)):
        monkeypatch.setenv("TRANSKRIBOR_FETCH_MEHRSPRACHIG", wert)
        assert fetch._mehrsprachig_aus_env() is erwartet, wert


def test_leere_fetch_sprache_schreibt_KEINEN_eintrag(projekt, monkeypatch):
    """`os.environ.get` liefert bei einer leeren `.env`-Zeile `""`, nicht `None` — dieselbe
    Null-Richtung wie bei `TRANSKRIBOR_YTDLP_UPDATE=`. Steht daneben der Mehrsprachig-Schalter,
    traegt der ZWEITE Konjunkt den `setze_datei`-Aufruf, und `""` landete als Sprach-Eintrag in
    projekt.json — vorbei an `pruef_fehler`, das auf diesem Weg nicht laeuft.

    Der Schaden ist nicht der Eintrag selbst, sondern was der Datei-Dialog daraus machte: einen
    LEEREN Waehler samt „Speichern & neu transkribieren", das mit 400 endete (#234).

    Gefahren wird der ECHTE Weg (`download_one` mit gefaelschtem yt-dlp), nicht die Zeile
    nachgebaut: ein Test, der `sprache or None` selbst schreibt, prueft seinen eigenen Nachbau
    und bliebe gruen, wenn jemand es in `fetch.py` entfernt.
    """
    # Lokaler Import unter anderem Namen: dieses Modul definiert eine FIXTURE `projekt`, die
    # den Modulnamen auf Dateiebene ueberschattet.
    from webtool import projekt as _p
    monkeypatch.setenv("TRANSKRIBOR_FETCH_SPRACHE", "")
    monkeypatch.setenv("TRANSKRIBOR_FETCH_MEHRSPRACHIG", "1")
    base = fetch.download_one("Demo", "https://youtu.be/vid123")
    assert _p.datei_ansicht("Demo", base)["sprache_eigen"] is None, "leerer String eingetragen"
    # Die Gegenprobe im selben Lauf: der Haken MUSS ankommen — sonst waere die Zusicherung
    # oben auch dann gruen, wenn `setze_datei` gar nicht gerufen wuerde.
    assert _p.datei_mehrsprachig("Demo", base) is True
