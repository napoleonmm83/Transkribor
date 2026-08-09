"""Kodierung der mitgelieferten PowerShell-Skripte.

Windows PowerShell 5.1 (`powershell.exe`, immer noch die Vorgabe) liest eine .ps1 ohne
BOM als ANSI/CP1252. Ein UTF-8-Gedankenstrich (E2 80 94) zerfaellt dabei zu `â€"` — und
dessen letztes Zeichen ist U+201D, ein typografisches Anfuehrungszeichen, das der Parser
als String-Anfang nimmt. Die Datei stirbt dann mit "Zeichenfolge hat kein Abschlusszeichen"
an einer Zeile weit hinter der eigentlichen Ursache. PowerShell 7 liest UTF-8 und merkt
nichts davon — der Fehler trifft also nur den, der die alte Shell benutzt.
"""

import pathlib

WURZEL = pathlib.Path(__file__).resolve().parent.parent


def test_ps1_mit_umlauten_haben_bom():
    ohne = []
    for p in WURZEL.glob("*.ps1"):
        roh = p.read_bytes()
        hat_bom = roh.startswith(b"\xef\xbb\xbf")
        if not hat_bom and any(b > 127 for b in roh):
            ohne.append(p.name)
    assert not ohne, (
        f"UTF-8 ohne BOM und mit Nicht-ASCII: {ohne} — PowerShell 5.1 liest das als CP1252 "
        "und bricht mit einem Parser-Fehler ab. Datei mit BOM speichern."
    )
