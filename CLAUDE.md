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

**Ein-Befehl-Variante (Stufe 2b):** `python -m webtool.correct run "<NAME>"` macht prep +
gemeinsames Glossar + pro Datei Korrektur + **Treue-Verifikation gegen Roh** + apply automatisch
per headless `claude -p` (oder im Web-Tool der ✎-Button). Der Treue-Pass läuft per Default
(abschaltbar per `--no-verify` bzw. Env `TRANSKRIBOR_VERIFY=0`). Für volle Kontrolle /
Parallelität der manuelle Workflow unten.

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
- Env-Overrides: `WHISPER_MODEL` (default large-v3), `WHISPER_LANG` (default de), `TRANSKRIBOR_VERIFY` (default 1; `0`/`false`/`no` schaltet den 2b-Treue-Pass server-weit ab).
- Web-Editor (Stufe 1): `.\webtool.ps1` → FastAPI (`webtool/app.py`) + `webtool/static/`.
  Kanonisches Editier-Dokument `<base>.edit.json` (aus Roh-`<base>.json`), Export `<base>.md`.
  Spec: `docs/superpowers/specs/2026-07-06-transkribor-webtool-design.md`.
- Stufe 2a (Browser-Transkription): `POST /audio` (Upload), `POST /transcribe` (startet `transcribe.py` via `webtool/jobs.py`-Job), `GET /api/jobs/{id}` (Polling), `POST /api/jobs/{id}/cancel` (bricht den Job samt Prozessbaum ab → Status `cancelled`; auf Windows via `taskkill /F /T`, weil `terminate()` den `claude`+MCP-Subtree verwaisen liesse). Job-Registry ist in-memory (threading+Popen) — kein `--reload` während Jobs.
- Stufe 2b (Browser-Korrektur): `POST /api/projects/{project}/correct` startet `python -m webtool.correct run <NAME>` als `jobs.py`-Job (kind `correct`; teilt sich die Ein-Job-pro-Projekt-Dedupe mit `transcribe`). Der `run`-Driver macht `prep` → ein `claude -p` für ein gemeinsames `_glossar.json` → pro Datei ein `claude -p` (Korrektur, schreibt `<base>.correction.json`) → per Default ein zweiter `claude -p` (**Treue-Verifikation** gegen das ID-getaggte `<base>.tagged.txt`, überschreibt `correction.json` mit der geprüften Fassung; ein ungültig schreibender Verify wird auf die gültige Erst-Korrektur zurückgerollt) → `apply`. Aufruf: `claude -p "<prompt>" --model opus --permission-mode acceptEdits --allowedTools Read,Write --add-dir <projekte_root>`, `cwd`=Repo-Root (lädt diese CLAUDE.md). **Erfolg = geschriebene `correction.json` existiert+parst+hat `segments`** (nicht Exitcode); fehlt sie → Datei überspringen, Rest weiterlaufen. Idempotent: `human_edited=true` oder vorhandene `correction.json` → SKIP. Ein via Cancel abgebrochener Lauf ist damit **resumbar**: schon fertig geschriebene `correction.json` bleiben stehen, ein Re-Run überspringt sie und holt nur fehlende/mid-write-kaputte (parsen nicht → gelten als „nicht vorhanden") nach; `apply` läuft beim erneuten Lauf. Der Treue-Pass ist Default-an, abschaltbar via `--no-verify` bzw. `TRANSKRIBOR_VERIFY=0` (kein Browser-Toggle — die Env greift server-weit über den uvicorn-Prozess). Verdoppelt die Opus-Aufrufe pro Datei; Cancel bricht Ausreißer ab. Kein API-Key (Claude-Code-Abo). Der Workflow `tools/correct_label.mjs` (Schritt 2 unten) bleibt die Alternative (Parallelität + In-Memory-Schema-Validierung der Agent-Ausgaben).
