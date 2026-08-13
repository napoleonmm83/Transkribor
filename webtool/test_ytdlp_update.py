"""Selbstaktualisierung von yt-dlp.

Zwei Dinge stellt die Fixture IMMER sicher, und beide sind keine Kosmetik:
`TRANSKRIBOR_SETTINGS` zeigt in tmp_path (der Merker landet in der Einstellungsdatei —
sonst schriebe der Test in Marcus' echte), und `subprocess.run` ist gefaelscht (ein Test,
der echtes pip startet, aendert die venv des Entwicklers waehrend der Lauf laeuft).
"""
import datetime as dt
import subprocess
import threading
import time

import pytest

from webtool import settings
from webtool import ytdlp_update as yu

HEUTE = dt.date(2026, 8, 13)


@pytest.fixture(autouse=True)
def isoliert(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.delenv("TRANSKRIBOR_YTDLP_UPDATE", raising=False)
    monkeypatch.setattr(yu.subprocess, "run",
                        lambda *a, **k: pytest.fail("kein echtes pip im Test"))
    monkeypatch.setattr(yu, "_heute", lambda: HEUTE)
    return tmp_path


def _pip(returncode=0, ausgabe="Successfully installed yt-dlp-2026.8.12"):
    """Spion statt echtem pip. Liefert (Liste der Aufrufe, Ersatzfunktion)."""
    gerufen = []

    def run(cmd, **kwargs):
        gerufen.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, returncode, ausgabe, "")

    return gerufen, run


# --- Faelligkeit (ohne Netz, allein aus der Versionsnummer) ------------------

def test_frische_fassung_ist_nicht_faellig(monkeypatch):
    """Die Versionsnummer IST ein Datum — deshalb braucht die Faelligkeit keine PyPI-Abfrage."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.1")        # 12 Tage alt
    assert yu.faellig() is False


def test_alte_fassung_ohne_merker_ist_faellig(monkeypatch):
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")        # 40 Tage alt
    assert yu.faellig() is True


def test_merker_bremst_die_alte_fassung(monkeypatch):
    """yt-dlp veroeffentlicht stabil etwa monatlich. Allein an der Fassung gemessen waere
    sie nach 14 Tagen DAUERHAFT faellig, und jeder Import liefe in ein pip, das nichts tut."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    settings.save({"ytdlp_geprueft": "2026-08-10"})               # vor drei Tagen geprueft
    assert yu.faellig() is False


def test_alter_merker_gibt_wieder_frei(monkeypatch):
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    settings.save({"ytdlp_geprueft": "2026-07-01"})
    assert yu.faellig() is True


def test_nightly_fassung_wird_gelesen(monkeypatch):
    """2026.8.1.232355 ist dieselbe Fassung wie 2026.8.1 — die vierte Zahl ist die Uhrzeit.
    Ohne den Schnitt auf drei Teile waere jede Nightly unlesbar und damit dauernd faellig."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.1.232355")
    assert yu.faellig() is False


def test_unlesbare_fassung_gilt_als_faellig_aber_der_merker_bremst(monkeypatch):
    """Einmal pip zu viel ist besser als nie. Der Merker haelt es trotzdem im Zaum —
    sonst waere eine exotische Fassungsnummer ein pip bei JEDEM Import."""
    monkeypatch.setattr(yu, "fassung", lambda: "unbekannt")
    assert yu.faellig() is True
    settings.save({"ytdlp_geprueft": HEUTE.isoformat()})
    assert yu.faellig() is False


def test_kaputter_merker_blockiert_nicht(monkeypatch):
    """Ein von Hand verdrehtes Datum darf die Aktualisierung nicht fuer immer abschalten."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    settings.save({"ytdlp_geprueft": "gestern"})
    assert yu.faellig() is True


