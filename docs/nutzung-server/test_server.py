import json
import threading
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
        code, z = get("/v1/zahlen", "geheim")
        assert code == 200 and z["heute"] == 1
    finally:
        srv.shutdown()
