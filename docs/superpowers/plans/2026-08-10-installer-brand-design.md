# Installer und Ersteinrichtung im Brand-Design — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transkribor bekommt ein eigenes Zeichen, und alle vier Flächen vor dem ersten Programmstart — App-Icon, Windows-Assistent, DMG-Fenster, Ersteinrichtungs-Fenster — tragen es im Designsystem der App.

**Architecture:** Ein Python-Modul (`build/marke.py`) kennt das Zeichen als PIL-Zeichnung und schreibt daraus alle abgeleiteten Bilddateien; die Ausgaben werden committet, weil die CI-Runner weder PIL noch Schriften haben. electron-builder findet `build/icon.png` und `build/installer.nsh` über seine Standardpfade selbst; nur die beiden NSIS-Bilder brauchen einen Eintrag in `package.json`. Geprüft werden die **fertigen Dateien** über ihre Kopfdaten mit der Standardbibliothek — kein PIL im Testpfad.

**Tech Stack:** Python 3.13 + Pillow 12.3 (nur zur Renderzeit), fontTools + brotli (einmalige Umwandlung), electron-builder 26 / NSIS MUI2, HTML/CSS in `electron/setup.html`, pytest, `node --test`.

## Global Constraints

- **Alle gerenderten Dateien werden committet.** Die CI-Runner haben weder PIL noch die Schriften; ein Bau darf nie rendern müssen.
- **Die beiden BMP müssen 24-bit RGB sein**, Sidebar exakt `164×314`, Header exakt `150×57`. NSIS nimmt Abweichungen wortlos hin und zeigt Müll.
- **Kein neuer Eintrag in `requirements.txt`.** Pillow ist Entwicklerwerkzeug für `build/`, fontTools/brotli sind ein Einmalschritt.
- **Akzentfarbe hell `#4F46E5`, dunkel `#818CF8`.** Der dunkle Wert ist Pflicht: `#4F46E5` auf `#0B0B0F` erreicht keine 3:1.
- **Bernstein und Rot bleiben frei** — sie markieren im Editor unsichere Wörter. Keine Fläche aus diesem Plan darf in diesen Bereich laufen.
- **Radius 8 px, keine Schatten** (Designsystem). Das Icon selbst ist die Ausnahme: dort ist der Radius 14/64 der Kantenlänge, wie bei Anwendungssymbolen üblich.
- Texte in Schweizer Rechtschreibung: **„ss" statt „ß"**.

---

### Task 1: Das Zeichen, die Schriften, das App-Icon

**Files:**
- Create: `build/fonts/SpaceGrotesk.ttf`, `build/fonts/DMSans.ttf`
- Create: `build/marke.py`
- Create: `build/icon.png`, `electron/marke.png`
- Create: `build/test_bilder.py`
- Create: `LICENSE-SCHRIFTEN.md`

**Interfaces:**
- Produces: `build.marke.zeichen(kante: int) -> PIL.Image.Image` (RGBA, quadratisch);
  `build.marke.schrift(datei: str, groesse: int, variante: str | None) -> ImageFont.FreeTypeFont`;
  `build.test_bilder.png_masse(pfad: Path) -> tuple[int, int]` und `bmp_masse(pfad: Path) -> tuple[int, int, int]`.
- Consumes: nichts.

- [ ] **Schritt 1: Die Schriften einmalig aus woff2 umwandeln**

PIL kann `.woff2` nicht laden — genau deshalb rendert `hintergrund.py` heute in Segoe UI. Umgewandelt wird aus den **vorhandenen** Dateien statt neu geladen, damit Render- und Weboberfläche dieselbe Schriftfassung benutzen.

```bash
.venv/Scripts/python.exe -m pip install fonttools brotli
mkdir -p build/fonts
.venv/Scripts/python.exe -c "
from fontTools.ttLib import TTFont
for quelle, ziel in (('space-grotesk', 'SpaceGrotesk'), ('dm-sans', 'DMSans')):
    f = TTFont(f'webtool/frontend/public/fonts/{quelle}.woff2')
    f.flavor = None                      # woff2 -> blankes TTF
    f.save(f'build/fonts/{ziel}.ttf')
    print(ziel, 'geschrieben')
"
```

- [ ] **Schritt 2: Die Namen der Schriftschnitte ausgeben lassen**

