# Wellenplan 3 — die offenen Issues, neu gruppiert

**Stand:** 2026-08-18, master `b1ab70d`. **Fortschreibung von Wellenplan 2, kein Ersatz.**
**Punkt 0 ist ausgefuehrt** (siehe Reihenfolge unten): #261 und #176 sind geschlossen, #254
ist entschieden. Der Bestand lag beim Schreiben bei **30**, jetzt bei **28** — wo unten „30"
steht, ist der Stand des Zuschnitts gemeint, nicht der heutige.
**Fassung 2** — nach zwei getrennten Gegenläufen (Fakten / Gruppierung), die **eine tragende
Behauptung gemessen widerlegt** und **die Hauptgruppe gekippt** haben. Was davon übrig ist,
steht unten unter „Was die Reviews umgeworfen haben"; die Gruppen sind entsprechend umgebaut.

Wellenplan 2 (`2026-08-17-transkribor-wellenplan-2.md`) bleibt für seine Wellen C/D/E/F
gültig; dieser Plan ordnet die **acht Issues ein, die es damals noch nicht gab**, erweitert
A1, und löst den Konflikt „zwei Nächste" auf, den zwei parallele Pläne erzeugt haben.

**Spec:** keine — dieser Plan ist eine Gruppierung, kein Entwurf. Die Entwürfe liegen je
Gruppe im Issue bzw. in `2026-08-17-transkribor-diarisierung-verbessern-design.md`.

---

## Was die Reviews umgeworfen haben

