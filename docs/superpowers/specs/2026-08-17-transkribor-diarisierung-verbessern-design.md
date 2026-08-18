# Sprechertrennung substanziell verbessern — Design

**Stand:** 2026-08-17 · **Auslöser:** Issues #266, #267 sowie Marcus' Auftrag „mache alles was
nötig ist um die Diarisierung substanziell zu verbessern“ · **Vorgänger:** #264 (PR #265, Sprecherzahl pro Datei)

Jede Zahl in diesem Dokument trägt eine Herkunft: **GEMESSEN** (an echtem Material, in dieser
Arbeit), **RECHERCHIERT** (fremde Quelle, nicht nachgeprüft) oder **HERGELEITET** (aus dem Code
gelesen, nicht ausgeführt). Die Trennung ist nicht Zierde — die häufigste Fehlerklasse dieses
Repos ist eine Behauptung, die schärfer ist als ihre Grundlage.

---

## 1 · Ausgangslage

### 1.1 Was gemessen wurde

Über den vollständigen echten Bestand (`%APPDATA%\Transkribor\projekte`, **20** Aufnahmen mit
`.diar.json`), rein lesend:

| Befund | Wert | Herkunft |
|---|---|---|
| Rhyathlon (Kameramikrofon): Dateien mit genau **2** Clustern | 9 von 10 | GEMESSEN |
| Rhyathlon: Dateien, in denen das LLM mindestens einen Cluster aufbrechen musste | **10 von 10** | GEMESSEN |
| Einzelsprecher-Video (`test/I Built DaVinci …`, 298 Segmente, **ein** Name) → Cluster | **2** | GEMESSEN |
| Monolog (`test/Behind the Scenes … FX5`, 71 Segmente, **ein** Name) → Cluster | 1 — **richtig** | GEMESSEN |
| Whisper-Segmente mit Overlap zu >1 Cluster (`00114307`) | 12 / 57 = 21 % | GEMESSEN |
| Rhyathlon-Korpus gesamt | 19 Min, 48 kHz, Dual-Mono | GEMESSEN |
| Wort-Zeitstempel in der Roh-JSON | vorhanden (`words[].start/end/probability`) | GEMESSEN |

Die dritte Zeile ist der einzige Befund dieser Tabelle, bei dem Akustik und Inhalt sich
eindeutig widersprechen **und** die Wahrheit feststeht: ein durchgehend allein sprechender
Mensch kann nicht zwei Sprecher sein. Die vierte ist die Gegenprobe dazu — derselbe Fall,
richtig gelöst. Beide Dateien sind Monologe; das war zu prüfen und nicht aus den Titeln zu
schliessen (ein erster Entwurf dieser Spec hielt die vierte für ein gescheitertes
Zwei-Personen-Interview, weil der Titel „with Cinematographer …“ lautet).

`min_speakers=2` ist der Fussboden, auf dem 9 von 10 Rhyathlon-Dateien landen. Zusammen mit
#264 („die vorgegebene Zahl trifft, und zwar exakt“) liegt die Vermutung nahe, die **Zählung**
sei der Fehler und die Trennung intakt. **Diese Vermutung ist offen** — sie liess sich mit dem
vorhandenen Material weder belegen noch widerlegen, und der Versuch ist selbst lehrreich
(1.3).

### 1.2 Was aus den Issues übernommen und dabei korrigiert wurde

**#267 nennt als erste mögliche Richtung, dem Korrektur-Prompt beizubringen, dass zwei
akustische Cluster derselbe Mensch sein dürfen. Diese Regel steht bereits im Code** — in
`_correct_prompt` Regel 4, seit Commit `328ebf2` (dem ursprünglichen Stufe-3-Commit), also
schon während der Messung, die #267 beschreibt. Die Richtung ist damit nicht „bauen“, sondern
„vervollständigen“: die Erlaubnis fehlt in `_verify_prompt` (Z. 549), `_light_prompt` (588)
und `_summary_prompt` (607). **Der Treue-Pass schreibt zuletzt** und verlangt dort „konsistent
pro akustischem (Sprecher N)-Cluster … Fehlzuordnungen korrigieren“ — dieselbe Falle, an der
`[Musik]` und die Fremdsprachen-Regel je schon einmal hingen (beide in der Wurzel-CLAUDE.md
festgehalten). HERGELEITET aus dem Prompttext; ob der Verify-Pass die Zusammenlegung wirklich
zurückdreht, ist **nicht gemessen** und gehört in die Phase-1-Prüfung.

**#266 vermutet, die Reparatur brauche einen neuen Endpunkt-Vertrag. Sie braucht keinen.**
`GET /api/projects/{p}/files/{base}/einstellungen` trägt mit `sprecher_max` bereits einen
reinen Server-Wert mit, aus exakt derselben Begründung (die Oberfläche soll die Regel nicht ein
zweites Mal führen). HERGELEITET aus `app.py:359-379`.

### 1.3 Zwei tote Hebel, eine offene Frage — und warum

Alles hier stammt aus dieser Arbeit und wurde vor dem Design an echtem Material geprüft. Es
steht hier, damit niemand dieselben Wege ein zweites Mal geht.

