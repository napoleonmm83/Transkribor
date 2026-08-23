# Parallelisierung von Transkription, Diarisierung und Korrektur

Stand 2026-08-23, master `a85b0f0`. Auftrag Marcus: „prüfen und einen Plan machen, ob die
Transkription parallelisierbar ist — und die Korrektur/Diarisierung viel stärker."

**Kurzfassung:** Die Korrektur ist bereits parallel; ihr Regler ist unentdeckt, nicht
ungebaut. Die Diarisierung ist sequentiell und hat einen echten Blocker. Die Transkription
über Dateien zu parallelisieren ist ein Datenverlustweg **und** bringt am Modell nichts.
Vor allem aber: **die Zeitverteilung über die drei Phasen ist nirgends gemessen** — jeder
Umbau vor dieser Messung ist eine Wette.

---

## 1. Befund je Phase (am Code belegt)

### 1.1 Korrektur — läuft schon parallel, zweistufig

| Ort | Was |
|---|---|
| `correct.py:962` | `ThreadPoolExecutor(max_workers=min(len(all_bases), CLAUDE_PARALLEL))` über **Dateien** |
| `correct.py:853` | `ThreadPoolExecutor(max_workers=min(len(chunks)-1, CLAUDE_PARALLEL))` über **Blöcke** einer Datei |
| `correct.py:46` | `_claude_slots = threading.Semaphore(CLAUDE_PARALLEL)` — **ein** Deckel über beide |
| `correct.py:459` / `:485` | der Deckel greift im Abo-Weg (`_run_claude`) **und** im API-Weg (`_ask_llm`) |
| `correct.py:43` | `CLAUDE_PARALLEL = max(1, int(os.environ.get("TRANSKRIBOR_PARALLEL") or 3))` |

Der Deckel sitzt bewusst an `_run_claude` statt an den Executors — sonst wären Datei- und
Blockparallelität multiplikativ (3 Dateien × 3 Blöcke = 9 Sessions).

**Drei Dinge, die den Durchsatz heute begrenzen:**

1. **`TRANSKRIBOR_PARALLEL` ist in `.env.example` nicht erwähnt** und geht **nicht** durch
   `settings.job_env()` (`settings.py:236` reicht nur `WHISPER_MODEL`/`WHISPER_LANG`
   durch). Er wirkt nur, wenn er in der echten Serverumgebung steht. Im Browser gibt es
   ihn nicht. → Er läuft auf **3**.
2. **Block 1 läuft immer allein vor** (`correct.py:846`), weil aus ihm die
   Cluster→Name-Zuordnung kommt. Bei *einer* langen Datei ist das eine feste serielle
   Phase, die kein Deckel wegnimmt.
3. **Der Treue-Pass verdoppelt die Aufrufe** je Block (Default an).

**Der eingestellte Anbieter ist `claude-cli` (Abo), Modell `sonnet`, kein API-Key.** Damit
ist der Deckel eine **Kontingent**-Entscheidung, nicht nur eine technische: 8 parallele
`claude -p` sind 8 node-Prozesse à ~7,7 s Startup und 8× Abo-Verbrauch pro Zeiteinheit.
Deshalb gehört die Zahl in die Hand des Nutzers, nicht in einen höheren Default.

### 1.2 Diarisierung — sequentiell, mit einem echten Blocker

`cmd_diarize` (`correct.py:215`) läuft in einer schlichten `for`-Schleife über alle Dateien,
**als Prep-Schritt vor** der Korrektur (`correct.py:916`). Erst wenn die letzte Datei
diarisiert ist, startet das Glossar.

Der naive Fix (ThreadPool um die Schleife) ist **nicht** zulässig:

- `diarize._pipeline()` (`diarize.py:55`) ist ein **modulglobaler** Cache — eine einzige
  pyannote-Instanz für alle Aufrufe. pyannote-Pipelines sind nicht als thread-safe
  dokumentiert und tragen Zustand.
- `_Sonden` (`diarize.py:121`) patcht **`type(pipe.clustering).filter_embeddings`** (die
  *Klasse*) und `clustering.cluster_vbx` (ein *Modulattribut*). Beide Patches sind global
  und an **ein** `diagnose`-dict gebunden. Zwei parallele Dateien: der `delattr`-Rückbau
  der einen entfernt den Patch der anderen, und die Diagnose landet in der falschen
  Sidecar-Datei. Das ist exakt die Diagnose aus #275, die dann still falsch würde.
