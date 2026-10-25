"""Nutzungszaehlung fuer Transkribor — der Empfaenger der Opt-in-Tagesmeldung.

Zusagen an die Nutzer (README `#nutzung`, `NutzungFrage.tsx`), hier eingeloest:
  * gespeichert werden nur (tag, geraet, version, plattform) — keine IP, keine Kopfzeilen;
  * `log_message` ist stumm, damit auch kein Zugriffslog eine IP traegt;
  * Zeilen aelter als AUFBEWAHRUNG_TAGE werden beim Start und taeglich geloescht.
Nur Standardbibliothek: der Container braucht nichts ausser Python.
"""
import hmac
import json
import os
import re
import sqlite3
import threading
import time
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


def zahlen(con, heute=None):
    h = heute or date.today()
    def geraete(tage):
        ab = (h - timedelta(days=tage - 1)).isoformat()
        return con.execute("select count(distinct geraet) from ping where tag >= ?", (ab,)).fetchone()[0]
    def je(spalte):
        ab = (h - timedelta(days=29)).isoformat()
        sql = f"select {spalte}, count(distinct geraet) from ping where tag >= ? group by 1 order by 2 desc"
        return dict(con.execute(sql, (ab,)).fetchall())
    gesamt = con.execute("select count(distinct geraet) from ping").fetchone()[0]
    return {"heute": geraete(1), "7_tage": geraete(7), "30_tage": geraete(30), "gesamt": gesamt,
            "version_30_tage": je("version"), "plattform_30_tage": je("plattform")}


def handler_fuer(con):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # kein Zugriffslog: es truege die IP
            pass

        def antwort(self, code, koerper=None):
            roh = json.dumps(koerper or {}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(roh)))
            self.end_headers()
            self.wfile.write(roh)

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

        def do_GET(self):
            if self.path == "/gesund":
                return self.antwort(200, {"ok": True})
            if self.path != "/v1/zahlen":
                return self.antwort(404)
            auth = self.headers.get("Authorization", "")
            if not TOKEN or not hmac.compare_digest(auth, f"Bearer {TOKEN}"):
                return self.antwort(401)
            self.antwort(200, zahlen(con))
    return H


def main():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    con = verbinden()
    aufraeumen(con)

    def taeglich():
        while True:
            time.sleep(24 * 3600)
            aufraeumen(con)
    threading.Thread(target=taeglich, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), handler_fuer(con)).serve_forever()


if __name__ == "__main__":
    main()
