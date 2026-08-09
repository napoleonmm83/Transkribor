"""Anmeldung an den Abo-CLIs.

Getestet wird gegen eine **nachgebaute CLI** (ein Python-Skript), nicht gegen `claude`/`codex`:
ein echter Login-Aufruf griffe in die Anmeldung des Entwicklers ein. Das Skript bildet genau
die zwei Eigenheiten nach, an denen die Umsetzung haengt und die an den echten CLIs gemessen
wurden — Ausgabe der URL ohne abschliessenden Zeilenumbruch bei der Eingabeaufforderung, und
Erfolg, der sich erst an einer spaeteren Statusabfrage zeigt.
"""
import subprocess
import sys
import textwrap
import time

import pytest

from webtool import auth


@pytest.fixture(autouse=True)
def sauber():
    """Kein Anmeldeversuch darf in den naechsten Test lecken."""
    yield
    auth.abbrechen()
    auth._lauf = None


def _fake_cli(tmp_path, *, code_noetig=True, url="https://example.invalid/oauth?code=true",
              zeigt_code=""):
    """Ein Skript, das sich wie `claude auth login` / `codex login --device-auth` verhaelt.

    `marker` ist die Datei, an der die Statusabfrage danach den Erfolg erkennt — genau wie
    bei den echten CLIs, wo `auth status` den Zustand kennt und der Exitcode nichts beweist.
    """
    marker = tmp_path / "angemeldet"
    skript = tmp_path / "cli.py"
    skript.write_text(textwrap.dedent(f"""
        import sys
        modus = sys.argv[1]
        if modus == "status":
            import os
            sys.exit(0 if os.path.exists({str(marker)!r}) else 1)
        sys.stdout.write("Opening browser to sign in\\n")
        sys.stdout.write("If the browser didn't open, visit: {url}\\n")
        {'sys.stdout.write("Your code: ABCD-1234\\n")' if zeigt_code else ''}
        sys.stdout.flush()
        if {code_noetig!r}:
            # Ohne Zeilenumbruch — genau wie die echte Aufforderung von `claude auth login`.
            sys.stdout.write("Paste code here if prompted > ")
            sys.stdout.flush()
            eingabe = sys.stdin.readline().strip()
            if eingabe == "GEHEIM":
                open({str(marker)!r}, "w").close()
        else:
            open({str(marker)!r}, "w").close()
        sys.stdout.write("\\nfertig\\n")
    """), encoding="utf-8")
    return skript, marker


def _verdrahte(monkeypatch, skript, code_noetig=True):
    """Haengt die nachgebaute CLI anstelle des echten Programms ein."""
    monkeypatch.setattr(auth, "_exe", lambda p: sys.executable)
    monkeypatch.setitem(auth.CLIS, "claude-cli", {
        "status": [str(skript), "status"],
        "login": [str(skript), "login"],
        "braucht_code": code_noetig,
    })


def _warte(bedingung, grenze=10.0):
    ende = time.time() + grenze
    while time.time() < ende:
        if bedingung():
            return True
        time.sleep(0.05)
    return False


def test_status_meldet_nicht_angemeldet(monkeypatch, tmp_path):
    skript, _ = _fake_cli(tmp_path)
    _verdrahte(monkeypatch, skript)
    st = auth.status("claude-cli")
    assert st["unterstuetzt"] is True and st["angemeldet"] is False


def test_status_meldet_angemeldet(monkeypatch, tmp_path):
    skript, marker = _fake_cli(tmp_path)
    marker.write_text("", encoding="utf-8")
    _verdrahte(monkeypatch, skript)
    assert auth.status("claude-cli")["angemeldet"] is True


def test_api_anbieter_haben_keinen_anmeldezustand():
    """Dort IST der Key die Anmeldung — die Oberflaeche darf nichts anzeigen."""
    assert auth.status("openai") == {"unterstuetzt": False, "angemeldet": False, "detail": ""}


def test_fehlendes_programm_meldet_sich_statt_zu_werfen(monkeypatch):
    """Die Einstellungsseite muss auch ohne installierte CLI laden."""
    monkeypatch.setattr(auth, "_exe", lambda p: "")
    st = auth.status("claude-cli")
    assert st["angemeldet"] is False and "installieren" in st["detail"]


def test_login_zeigt_die_url_ohne_zeilenumbruch_abzuwarten(monkeypatch, tmp_path):
    """Der Kern: die Aufforderung kommt ohne \\n. Ein zeilenweiser Leser (wie in jobs.py)
    saehe die URL erst, wenn spaeter zufaellig etwas nachkommt."""
    skript, _ = _fake_cli(tmp_path)
    _verdrahte(monkeypatch, skript)
    z = auth.start("claude-cli")
    assert z["url"] == "https://example.invalid/oauth?code=true"
    assert z["laeuft"] is True and z["braucht_code"] is True


def test_code_geht_an_die_wartende_cli_und_meldet_erfolg(monkeypatch, tmp_path):
    skript, _ = _fake_cli(tmp_path)
    _verdrahte(monkeypatch, skript)
    auth.start("claude-cli")
    auth.code("GEHEIM")
    assert _warte(lambda: not auth.zustand()["laeuft"]), "Anmeldung lief nicht zu Ende"
    assert auth.zustand()["ok"] is True


