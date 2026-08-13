# Mehrsprachige Transkription + optionale Übersetzung

Stand 2026-08-13. Ein Video, in dem nacheinander Schweizerdeutsch, Hochdeutsch und
Englisch gesprochen wird, soll als **ein** Transkript herauskommen, in dem jede Passage
in der Sprache steht, in der sie gesprochen wurde. Dazu eine **optionale** Übersetzung,
die das Original nicht ersetzt.

Sprache ist heute eine Eigenschaft **der Datei** (`webtool/sprachen.py`, `projekt.json`,
Track v0.19.x). Dieses Dokument macht sie zu einer Eigenschaft **der Stelle im Audio**.

---

## 1. Was gemessen wurde

Alles hier Stehende ist an echtem Audio gemessen, nicht abgeleitet. Modell `large-v3`,
RTX 5080, Decoder-Parameter sonst identisch zu `transcribe._opts`.

### 1.1 Das Beispielvideo ist einsprachig

`https://youtu.be/n7lGBEd3t5Q` (Rhylauf 2025, TV Rheintal, 12:35) enthält **kein**
Englisch. 28 Fenster à 30 s, 26 davon Deutsch mit `p ≥ 0,977`. Die beiden Ausreisser:

| Fenster | Zeit | erkannt | p |
|---|---|---|---|
| 9  | 270–300 s | `en` | **0,432** |
| 27 | 810–840 s | `en` | **0,289** |

Fenster 27 enthält gar keine Sprache (kein Segment in beiden Läufen), Fenster 9 ist
deutsch. Beides sind Falschmeldungen. Englische Wörter im gesamten Transkript:
`Race`, `Training`, `Training` — Lehnwörter.

**Folge für die Arbeit:** der Testfall musste gebaut werden. `mixed.wav` =
echtes Rheintal-Audio 0–90 s · englische TTS 90–130 s (Windows SAPI, `Zira`) ·
echtes Rheintal-Audio 130–220 s. Ohne diese Positivkontrolle wäre jede Messung
unten wertlos gewesen — eine Suche, deren erwartetes Ergebnis „nicht gefunden" ist,
braucht eine Probe, die gefunden werden **muss**.

### 1.2 `multilingual=True` allein macht es schlechter

faster-whisper 1.2.1 kennt `transcribe(..., multilingual=True)`: Spracherkennung pro
30-s-Fenster, Umschalten des Tokenizers (`faster_whisper/transcribe.py:1192-1198`).
Der naheliegende Einzeiler. Er scheitert an zwei Stellen:

**(a) Auf dem einsprachigen Video schaltet er auf die 0,289 um.** Es gibt dort **keine
Konfidenzschwelle** — `results[0][0]` wird ungeprüft genommen. `language_detection_threshold`
gilt nur der *einmaligen* Erkennung am Anfang, nicht der pro Fenster. In Fenster 9 fügte
der Lauf daraufhin einen Satz ein, der im Referenzlauf nicht existiert:

```
 279.16  " Es war eine erstaunliche Zeit."
```

Von 206 Segmenttexten blieben nur 89 identisch.

**(b) Auf dem gemischten Audio erkennt er das Englisch korrekt — und übersetzt es
trotzdem.** Fenster 3 (90–120 s) wurde als `en` mit `p = 0,938` erkannt. Ausgabe:

```
  98.4  Ich kam hier aus Manchester mit meinem Klub.
 117.4  Ich denke, ich habe ungefähr 34 Minuten beendet.
```

Ursache: **`condition_on_previous_text=True`**. Whisper bekommt die letzten Tokens als
Prompt; deutscher Kontext schlägt das `<|en|>`-Token. faster-whisper setzt zwar
`tokenizer.language` pro Fenster, setzt aber `prompt_reset_since` nicht zurück.

> Auf dem Weg dahin wurde eine falsche Hypothese widerlegt und ist hier festgehalten,
> damit sie niemand ein zweites Mal aufstellt: `Tokenizer.sot_sequence` ist **kein**
> `cached_property`, sondern ein normales `property` (die acht `cached_property` der
> Klasse betreffen andere Felder). Der Sprachwechsel erreicht den Decoder sehr wohl —
> er verliert nur gegen den Kontext.