Beide sind **variable** Schriften. Welche Schnitte sie führen, wird abgefragt und nicht geraten — `set_variation_by_name` wirft bei einem falschen Namen.

```bash
.venv/Scripts/python.exe -c "
from PIL import ImageFont
for d in ('SpaceGrotesk', 'DMSans'):
    f = ImageFont.truetype(f'build/fonts/{d}.ttf', 40)
    print(d, [n.decode() if isinstance(n, bytes) else n for n in f.get_variation_names()])
"
```

Die Ausgabe notieren. In Schritt 5 wird für Überschriften ein halbfetter Schnitt gebraucht (meist `SemiBold`, sonst `Bold`), für Fliesstext `Regular`.

- [ ] **Schritt 3: Den fehlschlagenden Test schreiben**

Create `build/test_bilder.py`:

```python
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
```

- [ ] **Schritt 4: Test laufen lassen, Fehlschlag bestätigen**

Run: `.venv/Scripts/python.exe -m pytest build/test_bilder.py -v`
Expected: `test_schriften_sind_echte_ttf` PASST (Schritt 1 hat sie erzeugt), die beiden Bild-Tests FALLEN DURCH mit `FileNotFoundError`.

- [ ] **Schritt 5: `build/marke.py` schreiben**

Create `build/marke.py`:

```python
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

# Die Schnittnamen stammen aus `get_variation_names()` (siehe Plan, Task 1 Schritt 2).
# Falls eine Schrift kein "SemiBold" fuehrt, hier auf "Bold" stellen.
HALBFETT = "SemiBold"
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
```

- [ ] **Schritt 6: Rendern**

Run: `.venv/Scripts/python.exe build/marke.py`
Expected: `geschrieben: build/icon.png (1024), electron/marke.png (128)`

- [ ] **Schritt 7: Test laufen lassen, Erfolg bestätigen**

Run: `.venv/Scripts/python.exe -m pytest build/test_bilder.py -v`
Expected: 3 passed

- [ ] **Schritt 8: Das Ergebnis ansehen**

Die Datei `build/icon.png` öffnen und prüfen: Ist die Fahne der Sprechblase unten **links** und ohne Naht am Rechteck? Sind die Balken klar getrennt? Ist der Rand des Quadrats glatt (keine Treppen)?

Bei Treppen `UEBER` auf 6 erhöhen und Schritt 6–7 wiederholen.

- [ ] **Schritt 9: `LICENSE-SCHRIFTEN.md` anlegen**

Die drei woff2 werden über `webtool/static/fonts` **bereits heute** mit der App ausgeliefert; SIL OFL verlangt, dass die Lizenz jede Kopie begleitet. Diese Datei schliesst die Lücke und deckt zugleich die neue Kopie in `electron/fonts/` ab. Muster ist `LICENSE-MODELLE.md`.

```markdown
# Schriften

Transkribor liefert drei Schriften mit. Alle stehen unter der
**SIL Open Font License 1.1** (<https://openfontlicense.org/>), die Weitergabe
ausdruecklich erlaubt, solange dieser Hinweis mitreist.

| Schrift | Urheber | Bezug |
|---|---|---|
| Space Grotesk | Florian Karsten | <https://github.com/floriankarsten/space-grotesk> |
| DM Sans | Colophon Foundry, Jonny Pinhorn, Indian Type Foundry | <https://github.com/googlefonts/dm-fonts> |
| JetBrains Mono | JetBrains s.r.o. | <https://github.com/JetBrains/JetBrainsMono> |

Der vollstaendige Lizenztext liegt jedem der oben verlinkten Projekte bei.
Die Dateien im Repo (`webtool/frontend/public/fonts`, `electron/fonts`,
`build/fonts`) sind unveraendert bzw. nur im Format umgewandelt (woff2 -> ttf).
```

- [ ] **Schritt 10: Committen**

```bash
git add build/marke.py build/test_bilder.py build/fonts build/icon.png electron/marke.png LICENSE-SCHRIFTEN.md
git commit -m "feat(marke): eigenes Zeichen und App-Icon statt des Electron-Logos"
```

---

### Task 2: Die beiden NSIS-Bilder

**Files:**
- Modify: `build/marke.py` (Funktionen `sidebar()`, `header()` + `__main__`)
- Modify: `build/test_bilder.py`
- Create: `build/installerSidebar.bmp`, `build/installerHeader.bmp`

