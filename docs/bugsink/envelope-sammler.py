"""Envelope-Sammler: nimmt Sentry-Envelopes an und legt jedes als Datei ab.

Aufruf: python envelope-sink.py [port] [ausgabeordner]
DSN dazu: http://k@127.0.0.1:<port>/1
Antwortet auf jeden POST mit 200 {} und zaehlt in <ausgabeordner>/zaehler.txt mit.
"""
import gzip
import io
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
ORDNER = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "envelopes")
os.makedirs(ORDNER, exist_ok=True)


class Sammler(BaseHTTPRequestHandler):
    def rumpf_lesen(self):
        """Content-Length ODER chunked — das Node-SDK schickt chunked, dann ist Content-Length leer."""
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            teile = []
            while True:
                zeile = self.rfile.readline().strip()
                groesse = int(zeile.split(b";")[0] or b"0", 16)
                if groesse == 0:
                    self.rfile.readline()  # abschliessende Leerzeile
                    break
                teile.append(self.rfile.read(groesse))
                self.rfile.readline()  # CRLF nach dem Chunk
            return b"".join(teile)
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_POST(self):
        roh = self.rumpf_lesen()
        if self.headers.get("Content-Encoding", "").lower() == "gzip":
            try:
                roh = gzip.decompress(roh)
            except OSError:
                pass
        stempel = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time()*1000)%1000:03d}"
        pfad = os.path.join(ORDNER, f"envelope-{stempel}.txt")
        with io.open(pfad, "wb") as f:
            f.write(f"PATH {self.path}\n".encode() + b"".join(f"{k}: {v}\n".encode() for k, v in self.headers.items()) + b"\n" + roh)
        with io.open(os.path.join(ORDNER, "zaehler.txt"), "a", encoding="utf-8") as z:
            z.write(f"{stempel} {self.path} {len(roh)}\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"envelope-sink")

    def log_message(self, fmt, *args):  # ruhig bleiben
        sys.stderr.write("sink: " + (fmt % args) + "\n")


if __name__ == "__main__":
    print(f"envelope-sink auf 127.0.0.1:{PORT}, Ablage {ORDNER}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Sammler).serve_forever()