### 1.3 Was funktioniert

`multilingual=True` **und** `condition_on_previous_text=False`, zusammen:

```
  90.0  Yeah, it was a fantastic race today.
  93.1  The course was really fast, especially the second half along the river.
  98.9  I came here from Manchester with my club, and honestly the atmosphere in this valley …
 124.5  We are already talking about coming back next year with a bigger group.
 129.2  In Anläufen, die ganz normal mit Massestart gestartet werden, …      <- zurück auf Deutsch
```

Wortgenau gegen das TTS-Skript, und die **Rückschaltung** sitzt ohne Zutun.

Der Preis am deutschen Teil desselben Audios (0–88 s und 134–220 s):

| Lauf | Segmente | Wörter |
|---|---|---|
| heute (`language='de'`, Kontext an) | 50 | 436 |
| gemischt (Kontext aus) | 35 | 420 |

Die ersten sechs Segmente sind zeichenidentisch; der Unterschied ist im Wesentlichen
gröbere Segmentierung. Klein, aber nicht null — darum gilt die Abschaltung **nur** für
Dateien, die der Nutzer als gemischt markiert hat.

### 1.4 Die Schwelle

Falsch erkannt bei `p = 0,289` und `p = 0,432`, richtig erkannt bei `p = 0,938`.
Dazwischen liegt viel Luft. **Vorgabe 0,7 ist geraten**, nicht gemessen — drei
Messpunkte tragen keine Kalibrierung. Sie ist deshalb eine Stellschraube
(`TRANSKRIBOR_MIX_SCHWELLE`), keine Konstante.

---

## 2. Entscheidungen

| Frage | Entscheidung | Grund |
|---|---|---|
| Zielform | Jede Passage in **ihrer** Sprache, keine Übersetzung im Transkript | Das Transkript ist das Protokoll des Gesagten. |
| Wie wird „gemischt" gewählt? | **Haken neben der Sprachauswahl**, nicht als sechster Sprach-Eintrag | Die gewählte Sprache wird zur **Ankersprache** (Rückfall unsicherer Fenster) und bleibt frei kombinierbar; ein Eintrag `mix` hätte den Anker fest verdrahtet und für ein englisch-dominiertes Video einen zweiten Eintrag gebraucht. |
| Übersetzung | Eigenes Feld, Zielsprache wählbar, Schalter Original ⇄ Übersetzung | Original bleibt unangetastet; der Schalter tauscht nur die Ansicht. |
| Reihenfolge | **A vor B**, zwei PRs | B ohne A übersetzt ein Transkript, das die Fremdsprache schon falsch wiedergibt. |

---

## 3. Teil A — Mehrsprachige Transkription

### 3.1 Datenmodell (`webtool/projekt.py`)