**Interfaces:**
- Consumes: `zeichen(kante)`, `schrift(datei, groesse, variante)` aus Task 1.
- Produces: zwei BMP-Dateien; keine neuen Funktionen für spätere Tasks.

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

An `build/test_bilder.py` anhängen:

```python
def test_installer_sidebar_ist_164x314_und_24bit():
    # NSIS/MUI2 gibt beide Masse fest vor. 24 bit ist Pflicht: eine 32-bit-BMP
    # wird angenommen und dann falsch gezeichnet.
    assert bmp_masse(BUILD / "installerSidebar.bmp") == (164, 314, 24)


def test_installer_header_ist_150x57_und_24bit():
    assert bmp_masse(BUILD / "installerHeader.bmp") == (150, 57, 24)
```

- [ ] **Schritt 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `.venv/Scripts/python.exe -m pytest build/test_bilder.py -v`
Expected: die zwei neuen Tests FALLEN DURCH mit `FileNotFoundError`.

- [ ] **Schritt 3: Die beiden Renderer schreiben**

In `build/marke.py` vor dem `if __name__` einfügen:

```python
def sidebar():
    """164x314 — steht auf der Willkommens- und der Abschlussseite des Assistenten."""
    b, h, u = 164, 314, UEBER
    bild = Image.new("RGBA", (b * u, h * u), INDIGO)
    d = ImageDraw.Draw(bild)

    z = zeichen(46 * u)
    bild.paste(z, (18 * u, 24 * u), z)

    f_titel = schrift("SpaceGrotesk.ttf", 19 * u, HALBFETT)
    f_text = schrift("DMSans.ttf", 10 * u)
    d.text((18 * u, 82 * u), "Transkribor", font=f_titel, fill=WEISS)
    for i, zeile in enumerate(("Interviews transkribieren —", "lokal auf deinem Rechner")):
        d.text((18 * u, (108 + i * 15) * u), zeile, font=f_text, fill=(255, 255, 255, 200))

    # Angedeutete Tonspur als Textur am Fuss. Halbdurchsichtig, deshalb ueber
    # alpha_composite statt direkt gezeichnet.
    schleier = Image.new("RGBA", bild.size, (0, 0, 0, 0))
    ds = ImageDraw.Draw(schleier)
    for i, hoch in enumerate((9, 18, 26, 14, 21, 8, 16, 24, 11, 19, 27, 13)):
        x = (18 + i * 10) * u
        ds.rounded_rectangle([x, (278 - hoch) * u, x + 4 * u, 278 * u],
                             radius=2 * u, fill=(255, 255, 255, 90))
    bild = Image.alpha_composite(bild, schleier)

    return bild.resize((b, h), Image.LANCZOS).convert("RGB")


def header():
    """150x57 — die Kopfzeile der inneren Seiten. Heller Grund, damit der
    Streifen nicht als Fremdkoerper ueber dem weissen Dialog schwebt."""
    b, h, u = 150, 57, UEBER
    bild = Image.new("RGBA", (b * u, h * u), "#FFFFFF")
    d = ImageDraw.Draw(bild)

    z = zeichen(30 * u)
    bild.paste(z, (12 * u, 13 * u), z)
    d.text((50 * u, 19 * u), "Transkribor",
           font=schrift("SpaceGrotesk.ttf", 14 * u, HALBFETT), fill=INDIGO)

    return bild.resize((b, h), Image.LANCZOS).convert("RGB")
```

Und den `__main__`-Block ersetzen durch:

```python
if __name__ == "__main__":
    zeichen(1024).save(BUILD / "icon.png")
    zeichen(128).save(WURZEL / "electron" / "marke.png")
    sidebar().save(BUILD / "installerSidebar.bmp", "BMP")
    header().save(BUILD / "installerHeader.bmp", "BMP")
    print("geschrieben: icon.png, electron/marke.png, installerSidebar.bmp, installerHeader.bmp")
```

- [ ] **Schritt 4: Rendern und Tests laufen lassen**

Run: `.venv/Scripts/python.exe build/marke.py && .venv/Scripts/python.exe -m pytest build/test_bilder.py -v`
Expected: 5 passed

- [ ] **Schritt 5: Die beiden BMP ansehen**