def test_merker_in_der_ZUKUNFT_blockiert_nicht(monkeypatch):
    """`(heute - g).days` wird bei einem Zukunftsdatum negativ — `faellig()` waere damit
    dauerhaft False und der Kalenderweg **still und fuer immer** abgeschaltet. Erreichbar
    per Handbearbeitung oder einer vorgehenden Rechneruhr; der API-Pfad ist verteidigt
    (`SettingsBody` kennt den Schluessel nicht), diese beiden nicht."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")
    settings.save({"ytdlp_geprueft": "2099-01-01"})
    assert yu.geprueft() is None
    assert yu.faellig() is True


def test_ohne_installiertes_yt_dlp_kein_update(monkeypatch):
    """`pip install -U` wuerde yt-dlp NEU installieren. Das ist Sache des Setups; hier
    bliebe sonst die ehrliche Meldung 'yt-dlp ist nicht installiert' aus."""
    monkeypatch.setattr(yu, "fassung", lambda: None)
    assert yu.faellig() is False


def test_fassung_laedt_yt_dlp_nicht(monkeypatch):
    """Der Kern des Mechanismus: die Fassung kommt aus den Metadaten auf der Platte.
    Ein Import hier machte die ganze Reihenfolge (pruefen -> pip -> importieren) sinnlos."""
    gerufen = []
    monkeypatch.setattr(yu.metadata, "version", lambda name: gerufen.append(name) or "2026.8.1")
    assert yu.fassung() == "2026.8.1"
    assert gerufen == ["yt-dlp"]


# --- Schalter ----------------------------------------------------------------

def test_einstellung_schaltet_ab():
    settings.save({"ytdlp_auto": "0"})
    assert yu.auto_an() is False


def test_env_gewinnt_gegen_die_einstellung(monkeypatch):
    """Wie job_env(): wer die Variable gesetzt hat (.env, CI), soll sie behalten."""
    settings.save({"ytdlp_auto": "0"})
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "1")
    assert yu.auto_an() is True
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    settings.save({"ytdlp_auto": "1"})
    assert yu.auto_an() is False


def test_leere_env_variable_ist_KEIN_override(monkeypatch):
    """`settings.load_env()` schreibt eine Zeile `TRANSKRIBOR_YTDLP_UPDATE=` als LEEREN
    String in die Umgebung. `os.environ.get` liefert dann "" statt None — ein `is None`-Test
    haelt das faelschlich fuer ein gesetztes JA, und wer den Haken im Browser abwaehlt,
    bekaeme weiter Updates plus die Meldung, eine leer gelassene Variable sei schuld."""
    settings.save({"ytdlp_auto": "0"})
    for leer in ("", "   "):
        monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", leer)
        assert yu.env_override() is None, repr(leer)
        assert yu.auto_an() is False, repr(leer)
        assert yu.zustand()["env"] is False, repr(leer)


def test_zustand_meldet_das_override_selbst(monkeypatch):
    """Der Server sagt es, statt das Frontend `ytdlp_auto` gegen `auto` vergleichen zu
    lassen: die beiden kommen aus zwei Antworten, und dazwischen behauptete der Vergleich
    ein Override, das es nicht gibt."""
    settings.save({"ytdlp_auto": "1"})
    assert yu.zustand()["env"] is False
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    z = yu.zustand()
    assert z["env"] is True and z["auto"] is False


def test_abgeschaltet_laeuft_kein_pip(monkeypatch):
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    monkeypatch.setattr(yu, "fassung", lambda: "2026.7.4")        # waere faellig
    assert yu.automatisch() is False                              # das gefaelschte run() wuerde failen


# --- aktualisiere ------------------------------------------------------------

def test_pip_aktualisiert_NUR_yt_dlp(monkeypatch):
    """Nie ueber alle requirements: das erwischt irgendwann torch, und die GPU waere still
    weg (dieselbe Falle wie beim CPU-Rad in setup.js)."""
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    assert yu.aktualisiere() is True
    cmd = gerufen[0][0]
    assert cmd[:5] == [yu.sys.executable, "-m", "pip", "install", "-U"]
    assert [x for x in cmd if not x.startswith("-")][-1] == "yt-dlp"
    assert "-r" not in cmd and not any("requirement" in x for x in cmd)


def test_pip_bekommt_kurze_zeitlimits(monkeypatch):
    """Ohne Deckel haengt pip offline minutenlang — und der Import wartet solange."""
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    cmd, kwargs = gerufen[0]
    assert "--timeout" in cmd and "--retries" in cmd
    assert kwargs["timeout"] == yu.PIP_TIMEOUT


def test_aktualisiere_setzt_den_merker(monkeypatch):
    _, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    assert settings.load()["ytdlp_geprueft"] == "2026-08-13"


def test_merker_auch_nach_fehlschlag(monkeypatch):
    """Sonst liefe der naechste Import in denselben Timeout."""
    def kaputt(*a, **k):
        raise subprocess.TimeoutExpired("pip", 120)
    monkeypatch.setattr(yu.subprocess, "run", kaputt)
    assert yu.aktualisiere() is False
    assert settings.load()["ytdlp_geprueft"] == "2026-08-13"


def test_pip_exitcode_ungleich_null_ist_kein_erfolg(monkeypatch):
    _, run = _pip(returncode=1, ausgabe="ERROR: Could not find a version")
    monkeypatch.setattr(yu.subprocess, "run", run)
    assert yu.aktualisiere() is False


def test_fehlschlag_wirft_nicht_und_wird_protokolliert(monkeypatch, capsys):
    """Best effort: ein Rechner ohne Netz darf durch dieses Feature nicht schlechter
    dastehen als vorher. Der Import laeuft danach mit der vorhandenen Fassung weiter."""
    def kaputt(*a, **k):
        raise OSError("kein Netz")
    monkeypatch.setattr(yu.subprocess, "run", kaputt)
    assert yu.aktualisiere() is False
    assert "ytdlp" in capsys.readouterr().out


def test_unanlegbares_sperrverzeichnis_bricht_nicht_ab(monkeypatch, capsys):
    """Der einzige Aufruf in diesem Modul, der frueher ungeschuetzt werfen konnte. Ein
    schreibgeschuetztes Profil (oder ein TRANSKRIBOR_SETTINGS ohne Verzeichnisanteil) haette
    den Import mitgerissen — genau das, was 'best effort, nie blockierend' ausschliesst.

    `yu.os` IST das `os`-Modul, der Patch wirkt also global: auch `settings.save()` im
    `_merken()` faellt damit aus. Das ist Absicht und macht die Probe haerter — geprueft wird,
    dass `aktualisiere()` **beide** Fehlschlaege ueberlebt und trotzdem True meldet. Die
    Sperre selbst braucht `os.mkdir`, nicht `makedirs`, wird hier also nicht angefasst; ihr
    eigener Fehlerpfad steht in `test_sperre.py`.
    """
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)

    def nein(*a, **k):
        raise OSError(13, "Permission denied")
    monkeypatch.setattr(yu.os, "makedirs", nein)
    assert yu.aktualisiere() is True            # pip laeuft trotzdem …
    assert len(gerufen) == 1
    assert "Sperrverzeichnis" in capsys.readouterr().out   # … und sagt es


def test_unschreibbare_einstellungsdatei_bricht_nicht_ab(monkeypatch):
    """Der Merker ist Buchhaltung, kein Ergebnis. Scheitert sein Schreiben, war das
    Update trotzdem erfolgreich — ein Fehler hier wuerde den Import mitreissen."""
    _, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)

    def nein(*a, **k):
        raise OSError("read-only")
    monkeypatch.setattr(yu.settings, "save", nein)
    assert yu.aktualisiere() is True


# --- automatisch (der Weg, den fetch.py geht) --------------------------------

def test_automatisch_ueberspringt_die_frische_fassung(monkeypatch):
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")
    assert yu.automatisch() is False        # das gefaelschte run() wuerde sonst failen


def test_erzwingen_uebergeht_den_merker(monkeypatch):
    """Die Selbstheilung greift genau dann, wenn gerade erst geprueft wurde: der Extraktor
    bricht ja nicht nach Kalender. Ein Merker-Respekt machte sie meistens wirkungslos."""
    gerufen, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")
    settings.save({"ytdlp_geprueft": HEUTE.isoformat()})
    assert yu.automatisch(erzwingen=True) is True
    assert len(gerufen) == 1


def test_erzwingen_uebergeht_den_schalter_NICHT(monkeypatch):
    """Wer seine venv selbst verwaltet, will auch keine Selbstheilung darin."""
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    assert yu.automatisch(erzwingen=True) is False


# --- Nebenlaeufigkeit --------------------------------------------------------

def test_zwei_pip_laeufe_ueberschneiden_sich_nicht(monkeypatch):
    """Zwei pip auf DIESELBE venv schreiben in dasselbe site-packages und koennen die
    Installation zerlegen. Erreichbar, seit es zwei Ausloeser gibt: der Import-Job und der
    Knopf in den Einstellungen. Gemessen wird die GLEICHZEITIGKEIT, nicht die Reihenfolge —
    welcher zuerst drankommt, ist egal."""
    laufend, hoechstens = [0], [0]

    def run(cmd, **kwargs):
        laufend[0] += 1
        hoechstens[0] = max(hoechstens[0], laufend[0])
        time.sleep(0.05)                  # Fenster, in dem sich der andere hineindraengen kann
        laufend[0] -= 1
        return subprocess.CompletedProcess(cmd, 0, "ok", "")

    monkeypatch.setattr(yu.subprocess, "run", run)
    faeden = [threading.Thread(target=yu.aktualisiere) for _ in range(3)]
    for f in faeden:
        f.start()
    for f in faeden:
        f.join()
    assert hoechstens[0] == 1


def test_merker_und_pip_nehmen_VERSCHIEDENE_locks(monkeypatch):
    """`_merken()` laeuft, waehrend die pip-Sperre noch haelt. Trueg sie denselben Namen wie
    die von `settings.save()`, stuende der Lauf hier fuer immer — deshalb der Test, nicht
    nur der Kommentar."""
    _, run = _pip()
    monkeypatch.setattr(yu.subprocess, "run", run)
    fertig = threading.Event()
    # daemon: haengt es doch, soll der Faden den Testlauf nicht am Beenden hindern — sonst
    # steht statt eines roten Tests ein haengender pytest da.
    threading.Thread(target=lambda: (yu.aktualisiere(), fertig.set()), daemon=True).start()
    assert fertig.wait(5), "aktualisiere() haengt — vermutlich Selbst-Deadlock der Sperren"
