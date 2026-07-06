# Transkribor Web-Tool — Design-Spec

Datum: 2026-07-06
Status: freigegeben (Design), bereit für Implementierungsplan

## 1. Kontext & Ziel

Transkribor transkribiert Interview-Audio (oft **Schweizerdeutsch / Bündnerdeutsch**) mit
Whisper large-v3 und korrigiert es kontextbasiert per LLM (Claude) zu lesbarem,
sprecher-markiertem Standarddeutsch. Heute läuft das als zwei CLI-/Workflow-Schritte;
Ergebnis ist eine `.md`-Datei.

Ziel dieses Projekts: ein **lokales Web-Tool nach Vorbild von TurboScribe**, mit dem der
Nutzer die Transkription **abschnittweise** sieht, per **Klick auf einen Abschnitt das
zugehörige Audio-Snippet abspielt** und den Text **manuell korrigiert** — plus Sichtbarkeit,
**wo Whisper unsicher war**. Ausbaustufe: volle TurboScribe-Parität (Upload → Transkribieren
→ LLM-Korrektur → Editieren → Export, mit Projektverwaltung), gebaut in tragfähigen Stufen.

Einzelnutzer, alles lokal lauffähig, kein Cloud-Zwang.

## 2. Festgelegte Entscheidungen (mit Begründung)

Vorab-Recherche (multi-agent, faktengeprüft, Quellen in §12) hat diese Weichen gestellt:

1. **ASR bleibt openai-whisper large-v3 im vorhandenen `torch cu128`-Stack. Kein Modell-/Stackwechsel.**
   - Schweizerdeutsch→Standarddeutsch macht large-v3 bereits zero-shot (~28,6 % WER). Ein
     dialekt-spezifischer Fine-Tune bringt *ehrlich gemessen* nur ~3 WER-Punkte (real ~25,6 % WER
     / ~13,8 % Content-WER); publizierte 12–17 % sind durch Benchmark-Kontamination geschönt
     (arXiv 2606.07608, im Fakten-Check bestätigt).
   - Der beste frei ladbare Fine-Tune (`nizarmichaud/...-swissgerman`) wurde von HuggingFace
     **zurückgezogen** (Datensatz-Lizenzen) → verstärkt „bei large-v3 bleiben".
   - Ein Wechsel auf faster-whisper/CTranslate2/WhisperX riskiert **cuDNN-Ladefehler auf Blackwell
     sm_120** (RTX 5080), den der aktuelle Stack schon vermeidet — bei **null** Confidence-Vorteil
     (identische Logits).
   - Die Lesbarkeit trägt ohnehin der nachgelagerte **Claude+Glossar-Korrekturschritt** — der bleibt.

2. **Korrektur-Fluss: „Pipeline, Mensch hat letztes Wort".**
   Whisper-Roh → LLM korrigiert automatisch (seed) → Nutzer reviewt/editiert im Browser. Die
   LLM-Korrektur läuft **nie** über manuelle Edits (`human_edited`-Flag schützt; Re-Korrektur nur
   nach expliziter Bestätigung).

3. **Unsicherheits-Signale kommen komplett aus dem vorhandenen Whisper-JSON** — nichts neu berechnen,
   kein Modellwechsel. Details §6.

4. **Architektur: FastAPI (vorhandene venv) + genau eine statische `index.html` (Vanilla-JS).**
   Kein Framework, keine DB, kein Docker, kein Electron/Tauri. Begründung §5.

5. **Waveform ja** (wavesurfer.js v7, lokal eingebettet). **Highlight auf Segment-/Redebeitrags-Ebene**
   (kein Wort-Karaoke im MVP). **Export nur `.md`** (weitere Formate später bei Bedarf).

6. **Diarization: standardmäßig keine.** Für saubere 2-Sprecher-Interviews schlägt die
   LLM-Frage/Antwort-Heuristik automatische Diarization oft nicht und spart HF-Token + Windows-Setup.
   `pyannote.audio 4.0 community-1` bleibt optionaler Upgrade-Pfad (Stufe 3, §11).