`build/installerSidebar.bmp` öffnen. Prüfen: Läuft der Untertitel über den rechten Rand? Der Streifen ist nur 164 px breit — das ist die häufigste Panne. Wenn ja, Schriftgrösse auf `9 * u` oder den Text kürzen.

- [ ] **Schritt 6: Committen**

```bash
git add build/marke.py build/test_bilder.py build/installerSidebar.bmp build/installerHeader.bmp
git commit -m "feat(marke): Sidebar und Kopfzeile fuer den Windows-Assistenten"
```

---

### Task 3: Das DMG-Fenster ins Designsystem holen

**Files:**
- Modify: `build/marke.py` (Funktion `dmg_hintergrund()` — der Inhalt von `hintergrund.py`)
- Delete: `build/hintergrund.py`
- Modify: `build/background.png`, `build/background@2x.png` (neu gerendert)
- Modify: `build/test_bilder.py`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `schrift(...)` aus Task 1.
- Produces: nichts für spätere Tasks.

**Wichtig:** Das Zeichen wird hier **nicht** gezeichnet. Die beiden Symbole im DMG-Fenster setzt der Finder aus `dmg.contents` in `package.json`; der Hintergrund liefert nur Text, Pfeil und Hinweiskarte. Der bestehende Kommentar in `hintergrund.py` sagt das bereits — er wandert mit.

- [ ] **Schritt 1: Den Test schreiben, der die Masse festhält**

An `build/test_bilder.py` anhängen:

```python
def test_dmg_hintergrund_passt_zum_fenster():
    # Muss zu dmg.window in package.json passen (540x380), sonst kachelt der Finder.
    assert png_masse(BUILD / "background.png") == (540, 380)
    assert png_masse(BUILD / "background@2x.png") == (1080, 760)
```

- [ ] **Schritt 2: Test laufen lassen**

Run: `.venv/Scripts/python.exe -m pytest build/test_bilder.py::test_dmg_hintergrund_passt_zum_fenster -v`
Expected: PASS — die alten Dateien haben bereits die richtigen Masse. Der Test hält den Vertrag fest, bevor die Datei neu gerendert wird.

- [ ] **Schritt 3: `hintergrund.py` nach `marke.py` übernehmen**

Den kompletten Inhalt von `build/hintergrund.py` als Funktion `dmg_hintergrund()` nach `build/marke.py` übernehmen — samt seiner Modulkonstanten `BREITE`, `HOEHE`, `S`, `KARTE_X0/X1`, `KARTE_INNEN` und `SYMBOL_*`.

**`S = 2` bleibt neben `UEBER = 4` bestehen, und das ist Absicht:** `S` ist der Retina-Faktor des DMG (gerendert wird 2×, gespeichert werden **beide** Grössen), `UEBER` ist der Renderfaktor gegen die fehlende Kantenglättung (gerendert wird 4×, gespeichert wird **nur** die kleine). Zwei verschiedene Zwecke, deshalb zwei Zahlen.

Dabei genau drei Änderungen:

1. Die Schriftpfade `C:/Windows/Fonts/seguisb.ttf` / `segoeui.ttf` fallen weg; stattdessen die gemeinsame Funktion:
   ```python
   f_titel = schrift("SpaceGrotesk.ttf", 26 * S, HALBFETT)
   f_unter = schrift("DMSans.ttf", 13 * S)
   f_kopf  = schrift("SpaceGrotesk.ttf", 14 * S, HALBFETT)
   f_text  = schrift("DMSans.ttf", 13 * S)
   ```
   Damit läuft das Skript nicht mehr nur auf Windows.
