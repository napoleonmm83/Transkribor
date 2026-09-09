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


def _bericht(seit=None):
    """Der Zustand des Anmeldevorgangs als EINE Zeile — fuer Fehlschlaege in der CI.

    Grund (#558): diese Datei faellt unter der vollen Suite sporadisch um, je ein
    anderer Test, isoliert nie. Was im Protokoll ankam, war ein nackter
    `AttributeError: 'NoneType' object has no attribute 'poll'` — daraus laesst sich
    NICHT entscheiden, welche der drei Erklaerungen zutrifft:

      a) `Popen` ist gescheitert  ⇒ `fehler` traegt "Start fehlgeschlagen: ..."
      b) der Start war nur langsam ⇒ `proc=None` bei kurzer `seit_start`, Ausgabe leer
      c) die Ausgabe kam spaet     ⇒ `proc` gesetzt, Ausgabe kurz oder leer

    Die drei sind am Zustand unterscheidbar, aber nur, wenn ihn jemand aufschreibt.
    Auf diesem Rechner ist der Fehler in 25 vollen Suitenlaeufen NICHT aufgetreten
    (7 einzeln, 18 zu sechst gleichzeitig) — ein Fix waere damit auf einer
    ungepruefen Vermutung gebaut und liesse sich von keiner Mutationsprobe rot
    bekommen. Deshalb hier Diagnose statt Reparatur: der naechste Fehlschlag in der
    CI soll seine eigene Ursache mitbringen.
    """
    lauf = auth._lauf
    if lauf is None:
        return "auth._lauf is None (gar kein Vorgang)"
    ausgabe = "".join(lauf["ausgabe"])
    teile = []
    if seit is not None:
        teile.append(f"seit_start={time.time() - seit:.2f}s")
    teile += [
        "proc=" + ("gesetzt" if lauf["proc"] is not None else "None"),
        f"laeuft={lauf['laeuft']}",
        f"ok={lauf['ok']}",
        f"fehler={lauf['fehler']!r}",
        f"ausgabe={len(ausgabe)}z {ausgabe[-160:]!r}",
    ]
    return " | ".join(teile)


# Die zwei Zusicherungen aus #558 stehen als FUNKTIONEN da, nicht als Inline-Zeilen —
# und das ist kein Stil, sondern der Unterschied zwischen bewacht und unbewacht.
# Der Kalt-Review hat gemessen, dass eine Inline-Meldung STILL verschwinden kann:
# `, _bericht(t0)` aus beiden Zusicherungen entfernt ⇒ alle 17 Tests blieben gruen.
# Die Absicht des ganzen PR (der Fehlschlag bringt seine Ursache mit) haette also
# keinen roten Test gehabt — nur die Mechanik von `_bericht` hatte einen.
# Als Funktion laesst sich der Fehlerfall herstellen; die zwei Waechter am
# Dateiende tun genau das.
def _url_muss_da_sein(z, erwartet, seit):
    assert z["url"] == erwartet, "URL fehlt — " + _bericht(seit)


