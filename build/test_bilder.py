"""Prueft die committeten Bilddateien und Schriften — ohne PIL.

Der CI-Python-Job faehrt bewusst ohne schwere Abhaengigkeiten (er ist der Waechter
ueber die Lazy-Imports). Geprueft wird deshalb das, was tatsaechlich ausgeliefert
wird: die Kopfdaten der fertigen Dateien. Das ist auch die schaerfere Pruefung —
eine 32-bit-BMP oder eine um einen Pixel falsche Groesse nimmt NSIS wortlos hin
und zeigt Muell.
"""
import struct
from pathlib import Path

BUILD = Path(__file__).resolve().parent
WURZEL = BUILD.parent


def png_masse(pfad):
    """(breite, hoehe) aus dem IHDR-Block."""
    kopf = pfad.read_bytes()[:24]
    assert kopf[:8] == b"\x89PNG\r\n\x1a\n", f"{pfad.name} ist kein PNG"
    return struct.unpack(">II", kopf[16:24])


def bmp_masse(pfad):
    """(breite, hoehe, bittiefe) aus dem DIB-Kopf."""
    kopf = pfad.read_bytes()[:30]
    assert kopf[:2] == b"BM", f"{pfad.name} ist kein BMP"
    breite, hoehe = struct.unpack("<ii", kopf[18:26])
    (bits,) = struct.unpack("<H", kopf[28:30])
    return breite, hoehe, bits


def test_app_icon_ist_1024_quadratisch():
    # electron-builder leitet .ico/.icns/Linux-Groessen hieraus ab; kleiner waere unscharf.
    assert png_masse(BUILD / "icon.png") == (1024, 1024)


def test_zeichen_fuer_das_einrichtungsfenster():
    assert png_masse(WURZEL / "electron" / "marke.png") == (128, 128)


def test_schriften_sind_echte_ttf():
    for name in ("SpaceGrotesk.ttf", "DMSans.ttf"):
        p = BUILD / "fonts" / name
        assert p.exists(), f"{name} fehlt — build/marke.py kann ohne sie nicht rendern"
        assert p.read_bytes()[:4] in (b"\x00\x01\x00\x00", b"true", b"ttcf"), \
            f"{name} ist keine TrueType-Datei (woff2 nicht umgewandelt?)"