2. `AKZENT = "#c2410c"` wird zu `AKZENT = INDIGO`. Der bisherige Kommentar („gedecktes Orange: Aufmerksamkeit, kein Alarm") wird ersetzt durch:
   ```python
   # Indigo statt des frueheren gedeckten Orange: Bernstein und Rot markieren im Editor
   # unsichere Woerter und bleiben dafuer frei. Die Gatekeeper-Meldung ist ausserdem ein
   # Hinweis, kein Fehler.
   ```
3. Die Farben `GRUND`/`TITEL`/`GRAU` werden auf die Tokens des Designsystems gezogen:
   ```python
   GRUND = "#FAFAFA"     # war #f5f5f7 (Apple-Grau)
   TITEL = "#18181B"     # war #1d1d1f
   GRAU  = "#52525B"     # war #6e6e73 — 7,4:1 auf #FAFAFA, nicht blasser setzen
   TEXT  = "#3F3F46"
   ```

Der Abbruch bei überlaufender Textzeile (`assert b <= platz`) bleibt **unverändert** stehen — er ist der Grund, warum eine zu lange Zeile hier scheitert und nicht erst im DMG.

Anschliessend `build/hintergrund.py` löschen und den `__main__`-Block ergänzen:

```python
    gross = dmg_hintergrund()
    gross.save(BUILD / "background@2x.png")
    gross.resize((BREITE, HOEHE), Image.LANCZOS).save(BUILD / "background.png")
```

- [ ] **Schritt 4: Rendern und Tests laufen lassen**

Run: `.venv/Scripts/python.exe build/marke.py && .venv/Scripts/python.exe -m pytest build/test_bilder.py -v`
Expected: 6 passed. Schlägt der Renderer mit `AssertionError: Zeile zu breit` fehl, ist Space Grotesk breiter als Segoe UI — dann `f_kopf` auf `13 * S` stellen.

- [ ] **Schritt 5: `build/background.png` ansehen**

Prüfen: Steht der Titel in Space Grotesk (auffällige, geometrische Formen)? Ist der Streifen an der Hinweiskarte indigo? Läuft keine Zeile aus der Karte?

- [ ] **Schritt 6: CLAUDE.md nachziehen**

Im Abschnitt zur Desktop-App den Absatz über `build/hintergrund.py` ersetzen. Alter Text nennt „`build/hintergrund.py` (PIL, Segoe UI)"; neu:

```markdown
- **DMG-Hintergrund erklärt die Gatekeeper-Warnung, bevor sie kommt.** Ankündigen kann die App
  sie nicht — vor dem erlaubten Start läuft kein Code von uns, das DMG-Fenster ist die einzige
  Fläche davor. `build/marke.py` rendert ihn (PIL, Brand-Schriften aus `build/fonts`) zusammen
  mit dem App-Icon und den beiden NSIS-Bildern; die **Ausgaben sind committet**, weil die
  CI-Runner weder PIL noch die Schriften haben. Die Symbolpositionen stehen doppelt —
  `dmg.contents` in `package.json` und `SYMBOL_*` im Skript (nur für den Pfeil) — die muss man
  **zusammen** ändern. Das Skript bricht ab, wenn eine Textzeile aus der Hinweiskarte läuft.
  Geprüft wird nicht der Renderer, sondern die fertige Datei: `build/test_bilder.py` liest die
  Kopfdaten mit `struct` und kommt **ohne PIL** aus — sonst liefe der Test im CI-Python-Job nicht,
  der bewusst ohne schwere Abhängigkeiten fährt.
```

- [ ] **Schritt 7: Committen**

```bash
git add build/marke.py build/test_bilder.py build/background.png build/background@2x.png CLAUDE.md
git rm build/hintergrund.py
git commit -m "feat(marke): DMG-Hintergrund in Brand-Schriften, hintergrund.py geht in marke.py auf"
```

---

### Task 4: Das Ersteinrichtungs-Fenster

**Files:**
- Create: `electron/fonts/space-grotesk.woff2`, `electron/fonts/dm-sans.woff2`
- Modify: `electron/setup.html`
- Modify: `electron/konfig.test.js`

**Interfaces:**
- Consumes: `electron/marke.png` aus Task 1.
- Produces: nichts für spätere Tasks.

- [ ] **Schritt 1: Die Schriften kopieren**

```bash
mkdir -p electron/fonts
cp webtool/frontend/public/fonts/space-grotesk.woff2 electron/fonts/
cp webtool/frontend/public/fonts/dm-sans.woff2 electron/fonts/
```

Eine echte Kopie, kein `{from,to}`-Mapping in `build.files`: das Mapping greift **nur im gepackten Lauf**, in der Entwicklung fiele `setup.html` still auf `system-ui` zurück und der Entwickler sähe etwas anderes als der Nutzer. `electron/**/*` steht bereits in `build.files`, die Dateien reisen also ohne weiteren Eintrag mit.

- [ ] **Schritt 2: Den fehlschlagenden Test schreiben**

`electron/konfig.test.js` lädt heute nur `node:test`, `node:assert` und `ajv`. Die beiden fehlenden Module deshalb **oben ergänzen**:

```javascript
const fs = require('node:fs')
const path = require('node:path')
```

Dann den Test anhängen:

```javascript
test('setup.html findet Zeichen und Schriften neben sich', () => {
  // Das Einrichtungsfenster laedt per file:// aus electron/. Fehlt eine dieser
  // Dateien, faellt es still auf system-ui bzw. ein leeres Bild zurueck — im
  // gepackten Lauf sieht das niemand mehr.
  const html = fs.readFileSync(path.join(__dirname, 'setup.html'), 'utf8')
  for (const datei of ['marke.png', 'fonts/space-grotesk.woff2', 'fonts/dm-sans.woff2']) {
    assert.ok(html.includes(datei), `setup.html verweist nicht auf ${datei}`)
    assert.ok(fs.existsSync(path.join(__dirname, datei)), `${datei} fehlt in electron/`)
  }
})
```

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm run test:electron`
Expected: FAIL — `setup.html verweist nicht auf marke.png`

- [ ] **Schritt 4: `electron/setup.html` umstellen**

Im `<style>`-Block **vor** `:root` einfügen:

```css
@font-face { font-family:"Space Grotesk"; src:url("fonts/space-grotesk.woff2") format("woff2");
             font-weight:400 700; font-display:swap; }
@font-face { font-family:"DM Sans"; src:url("fonts/dm-sans.woff2") format("woff2");
             font-weight:400 700; font-display:swap; }
```

`:root` ersetzen (heute: `color-scheme: dark` und ein Satz dunkler Werte):

```css
  :root { color-scheme: light dark;
          --bg:#FAFAFA; --fg:#18181B; --dim:#52525B; --line:#E4E4E7; --akzent:#4F46E5;
          --akzent-fg:#FFFFFF; --karte:#FFFFFF; --log-bg:#F4F4F5; --fehler-rand:#FCA5A5;
          --fehler-bg:#FEF2F2; --fehler-fg:#B91C1C; --ok:#16A34A; --fehlt:#CA8A04; }
  @media (prefers-color-scheme: dark) {
    /* #4F46E5 erreicht auf #0B0B0F keine 3:1 — der dunkle Akzent MUSS aufgehellt sein. */
    :root { --bg:#0B0B0F; --fg:#FAFAFA; --dim:#A1A1AA; --line:#26262B; --akzent:#818CF8;
            --akzent-fg:#0B0B0F; --karte:#141419; --log-bg:#08080A; --fehler-rand:#7A3B3B;
            --fehler-bg:#1D1113; --fehler-fg:#FFB4B4; --ok:#66D19E; --fehlt:#E0B341; }
  }
```

Die bisher fest verdrahteten Farben durch die Variablen ersetzen: `.ok { color:var(--ok) }`, `.fehlt { color:var(--fehlt) }`, `#log { background:var(--log-bg) }`, `#befehl { background:var(--log-bg); color:var(--fg) }`, `#fehler { border-color:var(--fehler-rand); background:var(--fehler-bg); color:var(--fehler-fg) }`.

`body` und `h1`:

```css
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.55 "DM Sans", ui-sans-serif, system-ui, sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh; padding:32px; }
  h1 { margin:0 0 4px; font-size:22px; font-weight:600;
       font-family:"Space Grotesk", ui-sans-serif, system-ui, sans-serif; letter-spacing:-.01em; }
```

Im `<body>` vor die `<h1>` das Zeichen setzen:

```html
  <img src="marke.png" width="38" height="38" alt="">
```

- [ ] **Schritt 5: Tests laufen lassen**

Run: `npm run test:electron`
Expected: PASS

- [ ] **Schritt 6: Beide Modi im Browser ansehen**

`electron/setup.html` direkt im Browser öffnen. Die Statusliste bleibt leer (`window.transkribor` fehlt dort) — Zeichen, Schriften, Farben und der Knopf sind trotzdem sichtbar. In den Entwicklerwerkzeugen unter *Rendering → Emulate CSS prefers-color-scheme* zwischen hell und dunkel schalten und beides prüfen.

- [ ] **Schritt 7: Committen und PR 1 stellen**

```bash
git add electron/setup.html electron/fonts electron/konfig.test.js
git commit -m "feat(einrichtung): Zeichen, Brand-Schriften und Hellmodus im Ersteinrichtungs-Fenster"
git push -u origin HEAD
gh pr create --base master --title "Zeichen, App-Icon und Ersteinrichtung im Brand-Design" \
  --body "Setzt docs/superpowers/specs/2026-08-10-transkribor-installer-brand-design.md um, Teil 1 von 2."
```

---

### Task 5: Die Willkommensseite des Windows-Assistenten

**Files:**
- Create: `build/installer.nsh`
- Modify: `package.json` (`build.nsis`)
- Modify: `electron/konfig.test.js`

**Interfaces:**
- Consumes: `build/installerSidebar.bmp`, `build/installerHeader.bmp` aus Task 2.
- Produces: nichts.

- [ ] **Schritt 1: Neuen Branch**

```bash
git checkout master && git pull --ff-only
git checkout -b feat/nsis-willkommensseite
```

- [ ] **Schritt 2: Den fehlschlagenden Test schreiben**

An `electron/konfig.test.js` anhängen (`fs` und `path` sind seit Task 4 oben eingebunden — falls Task 4 nicht gelaufen ist, hier nachholen):

```javascript
test('nsis verweist auf vorhandene Bilder und das Skript', () => {
  // Ein falscher Pfad faellt sonst erst im Bau auf — und electron-builder
  // uebergeht ihn je nach Option still.
  const { build } = require('../package.json')
  for (const schluessel of ['installerSidebar', 'installerHeader', 'uninstallerSidebar']) {
    const p = build.nsis[schluessel]
    assert.ok(p, `build.nsis.${schluessel} fehlt`)
    assert.ok(fs.existsSync(path.join(__dirname, '..', p)), `${p} existiert nicht`)
  }
  // Standardpfad von electron-builder — kein include-Eintrag noetig, aber die Datei muss da sein.
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'build', 'installer.nsh')))
})
```

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm run test:electron`
Expected: FAIL — `build.nsis.installerSidebar fehlt`

- [ ] **Schritt 4: `package.json` ergänzen**

In `build.nsis` die drei Zeilen anfügen (die bestehenden Schlüssel bleiben):

```json
    "installerSidebar": "build/installerSidebar.bmp",
    "installerHeader": "build/installerHeader.bmp",
    "uninstallerSidebar": "build/installerSidebar.bmp"
```

`uninstallerSidebar` zeigt bewusst auf dieselbe Datei — ein eigenes Bild für den Deinstallationsvorgang wäre eine Datei mehr für eine Fläche, die niemand gestaltet sehen will.

- [ ] **Schritt 5: `build/installer.nsh` anlegen**

electron-builder findet die Datei an diesem Standardpfad selbst; ein `include`-Eintrag ist nicht nötig. **Die Datei muss als UTF-8 *mit* BOM gespeichert werden** — dazu Schritt 7.

```nsis
; MUI2 fuegt die Willkommensseite NICHT von selbst hinzu. Ohne sie erscheint der
; 164x314-Streifen nur auf der Abschlussseite, und die eigentliche Nachricht kaeme
; nie an: dass nach der Installation noch ein grosser Download folgt. Genau dort
; halten Leute die App fuer kaputt.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Willkommen bei Transkribor"
  !define MUI_WELCOMEPAGE_TEXT "Dieser Assistent installiert Transkribor auf deinem Rechner. \
Das dauert etwa eine Minute.$\r$\n$\r$\nDanach passiert noch etwas: Beim ersten Start lädt \
Transkribor die Spracherkennung herunter — mehrere Gigabyte, je nach Leitung 10 bis 30 Minuten. \
Das ist einmalig. Danach läuft alles offline auf deinem Rechner, ohne Konto und ohne Cloud."
  !insertmacro MUI_PAGE_WELCOME
!macroend
```

- [ ] **Schritt 6: Tests laufen lassen**

Run: `npm run test:electron`
Expected: PASS

- [ ] **Schritt 7: BOM sicherstellen**

NSIS liest `.nsh` im Unicode-Modus je nach BOM unterschiedlich; ohne BOM können „lädt", „läuft" und der Gedankenstrich als Mojibake ankommen. Das ist das Spiegelbild des PowerShell-Fundes im Repo (`.ps1` **ohne** BOM wird als CP1252 gelesen).

```bash
.venv/Scripts/python.exe -c "
from pathlib import Path
p = Path('build/installer.nsh')
roh = p.read_bytes()
if not roh.startswith(b'\xef\xbb\xbf'):
    p.write_bytes(b'\xef\xbb\xbf' + roh)
    print('BOM ergaenzt')
else:
    print('BOM war schon da')
"
```

- [ ] **Schritt 8: Committen**

```bash
git add build/installer.nsh package.json electron/konfig.test.js
git commit -m "feat(installer): Willkommensseite, die den grossen Erst-Download ankuendigt"
```

---

### Task 6: Den Installer bauen und nachsehen

**Files:** keine — dies ist die Prüfung, die der Spec unter „Offen" ausdrücklich verlangt.

**Interfaces:**
- Consumes: alles aus Task 1–5.

- [ ] **Schritt 1: Bauen**

Run: `npm run dist`
Expected: `dist/Transkribor-Setup-<version>.exe` entsteht. Dauer ~3–6 Minuten.

- [ ] **Schritt 2: Das Symbol der Setup-Datei prüfen**

`dist/` im Explorer öffnen, Ansicht auf grosse Symbole. Die `.exe` muss das Zeichen tragen, **nicht** das Electron-Logo. Tut sie es nicht, hat electron-builder `build/icon.png` nicht gefunden — dann `"win": { "icon": "build/icon.png" }` in `package.json` ergänzen und neu bauen.

- [ ] **Schritt 3: Installer starten und die Willkommensseite lesen**

Die `.exe` ausführen (SmartScreen: *Weitere Informationen* → *Trotzdem ausführen*). Auf der ersten Seite prüfen:

1. **Steht links der indigo Streifen mit Zeichen und Tonspur?** Wenn nicht, kam die BMP nicht an — Masse und Bittiefe gegen `build/test_bilder.py` prüfen.
2. **Sind die Umlaute richtig?** „lädt", „läuft", „—". Erscheint stattdessen `lÃ¤dt`, hat der BOM aus Task 5 Schritt 7 nicht gereicht: dann die Datei als UTF-16LE mit BOM speichern und neu bauen.
3. **Läuft der Text aus dem Feld?** MUI2 bricht nicht um, was nicht passt.

- [ ] **Schritt 4: Kopfzeile und Abschluss prüfen**

Auf *Weiter* klicken. Auf der Verzeichnisseite sitzt oben die 150×57-Kopfzeile. Prüfen, ob sie **links oder rechts** ausgerichtet erscheint — ist sie rechtsbündig, das Bild in `marke.py:header()` spiegeln (Zeichen nach rechts, Text nach links) und neu rendern.

- [ ] **Schritt 5: Installieren und das Ersteinrichtungs-Fenster ansehen**

Installation abschliessen, App starten. Das Fenster aus Task 4 muss im Systemmodus (hell oder dunkel) erscheinen, mit Zeichen im Kopf und Space Grotesk in der Überschrift. Danach in den Windows-Einstellungen den Modus umschalten und das Fenster erneut öffnen.

- [ ] **Schritt 6: Taskleiste und Startmenü prüfen**

Bei laufender App: trägt das Symbol in der Taskleiste das Zeichen? Ist es dort noch als Sprechblase erkennbar (16 px)? Ebenso im Startmenü.

- [ ] **Schritt 7: Wieder deinstallieren**

Über *Einstellungen → Apps*. Der Deinstallationsvorgang muss ohne Fehler durchlaufen; der Streifen darf dort erscheinen, muss aber nicht geprüft werden.

- [ ] **Schritt 8: PR 2 stellen**

```bash
git push -u origin HEAD
gh pr create --base master --title "Windows-Assistent im Brand-Design mit Willkommensseite" \
  --body "Setzt docs/superpowers/specs/2026-08-10-transkribor-installer-brand-design.md um, Teil 2 von 2.

Am gebauten Installer geprüft: Symbol der Setup-Datei, Streifen auf der Willkommensseite,
Umlaute im Willkommenstext, Kopfzeile, Ersteinrichtungs-Fenster in hell und dunkel,
Symbol in Taskleiste und Startmenü."
```

- [ ] **Schritt 9: macOS und Linux offen lassen**

Das DMG-Fenster kann hier niemand anschauen. In PR 2 vermerken, dass der Blick darauf an **Issue #36** hängt (Plattformprüfung macOS/Linux aus dem gebauten Paket) — die neuen Bilddateien geben dieser Prüfung einen weiteren Punkt.
