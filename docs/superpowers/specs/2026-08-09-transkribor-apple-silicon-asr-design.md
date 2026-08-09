# Transkribor auf Apple Silicon — ASR-Engine (Design)

Datum: 2026-08-09
Status: umgesetzt
Schliesst: „Offene Messung" aus `2026-08-08-transkribor-cross-platform-design.md:228`

## Warum

Die Cross-Platform-Spec hat eine Frage bewusst offengelassen:

> Auf dem M-Mac dieselbe Audiodatei mit `large-v3` und `turbo`, je `mps` und `cpu`, Laufzeit
> notieren. Das Ergebnis entscheidet, ob `whisper.cpp` mit Metal als zweites Backend nötig
> wird — mit einer Zahl als Begründung statt aus dem Bauch. Solange die Messung fehlt, wird
> kein zweites Backend gebaut.

Die Messung ist erfolgt. Sie sagt: ja, und zwar deutlich.

## Messung

M1 Pro (6 Performance-, 2 Effizienzkerne, 16 GB), macOS 26.5.2. Eine Datei aus sieben
verketteten Interviewaufnahmen, 8,7 Min / 524 s. Identische Decoder-Einstellungen, wo die
Engine sie zulässt: `beam_size=5`, `best_of=5`, Temperatur-Rückfall `0.0…1.0`,
`condition_on_previous_text`, derselbe `initial_prompt`, `word_timestamps`.

| Engine | Modell | Gerät | Decoder | Laufzeit | Realtime | Wortähnlichkeit |
|---|---|---|---|---|---|---|
| faster-whisper (bisher) | large-v3 | CPU int8 | beam5 | 650 s | 0,81x | Referenz |
| faster-whisper | turbo | CPU int8 | beam5 | 126 s | 4,16x | 83,6 % |
| mlx-whisper | large-v3 | Metal | greedy | 494 s | 1,06x | 80,0 % |
| mlx-whisper | turbo | Metal | greedy | 149 s | 3,52x | 78,0 % |
| **whisper.cpp** | **large-v3 fp16** | **Metal** | **beam5** | **99 s** | **5,29x** | **89,5 %** |
| whisper.cpp | large-v3 q5_0 | Metal | beam5 | 106 s | 4,94x | 89,4 % |
| whisper.cpp | large-v3 fp16 +DTW | Metal | beam5 | 216 s | 2,42x | — |
| whisper.cpp | turbo | Metal | beam5 | 37 s | 14,16x | — |

„Wortähnlichkeit" ist `difflib.SequenceMatcher` über Wortlisten gegen den bisherigen
Produktionspfad. Das ist ein Abweichungs-, kein Qualitätsmaß — ohne Referenztranskript
sagt es nicht, welche Variante *richtiger* liegt. Es taugt, um grobe Abstürze
auszuschliessen, und dafür wird es hier benutzt.

## Entscheidungen

### 1. whisper.cpp mit Metal wird die ASR-Engine auf Apple Silicon

Nicht allein wegen Faktor 6,6. Ausschlaggebend war, dass whisper.cpp die einzige Variante
ist, die schneller wird, **ohne Qualität einzutauschen**: voller Beam-Search statt greedy,
dieselbe Segmentzahl wie der Referenzlauf (176), und im Wortvergleich näher an ihm als
jede Alternative.

### 2. mlx-whisper wird nicht gebaut

Es verliert bei `turbo` gegen den bestehenden CPU-Pfad (3,52x gegen 4,16x) und gewinnt bei
`large-v3` nur um 24 %. Dazu kommt ein funktionaler Mangel: `NotImplementedError: Beam
search decoder is not yet implemented` — jedes `beam_size != None` wird abgelehnt. Ein
zweiter Codepfad, der langsamer ist *und* den Decoder verschlechtert, ist keiner.

### 3. Flash Attention an, DTW aus

`--dtw` liefert genauere Wort-Zeitstempel, ist mit Flash Attention unvereinbar und
halbiert den Durchsatz (216 s statt 99 s). Gekauft wäre wenig: `Word.start/end` ist im
Frontend `number | null`; die Arbeit leistet dort `probability` (`uncertainty.ts` und die
`[[Wort|0.pp]]`-Markierung für die LLM-Korrektur). Die **Segment**-Zeiten, über die der
Editor Audio und Text synchronisiert, sind in beiden Modi exakt.

### 4. Quantisiert (q5_0), und damit ohne Hugging Face

