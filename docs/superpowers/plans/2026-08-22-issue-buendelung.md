# Bündelungsplan: 24 offene Issues

> **Kein Implementierungsplan.** Triage-Dokument: es entscheidet, WELCHE Bündel existieren,
> in welcher Reihenfolge sie laufen und welche blockiert sind. Jedes Bündel bekommt seinen
> eigenen Plan nach `superpowers:writing-plans`, wenn es dran ist.

**Stand (Fassung 4):** master `d51fa3e`, `v0.31.0` live, **23 offene Issues, 0 offene PRs**
(PRs in beiden Repos gezählt am 2026-08-23 morgens; die 23 Issues sind Transkribors).
Fassung 4 ergänzt **kein Issue-Bündel**, sondern den Prüfapparat selbst: **jeder der drei
Wächter hat eine stille Blindstelle**, und die Testhälfte fehlte ganz. Ihr erster Entwurf
wurde vor dem Bau von zwei Prüfern zerlegt — Stufe B ist deshalb `tsc -b` (470 ms) statt
eines Suitenlaufs (72 s, hätte im belegten Fenster 0 von 1 Rot-Fällen gefangen).
Steht am Ende unter „Fassung 4".
**Stand (Fassung 3):** master `80e2e1d`, `v0.31.0` live, **23 offene Issues, 0 offene PRs**
(gezählt am 2026-08-22 abends). Was Fassung 3 ergänzt, steht am Ende unter „Fassung 3".
**Stand Fassung 2:** master `af24095`, 24 offene Issues.
**Fassung 2** — Fassung 1 wurde von `faktenpruefer` und `pruefer-gegnerisch` zerlegt
(Berichte: `review-buendelungsplan-fakten.md`, `review-buendelungsplan-gegnerisch.md`).
**Fünf Zahlen darin waren falsch**, obwohl sie als „nachgeprüft" auftraten. Was korrigiert
wurde, steht am Ende unter „Was Fassung 1 falsch hatte" — nicht als Zerknirschung, sondern
weil die falschen Zahlen sonst über Zitate weiterleben.

## Das Bündelungskriterium

Gebündelt wird nach **geteilten Prüfkosten**, nicht nach Themenähnlichkeit
(`aehnlichkeit-ist-keine-kopplung`). Die vier teuren Posten — und seit Fassung 3 ein
fünfter, der **kein** Kontingent verbraucht, sondern einen Zustand beschreibt:

1. **Browser-Sitzung** — App starten, Wegwerf-Projekt, Screenshots, löschen. Pflicht nach
   jedem sichtbaren Frontend-Fix. Fällt pro PR an, nicht pro Fix.
