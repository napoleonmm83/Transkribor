# Einstellungs-Endpunkte validieren sprache/korrektur (#139)

**Stand:** 2026-08-12, master `4410cf6`. Issue #139 (abgeleitet aus dem #135-Review).

## Problem

Die beiden Einstellungs-Endpunkte nehmen jeden String für `sprache`/`korrektur` an und schreiben
ihn ungeprüft nach `projekt.json`:

- `PUT /api/projects/{project}/einstellungen` — `projekteinstellungen_speichern` (`webtool/app.py`)
- `PUT /api/projects/{project}/files/{base}/einstellungen` — `dateieinstellungen_speichern` (`webtool/app.py`, #135)

Ein Tippfehler (`{"sprache": "enm"}`) oder ein beliebiger String landet still in der Datei und
scheitert erst **später und woanders** — bei der Sprache am Whisper-Start (`--language enm`), bei
der Tiefe an der Korrektur-Tiefen-Verzweigung. Der Endpunkt antwortet `200 OK` auf einen Wert, der
nie funktionieren kann; der Nutzer sieht den Validierungsfehler nicht am Endpunkt, sondern Minuten
später als kryptischen Job-Fehler. Beide Endpunkte tragen denselben Fehler (der Datei-Endpunkt hat
ihn vom Projekt-Endpunkt gespiegelt).

## Lösung

**Ein gemeinsamer Validator in `webtool/sprachen.py`** (die EINE Quelle für Sprach-/Tiefenwerte),
aufgerufen von **beiden** PUT-Handlern vor dem Schreiben. Liefert eine Fehlermeldung mit Feldname
oder `None` (gültig):

- `sprache` (wenn nicht `None`) muss in `SPRACHEN`-Keys sein (`ch/de/en/fr/it/auto`).
- `korrektur` (wenn nicht `None`) muss `TIEFE_DEFAULT` (`"auto"`) sein **oder** in den `TIEFEN`-IDs
  (`voll_dialekt/voll/leicht/zusammenfassung`). `"auto"` bleibt erlaubt — es ist der Default und
  ein legitimer gespeicherter Wert.
- `None`-Werte bleiben erlaubt (Partial-Update: ein leeres Body oder nur ein Feld ändert nichts).
- Bestehende `projekt.json`-Einträge werden **nicht** nachträglich validiert — nur der Schreibpfad
  wird geschärft. Keine Migration.

**Status-Code: `400`** (nicht 422). Begründung: konsistent mit dem bestehenden `_validate` in genau
diesen Endpunkten (ungültiger Name → 400) und dem Codebase-weiten Stil; das Issue sagt 400.
CodeRabbit schlug 422 vor (FastAPI/pydantic-Konvention für „wohlgeformt, aber kein erlaubter Wert")
— bewusst abgelehnt zugunsten der Konsistenz mit `_validate`. `detail` nennt das fehlerhafte Feld,
damit der Nutzer es korrigieren kann (Frontend Toast via `api.ts`-Fehlerpfad).

## Architektur

### `webtool/sprachen.py` (eine neue Funktion)

```python
def pruef_fehler(sprache: str | None = None, korrektur: str | None = None) -> str | None:
    """Liefert eine Fehlermeldung, wenn sprache/korrektur kein bekannter Wert ist, sonst None.

    None-Argumente (nicht gesendete Felder) sind erlaubt — PUT ist ein Partial-Update.
    Eine Quelle der Wahrheit, konsumiert von beiden Einstellungs-Endpunkten."""
    if sprache is not None and sprache not in SPRACHEN:
        return f"unbekannte Sprache: {sprache!r} (erlaubt: {', '.join(SPRACHEN)})"
    gueltige_tiefen = {TIEFE_DEFAULT} | {t["id"] for t in TIEFEN}
    if korrektur is not None and korrektur not in gueltige_tiefen:
        return f"unbekannte Korrektur-Tiefe: {korrektur!r} (erlaubt: {', '.join(sorted(gueltige_tiefen))})"
    return None
```

### `webtool/app.py` (zwei identische Guards)

In **beiden** PUT-Handlern (`projekteinstellungen_speichern` und `dateieinstellungen_speichern`),
vor `speichern`/`setze_datei`:

```python
fehler = _sprachen.pruef_fehler(sprache=body.sprache, korrektur=body.korrektur)
if fehler:
    raise HTTPException(status_code=400, detail=fehler)
```

Reihenfolge im Handler: nach `_validate(project[, base])` (Namen-Validierung), vor dem Schreiben.
So gilt 400 für ungültige Namen wie für ungültige Werte, aus derselben Familie.

## Randfälle / bewusste Entscheidungen

- **`"auto"` ist gültig:** `TIEFE_DEFAULT`, vom System gesetzt und ein legitimer Wert. Würde der
  Validator `"auto"` ablehnen, grille er bestehende Aufrufer, die den Default explizit speichern.
  (Dass der Dialog `"auto"` nicht zur Auswahl stellt — Issue #141 — ist ein separates UI-Problem.)
- **GET validiert nicht:** GET liest nur, ein ungültiger gespeicherter Wert (vor diesem Fix
  entstanden) wird weiterhin gelesen. Das ist gewollt — der Schreibpfad wird geschärft, die Daten
  nicht nachträglich berichtigt.
- **Keine Migration:** vor diesem Fix geschriebene ungültige Werte bleiben in `projekt.json` und
  scheitern weiterhin zur Laufzeit. Das ist die dokumentierte Folge von „nur Schreibpfad schärfen";
  ein Aufräum-Schritt wäre eine separate, datenverändernde Aktion.
- **`projekt.json`-Race (#134)** unberührt — der Validator prüft vor dem Schreiben, ändert nichts
  an der Read-Modify-Write-Struktur.

## Testabdeckung

- **`webtool/test_sprachen.py`** (Unit): `pruef_fehler` — gültige Werte → `None`; unbekannte Sprache
  → Meldung; unbekannte Tiefe → Meldung; `"auto"` → `None`; `None`-Argumente → `None`; Meldung
  nennt den Wert.
- **`webtool/test_api.py`**: jeder PUT-Endpunkt lehnt unbekannte `sprache` **und** unbekannte
  `korrektur` mit **400** ab (4 Tests: 2 Endpunkte × 2 Felder); gültige Werte bleiben 200 (die
  bestehenden Speichern-Tests decken das schon).

## Doku

- **CLAUDE.md:** Ein-Satz-Fakt am Einstellungs-Abschnitt (Validierung gegen `SPRACHEN`/`TIEFEN` in
  beiden Endpunkten via `sprachen.pruef_fehler`; 400). **Lokal-only** per #110, nicht committet.
- **README:** nicht betroffen (für den Nutzer ändert sich nur, dass ein falscher Wert jetzt sofort
  statt später scheitert — keine neue Funktion).

## Nicht darin (YAGNI)

- Keine Aufräum-Migration bestehender ungültiger Werte.
- Keine Änderung am GET oder den Frontend-Auswahlen.
- Kein 422 (bewusst 400, s.o.).
- Keine Lösung für #141 (`"auto"` im Dialog anzeigen) — separater Scope.
