"""Der Sammler ist ein Messgeraet: liest er den Rumpf falsch, meldet der Messstand "0 Envelopes" —
genau so lief es einmal (chunked ignoriert, PR #531). Deshalb ein Test fuer `rumpf_lesen`."""
import importlib.util
import io
from email.message import Message
from pathlib import Path

_spec = importlib.util.spec_from_file_location("envelope_sammler", Path(__file__).with_name("envelope-sammler.py"))
sammler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sammler)
CRLF = bytes([13, 10])


def _handler(rumpf: bytes, **kopf):
    """Ein Handler ohne Socket: nur `rfile` und `headers`, mehr braucht `rumpf_lesen` nicht."""
    h = sammler.Sammler.__new__(sammler.Sammler)
    h.rfile = io.BytesIO(rumpf)
    h.headers = Message()
    for k, v in kopf.items():
        h.headers[k.replace("_", "-")] = v
    return h


def test_chunked_wird_zusammengesetzt_auch_mit_chunk_erweiterung():
    roh = b"5" + CRLF + b"hallo" + CRLF + b"6;ext=1" + CRLF + b" welt!" + CRLF + b"0" + CRLF + CRLF
    assert _handler(roh, Transfer_Encoding="chunked").rumpf_lesen() == b"hallo welt!"


def test_content_length_liest_genau_so_viele_bytes():
    assert _handler(b"abcdef", Content_Length="4").rumpf_lesen() == b"abcd"


def test_ohne_beides_ist_der_rumpf_leer():
    assert _handler(b"egal").rumpf_lesen() == b""


def test_modul_hat_beim_import_keinen_zustand_und_keinen_nebeneffekt():
    """Port und Ordner gehoeren nach __main__: ein Modul-ORDNER mit makedirs legte beim blossen
    Import einen Ordner an — genau das, was ein Test nicht tun darf."""
    assert not hasattr(sammler, "ORDNER") and not hasattr(sammler, "PORT")
    assert "ordner" in vars(sammler.Sammler)
