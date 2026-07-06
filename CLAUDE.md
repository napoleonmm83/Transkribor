# Transkribor — Anleitung für Claude

Dieses Repo transkribiert Interview-Audio (oft **Schweizerdeutsch**) mit Whisper und
erzeugt daraus kontextkorrigierte, **sprecher-markierte** Transkripte.

## Ablauf, wenn der Nutzer „transkribiere Projekt <NAME>" sagt

(bzw. wenn neue Audiodateien in `projekte\<NAME>\audio\` liegen)

### Schritt 1 — Transkription (Whisper large-v3, GPU)
Läuft eigenständig, kann je nach Audiolänge dauern → am besten im Hintergrund:

```
E:\Git\Transkribor\.venv\Scripts\python.exe E:\Git\Transkribor\transcribe.py "<NAME>"
```

Erzeugt pro Audiodatei in `projekte\<NAME>\transkripte\`:
`<base>.json` (Vollausgabe), `<base>.raw.txt` (Fliesstext), `<base>.segments.txt` (mit Zeitstempeln).
Bereits vorhandene werden übersprungen.

### Schritt 2 — Kontext-Korrektur + Sprecher-Labeling (braucht Claude)
Bevorzugt als paralleler Workflow (ein geteiltes Glossar über alle Dateien → pro Datei
Korrektur → Verifikation gegen das Rohtranskript):

1. Sammle die Basisnamen: alle `*.segments.txt` in `projekte\<NAME>\transkripte\` (Dateiname ohne Endung).
2. Lies `projekte\<NAME>\kontext.md` falls vorhanden → `context`.
3. **Vor-Taggen** (unsichere Wörter für den LLM markieren):
   ```
   E:\Git\Transkribor\.venv\Scripts\python.exe -m webtool.correct prep "<NAME>"
   ```
   (erzeugt `<base>.tagged.txt` je Datei)
4. **Korrektur-Workflow** (segment-genaue Korrektur + Sprecher):
   ```
   Workflow({ scriptPath: "E:\\Git\\Transkribor\\tools\\correct_label.mjs",
              args: { dir: "E:\\Git\\Transkribor\\projekte\\<NAME>\\transkripte",
                      bases: [ ...basenames... ],
                      context: "<Inhalt von kontext.md oder kurze Beschreibung>" } })
   ```
   Der Workflow liefert `{ glossary, corrections: [{ base, context, speakers, segments, annotations, summary }] }`.
   (Ist die Workflow-Funktion nicht verfügbar, führe die Korrektur **inline** aus — dieselben Regeln, siehe unten — und erzeuge dieselbe Korrektur-Struktur pro Datei.)
5. **Assemblieren**: pro Datei die zurückgegebene Korrektur nach `projekte\<NAME>\transkripte\<base>.correction.json` schreiben, dann:
   ```
   E:\Git\Transkribor\.venv\Scripts\python.exe -m webtool.correct apply "<NAME>" "<base>"
   ```
   (baut `<base>.edit.json` + `<base>.md`; überschreibt `edit.json` mit `human_edited=true` nicht — dafür `--force`).

Ergebnis: `projekte\<NAME>\transkripte\<base>.edit.json` (Editor-Dokument, im Web-Tool bearbeitbar) + `<base>.md` (Export).

## Korrektur-Regeln (gelten für Workflow UND inline)
- **Treu bleiben:** klare ASR-Fehler korrigieren (falsch gehörte Wörter, Eigennamen, im
  Kontext sinnlose Begriffe), zu lesbarem Standarddeutsch normalisieren (Schweizer „ss").
  **Nichts erfinden, Sinn nicht verändern, nicht über das Nötige hinaus glätten.**
- **Kontext nutzen:** Ein gemeinsames Glossar über alle Dateien sorgt für konsistente
  Schreibweisen von Namen/Orten/Begriffen.
- **Sprecher markieren:** meist zwei — **Interviewer** (stellt Fragen) und die befragte
  Person (mit Namen/Betrieb labeln, falls im Gespräch genannt, sonst „Befragte Person").
  Aufeinanderfolgende Segmente pro Sprecher zu Redebeiträgen bündeln.
- **Unsicheres offenlegen:** wirklich unklare Stellen nicht raten, sondern unter
  „## Anmerkungen" am Dateiende vermerken.

## Neues Projekt anlegen
`projekte\<NAME>\audio\` erstellen, Audio hineinlegen, optional `projekte\<NAME>\kontext.md`
mit Projektbeschreibung + bekannten Namen (verbessert Whisper und die Korrektur).

## Umgebung (Fakten)
- venv: `.venv` (Python 3.13, torch cu128 + openai-whisper) — GPU: RTX 5080 / Blackwell (sm_120).
- ffmpeg: wird von `transcribe.py` automatisch gefunden (winget Gyan.FFmpeg) oder muss auf PATH sein.
- Whisper-Modell-Cache: `%USERPROFILE%\.cache\whisper` (einmaliger Download ~3 GB).
- Env-Overrides: `WHISPER_MODEL` (default large-v3), `WHISPER_LANG` (default de).
- Web-Editor (Stufe 1): `.\webtool.ps1` → FastAPI (`webtool/app.py`) + `webtool/static/`.
  Kanonisches Editier-Dokument `<base>.edit.json` (aus Roh-`<base>.json`), Export `<base>.md`.
  Spec: `docs/superpowers/specs/2026-07-06-transkribor-webtool-design.md`.
- Stufe 2a (Browser-Transkription): `POST /audio` (Upload), `POST /transcribe` (startet `transcribe.py` via `webtool/jobs.py`-Job), `GET /api/jobs/{id}` (Polling). Job-Registry ist in-memory (threading+Popen) — kein `--reload` während Jobs.