*(Sieben weitere Hebel sind am 2026-08-18 dazugekommen, sechs davon ebenfalls tot — siehe 1.6.)*

**(a) „Nur die Zählung versagt, die Trennung ist intakt.“ — OFFEN, nicht widerlegt.** Der
naheliegende Beleg wären zwei Dateien gleicher Struktur (je 2 Cluster, je 2 Namen):
`US Car Treff/Roger Meili` erreicht **97 %** Übereinstimmung, `Rhyathlon/00111679` nur
**58 %** — was nach „die Trennung versagt am Kameramikrofon“ aussieht. **Dieser Beleg trägt
nicht:** genau bei `00111679` ist die Referenz kaputt (siehe d). Ein Vergleich, dessen eine
Hälfte auf einem Sammel-Etikett steht, kann die Frage nicht beantworten. Sie bleibt offen und
ist eine der ersten, die Phase 0 beantwortet.

**(b) „Zuordnung auf Wortebene holt die 21 % Grenz-Segmente.“ — TOT.** Die Wort-genaue
Zuordnung (Mehrheit der Wörter je Segment, Wort-Zeitstempel liegen vor) **ändert 0–3 Segmente
je Datei** — bei 57 bis 121 Segmenten. Diese Zahl ist referenzunabhängig und damit belastbar:
der Hebel bewegt schlicht fast nichts. Ergänzend, aber referenzabhängig und deshalb schwächer:
das V-Measure sinkt dabei auf zwei von vier Dateien (`00114307` 0,844 → 0,693; `Roger Meili`
0,718 → 0,676). GEMESSEN.

**(c) „Der Fehler sitzt auf den Grenz-Segmenten.“ — TOT, zusammen mit (b).** Die
Grenz-Segmente tragen absolut wenige Fehler: `00090000` 1, `00114307` 1, `Roger Meili` 2 —
je Datei. Selbst wenn man sie alle heilte, wäre der Gewinn einstellig. Zusammen mit (b), das
zeigt, dass die naheliegende Heilung sie gar nicht bewegt, ist die Richtung erledigt.

*(Ein erster Entwurf belegte (c) mit `00111679` — „von 21 Fehlern sitzen 18 auf sauberen
Segmenten“. Diese Datei ist als Beleg unbrauchbar, siehe (d); die obige Fassung stützt sich
nur noch auf die drei Dateien mit plausibler Referenz.)*

**(d) Der Fehler in der eigenen Messung, der stellvertretend für das ganze Problem steht.**
Die erste Sonde mass die Übereinstimmung zwischen Clustern und den Sprechernamen aus
`edit.json` über eine ungarische Zuordnung und variierte dabei `num_speakers` von 2 bis 6. Die
Quote fiel mit steigendem k — was wie ein Befund aussah und **rechnerisch erzwungen** war: die
Referenz hat nur 2–4 verschiedene Namen, überzählige Cluster bleiben unpaarig. Die Metrik war
gegen grosses k voreingenommen; die Spalten k≥4 sagen nichts.

Der zweite, schwerere Fehler steckt in der Referenz selbst. `00111679` erreicht ein V-Measure
von **0,078**, was nach Totalversagen aussieht. Der Blick in die Datei zeigt die Ursache: das
LLM hat **eine ganze Gruppe unter ein Sammel-Etikett gelegt** — „Team Ikotec“ (52 Segmente)
sind mehrere Personen, die einander ins Wort fallen („Kommt schnell!“, „Wo? Pia!“, „Darf ich
mal etwas sagen?“). Zwei akustische Cluster gegen ein Gruppen-Label zu messen erzeugt
zwangsläufig Rauschen. **Nicht pyannote hat versagt, sondern die Referenz.**

### 1.4 Die Schlussfolgerung, auf der dieses Design steht

**Die Sprechernamen aus `edit.json` sind keine Wahrheit.** Sie stammen vom LLM, das sie teils
aus denselben Clustern abgeleitet hat, und sie kollabieren Gruppen. Eine Metrik darauf misst
Übereinstimmung, nicht Richtigkeit.

Damit ist die Reihenfolge festgelegt: **erst eine belastbare Referenz und ein Messwerkzeug,
dann Änderungen.** Ohne das wäre jede Aussage über „besser“ eine Behauptung — und dieses Repo
hat für genau diese Fehlerklasse den höchsten Preis bezahlt.

### 1.5 Recherche zur Modelllandschaft

RECHERCHIERT (Herstellerangaben und Modellkarten, von mir **nicht** nachgemessen):

