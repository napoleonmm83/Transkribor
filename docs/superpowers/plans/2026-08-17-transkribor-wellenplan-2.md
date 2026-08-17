# Wellenplan 2 — die 24 offenen Issues, gruppiert

**Stand:** 2026-08-17, master `1ab4c70`. Wellenplan 1 ist durch (PR #248).
**Fassung 2** — nach einem adversarialen Gegenlauf, der **drei tragende Behauptungen der
ersten Fassung widerlegt** hat. Was davon übrig ist, steht unten unter „Was der Review
umgeworfen hat"; die Wellen sind entsprechend umgebaut.

## Die Gruppierungsregel

**Ein PR = eine Review-Linse = EINE Verifikationsumgebung** (CLAUDE.md: der lokale
Funktionstest kostet pro Umgebung einen Aufbau).
**Zweites Kriterium:** Issues, deren Fixes einander bedingen, gehören zusammen.

**Dritte Regel, aus dem Gegenlauf gelernt:** *Wenn ein Issue mehrere Wege nennt und
ausdrücklich „nicht entschieden" ist, wählt der Plan nicht still den teuren.* Genau das war
der schwerste Fehler der ersten Fassung.

---

## Was der Review umgeworfen hat

| Behauptung Fassung 1 | Befund | Beleg |
|---|---|---|
| „Poll adoptiert fremden Lauf" ist der Weg für #252 | **Kehrt eine dokumentierte Entscheidung um.** Im Code steht: „Übernommen wird der Lauf bewusst NICHT automatisch: das setzte `ytLaeuft` sofort wieder hoch und machte die Obergrenze der Warteschleife wirkungslos (der Test … hat genau das aufgedeckt)." | `SettingsPage.tsx:551-556` |
| Cache-Invalidierung sitzt bei `auth.py:221` | **Richtung falsch.** Der Login misst seinen Erfolg *selbst* per `status(provider)` — **vor** `laeuft = False`. Dieser eine Aufruf muss den Cache **umgehen**, nicht ihn stürzen. | `auth.py:219-221` |
| #242s Abbruch ist „auf POSIX exakt #224" | **Widerlegt.** #224 ist ein Python-Daemon-Faden mit `sperre.py`-Lock; #242 ist ein `spawn()` im Electron-Hauptprozess **ohne** Lock. Gemeinsam ist nur die Einsicht, nicht der Code. | `setup.js:123-129`, `main.js:133-145` |
| #244 sind „~10 Zeilen in `EditierbarerText.tsx`" | **Zwei Stellen.** `SegmentView.tsx:142` hat einen **eigenen** `<button title="Notiz bearbeiten (leeren streicht sie)">`, der `EditierbarerText` nicht benutzt. | `SegmentView.tsx:142` gegen `EditierbarerText.tsx:32` |
| #160 ist „grösser als mtime prüfen" | **Unbegründet — und der wahre Grund ist ein anderer.** Es gibt **drei** Schreiber der `edit.json`, einer davon in einem **eigenen Prozess**. Ein Token aus einer Registry im Serverprozess kann darum nicht funktionieren; es muss aus dem **Dateizustand** abgeleitet sein. | `app.py:614`, `app.py:507`, `correct.py:246` (via `jobs.request([sys.executable, …])`) |
| #251-Wächter: „jeder Handler ist eine Weiterleitung" | **Am ersten Tag rot.** Vier Handler tragen bewusste Entscheidungen, je mit Begründung im Kommentar. | `main.js:134, 152-154, 164-166, 175` |

Zusätzlich: die Zahl **0,26 s** für `auth.status()` ist in diesem Repo **nicht gemessen** —
#250 verlangt ausdrücklich, dass zuerst gemessen wird. Fassung 1 hat sie als Tatsache geführt.

---

## Welle A — Einstellungsseite, in ZWEI unabhängigen PRs

**Entschieden (Marcus, 2026-08-17):** #252 geht **Weg 2 — ehrlich anzeigen statt melden**.
Die Zeile bleibt stehen, bis ein Ergebnis vorliegt; kein Toast für einen Lauf, den dieser Tab
nicht begonnen hat.

**Damit fällt die Kopplung der ersten Fassung weg.** Sie entstand nur durch Weg 1: kein
Umkehren der Entscheidung aus `SettingsPage.tsx:551`, kein zweiter Besitzer der
`useEinmalJeLauf`-Kennung, keine Zusatzlast — also ist #250 keine Voraussetzung mehr.

**Und aus derselben Frage kam #253** (Marcus): die yt-dlp-**Kalenderprüfung** gehört an den
App-Start, nicht vor jeden Import. Das teilt Welle A entlang der Linse:

| PR | Issues | Linse |
|---|---|---|
| **A1** | #249, #250 | Was kostet `GET`/`PUT /api/settings` — und sagt die Seite es dem Nutzer? |
| **A2** | #253, #252 | Wann läuft eine yt-dlp-Aktualisierung, und woran sieht man sie? |

### A1 — #249: Busy-Zustand beim Speichern

`speichern()` (`SettingsPage.tsx:326-339`) hat keinen — nachgeprüft; der `busy` auf `:118`
gehört `AnmeldungAbo`. Vorbild ist `ytJetzt` (`:542`) und `kaputtWeg`.

**Die Wurzel bleibt und wird benannt, nicht behoben:** `auth.STATUS_TIMEOUT = 30`
(`auth.py:66`) mit dem Kommentar „ein lokaler Aufruf, der sofort antwortet" daneben. Mit
`busy` sieht der Nutzer künftig ein *gesperrtes* Formular 30 s lang statt eines toten. Die
Zahl hängt an drei Stellen (#249, #250, und der 35-s-Frist von `backend.projektePfad()`,
die laut `electron/CLAUDE.md` nur wegen dieser 30 s so hoch ist) — sie anzufassen ist eine
eigene Arbeit, kein Nebensatz.

**Mutation:** `setBusy(true)` raus → Test rot.

### A2 — #250: erst messen, dann bauen

Das Issue verlangt es wörtlich: „**Nicht gemessen**, sondern aus dem Aufrufbaum gelesen —
wer das angeht, misst zuerst, wie lange `GET /api/settings` auf diesem Rechner wirklich
braucht." Der Poll zahlt daneben `ytdlp_update.zustand()` (~6,4 ms laut `webtool/CLAUDE.md`);
wie gross der Subprozess-Anteil wirklich ist, weiss niemand.

**Erst messen. Dann** entscheiden zwischen kurzlebigem Cache und einer kleineren Decke.

**Falls Cache — die Falle, die Fassung 1 übersehen hat:** `_fahre` misst den Erfolg des
Logins mit `st = status(provider)` (`auth.py:219`), **bevor** `lauf["laeuft"] = False` fällt.
Ein Cache, der diesen Aufruf bedient, lässt den Login sich an einem Zustand von **vor** dem
Login messen — ein geglückter Login meldete „fehlgeschlagen". Dieser eine Aufruf muss den
Cache **umgehen** (`status(provider, frisch=True)` o. ä.).
Mitbetroffen über `available()`: `llm.check()` (`llm.py:357`) und `_require_ai()`
(`app.py:675`) — der Testknopf antwortete sonst aus dem Cache.

**Mutation:** den Umgehungsweg entfernen → der Login-Erfolgstest wird rot.

### A2 — #253 (Auslöser verschieben) + #252 (ehrlich anzeigen)

**#253 ist der grössere Gewinn und der kleinere Diff.** In `fetch.py` hängen zwei
Aktualisierungswege, und nur einer gehört dorthin:

```
fetch.download_one(:310)
  ├─ ensure_ffmpeg()                          Vorbedingung, ohne Wartezeit
  ├─ _hole_yt_dlp() (:320)
  │    └─ automatisch()  ── faellig()? ──►  pip bis 120 s, worst case ≥340 s
  │                                          ◄── HIER wartet der Nutzer auf
  │                                              Paketverwaltung, statt auf sein Video
  │                                          ►►► ZIEHT AN DEN START (app.py:36 _lifespan)
  └─ … Download …
       └─ Fehlschlag + _extraktor_verdacht (:418)
            └─ automatisch(erzwingen=True)     ◄── BLEIBT. Das ist die Reparatur,
                                                   nicht die Vorsorge (#162/#173)
```

**Die Mechanik existiert vollständig** — `faellig()` (14 Tage + Merker) ist die Bremse,
`starte_hintergrund()` (`ytdlp_update.py:635`) der Faden, heute nur vom „Jetzt
aktualisieren"-Knopf gerufen (`app.py:897`). Es wandert der **Auslöser**, nicht die Logik.

**Was #253 an anderen Issues tut:**
- **#176 wird gegenstandslos** — ohne Auslöser im Import können zwei Import-Jobs keine zwei
  pip-Läufe mehr anstossen. Aufgelöst, nicht gefixt. → **aus Welle B streichen**, nach dem
  Merge von #253 als obsolet schliessen.
- **#252 schrumpft** auf die eine ehrliche Anzeigezeile (Weg 2).
- **#224 wird wichtiger** — pip beim Start liegt genau im Fenster, in dem jemand die frisch
  geöffnete App wieder schliesst.

**Zu bedenken:** `python -m webtool.fetch` ohne Server verlöre die Kalenderprüfung (kein
`_lifespan` im Subprozess). Verhaltensänderung, nicht reine Verschiebung — steht im Issue.
`TRANSKRIBOR_YTDLP_UPDATE=0` und `ytdlp_auto` müssen weiter gewinnen.

**Mutation:** `faellig()`-Bremse am Startpfad entfernen → ein Test muss rot werden, der zeigt,
dass nicht bei jedem Start pip läuft.

### Lokaler Funktionstest — mit Sicherung

**Nicht** einfach „echten yt-dlp-Lauf anstossen": das schriebe `pip install -U yt-dlp[default]`
in Marcus' Entwickler-venv, also genau die venv, in der alle folgenden Wellen gemessen werden.
`webtool/CLAUDE.md` hält den Präzedenzfall fest. Gefahren wird mit `TRANSKRIBOR_YTDLP_UPDATE=0`
plus gefälschtem `subprocess.run`, oder in einer Wegwerf-venv.

---

## Welle B — yt-dlp/pip-Sperre auf POSIX

**Issue:** #224 — **#176 ist raus** (durch #253 gegenstandslos), **#173 ebenfalls** (siehe unten)
**Umgebung:** WSL (Ubuntu-22.04), echtes SIGTERM gegen echtes pip, **in einer Wegwerf-venv**.

**Warum in WSL:** #224 existiert auf Windows nicht — `taskkill /F /T` nimmt den Baum mit. Ein
grüner Windows-Test sagt zu #224 nichts.

### #224 zuerst — der einzige echte Schaden

Zwei `pip install` auf dieselbe venv. Richtung: den pip-Kindprozess beim Signal mitnehmen und
das Lock freigeben. Ob das mit dem `daemon=True`-Faden aus #174 zuverlässig geht, ist offen;
Alternative ist ein Lock-Merker mit der **Kind-PID**, damit `_lebt_laut()` den richtigen
Prozess prüft.

**Vorbehalt aus dem Issue selbst:** #224 ist „aus dem Code hergeleitet, auf einem Mac NICHT
verifiziert". Der WSL-Lauf ist die erste echte Messung — er kann den Befund auch widerlegen.

### #176 fällt weg — und das ist die zweitbeste Nachricht dieses Plans

Fassung 1 plante, die Sperre von `aktualisiere()` nach `automatisch()` zu verlagern. Der
Gegenlauf zeigte, dass das **zwei** Verträge aus PR #246 ändert (`aktualisiere() -> (ok,
gehalten)` speist `ungeschuetzt`/#236; `zustand()["laeuft"]` fragt `sperre.wird_gehalten`,
`:764`/#243) — und damit ausgerechnet das Signal berührt, das die Einstellungsseite liest.
Ein „15-Zeilen-Fix", der einen frisch gebauten Vertrag umschreibt.

**Mit #253 stellt sich die Frage nicht mehr:** ohne Auslöser im Import gibt es die zwei
gleichzeitigen Läufe nicht. Das Issue wird nach dem Merge von #253 als obsolet geschlossen,
mit Verweis. Kein Code, kein Vertrag, kein Risiko.

**Das ist die Regel dahinter:** ein Issue, das sich durch eine Verschiebung auflöst, ist
billiger als jeder Fix dafür. Erst fragen, ob der Auslöser am richtigen Ort sitzt.

---

## Welle B′ — #173, wartet auf fremdes Material

Herausgenommen aus B: die Messung braucht einen **echten, gerade kaputten Extraktor**
(Instagram) — ein Live-Dienst-Zustand, nicht auf Kommando herstellbar und nicht WSL-spezifisch.
Eine strikt sequentielle Kette blockierte sonst an einem Posten, der nicht terminiert.

`fetch.py:59` (`_EXTRAKTOR_RE`) plus das `_LOGIN_RE`-Veto (`:111`). **Kein Ratespiel:** wer die
Regex ohne Messung erweitert, hat das Issue verdoppelt statt bearbeitet. Läuft parallel mit,
wenn sich Gelegenheit ergibt.

---

## Welle C — Electron: der teure Knopf

**Issues:** #242, **#251 nur bedingt** (siehe unten)
**Umgebung:** gepackter Electron-Lauf.

### #242b ist teurer als das Issue klingt

`main.js:132-144` hält `einrichtungLaeuft`, **aber das ist nur das Promise** (Doppelklick-Riegel
aus #229), kein Abbruchgriff. `setup.einrichten` (`setup.js:443`) spawnt intern über `lauf()`
(`:129`, `:186`) und reicht den Kindprozess **nirgends heraus**. Ein Abbruch braucht ein
Durchreichen durch drei Ebenen.

**Gute Nachricht:** die Werkzeug-Naht ist da (`einrichten(…, werkzeug = {})`, `setup.js:443-450`,
aus #229) — der Abbruch ist **ohne echtes pip** testbar.

**Gestrichen: „das ist exakt #224".** Zwei Laufzeiten, zwei Sprachen, kein gemeinsames Lock,
kein gemeinsamer Code. B vor C ist damit **nicht erzwungen** — nur bequem, weil die Einsicht
„ein Kill nimmt den Baum auf POSIX nicht mit" dann schon frisch ist.

**Fehlende Prüfung, jetzt benannt:** der POSIX-Teil von #242b ist auf diesem Rechner **nicht**
verifizierbar (gepacktes macOS/Linux steht selbst unter #36; auf Windows existiert der Fall
nicht). Das geht als *ungeprüft* raus und wird so berichtet, nicht als „läuft".

### #251 braucht einen anderen Weg als Fassung 1 vorschlug

Der Quelltext-Wächter „jeder `ipcMain.handle`-Rumpf ist eine Weiterleitung" wäre **am ersten
Tag rot**: `einrichten` (`:134`), `titelleisteFarbe` (`:152-154`), `fortschritt` (`:164-166`),
`update:installieren` (`:175`) tragen alle bewusste Entscheidungen, je mit Begründung im
Kommentar. Ein Wächter mit Ausnahmeliste *ist* die Konvention, die er ersetzen sollte.

Issue #251 sagt das selbst und nennt den Ausweg: „**Weg 3** [`main.js` ladbar machen] ist der
einzige, der die Frage wirklich beantwortet." Das ist eine eigene Arbeit. **Empfehlung:** #251
nicht mit #242 bündeln, sondern eigenständig entscheiden — oder zunächst auf Weg 1 des Issues
zurückfallen (eine Zeile in `electron/CLAUDE.md`) und das Issue ehrlich als *nicht gelöst*
offenhalten.

---

## Welle D — Wächter und Kleinkram im Frontend

**Issues:** #222, #209, #244
**Umgebung:** `pytest` + `npm test`, plus **eine** Browserprüfung für #244.

- **#222** — die `skipif os.name != "nt"` stehen auf **235, 698, 772** (das Issue nennt
  212/589/663 — Zeilen gewandert). `:249` ist ein `mkfifo`-skipif und gehört **nicht** dazu.
  Braucht eine `conftest.py` (im Repo gibt es keine — nachgesehen).
- **#209** — **als vitest-Quellbaumtest, nicht als oxlint-Regel:** `npm run lint` läuft nicht
  in der CI (`test.yml` fährt `npm test` und `npm run build`; `release.yml` nur
  `test:electron`). Eine Lint-Regel wäre ein Wächter ohne Vollzug.
- **#244 — zwei Stellen, nicht eine.** `EditierbarerText.tsx:32` (erbt an `Anmerkungen.tsx`
  und `DokumentFeld`) **und** `SegmentView.tsx:142`, das einen eigenen Button hat. Nur die
  erste zu fixen schliesst das Issue formal und lässt den **häufigsten** Streichweg
  (Segmentnotiz, 400 Segmente je Dokument) für Tastatur und Screenreader stumm.

---

## Welle E — Der Editor-Speicherpfad (allein)

**Issue:** #160

**Der wahre Grund, warum das gross ist** — nicht „mtime reicht nicht", sondern **wer schreibt**:

```
edit.json wird geschrieben von …
  app.py:614      save_file          ← der Editor (PUT, alle 800 ms Tipppause)
  app.py:507      _doc_felder        ← Umbenennen (gerufen aus :531, :564)
  correct.py:246  cmd_apply          ← EIGENER PROZESS
                                       (app.py:658 → jobs.request([sys.executable, -m …]))
