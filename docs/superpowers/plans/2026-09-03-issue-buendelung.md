# Bündelungsplan 2026-09-03 — 29 offene Issues

> **Kein Implementierungsplan.** Triage: welche Bündel existieren, in welcher Reihenfolge,
> welche blockiert sind. Jedes Bündel bekommt seinen eigenen Plan, wenn es dran ist.
> Nachfolger des Plans `docs/superpowers/plans/2026-08-22-issue-buendelung.md` (Fassung 4),
> dessen Kriterium unverändert weitergilt.

**Stand:** master `84b6437`, v0.52.0 live (2026-09-03 08:01Z), **29 offene Issues**,
**1 offener PR** (#540, vitest v5).

## Context — warum dieser Plan

Der letzte Bündelungsplan ist elf Tage alt und beschreibt eine Issue-Menge, die es nicht mehr
gibt: von den damals gebündelten sind B1, B2a und B4 gebaut, die Ketten K1, K2, K3, K5, K6 und
K7 aus dem `.code-guardian-todo.md`-Kettenplan sind abgearbeitet oder hinfällig. Wer heute die
alte Liste abarbeitet, arbeitet an geschlossenen Issues.

**Drei Zustandsbehauptungen im Merker sind widerlegt** (gemessen mit `gh issue view`):

| Behauptung | Gemessen |
|---|---|
| K3-Kette #368 / #370 / #442 / #347 offen | alle zu ausser **#442** (PR #500, bewusst offen gelassen) |
| K5 (#448, #458, #446, #436) offen | **alle vier zu** → Kette hinfällig |
| K7 (#438, #439) offen | **beide zu** → Kette hinfällig |

Übrig aus dem alten Kettenplan bleibt genau **K4 (#381 + #382)** — hier als Bündel B.

## Das Kriterium (unverändert)

Gebündelt wird nach **geteilten Prüfkosten**, nicht nach Themenähnlichkeit
(`aehnlichkeit-ist-keine-kopplung`). Die teuren Posten:

1. **Browser-Sitzung** — App starten, Wegwerf-Projekt, Screenshots. Fällt pro PR an.
2. **Gepackter Electron-Lauf** — bauen, aus dem Installer starten. Teuerste Prüfung nach dem Mac.
3. **CodeRabbit-Kontingent** — verbraucht je **Commit**, repo-weit, aktuell ~1–3 Reviews/Stunde.
4. **Mac-Hardware** — nur Marcus.
5. **Messstand** (Wegwerf-Projekt + uvicorn + echter Job) — Skill `messstand`.
6. **Marcus' Entscheidungen** und **Beschaffung** (Geld, fremde Anbieter).

Zwei Issues im selben Bereich, die keinen dieser Posten teilen, werden **nicht** gebündelt.

---

## A — Bereichs-Disjunktheit ▶ ZUERST (Entscheidung Marcus, 2026-09-03)

**#523 + #496** — ein PR. Mitfahrer: **#509**, **#442 (Text-Hälfte)**.

**Warum zusammen — kausal, nicht thematisch.** #523 ist der *Ausnutzungspfad* von #496, am Code
belegt:

- `webtool/app.py:1162` — `delete_file` ruft `_keine_jobs(project, base, active_only=True)`,
  fragt also nur `active_bases`, nie den fixierten Bereich (#523).
- `webtool/app.py:1620` — `_start_transcribe`, und `:1630` hängt `--autocorrect`
  **bedingungslos** an. Vier Türen: `:1203` (Retranscribe), `:1638`, `:1817` (fetch-then),
  `:2105` (Upload), dazu der pending-Nachlauf in `jobs.py` (#496).
- Schritt 3 von #523 (löschen, gleichnamig neu hochladen) läuft **durch genau diese Zeile**.

Nur #496 behoben lässt #523s Löschweg offen; nur #523 behoben lässt die drei anderen Türen
offen. Getrennt ist es `fix-an-einer-stelle-ist-kein-fix-der-klasse`.

**Warum die Mitfahrer.** Beide liegen in `webtool/app.py` und teilen damit den Messstand *und*
die Konfliktfläche:

- **#509** — `_weg_alter()` / `_umbenennen_oder_keines()`, die Karenz der `.weg`-Sicherungskopie
  im Mischbetrieb. Prüfbar als pytest-Einheit an `_weg_alter(None)`; die volle Reproduktion
  bräuchte einen zweiten Server alter Fassung und ist **nicht** Teil des geteilten Stands —
  das ist der Grund, warum #509 abtrennbar bleibt.
- **#442, Text-Hälfte** — `_KIND_TEXT` steht in `webtool/app.py:1100`. Die Meldung *„wird
  gerade bearbeitet (Transkription läuft)"* ist im Wartefall sachlich falsch. Die
  **Phasen-Hälfte** (`jobPhases.ts`) gehört zu Bündel B, nicht hierher.

**Abbruchregel** (aus B1 übernommen): braucht #523/#496 eine zweite Reviewrunde, werden #509
und der #442-Text abgespalten und einzeln gemerged. Der Repo-Workflow ist Rebase-Merge des
ganzen PR — einen Commit einzeln abzulehnen gibt es nicht.

**Prüfung:** Messstand (Wegwerf-Projekt, uvicorn, echter `correct run` gegen einen
Transkriptionslauf) · pytest `test_api` + `test_jobs` · Mutationsprobe je Zusicherung ·
`was-erlaubt-der-fix-neu` ist hier Pflicht, weil beide Fixes Riegel auf Schreibpfaden sind.

### ► Korrigiert beim Bau (2026-09-03, Plan zu Bündel A)

Zwei Annahmen dieses Abschnitts haben das Lesen des Codes nicht überlebt — sie bleiben hier
stehen, weil sie sonst über Zitate weiterleben:

- **Die #442-Text-Hälfte war schon behoben** (`b7d895c`, „die Sperrmeldung sagt Verarbeitung
  statt Transkription"): `_KIND_TEXT` sagt bereits „Verarbeitung", und `jobPhases.ts:578/627`
  trägt seit K3 eine Wartekarte. #442 gehört ganz zu Bündel B.
- **#509 fährt nicht mit** — er teilt die Datei, nicht den Mechanismus. Seinen Platz nimmt ein
  beim Lesen gefundener Nebenbefund ein: `transcribe.py:817–823` schreibt Roh-JSON, `.raw.txt`
  und `.segments.txt` **nicht atomar**, obwohl `paths.atomic_write` existiert — ein Leser, der
  nur auf Vorhandensein prüft (genau das tun `correct.py:1252/:1314`), kann sie halb
  geschrieben sehen.

Entscheidungen des Grills zu Bündel A: #496 **entwaffnet die Mitkorrektur** statt 409 zu
antworten · #523 nimmt **Richtung 3** (Identität statt Anwesenheit, `transcribe._kennung`) und
lässt #80 stehen · das atomare Schreiben fährt mit.

---

## B — K4, Job-Ausgang nach Serverausfall

**#381 + #382** — die einzige überlebende Kette des alten Kettenplans. Mitfahrer: **#442**.

Beide hängen an derselben falschen Gleichsetzung: *Server antwortet nicht* = *Lauf ist
gescheitert*. #382 nennt #381 im eigenen Text als denselben Schnitt. Geteilte Prüfkosten: eine
Browser-Sitzung mit absichtlich weggenommenem Server, dieselbe Hook-Familie
(`useJob.ts`, `useActiveJob.tsx`, `useJobAusgang.ts`, `useProjektDaten.tsx`).

**Läuft NACH A**, nicht parallel: A hält `webtool/app.py` offen.

---

## C — Fehlerbericht-Weg (zwei Pakete, erzwungene Reihenfolge)

**C1 — #530 (b), Python-SDK.** Server plus alle Subprozess-Einstiege (`transcribe.py`,
`webtool/correct.py`, `webtool/fetch.py`, `webtool/jobs.py`) plus Testriegel. Prüfstand ist der
**Messstand**, nicht der gepackte Lauf — deshalb eigenes Paket.

**C2 — #530 (c) → #519 → #520.** Ein gepackter Electron-Lauf deckt alle drei
(`electron/main.js`, `electron/bericht.js`, `electron/fehlerberichte.js`).

**Die Reihenfolge in C2 ist keine Vorliebe, sondern eine Abhängigkeit:** #530 (c) baut den
manuellen Bericht mit Vorschau, #519 baut den manuellen Bericht ohne mailto-Längengrenze. Wird
#519 zuerst gebaut, entsteht ein Weg, den #530 (c) danach ersetzt. **#530 (c) entscheidet, ob
#519 überhaupt noch ein eigenes Issue ist.** #520 (geteilter Abweisungs-Deckel) ist derselbe
gepackte Lauf und derselbe `main.js`.

---

## D — Echtes Layout beweisen (bedingte Kette)

**#423 → #515.**

#423 sagt: die fünf Wächter zu #330 prüfen Tailwind-Klassenstrings, der Schaden hängt aber an
echtem Layout (`position: sticky`, Rollstand, `overflow`-Clipping, Trefferprüfung). #515 bringt
drei Bedienelemente unter dem WCAG-Mindestkontrast (1.00–1.05:1 statt 3:1) plus 109 px Reflow-
Überhang bei 320 px — und würde ohne #423 wieder mit genau der Wächterform abgesichert, die
#423 als blind belegt.

**Die Bedingung, ehrlich benannt:** geteilt ist nur, *wenn* #423 als Ergebnis einen
Playwright-getriebenen Messlauf gegen das gebaute Bundle hinterlässt. Ein Repo-Zensus zeigt
**keine Playwright-Konfiguration im Projekt** — Browserprüfungen laufen heute über den MCP oder
von Hand. Löst #423 sein Problem anders (etwa als Bundle-Prüfung auf erzeugte Tailwind-Regeln),
gewinnt #515 nichts und die beiden sind zwei Einzelgänger. Das ist vor dem Bau von #423 zu
entscheiden, nicht danach.

Für #515s Messung existiert das Werkzeug bereits: Skill `design-beweis` misst Kontrast je
Zustand und die geometrischen WCAG-2.2-Kriterien.

---

## E — Das Mac-Fenster ▶ blockiert auf Marcus (grösster Hebel je Sitzung)

Ein Durchgang an Marcus' M1 bewegt **sechs** Punkte:

| Punkt | Was zu tun ist |
|---|---|
| **#36** | Volle Pipeline aus dem `.dmg`, zwingend per **Finder** (`npm start` erbt den Shell-PATH und versteckt genau die Fehlerklasse). Mitprüfen: `models/` im `.dmg` angekommen, Sprechertrennung ohne HF-Token. |
| **#504** | Fällt aus dem #36-Lauf **gratis** ab: die objc-Zeilen stehen im Diarisierungs-Schritt desselben Protokolls. |
| **#512** | whisper.cpp-Fenster-Mechanismus an **C0709** (nicht C0761 — die Datei ist im Issue als ungeeignet benannt). |
| **Linux-Icon** | Der Rest der #503-Regression liegt auf dem unversionierten Mac-Branch `fix/kaltreview-icon-linux`; `git ls-remote` findet ihn nicht. **Releasebedingung ohne Issue** — siehe Lücken. |
| **#530 (a)** | Der gepackte Bugsink-Lauf ist nur auf Windows belegt (Nachfrage-Fenster, Envelope). |
| **#536** | Der Beleg-Teil. Der Code-Teil (Mindestversion in `latest-mac.yml`) ist auf Windows baubar. |

**#536 ist keine Releasebedingung für v0.53.0**, und das ist gemessen, nicht angenommen: der
Übergang v0.52.0 → v0.53.0 ist per Konstruktion nicht schützbar, weil auf dem Monterey-Mac die
**alte** App mit dem alten Updater-Code läuft. Der Fix schützt künftige Übergänge. Release-Notiz
und README tragen den Hinweis bereits.

---

## F — Sperre-Klasse (spät)

**#210 + #237** — geteilt ist der `sperre.py`-Reviewdurchgang und ein
Lock-Konkurrenz-Prüfstand. Zwei **verschiedene** Antworten, das bleibt aus B5 gültig:

- **#210** bauen: der im Issue vorgezeichnete **fadenfreie** Weg (Prozess-Startzeit in den
  Merker) macht die Fristschätzung überflüssig, statt sie zu verbessern. Die Schadensklasse ist
  einmal real eingetreten (#207).
- **#237** zuerst **messen**, nicht bauen: ob eine getrennte SMB-Freigabe hier überhaupt hängt,
  ist nie beobachtet worden. Die Messung ist die ganze Arbeit und darf mit *nein* enden.

---

## G — Sprachkette (Reihenfolge, kein Bündel)

**#136 → #137**, **#164 blockiert.** Sie teilen keinen Kostenposten; gebündelt gewönne man
nichts. #136 ist eine Messung (echtes nicht-deutsches Audio liegt vor, bestätigt 2026-08-22)
und entscheidet, ob #137 überhaupt das richtige Problem löst. #164 hängt an einem Datenproblem
(`faster_whisper.Segment` hat kein `language`, stille Fenster verschieben jede
Reihenfolgezuordnung **still**).

---

## H — Diarisierung ▶ blockiert auf einer einzigen Sache

**#274 + #276.** Beide hängen am **Referenzsatz aus Task 8** (13 im Editor korrigierte Dateien,
Gruppenmitglieder einzeln benannt), offen seit 2026-08-17. #276s Lizenzfrage ist beantwortet
(CC-BY-NC akzeptabel, 2026-08-22) — daraus ist eine Messaufgabe geworden, kein Entscheidungspunkt
mehr. Ohne den Referenzsatz misst jeder Kandidat blind.

---

## I — Einzelgänger, mit Disposition

| Issue | Disposition |
|---|---|
| **#346** BatchedInferencePipeline | Selbständige GPU-Messung, **auf diesem Rechner heute fahrbar**. Zwei Fallstricke stehen im Issue (`vad_filter`/`without_timestamps` haben im batched Pfad andere Defaults; `vad_filter=True` wäre echter Schaden). Guter Kandidat für ein ruhiges Fenster. |
| **#455** Glossar-`OSError` | Klein, aber **eine offene Entscheidung** (zwei vertretbare Wege stehen im Issue). Entscheidung zuerst, dann Fix + Test. |
| **#539** renovate.json ohne Test | Klein, **offene Entscheidung** (Renovate als devDependency / Config-Validator / bewusst ohne). Kein Bündelpartner. |
| **#469** 61 Zeilenverweise | **Konfliktfläche über ~15 Dateien.** Läuft zuletzt und allein, in einem Fenster ohne offene PRs — sonst rebasiert jeder andere Branch dagegen. |
| **#288** torch CVE | **Nichts zu tun.** Schliesst sich selbst, sobald der cu128-Index eine Fixfassung führt. Handlung: quartalsweise nachsehen. |
| **#95** Installer signieren | Beschaffung + Geld. Blockiert auf **einer** Frage an Certum (läuft SimplySign in GitHub Actions?). Die Anfrage braucht einen Besitzer. |
| **#509** `.weg`-Karenz im Mischbetrieb | Eigener PR (aus A herausgenommen, siehe oben). |
| **#45** Dependency Dashboard | Renovate-Artefakt, kein Issue. |

---

## Reihenfolge

```
A (#523+#496 + atomares Schreiben)        ← ZUERST, läuft heute, kein Mac
   └─ B (K4: #381+#382 + #442)            ← nach A, app.py ist dann frei
C1 (#530b)  ·  C2 (#530c → #519 → #520)   ← unabhängig von A/B, eigener Prüfstand
D  (#423 → #515)                          ← Bedingung vor dem Bau klären
E  (Mac-Fenster)                          ← sobald Marcus am M1 ist, jederzeit dazwischen
F  (#210 [+#237-Messung])  ·  G  ·  H     ← später bzw. blockiert
I  Einzelgänger; #469 GANZ zuletzt, allein
```

**Was nicht parallel laufen darf:** A und B (beide `webtool/app.py`), A und C1 (beide fassen
die Subprozess-Einstiege an), sowie #469 gegen alles. Der CodeRabbit-Slot ist repo-weit —
zwei gleichzeitige PRs kosten einander Reviews.

## Lücken, die dieser Plan benennt statt versteckt

1. **Releasebedingung ohne Issue:** der Linux-Icon-Rest aus #503 liegt nur lokal auf dem Mac
   (`git ls-remote --heads origin` findet keinen `fix/kaltreview-icon-linux`), #503 ist
   geschlossen. Nach der Repo-Regel *was die Session überlebt, wird ein Issue* fehlt hier eines.
2. **v0.53.0 ist fällig:** Electron 44 (`package.json: electron ^44.0.0`) und der
   Korrekturlauf-Fix liegen ungereleast auf master, die Release-Notiz unter
   `## Unveröffentlicht` ist geschrieben. Die README beschreibt den **Release**-Stand — das
   Driftfenster ist offen.
3. **#36 bleibt halb offen:** der Linux-Teil braucht eine VM mit Desktop-Bibliotheken; es gibt
   keine und keine geplante (Antwort Marcus, 2026-08-22). Ein Mac-Fenster schliesst #36 nicht.
4. **PR #540** (vitest v5, Major) liegt offen und gehört vor die Bündel oder klar dahinter —
   ein Major auf der Testkette rebasiert sonst gegen jeden Branch.

## Verifikation dieses Plans

- `gh issue list --state open` → 29, deckungsgleich mit der Zuordnung oben (jede Nummer kommt
  in genau einem Paket vor).
- Jede Kopplungsbehauptung ist an einer Zeile belegt, nicht an einem Thema:
  `webtool/app.py:1162`, `:1620`, `:1630`, `:1100` und die vier Aufrufer `:1203/:1638/:1817/:2105`.
- Die drei widerlegten Zustandsbehauptungen sind mit `gh issue view <n> --json state`
  nachgezählt, nicht aus dem Merker übernommen.