def test_falscher_code_meldet_misserfolg_trotz_exitcode_null(monkeypatch, tmp_path):
    """Das Skript endet auch bei falschem Code mit 0 — der Erfolg haengt an der
    Statusabfrage, genau wie bei den echten CLIs."""
    skript, _ = _fake_cli(tmp_path)
    _verdrahte(monkeypatch, skript)
    auth.start("claude-cli")
    auth.code("FALSCH")
    assert _warte(lambda: not auth.zustand()["laeuft"])
    z = auth.zustand()
    assert z["ok"] is False and z["fehler"]


def test_geraete_flow_braucht_keinen_code(monkeypatch, tmp_path):
    """Codex-Fall: URL UND Code werden angezeigt, eingegeben wird im Browser."""
    skript, _ = _fake_cli(tmp_path, code_noetig=False, zeigt_code="ABCD-1234")
    _verdrahte(monkeypatch, skript, code_noetig=False)
    auth.start("claude-cli")
    assert _warte(lambda: not auth.zustand()["laeuft"])
    z = auth.zustand()
    assert z["ok"] is True and z["braucht_code"] is False and z["code"] == "ABCD-1234"


def test_zweiter_start_raeumt_den_laufenden_nicht_weg(monkeypatch, tmp_path):
    """Ein Doppelklick darf nicht den Versuch abraeumen, in dessen Browser-Tab der Nutzer
    gerade tippt."""
    skript, _ = _fake_cli(tmp_path)
    _verdrahte(monkeypatch, skript)
    erst = auth.start("claude-cli")
    proc = auth._lauf["proc"]
    zweit = auth.start("claude-cli")
    assert auth._lauf["proc"] is proc and zweit["url"] == erst["url"]


def test_code_ohne_laufende_anmeldung_meldet_sich(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError):
        auth.code("EGAL")


def test_abbrechen_beendet_den_vorgang(monkeypatch, tmp_path):
    skript, _ = _fake_cli(tmp_path)
    _verdrahte(monkeypatch, skript)
    auth.start("claude-cli")
    auth.abbrechen()
    assert _warte(lambda: not auth.zustand()["laeuft"])
    assert auth.zustand()["ok"] is False


def test_farbcodes_zerstoeren_weder_url_noch_code(monkeypatch, tmp_path):
    """Aus dem Feld: `codex login --device-auth` faerbt URL und Code. Ungefiltert frisst die
    URL-Regex das abschliessende \\x1b[0m mit (kaputter Link), und die Wortgrenze vor dem
    Code scheitert am `m` aus `[94m` — der Code blieb unsichtbar und der Flow haengen."""
    skript = tmp_path / "cli.py"
    skript.write_text(
        "import sys\n"
        "if sys.argv[1] == 'status': sys.exit(1)\n"
        "sys.stdout.write('1. Link:\\n   \\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m\\n')\n"
        "sys.stdout.write('2. Code:\\n   \\x1b[94mIUO4-YVUNH\\x1b[0m\\n')\n"
        "sys.stdout.flush()\n"
        "import time; time.sleep(30)\n", encoding="utf-8")
    _verdrahte(monkeypatch, skript, code_noetig=False)
    z = auth.start("claude-cli")
    assert z["url"] == "https://auth.openai.com/codex/device"
    assert z["code"] == "IUO4-YVUNH"
    assert "\x1b" not in z["ausgabe"]


def test_anbieterwechsel_zeigt_den_fremden_vorgang_nicht(monkeypatch, tmp_path):
    """Aus dem Feld: waehrend einer Codex-Anmeldung auf das Claude-Abo umgestellt — die
    Codex-URL stand danach unter der Claude-Ueberschrift."""
    skript, _ = _fake_cli(tmp_path)
    _verdrahte(monkeypatch, skript)
    auth.start("claude-cli")
    assert auth.zustand("claude-cli")["laeuft"] is True
    assert auth.zustand("codex-cli") == {"laeuft": False}


def test_start_fuer_anderen_anbieter_raeumt_den_alten_weg(monkeypatch, tmp_path):
    skript, _ = _fake_cli(tmp_path)
    _verdrahte(monkeypatch, skript)
    monkeypatch.setitem(auth.CLIS, "codex-cli", dict(auth.CLIS["claude-cli"]))
    auth.start("claude-cli")
    alt = auth._lauf["proc"]
    auth.start("codex-cli")
    assert auth._lauf["provider"] == "codex-cli" and auth._lauf["proc"] is not alt
    assert _warte(lambda: alt.poll() is not None), "der alte Vorgang laeuft weiter"


def test_detail_macht_aus_beiden_ausgabeformen_einen_satz():
    """`claude auth status` antwortet JSON, `codex login status` einen Satz."""
    js = '{"loggedIn": true, "email": "a@b.c", "subscriptionType": "max"}'
    assert auth._detail(js, 0) == "Angemeldet als a@b.c (max)"
    assert auth._detail('{"loggedIn": false}', 1) == "Nicht angemeldet."
    assert auth._detail("Logged in using ChatGPT", 0) == "Logged in using ChatGPT"


def test_kaputte_statusausgabe_wirft_nicht():
    assert auth._detail("{kein json", 0)
    assert auth._detail("", 1) == "Nicht angemeldet."