q5_0 kostet 7 % Tempo (106 s statt 99 s) und ist im Wortvergleich gleichauf (89,4 % gegen
89,5 %). Der Gewinn ist die Grösse: **1,01 GB statt 2,88 GB** — unter der 2-GB-Grenze für
GitHub-Release-Assets. Damit kommt das Modell aus demselben Release, aus dem
`electron-updater` ohnehin lädt (`package.json:publish`), statt von Hugging Face.

Der Mac-Pfad ist danach frei von Hugging Face. Verifiziert mit `HF_HUB_OFFLINE=1`: die
pyannote-Diarisierung läuft weiter (ihr Modell liegt seit Stufe 3 in `models/`).

| Komponente | Quelle |
|---|---|
| pyannote-Modell | `models/` im Repo |
| GGML-Whisper-Modell | GitHub-Release `modelle-v1` |
| whisper-cpp, ffmpeg, Python | Homebrew |
| torch, PyAV | PyPI |

### 5. Wort-Wahrscheinlichkeit ist das Mittel der Token-Werte

whisper.cpp liefert Sub-Word-Tokens, der Vertrag verlangt Wörter. Gemessen an 62 Wörtern
gegen faster-whisper auf derselben Datei:

| Aggregation | unter Schwelle 0,5 | Median |
|---|---|---|
| faster-whisper (Referenz) | 6,5 % | 0,873 |
| **Mittel** | **9,4 %** | **0,866** |
| Minimum | 15,6 % | 0,844 |
| Produkt | 15,6 % | 0,812 |

Minimum und Produkt hätten `UNCERTAIN_TAG_THRESHOLD = 0.5` still entkalibriert und den
Editor mit Falschwarnungen geflutet.

### 6. `cpu_threads` bleibt beim Default

Der naheliegendste Optimierungsgriff schadet. large-v3, 2,0 Min Audio:

| Threads | Laufzeit | Realtime |
|---|---|---|
| 4 (Default) | 82 s | 1,45x |
| 6 | 104 s | 1,14x |
| 8 | 171 s | 0,70x |

CTranslate2 synchronisiert je Schicht; sobald Threads auf den Effizienzkernen landen,
wartet der ganze Block auf sie. Steht als Kommentar in `transcribe.py:_modell`, damit es
niemand später „optimiert".

## Wo die Plattformen auseinanderlaufen

Die Verzweigung sitzt an zwei Rändern und **konvergiert vor dem `<base>.json`-Vertrag**:

- **Engine-Wahl** — `device.asr_engine(modell)`. An der Plattform festgemacht
  (`sys.platform == "darwin" and platform.machine() == "arm64"`), nicht an `pick() == "mps"`:
  whisper.cpp rechnet über Metal und braucht kein torch.
- **Installation** — `setup.js:plan()` nennt `whisper-cpp` in derselben brew-Zeile wie
  python und ffmpeg.

Alles dahinter — `edit_model`, Korrektur, Diarisierung, Frontend — bleibt einpfadig, weil
`whispercpp.ergebnis()` exakt dieselbe dict-Form baut wie `transcribe._ergebnis()`.

**Drei Rückfälle auf faster-whisper**, damit nie etwas ausfällt statt nur langsam zu sein:
kein Apple Silicon; `whisper-cli` nicht installiert; eine Stufe ohne GGML-Datei am Release
(`large-v1`, die `.en`-Varianten).

## Nicht-Ziele

- **Windows/Linux umstellen.** Dort gewinnt CUDA; die Messung sagt nichts über sie aus.
- **Intel-Macs.** Nicht unterstützt (bereits in der README), und Metal gibt es dort nicht.
- **Wortgleichheit über Plattformen.** Mac und Windows transkribieren dasselbe Interview
  nicht identisch (89,5 % Ähnlichkeit). Für einen Einzelnutzer belanglos; wer Projekte
  zwischen Rechnern teilt, sollte es wissen.

## Offen

- **Schweizerdeutsch ungeprüft.** Das Testmaterial war überwiegend Standarddeutsch. Die
  Engine-Reihenfolge dürfte davon unberührt bleiben, die absoluten Zahlen nicht.
- **Segmentierung von q5_0.** 133 Segmente gegen 176 bei fp16 — ein struktureller
  Unterschied, der im Editor längere Blöcke bedeutet. An einem zweiten Interview
  gegenzuprüfen.
- **Release-Assets.** `modelle-v1` muss die GGML-Dateien tragen, sonst greift der
  Download ins Leere. Bis dahin hilft `TRANSKRIBOR_GGML_URL`.