2. **CodeRabbit-Kontingent** — **Momentaufnahme vom 2026-08-22**, gelesen an den
   Bot-Kommentaren zu PR #329 und #327 (`gh api …/issues/<nr>/comments`): „98 included PR
   review attempts over the past 7 days set your current allowance at **1 review per hour**".
   Das ist eine **dynamische Fair-Usage-Drosselung** über ein gleitendes 7-Tage-Fenster, keine
   feste Plangrösse — **die Zahl ist morgen eine andere**, das Argument bleibt. Der Plan läuft
   weiter („Pro Plus", am Bot-Lauf zu PR #333 desselben Tages erneut bestätigt); abgelaufen
   ist nur der **Security**-Trial. Ein PR weniger ist ein Reviewslot mehr.
   **Die Einheit ist der COMMIT, nicht der PR** *(Fassung 3, gemessen)*: verbraucht werden
   „review attempts", und jeder Push auf einen offenen PR ist einer. An PR #339 gezählt —
   **ein** PR, vier Commits, davon `f6f84ca` geprüft, `dbc4fdb` und `d3e3adc` jeweils
   `Review rate limited`. **Jedes „1 Reviewslot" in diesem Dokument ist daher eine
   Untergrenze**, keine Zahl. Die Bündelungsrichtung bleibt trotzdem richtig, nur aus einem
   anderen Grund als gedacht: weniger PRs heissen weniger *Runden* von Befund-und-Fix, und
   die Runden sind es, die zählen.
3. **Mac-Hardware** — nur Marcus.
4. **Marcus' Entscheidungen** — kosten je eine Antwort, wenn man sie bündelt.
5. **Der PR-Bestand** *(Fassung 3)* — **kein Kontingent-, sondern ein Zustandsposten.** Die
   erste Fassung dieses Punktes behauptete, ein offener PR „binde einen Reviewslot" — das ist
   **falsch und war ungeprüft**, ausgerechnet im Absatz, der das Nachrechnen einführt. Posten 2
   wird von **Reviewversuchen** verbraucht, also von *Commits*; ein PR, der unangetastet
   liegt, kostet **nichts**. An diesem Abend beidseitig belegt: #325 lag einen Tag ohne einen
   einzigen Bot-Lauf, während #338/#339 samt Fixcommits in Stunden bis in die Drosselung
   liefen. **Aufräumen kostet Kontingent, Liegenlassen nicht.**
   Was ein liegender PR wirklich kostet: fertige Arbeit erreicht niemanden, der Branch driftet,
   und — der teure Fall, heute gemessen — **ein grüner Haken verdeckt einen ungeprüften
   Stand** (#325: `success | Review rate limited`).
   **Vor jedem Bündel in BEIDEN Repos nachsehen** — dieser Plan reicht über
   zwei davon (B2b′ läuft in `claude-routing`), und `gh pr list` **ohne `--repo` sieht nur
   das, in dem man gerade steht**:
   `gh pr list --repo napoleonmm83/Transkribor` · `gh pr list --repo napoleonmm83/claude-routing`.
   *(Am 2026-08-22 nachgesehen: dort 0 offene. Die Regel wäre trotzdem blind gewesen —
   der Fehler war die Regel, nicht ihr Ergebnis.)*

Zwei Issues im selben Bereich, die keinen dieser Posten teilen, werden **nicht** gebündelt.

---

## B1 — Dialoge bei kleiner Fensterhöhe bedienbar (#283 + #311) ▶ ZUERST

**Warum gebündelt:** eine Browser-Sitzung deckt beides — ein App-Start, ein Wegwerf-Projekt,
ein Reviewslot statt zwei. Das ist der **einzige** Grund; fachlich teilen die beiden nichts.

**Warum zuerst:** #283 ist der einzige offene Issue mit einem Zustand, in dem sich nichts
mehr speichern lässt. Es gibt keinen Konkurrenten um Platz 1.

**Wie schlimm es wirklich ist — die Dringlichkeit ist kleiner als in Fassung 1:**
`electron/main.js:50` setzt `minHeight: 600` (Aussenmass, Viewport am Minimum ~560 px). Der
**Totalausfall bei 420 px ist damit nur im Browser erreichbar**; in der gepackten App ist der
597-px-Dialog am Minimum um ~19 px angeschnitten, der Knopf also teilweise klickbar.
„Die App ist unbedienbar" war eine Browser-Erzählung. Es bleibt ein echter Fehler — nur einer,
der die installierte App streift statt sie zu blockieren.

**Der Zusatzbefund, den #283 selbst nicht hat:**
`ui/dialog.tsx:62` hat `fixed top-[50%]` ohne `max-h`/`overflow-y` — wie beschrieben. **Aber
`ui/alert-dialog.tsx:59` trägt dieselbe Signatur und ist ein EIGENES Bauteil**
(`AlertDialogPrimitive.Content`, importiert nichts aus `ui/dialog.tsx`). Ein Fix nur an der
im Issue genannten Stelle liesse `DeleteProjectDialog` und die Alert-Dialoge in `DateiMenue`
kaputt — `fix-an-einer-stelle-ist-kein-fix-der-klasse`. **Beide Bauteile in den Fix.**
Nebenbei: #283 zählt „Löschen" fälschlich zu den `dialog.tsx`-Verbrauchern.

**Zensus statt Schätzung** (Fassung 1 hatte hier 10/3 aus einer Substring-Falle —
`grep "DialogContent"` fängt `AlertDialogContent` mit und zählt Definitionsdateien mit):

| Bauteil | Verbraucher | Dateien |
|---|---|---|
| `DialogContent` | **6** | `MaterialDialog`, `DateiEinstellungenDialog`, `NewProjectDialog`, `ProjektEinstellungenDialog`, `UmbenennenDialog`, `ui/command` |
| `AlertDialogContent` | **2** | `DateiMenue`, `DeleteProjectDialog` |

**Kein drittes betroffenes Bauteil:** `grep 'top-\[50%\]'` über `ui/` liefert genau diese
zwei. Kein `sheet.tsx`, kein `drawer.tsx`; `popover`/`select`/`dropdown-menu`/`tooltip` sind
Radix-Popper-positioniert, `select.tsx:63` hat bereits eigenes `max-h`+`overflow-y`.

**Zwei Fallen für die Browser-Prüfliste:**
- **`ui/command.tsx:51`** rendert `<DialogContent className="overflow-hidden p-0">`. `cn` ist
  `twMerge(clsx(…))` (`lib/utils.ts:5`) — der Verbraucher gewinnt Konflikte. Ein in
  `dialog.tsx` ergänztes `overflow-y-auto` würde dort **überstimmt**, ein `max-h-*` bliebe
  stehen. Die Palette rollt intern ohnehin (`CommandList: max-h-[300px] overflow-y-auto`).
- **`MaterialDialog.tsx:278`** deckelt sich mit `h-[min(648px,90vh)]` **selbst** und ist vom
  #283-Symptom gar nicht betroffen. Er ist damit die **Negativkontrolle**, nicht der Testfall.
  (Fassung 1 warnte vor einer „sticky-Kopfzeile" — die gibt es dort nicht: `grep sticky` über
  `src/` findet nur Kommentare. Kopf und Schrittleiste stehen fest, weil sie nicht-rollende
  Flex-Geschwister über dem Bildlaufbehälter sind. Und der Bildlauf kam aus **PR #313/#315**,
  nicht #310.) Die offene Frage bleibt, muss aber anders lauten: wie wirkt ein Basis-`max-h`
  auf einen Verbraucher, der schon `h-[…]` + Flex-Spalte + innere Bildläufe hat?

**Ein PR, und die ehrliche Abbruchregel statt einer Beruhigung.** Fassung 1 sagte „getrennte
Commits, damit ein Reviewer den riskanten Fix ablehnen kann, ohne #311 mitzunehmen" — das ist
hohl: der Repo-Workflow ist **Rebase-Merge des ganzen PRs**, einen Commit einzeln abzulehnen
gibt es nicht. Die tragfähige Regel: **braucht der Bauteil-Fix eine zweite Reviewrunde, wird
#311 abgespalten und separat gemerged.** Dann ist die Bündelung ihren Reviewslot wert
gewesen, ohne den kleinen Fix am grossen festzunageln.

**Prüfung:** vitest beide Richtungen + Mutationsprobe · Browser bei **420 px** (Fehlerfall)
UND **900 px** (Negativkontrolle: kein Bildlauf im Normalfall) · alle **8** Verbraucher
einmal öffnen · Screenreader-Gegencheck für #311, weil jsdom Live-Regionen nicht nachbildet.

### ► UMGESETZT in PR #333 (2026-08-22)

Alles oberhalb dieser Zeile beschreibt die **Ausgangslage vor** dem PR und bleibt als
Begründung stehen — der Code trägt die Fixes inzwischen. Was der Bau ergab und im Plan so
nicht stand:

- Die offene Frage („wie wirkt ein Basis-`max-h` auf den Material-Dialog?") war **berechtigt,
  aber falsch verortet**. Nicht die Höhenkette brach, sondern der **animierte Rahmen**: sein
  `::before` hat `inset: -2px`, und ein `overflow ≠ visible` macht daraus scrollbaren Inhalt.
  Gemessen bei 320 px: **beide** Bildlaufleisten, je 15 px, für 2 px Phantom-Überlauf, und
  `clientHeight` fiel 286 → 271. Der Reviewer bestätigte per Pixelprobe, dass der Rahmen ganz
  verschwand. `MaterialDialog` nimmt die Basis deshalb mit `overflow-visible` zurück;
  `overflow-hidden` wäre die falsche Ausnahme — es klemmt denselben Rahmen.
- **#311 war zunächst halb wirkungslos, und kein Test zeigte es:** `aria-relevant` steht per
  Default auf `additions text`, eine **Entfernung** von Text wird nicht angesagt — der
  Übergang auf `""` blieb also stumm, und der eigene Test schrieb ihn als Soll fest. Der leere
  Zustand trägt jetzt Text (`sr-only`: aus dem Fluss, im Barrierefreiheitsbaum).
- **Drei neue Issues:** #330 (der ✕ eines gerollten Dialogs wandert aus dem Bild), #331 (der
  README-Wächter schlug **still** nicht an — er prüft auf die Zeichenkette `git commit`, und
  `git -c … commit` schiebt sich dazwischen), #332 (der Deckel kennt die 40-px-Ziehzone der
  Titelzeile nicht — **hergeleitet, nicht gemessen**).

---

## B2 — Routing-Wächter: gehört NICHT in dieses Repo (#323, dann #324, dann #326)

**Nachgeprüft:** `git ls-files .claude/` ist **leer** — komplett untracked. `.claude/hooks/`
enthält 5 Dateien. In `E:\Git\claude-routing\projekte\transkribor\hooks\` liegen davon
**genau zwei**: `routing-sperre.sh` und `routing-sperre.test.sh`, beide **byte-identisch**
mit den lokalen.

**B2a — sofort: #323 allein.** Selbsttest verschiebt 30 unversionierte `review-*.md` →
Wegwerf-Fixture im Scratchpad statt im echten Projektstamm. Träger ist
`routing-sperre.test.sh`, der in claude-routing liegt. Ein PR dort, fertig.

**B2b — #324 braucht einen Schritt davor.** Seine beiden Träger sind
`kein-pauschales-add.sh` und `CLAUDE.md`. **Keiner von beiden ist in claude-routing
versioniert** (`find` über das ganze Repo: kein Treffer; `readme-pflicht.sh` fehlt ebenso).
CLAUDE.md ist hier gitignoriert (`.gitignore:35`) und dort nicht gespiegelt. **Ein „PR in
claude-routing" für #324 hätte heute keine Datei zum Ändern.** Fassung 1 bündelte #324 mit
#323 auf einer Prämisse, die nur das *Verzeichnis* geprüft hatte, nicht seinen Inhalt.
Reihenfolge: erst `kein-pauschales-add.sh` (und sinnvollerweise `readme-pflicht.sh`) in den
Spiegel aufnehmen, dann die Begründung austauschen — **nicht die Entscheidung**, die bleibt
richtig. Die CLAUDE.md-Hälfte bleibt eine lokale Änderung ohne Reviewweg; das ist hinzunehmen,
aber zu benennen.

**B2c — #326 getrennt und später** (Zeitanker der PR-Sperre): **kein Tweak, sondern ein
Neuentwurf.** Der Issue sagt selbst, eine mtime sei die falsche Größe — sie sagt *wann* ein
Bericht entstand, nicht *wozu* er gehört. Ohne entschiedenen Ersatz (Bericht nennt den
Branch? git-Notiz? Commit-Trailer?) ist das Brainstorming, keine Umsetzung.
*Nebenbefund:* #326 nennt als Spiegel noch `docs/superpowers/routing-hooks/` — das
Verzeichnis existiert nicht mehr, die Fundstelle im Issue ist veraltet.

### ► UMGESETZT in claude-routing PR #7 + #8 (2026-08-22), #323 ist ZU

Alles oberhalb bleibt als Begründung stehen. Was der Bau ergab und im Plan so nicht stand:

- **Die Fixture reichte weiter, als B2a annahm.** Nicht nur die „kein Review"-Fälle laufen
  darauf, sondern **alle** — der Test braucht den echten Projektstamm für gar nichts mehr
  (Hookpfad aus `BASH_SOURCE`). Damit fällt der Wiederherstellungs-`trap` weg **und mit ihm
  seine eigene Probe**: nichts wiederherzustellen ist besser als ein geprüftes
  Wiederherstellen. Zusicherungen 42 → 43.
- **Drei Befunde kamen erst beim PRÜFEN des Fixes, jeder von einem anderen Prüfer — und alle
  drei sind dieselbe Klasse:** die Begründung versprach mehr als der Code hielt. Subagent:
  `GIT_CONFIG_GLOBAL/SYSTEM` (ein globales `core.hooksPath` tötet die Fixture-Commits) plus ein
  Fixture-Wächter, der „die ganze Reihe hängt daran" sagte und nur `fehler=1` setzte
  (gemessen: 35 von 40 Prüfungen liefen dann still gegen den echten Stamm). CLI:
  `GIT_CONFIG_COUNT` als **dritter** Kanal. Bot (**Major**): `GIT_DIR`.
- **Der Bot-Befund war beim Nachstellen ein echter Schaden:** mit gesetztem `GIT_DIR` landeten
  drei Fixture-Commits in Transkribors **echtem** Repo (835 → 838, nicht gepusht, per
  `git reset --soft` zurückgesetzt). Genau die Schadensklasse von #323, über einen Weg, den das
  Issue nicht nannte. Nach dem Fix: 835 → 835.
- **Die Isolation hat jetzt einen eigenen Wächter (Prüfung 42):** der Test ruft sich selbst mit
  feindlicher Umgebung auf, über beide Konfigurationskanäle. Nicht zirkulär — er fragt nicht
  „hast du etwas angefasst" (die eigene Behauptung als Maßstab), sondern spritzt eine Störung
  ein und misst die Wirkung. Preis: 17 statt 8 Sekunden Laufzeit.
- **Der Preis des Fixes ist benannt, nicht verschwiegen → #334.** Der alte Test lief im echten
  Repo und wäre bei `master`→`main` rot geworden; der Hook verdrahtet `master` und lässt ohne
  Anker **still** durch. Die Fixture baut sich ihr eigenes `master`. Der Sensor ist weg, #334
  ist sein Ersatz. `claude-routing` selbst hat keinen `master` — dort wäre die Sperre von Tag 1
  an aus gewesen, mit grünem Selbsttest daneben.
- **Ein zweiter Defekt fiel beim Abgleich Spiegel↔Live auf (PR #8):** `claude-routing` hatte
  keine `.gitattributes`, `core.autocrlf=true` schrieb 335 CR-Bytes in die Arbeitskopie. Unter
  Linux-bash ergibt das Syntaxfehler und **Exit 0 bei leerem stdout** — Erfolg für einen
  Selbsttest, der nie gelaufen ist.
- **Zwei Messfallen, beide selbst hineingetappt:** `sed` scheiterte zweimal still an einer
  Fortsetzungszeile, die Mutation kam nie an (`mutation-greift-nicht-gruen` — nur die
  Anwendungs-Kontrolle `grep -c` auf den Mutationsmarker fing es). Und `out=$(bash … 2>&1)`
  durch zwei Shell-Ebenen (`wsl -- bash -c`) verschluckte die Ausgabe und meldete leeres stdout
  auch für den **grünen** Lauf — eine Behauptung, die ich zurückziehen musste.
- **Betriebsnotiz:** die CodeRabbit-CLI hing 17 Minuten bei 1 s CPU, weil sie den Default-Branch
  per `git fetch` holt, `claude-routing` **privat** ist und WSL keinen `credential.helper` hat.
  Transkribor ist öffentlich, deshalb fiel es nie auf. Abhilfe ohne Zugangsdaten: einmal
  `git remote set-head origin main` (rein lokal), danach lief die Review in 100 Sekunden.

---

## B3 — Der Mac-Durchgang (#318 + #84, #36 nur zur Hälfte) ▶ blockiert auf Marcus

**Was eine Mac-Sitzung wirklich schliesst:** #318 und #84 ganz — **#36 nur zur Hälfte.**
Sein Titel lautet „macOS **und Linux**", und Marcus' Mac prüft weder AppImage noch deb.
Fassung 1 schrieb „entblockt 3 Issues"; das stimmt nicht. Der Linux-Teil braucht eine VM mit
Desktop-Bibliotheken (WSL hat keine) und kommt in keinem Bündel vor — **das ist eine offene
Lücke, keine Entscheidung.**

**Reihenfolge in der Sitzung:**
1. **#318** — `.dmg` per Finder starten, Protokoll lesen. Bestanden: weder „Failed to parse
   URL" noch „app-update.yml nicht lesbar"; bei neuerer Fassung „Update … verfügbar" mit
   funktionierendem „Manuell herunterladen". Fünf Minuten.
2. **#36 (macOS-Hälfte)** — volle Pipeline aus dem `.dmg`, zwingend per **Finder** (nicht
   `npm start`: das erbt den Shell-PATH und versteckt genau die Fehlerklasse). Mitzuprüfen:
   ist `models/` im `.dmg` angekommen, läuft die Sprechertrennung ohne HF-Token.
3. **#84** — dieselbe Datei mit und ohne `--prompt`, Abdeckung (Summe der Segmentdauern) und
   Wortzahl vergleichen.

**Meine Vorarbeit — und was daran WIRKLICH Arbeit ist.** #318 und #36 tragen ihre Schritte
und Bestanden-Kriterien bereits im Issue-Text; sie abzuschreiben wäre Doppelung. Echt ist
nur **#84**: `--prompt` ist aus `whispercpp.transkribiere()` **entfernt**, der „mit
Prompt"-Arm der Messung hat also keinen Aufrufweg — den gibt es nirgends. Zu bauen ist ein
kleines Mess-Harness (zwei `whisper-cli`-Läufe, Abdeckung + Wortzahl auszählen), das Marcus
ohne Nachfragen starten kann. Alles andere ist eine halbe Seite Bestanden-Haken.

**Nicht dazu gebündelt:** #95 (Signieren) — Beschaffung, keine Messung.

---

## B4 — Diarisierungs-Diagnose (#275) ▶ allein, als Türöffner

**Warum allein:** #275 ist der einzige der vier Diarisierungs-Issues, der jetzt läuft — reines
Protokoll, zwei Schlüssel mehr in `<base>.diar.json`, **kein Verhaltenswechsel**. Die anderen:
- **#274** (`min_active_ratio`) ist laut eigenem Text „kein fertiger Fix", **nur mit dem
  Referenzsatz aus Task 8 messbar** → hängt an Marcus.
- **#276** (DiariZen) ist eine **Lizenzentscheidung** vor jeder Messung.
- **#267** ist in seiner Prämisse widerlegt (MEMORY/CLAUDE.md:889-895: `Sprecher 1` ist ein
  *gemischter* Cluster) → braucht eine **Disposition**, siehe unten.

**Die Machbarkeitsfrage ist inzwischen beantwortet — und die Antwort ist unbequem.**
Fassung 1 sagte „ungeprüft, erste Frage vor dem Bau". Gemessen:
`clustering.py:609` `q, sp = cluster_vbx(…)` ist eine **lokale Variable**; :669 gibt
`(hard_clusters, soft_clusters, centroids)` zurück — **`sp` ist nicht dabei**.
`speaker_diarization.py:640` verwirft selbst `soft_clusters`. `webtool/diarize.py:118` sieht
nur das Endergebnis. **Ohne Patch kommt man an `sp` nicht heran.** Der einzige Weg ist der im
Issue beschriebene Monkeypatch auf `pyannote.audio.pipelines.clustering.cluster_vbx` (der
Name ist zur Importzeit gebunden — `utils.vbx` zu patchen liefe ins Leere). Indirekt sichtbar
wäre nur die *Anzahl* der Überlebenden (`centroids.shape[0]`), nie das Spektrum.

**Folge:** #275 wird ein **best-effort-Monkeypatch** mit Rückfall auf „keine Diagnose", nicht
ein sauberer Auslesepfad. Das ist vertretbar (es ist reine Diagnose, ein Ausfall kostet
nichts), muss aber im Plan des Bündels als solches stehen — und der Patch braucht einen
Wächtertest, der rot wird, wenn pyannote die Signatur ändert.

**Warum es trotzdem zuerst zählt:** heute ist ein echtes 2-Sprecher-Gespräch nicht von einem
zu unterscheiden, bei dem zwei Sprecher knapp unter die VBx-Schwelle gestorben sind. Ohne
diese Zahl misst jeder Kandidat blind — auch #274, wenn Task 8 kommt.

### ► UMGESETZT in PR #336 (2026-08-22), #275 ist ZU

Alles oberhalb bleibt als Begründung stehen. Was der Bau ergab und im Plan so nicht stand:

- **Es sind ZWEI Patchpunkte, nicht einer.** Der Plan (und der Issue) kennen nur `cluster_vbx`.
  Die Überlebensquote kommt aus `filter_embeddings` — einer **Methode** mit dokumentierter
  Signatur, gepatcht auf `type(pipe.clustering)` statt auf der Instanz (pyannotes
  `Pipeline.__setattr__` ist überschrieben, nachgemessen). Der Rückbau ist dort ein `delattr`,
  weil die Methode in `vars(BaseClustering)` steht und nicht in `vars(VBxClustering)` — und
  **beide** Rückbau-Zweige sind getestet, weil eine künftige pyannote-Fassung sie direkt auf
  der benutzten Klasse definieren könnte.
- **Der schwerste Befund lag in der eigenen Sonde, und zwei Subagenten fanden ihn unabhängig.**
  `q, sp = vbx_alt(...)` stand VOR dem `suppress` und schrieb die Arität als Konstante fest.
  Ändert pyannote die Rückgabeform, wirft die *Protokoll*funktion mitten in fremdem Clustering;
  der Wurf reist bis in `cmd_diarize`s breites `except` und ergibt „Korrektur ohne Cluster" für
  **jede Datei des Laufs** — die Sprechertrennung fällt still aus, mit Erfolgsmeldung. Genau
  der Tag, für den die Best-effort-Architektur gebaut ist, und sie hätte in die **falsche
  Richtung** versagt.
- **Der Test war grün, als die Zahl schon falsch war.** `slots` zählte zunächst
  `chunks × speakers`. Am echten Audio: angeboten 48, mit Sprache 20, durchgelassen 16 — 20 %
  verworfen gegen die Sprache, **67 %** gegen die angebotene Menge. Nur die 20 % liegen in der
  Grössenordnung der Spec-Tabelle (1.6(j), 16–32 %). Gefunden hat es allein der Vergleich mit
  einer **Referenzmessung im Repo**; ohne die wäre 67 % eine plausible, testgedeckte Zahl
  gewesen.
- **Drei eigene Behauptungen zurückgezogen** statt verteidigt: „der Default JEDES heutigen
  Aufrufers" (`cmd_diarize` übergibt immer ein dict — die Produktion fährt den Patch-Zweig);
  die Spec-Vergleichbarkeit (Grössenordnung, **nicht** Gleichheit — die damalige Zählmethode ist
  nirgends erhalten); „Überlebensquote des `min_active_ratio`-Filters" (`filter_embeddings`
  verwirft auch NaN, die Differenz vermischt zwei Ursachen).
- **Der Betrieb ist NICHT betroffen** — ausdrücklich gemessen, nicht geschlossen: keine neue
  Nebenläufigkeit (jeder Job ist ein Subprozess, `cmd_diarize` läuft seriell vor dem Executor),
  kein Verhaltenswechsel (drei Läufe ohne/mit/danach liefern identische Turns), alle
  Sidecar-Leser geprüft — der neue Schlüssel ist inert, kein Frontend liest ihn.
- **Eine abgeschossene CLI meldet Erfolg.** Der Nachhol-Lauf für den rate-limitierten Bot lief
  in `timeout 600`, bekam SIGTERM, fuhr sauber herunter und endete mit **Exit 0 ohne
  `"type":"complete"`**. Erkannt nur, weil das fehlende Abschlussereignis nicht zum grünen Exit
  passte — dieselbe Regel wie bei `_run_claude`: Erfolg misst man am Ergebnis, nicht am
  Exitcode. Zweiter Lauf mit 25 Minuten: `review_completed, findings: 0`.
- **Dreimal hat in dieser Arbeit die Anwendungs-Kontrolle eine wertlose grüne Zahl abgefangen**
  (zweimal scheiterte `sed` still an einer Fortsetzungszeile, einmal war der Mutationsanker
  nicht eindeutig — `tdir = …` kommt in `correct.py` zweimal vor). „Grün" bedeutete dort
  jeweils *nichts verändert*.

---

## B5 — sperre.py: zwei Issues, ZWEI verschiedene Antworten (#237 ≠ #210)

Fassung 1 warf beide in ein „nicht bauen". Das trägt nur für eines von beiden.

**#237 (Netzfreigabe) — nicht bauen. Die Belege stehen wörtlich im Issue:** der Fall wurde
nie beobachtet, und die Zahl „zehner Sekunden" ist aus dem Ursprungs-Issue übernommen und
**nicht nachgemessen**. Wer es angeht, misst zuerst, ob eine getrennte SMB-Freigabe hier
überhaupt hängt — das ist die ganze Arbeit, und sie kann mit „nein" enden.

**#210 (`stale` ist eine Schätzung) — offen, nicht abgelehnt.** Das Kopfargument gegen beide
war „ein Faden je Lock-Erwerb auf dem Request-Pfad". **Das trifft #210 nicht:** der Issue
zeichnet selbst einen **fadenfreien** Weg vor — die Prozess-**Startzeit** mit in den Merker
(Windows `GetProcessTimes` am ohnehin geöffneten Handle, Linux `/proc/<pid>/stat` Feld 22).
Der macht die Fristschätzung *überflüssig* statt sie zu verbessern. Fassung 1 beschrieb ihn
unter „Falls doch" und sortierte ihn trotzdem unter „gar nicht" — das war eine Bequemlichkeit,
keine Entscheidung. Der verschwiegene Preis des Nichtstuns: die Schadensklasse (verlorener
Read-Modify-Write bei `settings.save()`/`projekt.setze_datei`) ist **einmal real eingetreten**
(#207) und bleibt offen; heute schützt nur, dass jemand die Arithmetik im Kopf richtig macht.
**Disposition:** kein Wegwerf-Kandidat, sondern ein Bündel für später — mit dem ausdrücklichen
Vermerk, dass auf macOS kein portabler Weg ohne `sysctl`-Structs existiert und es dort beim
heutigen Verhalten bliebe.

---

## B6 — Mehrsprachigkeit: Reihenfolge, kein Bündel (#136 → #137, #164 blockiert)

**#136 vor #137** — der Merkposten steht in **MEMORY.md:127**, nicht in CLAUDE.md (Fassung 1
schrieb ihn CLAUDE.md zu; wer dort nachschlägt, findet ihn nicht). Der Grund trägt trotzdem:
- **#136** ist eine **Messung** (Treue der Korrektur an nicht-deutschem Audio). Sie
  entscheidet, ob #137 überhaupt das richtige Problem löst.
- **#137** wäre ein Bau auf einer ungemessenen Annahme.
- **#164** ist an einem **Datenproblem** blockiert, nicht an Priorität: `faster_whisper.Segment`
  hat kein `language`-Feld, der Proxy sieht kein `seek`, und eine Zuordnung über die
  Reihenfolge bricht **still** an stillen Fenstern.

Sie teilen keinen der vier Kostenposten — gebündelt gewönne man nichts.

---

## Nicht bündeln — mit Disposition

| Issue | Disposition |
|---|---|
| **#288** torch CVE | **Nichts zu tun.** Schliesst sich selbst, sobald der cu128-Index eine Fixfassung führt. Der Issue IST der Tracker. Handlung: quartalsweise nachsehen. |
| **#45** Dependency Dashboard | Renovate-Bot-Artefakt, kein Issue. |
| **#251** `main.js` ohne Tests | **Unblockiert, Weg bekannt** (Weg 3, „ladbar machen", 6 Attrappen: app, BrowserWindow, ipcMain, nativeTheme, net, shell). MEMORY.md:129 sagt „bleibt GETRENNT" — das heisst *eigener PR*, **nicht „nie"**. Fassung 1 gab ihm keine Zeile in der Reihenfolge; das war eine Auslassung. → **nach B4 einplanen.** |
| **#267** Interviewer-Split | **Zombie — braucht eine Entscheidung, keine Arbeit.** Die Prämisse ist widerlegt, der gebaute Fix läuft ohne Wirkungsbehauptung. Entweder **schliessen** (mit der Messung als Begründung) oder auf das umwidmen, was wirklich nötig wäre: Zuordnung **je Segment** statt je Cluster. Beides ist billig; ihn offen und unbeschrieben zu lassen ist die einzige schlechte Option. |
| **#36 (Linux-Hälfte)** | **Kein Bündel hat ihn.** Braucht eine VM mit Desktop-Bibliotheken. Offene Lücke, hier benannt statt versteckt. |
| **#95** Installer signieren | Beschaffung + Geld. Blockiert auf **einer** Frage an Certum: läuft SimplySign (Cloud) in GitHub Actions? Mit Hardware-Token müsste jeder Release von Hand signiert werden — das entwertet `release.yml`. **Die Anfrage braucht einen Besitzer**; sie stellt sich nicht von selbst. |
| **#328** Spendenknopf im Fehlerzustand | Bewusste Entscheidung aus PR #327; der Reviewer gab absichtlich keine Empfehlung. Geschmacksfrage → Nachfrage Punkt 4. |

---

## Entscheidungen, die Marcus blockieren — EINE Nachfrage

> **Fassung 3, 2026-08-22:** gestellt und beantwortet, soweit es Entscheidungen waren.
> Punkte 5, 6 und 7 sind erledigt (mit #276 aus Fassung 2 also **vier von sieben**). Offen
> bleiben **2** (Task 8), **3** (#95) und **4** (#70+#71) — das sind Arbeit und Beschaffung,
> keine Entscheidungen. Die Antworten stehen unten und in den Issues selbst.

1. ~~**#276 — DiariZen-Lizenz:** ist ein **CC-BY-NC**-Modell im ausgelieferten Installer
   akzeptabel? Bei *nein* entfällt der Kandidat ersatzlos, community-1 bleibt gesetzt, #276
   ist sofort schliessbar.~~
   ✅ **beantwortet: akzeptabel** (2026-08-22). Aus der Entscheidungs- ist eine **Messaufgabe**
   geworden — DiariZen bleibt Kandidat, die Messung hängt an Task 8. #276 bleibt deshalb offen,
   aber nicht mehr als *Nachfrage*.
2. **Task 8 — der Referenzsatz** (13 im Editor korrigierte Dateien, Gruppenmitglieder
   einzeln benannt). Blockiert #274 und jede weitere Diarisierungs-Messung. Steht seit
   2026-08-17. *(In Fassung 1 fehlte er, obwohl B4 ihn selbst als Blocker nennt.)*
3. **#95 — Signieren:** kaufen? Und wer stellt die Certum-Anfrage (Cloud CI-tauglich?).
4. **#70 + #71 — Layout nach PR #68:** beide sind Gestaltungsfragen, keine Defekte. Sie
   gehören zusammen: dieselbe Ursache (die Aufteilung stimmt bei 300 Projekten und bei 5
   nicht). → `superpowers:brainstorming`, nicht ein Fix.
5. ~~**#328 — Takt:** Spendenknopf im Fehlerzustand ausblenden, ja oder nein?~~
   ✅ **beantwortet: ausblenden** (2026-08-22). → B7.
6. ~~**Sachfrage (B6):** gibt es echtes nicht-deutsches Interview-Audio für #136?~~
   ✅ **beantwortet: liegt vor** (2026-08-22). B6 ist damit fahrbar, die Vorbedingung
   `positivkontrolle-braucht-echtes-material` ist erfüllt.
7. ~~**Sachfrage (#36):** gibt es eine Linux-VM mit Desktop, oder bleibt die Hälfte offen?~~
   ✅ **beantwortet: keine, und keine geplant** (2026-08-22). #36 bleibt nach der Mac-Sitzung
   offen — die Lücke ist am Issue benannt statt weggezählt.

---

## Empfohlene Reihenfolge

| # | Was | Ergebnis |
|---|---|---|
| 1 | ~~**B1** #283 + #311~~ ✅ **erledigt** (PR #333) | 2 zu |
| 2 | ~~**B2a** #323 (in `claude-routing`)~~ ✅ **erledigt** (PR #7 + #8) | 1 zu, +1 neu (#334) |
| 3 | ~~**B4** #275~~ ✅ **erledigt** (PR #336) | 1 zu, Tueroeffner offen |
| 4 | ~~**Nachfrage an Marcus**~~ ✅ **erledigt** (2026-08-22) | 4 von 7 beantwortet |
| 5 | ~~**Stufe 0** PR-Bestand: #322 · #325→#338 · 4 Branches~~ ✅ **erledigt** | 0 offene PRs |
| 6 | ~~**#267** schliessen oder umwidmen~~ ✅ **geschlossen**, mit der Messung | 1 zu |
| 7 | **B3-Vorarbeit** #84-Mess-Harness + Bestanden-Blatt | entblockt die Mac-Sitzung |
| 8 | **B2b′** Spiegel-Import → #331 → #334 → #324 (`claude-routing`) | 3 zu, 1 PR |
| 9 | **B7** #330 + #328 (eine Browser-Sitzung) | 2 zu, 1 Sitzung |
| 10 | **#251** einplanen · **B6** #136 (Material liegt vor) | 1 zur Disposition, 1 messbar |
| 11 | **B2c** #326 — erst Entwurf, dann Bau | nach Entwurf |
| — | **#237** nicht bauen · **#210** später, fadenfreier Weg · **#36-Linux** ohne Weg | — |

**Warum B3-Vorarbeit (7) vor dem Routing-Bündel (8) steht** — obwohl das Bündel drei Issues
schliesst und die Vorarbeit keines: es ist dasselbe Prinzip, das die Nachfrage nach vorn
gezogen hat. **Was Marcus entblockt, geht zuerst.** Der Mac-Termin ist angefragt und noch
offen; kommt er kurzfristig, muss das Harness schon liegen. Das Routing-Bündel wartet
folgenlos, eine ungenutzte Mac-Sitzung nicht.

**Ehrliche Rechnung.** Schritte 1–3 schliessen **4 Issues in 3 Review-Zyklen** mit **1
Browser-Sitzung**. Unbündelt wären es 4 Zyklen und 2 Browser-Sitzungen (#323 und #275 sind
Shell bzw. Backend und brauchen keinen Browser). **Ersparnis: 1 Reviewslot, 1 Browser-Sitzung.**
Fassung 1 behauptete „vier statt fünf Zyklen, eine statt drei Sitzungen" — beides falsch
gerechnet, weil sie #275 eine Browser-Sitzung zuschrieb, die es nicht braucht.

**Bilanz über die 24 AUSGANGS-Issues** — der Stand vom 2026-08-22, als dieser Plan
geschrieben wurde. Gezählt in ISSUES, jedes genau einmal. (Die Nachfrage oben bündelt mehrere
davon zu *fünf Entscheidungen*; das ist eine andere Einheit und darum hier nicht die
Zählgrösse.) **Das ist kein Abbild der heutigen Issue-Liste** — was seither dazugekommen ist,
steht darunter.

| Kategorie | Anz. | Issues |
|---|---|---|
| jetzt gebaut | **4** | #283, #311 (B1) · #323 (B2a) · #275 (B4) |
| wartet auf Marcus | **10** | #318, #36, #84 (Mac) · #274, #276 (Task 8) · #136 (Audio) · #95 (Kauf) · #70, #71 (Gestaltung) · #328 (Takt) |
| terminiert, Reihenfolge steht | **5** | #324 (nach Spiegel-Import) · #326 (Neuentwurf) · #137 (nach #136) · #164 (Datenproblem) · #210 (fadenfreier Weg) |
| Disposition nötig, keine Arbeit | **2** | #267 (schliessen oder umwidmen) · #251 (einplanen) |
| Nicht-Issues | **2** | #288 (Tracker, schliesst sich selbst) · #45 (Renovate-Bot) |
| abgelehnt | **1** | #237 (nie beobachtet, Kernzahl ungemessen) |
| **Summe** | **24** | |

**Keines ohne Grund weggeschoben** — das war der schwerste Befund gegen Fassung 1, und die
vier ohne tragenden Grund (#251, #210, #36-Linux, #267) haben ihn jetzt.
**#276 ist am 2026-08-22 beantwortet** (CC-BY-NC im Installer akzeptabel) und bleibt trotzdem
in „wartet auf Marcus": aus der Entscheidungs- ist eine **Messaufgabe** geworden, und die
hängt an Task 8.

### Seit diesem Plan dazugekommen — NICHT in der Tabelle oben

Die Summe 24 bleibt die des Ausgangsstands; diese vier Posten kommen obendrauf und sind hier
aufgeführt, damit die Tabelle nicht als aktuelle Issue-Liste missverstanden wird.

| Posten | Woher | Einordnung |
|---|---|---|
| **#330** ✕ eines gerollten Dialogs wandert aus dem Bild | Folge von B1 | Frontend, klein; drei Auswege gemessen. Kandidat für ein späteres UI-Bündel. |
| **#331** README-Wächter schlägt still nicht an | beim Bau von B1 gefunden | Gehört zum **Routing-System** — und wie #324 gibt es dafür in `claude-routing` noch keine Datei. Vorbedingung: Spiegel-Import. |
| **#332** Deckel kennt die Ziehzone der Titelzeile nicht | Review zu B1 | **Zuerst messen, dann entscheiden** — ob der Klick dort wirklich zieht, ist ungeprüft. Braucht die gepackte App, also Marcus. |
| **#36, Linux-Hälfte** | schon in B3 benannt | **Kein Bündel hat sie.** Marcus' Mac deckt AppImage/deb nicht ab; nötig wäre eine VM mit Desktop-Bibliotheken. #36 bleibt nach der Mac-Sitzung offen. |

---

## Fassung 3 (2026-08-22 abends)

**Was sich seit Fassung 2 geändert hat:** #267 ist zu, beide offenen PRs sind weg, **vier der
sieben** Nachfragen sind beantwortet (#276, #328, #136-Material, #36-VM; offen bleiben
Task 8, #95 und #70+#71). Fassung 2 hatte **drei Lücken**; sie werden hier
geschlossen, nicht überschrieben — alles oberhalb bleibt stehen.

### Lücke 1: offene PRs waren kein Kostenposten

Fassung 2 zählt vier teure Posten und **keinen für liegende PRs**. Prompt lagen zwei
vergessen herum — beide grün, beide mergebar, seit dem Vortag. **Der fünfte Posten steht
jetzt oben**, aber als *Zustands*-, nicht als Kontingentposten: ein unangetasteter PR
verbraucht **nichts** (Posten 2 zählt Commits, siehe dort). Er kostet, dass fertige Arbeit
niemanden erreicht, dass der Branch driftet — und im teuren Fall, dass ein grüner Haken
einen ungeprüften Stand verdeckt.

*(Die erste Fassung dieses Absatzes behauptete das Gegenteil — „ein offener PR bindet einen
Reviewslot" — und der Satz überlebte den Fix am Kostenposten selbst um einen Commit. Genau
`widerlegte-regel-lebt-in-ihren-traegern`: die Behauptung wurde an EINER Stelle korrigiert
und lebte in ihrem zweiten Träger weiter, bis die CLI ihn fand.)*

Was der Aufräumlauf ergab und was man nicht aus dem Diff liest:

- **#325 trug netto EINE Datei** (`.coderabbit.yaml`, 21+/3−) bei **27 Commits**. Deren Inhalt
  (das Routing-System) war längst nach `claude-routing` gezogen; ein Rebase-Merge hätte 27
  Commits ohne Gegenstand auf master geschrieben.
- **Sein grüner CodeRabbit-Haken bedeutete „nicht geschaut".** Status auf `37df979`:
  `CodeRabbit | success | Review rate limited | 2026-08-22T07:36:45Z`. Das echte Review lief am
  **21.08. um 22:04**, der Commit stammt vom **22.08. um 07:35**. Die Falle steht in CLAUDE.md
  — aber in einer Form, die dort **nicht** steht: **die Drosselung hängt am COMMIT, nicht am
  PR.** Ein rate-limitierter Lauf zählt als „bereits gesehen", und danach hilft auch
  `@coderabbitai review` nicht mehr. Und der sonst empfohlene Weg greift hier nicht: im
  PR-Kommentar steht dazu **nichts**, die Auskunft steht allein in der
  **Statusbeschreibung** — abzurufen über
  `gh api repos/<owner>/<repo>/commits/<sha>/status`.
- **Der Ausweg ist ein frischer Commit, kein Wegklicken.** Neu geschnitten als **#338**,
  Inhalt byte-identisch: `success | Review completed`, „No actionable comments". Beide Zustände
  an derselben Datei gemessen, im Abstand von Stunden.

### Lücke 2: #334 hatte keinen Slot

Er entstand als **benannter Preis** von B2a und stand danach nur in dessen ►UMGESETZT-Notiz —
in keiner Reihenfolge, in keiner Bilanz. Ein Issue, das nur im Fliesstext eines erledigten
Bündels lebt, ist praktisch verloren.

### Lücke 3: die Routing-Issues teilen eine Vorbedingung, standen aber in drei Abschnitten

Zuvor stand #324 in B2b, #326 in B2c, #331 unter „dazugekommen", #334 nirgends.
**Drei davon hängen an derselben Sache** — genau der Fall, für den es das
Bündelungskriterium gibt.

#### B2b′ — #331 + #334 + #324 sind EIN Bündel

**Nachgemessen am 2026-08-22 abends, also NACH B2a** (Fassung 2 mass davor; das Ergebnis hält,
aber es war nachzumessen — B2a hat in genau diesem Repo Dateien angefasst):

`git ls-files` in `claude-routing` listet **7** Hook-Dateien. `kein-pauschales-add.sh` und
`readme-pflicht.sh` sind **nicht darunter**. Lokal liegen in `.claude/hooks/` **fünf** Dateien,
gespiegelt sind **zwei** (`routing-sperre.sh`, `routing-sperre.test.sh`).

Reihenfolge im Bündel: **Spiegel-Import → #331 → #334 → #324.** Ein PR, drei Issues, kein
Browser. **Ein** Reviewversuch ist dabei die Untergrenze, nicht die Zahl — jede Fixrunde ist
ein weiterer (Posten 2).

- **#331** — `readme-pflicht.sh:20` prüft auf die Zeichenkette `git commit`; ein globales
  `-c` schiebt sich dazwischen und macht den Wächter blind. Er war **still aus**.
- **#334** — `routing-sperre.sh:202/207` verdrahtet `master`; ohne diesen Branch bleibt der
  Anker leer und `:210` lässt durch. In jedem `main`-Repo **still aus**. `claude-routing`
  selbst hat keinen `master`.
- **#324** — abgelaufene Messung („python liegt im Git-Bash-PATH NICHT"). **Am 2026-08-22
  nebenbei erneut widerlegt:** `python -c` läuft in Git Bash, Exit 0.

**„Anderes Repo" heisst nicht „gratis":** `claude-routing` verbraucht **dasselbe**
CodeRabbit-Kontingent. Der Slot ist geteilt, nicht zusätzlich. Und dort ist die CLI der einzige
brauchbare Weg — das Repo ist privat, der Lauf hing zuletzt 17 Minuten am fehlenden
`credential.helper` in WSL (Abhilfe: einmal `git remote set-head origin main`, rein lokal).

**#326 bleibt draussen** — unverändert die Einordnung aus B2c: ein Neuentwurf, kein Tweak.

#### B7 — UI-Bündel #330 + #328 (eine Browser-Sitzung)

Nach demselben Kriterium wie B1: ein App-Start, ein Wegwerf-Projekt, ein PR.

- **#330** — der ✕ eines gerollten Dialogs wandert aus dem Bild (gemessen: `top` fällt von 33
  auf **−297** bei 320 px Fensterhöhe). Folge des Höhendeckels aus B1.
- **#328** — Spendenknopf im Fehlerzustand der Leiste. **Entschieden: ausblenden**
  (Marcus, 2026-08-22). Der Reviewer an PR #327 hatte bewusst keine Empfehlung gegeben.

**#332 gehört NICHT dazu.** Er braucht die **gepackte** App — also Marcus — und ist bislang
*hergeleitet, nicht gemessen*. Ob ein Klick in den obersten 40 px wirklich das Fenster zieht,
ist ungeprüft; das ist der erste Schritt, nicht der Fix.

### Beantwortet am 2026-08-22

| Frage | Antwort | Folge |
|---|---|---|
| **#328** Takt | ausblenden | → B7 |
| **#267** | schliessen, mit der Messung als Begründung | **zu** |
| **#136** Material | liegt vor | B6 ist fahrbar |
| **#36** Linux-VM | keine, und keine geplant | Lücke am Issue benannt |

**Offen und weiterhin bei Marcus:** **Task 8** (der Referenzsatz — blockiert #274 und jede
weitere Diarisierungs-Messung, steht seit dem 2026-08-17 und ist der teuerste offene Posten
überhaupt), der **Mac-Termin**, die **#95-Certum-Anfrage**. **#70 + #71** brauchen ein
`superpowers:brainstorming`, keinen Fix — sie sind Gestaltungsfragen mit einer gemeinsamen
Ursache.

### Bilanz über die 23 HEUTE offenen Issues

Ersetzt für den Tagesstand die Tabelle über die 24 Ausgangs-Issues; die bleibt als
Ausgangsaufnahme stehen. Gezählt in Issues, jedes genau einmal.

| Kategorie | Anz. | Issues |
|---|---|---|
| als Nächstes gebaut | **6** | #331, #334, #324 (B2b′) · #330, #328 (B7) · #84 (B3-Vorarbeit) |
| wartet auf Marcus | **7** | #318, #36 (Mac) · #274, #276 (Task 8) · #95 (Kauf) · #70, #71 (Gestaltung) |
| terminiert, Reihenfolge steht | **5** | #326 (Neuentwurf) · #136 → #137 · #164 (Datenproblem) · #210 (fadenfreier Weg) |
| Disposition nötig, keine Arbeit | **2** | #251 (einplanen) · #332 (erst messen, dann entscheiden) |
| Nicht-Issues | **2** | #288 (Tracker) · #45 (Renovate-Bot) |
| abgelehnt | **1** | #237 |
| **Summe** | **23** | |

*(#84 hat zwei Hälften — mein Mess-Harness und Marcus' Messung darauf. Es steht in der
ersten Zeile, weil die Vorarbeit als Nächstes ansteht; die Mac-Hälfte hängt am Termin.)*

### Was Fassung 2 nicht hatte

| Auslassung | Wirkung |
|---|---|
| Kein Kostenposten für offene PRs | Zwei grüne PRs lagen einen Tag lang — fertige Arbeit, die niemanden erreichte, und an #325 ein grüner Haken über einem ungeprüften Stand. *(Kontingent kosteten sie nicht — das war Fassung 3s eigener Fehlgriff, siehe Posten 2.)* |
| #334 in keiner Reihenfolge | Der benannte Preis von B2a wäre im Fliesstext verschwunden |
| #331/#334/#324 in drei Abschnitten | Ihre gemeinsame Vorbedingung war nicht als solche sichtbar |
| „Drosselung" als PR-Eigenschaft gedacht | Sie hängt am **Commit** — ein neuer Commit ist der Ausweg, ein `@coderabbitai review` nicht |

---

## Was Fassung 1 falsch hatte

Damit die Zahlen nicht über Zitate weiterleben:

| Behauptung (Fassung 1) | Richtig |
|---|---|
| 10 Verbraucher `DialogContent`, 3 `AlertDialogContent` | **6 und 2** — Substring-Grep fing `AlertDialogContent` mit und zählte Definitionsdateien |
| „Die App ist unbedienbar" | Nur im **Browser**; `electron/main.js:50` erzwingt `minHeight: 600` |
| Getrennte Commits erlauben getrennte Ablehnung | **Nein** — Rebase-Merge des ganzen PRs. Ersetzt durch die Abbruchregel |
| `MaterialDialog` hat sticky-Kopf aus PR #310 | **Kein `sticky`** in der Datei; Bildlauf aus **#313/#315**; er ist **Negativkontrolle**, self-capped |
| #323 + #324 sind ein Bündel in claude-routing | **#324s Träger existiert dort nicht** — Spiegel-Import ist Vorbedingung |
| „#136 vor #137" / „#251 bleibt GETRENNT" stehen in CLAUDE.md | Beide in **MEMORY.md** (127, 129) |
| CodeRabbit-Trial abgelaufen | Nur der **Security**-Trial; Plan „Pro Plus" läuft, Drosselung ist dynamisch |
| B3 entblockt 3 Issues | **2,5** — #36 ist „macOS **und Linux**" |
| #275-Machbarkeit „erste Frage" | Beantwortet: **nur per Monkeypatch**, `sp` verlässt `clustering.py` nicht |
| 4 statt 5 Zyklen, 1 statt 3 Sitzungen | **3 statt 4 Zyklen, 1 statt 2 Sitzungen** |

---

## Fassung 4 (2026-08-23) — der Wächter-Bestand als eigenes Bündel

> **Diese Fassung wurde vor dem Bau von zwei Prüfern zerlegt** (`review-fassung4-fakten.md`,
> `review-fassung4-gegnerisch.md`). Der erste Entwurf schlug einen 72-Sekunden-Suitenlauf am
> PR-Moment vor und stützte sich auf eine Positivkontrolle, die **mit einem kaputten
> Klassifikator gemessen war**. Beides ist unten ersetzt, nicht geglättet. Was der erste
> Entwurf falsch hatte, steht am Ende — nicht als Zerknirschung, sondern weil die Zahlen
> sonst über Zitate weiterleben.

**Stand, nachgezählt statt fortgeschrieben:** master `d51fa3e`, `v0.31.0` live, **23 offene
Issues, 0 offene PRs** — in **beiden** Repos nachgesehen (Posten 5; `claude-routing` hat
zusätzlich 6 offene *Issues*, die Zahl 23 gilt Transkribor). Die Bündel B1–B7 aus Fassung 3
bleiben unverändert gültig; Fassung 4 fügt **kein neues Issue-Bündel** hinzu, sondern schliesst
eine Lücke im Prüfapparat selbst.

### Lücke 4: der Plan bündelt die Arbeit, aber niemand prüft den Prüfer

Fassung 3 zählt fünf Kostenposten und ordnet 23 Issues. Was in keiner Fassung steht: **die
Wächter, die diese Kosten überhaupt erzwingen, sind selbst ungeprüft.**

| Wächter | Erzwingt | Zustand |
|---|---|---|
| `kein-pauschales-add.sh` | CLAUDE.md nicht versehentlich committen (#110) | ungemessen (nicht im Prüfauftrag) |
| `readme-pflicht.sh` | README im selben Commit | **blind gegen `git -c … commit`** (#331, am echten Hook reproduziert: Exit 0) |
| `routing-sperre.sh` | Stufe 1: Subagent-Review vor dem PR | wirkt **hier**; in jedem `main`-Repo still aus (#334, im Wegwerf-Repo reproduziert) |
| — | **Test zum Fix, grüne Suite** | **existiert nicht** |

**Die Verdichtung „zwei von drei Wächtern waren still aus" ist zu scharf** und stand so im
ersten Entwurf: `routing-sperre.sh` war am Einsatzort nie aus, und `readme-pflicht.sh` erkennt
ein plaines `git commit` weiterhin. Genau genommen: **eine Blindstelle je Wächter**, beide
gemessen, beide still.

Die letzte Zeile ist **kein Versäumnis, sondern eine dokumentierte Entscheidung.**
`routing-sperre.sh` begründet sie im Kopf: „Mutationsprobe und lokaler Funktionstest sind an
keinem Dateinamen erkennbar. Eine Stufe verlässlich ist mehr wert als drei wackelige."
Wer die Testhälfte nachrüstet, muss gegen dieses Argument antreten — nicht daran vorbei.

### Der Code-Guard: zwei Stufen, und die zweite ist nicht die, die hier zuerst stand

**Stufe A — `git commit`: `fix`/`feat` ohne Testdatei.** Aus dem *gestagten* Diff (wie
`readme-pflicht.sh`). **Nur bei Commit-Messages mit `fix`- oder `feat`-Präfix** — die
Verengung ist nicht Geschmack, sie ist der Unterschied zwischen brauchbar und abschaltreif
(Messung unten). Laufzeit **0 s**, kein neuer Zustand.

**Stufe B — `gh pr create`: `tsc -b`, NICHT die Suiten.** Gemessen **470 ms**
(`./node_modules/.bin/tsc -b --force`, zwei Läufe: 475/470 ms, Exit 0). Positivkontrolle
gefahren: ein injizierter Typfehler in `src/lib/api.ts` ergibt Exit 1 mit `TS2322`, sauber
zurückgespielt. `tsconfig.app.json:28` schliesst `src` ein — also **auch die Testdateien**,
und genau dort sass der einzige gemessene Rot-Fall.

**Warum nicht die Suiten — der Grund ist eine Messung, kein Geschmack.** Im belegten Fenster
(2026-08-20 bis 08-22, `gh run list`): **136 pull_request-Läufe über 28 PR-Branches, 131 grün,
4 abgebrochen, 1 rot.** Der eine rote (PR #302, erster Lauf des Branches) fiel an
`npm run build` mit `TS2591` in `HoerBalken.test.tsx` — einem **tsc-Typfehler**. Python und
Electron waren grün, vitest lokal ebenfalls.

> **Ein Suitenlauf am PR-Moment hätte in diesem Fenster NULL Fälle gefangen und
> 28 × 72 s ≈ 34 Minuten gekostet.** Der Check, der den gemessenen Fall gefangen hätte, kostet
> **0,47 s** — Faktor 150.

**Und der Wegfall zieht drei Folgekosten mit sich, die der erste Entwurf hatte:**
die Hook-Zeitgrenze bleibt bei **10 s** (keine `settings.json`-Anhebung, deren Obergrenze
ohnehin **nicht belegbar** war); die zwei **dokumentierten Fehlalarme** des Parsers
(`routing-sperre.sh:56–68`) bleiben bei ihrem heutigen Preis, statt um Faktor ~18 teurer zu
werden; und der Hausregel-Einwand unten verliert seine Spitze.

**Die Reihenfolge „erst Review, dann Test" ist NICHT herstellbar** — passende Hooks laufen
parallel, nicht in Listenreihenfolge (hergeleitet aus der Hook-Semantik, **vor dem Bau mit
zwei Zeitstempel-Hooks zu messen**). Bei 0,47 s ist das folgenlos: es kostet zwei
Sperrmeldungen statt einer. Bei 72 s wäre es eine Minute Warten auf eine Sperre, die schon
feststand. Der Plan behauptet die Reihenfolge deshalb nicht mehr.

**Fehlersemantik — ausdrücklich, weil ihr Fehlen die Fehlerklasse dieses Abschnitts ist:**
nur Exit 2 sperrt; jeder andere Code und jeder Timeout laufen **durch**. Beide Stufen sind
also **fail-open**, und das ist die richtige Richtung (dieselbe Entscheidung wie
`routing-sperre.sh:208–210`: ein Wächter, der bei eigener Unsicherheit sperrt, blockiert
Arbeit, über die er nichts weiss). Aber sie muss **dastehen** — ein vierter Wächter mit
eingebautem Still-Aus wäre genau der Fehler, gegen den Lücke 4 argumentiert. Fehlt `node` oder
`node_modules`, schweigt Stufe B; der Selbsttest misst das als eigene Zusicherung.

**Die Fluchtwege:**

- Stufe A: **`[ohne-test]` in der Commit-Message** (Muster wie `[intern]`) **plus
  `KEIN_TEST=1` als Env-Präfix**. Der zweite ist nicht Redundanz, sondern Pflicht: bei
  `git commit -F datei`, `-c`/`-C` oder Editor-Message steht die Message **nicht** im
  Command-JSON, das der Hook liest — der Marker wäre dort unbenutzbar und die Sperre ein
  Ausgang ohne Tür. `readme-pflicht.sh` hat für diesen Fall einen zweiten Weg (README stagen);
  Stufe A hätte sonst nur die Dummy-Testdatei, also genau das Ritual, das dieser Plan als
  Risiko benennt.
- Stufe B: **`KEIN_TEST=1`**.

**Der Auditpfad ist weicher als er klingt, und das gehört gesagt:** `git commit --amend` mit
leerem Index sieht Stufe A gar nicht (gestagter Diff leer → durch), der Marker ist also
nachträglich entfernbar. `git log --grep` **zählt** die Schuld, es **beweist** sie nicht.

**Was der Guard ausdrücklich NICHT prüft:** Mutationsprobe, lokaler Funktionstest im Browser,
CodeRabbit, und ob ein mitgelieferter Test überhaupt etwas zusichert (`vacuous-guard-test`).
Stufe A misst **Anwesenheit**, nicht Güte. Beides gehört in die Sperrmeldung, sonst liest sich
ein grüner Durchlauf als „geprüft".

### Was Stufe A wirklich leistet — normativ, nicht detektivisch

Die ehrliche Lesart der Historie, und sie ist unbequemer als die erste Fassung:

| Messung | Ergebnis |
|---|---|
| Letzte **25 gemergte PRs** | **0 Sperren** — jede gemergte Arbeit trug einen Test |
| Letzte **80 Commits**, erste (kaputte) Definition | 4 Treffer — **1 echter, 2 Fehlalarme, 1 Artefakt** |
| Letzte **120 Commits**, korrigierte Definition, nur `fix`/`feat` (63 Stück) | **1 Sperre, 0 Fehlalarme** |

**Auf PR-Ebene fängt der Wächter in der gesamten belegten Historie keine einzige fehlende
Testexistenz.** Bei `cf7b2654` (`fix(api): return await`, allein `src/lib/api.ts`) folgten die
Tests zwei bis vier Commits später im selben Strang. Was Stufe A erzwingt, ist der
**Ablageort** — „Der Test gehört zum Fix, nicht in einen Nachtrag" (CLAUDE.md) —, nicht die
Entdeckung eines fehlenden Tests. So und nicht anders wird er verkauft.

**Dazu die Repo-eigene Messgeschichte, die gegen den Guard spricht:** fehlende Tests sind
nicht die dokumentierte Fehlerklasse dieses Repos. PR #227 hatte 437 grüne Tests, und niemand
hatte den Knopf je gedrückt; „keiner davon war an einem roten Test zu sehen". Übersehene
**Browser- und Funktionsprüfungen** sind die Klasse — und die prüft dieser Guard
ausdrücklich nicht.

### Warum die Verengung auf `fix`/`feat` tragend ist

Ohne sie sperrt Stufe A auf **reinen Kommentaränderungen** in Quelldateien: `88c048c2` und
`13bdabdd` ändern nachweislich nur Kommentartext in `.tsx`. Damit stünde die Bilanz bei
**1 echt : 2 Fehlalarm** — und `readme-pflicht.sh` schreibt selbst, ein Wächter, „der meistens
danebenliegt, erzieht nur zum Wegklicken".

**Ein Kommentarfilter ist nicht baubar, und das ist gemessen, nicht vermutet:** JSX-Kommentare
sind `{/* … */}`, die geänderten Zeilen sind Fortsetzungszeilen **im Kommentarkörper** und
tragen kein Zeilenpräfix. Ein zeilenpräfix-basierter Filter hält beide Commits für
Codeänderungen (gefahren, beide falsch klassifiziert). Wer es trotzdem einbaut, baut den
Fehlalarm ein.

Die Verengung auf Conventional-Commit-Präfixe nutzt stattdessen ein Signal, das dieses Repo
ohnehin diszipliniert produziert, und trifft die Absicht genau: `docs:` ist kein Fix.

### Der Lib-Anspruch war falsch — #331 fällt NICHT nebenbei ab

Der erste Entwurf verkaufte einen gemeinsamen Erkenner als Klassenfix, aus dem #331
abfällt. **Gemessen ist das widerlegt:**

    printf 'git -c user.name=x commit -m "y"' | grep -q  'git commit'              → kein Match
    printf 'git -c user.name=x commit -m "y"' | grep -Eq 'git[[:space:]]+commit'   → kein Match

#331s Form ist eine **Option ZWISCHEN den Befehlswörtern**. Alle sechs Härtungsrunden des
Parsers behandeln Zuweisungs-**Präfixe vor** dem Befehl (`zuweisungen`,
`routing-sperre.sh:160`) und Feldgrenzen darum herum — **keine** kennt Tokens zwischen den
Wörtern der Phrase. Ein auf „Befehlsmuster" parametrisierter Erkenner ist für die `-c`-Form
**genauso blind wie das heutige grep**. #331 verlangt eine **siebte, neue
Härtungsdimension** (Option-mit-Wert zwischen den Wörtern, mit eigener Wertklassenfrage:
`-c 'a b'`, `-c a=b`, `--git-dir=…`) — echte Arbeit mit eigenem Reviewrisiko.

*(Nebenbefund: der grep steht in `readme-pflicht.sh:19`, nicht `:20`. Issue #331 trägt
dieselbe falsche Zeilennummer und wird beim Fix mitkorrigiert.)*

**Und die Lib bleibt kleiner als behauptet.** „Parametrisiert auf Befehlsmuster und
Fluchtweg-Name" passt auf einen von drei Verbrauchern: `routing-sperre.sh` benutzt
Env-Präfix-Grammatik mit fest verdrahtetem `KEIN_REVIEW` in **zwei** `sed`-Ausdrücken plus
eigenem PowerShell-Zweig (`ps_flucht`, :164, :179–181); `readme-pflicht.sh` und Stufe A
benutzen **Message-Marker**. Das sind zwei **Grammatiken**, nicht zwei Namen. **Entscheidung:
die Lib trägt nur die ERKENNUNG; die Fluchtwege bleiben bei ihren Verbrauchern.**

### Ein Posten, den der erste Entwurf ganz übersah: die PowerShell-Verdrahtung

`.claude/settings.json:24–33` ruft für den `PowerShell`-Matcher **nur** `routing-sperre.sh`.
Weder `readme-pflicht.sh` (heute schon nicht) noch der künftige Guard laufen dort — und
PowerShell ist die primäre Shell dieses Rechners. **Das ist Klasse #334 im selben Bündel, das
#334 behebt:** ein Wächter, der auf einem Weg still nicht anschlägt. Die Verdrahtung ist ein
eigener Posten in B2b′-1, kein Nebensatz.

### Zuschnitt: zwei PRs, und der Grund ist die Abbruchregel — nicht das Kontingent

| PR | Inhalt | Schliesst |
|---|---|---|
| **B2b′-1** Wächter-Instandsetzung | Spiegel-Import · Erkenner-Lib (nur Erkennung) · **7. Härtungsdimension** · #331 · #334 · #324 · PowerShell-Verdrahtung | **3 Issues** |
| **B2b′-2** Code-Guard | Stufe A (`fix`/`feat`) + Stufe B (`tsc -b`) + Selbsttest-Erweiterung | 0 (neue Fähigkeit) |

**Das Kontingent-Argument für den Split wird gestrichen.** Es lautete, ein grosser PR erzeuge
mehr Befundrunden — das war die **einzige ungemessene Behauptung** in einem Abschnitt, der mit
„alle Zahlen sind gemessen" warb, und nach dem eigenen Kostenmodell (Reviewversuche je
*Commit*) ist die Summe beim Split identisch, zwei Erst-Reviews kommen sogar dazu.

**Tragend ist allein die Abbruchregel:** der Guard baut auf dem Erkenner auf. Wackelt der
Unterbau, sind die Selbsttests des Guards wertlos — also steht B2b′-2 still, bis B2b′-1 steht.

### Der Hausregel-Widerspruch, beantwortet statt übergangen

CLAUDE.md: „**`pre_merge_checks` als `warning`, nie `error`.** Ein Gate, das den Merge sperrt,
wird umgangen; ein Hinweis wird gelesen."

**Für Stufe A ist er entkräftet** — sie erfüllt dieselben Akzeptanzbedingungen wie die
bestehende `routing-sperre.sh`: sofortige Meldung, erklärender Text, billiger Fluchtweg, und
eine **an der echten Historie gemessene Fehlalarmquote von 0** (63 `fix`/`feat`-Commits).

**Für Stufe B war er in der 72-Sekunden-Fassung NICHT entkräftbar** — Latenz plus die im Repo
dokumentierte Umgebungs-Rot-Klasse (stale `__pycache__` nach Mutationsserien, PR #180: 30
Minuten Suche an einem Fehler, den es im Quelltext nie gab) hätten `KEIN_TEST=1` zur Routine
gemacht, und die Hausregel prognostiziert genau dieses Wegklicken. **Bei 0,47 s und einem
Check ohne Umgebungszustand fällt beides weg.** Das ist der eigentliche Grund für den Tausch,
nicht die gesparte Zeit.

### Eine Grenze, die kein Hook überwinden kann

Stufe B misst den **Arbeitsbaum**, nicht den gepushten Stand. Eine untrackte Datei kann lokal
grün machen, was der PR nicht enthält — und umgekehrt lokal rot, was auf dem Branch grün ist.
Die CI misst das richtige Objekt; ein `PreToolUse`-Hook kann das strukturell nicht. Der Guard
ist eine **Vorwarnung**, kein Ersatz für die CI, und die Sperrmeldung sagt das.

### Prüfung des Guards selbst

`routing-sperre.test.sh` liegt daneben und hat **43 `||`-Zusicherungen** samt Wegwerf-Fixture
(daneben eine 44. FAIL-Stelle, die keine `||`-Zusicherung ist) — der neue Wächter erweitert
**diese** Datei, statt eine zweite Testwelt aufzumachen. Pflicht:

1. **Positiv- UND Negativkontrolle** je Stufe. Ohne die zweite Richtung ist ein Dauer-Sperrer
   grün.
2. **Die Verengung selbst wird geprüft:** ein `docs:`-Commit an einer Quelldatei ohne Test
   muss **durchlaufen**. Genau das ist der Unterschied zu 1:2.
3. **Beide Fluchtwege**, plus die Falle aus Runde 5: ein Heredoc, das den Fluchtweg nur
   *aufschreibt*, darf keinen echten Befehl freigeben. Und der `-F`-Fall: Message nicht im
   JSON → `KEIN_TEST=1` muss greifen.
4. **Fail-open wird zugesichert, nicht angenommen:** fehlendes `node` → Stufe B schweigt
   (Exit 0), nicht Exit 2.
5. **Mutationsprobe** mit Anwendungs-Kontrolle (`grep -c` auf den Marker) — `sed` ist in
   diesem Repo dreimal still an einer Fortsetzungszeile gescheitert.
6. **`.gitattributes`-Probe** (Lehre aus PR #8): CRLF in einer `.sh` ergibt unter Linux-bash
   Syntaxfehler und **Exit 0 bei leerem stdout** — Erfolg für einen Test, der nie lief.
7. **Hook-Parallelität messen**, bevor irgendein Text eine Reihenfolge behauptet: zwei
   Zeitstempel-Hooks, Ausgabe vergleichen.

### Reihenfolge, ergänzt

| # | Was | Ergebnis |
|---|---|---|
| 7 | **B3-Vorarbeit** #84-Mess-Harness *(unverändert: was Marcus entblockt, geht zuerst)* | entblockt die Mac-Sitzung |
| 8a | **B2b′-1** Spiegel-Import → Erkenner-Lib + 7. Dimension → #331 → #334 → #324 → PowerShell | 3 zu, 1 PR |
| 8b | **B2b′-2** Code-Guard Stufe A + B | neue Fähigkeit, 1 PR |
| 9 | **B7** #330 + #328 *(unverändert)* | 2 zu, 1 Sitzung |

Ab 10 unverändert. **Warum der Guard hinter B3-Vorarbeit bleibt:** derselbe Grund wie in
Fassung 3 — der Mac-Termin kann kurzfristig kommen; der Guard wartet folgenlos, eine
ungenutzte Mac-Sitzung nicht.

### Was der erste Entwurf von Fassung 4 falsch hatte

Damit die Zahlen nicht über Zitate weiterleben:

| Behauptung | Richtig |
|---|---|
| „4 Sperren / 80 Commits, Positivkontrolle bestanden" | **1 echter Treffer, 2 Fehlalarme, 1 Artefakt.** Der Klassifikator kannte `.test.js` nicht und zählte `electron/updater.test.js` über `electron/.*\.js` sogar als **Quellcode** |
| „Der Wächter hätte bei #318 angehalten" | **`b241a175` trägt seinen Test im selben Commit** (`electron/updater.test.js`, +55). Er hätte nicht angehalten — und #318s Lücke (Lauf am gepackten Mac-Ziel) steht auf der planeigenen „prüft NICHT"-Liste |
| Stufe B = `pytest` + `vitest`, 72 s | **`tsc -b`, 470 ms.** Die Suiten hätten im belegten Fenster **0 von 1** Rot-Fällen gefangen; der eine war ein tsc-Fehler |
| „Hook-Zeitgrenze von 10 s auf 180 s" | **Entfällt.** Die Obergrenze war ohnehin nicht belegbar, und der Timeout steht **je Hook-Kommando** — pauschal gehoben hätte er auch `routing-sperre` auf 180 s gestellt |
| „läuft NACH `routing-sperre.sh`" | **Nicht herstellbar** — passende Hooks laufen parallel |
| „#331 fällt bei der Lib-Extraktion ab" | **Widerlegt.** `-c` steht ZWISCHEN den Befehlswörtern; keine der sechs Runden kennt diese Klasse. Es braucht eine siebte |
| „zwei von drei Wächtern still aus" | **Eine Blindstelle je Wächter.** `routing-sperre` wirkt hier, `readme-pflicht` erkennt plaines `git commit` weiter |
| `readme-pflicht.sh:20` · „43 Zusicherungen" · `vitest --run` | **:19** · 43 **`||`**-Zusicherungen (+1 andere FAIL-Stelle) · `package.json:11` sagt **`vitest run`** |
| Zwei PRs wegen des Kontingents | **Gestrichen** — ungemessen und dem eigenen Kostenmodell zuwider. Tragend ist die Abbruchregel |
| PowerShell-Verdrahtung | **Fehlte ganz.** `settings.json:24–33` ruft dort nur `routing-sperre` |

### Was Fassung 3 nicht hatte

| Auslassung | Wirkung |
|---|---|
| Kein Blick auf den Wächter-Bestand als Ganzes | #331 und #334 standen als Einzel-Issues da; dass **jeder Wächter eine stille Blindstelle hat**, stand nirgends als Befund |
| Testhälfte des Prüfapparats gar nicht adressiert | CLAUDE.md verlangt Review **UND** Test; erzwungen wurde nur Review |
| #331 als reine Zeichenketten-Frage gelesen | Er ist eine **eigene Härtungsdimension**, keine Variante der sechs vorhandenen |
