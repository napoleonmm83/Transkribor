# Material hinzufügen: ein Dialog statt vier Karten

Stand 2026-08-20. Der Bereich „Material hinzufügen" auf der Arbeitsfläche
(`ProjectWorkspace.tsx`) ist auf vier gleichgewichtete Karten gewachsen und verdrängt die
Dateiliste aus dem Sichtfeld. Dieses Dokument ersetzt ihn durch **einen Dialog mit drei
waagrechten Schritten**, der zugleich zwei Dinge nachholt, die der Server längst kann und die
Oberfläche nicht anbietet: **Sprache pro Datei** und **Reinhören vor dem Start**.

Ausgangspunkt ist Marcus' Befund vom 2026-08-20: „wir haben langsam zu viele Optionen hier
drin, und es wirkt unaufgeräumt."

---

## 1. Was gemessen wurde

Zustand mit drei gewählten Dateien und offener Upload-Vorschau, abgezählt am Markup von
`ProjectWorkspace.tsx` + `UploadDropzone.tsx` + `MaterialVorschau.tsx` + `UrlFetch.tsx`:

| | heute |
|---|---|
| Karten übereinander (`.blatt`) | **4** — Sprache · Ablagefläche · Vorschau · Video-URLs |
| Bedienelemente im Bereich | **10** (+ 4 im Seitenkopf) |
| Erklärabsätze gleichzeitig sichtbar | **4**, zusammen **75** Wörter |
| sichtbare Einträge der Dateiliste | **0** — am Screenshot abgelesen, nicht am Markup: die Zahl hängt an Fensterhöhe und Zoom |
| gleichzeitig mögliche Primärknöpfe | **2** — Upload- und URL-Vorschau können beide offen stehen |

Die zehn Bedienelemente einzeln, damit die Zahl nachprüfbar bleibt: Sprach-Select ·
„Enthält weitere Sprachen" · Ablagefläche (`role="button"`) · 3× Sprecherfeld · Abbrechen ·
Hinzufügen & starten · URL-Textfeld · Holen. Das verborgene `<input type="file">` zählt nicht.
Die vier Erklärabsätze: Sprach-Hinweis (7 Wörter) · `MehrsprachigKasten` (25) ·
Ablageflächen-Untertext (14) · `MaterialVorschau` (29).

**Erste Fassung dieses Abschnitts nannte 11 Bedienelemente und 3 Absätze mit ~70 Wörtern.**
Beides war aus den Mockups übernommen statt am Markup gezählt; die Zahlen oben sind
nachgezählt. Genau die Fehlerklasse, gegen die dieses Repo seine Prüfregel hat — hier an der
eigenen Spec.

Drei strukturelle Befunde dahinter:

**B1 — Sprache steht zweimal in der Oberfläche.** `ProjektEinstellungenDialog` (⋯-Menü) und
der Bereich auf der Seite zeigen dasselbe Bedienelement mit derselben Beschriftung und
demselben Erklärtext; `MehrsprachigKasten` ist buchstäblich dieselbe Komponente. Die Bedeutung
ist verschieden — der Dialog schreibt den Projekt-Standard zurück, die Seite setzt einen
Override für neu Hinzugefügtes —, und nichts an der Darstellung sagt das. Der Umfang der
Kommentare an `sprachWert`/`mehrWert` (**34 Kommentarzeilen**, `ProjectWorkspace.tsx:95-142`,
nur dafür, wann ein Override entsteht) ist das Symptom: wenn die Erklärung so lang ist, liegt
der Fehler in der Oberfläche.

**B2 — Der Bereich ist dauerhaft ausgefahren für einen seltenen Vorgang.** Bei einem Projekt
mit zehn Aufnahmen ist Hinzufügen ein Randfall, belegt aber den ganzen ersten Bildschirm.

**B3 — Die Vorschau ist semantisch modal, wird aber inline gerendert.** Auswählen →
bestätigen oder abbrechen hat Anfang und Ende. Als vierte gleichaussehende Karte liest sie
sich wie „noch eine Einstellung".

---

## 2. Die Kette der Entscheidungen

Vier Runden Mockups mit Marcus, jede mit Alternativen und Auswahl. Die verworfenen Wege stehen
mit Grund dabei — sie sind der eigentliche Inhalt dieses Abschnitts, damit sie niemand in drei
Monaten neu durchläuft.

### 2.1 Der Bereich wird ein Dialog (gewählt: A)

| | |
|---|---|
| **A — ein Knopf, ein Dialog** | **gewählt.** Löst B1, B2, B3 strukturell. |
| B — eine Karte statt vier | verworfen: lässt B2 offen, der Bereich steht weiter über der Liste. |
| C — gross wenn leer, schmal wenn voll | verworfen: lässt B3 offen; die Vorschau bleibt eine Karte in der Seite. |