- **NVIDIA Sortformer** ist in allen veröffentlichten Varianten (`diar_sortformer_4spk-v1`,
  `diar_streaming_sortformer_4spk-v2`, `-v2.1`) auf **4 Sprecher** gedeckelt; die Modellkarte
  nennt Leistungsabfall ab 5. Die schwerste Aufnahme des Bestands hat 5 Personen (#267).
  **Schlechte Passung**, trotz Marcus' Freigabe für grosse Abhängigkeiten.
- NeMos alternativer Weg ohne Sprecherlimit ist die **kaskadierte** Pipeline (MarbleNet-VAD +
  TitaNet-Einbettungen + Spektral-Clustering) — architektonisch dieselbe Familie wie pyannote.
- **pyannote `precision-2`** ist laut Hersteller im Mittel 28 % genauer als `community-1`,
  läuft aber **als Cloud-Dienst**. Marcus hat entschieden: das Audio verlässt den Rechner
  nicht. **Ausgeschlossen.**
- **DiariZen** (BUT Brno, EEND-VC: strukturell beschnittener WavLM-Large-Encoder +
  Conformer-Powerset-Backend + VBx/PLDA) ist der einzige lokale Kandidat, für den ein
  Vorsprung **in veröffentlichten Benchmarks** auf einer *ähnlichen* Bedingung belegt ist.
  Benchmarktabelle des Repos selbst, DER %:
  **AMI-SDM** (ein entferntes Mikrofon) 22,4 → **13,9**, **AliMeeting far** 24,4 → **10,8**,
  DIHARD3 21,7 → 14,5. Fremdvergleich über 196,6 h in fünf Sprachen **inklusive Deutsch**:
  13,3 % gegen 11,2 % des Cloud-Dienstes pyannoteAI
  ([arXiv:2509.26177](https://arxiv.org/abs/2509.26177)).

  **Der Vergleich läuft gegen `pyannote 3.1`, nicht gegen `community-1`** — und das verkleinert
  den Abstand erheblich: community-1 meldet auf derselben Aufgabe **AMI-SDM 19,9 %** gegen
  3.1s 22,4 %. Der ehrliche Abstand ist also 19,9 → 13,9, nicht 22,4 → 13,9. Auf **unserem**
  Material ist gar nichts gemessen. HERGELEITET, dass der Mechanismus passt (der
  WavLM-Encoder ersetzt genau das schwache Frontend von community-1 — `PyanNet`: SincNet +
  4× BiLSTM); **bis zu einem Referenzlauf auf Rhyathlon bleibt C8 eine Hypothese.**
  **Drei Haken, und der erste ist der harte: die Gewichte sind CC BY-NC 4.0** (Code MIT) —
  bei einem verteilten Installer ist „nicht kommerziell“ eine Produktentscheidung, keine
  Fussnote, und sie gehört **vor** die Messung, nicht danach. Dazu: **kein `num_speakers`**
  (die Zahl fällt aus VBx) — das Feld aus #264 wäre weg. Und die Grenze von zwei
  *gleichzeitigen* Sprechern hebt es nicht. RECHERCHIERT, nicht nachgemessen.
- `community-1` ist damit weiterhin das beste *lokale* Modell und bleibt die Grundlage.

### 1.6 Nachtrag 2026-08-18 — sieben weitere Hebel geprüft, fünf lokal gemessen tot

Anlass war Marcus' Frage, ob die **Geschwindigkeits-Optimierungen** der letzten Wochen die
Sprechererkennung verschlechtert haben. Die Antwort ist nein — und der Weg dorthin hat
nebenbei drei weitere Hebel erledigt, darunter den in C2 noch als ungeprüft geführten.

Gemessen wurde an echtem Rhyathlon-Material **ohne** Referenz: verglichen wird die
**Clusterzahl** bzw. der Anteil gewechselter Etiketten, beides referenzunabhängig. Damit
gelten dieselben Vorbehalte wie in 1.3(b) — belastbar für „bewegt nichts“, nicht für „ist
besser“.

**(e) „Der Dekodier-Weg hat sich mit faster-whisper geändert.“ — TOT.** Vor `cdb57c0` lud
`diarize._load_waveform` über `whisper.load_audio` (ffmpeg-Subprozess, s16le, also
**int16-quantisiert**), heute über `faster_whisper.decode_audio` (PyAV, float32 ohne
Zwischenstufe). Die Vermutung, die alte Quantisierung verändere pyannotes Eingabe, ist falsch:
die Samples sind **bit-identisch** (`np.array_equal` True, `max_abs_diff` 0,0, vier Dateien),
Cluster und Turns folglich ebenfalls. **Negativkontrolle:** derselbe Weg zweimal ergibt
V = 1,000 — pyannote ist auf identischer Eingabe deterministisch, der Rauschboden ist **null**,
der Test hätte jeden echten Unterschied gesehen. GEMESSEN.

**(f) „Die ASR-Engine bestimmt die Segmentgrenzen, auf die die Cluster abgebildet werden.“ —
TOT.** openai-whisper large-v3 mit identischen Decoder-Parametern gegen faster-whisper:
`00097495` liefert **93 statt 61** Segmente bei **0,68 s statt 1,24 s** Median-Länge — und der
Anteil der Redezeit in Segmenten, die eine Cluster-Grenze überspannen, bleibt **gleich**
(11,86 % gegen 11,78 %; `00111679` 9,93 % gegen 9,93 %). Fast doppelt so feine Segmente
ändern nichts. Der Text ebenfalls: 288 gegen 285 Wörter bei 89,7 % Wortübereinstimmung.
GEMESSEN.

*(Zwei weitere Tempo-Wege scheiden ohne Messung aus, weil sie das Material gar nicht
erreichen: `CHUNK_SEGMENTS = 150` — die grösste Rhyathlon-Datei hat 122 Segmente, die
Block-Parallelität aus `e16a48e` war hier nie aktiv; und `compute_type="float16"` auf cuda
entspricht dem früheren `fp16=True`, quantisiert wird nur `int8` auf der CPU.)*

**(g) „Überlappendes Sprechen ist die dominante Fehlerquelle.“ — als Zeitanteil richtig, als
Etikettfehler fast folgenlos.** 0,97 %–14,90 % der Redezeit hat zwei gleichzeitig aktive
Cluster; rechnet man den Grenzverlust ohne diese Bereiche, erklärt die Überlappung **50–91 %**
davon. Praktisch ändert das aber fast nichts: community-1 berechnet bei **jedem** Lauf eine
zweite, überlappungsfreie Annotation (`exclusive_speaker_diarization`,
`speaker_diarization.py:701-713` — `count` auf 1 geklemmt, dann rekonstruiert, die Auswahl
trifft also frame-genau das Segmentierungsmodell). Sie statt der überlappenden zu nehmen
ändert **9 von 388 Segmenten (2,3 %)** und die Clusterzahl in **keinem** der sechs Fälle. Die
Sekunden-Mehrheitsregel in `assign_clusters` wählt in 97,7 % der Fälle bereits dasselbe.
GEMESSEN.

> **Die Lehre reicht über diesen Fall hinaus.** Der „Grenzverlust“ misst *nicht darstellbare
> Zeit*, nicht *falsche Etiketten* — eine Metrik, die beides gleichsetzt, überzeichnet den
> Fehler um mehr als eine Grössenordnung. Was der Vergleich zeigt, ist ausschliesslich, dass
> die überlappungsfreie Annotation **fast dieselben Ausgabesegmente** liefert. **Ob** das
> dominante Etikett das richtige ist, bleibt ohne Referenz offen — die naheliegende Annahme
> („Whisper transkribiert die dominante Stimme, also stimmt deren Name“) ist genau die Sorte
> Herleitung, die dieses Design nicht mehr als Beleg gelten lässt. Beantwortbar erst nach
> Task 8. Aufgefallen ist der Unterschied ohnehin erst durch die Gegenprobe, nicht durch
> Nachdenken über die Metrik.

**(h) „Unser eigenes `min_speakers=2` erzwingt die vielen 2er-Ergebnisse.“ — TOT.** Gut
begründet und falsch. `clustering.py:627-628` setzt bei `auto_num_clusters < min_clusters`
tatsächlich `num_clusters = min_clusters` und rechnet dann KMeans; kollabierte VBx auf 1,
wäre unser eigener Default die Ursache der 2er-Ergebnisse. Gegenprobe über sechs Dateien, mit
und ohne das Argument: **identische Clusterzahl in allen sechs** (3/3, 2/2, 2/2, 3/3, 2/2,
2/2). VBx kollabiert nicht auf 1, es findet wirklich 2 bzw. 3. GEMESSEN.

**(i) „`Fa` ist der ungeprüfte Knopf.“ — GEPRÜFT, und er zerstäubt.** Auf echtem Material
schlimmer als `Fb`:

| Datei | Fa 0,07 (heute) | 0,15 | 0,20 | 0,25 | 0,30 |
|---|---|---|---|---|---|
| `00114307` (real 5 Sprecher) | **3** | 10 | 11 | 13 | 14 |
| `00111679` | **2** | 9 | 12 | 13 | 17 |
| `00090000` | **3** | 10 | 10 | 11 | 11 |
| `00097495` | **2** | 5 | 7 | 9 | 9 |
| `00104647` | **2** | 2 | 3 | 3 | 4 |

Schon der mildeste Schritt auf 0,15 sprengt `00114307` von 3 auf **10** Cluster. GEMESSEN.

> **Warum das hier so ausführlich steht.** Die Empfehlung `Fa = 0,25` kam aus einer Recherche
> mit einem *synthetischen* Sweep, der überzeugend aussah: sauberes Material bleibt bei k=4,
> degradiertes steigt von 1 auf 4 zurück. Die Daten stammten aus **VBx' eigenem
> Generativmodell** und erfüllen damit per Konstruktion genau die Annahmen, die halliges
> Interview-Audio verletzt. Das ist dieselbe Fehlerklasse wie die an TTS kalibrierte
> Sprachschwelle (0,938 synthetisch gegen 0,565 an echtem Material). **Wer einen
> Clustering-Parameter kalibriert, misst an ECHTEM Material** — synthetische Daten ordnen
> höchstens den Mechanismus.

**(j) `min_active_ratio = 0,2` — WIRKSAM, aber nicht kalibrierbar.** Der einzige neue Hebel,
der in die richtige Richtung zeigt. `clustering.py:116`: ein Sprecher-Embedding kommt nur ins
Clustering, wenn der Sprecher **≥ 0,2 × 589 Frames ≈ 2 s allein gesprochene Zeit** in einem
10-s-Fenster hat — `single_active_mask` zählt nur Frames mit **genau einem** Aktiven,
Überlappung frisst das Budget also doppelt, und `embedding_exclude_overlap: true` nullt
dieselben Frames ein zweites Mal. Fest verdrahtet (`VBxClustering.__call__` ruft
`filter_embeddings` ohne das Argument, `clustering.py:584`) und **nicht über die config
erreichbar**.

Gezählt, wie viele aktive Sprecher-Fenster der Filter verwirft:

| Datei | aktive Slots | durchgelassen | verworfen | Cluster bei 0,20 / 0,05 / 0,00 |
|---|---|---|---|---|
| `00114307` (real 5) | 287 | 195 | **92 (32 %)** | 3 / 3 / **4** |
| `00111679` | 214 | 152 | **62 (29 %)** | 2 / **3** / **4** |
| `00097495` | 219 | 150 | **69 (32 %)** | 2 / **3** / 3 |
| `00090000` | 449 | 378 | **71 (16 %)** | 3 / 3 / 3 |

**Über alle vier Dateien kommen 25 % aller Sprecherpräsenz nie beim Clustering an** — in drei
von vier Dateien 29–32 %, in `00090000` nur 16 %. Das ist der erste gemessene Mechanismus für
die Unterzählung. Das Senken holt ein bis zwei Cluster zurück,
**überschiesst aber** (`00097495` von 2 auf 3) und schliesst die Lücke trotzdem nicht
(`00114307` 4 statt real 5). Ohne Referenz je Aufnahme derselbe Zerstäuber-Charakter wie `Fb`,
nur milder — deshalb Kandidat (C7), nicht Fix.

Upstream stützt die Richtung: das Papier hinter dieser Implementierung
([arXiv:2510.19572](https://arxiv.org/abs/2510.19572), §3.2) schreibt zu genau diesem Filter,
„filtering below 4 s can risk discarding most of the speech from less dominant speakers“.

**(k) Enthallen/Entrauschen vor der Diarisierung (C5) — externe Evidenz gemischt, lokal
NICHT gemessen.** Der einzige Punkt in 1.6 ohne eigene Messung; er bewertet C5 deshalb auch
nicht abschliessend.

RECHERCHIERT: an verrauschten Klassenzimmer-Aufnahmen
([arXiv:2505.10879v2](https://arxiv.org/abs/2505.10879), Tabelle 1, DER %) **senkt** Entrauschen
den Fehler in **drei von vier** Bedingungen — ClassBank 2 Sprecher 50,5 → 36,7, ClassBank alle
64,6 → 58,1, MPT 2 Sprecher 33,2 → 26,8 — und **hebt** ihn nur im MPT-All-Speaker-Setup, dort
allerdings deutlich (71,3 → **82,2**).

**Der für uns relevante Teil zeigt trotzdem in die falsche Richtung:** die
**Verwechslungsrate steigt in allen vier Bedingungen**. Der DER-Gewinn kommt aus weniger
verpasster Sprache (MISS 39,4 → 11,4), erkauft mit mehr Fehlalarm (FA 7,0 → 13,9) und eben mehr
Verwechslung. Unser gemessener Engpass ist die **Zuordnung**, nicht die Detektion — die
Tauschrichtung passt also schlecht. Die Autoren haben Inferenz-Entrauschung verworfen
(„denoising inadvertently suppressed children's speech segments“); leise Sprecher wegzuputzen
ist bei Kameramikrofon genau das Problem.

**Was die Studie NICHT abdeckt:** sie fährt eine **NeMo**-Pipeline auf **englischen
Klassenzimmerdaten** — nicht `community-1`, nicht Schweizerdeutsch, nicht unser Material.
Schwach bestätigend:
[pyannote-audio#1053](https://github.com/pyannote/pyannote-audio/issues/1053) (DER stieg mit
`noisereduce`, keine Zahlen im Thread, keine Maintainer-Antwort). **Abschliessend zu bewerten
erst nach der Referenzmessung** — bis dahin nachrangig, nicht ausgeschlossen.

**WPE-Enthallung ist zusätzlich strukturell tot:** sie arbeitet mehrkanalig, und die Kanäle
dieser Aufnahmen sind bit-identisch (Dual-Mono, in #264 gemessen) — es gibt keine zweite
Informationsquelle.

*Nebenbefund gegen einen kursierenden Zahlenwert: „Demucs-Vokaltrennung bringt 12,41 Punkte
DER“ ist falsch zugeordnet. Im Papier ([arXiv:2602.21741](https://arxiv.org/html/2602.21741v1))
wurde Demucs **nur für ASR** eingesetzt; der Diarisierungsteil sagt wörtlich „No additional
denoising or filtering was applied“. Die Punkte stammen aus pyannote-Feinabstimmung.*

**Was 1.6 an der Schlussfolgerung aus 1.4 ändert: nichts.** Die Bilanz, genau ausgezählt:
**fünf** Hebel lokal gemessen tot (e, f, h, i — sowie g, dessen Wirkung mit 2,3 % praktisch
verschwindet), **einer** wirksam aber unkalibrierbar (j), **einer** nur extern belegt und
lokal ungemessen (k, deshalb offen). Alle lokalen Messungen liefen **ohne** Referenz, sind
also nur auf „bewegt (nichts)“ belastbar, nicht auf „ist besser“ — dieselbe Grenze wie in
1.3(b). Die vorgegebene Sprecherzahl aus #264 bleibt der einzige exakte Hebel, und die
Reihenfolge „erst Referenz, dann Änderungen“ steht unverändert.

---

## 2 · Entscheidungen (von Marcus, 2026-08-17)

| Frage | Entscheidung | Folge für dieses Design |
|---|---|---|
| Darf Audio den Rechner verlassen? | **Nein, alles lokal** | `precision-2` und jede Cloud-API fallen weg |
| Wie schwer darf eine neue Abhängigkeit werden? | **Auch gross erlaubt** | C3/C5/C6 sind zulässig — C6 wird trotzdem nur bei belegter Lücke gezogen |
| Woher die Wahrheit? | **8–10 Dateien im Editor korrigieren** | Phase 0 ist finanziert; Segment-Genauigkeit wird messbar |
| Welcher Weg? | **Ansatz A: Messgrundlage, dann gezielt schrauben** | B und C werden *innerhalb* von A geprüft, nicht vorab gesetzt |

---

## 3 · Phase 0 — Messgrundlage

### 3.1 Referenzsatz

Marcus korrigiert die Sprecherzuordnung im Editor. Das setzt `human_edited=true` und erzeugt
Segment-genaue Wahrheit als Nebenprodukt normaler Arbeit — kein Nebenkanal, keine Zeitmarken
von Hand.

**Auswahl** (deckt alle beobachteten Fehlerbilder ab):

| Datei(en) | Segmente | deckt ab |
|---|---|---|
| alle 10 `Rhyathlon/*` | 512 | Kameramikrofon, Unterschätzung, Gruppen |
| `US Car Treff/Roger Meili` | 116 | Ansteckmikrofon, sauberer Zwei-Personen-Fall — **Positivkontrolle** |
| `test/Behind the Scenes … FX5` | 71 | englischer Monolog, heute **richtig** gelöst — **Gegenprobe:** keine Änderung darf hier einen zweiten Sprecher erfinden |
| `test/I Built DaVinci …` | 298 | Einzelsprecher, heute auf 2 Cluster gespreizt — der eine Fall mit feststehender Wahrheit |

Die letzten drei sind bewusst keine schweren Fälle. Eine Änderung, die den Kameramikrofon-Fall
rettet und dabei Monologe oder saubere Zwei-Personen-Aufnahmen verschlechtert, ist keine
Verbesserung — und ohne diese drei im Satz wäre genau das nicht zu sehen.

**Eine Anweisung entscheidet über die Brauchbarkeit:** Gruppenmitglieder brauchen **einzelne**
Namen („Ikotec 1“, „Ikotec 2“), nie ein Sammel-Etikett. Genau daran ist `00111679` als
Messgrundlage gescheitert (1.3d).

**Bekannte Einschränkung, die im Bericht mitgeführt wird:** der Editor zeigt beim Korrigieren
den LLM-Vorschlag vor, der seinerseits von den Clustern beeinflusst ist. Ein Bestätigungs-Bias
ist damit nicht ausgeschlossen. Die Referenz ist deutlich besser als das, was wir heute haben,
aber sie ist nicht unabhängig erhoben — das gehört in jede Aussage, die sich auf sie stützt.

### 3.2 `tools/diar_eval.py`

Drei Unterbefehle:

- **`freeze`** — liest die handkorrigierten `edit.json` und schreibt Sprecherzuordnung je
  Segment-ID samt `start`/`end` nach `eval/referenz.json`. **Das Einfrieren ist nicht Komfort:**
  ohne es wandert das Ziel bei jeder späteren Korrektur mit, und zwei Messläufe wären nicht
  vergleichbar.
- **`run`** — diarisiert den Referenzsatz mit einer gegebenen Konfiguration und schreibt das
  Ergebnis als JSON (ein Lauf = eine Datei, damit Läufe diffbar sind).
- **`vergleich`** — stellt zwei Läufe gegenüber, je Datei und in der Summe.

**Drei Zahlen je Datei:**

| Zahl | misst | Begründung der Wahl |
|---|---|---|
| Sprecherzahl vorhergesagt vs. wahr | die Zählung | #264 hat gemessen, dass nur sie exakt trifft |
| V-Measure (mit Homogenität und Vollständigkeit einzeln) | die Trennung | symmetrisch; die naheliegende Trefferquote ist gegen grosses k voreingenommen (1.3d), Reinheit allein belohnt Über-Clustering |
| zeitgewichtete Sprecher-Fehlerquote | was der Nutzer merkt | Sekunden falsch zugeordneter Rede / Gesamtsekunden |

Die dritte Zahl ist **kein DER**: es fehlen der VAD- und der Overlap-Term, und die Auflösung
ist das Whisper-Segment, nicht der Rahmen. Sie wird deshalb nirgends „DER“ genannt. Der Grund
für diese Auflösung ist, dass sie die Grenze ist, an der das Ergebnis den Nutzer erreicht —
feiner zu messen als das Produkt liefert, misst etwas, das niemand sieht.

**Zwei Eigenschaften, ohne die das Werkzeug selbst zur Fehlerquelle würde:**

1. **Es schreibt nie nach `projekte\`.** Es ruft `diarize.diarize_file` direkt, nie
   `correct.cmd_diarize` — letzteres legt Sidecars in Marcus' echtem Material an und würde
   dessen Zustand während der Messung verändern.
2. **`eval/` ist gitignoriert.** Das sind Interviewinhalte; die Repo-Regel „`projekte\`-Inhalte
   nie committen“ gilt für ihre Kopien genauso. Das *Werkzeug* wird committet und bekommt
   Unit-Tests mit **synthetischen** Daten, damit die CI es prüfen kann, ohne die Aufnahmen zu
   sehen.

**Preis dieser Entscheidung, benannt statt verschwiegen:** die Referenz existiert nur auf
Marcus' Rechner. Kein CI-Lauf und keine spätere Sitzung kann die Messungen ohne sie
reproduzieren — dieselbe Lage wie bei allen bisherigen „an echtem Material gemessen“-Aussagen
dieses Repos.

### 3.3 Ausgangswert

Vor jeder Änderung wird der heutige Stand einmal vollständig vermessen. Ohne diesen Nullpunkt
ist „besser“ nicht definiert.

---

## 4 · Phase 1 — die zwei sicheren Fixes

Unabhängig von der Messung, deshalb ein eigener PR, der nicht auf Phase 0 wartet.

### 4.1 #266 — `TRANSKRIBOR_DIARIZE=0` macht das Feld zum toten Schalter

- `GET …/files/{base}/einstellungen` liefert zusätzlich `diarisierung_aktiv: bool`, gespeist
  aus der **einen** vorhandenen Quelle (`correct._diarize_enabled()`; wird dafür öffentlich).
  Eine zweite Kopie der Regel in `app.py` wäre die Divergenzfalle, gegen die dieses Repo
  mehrfach entschieden hat.
- Die Auskunft ist belastbar, weil `settings.job_env()` nur `WHISPER_MODEL`/`WHISPER_LANG`
  setzt: der `correct`-Subprozess liest exakt den Wert, den der Server meldet. HERGELEITET aus
  `settings.py:225-232`.
- Das Feld wird **deaktiviert statt versteckt** — ein bereits gespeicherter Wert bleibt
  sichtbar, statt kommentarlos zu verschwinden. Der Hilfetext wird getauscht (die heutige
  Zusage „trennt die Stimmen deutlich zuverlässiger“ ist bei abgeschalteter Diarisierung
  schlicht falsch).
- **README:** der Abschnitt „Es hat zu wenige Sprecher erkannt“ (Z. 252 ff.) verspricht dieselbe
  Wirkung und bekommt den Vorbehalt.

### 4.2 #267 — die Zusammenlege-Erlaubnis fehlt in drei von vier Prompts

- Die Regel aus `_correct_prompt` Regel 4 wandert nach `_verify_prompt`, `_light_prompt` und
  `_summary_prompt`.
- Regel 4 selbst wird um den **gemessenen** Hinweis geschärft: bei Kameramikrofon-Aufnahmen
  verteilt die Diarisierung denselben Sprecher regelmässig auf mehrere Cluster; sprechen zwei
  Cluster durchweg in Frageform, ist das derselbe Interviewer.
- **Zu prüfen, nicht anzunehmen:** ob der Verify-Pass eine Zusammenlegung heute wirklich
  zurückdreht, ist HERGELEITET. Der Plan enthält dafür eine Messung an einer Wegwerf-Kopie mit
  vorgegebener Sprecherzahl — findet sie den Effekt nicht, wird die Regel trotzdem
  vervollständigt (Konsistenz über alle Prompts), aber ohne Wirkungsbehauptung.

### 4.3 Bewusst NICHT in Phase 1

`min_speakers = 2 → 1` ist eine Zeile, und die Wurzel-CLAUDE.md führt den heutigen Wert bereits
als falsch („erfindet dort bis heute einen zweiten Sprecher“). Er bleibt trotzdem draussen:
seine Wirkung ist **messbar**, also wird sie gemessen statt zugesagt. Phase 2, Kandidat C1.

---

## 5 · Phase 2 — Kandidaten, jeder einzeln gegen die Referenz

Reihenfolge nach Aufwand. Nur was gegen den Ausgangswert **gewinnt**, bleibt; wer verliert,
wird mit seiner Zahl dokumentiert, damit ihn niemand erneut versucht (wie `threshold`/`Fb` in
#264).

| # | Kandidat | Kosten | Anmerkung |
|---|---|---|---|
| C1 | `min_speakers` 2 → 1 | 1 Zeile | gemessener Fehler auf Einzelsprecher-Material |
| C2 | Clustering-Gitter `Fa`/`Fb`/`threshold` | — | **ERLEDIGT, alle drei tot.** `threshold`/`Fb` in #264, `Fa` in 1.6(i) — er zerstäubt schlimmer als `Fb` |
| C3 | Einbettungs-Modell tauschen | ~30–100 MB | **Der Steckplatz täuscht.** Die VBx-PLDA (`plda/plda.npz`: `lda (256,128)`, `tr (128,128)`) ist an genau den 256-d-Raum von `WeSpeakerResNet34` gebunden — ein anderes Modell bildet in einen Raum ab, den `self.plda(...)` nicht kennt. Das ist ein Umbau (VBx aufgeben oder PLDA neu trainieren), kein Tausch. VERIFIZIERT an den Shapes |
| C4 | Segmentierung (`min_duration_off`, `embedding_exclude_overlap`) | Rechenzeit | billig mitzunehmen |
| C5 | Enthallen/Entrauschen vor `_load_waveform` | ~10 MB | **nachrangig, nicht ausgeschlossen** — 1.6(k): externe Evidenz gemischt (DER besser in 3 von 4 Bedingungen, Verwechslungsrate schlechter in allen vieren), lokal ungemessen |
| C6 | Andere Pipeline (NeMo kaskadiert) | Schwergewicht | **nur** bei grosser Restlücke nach C1–C5 |
| C7 | `min_active_ratio` 0,2 → niedriger (gemessen sind 0,05 und 0,00; **0,08 ist ungemessen**) | 1 Funktion (Monkeypatch, **nicht** über die config erreichbar) | wirksam, aber überschiesst — 1.6(j). Nur gegen eine Referenz sinnvoll |
| C8 | DiariZen statt community-1 | zweites Modell | 1.5 — **erst die CC-BY-NC-Frage entscheiden**, dann messen |

**Vor jedem Modellwechsel (C3, C5, C6) sind drei Dinge zu klären, nicht anzunehmen:**
Weitergabe-Lizenz (das jetzige Modell ist CC-BY-4.0 und steht in `LICENSE-MODELLE.md`),
Lauffähigkeit auf **Apple Silicon** (der Mac-Pfad ist bewusst Hugging-Face-frei), und die
Paketgrösse gegen die 2-GB-Grenze für Release-Assets.

### 5.1 Was jede wirksame Änderung NEU aufmacht

`cmd_diarize` überspringt ein vorhandenes Sidecar anhand von **mtime und Sprecherzahl** (#264).
Ändern wir Modell oder Parameter, gilt ein altes Sidecar weiterhin als frisch: bestehende
Projekte behielten die alte Clusterung — lautlos, mit Erfolgsmeldung. Das ist exakt der
tote Schalter aus #264 über einen neuen Weg.

**Das Sidecar braucht deshalb einen Konfigurations-Fingerabdruck**, und er gehört in denselben
PR wie die erste wirksame Änderung, nicht in einen Nachtrag. Ein Sidecar ohne den Schlüssel
gilt als „alte Konfiguration“ — bestehende Projekte werden damit einmal neu gerechnet, was die
gewollte Folge ist.

---

## 6 · Phase 3 und 4 — ausdrücklich unentschieden

Beide werden **nur** gebaut, wenn die Messung sie rechtfertigt. Sie hier schon zuzusagen wäre
wieder eine Behauptung.

**Phase 3 — Sprecherzahl automatisch.** Falls sich die Zählung als dominanter Fehler zeigt.
Zweistufig: rohes Transkript → LLM schätzt die Personenzahl (die Namen stehen im Text: die
Vorstellungsrunde „Mustafa. David. Markus.“ in `00114307`) → Neu-Diarisierung mit
`num_speakers`. Nutzt den einzigen Knopf, den #264 als wirksam gemessen hat, ohne dafür den
Menschen zu brauchen. Kosten: ein zusätzlicher LLM-Aufruf und ein zweiter pyannote-Lauf je
Datei.

**Phase 4 — die Hybrid-Grenze verschieben.** Falls die Akustik ausgereizt ist. Das LLM bekommt
Turn-Grenzen mit Zeiten statt fertiger Segment-Etiketten und entscheidet die Zuordnung selbst.
Die Messung stützt die Machbarkeit: in **10 von 10** Rhyathlon-Dateien hat das LLM Cluster
erfolgreich aufgebrochen — die Fähigkeit ist vorhanden, sie wird nur nicht strukturiert
genutzt. Kosten: mehr Token je Datei; hilft nicht, wo die Akustik nichts hergibt.

---

## 7 · Abnahme

Ein Kandidat gilt als Verbesserung, wenn er gegen den Ausgangswert aus 3.3

1. die **zeitgewichtete Sprecher-Fehlerquote** über den Referenzsatz senkt,
2. dabei die **Positivkontrolle** (`Roger Meili`, sauberes Ansteckmikrofon) **nicht**
   verschlechtert — eine Änderung, die den schweren Fall rettet und den leichten opfert, ist
   keine Verbesserung, und
3. die **Sprecherzahl** auf nicht weniger Dateien trifft als vorher.

Jede Phase endet nach den Repo-Regeln: mutationsgeprüfter Test je Fix,
`superpowers:requesting-code-review` und danach CodeRabbit, lokaler Funktionstest am echten
Pfad, README nachgezogen, offene Punkte als GitHub-Issues.

---

## 8 · Offene Fragen

- **Die Referenz ist nicht unabhängig erhoben** (3.1). Ob der Bestätigungs-Bias die Messung
  merklich verschiebt, lässt sich mit dem vorhandenen Material nicht beantworten.
- **Ob der Verify-Pass die Cluster-Zusammenlegung heute zurückdreht**, ist hergeleitet und in
  Phase 1 zu messen (4.2).
- **Ob `00111679` nach der Handkorrektur überhaupt messbar wird.** Bei einer Gruppe, die
  einander ins Wort fällt, kann auch ein Mensch die Sprecher nicht sicher trennen. Sollte das
  so sein, gehört die Datei aus dem Referenzsatz heraus — mit Begründung, nicht stillschweigend.