| Behauptung Fassung 1 | Befund | Beleg |
|---|---|---|
| **#261: der Test bleibt bei der Mutation grün** („Vorher grün, das ist der Befund") | **GEMESSEN falsch — er ist vorher schon ROT.** Das `30` in `haltedauer` ist ein **Literal in der Testdatei**, es leitet sich nicht aus `_lock_stale()` ab. Mutiert man den Code, sinkt die Vergleichsgrösse **nicht** mit: `assert 190.0 > 215.0` → False. **Dieselbe Fehlrechnung steht im Issue selbst** („`frist(185) = 190 > 185` bleibt grün" — es unterstellt, `haltedauer` sinke auf 185). Der Wächter bewacht seine Regel bereits. | `test_ytdlp_update.py:1137` gegen `ytdlp_update.py:613`. Zweimal unabhängig nachgerechnet, Mutation ausgeführt und zurückgespielt. |
| **N1 (#262 + #270) ist eine Gruppe** — „dieselbe Fehlerklasse, und beide sagen das selbst" | **GEMESSEN kein gemeinsamer Code.** Keine gemeinsame Produktionsdatei, keine gemeinsame Testdatei, kein gemeinsames Frontend-Modul — und **zwei** Aufbauten (präparierter Merker gegen halb deinstalliertes pyannote). Die Repo-Regel lautet „eine Verifikations**umgebung**", nicht „eine Fehler**klasse**". Eine Gruppe aus Ähnlichkeit statt aus Kopplung verdoppelt den Reviewkontext, ohne Aufbau zu sparen. | `ytdlp_update.py`/`test_ytdlp_update.py`/`SettingsPage.tsx` gegen `app.py`/`test_api.py`/`DateiEinstellungenDialog.tsx` |
| **Die Kante N1→A1**: „#262 legt einen Dateizugriff auf den Poll, andernfalls wäre #250s Messung beim Merge veraltet" | **GEMESSEN gegenstandslos.** `_pip_unterbrochen()` kostet **11 µs** (kein Merker) / **23 µs** (Merker da), je 2000 Läufe. Derselbe Request zahlt schon `llm.available()` → Subprozess (0,09–0,26 s). **Faktor ~4 000 bis ~11 000.** Der Plan hatte die Kante selbst als „hergeleitet, nicht gemessen" markiert — jetzt ist sie gemessen und fällt. | Messung mit eigener `TRANSKRIBOR_SETTINGS`; `app.py:_settings_body` ruft beides |
| **#262: „Der Wert liegt bereits vor … der Code bestätigt es"** | **Der Code bestätigt es nicht.** `zustand()` ruft `_pip_unterbrochen()` **überhaupt nicht** — die einzigen Vorkommen sind Definition (`:781`) und `faellig()` (`:501`). Es ist ein **neuer** Dateizugriff (23 µs, gemessen), kein vorliegender Wert. | `ytdlp_update.py:1145-1186`, grep über das Modul |
| **N2: „#268 ändert das Merkerformat" — „der einzige echte Bedingungsfall"** | **Beide Hälften unbelegt.** „Merkerformat" steht in **keinem** der Issues; #268 verlangt wörtlich nur, „zwei Zustände zu unterscheiden" — ein zweiter Merker täte das ohne Formatänderung. Und **#260 schreibt gar nichts**: seine Wege sind ein Lese-Subprozess bzw. eine Messung. Die Gruppe hält als **Kontext-Ersparnis**, nicht als Bedingung. | Issues #268/#260, `ytdlp_update.py:642-664` |
| **#270: `find_spec` beantwortet die Frage** | **Kern hält (gemessen: 1,8 ms, torch bleibt ungeladen), eine Falle fehlt.** Fehlt pyannote **ganz**, liefert `find_spec('pyannote.audio')` nicht `None`, sondern **wirft `ModuleNotFoundError`** — genau im Fall, den die Auskunft melden soll. Ungeschützt ein 500 im GET. | Positivkontrolle `pyannote.nixdanicht` → None; Negativkontrolle `gibtsnicht.audio` → Wurf |
| **#160 gehört ans Ende (Platz 5 von 5)** | **Falsche Priorität.** Es ist das **einzige** der 30 Issues mit stillem Datenverlust („die fertige Korrektur ist weg, und niemand erfährt davon"; Preis: ein kompletter Korrekturlauf, Opus-Minuten + pyannote-GPU). Davor standen drei Anzeigefixes und ein **nie beobachteter** Zustand. Und der Plan hatte den Platz selbst freigelegt: Block B Task 8 wartet auf Marcus — #160 ist die eine Arbeit, die weder an Marcus noch an einer Messung hängt. | Issue #160; Wurzel-`CLAUDE.md` („der Speicherpfad ist der mit der schlechtesten Bilanz im Repo") |
| **#176 ist „durch #253 erledigt", schliessen mit Verweis darauf** | **Falscher Bezug.** Nur die Kalenderhälfte ist weg. Der Rest — zwei Prozesse werten `faellig()` **vor** dem Sperren aus und sitzen nacheinander auf derselben Sperre — ist **wörtlich der erste Punkt von #254**, dort mit realerem Auslöser und Nutzersichtbarkeit (220 s „Eine Aktualisierung läuft"). | #176 gegen #254, Punkt 1 |
| **„senkt 30 auf ~27"** | **−2, nicht −3.** #254 geht als Frage an Marcus (bleibt offen), #267 bleibt ausdrücklich offen. Das war ausgerechnet die **Begründung** der neuen Regel 4. | `gh issue list` |
| **„Sechs der acht kommen aus Reviewbefunden" der „letzten vier PRs"** | **Vier aus Reviews, fünf PRs.** #262 und #263 stammen aus dem **Zuschnitt** von #257/#258, nicht aus einem Review — und ausgerechnet diese beiden tragen die Behauptungen, die oben gefallen sind. Herkunft und Belastbarkeit hängen zusammen. | „Wie gefunden" je Issue |

Kleinere Korrekturen eingearbeitet: `zustand()`-Rückgabe steht bei `:1182-1186` (nicht `:1180`);
`cmd_diarize`s `try` endet bei `:291` (nicht `:251`); `diarize.py` hat einen **zweiten** lazy
`import torch` bei `:53`; #260s „erst messen" ist im Issue der **zweite von zwei** Wegen
(„**Oder** erst messen"), keine Forderung — die Handlung bleibt richtig, die Begründung war zu
scharf.

---

## Was sich seit Wellenplan 2 geändert hat

| | |
|---|---|
| **Erledigt** | #253, #252 (PR #255) · #224 (PR #256) · #257, #258 (PR #259) · #264 (PR #265) · #266 (PR #269) — **fünf** PRs, alle merged, Zuordnung geprüft |
| **Neu entstanden** | #254, #260, #261, #262, #263 · #267, #268, #270 |
| **Unverändert offen aus Wellenplan 2** | #249, #250 (A1) · #242, #251 (C) · #222, #209, #244 (D) · #160 (E) · #216 (F) · #173 (B′) · ~~#176~~ (am 08-18 an #254 geschlossen) |

**Vier der acht kommen aus Reviewbefunden** (#260 CodeRabbit-CLI, #268 CodeRabbit-Bot, #254
gegnerisches Review, #270 Reviewer-Subagent), **zwei aus dem Zuschnitt** ihres PRs (#262, #263),
**eines aus einem Plan-Review** (#261), **eines aus einer Messung** (#267). Alle sechs aus PRs
wurden bewusst herausgehalten — das ist die Repo-Regel „Offene Punkte werden Issues" in Betrieb,
nicht liegengebliebene Arbeit.

---

## Die Gruppierungsregel

Übernommen aus Wellenplan 2, unverändert:

1. **Ein PR = eine Review-Linse = EINE Verifikationsumgebung.**
2. **Issues, deren Fixes einander bedingen, gehören zusammen.**
3. **Nennt ein Issue mehrere Wege und sagt ausdrücklich „nicht entschieden", wählt der Plan
   nicht still den teuren.**

**Vierte Regel, neu:**

4. **Ein Issue, dessen eigener Text eine Entscheidung statt einer Reparatur nahelegt, gehört
   in keine Welle.** #263 schreibt selbst: „Vermutlich richtig ist: so lassen und die Frist
   die Arbeit machen." Entscheidungen kosten Minuten, Wellen kosten Tage.
   **Eingeschränkt nach dem Review:** die Regel gilt nur, wo die Entscheidung **wirklich
   endet**. #263s Schliessung hing an einem Vorbehalt, den derselbe Plan für unwahrscheinlich
   hielt — das ist keine Entscheidung, sondern eine Verschiebung mit geschlossenem Deckel. Wo
   ein Vorbehalt bleibt, wandert das Issue in die Welle, die ihn auflöst.

**Fünfte Regel, aus dem Kippen von N1 gelernt:**

5. **Ähnlichkeit ist keine Kopplung.** Zwei Issues, die dieselbe Fehlerklasse beschreiben,
   sparen einem Reviewer nichts, wenn sie keine Datei, keinen Test und keinen Aufbau teilen.
   Das Kriterium ist **gemeinsamer Kontext**, nicht gemeinsames Thema. Prüfbar mit einem
   `grep`: welche Dateien fasst jeder Fix an?

---

## Gruppe M — Merker und Fälligkeit (#268 + #260 + #263 + #254-Hälfte)

**Umgebung:** `pytest` + **eine** Wegwerf-venv. Nie Marcus' venv.
**Datei:** `webtool/ytdlp_update.py` + `webtool/test_ytdlp_update.py`.
**Linse:** Woran erkennt der Server, dass die Installation zerlegt ist, für **welche** venv —
und wie lange gilt diese Erkenntnis?

**Warum das eine Gruppe ist — gemessen am Code, nicht am Thema:**

- `ytdlp_update.py:664` — `_pip_merker()` ist `f"{_lockziel()}.{_venv_kennung()}.abbruch"`.
  Der Abbruch-Merker (#268/#260/#263) ist aus `_lockziel()` **zusammengesetzt**.
- `:589` — `_lockziel()` ist `settings.path() + ".ytdlp"`. Genau diesen Ausdruck will
  **#254 Weg 2** ändern. Ändert er sich, ändert sich der Dateiname **jedes** Abbruch-Merkers
  mit. Eine Migration statt zwei.
- `:616-632` — der Docstring von `_venv_kennung()` nennt **#254 beim Namen** („dieselbe
  Zwei-Prozess-Lage wie #254") und hält fest, `electron/backend.js` setze
  `TRANSKRIBOR_SETTINGS` nicht — **nachgeprüft**. Die halbe Antwort auf #254 steht bereits im
  Code, mit funktionierendem Präzedenzfall aus PR #259.

**Alle vier Issues beschreiben denselben Satz:** *der Merker sagt etwas anderes, als der
Zustand ist.* #260: Metadaten heil, Paket halb. #268: Merker abgelaufen, Installation zerlegt.
`#263`: Merker liegt, Installation heil. #254 Punkt 2: ein Prozess verbraucht den Tagesmerker
für die venv des anderen.

**Reihenfolge INNERHALB der Gruppe:**

1. **#260 zuerst messen** — Kill gezielt in die **Deinstallations**phase (grosses Paket,
   langsamer Datenträger). Ergibt die Messung den Zustand nicht, wird #260 **mit der Messung
   geschlossen**, nicht gebaut. Das ist der wahrscheinlichere Ausgang.
2. **#268 entwerfen** — zwei Zustände trennen: „wann fing das Problem an" (Anker der
   Verfallsfrist) gegen „wann wurde zuletzt abgebrochen". **#263 ist dabei die dritte
   Eingabe**, nicht ein Nachbar: „ein Merker liegt, obwohl nichts kaputt ist". Wer das
   Format entwirft, ohne diesen Fall auf dem Tisch zu haben, entwirft es einmal zu wenig.
3. **#254 mitnehmen — entschieden, Weg 2 + 3** (Marcus, 08-18). `_lockziel()` bekommt die
   venv-Kennung; `_pip_merker()` wird im selben Zug auf `f"{_lockziel()}.abbruch"`
   zurückgebaut (sonst stünde die Kennung doppelt). Dazu das Neulesen nach dem Sperrerwerb
   aus dem hierher geschlossenen #176. **Damit ist M keine bedingte Gruppe mehr:** die
   Merkerpfad-Änderung und #268s Formatentwurf treffen sicher aufeinander.

**Was diese Gruppe NICHT tut:** den naheliegenden #268-Fix (bei jedem Abbruch auffrischen).
Er reisst die Richtung wieder auf, gegen die die erste Regel steht — der Docstring von
`_pip_merker_setzen` argumentiert es aus, und die Frist-Semantik ist bereits **zweimal** von
Reviews geformt worden.

**Die Gruppe ist eine Kontext-Ersparnis, keine Bedingung** (korrigiert nach dem Review): ein
Reviewer baut die Merker-Semantik einmal auf statt viermal. Dass #260 #268s Arbeit blockiere,
ist **nicht belegt** — #260 schreibt nichts, es liest.

---

## A1′ — Einstellungsseite (#249 + #250 + #262)

**Erweitert Welle A1 aus Wellenplan 2 um #262.**
**Umgebung:** Browser + `pytest` + `npm test`. **Dateien:** `SettingsPage.tsx`,
`SettingsPage.test.tsx`, `ytdlp_update.zustand()`.

**Warum #262 hierher und nicht zu #270:** gleiche Seite, gleiche Testdatei, gleicher Poll,
gleicher Endpunktrumpf. #250s Weg 1 (ein schmaler Endpunkt `GET /api/settings/ytdlp`)
verschiebt `zustand()` — also genau den Rumpf, in den #262 ein Feld setzt. Das ist die
Kopplung, die N1 behauptet hat und nicht hatte.

- **#249** — Busy-Zustand beim Speichern. Vorbild `ytJetzt`/`kaputtWeg`. Unverändert aus
  Wellenplan 2, samt der Wurzel, die dort **benannt und nicht behoben** wird
  (`auth.STATUS_TIMEOUT = 30`).
- **#250** — **erst messen.** Das Issue verlangt es. Falls Cache: der eine Aufruf bei
  `auth.py:219` muss ihn **umgehen** (dort misst der Login seinen eigenen Erfolg).
- **#262** — ein Feld `unterbrochen` in `zustand()`. **Ehrlich geführt:** das ist ein
  **neuer** Dateizugriff (gemessen 23 µs), kein vorliegender Wert — `zustand()` ruft
  `_pip_unterbrochen()` heute nicht. Zu entscheiden im PR: kurzschliessen wie `faellig()`
  (`v is None and …`) oder nicht. Die Frage dahinter: hat die Anzeige bei *lesbarer* Fassung
  etwas zu melden? #263 sagt ja (ein liegengebliebener Merker), #262s Textvorschlag sagt nein.

**A1′ läuft NACH M** — #262 zeigt an, was M erst festlegt.

**Keine Reihenfolgekante aus den Kosten** (gestrichen): 23 µs gegen einen Subprozess von
0,09–0,26 s im selben Request. Faktor ~4 000. Eine Messung, die den Subprozess-Anteil sucht,
veraltet daran nicht. **Nebenbei gemessen:** der 1,5-s-Poll läuft **nur während eines Laufs**
(Gate `if (!lauf/ytLaeuft) return`, gedeckelt auf 480 Runden); für fremde Läufe gibt es einen
zweiten Effekt mit 3 s. Auf einer ruhenden Seite pollt gar nichts.

---

## #270 — Mitreiter, kein PR

Ein Feld, ein `find_spec`, ein Docstring mit Decke. **Kleiner als #261**, dem Fassung 1 zu
Recht keinen eigenen PR gab. Es hängt an nichts und berührt nichts.

**Reitet mit dem nächsten PR mit, der `webtool/app.py` und `DateiEinstellungenDialog.tsx`
ohnehin anfasst** — also Block A/C der Diarisierungsarbeit.

- **Fundstelle:** `app.py:402` gegen `correct.py:202` und den `try` in `cmd_diarize`
  (`correct.py:228-291`).
- **Am Code geprüft:** die torch/pyannote-Importe in `diarize.py` liegen lazy in den Funktionen
  (`:20-40` **und** `:53`). Gemessen: `find_spec('pyannote.audio')` = 1,8 ms, torch bleibt
  ungeladen; `import webtool.diarize` = 2,4 ms.
- **Die Falle, ohne die es ein 500 wird:** fehlt pyannote **ganz**, wirft
  `find_spec('pyannote.audio')` einen `ModuleNotFoundError` statt `None` zurückzugeben —
  genau im Fall, den die Auskunft melden soll. Gemessen: `find_spec('gibtsnicht.audio')`
  → Wurf, `find_spec('pyannote.nixdanicht')` → `None`. Muss abgefangen werden.
- **Benannte Decke, wie `llm.available()`:** die Auskunft heisst „pyannote installiert und
  Modell vorhanden", **nicht** „der Lauf wird gelingen". GPU-OOM ist nicht vorhersagbar.
  Gehört in den Docstring und ins Issue, bevor es geschlossen wird.

**Mutation:** Feld auf eine Konstante festverdrahten → Test rot, **in beide Richtungen**
(`True` fest *und* `False` fest), wie an #266 gelernt.

---

## Entscheidungen statt Wellen — drei Issues, kein Code

### #261 — schliessen, mit der Messung (NEU in Fassung 2)

**Die Prämisse des Issues ist gemessen falsch.** Es behauptet, der Test rechne seine
Vergleichsgrösse aus denselben Konstanten wie der Code, und bleibe bei entferntem 30-s-Zuschlag
grün. Tatsächlich ist das `30` in `haltedauer` ein **Literal in der Testdatei**:

```text
_lock_stale()          = PIP_TIMEOUT + 30 + frist()   = 215 s
Test-haltedauer        = PIP_TIMEOUT + 30 + frist()   = 215 s   ← 30 ist LITERAL
Mutation (ohne + 30):    _lock_stale() = 185 → frist(185) = 190
assert 190.0 > 215.0   → False → ROT
```

Auch die anderen zwei Strukturmutationen (`PIP_TIMEOUT` raus, `frist()` raus) werden rot.
Der Wächter bewacht seine Regel bereits. **Schliessen mit dieser Rechnung im Kommentar** —
sie gehört dokumentiert, sonst erfindet sie jemand ein zweites Mal.

### #176 — schliessen, als von #254 absorbiert

Nicht „durch #253 erledigt" (das deckt nur die Kalenderhälfte). Der Rest — beide Prozesse
werten `faellig()` **vor** dem Sperren aus — ist wörtlich #254s erster Punkt, dort mit
realerem Auslöser (gepackte App neben Entwickler-Checkout, bei *jedem* Start seit #253) und
mit Nutzersichtbarkeit. **Schliessen mit Verweis auf #254**, wo die Nachprüfung nach dem
Sperrerwerb behandelt wird.

### #267 — bleibt offen, Stand ist dokumentiert

Prompt-Fix gebaut, **gemessen wirkungslos** (PR #269); die Messung hat die Prämisse gekippt
(`Sprecher 1` ist ein **gemischter** Cluster). Steht am Issue. Gehört in die
Diarisierungsarbeit: Block B baut `v_measure`/`fehlerquote` über `{segment_id: etikett}` — ein
gemischter Cluster schlägt dort als Homogenitätsverlust durch. **Das ist keine Entscheidung**
(es ändert sich nichts) und steht hier nur der Vollständigkeit halber.

### #254 — Frage an Marcus, mit der Vorinformation

Zwei Wege, und der naheliegende hat einen Preis, den kein Plan still wählen darf:
`serverEnv()` auf `userData` umstellen **verschiebt die Einstellungen der gepackten App** —
API-Key, Anbieter, Whisper-Stufe. Ein eingerichteter Nutzer fände eine leere Seite vor; es
bräuchte eine Übernahme.

**Was die Frage kleiner macht, als Fassung 1 sie darstellte:** Weg 2 ist zur **Hälfte gebaut**.
`_venv_kennung()` (`:616`) hängt den Abbruch-Merker bereits an `sys.prefix`, und sein Docstring
nennt #254 als dieselbe Lage. Die Frage ist damit nicht „welcher von zwei Entwürfen", sondern
**„wenden wir das bestehende Muster auf `_lockziel()` auch an?"**

**Bilanz ehrlich:** #261 und #176 werden geschlossen → **30 auf 28**. #254 und #267 bleiben
offen. Das ist −2, nicht −3.

---

## Reihenfolge

```text
0.  Entscheidungen  ✓ ERLEDIGT 2026-08-18
                          #261 geschlossen (not planned) — Mutation selbst gefahren:
                             alle DREI Strukturmutationen an :613 machen den Test rot
                             (+30 raus / PIP_TIMEOUT raus / frist() raus), Baseline und
                             Rueckspielung gruen, `git diff` leer, __pycache__ geleert
                          #176 geschlossen (not planned) — an #254, NICHT an #253
                          #254 ENTSCHIEDEN (Marcus, 08-18): Weg 2 + 3 kombiniert —
                             `_lockziel()` bekommt die venv-Kennung, plus Neulesen nach dem
                             Sperrerwerb (der #176-Fix). Weg 1 (userData) ist vom Tisch.
                             Drei Fallen am Issue notiert: `_pip_merker()` doppelte sonst die
                             Kennung, `test_ytdlp_update.py:1144` geht BEWUSST rot (Literal-
                             Pin aus #243), alle uebrigen Verbraucher folgen automatisch.
                          #267 Stand war bereits am Issue (Kommentar 2026-08-17) — nichts zu tun
                          → 30 auf 28 (gezaehlt), wie korrigiert vorhergesagt: -2, nicht -3

1.  Block B               tools/diar_eval.py, Tasks 6-7        (Marcus' laufender Auftrag)
    (Diarisierungsplan)   #270 reitet mit Block A/C mit
                          Task 8 wartet danach auf Marcus (13 Dateien im Editor)

2.  E  #160               ── HOCHGEZOGEN ──  der einzige stille Datenverlust unter 30 Issues.
                          Füllt genau die Wartezeit, die Task 8 an Marcus abgibt.
                          Eigener ungeteilter Reviewer + eigener `was-erlaubt-der-fix-neu`.

3.  M  #268 (+ #260-Messung, #263, ggf. #254-Hälfte)     Wegwerf-venv + pytest

4.  A1′ #249 + #250 + #262                                Browser + pytest

5.  C  #242  →  D  #222/#209/#244  →  F  #216
       #251 bleibt GETRENNT — Wellenplan 2 empfiehlt ausdrücklich, es nicht mit #242 zu
       bündeln (der vorgeschlagene Wächter wäre am ersten Tag rot); es braucht Weg 3
       („main.js ladbar machen") als eigene Arbeit oder bleibt ehrlich ungelöst.
       B′ #173 nebenher — wartet auf einen echten kaputten Extraktor.
```

**Warum Block B zuerst:** Marcus' laufender Auftrag schlägt Backlog-Reihenfolge; Block B hängt
an nichts; und Task 8 wartet danach auf Marcus — je später der Start, desto später beginnt
diese Wartezeit.

**Warum #160 auf Platz 2** (geändert in Fassung 2): es ist das einzige Issue mit **stillem
Datenverlust**, und der Preis eines Treffers ist ein kompletter Korrekturlauf. Alles, was
Fassung 1 davor stellte, war Anzeige (#262, #270, #249), Last (#250), ein **nie beobachteter**
Zustand (#260) oder Testbau (D). Dazu die Wurzel-`CLAUDE.md`: der Speicherpfad ist „der mit
der schlechtesten Bilanz im Repo" — er gehört früh angefasst, mit frisch aufgebautem Kontext,
nicht als vorletzter Posten. **Und der Platz ist da:** die Wartezeit auf Marcus' Referenzarbeit.

**Der wahre Grund, warum #160 gross ist** (aus Wellenplan 2, unverändert gültig): nicht „mtime
reicht nicht", sondern **wer schreibt** — drei Schreiber der `edit.json`, einer davon
(`correct.py:246`) in einem **eigenen Prozess**. Ein Token aus einer Registry im Serverprozess
kann darum nicht funktionieren; es muss aus dem **Dateizustand** abgeleitet sein.

---

## Was dieser Plan bewusst NICHT tut

- **Wellenplan 2 nicht neu schreiben.** C/D/F stehen dort mit ihren Fundstellen. Eine zweite
  Fassung derselben Wellen wäre die Divergenzfalle.
- **#260 nicht bauen, bevor gemessen ist.** Das Issue nennt es als einen von zwei Wegen; die
  Folgerung („ohne Messung gegen eine Vermutung gebaut") trägt sie trotzdem.
- **#254 keinen Weg STILL zuweisen.** ~~Der naheliegende verschiebt Nutzereinstellungen.~~
  **Erledigt am 08-18:** Marcus hat Weg 2 + 3 gewählt, nachdem der Plan alle drei Wege samt
  Preis vorgelegt hatte. Der Punkt bleibt als Regel stehen (Regel 3), nicht als offene Frage —
  ohne diese Trennung widerspräche der Abschnitt den Zuordnungen in Gruppe M.
- **#261 nicht reparieren.** Es ist nichts kaputt — gemessen.
- **#270 nicht zu einer Verfügbarkeitsvorhersage ausbauen.** GPU-OOM ist nicht vorhersagbar.
- **#251 nicht mit #242 bündeln.** Wellenplan 2s Empfehlung, die Fassung 1 in einer Klammer
  verschluckt hatte.
- **Die Nicht-Wellen-Issues nicht anfassen:** #210/#237 (Entwurfsfragen), #70/#71 (Geschmack),
  #36/#84 (Hardware), #136 vor #137, #164, #95, #45 (extern/Material).

---

## Offene Prüflücken (benannt, nicht verschwiegen)

- **#260s Zustand ist nie beobachtet worden.** Fünf Kill-Messungen, null Treffer. Die geplante
  Messung kann ihn auch weiterhin nicht herstellen — dann wird geschlossen, nicht gebaut.
- **#270s Decke ist echt:** `find_spec` + Modelldatei beantworten „installiert", nicht „wird
  gelingen". Ein Lauf, der an GPU-OOM scheitert, meldet weiterhin `true`. Das ist eine
  Verengung des Issues, keine Lösung — und gehört so ins Issue geschrieben.
- **#242s POSIX-Teil ist auf diesem Rechner nicht verifizierbar** (aus Wellenplan 2). Geht
  ungeprüft raus und wird so berichtet.
- **`auth.status()`-Kosten (0,09/0,26 s) stammen aus der Wurzel-CLAUDE.md, nicht aus einer
  Messung in diesem Repo.** Die gestrichene Reihenfolgekante hängt nicht daran: selbst bei
  1 ms Subprozessdauer bliebe der Abstand zu 23 µs bei Faktor 40.
- **Die Gruppe M ist eine Kontext-Ersparnis, keine gemessene Bedingung.** Wird #260 nach der
  Messung geschlossen, schrumpft sie auf #268 + #263 + #254. (Die zweite Bedingung dieses
  Satzes — „wählt Marcus bei #254 Weg 1" — ist am 08-18 **entfallen**: entschieden wurde
  Weg 2 + 3, und der fasst `_lockziel()` an, also genau den Merkerpfad.)