Die Ablagefläche verschwindet damit von der Seite. **Drag & Drop bleibt trotzdem auf der
ganzen Arbeitsfläche scharf** — beim Ziehen legt sich ein Overlay über die Seite und öffnet
den Dialog mit den fallengelassenen Dateien. Eine dauerhaft sichtbare Zone ist dafür nicht
nötig, ein Ziel für den Zug schon.

### 2.2 Der Ablauf ist waagrecht (gewählt: H1)

Der Auslöser war Marcus' Befund: wenn der Dialog über die Bildschirmhöhe wächst, sieht man
nicht mehr, was noch kommt, und klickt zu schnell weiter.

| | |
|---|---|
| **H1 — Schiene mit benannter Schrittleiste** | **gewählt.** Die Leiste steht oben und bleibt stehen; der Balken zwischen den Stationen füllt sich beim Gleiten. |
| H2 — Karten mit Vorschau am Rand | verworfen: die Punktreihe sagt nur *wie viele* Stationen kommen, nicht *welche*. |
| H3 — Übersichtsspalte, die mitschreibt | verworfen trotz bester Bewertung: braucht Breite, und unter 720 px fällt die Spalte weg — dann ist es H1 ohne Leiste. |

**Der Rahmen bekommt damit eine feste Höhe, und das verschiebt das Problem, statt es
aufzulösen.** Bei zehn Aufnahmen passt die Liste nicht mehr hinein. Sie bekommt deshalb ihre
**eigene** Scrollfläche mit einem Zähler daneben. Das ist der bewusste Tausch: nicht „kein
Scrollen mehr", sondern Scrollen an einer Stelle, an der man es kommen sieht.

### 2.3 Das Sprecherfeld sagt selbst, wofür es ist (gewählt: S1)

Heute steht `automatisch` als Platzhalter im Feld und „Anzahl Sprecher" als Zeile **darunter** —
der Hinweis kommt nach dem Element, das er erklärt.

| | |
|---|---|
| **S1 — Präfix im Feld** (`[👤 Sprecher │ automatisch]`) | **gewählt.** Die Beschriftung klebt am Feld und bleibt lesbar, egal wie weit die Liste scrollt. Kleinstes Delta: das Textfeld bleibt, was es ist. |
| S2 — Spaltenkopf über der Liste | **als Feld-Beschriftung** verworfen: scrollt die Liste, ist der Kopf weg. Eine statische Kopfzeile über der Liste bleibt trotzdem stehen (sie gliedert die Spalten) — sie ersetzt aber nicht die Beschriftung **am** Feld, und genau deshalb braucht es S1. |
| S3 — Chips `auto · 1 · 2 · 3 · 4 · 5 · 6+` | verworfen: schafft das Tippen ab und braucht für „6+" trotzdem ein Feld — zwei Wege für dieselbe Zahl. |
| S4 — Stepper | verworfen: von „automatisch" auf 15 sind fünfzehn Klicks. |

