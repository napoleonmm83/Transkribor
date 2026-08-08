"""Erzeugt den DMG-Fensterhintergrund (build/background.png + @2x).

Warum ueberhaupt ein Bild: die Gatekeeper-Warnung beim ersten Start laesst sich von innen
heraus nicht ankuendigen — vor dem erlaubten Start laeuft kein Code von uns. Das DMG-Fenster
ist die einzige Flaeche, die der Nutzer davor sieht.

Einmal laufen lassen, die beiden PNG committen:
    .venv\\Scripts\\python.exe build\\hintergrund.py

Gerendert wird in 2x und fuer 1x heruntergerechnet — identisches Layout, scharfe Schrift auf
Retina (und arm64-Macs sind alle Retina).
"""
from PIL import Image, ImageDraw, ImageFont

BREITE, HOEHE = 540, 380          # muss zu dmg.window in package.json passen
S = 2                             # Renderfaktor

GRUND = "#f5f5f7"
TITEL = "#1d1d1f"
GRAU = "#6e6e73"
TEXT = "#3a3a3c"
KARTE = "#ffffff"
RAND = "#e3e3e8"
AKZENT = "#c2410c"                # gedecktes Orange: Aufmerksamkeit, kein Alarm
PFEIL = "#c7c7cc"

# Die Schriften liegen auf jedem Windows; gerendert wird einmalig hier, im DMG steckt nur das Bild.
FETT = "C:/Windows/Fonts/seguisb.ttf"
NORMAL = "C:/Windows/Fonts/segoeui.ttf"

KARTE_X0, KARTE_X1 = 32, 508
KARTE_INNEN = 20                  # Abstand Kartenrand -> Text

# Die beiden Symbole setzt der Finder aus dmg.contents (package.json), nicht dieses Skript.
# Hier stehen sie nur, damit der Pfeil zwischen ihnen landet — beides zusammen aendern.
SYMBOL_L, SYMBOL_R, SYMBOL_Y = 140, 400, 170
SYMBOL_GROESSE = 80               # dmg.iconSize


def schrift(pfad, groesse):
    return ImageFont.truetype(pfad, groesse * S)


def breite(d, text, font):
    return d.textlength(text, font=font) / S


def zeichnen():
    bild = Image.new("RGB", (BREITE * S, HOEHE * S), GRUND)
    d = ImageDraw.Draw(bild)

    f_titel = schrift(FETT, 26)
    f_unter = schrift(NORMAL, 13)
    f_kopf = schrift(FETT, 14)
    f_text = schrift(NORMAL, 13)

    # Kopf
    d.text((BREITE / 2 * S, 30 * S), "Transkribor", font=f_titel, fill=TITEL, anchor="ma")
    d.text((BREITE / 2 * S, 70 * S), "Zum Installieren ins Programme-Verzeichnis ziehen",
           font=f_unter, fill=GRAU, anchor="ma")

    # Pfeil in die Luecke zwischen den beiden Symbolen, mit etwas Abstand zu beiden
    y = (SYMBOL_Y - 2) * S
    von = (SYMBOL_L + SYMBOL_GROESSE / 2 + 42) * S
    bis = (SYMBOL_R - SYMBOL_GROESSE / 2 - 38) * S
    d.line([(von, y), (bis, y)], fill=PFEIL, width=int(2.5 * S))
    d.polygon([(bis + 10 * S, y), (bis - 2 * S, y - 6 * S), (bis - 2 * S, y + 6 * S)], fill=PFEIL)

    # Hinweiskarte
    k_y0, k_y1 = 248, 342
    d.rounded_rectangle([(KARTE_X0 * S, k_y0 * S), (KARTE_X1 * S, k_y1 * S)],
                        radius=12 * S, fill=KARTE, outline=RAND, width=max(1, S // 2))
    d.rounded_rectangle([(KARTE_X0 * S, k_y0 * S), ((KARTE_X0 + 4) * S, k_y1 * S)],
                        radius=2 * S, fill=AKZENT)

    tx = (KARTE_X0 + KARTE_INNEN) * S
    zeilen = [
        (268, "Beim allerersten Start blockiert macOS die App.", f_kopf, TITEL),
        (293, "Systemeinstellungen \u203a Datenschutz & Sicherheit \u203a \u201eDennoch \u00f6ffnen\u201c", f_text, TEXT),
        (315, "Nur dieses eine Mal \u2014 danach startet Transkribor ganz normal.", f_text, GRAU),
    ]
    for ty, text, font, farbe in zeilen:
        d.text((tx, ty * S), text, font=font, fill=farbe)

    # Der Hinweis nuetzt nichts, wenn er aus der Karte laeuft: lieber hier scheitern als im DMG.
    platz = KARTE_X1 - KARTE_X0 - 2 * KARTE_INNEN
    for _, text, font, _ in zeilen:
        b = breite(d, text, font)
        assert b <= platz, f"Zeile zu breit ({b:.0f}px > {platz}px): {text!r}"

    return bild


if __name__ == "__main__":
    gross = zeichnen()
    gross.save("build/background@2x.png")
    gross.resize((BREITE, HOEHE), Image.LANCZOS).save("build/background.png")
    print(f"geschrieben: build/background.png ({BREITE}x{HOEHE}) + @2x ({BREITE*S}x{HOEHE*S})")
