"""Erzeugt alle Bilddateien, die aus dem Zeichen abgeleitet werden.

    .venv\\Scripts\\python.exe build\\marke.py

Warum PIL und kein SVG: das Zeichen besteht aus abgerundeten Rechtecken und einem
Dreieck — genau das, was ImageDraw kann. Ein SVG waere ein zweiter Wahrheitsstand
und braechte einen Rasterizer (cairosvg zieht auf Windows Cairo nach).

PIL zeichnet ohne Kantenglaettung. Gerendert wird deshalb in UEBER-facher Groesse
und mit LANCZOS heruntergerechnet — dasselbe Verfahren, das der DMG-Hintergrund
schon benutzt hat.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BUILD = Path(__file__).resolve().parent
WURZEL = BUILD.parent
SCHRIFTEN = BUILD / "fonts"

INDIGO = "#4F46E5"
WEISS = "#FFFFFF"
UEBER = 4                       # Renderfaktor gegen die fehlende Kantenglaettung

# Schnittnamen laut get_variation_names() (Task 1 Schritt 2):
#   SpaceGrotesk: Light, Regular, Medium, Bold      (kein SemiBold)
#   DMSans:       Thin, ExtraLight, Light, Regular, Medium, SemiBold, Bold, ExtraBold, Black
# SpaceGrotesk fuehrt kein SemiBold -> naechstschwerer Schnitt ist Bold, und der
# steht in beiden Schriften zur Verfuegung.
HALBFETT = "Bold"
NORMAL = "Regular"


def schrift(datei, groesse, variante=NORMAL):
    f = ImageFont.truetype(str(SCHRIFTEN / datei), groesse)
    if variante:
        f.set_variation_by_name(variante)
    return f


def _zeichen_roh(kante):
    """Der Entwurf steht in einem 64er-Raster; `s` rechnet ihn auf `kante` hoch."""
    s = kante / 64
    bild = Image.new("RGBA", (kante, kante), (0, 0, 0, 0))
    d = ImageDraw.Draw(bild)
    m = lambda *w: [x * s for x in w]

    d.rounded_rectangle(m(0, 0, 64, 64), radius=14 * s, fill=INDIGO)
    # Sprechblase = Rechteck plus Fahne. Die Fahne beginnt INNERHALB des Rechtecks
    # (y=34 liegt ueber der Unterkante 38), sonst bleibt an der Naht eine Kante stehen.
    d.rounded_rectangle(m(14, 10, 50, 38), radius=6 * s, fill=WEISS)
    d.polygon(m(20, 34, 30, 34, 20, 48), fill=WEISS)
    # Tonspur in der Blase — das Eigene am Zeichen steckt hier drin.
    for x, y, h in ((21, 20, 8), (28, 16, 16), (35, 19, 10), (42, 22, 4)):
        d.rounded_rectangle(m(x, y, x + 4, y + h), radius=2 * s, fill=INDIGO)
    return bild


def zeichen(kante):
    """Das Zeichen als RGBA-Bild der Kantenlaenge `kante`."""
    return _zeichen_roh(kante * UEBER).resize((kante, kante), Image.LANCZOS)


if __name__ == "__main__":
    zeichen(1024).save(BUILD / "icon.png")
    zeichen(128).save(WURZEL / "electron" / "marke.png")
    print("geschrieben: build/icon.png (1024), electron/marke.png (128)")
