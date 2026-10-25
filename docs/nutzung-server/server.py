"""Nutzungszaehlung fuer Transkribor — der Empfaenger der Opt-in-Tagesmeldung.

Zusagen an die Nutzer (README `#nutzung`, `NutzungFrage.tsx`), hier eingeloest:
  * gespeichert werden nur (tag, geraet, version, plattform) — keine IP, keine Kopfzeilen;
  * `log_message` ist stumm, damit auch kein Zugriffslog eine IP traegt;
  * Zeilen aelter als AUFBEWAHRUNG_TAGE werden beim Start und taeglich geloescht.
Nur Standardbibliothek: der Container braucht nichts ausser Python.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.request
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.environ.get("NUTZUNG_DB", "/daten/nutzung.sqlite")
TOKEN = os.environ.get("NUTZUNG_TOKEN", "")
AUFBEWAHRUNG_TAGE = 400
MAX_RUMPF = 1024
GERAET = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9A-Za-z.+-]{1,32}$")
PLATTFORM = re.compile(r"^(win32|darwin|linux)-(x64|arm64|ia32|arm)$")

_sperre = threading.Lock()


def verbinden(pfad=None):
    con = sqlite3.connect(pfad or DB, check_same_thread=False)
    con.execute("create table if not exists ping (tag text not null, geraet text not null,"
                " version text not null, plattform text not null, primary key (tag, geraet))")
    return con


def aufraeumen(con, heute=None):
    grenze = ((heute or date.today()) - timedelta(days=AUFBEWAHRUNG_TAGE)).isoformat()
    with _sperre:
        con.execute("delete from ping where tag < ?", (grenze,))
        con.commit()


def pruefen(d):
    """Die Nutzlast oder None. Genau drei Felder, jedes in fester Form — mehr nimmt der Server nicht an."""
    if not isinstance(d, dict) or set(d) != {"geraet", "version", "plattform"}:
        return None
    if not all(isinstance(d[k], str) for k in d):
        return None
    # fullmatch, nicht match: `$` liesse sonst ein abschliessendes "\n" durch.
    if not (GERAET.fullmatch(d["geraet"]) and VERSION.fullmatch(d["version"]) and PLATTFORM.fullmatch(d["plattform"])):
        return None
    return d


def eintragen(con, d, heute=None):
    tag = (heute or date.today()).isoformat()
    with _sperre:
        # Am selben Tag zaehlt ein Geraet einmal; ein Update am selben Tag ueberschreibt die Version.
        con.execute("insert into ping values (?,?,?,?) on conflict(tag, geraet) do update set"
                    " version=excluded.version, plattform=excluded.plattform",
                    (tag, d["geraet"], d["version"], d["plattform"]))
        con.commit()


# limit: POST /v1/ping ist offen; erfundene Fassungen sollen die Uebersicht nicht sprengen.
_JE = {
    "version": "select version, count(distinct geraet) from ping where tag >= ? group by 1 order by 2 desc limit 30",
    "plattform": "select plattform, count(distinct geraet) from ping where tag >= ? group by 1 order by 2 desc limit 30",
}


def zahlen(con, heute=None):
    h = heute or date.today()
    def geraete(tage):
        ab = (h - timedelta(days=tage - 1)).isoformat()
        return con.execute("select count(distinct geraet) from ping where tag >= ?", (ab,)).fetchone()[0]
    def je(spalte):
        ab = (h - timedelta(days=29)).isoformat()
        return dict(con.execute(_JE[spalte], (ab,)).fetchall())
    gesamt = con.execute("select count(distinct geraet) from ping").fetchone()[0]
    return {"heute": geraete(1), "7_tage": geraete(7), "30_tage": geraete(30), "gesamt": gesamt,
            "version_30_tage": je("version"), "plattform_30_tage": je("plattform")}


def verlauf(con, heute=None, tage=90):
    """Aktive Geraete je Tag, lueckenlos (Tage ohne Meldung mit 0) — die Kurve der Uebersicht."""
    h = heute or date.today()
    ab = h - timedelta(days=tage - 1)
    roh = dict(con.execute("select tag, count(distinct geraet) from ping where tag >= ? group by tag",
                           (ab.isoformat(),)).fetchall())
    return [{"tag": (ab + timedelta(days=i)).isoformat(), "geraete": roh.get((ab + timedelta(days=i)).isoformat(), 0)}
            for i in range(tage)]


# Zweite Schicht hinter Cloudflare Access: das signierte Access-Token (Cf-Access-Jwt-Assertion) wird
# hier selbst geprueft — Signatur gegen die oeffentlichen Schluessel des Teams, Audience, Aussteller,
# Ablauf. Ein blosser Kopf wie Cf-Access-Authenticated-User-Email reicht laut Cloudflare NICHT, solange
# die Herkunft nicht per Tunnel angebunden ist: fiele die Access-Regel weg, reichte der Proxy einen
# vom Client gesetzten Kopf durch.
ERLAUBT = {a.strip().lower() for a in os.environ.get(
    "NUTZUNG_ERLAUBT", "marcus@martini.digital,marcusmartini83@gmail.com").split(",") if a.strip()}
ACCESS_TEAM = os.environ.get("NUTZUNG_ACCESS_TEAM", "https://martinidigital.cloudflareaccess.com")
ACCESS_AUD = os.environ.get("NUTZUNG_ACCESS_AUD", "d02fa57701511639002a4596ef3a90796ebc1767b2c7d4a62ecfb77733718ee2")
_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")  # DER-Praefix SHA-256 (RFC 8017)
_schluessel = {"zeit": 0.0, "versuch": 0.0, "keys": {}}
_schluessel_sperre = threading.Lock()


def _b64(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def rs256_gueltig(n, e, nachricht, signatur):
    """RSASSA-PKCS1-v1_5 mit SHA-256, nur mit pow() — die Standardbibliothek hat keine RSA-Pruefung."""
    k = (n.bit_length() + 7) // 8
    if len(signatur) != k:
        return False
    em = pow(int.from_bytes(signatur, "big"), e, n).to_bytes(k, "big")
    soll = (b"\x00\x01" + b"\xff" * (k - 3 - len(_DIGEST_INFO) - 32) + b"\x00"
            + _DIGEST_INFO + hashlib.sha256(nachricht).digest())
    return hmac.compare_digest(em, soll)


def _holen_schluessel():
    # ACCESS_TEAM ist eine feste https-Adresse aus der Konfiguration, kein Nutzerwert.
    req = urllib.request.Request(ACCESS_TEAM + "/cdn-cgi/access/certs", headers={"User-Agent": "transkribor-nutzung/1"})  # noqa: S310
    with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310
        return {k["kid"]: (int.from_bytes(_b64(k["n"]), "big"), int.from_bytes(_b64(k["e"]), "big"))
                for k in json.load(r)["keys"] if k.get("kty") == "RSA"}


def schluessel(kid, holen=_holen_schluessel, jetzt=None):
    """Schluessel je kid, eine Stunde gemerkt; ein unbekanntes kid laedt hoechstens einmal je Minute nach."""
    t = jetzt if jetzt is not None else time.time()
    with _schluessel_sperre:
        seit_versuch = t - _schluessel.get("versuch", 0.0)
        faellig = t - _schluessel["zeit"] > 3600 or kid not in _schluessel["keys"]
        # Jeder Versuch zaehlt fuer die Minutenbremse — auch ein gescheiterter, sonst holte jede Anfrage neu.
        if faellig and seit_versuch > 60:
            _schluessel["versuch"] = t
            try:
                _schluessel["keys"], _schluessel["zeit"] = holen(), t
            except Exception as e:
                print("Access-Schluessel nicht ladbar:", type(e).__name__, file=sys.stderr)
        return _schluessel["keys"].get(kid)


def access_email(token, finde=schluessel, jetzt=None):
    """Die E-Mail aus einem gueltigen Access-Token, sonst None. Wirft nie."""
    try:
        kopf_b64, rumpf_b64, sig_b64 = token.split(".")
        kopf, rumpf = json.loads(_b64(kopf_b64)), json.loads(_b64(rumpf_b64))
        if kopf.get("alg") != "RS256":
            return None
        k = finde(kopf.get("kid"))
        if not k or not rs256_gueltig(*k, f"{kopf_b64}.{rumpf_b64}".encode(), _b64(sig_b64)):
            return None
        t = jetzt if jetzt is not None else time.time()
        aud = rumpf.get("aud")
        aud = aud if isinstance(aud, list) else [aud]
        if ACCESS_AUD not in aud or rumpf.get("iss") != ACCESS_TEAM:
            return None
        if not (isinstance(rumpf.get("exp"), (int, float)) and rumpf["exp"] > t):
            return None
        if isinstance(rumpf.get("nbf"), (int, float)) and rumpf["nbf"] > t + 60:
            return None
        email = rumpf.get("email")
        return email.strip().lower() if isinstance(email, str) else None
    except Exception:
        return None
SEITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uebersicht.html")


def handler_fuer(con):
    class H(BaseHTTPRequestHandler):
        # Ein halber Rumpf haelt sonst einen Faden unbegrenzt; der Timeout landet in log_error -> stumm.
        timeout = 10

        def log_message(self, *a):  # kein Zugriffslog: es truege die IP
            pass

        def antwort(self, code, koerper=None):
            roh = json.dumps(koerper or {}).encode()
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(roh)))
                # Pflicht: die Zone cacht aggressiv, ohne diesen Kopf lieferte Cloudflare alte Zahlen
                # aus (gemessen cf-cache-status HIT, Age 347 auf /gesund; die Uebersicht zeigte 0).
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(roh)
            except OSError:  # Client hat aufgelegt — nichts zu melden
                pass

        def do_POST(self):
            if self.path != "/v1/ping":
                return self.antwort(404)
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.antwort(400)
            if n <= 0 or n > MAX_RUMPF:
                return self.antwort(400)
            try:
                d = pruefen(json.loads(self.rfile.read(n)))
            except ValueError:
                d = None
            if d is None:
                return self.antwort(400)
            eintragen(con, d)
            self.antwort(200, {"ok": True})

        def angemeldet(self):
            return access_email(self.headers.get("Cf-Access-Jwt-Assertion", "")) in ERLAUBT

        def do_GET(self):
            # Pfade werden WOERTLICH verglichen, nie normalisiert: die Access-Freigabe fuer /v1/ping laesst
            # auch /v1/ping/..%2Fzahlen durch, und das darf hier nur 404 sein.
            if self.path == "/gesund":
                # Bewusst ohne Zahlen: /gesund ist oeffentlich, die Nutzungszahlen sind es nicht.
                return self.antwort(200, {"ok": True})
            if self.path in ("/", "/v1/uebersicht"):
                if not self.angemeldet():
                    return self.antwort(403)
                if self.path == "/v1/uebersicht":
                    return self.antwort(200, {**zahlen(con), "verlauf": verlauf(con)})
                with open(SEITE, "rb") as f:
                    roh = f.read()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(roh)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Security-Policy",
                                     "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline';"
                                     " connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
                    self.end_headers()
                    self.wfile.write(roh)
                except OSError:
                    pass
                return
            if self.path != "/v1/zahlen":
                return self.antwort(404)
            # Als Bytes vergleichen: compare_digest wirft bei nicht-ASCII-str einen TypeError.
            auth = self.headers.get("Authorization", "").encode("utf-8", "surrogateescape")
            if not TOKEN or not hmac.compare_digest(auth, f"Bearer {TOKEN}".encode()):
                return self.antwort(401)
            self.antwort(200, zahlen(con))
    return H


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Die Vorgabe druckt "... from (ip, port)" samt Traceback — das waere ein Zugriffslog mit IP.
        print("Fehler bei einer Anfrage:", sys.exc_info()[0].__name__, file=sys.stderr)


def main():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    con = verbinden()
    aufraeumen(con)

    def taeglich():
        while True:
            time.sleep(24 * 3600)
            try:
                aufraeumen(con)
            except Exception as e:  # der Faden darf nicht sterben, sonst haelt die 400-Tage-Zusage nicht
                print("Aufraeumen fehlgeschlagen:", type(e).__name__, file=sys.stderr)
    threading.Thread(target=taeglich, daemon=True).start()
    # 0.0.0.0 ist Absicht: der Container wird nur ueber den Proxy erreicht.
    Server(("0.0.0.0", int(os.environ.get("PORT", "8080"))), handler_fuer(con)).serve_forever()  # noqa: S104


if __name__ == "__main__":
    main()
