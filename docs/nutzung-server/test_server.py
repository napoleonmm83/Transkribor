import base64
import hashlib
import json
import random
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


def _primzahl(bits, rnd):
    while True:
        p = rnd.getrandbits(bits) | (1 << (bits - 1)) | 1
        d, s = p - 1, 0
        while d % 2 == 0:
            d, s = d // 2, s + 1
        for _ in range(24):
            x = pow(rnd.randrange(2, p - 1), d, p)
            if x in (1, p - 1):
                continue
            for _ in range(s - 1):
                x = pow(x, 2, p)
                if x == p - 1:
                    break
            else:
                break
        else:
            return p


@pytest.fixture(scope="module")
def rsa():
    """Ein Test-Schluesselpaar nur aus der Standardbibliothek (1024 Bit reichen fuer PKCS#1-Padding)."""
    rnd = random.Random(4711)
    e = 65537
    while True:
        p, q = _primzahl(512, rnd), _primzahl(512, rnd)
        phi = (p - 1) * (q - 1)
        if p != q and phi % e:
            return p * q, e, pow(e, -1, phi)


def _b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _token(rsa, **rumpf):
    n, _, d = rsa
    kopf = _b64u(json.dumps({"alg": "RS256", "kid": "k1"}).encode())
    inhalt = {"aud": [server.ACCESS_AUD], "iss": server.ACCESS_TEAM, "exp": time.time() + 600,
              "email": "marcusmartini83@gmail.com", **rumpf}
    koerper = _b64u(json.dumps(inhalt).encode())
    k = (n.bit_length() + 7) // 8
    em = (b"\x00\x01" + b"\xff" * (k - 3 - len(server._DIGEST_INFO) - 32) + b"\x00"
          + server._DIGEST_INFO + hashlib.sha256(f"{kopf}.{koerper}".encode()).digest())
    sig = pow(int.from_bytes(em, "big"), d, n).to_bytes(k, "big")
    return f"{kopf}.{koerper}.{_b64u(sig)}"


def test_access_token_pruefung(rsa):
    n, e, _ = rsa
    finde = {"k1": (n, e)}.get
    assert server.access_email(_token(rsa), finde) == "marcusmartini83@gmail.com"
    assert server.access_email(_token(rsa, aud=["fremd"]), finde) is None
    assert server.access_email(_token(rsa, iss="https://fremd.cloudflareaccess.com"), finde) is None
    assert server.access_email(_token(rsa, exp=time.time() - 1), finde) is None
    assert server.access_email(_token(rsa, nbf=time.time() + 3600), finde) is None
    kopf, rumpf, sig = _token(rsa).split(".")
    falscher_rumpf = _b64u(json.dumps({"aud": [server.ACCESS_AUD], "iss": server.ACCESS_TEAM,
                                       "exp": time.time() + 600, "email": "boese@example.com"}).encode())
    assert server.access_email(f"{kopf}.{falscher_rumpf}.{sig}", finde) is None
    unsigniert = _b64u(json.dumps({"alg": "none", "kid": "k1"}).encode())
    assert server.access_email(f"{unsigniert}.{rumpf}.", finde) is None
    assert server.access_email(_token(rsa), {}.get) is None
    assert server.access_email("", finde) is None and server.access_email("a.b", finde) is None


def test_schluessel_werden_gemerkt_und_bei_unbekanntem_kid_nachgeladen(monkeypatch):
    monkeypatch.setattr(server, "_schluessel", {"zeit": 0.0, "versuch": 0.0, "keys": {}})
    geholt = []
    def holen():
        geholt.append(1)
        return {"k1": (3, 5)}
    assert server.schluessel("k1", holen, jetzt=10_000) == (3, 5)
    assert server.schluessel("k1", holen, jetzt=10_010) == (3, 5)
    assert server.schluessel("k2", holen, jetzt=10_020) is None  # unter einer Minute: kein Nachladen
    assert server.schluessel("k2", holen, jetzt=10_100) is None
    assert len(geholt) == 2


def test_gescheitertes_holen_wird_gebremst(monkeypatch):
    monkeypatch.setattr(server, "_schluessel", {"zeit": 0.0, "versuch": 0.0, "keys": {}})
    versuche = []
    def kaputt():
        versuche.append(1)
        raise OSError("weg")
    for t in (10_000, 10_005, 10_030):
        assert server.schluessel("k1", kaputt, jetzt=t) is None
    assert len(versuche) == 1
    server.schluessel("k1", kaputt, jetzt=10_070)
    assert len(versuche) == 2


def test_uebersicht_nur_mit_gueltigem_access_token(con, rsa, monkeypatch):
    n, e, _ = rsa
    monkeypatch.setattr(server, "ERLAUBT", {"marcusmartini83@gmail.com", "marcus@martini.digital"})
    monkeypatch.setattr(server, "TOKEN", "geheim")
    monkeypatch.setattr(server, "_schluessel", {"zeit": time.time(), "versuch": time.time(), "keys": {"k1": (n, e)}})
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server.handler_fuer(con))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    basis = f"http://127.0.0.1:{srv.server_address[1]}"

    def get(pfad, kopf=None):
        try:
            r = urllib.request.urlopen(urllib.request.Request(basis + pfad, headers=kopf or {}))
            return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, None, b""
    gut = {"Cf-Access-Jwt-Assertion": _token(rsa)}
    try:
        for pfad in ("/", "/v1/uebersicht"):
            assert get(pfad)[0] == 403
            # Der blosse Kopf genuegt nicht mehr — nur das signierte Token zaehlt.
            assert get(pfad, {"Cf-Access-Authenticated-User-Email": "marcusmartini83@gmail.com"})[0] == 403
            assert get(pfad, {"Cf-Access-Jwt-Assertion": _token(rsa, email="fremd@example.com")})[0] == 403
        code, kopf, roh = get("/", gut)
        assert code == 200 and kopf["Content-Type"].startswith("text/html") and b"Transkribor" in roh
        assert kopf["Cache-Control"] == "no-store"
        assert "default-src 'none'" in kopf["Content-Security-Policy"]
        assert "frame-ancestors 'none'" in kopf["Content-Security-Policy"]
        code, _, roh = get("/v1/uebersicht", gut)
        d = json.loads(roh)
        assert code == 200 and len(d["verlauf"]) == 90 and "gesamt" in d
        # Das Access-Token ersetzt den Lese-Token fuer Skripte nicht.
        assert get("/v1/zahlen", gut)[0] == 401
        # Die Access-Freigabe fuer /v1/ping laesst Pfade darunter durch — der Server normalisiert nie.
        assert get("/v1/ping/..%2Fzahlen", gut)[0] == 404
        assert get("/v1/ping/../uebersicht", gut)[0] == 404
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