```

`correct.py` läuft als Subprozess und mintet keine Token. Ein Token aus einer Registry **im
Serverprozess** kann darum nicht funktionieren — es muss aus dem **Dateizustand** abgeleitet
sein (mtime oder Hash). Damit ist der Vorschlag aus dem Issue („die `mtime` prüfen, die der
Client beim Laden gesehen hat") **die naheliegende Lösung**, nicht die zu kleine; Fassung 1
hat ihn ohne Begründung abgetan.

Offen bleibt die Erneuerung: nach jedem erfolgreichen PUT muss der Client das neue Token
bekommen, sonst antwortet sein zweiter Speichervorgang mit 412.

Dieser PR bekommt einen ungeteilten Reviewer und einen eigenen
`was-erlaubt-der-fix-neu`-Lauf — der Speicherpfad ist der mit der schlechtesten Bilanz im Repo.

---

## Welle F — README-Drift (#216)

Die README auf `master` beschreibt dauerhaft mehr, als der Herunterladen-Knopf liefert.

**Begründung korrigiert:** Fassung 1 schrieb „tut niemandem weh, solange die Releases dicht
folgen". Das ist genau die Position, die der Issue-Titel zurückweist („die Drift ist
**strukturell**"). Zurückgestellt wird es wegen geringerer Dringlichkeit, nicht weil es
harmlos wäre.

---

## Nicht in Wellen

**Braucht Marcus' Entscheidung:** #210 (Herzschlag in `sperre.py` — ein Faden je Halter?) ·
#237 (Netzfreigabe — ein Faden je Leseversuch auf dem Request-Pfad; das Issue argumentiert
selbst dagegen) · #70, #71 (Geschmack: was gehört in die leere Werkzeugleiste / die dünne
Übersicht?)

**Braucht Hardware:** #36 (macOS/Linux aus dem gebauten Paket, per Finder aus dem `.dmg` —
`npm start` versteckt die Fehlerklasse) · #84 (whisper.cpp `--prompt` auf Apple Silicon)

**Braucht echtes Material / extern:** **#136 vor #137** (#137 baut auf einer Annahme, die #136
erst prüft) · #164 (Sprache pro Segment — stille Fenster verschieben die Zuordnung *still*;
braucht einen Entwurf) · #95 (Certum-Kauf) · #45 (Renovate-Anzeige, kein Vorgang)

---

## Reihenfolge

```
A2 (yt-dlp-Auslöser) → A1 (Einstellungskosten) → B (POSIX) → C (Electron) → D → E → F
   #253 #252             #249 #250                 #224        #242 (#251)   …
   Browser + App-Start   Browser                    WSL         gepackt

   B′ (#173) läuft nebenher — wartet auf einen echten kaputten Extraktor
   #176      entfällt nach A2 — als obsolet schliessen
```

**Harte Kanten: keine.** Mit #252-Weg 2 wird nichts adoptiert, also gibt es das geteilte
`zustand()["laeuft"]`-Signal-Problem nicht. B→C ist **nicht** erzwungen (die „exakt
#224"-Begründung ist gestrichen), nur bequem.

**Warum A2 zuerst:** es ist der einzige Punkt im ganzen Plan, an dem ein Issue **verschwindet**
statt bearbeitet zu werden (#176), und der einzige, den ein Nutzer als Tempogewinn merkt —
der Import wartet nicht mehr auf einen Paketmanager.

**Warum A1 danach und nicht zuerst — Begründung korrigiert.** Fassung 1 schrieb „Nachwehen des
letzten PRs". Das trägt nur für **#249**: #252 ist im Issue ausdrücklich als **vorbestehend**
markiert (Ursache #243/PR #246), und #250 entstand mit dem Poll aus #174. #249 bleibt trotzdem
weit vorn, weil es den Nutzer sichtbar beim Speichern trifft.

## Was schon existiert (und nicht neu gebaut wird)

| Gebraucht | Gibt es | Wo |
|---|---|---|
| Busy-Zustand (#249) | `ytJetzt`, `kaputtWeg` | `SettingsPage.tsx:542` |
| Prozessbaum abräumen (#242b) | `auth.abbrechen()` für die Login-CLIs | `webtool/auth.py:241` |
| Testen ohne echtes pip (#242) | `einrichten(…, werkzeug = {})` aus #229 | `setup.js:443-450` |
| Reine Entscheidungsfunktionen | `setup.plan`, `backend.serverEnv`, `fenster.fensterOptionen` | `electron/` |
| Atomares Schreiben (#160) | `paths.atomic_write` | `webtool/paths.py` |
| Versteckter Beschreibungstext (#244) | Geltungssatz am Sprachwähler | Frontend |

## Was dieser Plan bewusst NICHT tut

- **Keine Welle für #210/#237** — Entwurfsfragen. Sie zu bauen hiesse, die Antwort im Code
  zu raten.
- **Kein #251 im #242-PR** — der vorgeschlagene Wächter wäre am ersten Tag rot und bräuchte
  eine Ausnahmeliste.
- **Kein Vorgriff auf #250s Lösung** — erst messen. Das Issue verlangt es, und die 0,26 s
  sind in diesem Repo nie gemessen worden.
- **Kein Vorgriff auf einen anderen #252-Weg** — Weg 2 ist entschieden (Marcus, 2026-08-17).
  Die Umsetzung übernimmt deshalb **keinen** zweiten Besitzer der `useEinmalJeLauf`-Kennung und
  **keinen** Toast für fremde Läufe; der Anzeige-Poll fasst `ytLaeuft` nicht an. Wer Weg 1
  später doch will, fängt bei der 480-Runden-Obergrenze an, nicht beim Toast.
  (Die Frage stand hier bis zur Entscheidung offen — das Issue selbst sagte „Nicht
  entschieden", und die Wahl änderte die Form der ganzen Welle.)

## Offene Prüflücken (benannt, nicht verschwiegen)

- **#242b auf POSIX** — auf diesem Rechner nicht verifizierbar. Geht ungeprüft raus.
- **#224 überhaupt** — bisher nur aus dem Code hergeleitet. Der WSL-Lauf ist die erste
  Messung und kann den Befund widerlegen.
- **`auth.status()`-Kosten** — nie gemessen. A2 misst zuerst.
- **Die 480-Runden-Regression bei #252-Weg 1** — aus der Effektmechanik hergeleitet, nicht
  durch einen Lauf belegt. Wer den Weg wählt, fährt die Mutation, bevor er dem grünen Test
  glaubt.
