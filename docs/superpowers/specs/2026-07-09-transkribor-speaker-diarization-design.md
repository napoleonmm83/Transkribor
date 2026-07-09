# Transkribor — Sprecher-Erkennung (Speaker Diarization, Stufe 3)

**Datum:** 2026-07-09
**Status:** Entwurf zur Freigabe
**Kontext:** Roadmap-Stufe 3. Baut auf dem bestehenden Transkribier-/Korrektur-Pipeline
(`transcribe.py` → `webtool.correct`) auf. Backend-Datenmodell (`edit.json`/`md`) und das
komplette Frontend bleiben **unverändert** — die Diarisierung befüllt nur ein Feld, das
ohnehin schon end-to-end fliesst.

## 1. Ziel & Kontext

Interviews sind meist Zwiegespräche (Interviewer + befragte Person, gelegentlich mehr).
Heute rät **Claude im Korrektur-Schritt** die Sprecher allein aus dem **Text** ("klingt nach
Frage → Interviewer"). Das ist bei unklaren Wechseln, Rückkanälen und Interviewer-Aussagen
fehleranfällig. Diese Stufe fügt eine **akustische** Sprecher-Trennung (pyannote) hinzu, die
*wer wann spricht* aus dem Ton bestimmt. Die Sprecher werden automatisch als „Sprecher 1/2/…"
vor-markiert und bleiben über die bestehende Combobox editierbar.

**Nicht-Ziel:** neue Frontend-Features, Sprecher-Verifikation über Dateien hinweg
(Sprecher-Wiedererkennung projektweit), Echtzeit/Streaming-Diarisierung.

## 2. Entscheidungen (aus dem Brainstorming)

| Aspekt | Wahl | Begründung |
|---|---|---|
| **Architektur** | **Hybrid**: pyannote liefert anonyme Cluster (*wer wann*), Claude benennt sie (*wie heissen sie*) im bestehenden Korrektur-Schritt | Akustik fixt Sprechergrenzen (LLM-Schwäche), LLM macht die Benennung (LLM-Stärke). Wiederverwendet die ganze Korrektur-Pipeline. |
| **Pipeline-Slot** | **Prep-Schritt im `correct run`-Job** (neben Tagging/Glossar), schreibt `<base>.diar.json` | Ein Button („Korrigieren"), resumbar, graceful Fallback. Kein neuer manueller Schritt. |
| **Sprecheranzahl** | **Auto-Detect, `min_speakers=2`** (kein Max-Cap) | Über-Segmentierung ist heilbar (LLM merged Namen), Unter-Segmentierung nicht; min-2 verhindert den schlimmen Fall. Gruppeninterviews gratis. |
| **Engine** | **pyannote.audio 4.0.7** (community-1), GPU, HF-Token, torchcodec-Pin | Beste Cluster-Qualität; torch-2.8-Pin ist gelockert (läuft auf torch 2.11/Blackwell). sherpa-onnx bleibt Fallback (engine-agnostisches Design). |
| **Frontend** | **keine Änderung in v1** | Sprecher sind bereits editierbar (SpeakerCombobox pro Segment). „Ganzen Cluster umbenennen" mit einem Klick ist auf später verschoben. |
| **Aktivierung** | Default-**an**, abschaltbar via `TRANSKRIBOR_DIARIZE=0` | Spiegelt `TRANSKRIBOR_VERIFY`; greift server-weit über den uvicorn-Prozess. |

## 3. Datenfluss

Die Diarisierung ist ein neuer **deterministischer Prep-Schritt**. Der Ausgabe-Vertrag des
LLM (`correction.json`) bleibt **identisch** — deshalb ist der Diff klein.

```
transcribe.py ──▶ <base>.json   (Whisper-Segmente + Wort-Zeitstempel)
                        │
   ┌────────────────────┴──────────── correct run  (Korrigieren-Job) ─────────────────────┐
   │  prep:   unsichere Wörter taggen         →  <base>.tagged.txt                          │
   │  DIARIZE (NEU, GPU): pyannote            →  <base>.diar.json  {turns[], seg→cluster}   │
   │  glossar (LLM, über alle Dateien)                                                      │
   │  pro Datei: correct (LLM) liest tagged.txt + diar.json → <base>.correction.json        │
   │  verify (Treue, unverändert) → apply                                                   │
   └───────────────────────────────────────────────────────────────────────────────────────┘
                        │
             <base>.edit.json + <base>.md     (Feld `speaker` fliesst bereits end-to-end)
```

## 4. Komponenten

### 4.1 Neues Modul `webtool/diarize.py`

Drei Bausteine, ein Lazy-Modell-Singleton (wie das Whisper-Modell in `transcribe.py`):

- **`load_pipeline()`** — lädt die pyannote-Pipeline einmal (Modul-Level, GPU via `.to("cuda")`),
  `token=os.environ["HF_TOKEN"]`. `speaker-diarization-community-1`. Cache in
  `~/.cache/huggingface`.
- **`diarize_file(audio_path, min_speakers=2) -> list[dict]`** — führt die Pipeline aus,
  liefert `turns = [{"start": float, "end": float, "cluster": int}]` (roher Sprecher-Turn je
  Zeitspanne).
- **`assign_clusters(raw_json, turns) -> dict[int, str]`** — ordnet jedem Whisper-Segment per
  **maximaler zeitlicher Überlappung** (`[seg.start, seg.end]` vs. Turns) einen Cluster zu;
  Segmente ohne Überlappung erben den Cluster des vorherigen Segments. Cluster 1-basig →
  `"Sprecher 1"`, `"Sprecher 2"`, …
- **`run_diarization(audio_path, raw_json_path, out_path, min_speakers=2)`** — Orchestrierung:
  ruft die obigen, schreibt Sidecar (atomar).

**Sidecar `<base>.diar.json`** (unter `projekte/<NAME>/transkripte/`, git-ignoriert):
```json
{
  "base": "<base>",
  "audio": "<dateiname>",
  "min_speakers": 2,
  "turns": [{"start": 0.0, "end": 4.2, "cluster": 1}],
  "segments": [{"id": 0, "speaker": "Sprecher 1"}]
}
```
**Idempotent/resumbar:** existiert + parst → SKIP (wie `correction.json`). Neu-Diarisierung =
Sidecar löschen oder `--force`.

### 4.2 Der Hybrid-Kleber — nur eine Prompt-Änderung (`webtool/correct.py`)

Der Korrektur-Prompt baut heute aus `<base>.tagged.txt` (Zeilen `[<id>] <getaggter Text>`).
Neu wird pro Zeile der Cluster vorangestellt, **wenn** `diar.json` vorhanden:

```
[<id>] (Sprecher 1) <getaggter Text>
```

Zusatz-Instruktion im Prompt: *„Der eingeklammerte Cluster ist die akustische Wahrheit, WER
spricht — vergib genau einen konsistenten Namen pro Cluster (Interviewer / Name der befragten
Person / ‚Befragte Person'). Du DARFST zwei Cluster demselben Namen zuordnen, wenn es klar
dieselbe Person ist. Eine Cluster-Grenze nur überschreiben, wenn sie offensichtlich falsch ist
(z. B. ein einzelnes Rückkanal-Wort falsch zugeordnet)."*

Das LLM liefert **dasselbe** `correction.json` wie bisher (`segments[].speaker` jetzt benannt,
`speakers[]` die benannte Liste). **`apply_correction` ändert sich nicht.**

### 4.3 Verdrahtung in den Run-Treiber (`webtool/correct.py cmd_run`)

Nach `prep`, vor Glossar/Korrektur, pro Base: `run_diarization(...)` **best-effort**
(try/except). Reuse-/Skip-Logik analog `correction.json` (mtimes + vorhandenes Sidecar).

## 5. Was sich NICHT ändert

- `webtool/edit_model.py` (`build_edit_doc`, `apply_correction`) — Schema & Overlay unverändert.
- `webtool/render_md.py` — Gruppierung nach `speaker` unverändert.
- **Das komplette Frontend** — `SpeakerCombobox`, `SpeakerTurn`, `groupIntoTurns`, `types.ts`
  (`Segment.speaker`, `EditDoc.speakers[]`). Segment-genaue Korrekturen laufen über die
  bestehende Combobox.
- Der Treue-Verify-Pass prüft Text gegen `tagged.txt`, berührt Sprecher nicht → unbeeinflusst.

## 6. Fehlerbehandlung & Fallback (Null-Regression)

Die Diarisierung ist rein additiv:

- pyannote nicht installiert / `HF_TOKEN` fehlt / Laufzeitfehler → **loggen, kein Sidecar,
  weiter**. Fehlt `diar.json`, baut der Prompt wie **heute** ohne Cluster (reines Text-Raten).
  Eine kaputte GPU/Token bricht die Korrektur nie.
- `TRANSKRIBOR_DIARIZE=0` (Default `1`) → Diarisierung server-weit aus.
- **GPU-Exklusivität:** die Diarisierung nutzt die GPU; der `correct`-Job läuft heute ohne
  GPU-Guard. Der bestehende Single-Transcribe-Guard in `webtool/jobs.py` (`start()`, ~Z. 33–37)
  wird erweitert, sodass sich Transkription und (diarisierende) Korrektur nicht gleichzeitig um
  die eine GPU streiten.
- Trust-Boundary neuer Pfade unverändert über `paths.safe_name`.

## 7. Konfiguration & Abhängigkeiten

- Neu ins `.venv` (uv/pip, cu128): `pyannote.audio==4.0.7`, passendes `torchaudio` (2.11) und
  `torchcodec` (ABI-Match zu torch 2.11). ffmpeg ist bereits auf PATH.
- **`HF_TOKEN`** (env) — einmalig HF-Konto + `speaker-diarization-community-1`-Bedingungen
  akzeptieren. Modell-Cache `~/.cache/huggingface` (~einmaliger Download, wie Whisper-Cache).
- CLAUDE.md „Umgebung" + Env-Overrides um `HF_TOKEN` und `TRANSKRIBOR_DIARIZE` ergänzen.

## 8. Tests

- **Unit (der Rechenpfad):** `assign_clusters` Max-Overlap mit **synthetischen** Turns/Segmenten
  (kein Audio, kein Modell): Normalfall 2 Sprecher; Segment über eine Grenze; Segment ohne
  Überlappung (erbt Vorgänger); Über-Segmentierung (3 Cluster) bleibt zuordenbar.
- **Fallback:** fehlendes `diar.json` → Prompt-Bau ohne Cluster (kein Fehler, Text-only).
- **Smoke (manuell, im Impl-Schritt):** Diarisierung auf einer echten Foodfestival-Aufnahme,
  GPU-Inferenz + plausible Cluster-Zahl prüfen (Skill `verify`).

## 9. Implementierungs-Reihenfolge

1. **De-Risk-Spike (zuerst!):** pyannote 4.0.7 + torchcodec im `.venv` installieren, HF
   authentifizieren, Diarisierung auf **einer** echten Aufnahme laufen lassen; GPU-Inferenz +
   sinnvolle Cluster bestätigen. Zickt der Install → auf **sherpa-onnx** ausweichen (nur
   `diarize_file`-Interna tauschen, Rest engine-agnostisch).
2. `webtool/diarize.py` inkl. `assign_clusters`-Unit-Tests (TDD).
3. Prompt-Erweiterung + `cmd_run`-Verdrahtung (best-effort) in `correct.py`; Fallback-Test.
4. GPU-Guard in `jobs.py` erweitern.
5. Env/Docs (`HF_TOKEN`, `TRANSKRIBOR_DIARIZE`) in CLAUDE.md.
6. End-to-end Smoke auf einem echten Projekt (`verify`).

## 10. Datei-Anker (für den Plan)

- `transcribe.py` — Whisper-Ausgabe `<base>.json` (Segmente `{id,start,end,text,words[]}`).
- `webtool/correct.py` — `cmd_prep` (~54–67, schreibt `tagged.txt`), `cmd_run` (~274–324),
  Prompt-Schema (~202–211), Sprecher-Instruktion (~195–197), Reuse/Skip (~295–304).
- `webtool/edit_model.py` — `apply_correction` (~87–102) überlagert `speakers`/`text` je id.
- `webtool/render_md.py` — Gruppierung nach `speaker`, leer → „Befragte Person".
- `webtool/jobs.py` — `start()` Dedupe + Single-Transcribe-GPU-Guard (~33–37).
- `webtool/paths.py` — `safe_name` (~12–15) Trust-Boundary; `TRANSKRIBOR_PROJEKTE`.
- Frontend (unverändert, zur Referenz): `src/lib/types.ts`, `src/lib/grouping.ts`,
  `src/components/SpeakerCombobox.tsx`.