7. **Stufe-2-Korrektur-Trigger: Backend ruft headless `claude -p`** (nutzt bestehendes
   Claude-Code-Abo + `correct_label.mjs`, kein API-Key). Nicht die Anthropic-API direkt.

## 3. Nicht-Ziele / bewusst verworfen (YAGNI)

- **Kein** Wechsel auf faster-whisper/CTranslate2/WhisperX als Standard (Blackwell-Risiko, kein Gewinn).
- **Kein** Swiss-German-Fine-Tune als Default (marginaler, kontaminationsverzerrter Gewinn; nur optionales A/B später).
- **Keine** MongoDB/Docker/Multi-Container-Architektur (Whishper-Style) — Wartungsfalle für einen Nutzer.
- **Kein** Electron/Tauri-Desktop — neue Toolchain für null Mehrwert.
- **Kein** destruktives Media-Editing à la Descript (Text löschen schneidet Audio) — außerhalb des Use-Case.
- **Kein** Wort-genaues Karaoke-Highlight im MVP (Segment-Ebene reicht für „abschnittweise").
- **Kein** `beam_size`-Senken gegen Halluzinationen (kostet Dialektgenauigkeit; der Kontext-LLM ist der Hebel).

## 4. Datenmodell

### 4.1 Dateien pro Projekt

| Datei | Rolle | Schreiber |
|---|---|---|
| `projekte/<P>/audio/<base>.<ext>` | Audioquelle | Nutzer (Upload) |
| `projekte/<P>/kontext.md` | optionaler Projektkontext + bekannte Eigennamen | Nutzer |
| `projekte/<P>/transkripte/<base>.json` | Whisper-Rohausgabe, **immutable** | `transcribe.py` |
| `projekte/<P>/transkripte/<base>.edit.json` | **kanonisches Editor-Dokument** | Editor + LLM-Korrektur |
| `projekte/<P>/transkripte/<base>.md` | Export (aus `edit.json` gerendert) | Editor-Export |
| `projekte/<P>/transkripte/<base>.raw.txt`, `.segments.txt` | abgeleiteter Rohtext (bestehend) | `transcribe.py` |

**Nicht-destruktive Garantie:** `<base>.json` wird nie überschrieben. Editier-Zustand lebt
ausschließlich in `<base>.edit.json`. `<base>.md` ist reiner Export und jederzeit reproduzierbar.

### 4.2 `edit.json`-Schema

```jsonc
{
  "base": "C0687_01913077",
  "project": "Foodfestival-Maienfeld",
  "audio": "C0687_01913077.mp3",     // Dateiname in audio/
  "language": "de",
  "human_edited": false,             // true, sobald der Nutzer speichert -> schützt vor LLM-Überschreiben
  "context": "",                     // 1–2 Sätze zu diesem Gespräch (aus LLM-Korrektur, optional)
  "speakers": ["Interviewer", "Matthias Baumgartner"],  // Projekt-/Datei-Vorschläge fürs Dropdown
  "segments": [
    {
      "id": 0,
      "start": 5.28, "end": 13.52,
      "speaker": "Matthias Baumgartner",   // "" wenn unbekannt
      "raw_text": "Ich bin Matthias ...",  // aus Whisper-Roh, unverändert
      "text": "Ich bin Matthias Baumgartner, Chef vom Schloss Maienfeld ...",  // korrigiert, editierbar
      "words": [ {"word":"Ich","start":5.28,"end":6.02,"probability":0.13}, ... ], // aus Roh
      "flags": {"hallucination": false, "silence": false, "low_conf": true},
      "note": ""   // optionale Anmerkung zu diesem Segment
    }
  ],
  "annotations": []  // Freitext-Zeilen für "## Anmerkungen" im Export
}
```

### 4.3 Aufbau von `edit.json` aus Roh-JSON (wenn noch keine LLM-Korrektur vorliegt)

Pro Whisper-Segment: `id/start/end` übernehmen; `raw_text = segment.text.strip()`;
`text = raw_text` (Startwert); `words` aus Roh; `speaker = ""`; `flags` berechnet aus:

- `hallucination = compression_ratio > 2.4` (zuverlässigster Halluzinations-/Loop-Indikator)
- `silence = no_speech_prob > 0.6 && avg_logprob < -1.0`
- `low_conf = avg_logprob < -1.0` (generell wacklig)

Schwellen als Konstanten an *einer* Stelle (Whisper-Defaults). `human_edited = false`.

**Migration bestehender `.md`:** vorhandene Prosa-`.md` werden nicht zurückgeparst (fragil).
Ab jetzt ist `edit.json` kanonisch; für Altdateien entweder aus Roh starten oder die
Korrektur (Stufe 1.5) einmal neu laufen lassen, die `edit.json` direkt erzeugt.

## 5. Architektur

### 5.1 Backend — FastAPI (Warum, gegen Alternativen)

Reines Static-HTML fällt aus (Browser darf nicht frei ins Dateisystem schreiben → Korrekturen
nur als Download). Electron/Tauri/Whishper-Style ist Over-Engineering. FastAPI nutzt die
**vorhandene venv** (null neue Sprache) und liefert genau die drei Dinge, die Static nicht kann:
Audio-Range-Streaming, das JSON, und robustes serverseitiges Speichern.

| Methode & Pfad | Zweck | Stufe |
|---|---|---|
| `GET /` | liefert `index.html` | 1 |
| `GET /static/*` | eingebettete Assets (wavesurfer, JS, CSS) | 1 |
| `GET /api/projects` | Projekte + Dateien + Status (hat audio/json/edit/md) | 1 |
| `GET /api/projects/{p}/files/{base}` | `edit.json` (baut es bei Bedarf aus Roh-JSON, §4.3) | 1 |
| `GET /api/projects/{p}/audio/{base}` | Audio mit **HTTP-Range**-Support (Seeking) | 1 |
| `PUT /api/projects/{p}/files/{base}` | `edit.json` speichern (nicht-destruktiv), `human_edited=true`, `.md` rendern | 1 |
| `POST /api/projects/{p}/files/{base}/export` | `.md` (neu) erzeugen/zurückgeben | 1 |
| `POST /api/projects/{p}/upload` | Audio-Upload in `audio/` | 2 |
| `POST /api/projects/{p}/transcribe` | `transcribe.py` als Subprozess starten | 2 |
| `POST /api/projects/{p}/files/{base}/correct` | LLM-Korrektur via headless `claude -p` starten | 2 |
| `GET /api/jobs/{id}` | Fortschritt laufender Jobs (Transkription/Korrektur) | 2 |

Job-Fortschritt (Stufe 2): einfache In-Memory-Job-Registry + Polling auf `GET /api/jobs/{id}`
(kein SSE/WebSocket nötig für einen Nutzer). `ponytail:` Polling reicht; auf SSE upgraden nur,
wenn die UI zu träge wirkt.

### 5.2 Frontend — eine `index.html` + Vanilla-JS

- **Klick→Audio braucht keine Library:** `audio.currentTime = seg.start; audio.play()`, Stop bei
  `seg.end` (per `timeupdate` oder `requestAnimationFrame`-Poll).
- **Segment-Highlight beim Abspielen:** aktives Segment = jenes, dessen `[start,end]` `currentTime`
  enthält (rAF-Poll, ~250 ms `timeupdate` ist zu grob).
- **wavesurfer.js v7 (7.12.x) lokal eingebettet** (kein CDN, CSP-safe) für die Wellenform;
  Klick in die Waveform seekt; optionale Segment-Regionen als Marker.
- **Inline-Edit:** Segmenttext als `contenteditable`; Speichern on-blur/Button → `PUT`.
- **Sprecher-Label** pro Segment: Dropdown aus `speakers` + Freitext.

## 6. Unsicherheits-Strategie

Alle Signale liegen im Whisper-JSON — nichts neu berechnen.

- **Wort-Ebene** aus `word.probability`: verstellbare Regler (Startwerte `<0.6` gelb „prüfen",
  `<0.4` rot „wahrscheinlich falsch"). Angezeigt über den **🔍-Toggle pro Segment**, der die
  **Roh-Wörter** farbcodiert einblendet (dort mappen die Wahrscheinlichkeiten 1:1; der korrigierte
  Text kann Wörter geändert haben). Schwellen **nicht** hartkodieren — Whisper ist überkonfident und
  nicht auf Schweizerdeutsch kalibriert. **Randwort-Begnadigung:** erstes/letztes Wort eines Segments
  erst ab der *roten* Schwelle färben (bekannter Randeffekt niedriger prob).
- **Segment-Ebene (Flags, immer sichtbar):** ⚠ `hallucination` (`compression_ratio>2.4`),
  🔇 `silence`, ~ `low_conf`. **Wichtig:** `avg_logprob` **nicht** allein als Halluzinations-Detektor
  (flüssige Fehl-Transkriptionen sind überkonfident); `compression_ratio` ist der zuverlässigste.
- **LLM gezielt lenken** (Korrekturschritt, §7): niedrig-prob-Wörter **inline getaggt** an Claude
  (`nach [[Chur|0.31]]`) + Segment-Flags durchreichen. Anweisung: „korrigiere primär Markiertes via
  Glossar/Kontext; Unmarkiertes nur bei eindeutigem Kontextfehler; nichts erfinden; geflaggte
  Halluzinations-/Stille-Segmente im Zweifel unter `## Anmerkungen` statt raten." Deckt sich mit der
  bestehenden `CLAUDE.md`-Regel „Unsicheres offenlegen".

## 7. Pipeline-Integration

- **`transcribe.py` bleibt unverändert** (large-v3, `word_timestamps=True` liefert bereits alles Nötige).
- **Korrekturschritt wird segment-ausgerichtet:** `tools/correct_label.mjs` (bzw. der Inline-Fallback)
  liefert künftig **`<base>.edit.json`** (korrigierter Text + Sprecher **pro Segment**), nicht mehr nur
  Prosa-`.md`. Die `.md` ist der aus `edit.json` gerenderte Export. Zusätzlich bekommt Claude die
  unsicheren Wörter inline getaggt (§6). Der Verifikationsschritt (Treue-Check gegen Roh) bleibt.
- **Stufe-2-Trigger:** Der „Korrektur"-Button im Browser startet die Korrektur über **headless
  `claude -p`** im Projektordner (nutzt Claude-Code-Abo + bestehenden Workflow), kein API-Key.

### 7.1 `.md`-Render-Regel (aus `edit.json`)

```
# Interview <base>

**Kontext:** <edit.context, falls vorhanden>

---

**<speaker>:** <Texte aufeinanderfolgender Segmente desselben Sprechers, mit Leerzeichen verbunden>

**<nächster speaker>:** ...

## Anmerkungen
- <je Zeile aus edit.annotations sowie nicht-leere segment.note>
```

Maximale Runs gleicher `speaker` werden zu einem Redebeitrag zusammengefasst. `## Anmerkungen`
nur, wenn es Einträge gibt.

## 8. Editor-UI (Layout)

```
┌─────────────┬──────────────────────────────────────────────┐
│ Projekte    │  ▶ ══════▓▓▓░░░░══════  Waveform (wavesurfer) │
│ ▸ Foodfest. │  0:12 / 3:45     [Speichern] [Export .md] [⚙] │
│   C0687 ✓   ├──────────────────────────────────────────────┤
│   C0700 ●   │  ▌Matthias Baumgartner ▼   [5.3s] 🔍          │
│   C0701     │  ▌ Ich bin Matthias Baumgartner, Chef vom     │
│ ▸ AndProj   │  ▌ Schloss Maienfeld…      ← klickbar, edit.  │
│             │  ▌Interviewer ▼   [13.5s]  ⚠                  │
│             │  ▌ Ihr seid auch der Gastgeber, oder?         │
└─────────────┴──────────────────────────────────────────────┘
```

Interaktionen: Klick auf Block → seek+play `[start,end]`; aktives Segment hervorgehoben;
Flags als Icon; 🔍 blendet farbcodierte Roh-Wörter ein; ⚙ öffnet die Schwellen-Regler;
Text `contenteditable`; Sprecher-Dropdown; Speichern/Export.

## 9. Stufenplan & Akzeptanzkriterien

| Stufe | Inhalt | Fertig, wenn |
|---|---|---|
| **1 — Editor-Kern** | FastAPI + index.html; `edit.json` aus Roh-JSON; Waveform; Klick→Play; Segment-Highlight; Unsicherheits-Toggle + Regler; Segment-Flags; Sprecher-Labels; Inline-Edit; nicht-destruktives Speichern; `.md`-Export | Ein bestehendes Projekt lässt sich öffnen, ein Abschnitt per Klick abspielen, Text korrigieren, speichern; `.json` bleibt unangetastet; korrekte `.md` fällt raus. |
| **1.5 — LLM-Seed** | Korrektur segment-ausgerichtet → `edit.json` vorbefüllt; inline-getaggte Unsicherheiten an Claude | Editor öffnet die Datei mit bereits korrigiertem Text + Sprecher-Labels; manuelle Edits überschreiben die Korrektur, nicht umgekehrt. |
| **2 — Pipeline im Browser** | Audio-Upload; „Transkribieren" (`transcribe.py`-Subprozess); „Korrektur" (headless `claude -p`); Job-Fortschritt | Neues Audio hochladen → transkribieren → korrigieren → editieren, alles aus dem Browser. |
| **3 — Feinschliff** | optional `pyannote`-Diarization; Wort-Karaoke; weitere Exporte | je nach Bedarf. |

## 10. Teststrategie (ponytail: ein lauffähiger Check pro nicht-trivialer Logik)

- `test_render.py`: Asserts auf (a) Flag-Berechnung an den Schwellen (`2.4 / 0.6 / -1.0`),
  (b) `.md`-Render-Gruppierung (aufeinanderfolgende gleiche Sprecher → ein Redebeitrag;
  `## Anmerkungen` nur bei Einträgen), (c) `edit.json`-Aufbau aus einer Roh-JSON-Fixture.
  Keine Frameworks/Fixtures über das Nötige hinaus.
- Manuelle End-to-End-Prüfung Stufe 1 am bestehenden `Foodfestival-Maienfeld`-Projekt.

## 11. Offene Punkte & Risiken

- **Blackwell sm_120:** jeder Pfad über CTranslate2/faster-whisper/WhisperX riskiert cuDNN-Fehler →
  bewusst vermieden (Stack bleibt). `pyannote` (Stufe 3) läuft dagegen auf `torch cu128` direkt.
- **Wort-prob-Schwellen (0.4/0.6)** sind unkalibrierte Heuristik-Startwerte → als Regler bauen,
  am eigenen Material nachjustieren, nicht hartkodieren.
- **Karaoke-Genauigkeit:** HTML5 `timeupdate` (~250 ms) zu grob → `requestAnimationFrame`-Poll.
- **wavesurfer** CSP-safe vendoren (kein CDN-Fetch im lokalen Tool).
- **headless `claude -p`** (Stufe 2): Reliabilität/Timeout des Subprozess-Aufrufs im Blick behalten;
  Job-Registry muss Fehler sauber zurückmelden.
- **`pyannote` (Stufe 3, falls nötig):** Windows-`torchcodec`-DLL-Falle umgehen (Audio vorab mit
  `torchaudio/soundfile` laden, als `{waveform, sample_rate}` übergeben); `num_speakers=2`; Turns per
  Zeit-Mehrheitsvotum auf **Segmente** mappen; Labels dem LLM nur als **Hinweis** geben.

## 12. Quellen (Recherche, faktengeprüft)

- Ehrliche Schweizerdeutsch-WER / Benchmark-Kontamination: arXiv 2606.07608.
- Whisper large-v3-turbo (809M, Decoder 32→4): huggingface.co/openai/whisper-large-v3-turbo.
- faster-whisper / Blackwell-Kontext: github.com/SYSTRAN/faster-whisper.
- Unsicherheit/Halluzination: openai/whisper `transcribe.py`-Defaults; arXiv 2501.11378; Interspeech 2025 (Calm-Whisper).
- Editor-Vorbilder: github.com/oTranscribe/oTranscribe, github.com/JuergenFleiss/aTrain, github.com/katspaugh/wavesurfer.js.
- Diarization: huggingface.co/pyannote/speaker-diarization-community-1; PyTorch 2.7 sm_120-Support.