def _prozess_muss_gesetzt_sein(alt, seit):
    assert alt is not None, "start() kam ohne gesetzten Prozess zurueck — " + _bericht(seit)


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
    t0 = time.time()
    z = auth.start("claude-cli")
    # Die URL wird am Ereignis erwartet, nicht an der festen 3-s-Frist der Rueckgabe (#558):
    # unter Volllast kam `Popen` langsamer hoch als diese Frist, `start()` kehrte ohne URL
    # zurueck, und der Test schlug auf einen langsamen Start statt auf einen kaputten Leser.
    # Der UI-Poll geht denselben Weg (GET loginState, SettingsPage) — die Rueckgabe bleibt
    # fuer das verantwortlich, was sie synchron zusagen kann (Zeile ganz unten).
    erwartet = "https://example.invalid/oauth?code=true"
    assert _warte(lambda: auth.zustand("claude-cli")["url"]), \
        "URL kam nicht in den Zustand — " + _bericht(t0)
    # Der Zustand steht in der Meldung, nicht nur der erwartete Wert: dieser Test
    # ist einer der zwei aus #558, und ein blosses "leer ist nicht die URL" sagt
    # nichts darueber, WARUM sie fehlt.
    _url_muss_da_sein(auth.zustand("claude-cli"), erwartet, t0)
    assert z["laeuft"] is True and z["braucht_code"] is True, _bericht(t0)


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
    auth.start("claude-cli")
    # Ereignis statt Frist (#558, Nachbarstelle desselben Rennens): `proc` und die URL
    # stehen erst nach `Popen` bzw. dem zeichenweisen Lesen im Zustand — ohne Warten
    # verglich der Test zwei Rueckgaben, deren eine die URL noch nicht trug (rot aus
    # Verschwinden) oder gar None mit None (vacuous gruen, schlimmer).
    assert _warte(lambda: (auth._lauf or {}).get("proc") is not None
                  and auth.zustand("claude-cli")["url"]), "Start nicht sichtbar — " + _bericht()
    proc = auth._lauf["proc"]
    url_vor = auth.zustand("claude-cli")["url"]
    zweit = auth.start("claude-cli")
    assert auth._lauf["proc"] is proc
    assert zweit["url"] == url_vor


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
    t0 = time.time()
    auth.start("claude-cli")
    # Ereignis statt Rueckgabe-Frist (#558): `proc` wird erst gesetzt, nachdem der
    # Daemon-Faden durch `Popen` ist — unter Volllast spaeter als `start()` zurueckkehrt.
    # Vorher direkt gelesen, starb der Test an `alt.poll()` mit einem AttributeError, der
    # die Ursache verschweigt; das Warten traegt denselben Bericht mit sich.
    assert _warte(lambda: (auth._lauf or {}).get("proc") is not None), \
        "erster Start hat keinen Prozess gesetzt — " + _bericht(t0)
    # `(auth._lauf or {})`, nicht `auth._lauf[...]`: der Zugriff selbst war die ERSTE
    # Absturzstelle. Steht dort None, starb die Zeile mit einem nackten
    # `TypeError: 'NoneType' object is not subscriptable` (Kalt-Review B4).
    alt = (auth._lauf or {}).get("proc")
    _prozess_muss_gesetzt_sein(alt, t0)
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


def _lauf_attrappe(**abweichend):
    lauf = {"provider": "claude-cli", "laeuft": True, "ok": False, "fehler": "",
            "ausgabe": [], "proc": None, "braucht_code": True, "start": time.time()}
    lauf.update(abweichend)
    return lauf


