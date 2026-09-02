"""Prueft die committeten Bilddateien und Schriften — ohne PIL.

Der CI-Python-Job faehrt bewusst ohne schwere Abhaengigkeiten (er ist der Waechter
ueber die Lazy-Imports). Geprueft wird deshalb das, was tatsaechlich ausgeliefert
wird: die Kopfdaten der fertigen Dateien. Das ist auch die schaerfere Pruefung —
eine 32-bit-BMP oder eine um einen Pixel falsche Groesse nimmt NSIS wortlos hin
und zeigt Muell.
"""
import json
import struct
import zlib
from pathlib import Path

BUILD = Path(__file__).resolve().parent
WURZEL = BUILD.parent


def png_masse(pfad):
    """(breite, hoehe) aus dem IHDR-Block."""
    kopf = pfad.read_bytes()[:24]
    assert kopf[:8] == b"\x89PNG\r\n\x1a\n", f"{pfad.name} ist kein PNG"
    return struct.unpack(">II", kopf[16:24])


def png_alpha_rand(pfad):
    """Wie breit ist der vollstaendig durchsichtige Rand rundum? — ohne PIL.

    Eine reine Masspruefung genuegt hier NICHT: das fehlerhafte Icon aus #503 war
    ebenfalls 1024x1024, es fuellte die Leinwand nur randlos. Geprueft werden muss
    der Alphakanal, und dafuer fuehrt kein Weg an den Bilddaten vorbei.

    Die Datei parst Kopfdaten ohnehin von Hand (IHDR, DIB) — das hier ist derselbe
    Griff eine Ebene tiefer: IDAT zusammensetzen, entpacken, die PNG-Zeilenfilter
    zuruecknehmen (Spezifikation Abschnitt 9.2). Nur RGBA/8 bit, mehr liefert
    marke.py nicht.
    """
    roh = pfad.read_bytes()
    breite, hoehe = struct.unpack(">II", roh[16:24])
    tiefe, farbtyp = roh[24], roh[25]
    assert (tiefe, farbtyp) == (8, 6), f"{pfad.name}: erwartet 8-bit RGBA, ist {tiefe}/{farbtyp}"
    # Interlace MUSS geprueft werden, nicht nur Tiefe und Farbtyp: bei Adam7 (Byte 28 == 1)
    # stehen die Bilddaten in sieben verschachtelten Durchgaengen, der Dekoder unten liest
    # sie als fortlaufende Zeilen und liefert dann STILL einen falschen Rand. Fuer icon.png,
    # wo (0,0,0,0) erwartet wird, waere ein interlaced UND gepolstertes Bild damit
    # faelschlich gruen. Ein Bildoptimierer mit -i1 genuegt, um das auszuloesen.
    assert roh[28] == 0, f"{pfad.name}: interlaced PNG (Adam7) — dieser Dekoder liest nur Interlace 0"

    # Chunks durchlaufen und alle IDAT einsammeln — Pillow schreibt oft mehrere.
    daten, pos = bytearray(), 8
    while pos < len(roh):
        laenge, typ = struct.unpack(">I", roh[pos:pos + 4])[0], roh[pos + 4:pos + 8]
        if typ == b"IDAT":
            daten += roh[pos + 8:pos + 8 + laenge]
        pos += 12 + laenge                      # Laenge + Typ + Daten + CRC
    roh_zeilen = zlib.decompress(bytes(daten))

    def paeth(a, b, c):
        """Der Paeth-Praediktor aus Spezifikation 9.4 — links, oben, oben-links."""
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

    schritt = breite * 4                        # RGBA
    vorige, alpha = bytearray(schritt), []
    for y in range(hoehe):
        anfang = y * (schritt + 1)
        filt, zeile = roh_zeilen[anfang], bytearray(roh_zeilen[anfang + 1:anfang + 1 + schritt])
        for i in range(schritt):
            a = zeile[i - 4] if i >= 4 else 0
            b = vorige[i]
            c = vorige[i - 4] if i >= 4 else 0
            if filt == 1:
                zeile[i] = (zeile[i] + a) & 0xFF
            elif filt == 2:
                zeile[i] = (zeile[i] + b) & 0xFF
            elif filt == 3:
                zeile[i] = (zeile[i] + (a + b) // 2) & 0xFF
            elif filt == 4:
                zeile[i] = (zeile[i] + paeth(a, b, c)) & 0xFF
        vorige = zeile
        alpha.append(zeile[3::4])

    def leer(werte):
        """Ist diese Zeile vollstaendig durchsichtig? Ein einziges Alpha > 0 genuegt."""
        return not any(werte)

    oben = next(y for y in range(hoehe) if not leer(alpha[y]))
    unten = hoehe - 1 - next(y for y in range(hoehe - 1, -1, -1) if not leer(alpha[y]))
    links = next(x for x in range(breite) if any(z[x] for z in alpha))
    rechts = breite - 1 - next(x for x in range(breite - 1, -1, -1) if any(z[x] for z in alpha))
    return oben, links, unten, rechts


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


def test_mac_icon_hat_apples_rand():
    # macOS setzt den Koerper auf 824x824 mittig in 1024x1024. Randlos erscheint das
    # Symbol im Dock um 1024/824 = 1,243 groesser als jedes Nachbarsymbol (#503).
    # Geprueft wird der Alphakanal, nicht das Mass: das fehlerhafte Icon war ebenfalls
    # 1024x1024 — eine Masspruefung allein waere hier blind.
    assert png_masse(BUILD / "icon-mac.png") == (1024, 1024)
    assert png_alpha_rand(BUILD / "icon-mac.png") == (100, 100, 100, 100)


def test_jede_plattform_zeigt_auf_ihr_eigenes_icon():
    """Der eigentliche Waechter fuer #503 — er prueft die KONFIGURATION, nicht die Datei.

    Der Test darunter bewacht `icon.png`, und das genuegte nicht: electron-builder loest
    Linux als `[linux.icon, mac.icon ?? config.icon]` auf (LinuxTargetHelper,
    computeDesktopIcons). Ohne eigenen `linux.icon`-Eintrag faellt Linux also auf das
    GEPOLSTERTE macOS-Bild zurueck — AppImage und deb waeren rund 20 % zu klein, und der
    Datei-Waechter bliebe dabei gruen, weil er eine Datei prueft, die Linux gar nicht mehr
    benutzt. Genau so ist der Fehler beim ersten Anlauf durchgerutscht.

    Windows hat den Sonderfall nicht (platformPackager.getOrConvertIcon nimmt
    `win.icon || config.icon`, nie `mac.icon`) und braucht deshalb keinen Eintrag.
    """
    b = json.loads((WURZEL / "package.json").read_text(encoding="utf-8"))["build"]
    assert b["mac"]["icon"] == "build/icon-mac.png", "macOS muss auf das gepolsterte Icon zeigen"
    assert b["linux"]["icon"] == "build/icon.png", \
        "linux.icon fehlt — Linux faellt sonst auf mac.icon zurueck und bekommt den Rand"


def test_windows_und_linux_icon_bleibt_randlos():
    # Gegenrichtung: dort gibt es Apples Raster nicht, dort ist randlos richtig. Ein Fix,
    # der icon.png mitbepolstert, macht die beiden anderen Plattformen kaputt — deshalb
    # zwei Dateien und dieser Waechter.
    assert png_masse(BUILD / "icon.png") == (1024, 1024)
    assert png_alpha_rand(BUILD / "icon.png") == (0, 0, 0, 0)


def test_zeichen_fuer_das_einrichtungsfenster():
    assert png_masse(WURZEL / "electron" / "marke.png") == (128, 128)


def test_schriften_sind_echte_ttf():
    for name in ("SpaceGrotesk.ttf", "DMSans.ttf"):
        p = BUILD / "fonts" / name
        assert p.exists(), f"{name} fehlt — build/marke.py kann ohne sie nicht rendern"
        assert p.read_bytes()[:4] in (b"\x00\x01\x00\x00", b"true", b"ttcf"), \
            f"{name} ist keine TrueType-Datei (woff2 nicht umgewandelt?)"


def test_installer_sidebar_ist_164x314_und_24bit():
    # NSIS/MUI2 gibt beide Masse fest vor. 24 bit ist Pflicht: eine 32-bit-BMP
    # wird angenommen und dann falsch gezeichnet.
    assert bmp_masse(BUILD / "installerSidebar.bmp") == (164, 314, 24)


def test_installer_header_ist_150x57_und_24bit():
    assert bmp_masse(BUILD / "installerHeader.bmp") == (150, 57, 24)


def test_dmg_hintergrund_passt_zum_fenster():
    # Muss zu dmg.window in package.json passen (540x380), sonst kachelt der Finder.
    assert png_masse(BUILD / "background.png") == (540, 380)
    assert png_masse(BUILD / "background@2x.png") == (1080, 760)