`projekt.json` bekommt `mehrsprachig: bool`, auf Projekt- **und** Dateiebene, Vorgabe
`false` (aufgefüllt in `laden()`, wie `sprache`/`korrektur`). `setze_datei` und
`speichern` nehmen es auf; beide laufen bereits unter dem projekt-weiten
`_gesperrt()`-Lock (#134) — **kein neuer Schreibpfad**.

`speichern` filtert seine Schlüssel heute über `isinstance(patch[k], str)`. Ein bool
fiele durch diese Prüfung und würde **stillschweigend verworfen** — das Kästchen liesse
sich auf Projektebene setzen, ohne dass etwas passiert. Der bool braucht dort einen
eigenen Zweig.

**Falle, die zwingend zu vermeiden ist:** `datei_sprache` löst den Projekt-Rückfall
über `or` auf:

```python
return d["dateien"].get(base, {}).get("sprache") or d["sprache"]
```

Für einen **bool** ist das falsch: ein bewusst auf `False` gesetzter Datei-Wert ist
falsy und fiele auf den Projekt-Wert `True` zurück — der Nutzer könnte den Haken nie
wieder einzeln abwählen. `datei_mehrsprachig` prüft deshalb auf **Anwesenheit des
Schlüssels**, nicht auf Wahrheit:

```python
def datei_mehrsprachig(project: str, base: str) -> bool:
    d = laden(project)
    e = d["dateien"].get(base, {})
    return bool(e["mehrsprachig"] if "mehrsprachig" in e else d["mehrsprachig"])
```

Dasselbe Prinzip wie bei `apply_correction` (`"text": ""` streicht, ein fehlender
Schlüssel nicht): **der Schlüssel entscheidet, nicht der Wert.**

`sprachen.pruef_fehler` bekommt ein drittes Argument und lehnt Nicht-Bools mit 400 ab —
dieselbe EINE Quelle wie für `sprache`/`korrektur` (#139).

### 3.2 ASR (`transcribe.py`)

`_opts(language, mehrsprachig=False)`. Bei gesetztem Haken **beide** Parameter,
niemals einer allein:

```python
if mehrsprachig:
    o["multilingual"] = True
    o["condition_on_previous_text"] = False   # ohne dies uebersetzt Whisper (1.2)
```

`_datei_whisper_code` wird zu `_datei_sprachwahl(proj_dir, base, fallback) -> (code, mehrsprachig)`
— **ein** `projekt.json`-Lesevorgang statt zweier, gleicher lazy-Import wie bisher.

### 3.3 Der Schwellenproxy

faster-whisper bietet keinen Haken für „nur umschalten, wenn sicher". Ein
delegierender Proxy um das ct2-Modell (`m.model`) liefert ihn in ~15 Zeilen und ohne
Fork:

```python
class _Sprachschwelle:
    """Klemmt unsichere Sprachwechsel auf die Ankersprache.
    faster-whisper nimmt bei multilingual=True results[0][0] ungeprueft
    (faster_whisper/transcribe.py:1192) -- gemessen: 0.29 und 0.43 waren falsch,
    0.94 war richtig."""
    def __init__(self, echt, anker, schwelle):
        self._echt, self._anker, self._s = echt, anker, schwelle
        self.fenster = []
    def detect_language(self, enc):
        r = self._echt.detect_language(enc)
        tok, p = r[0][0]
        code = tok[2:-2]
        if self._anker and code != self._anker and p < self._s:
            self.fenster.append([code, round(p, 3), self._anker])
            return [[(f"<|{self._anker}|>", 1.0)]]
        self.fenster.append([code, round(p, 3), code])
        return r
    def __getattr__(self, n):
        return getattr(self._echt, n)
```

- Anker `None` (Sprache `auto`): die **erste sichere** Erkennung wird zum Anker.
- Gleiche Sprache unter der Schwelle wird **nicht** geklemmt — es gibt nichts zu klemmen.
- Der Proxy wird nur für gemischte Dateien eingehängt und danach wieder abgehängt;
  das Modell wird pro Projektlauf einmal geladen und von allen Dateien geteilt.

### 3.4 Was im Rohtranskript landet

`<base>.json` bekommt `window_languages: [[code, p, benutzt], …]` — die Entscheidungen
in der Reihenfolge, in der sie fielen. **Diagnose, keine Segmentzuordnung.**

Der Grund für die Einschränkung gehört hierher, weil er nicht offensichtlich ist: eine
strenge Abbildung Fenster → Segment ist mit den vorhandenen Daten **nicht sauber
herstellbar**. `Segment` hat kein `language`-Feld, der Proxy sieht kein `seek`, und ein
stilles Fenster verbraucht eine Erkennung, **ohne** ein Segment zu erzeugen — eine
Zuordnung über die Reihenfolge verschöbe sich ab dort für alle folgenden Segmente.
Ein `segments[].sprache` wäre also entweder falsch oder aufwändig; gebraucht wird es
nicht, weil die Korrektur und die Übersetzung den Text ohnehin lesen. Bleibt offen
(Issue), falls der Editor die Sprache je anzeigen soll.

### 3.5 Korrektur (`webtool/correct.py`)

`_correct_prompt` und `_verify_prompt` bekommen ein **eigenes Flag**
`mehrsprachig: bool = False`, das je **eine zusätzliche Regelzeile** einsetzt.

Nicht über die `ziel`-Phrase, obwohl das zunächst naheliegt: `ziel` steht in
`_correct_prompt` mitten im Satz („zu {ziel} normalisieren"), eine Phrase wie „jede
Passage in ihrer Sprache belassen" ergäbe dort Kauderwelsch. Schwerer wiegt der zweite
Grund — in `_verify_prompt` wird `ziel` **ausschliesslich** über
`_default_context(ziel, dialekt)` verwendet, und der greift nur, wenn **kein**
`kontext.md` vorliegt. Ein Projekt mit Kontextdatei sähe die Regel also nie. `ziel` und
`dialekt` folgen weiterhin unverändert der Ankersprache.

Die Zeile in `_correct_prompt` wird Regel 8 (neben 6 MUSIK und 7 ASR-ARTEFAKTE):

> **8) MEHRSPRACHIG:** Die Aufnahme enthält mehrere Sprachen. Belasse jede Passage in
> der Sprache, in der sie gesprochen wurde — **übersetze nichts**. Innerhalb einer
> Passage gelten die Korrekturregeln ihrer eigenen Sprache.

Die Zeile in `_verify_prompt` ist ein weiterer Aufzählungspunkt in „Prüfe kritisch
gegen das ROH", unmittelbar nach MUSIK/ARTEFAKTE und nach demselben Muster gebaut:

> **- FREMDSPRACHE ist eine ERLAUBTE Entscheidung, KEINE Untreue:** Eine Passage in
> einer anderen Sprache als der Rest ist nicht zurückzuübersetzen. Prüfe nur, ob sie
> zum Roh passt.

**Diese zweite Zeile ist der ganze Punkt.** Der Treue-Pass prüft gegen das
Rohtranskript und würde eine englische Passage neben deutschem Kontext sonst als
Untreue zurückdrehen — exakt die Falle, in die schon die `[Musik]`-Markierung gelaufen
ist. Dass es dieselbe Falle ist, ist der Grund, den Text hier wörtlich hinzuschreiben
statt „analog zu Regel 6".

`_glossary_prompt` bleibt unangetastet (läuft mit `ziel=""`, sprachneutral).

### 3.6 macOS

`webtool/whispercpp.py` ruft `whisper-cli` mit einem festen `-l`; eine Erkennung pro
Fenster kennt whisper.cpp nicht. Gemischte Dateien fallen deshalb auf faster-whisper
zurück — der **vierte** dokumentierte Rückfall neben „kein Apple Silicon", „`whisper-cli`
fehlt" und „keine GGML-Datei". Langsamer, aber richtig; ein Ausfall wäre schlechter.

### 3.7 Endpunkte und Oberfläche

Kein neuer Endpunkt. `GET/PUT /api/projects/{p}/einstellungen` und
`GET/PUT /api/projects/{p}/files/{base}/einstellungen` tragen `mehrsprachig` mit;
Upload und Fetch reichen es wie `sprache` durch, **bevor** der Job startet.

Im Dialog ein Kontrollkästchen unter der Sprachauswahl: **„Enthält weitere Sprachen"**,
mit dem Hinweis, dass die gewählte Sprache dann als Hauptsprache gilt. Die Verzweigung
in `DateiMenue.einstellungenGespeichert` behandelt eine Änderung von `mehrsprachig`
wie eine Sprachänderung: `has_raw` ⇒ Neu-Transkription, Editor **vergisst + verlässt**
die Datei (Waisen-Vermeidung, #106).

### 3.8 Tests

| Test | Mutationsprobe |
|---|---|
| `_opts(...)` mit Vorgaben **byte-identisch** zu heute | Vorgabe kippen → rot |
| `_opts(..., mehrsprachig=True)` setzt **beide** Parameter | je einen entfernen → rot (zwei Tests) |
| Schwellenproxy klemmt unter der Schwelle auf den Anker | Vergleich entfernen → rot |
| Schwellenproxy lässt über der Schwelle durch | — (Positivkontrolle, sonst klemmt er alles) |
| Schwellenproxy klemmt **nicht** bei gleicher Sprache | `code != anker` entfernen → rot |
| `datei_mehrsprachig` mit gespeichertem `False` liefert `False` | auf `or` umstellen → rot |
| `pruef_fehler` lehnt Nicht-Bool ab | Prüfung entfernen → rot |
| `ziel`-Phrase steht in Korrektur- **und** Verify-Prompt | je einen entfernen → rot |
| gemischte Datei auf Apple Silicon ⇒ faster-whisper | Bedingung entfernen → rot |

Der bestehende Wächter `test_opts_gibt_whisper_KEINEN_initial_prompt` bleibt.

Nicht per Test abzudecken und deshalb im Browser gegenzulesen: das Kontrollkästchen im
Dialog und das Verhalten beim Wechsel (Editor verlässt die Datei).

---

## 4. Teil B — Optionale Übersetzung

Eigener PR, setzt A voraus. **Der Umsetzungsplan zu dieser Spec deckt nur Teil A ab**;
B wird nach dem Merge von A eigens geplant — dieser Abschnitt hält fest, worauf A
Rücksicht nehmen muss, nicht was als Nächstes gebaut wird.

- **Dokument:** `segments[].uebersetzung` (Text) und dokumentweit `uebersetzung_sprache`.
  Das Original in `text`/`raw_text` wird **nie** angefasst.
- **Wählbare Zielsprachen** sind `SPRACHEN` ohne `auto` (eine Übersetzung braucht ein
  benanntes Ziel) und ohne `ch` (Schweizerdeutsch ist die Quell-, nie die Zielform —
  `ziel_phrase("ch")` ist bereits „lesbarem Standarddeutsch"). Praktisch also
  `de`/`en`/`fr`/`it`. Die Liste wird aus `SPRACHEN` abgeleitet, nicht abgeschrieben.
- **Auslöser:** Knopf im Editor mit Zielsprachen-Auswahl, ein Lauf über die Datei,
  geblockt in Blöcken wie die Korrektur (`_ask_llm`, gleiche Parallelitätsgrenze).
- **Am Treue-Pass vorbei.** Eigener Prompt, eigener Schritt; der Verify-Lauf prüft
  gegen das Rohtranskript und verwürfe jede Übersetzung.
- **Ansicht:** Schalter Original ⇄ Übersetzung in der Werkzeugleiste. `SegmentView`
  zeigt das aktive Feld; die Bearbeitung schreibt in das aktive Feld.
- **Export:** `.md`/`.srt` nehmen einen Parameter wie schon `?sprecher=false`.
- **Suche:** `useSuche` durchsucht das **angezeigte** Feld — sichtbarer Text, den die
  Suche nicht findet, ist die Lücke aus #128.

Offen für B, bewusst nicht vorentschieden: ob ein Dokument mehrere Übersetzungen
gleichzeitig hält (heute: eine, Sprachwechsel überschreibt) und ob eine übersetzte
Datei `human_edited` setzt.

---

## 5. Bewusst nicht gebaut

- **Kein `segments[].sprache`** — siehe 3.4. Issue.
- **Keine automatische Erkennung, dass eine Datei gemischt ist.** Der Haken ist eine
  Nutzerangabe. Automatisch zu raten hiesse, `multilingual` probeweise auf jeder Datei
  laufen zu lassen — genau der Lauf, der laut 1.2(a) einsprachige Aufnahmen verschlechtert.
- **Keine Schwellen-Kalibrierung.** Drei Messpunkte. Stellschraube statt Anspruch.
- **`multilingual` nicht als globale Vorgabe.** Messbar schlechter auf einsprachigem Material.

## 6. Getrennt davon zu erledigen (Issues)

1. **URL-Import ist kaputt.** YouTube antwortet mit `403 Forbidden`; yt-dlp braucht seit
   Kurzem eine JS-Laufzeit (`Only deno is enabled by default`). `--js-runtimes node`
   behebt es sofort, Node liegt fürs Frontend ohnehin vor (v22.23.2). Eine Zeile in
   `webtool/fetch.py`. Gefunden beim Laden des Beispielvideos für diesen Spike.
2. **Upstream-Bericht an faster-whisper:** `multilingual=True` erkennt die Sprache
   richtig und gibt sie trotzdem übersetzt zurück, weil `prompt_reset_since` beim
   Sprachwechsel nicht zurückgesetzt wird. Ohne `condition_on_previous_text=False`
   ist die Option stillschweigend wirkungslos. Messwerte siehe 1.2(b).
3. **Sprache pro Segment** im Rohtranskript — siehe 3.4.