def test_bericht_nennt_die_tatsachen_die_die_ursachen_trennen():
    """Der Bericht aus #558 ist nur brauchbar, wenn er die drei Faelle TRENNT.

    Beide Richtungen stehen hier: ein Bericht, der immer `proc=None` sagt, waere
    derselbe Schaden von der anderen Seite — er behauptete einen gescheiterten
    Start, wo keiner war.
    """
    auth._lauf = _lauf_attrappe(fehler="Start fehlgeschlagen: [WinError 8]", ausgabe=["x"])
    text = _bericht(time.time() - 1.5)
    assert "proc=None" in text, text
    assert "Start fehlgeschlagen" in text, text
    assert "seit_start=" in text, text
    assert "ausgabe=1z" in text, text

    # Das ENDE der Ausgabe, nicht nur ihre Laenge: es trennt einen VIERTEN Ausgang,
    # den der Docstring nicht nennt — die Ausgabe kam vollstaendig an, aber `_URL`
    # hat nicht getroffen (etwa nach einer Aenderung an `_ANSI`/`_URL`).
    # `ausgabe=75z` allein beantwortet das nicht (Kalt-Review B3).
    assert "ausgabe=1z 'x'" in text, text

    # Und es muss das ENDE sein, nicht der Anfang. Mit einer einzeichigen Ausgabe
    # ist `[-160:]` von `[:160]` NICHT zu unterscheiden — der Test darueber allein
    # bliebe unter dieser Vertauschung gruen (CodeRabbit-CLI). Deshalb eine lange
    # Ausgabe mit unterscheidbaren Enden: der Anfang gehoert NICHT in den Bericht.
    # Das ist die Richtung, auf die es ankommt — bei einem haengenden Login steht
    # die verwertbare Spur am Ende der Ausgabe, nicht am Anfang.
    lang = "ANFANGSMARKE" + "y" * 300 + "ENDMARKE"
    auth._lauf = _lauf_attrappe(ausgabe=[lang], laeuft=False)
    text = _bericht()
    assert "ENDMARKE" in text, text
    assert "ANFANGSMARKE" not in text, text
    assert f"ausgabe={len(lang)}z" in text, text

    class _Proc:
        pass

    # `laeuft=False` ist Pflicht, nicht Kosmetik: faellt die Zusicherung darunter,
    # wird `auth._lauf = None` nie erreicht, und die autouse-Fixture ruft `abbrechen()`
    # auf einen Lauf mit `laeuft=True` und diesem Attrappen-Prozess — `_kill_tree`
    # stirbt dann an `str(proc.pid)` mit einem ZWEITEN AttributeError im Abbau.
    # Ausgerechnet dieselbe Ausnahmeklasse wie die aus #558, aus einer fremden Datei:
    # ein PR, der ein Protokoll lesbar machen will, legte daneben Rauschen ab, das ein
    # Leser fuer die Ursache halten kann (Kalt-Review B2, zweimal unabhaengig gemessen).
    auth._lauf = _lauf_attrappe(proc=_Proc(), laeuft=False)
    assert "proc=gesetzt" in _bericht(), _bericht()

    auth._lauf = None
    assert "auth._lauf is None" in _bericht()


def test_die_zusicherungen_tragen_den_bericht_in_ihre_meldung():
    """Der eigentliche Zweck von #558 — und bis zum Kalt-Review unbewacht.

    Gemessen wurde dort: `, _bericht(t0)` aus beiden Zusicherungen entfernt ⇒ alle
    17 Tests blieben GRUEN. Geprueft war also nur, dass `_bericht` wohlgeformt ist,
    nicht dass sein Text je bei jemandem ankommt. Ein Refactoring haette die
    Diagnose still mitgenommen, und aufgefallen waere es beim naechsten
    CI-Fehlschlag — also genau dann, wenn sie gebraucht wird.

    Hier wird der Fehlerfall PROVOZIERT statt beschrieben; die Reproduktion des
    Flakes braucht es dafuer nicht.
    """
    auth._lauf = _lauf_attrappe(laeuft=False, fehler="Start fehlgeschlagen: [WinError 8]")

    with pytest.raises(AssertionError) as e:
        _url_muss_da_sein({"url": ""}, "https://example.invalid/x", time.time() - 0.5)
    assert "URL fehlt" in str(e.value)
    assert "proc=None" in str(e.value), str(e.value)
    assert "Start fehlgeschlagen" in str(e.value), str(e.value)

    with pytest.raises(AssertionError) as e:
        _prozess_muss_gesetzt_sein(None, time.time() - 0.5)
    assert "ohne gesetzten Prozess" in str(e.value)
    assert "seit_start=" in str(e.value), str(e.value)
    assert "Start fehlgeschlagen" in str(e.value), str(e.value)

    # Gegenrichtung: im gruenen Fall darf keine der beiden Zusicherungen werfen —
    # sonst waere der Waechter erfuellt und die Tests darueber dauerhaft rot.
    _url_muss_da_sein({"url": "gleich"}, "gleich", None)
    _prozess_muss_gesetzt_sein(object(), None)