- Beide GPU-Phasen (Transkription und Diarisierung) rechnen auf **derselben** Karte.

**Und: die Dauer ist unvermessen.** `cmd_diarize` druckt keine Zeit — nur „n Datei(en)
diarisiert". Wie groß der Kuchen ist, den man hier teilen würde, weiß niemand.

### 1.3 Transkription — drei unabhängige Gründe gegen den naiven Weg

**Grund A — es bringt am Modell nichts.** `_modell` (`transcribe.py:265`) baut
`WhisperModel(...)` ohne `num_workers`; der Default ist **1** (in der installierten
faster-whisper 1.2.1 nachgesehen). CTranslate2 hat damit *einen* Ausführungsslot —
parallele `transcribe()`-Threads reihen sich dort in eine Warteschlange. Threads ohne
`num_workers>1` kosten Overhead und liefern keinen Durchsatz.

**Grund B — der naive Weg korrumpiert Transkripte.** `_transkribiere_datei`
(`transcribe.py:390-402`) setzt für mehrsprachige Dateien `m.model = proxy` — ein Attribut
des **geteilten** Modells. Zwei Dateien parallel: die einsprachige Datei B rechnet mit dem
Anker von Datei A. Der `finally`-Kommentar dort beschreibt genau diesen Schaden bereits
für den *sequentiellen* Fall („ein hängengebliebener Proxy klemmte die nächste,
einsprachige Datei auf eine fremde Ankersprache") — Parallelität macht ihn zur Regel statt
zum Ausnahmefall. Zusätzlich sammelte `proxy.fenster` dann die Fenster **aller** parallelen
Dateien in ein `window_languages`.

**Grund C — die Jobebene sperrt ohnehin.** `jobs.GPU_KINDS = ("transcribe",)` lässt global
nur *einen* transcribe-Job zu, und `_active` dedupliziert je `(Projekt, Art)`.

**Der Hebel, der ohne Parallelität wirkt:** `BatchedInferencePipeline` ist in
faster-whisper 1.2.1 vorhanden und batcht die 30-s-Fenster **einer** Datei
(`batch_size=8` Default). Zwei Fallstricke, am Signaturvergleich abgelesen:
`vad_filter` steht dort auf `True` (bei `WhisperModel.transcribe`: `False`) und
`without_timestamps` auf `True` (dort: `False`) — die Ergebnisse wären ohne Angleichung
**nicht** vergleichbar. Und ob der `_Sprachschwelle`-Proxy im batched Pfad überhaupt
gerufen wird, ist offen. Das ist eine **Messaufgabe**, kein Refactor.

---

## 2. Was fehlt, bevor irgendetwas gebaut wird

**Es gibt keine Messung der Phasenverteilung.** Was heute im Log steht:

- `transcribe.py:509` druckt `dt` **pro Datei** ✔
- `cmd_diarize` druckt **keine** Dauer ✘
- die Korrektur druckt **keine** Dauer ✘ (nur `→ Korrigiere …` / `✓ … fertig`)

**Hergeleitet, NICHT gemessen:** Bei 17× Echtzeit (CLAUDE.md, RTX 5080, large-v3) kostet
ein 10-Minuten-Interview ~35 s Transkription. Ein Korrekturblock ist ein LLM-Aufruf im
Minutenbereich, `CHUNK_SEGMENTS=150`, plus Verify — bei derselben Datei also ein
Vielfaches davon. Daraus folgt die *Erwartung*, dass die Korrektur die Wandzeit
dominiert. **Belegt ist das nicht**, und die Diarisierung fehlt in der Rechnung ganz.

Genau darum steht Stufe 0 vor allem anderen.

### 2.1 Erster Messwert (2026-08-23, Wegwerf-Projekt)

Stufe 0 ist gebaut; ein Lauf am echten Pfad (`python -m webtool.correct run`, eigenes
`TRANSKRIBOR_PROJEKTE` im Scratchpad, danach gelöscht) liefert:

```
⏱ probe: Korrektur 22s, Verify 35s
⏱ Phasen: diarisieren 0s · vorbereiten 0s · glossar 0s · korrigieren 57s · gesamt 57s (parallel=8)
```

**Der Treue-Pass kostet mehr als die Korrektur selbst** — 35 s gegen 22 s. CLAUDE.md sagt
dazu bisher „verdoppelt die Opus-Aufrufe pro Datei"; bei der *Zeit* ist es mehr als eine
Verdopplung. Das ist der erste belastbare Grund, `--no-verify` als bewusste
Tempo-Entscheidung zu behandeln statt als Randnotiz.

**Was diese Zahl NICHT trägt:** eine Datei, vier Segmente, ohne Audio (Diarisierung
übersprungen) und ohne `.raw.txt` (Glossar übersprungen). Sie belegt, dass die Messung
funktioniert und dass Verify teuer ist — sie ist **keine** Verteilung über ein echtes
Projekt. Die steht noch aus, und sie ist der Eingang zu Stufe 2 und 3.

---

## 3. Plan, gestaffelt

### Stufe 0 — Die drei Phasen drucken ihre Dauer  *(Pflicht, ~10 Zeilen)*
`cmd_diarize` pro Datei und als Summe, `_correct_one` pro Aufruf, `cmd_run` je Phase.
Danach **ein** echter Lauf auf einem Wegwerf-Projekt mit 3–4 Aufnahmen → die Verteilung
steht fest, und die Stufen 2/3 entscheiden sich an Zahlen statt an Vermutung.
Nebennutzen: die Zeilen bleiben dauerhaft im Log und machen jede spätere Regression sichtbar.

### Stufe 1 — Der Korrektur-Deckel wird bedienbar  *(bester Ertrag pro Zeile)*
1. `TRANSKRIBOR_PARALLEL` in `.env.example` **dokumentieren** (kostet nichts, wirkt sofort).
2. In `settings.job_env()` aufnehmen + Feld auf der Einstellungsseite, damit er ohne
   Serverneustart und ohne Dateihantieren einstellbar ist.
3. **Kein höherer Default.** Beim Abo ist die Zahl eine Kontingent-Entscheidung; der
   Hilfetext benennt das (mehr Slots = schneller fertig *und* schneller verbraucht).

**Nicht gebaut:** getrennte Deckel für Abo und API. Erst relevant, wenn ein API-Key läuft
— heute nicht der Fall.

### Stufe 2 — Diarisierung parallelisieren  *(nur wenn Stufe 0 sie relevant misst)*
Der Blocker ist der globale Sonden-Patch. Der saubere Weg: das `diagnose`-Ziel
threadlokal führen (`threading.local()`), Patch **einmal** setzen statt pro Aufruf, Rückbau
erst am Ende des Laufs. Beide Zweige testen — der ungepatchte Fall (`diagnose=None`) muss
unberührt bleiben.
**Vorher zu klären:** ob zwei pyannote-Läufe auf einer GPU überhaupt schneller sind als
einer. Wenn das Modell die Karte schon sättigt, ist der ganze Umbau umsonst — dieselbe
Frage wie bei den neun toten Hebeln aus der Diarisierungs-Arbeit.

**Billigere Alternative, die zuerst zu prüfen ist:** die Diarisierung *pro Datei* in den
Korrektur-Thread ziehen, statt sie als Sperr-Prep vor allem laufen zu lassen. Dann
versteckt sie sich hinter der ersten LLM-Wartezeit, ohne echte Parallelität. Hindernis:
`cmd_prep` webt die Cluster ein und läuft heute nach `cmd_diarize` für alle Dateien.

### Stufe 3 — Transkription  *(zuletzt, und anders als gefragt)*
**Nicht** über Dateien parallelisieren (Gründe A/B/C oben). Stattdessen
`BatchedInferencePipeline` an *einer* echten Aufnahme messen, mit angeglichenen Defaults
(`vad_filter=False`, `without_timestamps=False`, `word_timestamps=True`) gegen den heutigen
Weg — Kriterium ist **Segmentzahl und Worttreue**, nicht nur Sekunden. Gewinnt sie:
einbauen mit dem heutigen seriellen Weg als Rückfall für mehrsprachige Dateien, weil der
`_Sprachschwelle`-Proxy dort nicht greift.

Falls doch Dateiparallelität: dann zwingend `num_workers>1` **und** ein eigenes
`WhisperModel` je Thread (oder ein Lock um den Proxy-Abschnitt) — sonst Grund B.

---

## 4. Was bewusst nicht in den Plan kommt

- **Mehrere `transcribe`-Jobs gleichzeitig** (`GPU_KINDS` aufweichen): eine GPU, ein
  3-GB-Modell je Job. Das tauscht Durchsatz gegen VRAM-Druck.
- **Ein `correct`-Job je Datei statt je Projekt**: das gemeinsame Glossar ist der Grund,
  warum Schreibweisen über Dateien konsistent bleiben. Aufgeteilt wäre es pro Datei neu.
- **Den Verify-Pass abschalten**, um zu halbieren: das ist keine Parallelisierung,
  sondern weniger Prüfung.

---

## 5. Messungen vom 2026-08-23 (nach dem Merge von PR #343)

Alles an **echtem Material** aus `projekte/` (in ein Wegwerf-Projekt kopiert, nie
zurückgeschrieben), RTX 5080, `large-v3`.

### 5.1 Diarisierung — Stufe 2 ist damit beantwortet: NICHT bauen

| Material | Dauer | Faktor |
|---|---|---|
| 4 Aufnahmen (je ~3–5 Min) | 18 s gesamt (erste 10 s inkl. Modell-Laden, dann 2–3 s je Datei) | — |
| 1 Aufnahme, 21,7 Min | **24 s** | ~54× Echtzeit |

Die Diarisierung skaliert linear mit ~1 s pro Audiominute. Für ein Projekt mit 132 Min
Material sind das **~2,5 Minuten** — gegen eine Korrektur, die pro Datei Minuten braucht.

**Parallelisierung würde 2–4 % der Laufzeit sparen** und dafür den globalen Sonden-Patch
threadlokal machen müssen, also das Risiko tragen, die Diagnose aus #275 still falsch zu
machen. Das Verhältnis stimmt nicht. Issue #345 ist damit **gemessen erledigt**, nicht
offen.

### 5.2 `BatchedInferencePipeline` — messbar schneller, aber eine Qualitätsentscheidung

An der 21,7-Min-Aufnahme, sonst identische Decoder-Parameter:

| | Dauer | Faktor | Segmente | Wörter | letztes Segment |
|---|---|---|---|---|---|
| seriell (heute) | 80,0 s | 16,3× | 411 | 2868 | 1300,6 s |
| batched + VAD | **28,7 s** | **45,3×** | 277 | 2596 | 1116,6 s |

**`vad_filter=True` ist keine Wahl, sondern Pflicht:** ohne VAD wirft
`BatchedInferencePipeline` `RuntimeError: No clip timestamps found`. Der Plan nahm oben an,
man könne die Defaults angleichen — **das geht nicht**, und `_opts` schaltet VAD bewusst ab
(`test_opts_schaltet_vad_aus`).

Zwei Sorgen aus Abschnitt 1.3 sind damit geprüft, eine davon **entkräftet**:

- **Die Zeitachse stimmt.** faster-whisper mappt VAD-Zeiten zurück
  (`restore_speech_timestamps`); sechs Stichproben über die ganze Aufnahme liegen unter
  0,3 s Abweichung. Eine frühere Messung „Median 92 s Versatz" war ein **Artefakt des
  Vergleichs** (Segment #i gegen #i bei unterschiedlicher Segmentierung) — nicht des Codes.
- **Der Wortverlust liegt überwiegend im Halluzinationsbereich.** Von 22 Fenstern à 60 s
  haben nur zwei unter 60 % der Wörter, beide bei 18–19 Min — dort erfindet der serielle
  Lauf 24× „Danke auch dir." über Stille, was VAD wegschneidet. Das ist eine
  *Verbesserung*, keine Verschlechterung.

**Was offen bleibt und gegen einen Einbau ohne Rückfrage spricht:** die Segmentierung wird
gröber (411 → 277), und ob die verbleibende Wortdifferenz *ausschließlich* Halluzination
ist, ist an **einer** Datei nicht belegt. Die Transkription ist die Grundlage von allem —
„eine Passage, die Whisper nie gelesen hat, kann niemand mehr zurückholen".

Und der Ertrag ist begrenzt: die Transkription ist ohnehin die kürzeste Phase. 51 s Gewinn
an einer 21,7-Min-Aufnahme, gegen eine Korrektur im Minutenbereich.

**Empfehlung: als Wahlmöglichkeit anbieten, nicht als Standard umstellen** — und vorher an
mehreren Aufnahmen messen. Issue #346 trägt die Zahlen.
