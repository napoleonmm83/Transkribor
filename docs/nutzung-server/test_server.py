import json
import socket
import threading
import time
import urllib.error
import urllib.request
from datetime import date
from http.server import ThreadingHTTPServer

import pytest
import server

G = "a" * 64
GUT = {"geraet": G, "version": "0.60.1", "plattform": "win32-x64"}


@pytest.fixture
def con(tmp_path):
    c = server.verbinden(str(tmp_path / "n.sqlite"))
    yield c
    c.close()


@pytest.mark.parametrize("d", [
    {**GUT, "ip": "1.2.3.4"},
    {"geraet": G, "version": "1"},
    {**GUT, "geraet": "A" * 64},
    {**GUT, "geraet": "a" * 63},
    {**GUT, "geraet": "a" * 64 + "\n"},
    {**GUT, "plattform": "win32-x64\n"},
    {**GUT, "plattform": "haiku-x64"},
    {**GUT, "version": "x" * 33},
    {**GUT, "version": 1},
    [GUT],
])
def test_falsche_form_wird_abgewiesen(d):
    assert server.pruefen(d) is None


def test_gute_form_geht_durch():
    assert server.pruefen(GUT) == GUT


def test_tabelle_hat_keine_ip_spalte(con):
    spalten = [r[1] for r in con.execute("pragma table_info(ping)")]
    assert spalten == ["tag", "geraet", "version", "plattform"]


def test_ueber_tage_zaehlt_ein_geraet_einmal(con):
    server.eintragen(con, GUT, date(2026, 10, 24))
    server.eintragen(con, GUT, date(2026, 10, 25))
    z = server.zahlen(con, date(2026, 10, 25))
    assert (z["7_tage"], z["gesamt"]) == (1, 1)


def test_ein_geraet_zaehlt_je_tag_einmal(con):
    t = date(2026, 10, 25)
    server.eintragen(con, GUT, t)
    server.eintragen(con, {**GUT, "version": "0.60.2"}, t)
    server.eintragen(con, {**GUT, "geraet": "b" * 64}, t)
    z = server.zahlen(con, t)
    assert z["heute"] == 2 and z["gesamt"] == 2
    assert z["version_30_tage"] == {"0.60.2": 1, "0.60.1": 1}


def test_fenster_und_aufraeumen(con):
    server.eintragen(con, GUT, date(2026, 10, 1))
    server.eintragen(con, {**GUT, "geraet": "c" * 64}, date(2025, 1, 1))
    z = server.zahlen(con, date(2026, 10, 25))
    assert (z["heute"], z["7_tage"], z["30_tage"], z["gesamt"]) == (0, 0, 1, 2)
    server.aufraeumen(con, date(2026, 10, 25))
    assert server.zahlen(con, date(2026, 10, 25))["gesamt"] == 1


def test_kein_log_mit_adresse(con, capfd):
    """Weder Zugriffszeile noch Fehlerdruck darf die Client-Adresse tragen (README-Zusage)."""
    srv = server.Server(("127.0.0.1", 0), server.handler_fuer(con))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/gesund").read()
        s = socket.create_connection(("127.0.0.1", port))
        s.sendall(b"POST /v1/ping HTTP/1.1\r\nHost: x\r\nContent-Length: 50\r\n\r\n{\"a\":")
        s.close()
        time.sleep(0.3)
    finally:
        srv.shutdown()
    aus = capfd.readouterr()
    assert "127.0.0.1" not in aus.out + aus.err
    assert "GET /gesund" not in aus.out + aus.err


def test_fehlerdruck_ohne_adresse(capfd):
    srv = server.Server(("127.0.0.1", 0), server.handler_fuer(None))
    try:
        try:
            raise ConnectionResetError("weg")
        except ConnectionResetError:
            srv.handle_error(None, ("203.0.113.7", 4711))
    finally:
        srv.server_close()
    aus = capfd.readouterr()
    assert "203.0.113.7" not in aus.out + aus.err
    assert "ConnectionResetError" in aus.err  # Positivkontrolle: es wurde gedruckt


def test_halber_rumpf_blockiert_nicht_ewig():
    assert server.handler_fuer(None).timeout == 10


def test_verlauf_ist_lueckenlos(con):
    server.eintragen(con, GUT, date(2026, 10, 23))
    server.eintragen(con, {**GUT, "geraet": "b" * 64}, date(2026, 10, 25))
    server.eintragen(con, GUT, date(2026, 10, 25))
    v = server.verlauf(con, date(2026, 10, 25), tage=3)
    assert v == [{"tag": "2026-10-23", "geraete": 1}, {"tag": "2026-10-24", "geraete": 0},
                 {"tag": "2026-10-25", "geraete": 2}]


def test_uebersicht_nur_fuer_erlaubte_adresse(con):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server.handler_fuer(con))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    basis = f"http://127.0.0.1:{srv.server_address[1]}"

    def get(pfad, email=None):
        kopf = {"Cf-Access-Authenticated-User-Email": email} if email else {}
        try:
            r = urllib.request.urlopen(urllib.request.Request(basis + pfad, headers=kopf))
            return r.status, r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError as e:
            return e.code, None, b""
    try:
        for pfad in ("/", "/v1/uebersicht"):
            assert get(pfad)[0] == 403
            assert get(pfad, "fremd@example.com")[0] == 403
        code, typ, roh = get("/", "Marcusmartini83@gmail.com ")
        assert code == 200 and typ.startswith("text/html") and b"Transkribor" in roh
        code, _, roh = get("/v1/uebersicht", "marcus@martini.digital")
        d = json.loads(roh)
        assert code == 200 and len(d["verlauf"]) == 90 and "gesamt" in d
        # Die Access-Freigabe fuer /v1/ping laesst Pfade darunter durch — der Server normalisiert nie.
        assert get("/v1/ping/..%2Fzahlen")[0] == 404
        assert get("/v1/ping/../uebersicht")[0] == 404
    finally:
        srv.shutdown()


def test_http_ende_zu_ende(con, monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "geheim")
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server.handler_fuer(con))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    basis = f"http://127.0.0.1:{srv.server_address[1]}"

    def post(d):
        req = urllib.request.Request(basis + "/v1/ping", json.dumps(d).encode(), {"Content-Type": "application/json"})
        try:
            return urllib.request.urlopen(req).status
        except urllib.error.HTTPError as e:
            return e.code

    def get(pfad, token=None):
        req = urllib.request.Request(basis + pfad, headers={"Authorization": f"Bearer {token}"} if token else {})
        try:
            r = urllib.request.urlopen(req)
            return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, None
    try:
        assert post(GUT) == 200
        assert post({**GUT, "ip": "x"}) == 400
        assert get("/v1/zahlen")[0] == 401
        assert get("/v1/zahlen", "falsch")[0] == 401
        assert get("/v1/zahlen", "fälsch")[0] == 401  # nicht-ASCII: 401, kein Absturz
        code, z = get("/v1/zahlen", "geheim")
        assert code == 200 and z["heute"] == 1
    finally:
        srv.shutdown()