**`type="text"` + `inputMode="numeric"` bleibt, `type="number"` bleibt verboten** (#264): ein
Zahlenfeld liefert bei einer ungültigen Zwischeneingabe einen leeren `value` und zeigt dem
Nutzer den getippten Text trotzdem weiter an. Leer heisst hier „automatisch", die Zahl
verschwände also still beim blossen Vertippen. **Genau deshalb sind S3 und S4 gefallen:** sie
lösen ein Problem, das S1 nicht hat, und schaffen dafür ein neues.

### 2.4 Sprache wird eine Eigenschaft der Zeile (gewählt: L2)

| | |
|---|---|
| **L2 — Sprache als zweite Spalte in Schritt 2** | **gewählt.** Ein Ort für alles, was zu *einer Datei* gehört. Der Schritt „Sprache" entfällt: drei Stationen statt vier. |
| L1 — eine für alle, mit Ausnahmen-Aufklapper | verworfen aus **einem** Grund: es hätte **zwei Wähler für dieselbe Sache** — den globalen und den in der Ausnahmezeile. Das ist B1 in den neuen Dialog zurückgebaut. |
| L3 — nach Sprache gruppieren (Körbe) | verworfen: gewinnt nur im schmalen Bereich „drei bis fünf Sprachen auf zehn Dateien" und kostet ein Bedienmuster, das es sonst nirgends in der App gibt. Vorratsbau. |

**Der Einwand gegen L2 — zehn Sprachwähler, auch wenn alle gleich sind — wird nicht
weggeredet, sondern gestaltet:** eine Zeile, die dem Projektwert folgt, zeigt ihn in
**gedämpfter** Schrift („wie Projekt: Schweizerdeutsch"); nur eine bewusst geänderte Zeile hebt
sich ab. Das entspricht genau dem, was das Backend ohnehin tut — ein Wert, der dem Projekt
entspricht, wird nach #234 gar nicht erst als Override geschrieben. Eine Zeile „alle auf
einmal" über der Liste setzt den ganzen Stapel; einzelne Zeilen bleiben danach änderbar.

### 2.5 Reinhören mit einer Welle unten (gewählt: P1)

Marcus' Anlass: bei vielen Dateien mit Namen wie `00114307.mp3` weiss man nicht, welche welche
ist — und das Gesprochene beginnt oft nicht bei 0:00.

| | |
|---|---|
| **P1 — eine Welle unten im Dialog** | **gewählt.** Sie bleibt an ihrem Platz, nur ihr Inhalt wechselt; die aktive Zeile ist markiert. |
| P2 — Welle klappt in der Zeile auf | verworfen **nach dem Bauen, gegen die eigene Erwartung**: bei fester Rahmenhöhe springt die Liste bei jedem Öffnen und Schliessen. Beim Durchhören von zehn Dateien passiert das zehnmal; man verliert die Position. Ausserdem ist die Welle dort mit 42 px zum Zielen zu klein — der Fall „das Gesprochene kommt später" wird damit schlechter bedient, nicht besser. |

P1 ist zugleich dasselbe Muster wie im Editor: ein Player unten, dessen Inhalt wechselt.

---

## 3. Was der Server schon kann

Nachgelesen, nicht angenommen:

- **Sprache pro Datei ist im Backend fertig.** `upload_audio` nimmt `sprache: str = Form(None)`
  und schreibt sie via `_projekt.setze_datei(project, base, sprache=…)`. `UploadDropzone` lädt
  ohnehin **Datei für Datei** in einer Schleife hoch — es reicht heute nur denselben String an
  alle durch. `projekt.json` hält `dateien[base].sprache`; gemischtsprachige Projekte sind
  ausdrücklich vorgesehen (Wurzel-`CLAUDE.md`).
- **`Waveform.tsx` nimmt `url: string`** und reicht ihn an `useWavesurfer` durch. Eine
  Blob-URL aus `URL.createObjectURL(file)` funktioniert damit — **abspielen vor dem Hochladen
  geht**, die Datei muss den Rechner nicht verlassen haben.
- **Die Sprecherzahl pro Datei ist seit PR #297 fertig** (`MaterialVorschau`, `sprecher` als
  Formfeld bzw. index-parallele Liste).

### Was fehlt: die Sprache auf dem URL-Weg

`fetch_urls` nimmt `body.sprache` als **einen** String für den ganzen Auftrag und reicht ihn
als `TRANSKRIBOR_FETCH_SPRACHE` durch; `download_one` liest ihn aus der Umgebung. `sprecher`
ist dagegen bereits eine **index-parallele Liste** (`TRANSKRIBOR_FETCH_SPRECHER`), die `main`
per `enumerate` an `download_one` durchreicht.

**Die Sprache bekommt dieselbe Form wie die Sprecherzahl** — das ist der ganze Umbau dort, und
er hat sein Vorbild eine Zeile weiter:

- `FetchBody.sprache` wird `str | list[str] | None`.
- Die **paarweise Filterung** in `fetch_urls` nimmt die Sprachen mit auf. Sie existiert, weil
  leere URL-Zeilen sonst nur auf einer Seite wegfallen und ab da **jede** Zuordnung
  verschieben — dieselbe Falle, die bei `sprecher` schon zugeschlagen hat.
- `download_one(project, url, sprecher=None, sprache=None)` bekommt die Sprache als Parameter,
  statt sie selbst aus der Umgebung zu lesen.
- **Rückwärtskompatibel:** ein einzelner Wert ohne Komma behält seine heutige Bedeutung und
  gilt für alle URLs. Eine Liste muss so viele Einträge haben wie URLs, sonst **400**.
  Sprach-ids enthalten kein Komma (`ch/de/en/fr/it/auto`), die Trennung ist eindeutig.
  **Die Regel gilt NUR der Env-Schicht** — im JSON-Rumpf entscheidet der Typ, nicht ein
  Trennzeichen. Und sie ist **nicht** „dieselbe Form wie `sprecher`", wie hier zuerst stand:
  `_sprecher_aus_env` liefert bei einer zu kurzen Liste `None`, „einer gilt für alle" tut das
  Gegenteil. Die Zwillingsbehauptung war bequem und falsch; die beiden Parser sehen ähnlich
  aus und entscheiden im Randfall entgegengesetzt.
- **Die Einzelprüfung `pruef_fehler(sprache=body.sprache)` in `app.py:968` muss WEG.** Mit
  einer Liste macht `sprache not in SPRACHEN` (`sprachen.py:114`) einen dict-Lookup mit einer
  Liste → `TypeError: unhashable type` → **500 statt 400**. Sie wird durch eine Schleife über
  die aufgelöste Liste ersetzt, nicht ergänzt.
- **Die Längenprüfung muss BEIDE Listen decken.** `app.py:944-947` prüft heute nur
  `sprecher_roh`. Kommt `sprache` als Liste falscher Länge, feuert `zip(…, strict=True)` einen
  rohen `ValueError` — also **500 statt 400**, ausgerechnet an der Stelle, deren Zweck eine
  saubere Fehlermeldung ist.
- **Reihenfolge: erst expandieren, dann filtern.** Ein Einzelwert wird **vor** dem `zip` auf
  die Zahl der URLs aufgeblasen. Andersherum bricht `strict=True`, und ohne `strict` wäre es
  schlimmer: still gekürzt heisst hier verschobene Zuordnung.

**Verhältnis zu Issue #298 — der Mechanismus ist ein anderer, als hier zuerst stand.**
Nicht `settings.load_env()` ist die Ursache. `jobs._run_proc` baut die Subprozess-Umgebung als
`{**os.environ, **job_env(), **env}`; das explizite `env` **gewinnt**. Der Durchschlag entsteht
dadurch, dass `app.py:978` den Schlüssel **bedingt** setzt (`if body.sprache`) — fehlt er,
überlebt der Altwert aus `os.environ`, den `load_env()` aus der `.env` dorthin geschrieben hat.
Die Fixrichtung ist deshalb **„den Schlüssel immer setzen, auch leer"**, genau der Weg, den
#297 für `TRANSKRIBOR_FETCH_SPRECHER` schon gegangen ist — nicht eine Änderung am Vorrang.

**Und dieser Umbau verschärft #298, statt ihn nur zu berühren.** Heute überschreibt ein
Altwert *eine* Sprache für den Auftrag. Mit der index-parallelen Liste kollabiert er **alle
Datei-Entscheidungen auf einen Wert** — still, mit Erfolgsmeldung. Der Schlüssel muss also
unbedingt gesetzt werden, und die Leseseite in `fetch.py` muss `""` als „nicht gesetzt" lesen.
**Achtung beim Nachbarn:** `_mehrsprachig_aus_env("")` liefert laut #298 **`False`, nicht
`None`** — dieselbe Behandlung dort blind zu übernehmen schriebe einen echten Datei-Override
fest (die Falle aus #166).

---

## 4. Der Dialog im Einzelnen

### Auslöser

Ein Primärknopf **„+ Material"** im Seitenkopf, neben „Transkribieren" und „Korrigieren".
Zusätzlich öffnet ein Drop auf die Arbeitsfläche den Dialog direkt mit den Dateien.

**Das seitenweite Overlay fängt Drops ab, die heute ins Leere gehen.** `waehlen` filtert per
`AUDIO_RE` und kehrt bei leerer Menge **still** zurück — heute nur, wenn man die Ablagefläche
absichtlich trifft. Seitenweit heisst: ein PDF irgendwo fallen lassen und es passiert
scheinbar nichts. Der neue Weg braucht deshalb eine Meldung („keine Audiodatei dabei"), die
der alte nicht brauchte.

### Schritt 1 — Quelle

Umschalter **Dateien | Links**. Dateien: Ablagefläche (ziehen oder klicken). Links: Textfeld,
eine URL pro Zeile, Knopf „Holen". Weiter ist gesperrt, solange nichts gewählt ist.

### Schritt 2 — Aufnahmen beschreiben

Über der Liste eine Zeile „alle auf einmal: [Sprache setzen …]", darunter eine statische
Kopfzeile („Hören · Aufnahme · Sprache · Sprecher" plus Zähler). Darunter die Liste in ihrer
**eigenen Scrollfläche**, je Zeile:

```
[▶]  00114307.mp3            [Sprache ▾]   [👤 Sprecher │        ]
```

- **▶** — Reinhören. Auf dem URL-Weg **deaktiviert** mit Begründung im `title`/`aria-label`:
  das Video ist noch nicht heruntergeladen.
- **Sprache** — Vorgabe ist der Projektwert, in gedämpfter Schrift. Eine geänderte Zeile hebt
  sich ab.
- **Sprecher** — S1, `type="text"` + `inputMode="numeric"`, leer = automatisch.

**Eine ungültige Sprecherzahl sperrt den ganzen Weiter-Knopf**, nicht nur ihre Zeile —
dieselbe Regel wie heute in `MaterialVorschau`. Sonst liesse sich über eine gültige
Nachbarzeile starten, und die fehlerhafte Eingabe ginge als „automatisch" durch, also als eine
Entscheidung, die niemand getroffen hat.

### Schritt 3 — Prüfen und starten

Zusammenfassung: Zahl der Aufnahmen, Sprecher-Verteilung (`10× automatisch` bzw.
`3 von 10 gesetzt`), Sprach-Verteilung (`Schweizerdeutsch für alle` bzw. `7× Schweizerdeutsch,
3× Englisch`), und was danach passiert („Transkription, dann Korrektur — automatisch").
Enthält die Auswahl `auto`, steht hier ein Warnkasten (siehe 5.2). Knopf: **„Los geht's"**.

### Der Hörbalken (P1)

Erscheint unten im Dialog, sobald etwas klingt; verschwindet beim Stoppen. Enthält
Play/Pause, Stop, den Dateinamen, `mm:ss / mm:ss` und die Welle. Klick in die Welle springt an
die Stelle. **Es klingt nie mehr als eine Datei**, und beim Verlassen von Schritt 2 hört die
Wiedergabe auf.

**Die Wiedergabe beginnt nicht bei 0:00**, sondern an der ersten Stelle über einer
Pegelschwelle, berechnet aus den Peaks, die für die Welle ohnehin anfallen. Die Welle markiert
sie. Der Anfang bleibt über einen Klick ganz links erreichbar.

---

## 5. Grenzen, die nicht wegzudesignen sind

### 5.1 Drei Grenzen des Hörwegs

1. **Beim URL-Import gibt es nichts zu hören.** Das Video existiert an dieser Stelle nur als
   Link. Der Knopf ist deaktiviert und sagt warum — nicht still tot.
2. **Nur eine Welle gleichzeitig.** Wavesurfer dekodiert die ganze Datei, um zu zeichnen. Bei
   zehn Interviews à 30 Minuten wären zehn Wellen ein Speicherproblem: dekodiert wird erst auf
   Klick und nur für diese eine Datei; beim Wechsel wird die vorige freigegeben
   (`URL.revokeObjectURL`).
   **Der Abspieler hat mehr Ausgänge als den Dateiwechsel, und alle müssen ihn beenden:**
   Dialog geschlossen (X, Esc, Klick auf den Hintergrund), Schrittwechsel, Projektwechsel,
   Start des Uploads — **und der Fall, dass die klingende Zeile aus der Liste verschwindet.**
   Nach einem Teil-Fehlschlag bleiben nur die gescheiterten Zeilen stehen (§6.4); eine
   erfolgreiche Datei ist dann weg, ihr Ton liefe ohne diesen Ausgang weiter. Vorher unmöglich,
   weil es an dieser Stelle keinen Abspieler gab.
   **Die Gegenrichtung ist genauso scharf:** `revokeObjectURL` **vor** dem Zerstören der
   Wavesurfer-Instanz bricht die laufende Wiedergabe. Erst zerstören, dann freigeben.
3. **`.mp4` ist ungeprüft.** Ob die Tonspur sich dekodieren lässt, hängt vom Codec und vom
   Browser ab. **Das ist zu messen, bevor gebaut wird** (siehe 7). Bis dahin gilt: anbieten und
   bei Fehlschlag eine Meldung zeigen, statt still nichts zu tun.

### 5.2 Was „Automatisch" kann und was nicht

`sprachen.py` führt `auto` mit `whisper: None` — Whisper bestimmt die Sprache selbst. Zwei
Dinge dazu, die im Code stehen und deren Missachtung teuer wäre:

- **Schweizerdeutsch kann `auto` von sich aus niemals liefern** — erst der Projekt-Standard
  aus 10.1 tut das. Der Kommentar in `von_whisper_code` sagt
  es wörtlich: *„'ch' ist nur als Nutzerauswahl gueltig, nie als Detektion."* Whisper meldet
  `de`, und `auto` trägt `dialekt: False`. Für jede Schweizer Aufnahme heisst „automatisch"
  also **ohne Dialekt-Glättung**.
- **An echtem Material ist die Erkennung knapp.** Gemessen (Wurzel-`CLAUDE.md`, 12:24-Beitrag,
  Erkennung je 30-s-Fenster): echtes Deutsch 0,980–1,000, echtes Englisch mit Publikumsgeräusch
  **0,565**, Stille **0,289**.

Deshalb: `auto` bleibt **wählbar**, wird aber **nirgends Vorgabe**, und die Zusammenfassung in
Schritt 3 nennt die Folge beim Namen — seit 10.1 einschliesslich des Projekt-Standards, der bei
erkanntem `de` gewinnt. Die zweite Messung oben bleibt der Grund, warum `auto` nicht Vorgabe
wird: der Vorrang repariert die `ch`/`de`-Kollision, nicht eine unsichere Erkennung.

### 5.3 Die Sprunghilfe findet Geräusch, nicht Sprache

Ein Pegel-Schwellwert setzt die Marke auch bei Applaus, Windrauschen oder einer zuschlagenden
Autotür. Für „kurz hören, wer da spricht" reicht das. **Sie darf nirgends als Erkennung
beschriftet werden** — der Text am Marker sagt „erstes Geräusch", nicht „erste Sprache".
**Das ist eine bewusste Abweichung vom Mockup**, in dem noch „erste Sprache" steht: die
Beschriftung dort behauptet mehr, als die Messung hergibt.

---

## 6. Zustand und seine Fallen

Der Dialog hält Zustand, den es vorher nicht gab (welcher Schritt, welche Auswahl, welche
getippten Zahlen). Fünf Dinge, die daran schon einmal schiefgegangen sind und deren Schutz
mitwandern muss:

1. **Der Projektwechsel verwirft die Auswahl.** React Router baut die Seite bei einem
   Parameterwechsel **nicht** neu auf. Ohne Reset landeten Projekt As Dateien samt eingetippter
   Sprecherzahl in Projekt B — still und mit Erfolgsmeldung. Gilt für Auswahl, Sprachen,
   Sprecherzahlen **und den Schritt**.
2. **Die Laufnummer wandert mit** (`laufNr` aus `UploadDropzone`). Ein abgebrochener Lauf darf
   die Oberfläche nicht mehr anfassen; das gilt auch für den Projektwechsel, sonst schreibt der
   laufende Upload aus Projekt A sein Ergebnis in den Dialog von Projekt B.
3. **Ein Schrittwechsel verliert nichts.** „Zurück" von 2 nach 1 und wieder vor muss jede
   getippte Zahl und jede gewählte Sprache erhalten. Das ist die Bedingung, unter der H1
   überhaupt vertretbar ist.
4. **Nach einem Fehlschlag bleiben nur die gescheiterten Zeilen stehen.** „Existiert bereits"
   zählt **nicht** als wiederholbar — ein zweiter Versuch endet wieder mit 409. Bedingungsloses
   Leeren wäre Datenverlust, alles Stehenlassen liefe in lauter 409er.
5. **Abbrechen ist während des Laufs nicht gesperrt.** `uploadAudio`/`fetchUrls` haben kein
   Zeitlimit (Issue #299); hängt die Verbindung, bliebe der Dialog sonst für immer tot, und der
   einzige Ausweg wäre ein Neuladen samt Verlust aller Eingaben.

**Von Marcus bestätigt (2026-08-20, s. 10):** ein mitten im Ablauf geschlossener Dialog
**stellt beim nächsten Öffnen wieder her**, was schon eingetippt war. Getippte Sprecherzahlen
sind Arbeit; dieselbe Regel wie Punkt 4. 
**Diese Annahme widerspricht Punkt 1, solange nicht dazugesagt wird, dass sie
PROJEKTGEBUNDEN ist.** Ohne das ist die Wiederherstellung exakt der Bug aus Punkt 1 durch die
eigene Hintertür: Dialog in Projekt A schliessen, zu B wechseln, öffnen — und As Dateien samt
Zahlen stehen darin. Der aufbewahrte Zustand hängt deshalb am Projektnamen und wird beim
Wechsel verworfen, nicht bloss versteckt.

**Sechstens, neu durch den Dialog: das Modal verdeckt den Abbrechen-Knopf laufender Jobs.**
Die Arbeitsfläche zeigt je laufendem Job eine Leiste mit „Abbrechen"; mit offenem Dialog ist
sie unerreichbar, heute ist sie es nie. Wer während eines Laufs Material hinzufügt und dann
abbrechen will, muss erst schliessen — und verlässt sich dabei auf die Wiederherstellung oben.
Das ist der Preis des Modals und wird hier bewusst gezahlt; wenn er zu hoch ist, gehört die
Job-Leiste über den Dialog gehoben.

---

## 7. Was vor dem Bauen zu messen ist

Keine dieser Zahlen ist heute bekannt. Sie stehen hier, damit sie nicht später als Annahme
durchgehen:

1. **`.mp4`-Dekodierung** an einer echten Datei aus `projekte\` (Wegwerf-Kopie), in Chrome und
   im gepackten Electron-Lauf. Ergebnis entscheidet, ob der Hörknopf dort angeboten wird.
2. **Dekodierzeit und Speicher** für ein 30-Minuten-Interview über eine Blob-URL. Ergebnis
   entscheidet, ob es beim „auf Klick dekodieren" bleibt oder ob es einen Ladezustand braucht.
3. **Die feste Rahmenhöhe.** Im Entwurf 352 px. Bei etwa 480 px passen zehn Zeilen ohne
   Scrollen — zu prüfen auf Marcus' Bildschirm und auf einem 13-Zoll-Laptop.
4. **Erscheinen Sonner-Toasts über dem Dialog?** Der Workspace meldet Job-Ausgänge per Toast.
   Liegen sie hinter dem Modal, geht ausgerechnet die Fehlermeldung eines gescheiterten Laufs
   verloren. Vermutlich unkritisch (Sonner rendert in einem Portal), **aber nicht gemessen** —
   und eine Vermutung über eine Stapelreihenfolge ist keine Zusicherung.

---

## 8. Was NICHT gebaut wird

- **Kein Vorspringen über die Schrittleiste.** Sie zeigt an, sie bedient nicht.
- **Keine Erkennung der Sprache vor dem Start.** `auto` bleibt eine Wahl, die Whisper im Lauf
  auflöst; die Oberfläche rät nichts.
- **Keine Anzeige der erkannten Sprache in der Dateiliste.** Sinnvoll, aber eine eigene Arbeit
  — sie gehört zur Liste, nicht zum Dialog.
- **Kein Reinhören nach dem URL-Download.** Dann ist die Pipeline schon losgelaufen, und genau
  das zu vermeiden war der Grund für die Vorschau.
- **Der Projekt-Standard bleibt im ⋯-Menü.** Der Dialog setzt Overrides, er schreibt nie den
  Projektwert zurück. Damit ist B1 aufgelöst: eine Bedeutung, ein Ort.

---

## 9. Berührte Dateien

| Datei | Art der Änderung |
|---|---|
| `webtool/frontend/src/components/MaterialDialog.tsx` | neu — Schiene, Schrittleiste, Zustand |
| `webtool/frontend/src/components/MaterialZeile.tsx` | neu — eine Zeile (Hören · Name · Sprache · Sprecher) |
| `webtool/frontend/src/components/HoerBalken.tsx` | neu — Welle + Transport, nutzt `Waveform.tsx` |
| `webtool/frontend/src/components/MaterialVorschau.tsx` | entfällt; ihre Regeln (Gültigkeit sperrt den ganzen Knopf, `useId` für `aria-describedby`, Abbrechen nie gesperrt) wandern in die neuen Bauteile |
| `webtool/frontend/src/components/UploadDropzone.tsx` | schrumpft auf die Ablagefläche; Upload-Schleife zieht in den Dialog |
| `webtool/frontend/src/components/UrlFetch.tsx` | schrumpft auf das Textfeld |
| `webtool/frontend/src/pages/ProjectWorkspace.tsx` | Bereich raus, Knopf rein, Drop-Overlay |
| `webtool/frontend/src/lib/api.ts` | `fetchUrls`: `sprache` wird Liste |
| `webtool/app.py` | `FetchBody.sprache` Liste, paarweise Filterung erweitert |
| `webtool/fetch.py` | `download_one` bekommt `sprache` als Parameter; `""` gilt als „nicht gesetzt" |
| `webtool/test_api.py` | `fetch_urls`: Längenprüfung beider Listen, Einzelwert-Expansion, 400 statt 500 |
| `webtool/test_fetch.py` | `download_one` mit Sprache je Index; Altlast-Neutralisierung (#298) |
| `webtool/frontend/src/components/MaterialVorschau.test.tsx` | entfällt mit der Komponente; die Zusicherungen wandern mit |
| `webtool/frontend/src/components/UploadDropzone.test.tsx` | schrumpft auf die Ablagefläche |
| `webtool/frontend/src/components/UrlFetch.test.tsx` | schrumpft auf das Textfeld |
| `webtool/frontend/src/pages/ProjectWorkspace.test.tsx` | Bereich raus, Knopf + Overlay rein |

`MehrsprachigKasten` bleibt unverändert und wird im Dialog **nicht** verwendet — das Kästchen
„Enthält weitere Sprachen" betrifft *eine Aufnahme mit mehreren Sprachen darin* und ist damit
eine Datei-Eigenschaft, die ins ⋯-Menü gehört. Es mit der Spalte „Sprache" in eine Zeile zu
mischen wäre genau die Verwechslung, die B1 erzeugt hat.

---

## 10. Entschieden (Marcus, 2026-08-20)

Die vier offenen Annahmen sind beantwortet. Sie stehen hier als Entscheidung, nicht mehr als
Vorgriff:

1. **`auto` bleibt in der Liste**, mit Hinweis in Schritt 3 — **und bekommt einen Vorrang**,
   siehe 10.1. Der Hinweistext ändert sich dadurch (10.1, letzter Absatz).
2. **Die Sprunghilfe springt.** Play beginnt an der ersten Geräuschstelle, nicht bei 0:00.
   Die Beschriftung bleibt „erstes Geräusch" — 5.3 gilt unverändert.
3. **Ein geschlossener Dialog stellt seine Eingaben wieder her**, **projektgebunden**
   (Abschnitt 6). Getippte Sprecherzahlen sind Arbeit; und weil das Modal den
   Abbrechen-Knopf laufender Jobs verdeckt, darf Schliessen nichts kosten.
4. **Kein „+15 s"-Knopf.** Play, Stop und Klick in die Welle genügen; jeder weitere Knopf macht
   die Zeile wieder voller — und davon kamen wir her.

### 10.1 Neu: der Projekt-Standard gewinnt bei `auto`

Marcus' Bedingung für Entscheidung 1: *„man kann eine Default-Sprache einstellen, die bei
`auto` Prio 1 ist, wenn eine erkannte Sprache matcht — also zum Beispiel `de` erkannt und
Default ist `ch`, dann `ch`."*

Quelle ist der **Projekt-Standard aus dem ⋯-Menü** (`projekt.json:sprache`), keine neue
Einstellung. Der Wert existiert bereits als Fallback für Dateien ohne eigene Wahl; ihn als
Vorrang mitzubenutzen ist dieselbe Bedeutung („was wird hier normalerweise gesprochen") an
demselben Ort. Eine zweite, globale Sprachquelle wäre genau die Doppelung, die B1 erzeugt hat.

| Datei-Sprache | Whisper erkennt | Projekt-Standard | Ergebnis |
|---|---|---|---|
| `auto` | `de` | `ch` | **`ch`** — mit Dialekt-Glättung |
| `auto` | `de` | `de` | `de` — wie bisher |
| `auto` | `en` | `ch` | `en` — der Standard greift nicht |
| `auto` | (nichts erkannt) | egal | `de` — wie bisher |

**Es ist EINE Zeile** (`correct.py:96`, `_s.von_whisper_code(code)`): der Vorrang gehört als
Parameter in `sprachen.von_whisper_code`, nicht als Sonderfall an den Aufrufort — die Tabelle
mit den Whisper-Codes ist die EINE Quelle, und `ch`/`de` ist die einzige Kollision darin.

**Die Transkription ändert sich nicht.** `ch` und `de` teilen den Whisper-Code `de`; betroffen
sind nur `ziel`-Phrase und Dialekt-Flag der **Korrektur**.

**Der Preis, benannt:** alle Altprojekte stehen auf `ch` (`SPRACH_DEFAULT`). Eine bestehende
`auto`-Datei, bei der Whisper `de` erkennt, bekommt dort ab sofort Dialekt-Glättung, wo sie
vorher Standarddeutsch bekam. Das ist die gewollte Richtung — aber es ist eine
Verhaltensänderung an bestehenden Projekten und gehört in die README.

**Und der Hinweistext in Schritt 3 ändert sich mit.** „Automatisch liefert nie
Schweizerdeutsch" stimmt danach nicht mehr. Er nennt jetzt den Vorrang: *„Automatisch:
Whisper erkennt die Sprache. Wird Deutsch erkannt, gilt der Projekt-Standard
‹Schweizerdeutsch›."* — der zweite Satz nur, wenn der Projekt-Standard überhaupt greifen kann
(Whisper-Code des Standards ist nicht `None`). Behauptet wird damit nur, was 5.2 hergibt.

---

## Herkunft der Prüfung

Diese Fassung ist **überarbeitet, nicht erstgeschrieben**. Was geprüft wurde und was nicht,
damit niemand mehr Sicherheit annimmt, als dahintersteht:

- **Zwei Reviewer-Subagenten wurden losgeschickt**, und sie fielen auf **zwei
  verschiedene** Arten aus — was von aussen identisch aussah:
  - **Der Faktenprüfer lief vollständig durch** (83 Transkriptzeilen, 632 KB, 27
    Werkzeugaufrufe) und hatte einen **fertigen Bericht** als Schlusstext. Nur die
    Zustellung scheiterte. Der Bericht wurde nachträglich aus dem Transkript geborgen und
    ist eingearbeitet — er fand unter anderem den `TypeError` bei `pruef_fehler` mit einer
    Liste, der sonst als 500 im Code gelandet wäre.
  - **Der zweite Agent hat nie gestartet** — kein Transkript, obwohl seine Definition
    (`.claude/agents/was-erlaubt-der-fix-neu.md`) vorliegt. Diese Linse wurde selbst
    gefahren und ist damit **kein fremder Blick**; sie ist vor dem Bauen nachzuholen.
- **Kein Kontextproblem.** Das war die Ursache in früheren Fällen, hier nachweislich nicht.
  Wer beim nächsten „idle ohne Bericht" nachfragt statt nachzusehen, verschenkt die Arbeit
  eines vollständig gelaufenen Reviews — die Regel dazu steht jetzt in `CLAUDE.md`.
- **Nachgezählt statt übernommen** wurden die Zahlen in §1 (zwei davon waren falsch), die
  34 Kommentarzeilen in §1 B1, die vier Testdateien in §9 und das Verhältnis zu #298 (§3 nannte
  den falschen Mechanismus).
- **CodeRabbit ist an dieser Spec nicht gelaufen.** Für ein reines Design-Dokument ohne Code
  ist das vertretbar; am Implementierungs-PR ist es Pflicht.

## Mockups

Vier Runden, alle anklickbar:

1. Diagnose + A/B/C — https://claude.ai/code/artifact/50f2197a-3a53-46a6-a52e-e470d61be294
2. Sprecherfeld + Ablauf — https://claude.ai/code/artifact/12fa61c7-7f3f-499d-8aac-0e960cf09eb0
3. Waagrechter Ablauf — https://claude.ai/code/artifact/61c122c3-6b62-4f25-934a-5b3ca686a451
4. Gemischte Sprachen — https://claude.ai/code/artifact/821b1a37-318a-4e79-86ca-6267a5497a56
5. Reinhören (mit Ton) — https://claude.ai/code/artifact/489f079f-2a5d-4d12-80e5-748b140b1288
