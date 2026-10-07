# Issue-Bündelung nach dem 06.10.2026

Stand: 07.10.2026 · Basis: `master` auf `46798c7` · Vorgänger: `2026-09-15-issue-buendelung.md`

Bündelkriterium wie bisher: **geteilte Prüfkosten**, nicht Themenähnlichkeit. Neu gegenüber dem
Vorgänger ist, dass der Plan auch die offenen PRs, die lokalen Zweige und den lokalen Aufgabenindex
(`.code-guardian-todo.md`, gitignoriert) einbezieht. Dort lag Arbeit, die in keinem Plan stand.

## Gemessener Bestand

Alle Zahlen stammen vom 07.10.2026. Die Kommandos und ihre Ergebnisse stehen im Verifikationsblock am Ende.

| Was | Zahl |
| --- | --- |
| offene Issues | **21**, davon das Renovate-Dashboard (Nr. 45), das kein bearbeitbares Issue ist |
| offene PRs | 7 (sechs Renovate-PRs und PR 663) |
| fertige, nie gepushte Zweige | 5 Issue-Zweige und 1 Baseline-Zweig, alle vom 04.10. mit je einem Commit auf `master` |
| weitere Zweige mit Commits, die in keinem PR waren | 5 |
| unveröffentlicht seit v0.58.2 (30.09.) | 14 Commits, darunter 2 Behoben-Zeilen in `RELEASE-NOTIZEN.md` |
| offene Punkte im lokalen Aufgabenindex | 133, davon **keiner** mit Wirkung-Zeile |

## Änderung zum Plan vom 15.09.2026

| Behauptung im Vorgänger | Messung heute |
| --- | --- |
| Nächstes Bündel: Nr. 613 und Nr. 616 | beide CLOSED am 17.09. |
| Nr. 615 und Nr. 618 durch PR 624 geliefert | beide CLOSED am 17.09. |
| Einzelarbeit Nr. 619 (Prompt-Vertrag) | CLOSED am 18.09. |
| Einzelarbeit Nr. 622 (Mutationstreiber) | CLOSED am 23.09. |
| Bündel C2: Nr. 530, Nr. 519, Nr. 520 | Nr. 530 CLOSED am 24.09., Nr. 519 CLOSED als NOT_PLANNED am 23.09., Nr. 520 offen und allein |
| Einzelarbeit Nr. 509 | CLOSED am 28.09. |
| Einzelarbeit Nr. 553 und Nr. 469 | weiterhin offen, aber jetzt mit fertigem lokalem Zweig |
| Renovate-PR 621 als einziger offener PR | 7 offene PRs |

Neu seit dem Vorgänger sind Nr. 659 und Nr. 661 (01.10.) sowie Nr. 665 und Nr. 666 (06.10.).
Kontrolle: 26 − 9 + 4 = 21.

Bündel C2 war ein Bündel geteilter Prüfpfade (Fehlerbericht, Transport, Drosselung), kein Blocker.
Seit Nr. 530 und Nr. 519 zu sind, steht Nr. 520 allein.

## Offene PRs

| PR | Zustand | Ursache, falls rot |
| --- | --- | --- |
| 663 Oxlint-Riegel-Selbsttests auf vitest | grün, CLEAN | – |
| 664 `@sentry/electron` v8 (Major) | grün, CLEAN | – |
| 652 `huggingface-hub` v2 | grün, CLEAN | Das Grün belegt wenig: `webtool/test_hf_tls.py` ersetzt `huggingface_hub` per `sys.modules` durch einen Stub |
| 637 `@vitejs/plugin-react` 6.1.2 | grün, CLEAN | – |
| 658 `av` v19 | rot | der Wächtertest `test_grundsetup_begrenzt_pyav_auf_decoder_kompatible_fassungen` lässt `av` 18.1.0 zu und 19.0.0 nicht (Pin `av>=11,<19`); er hängt damit an Nr. 666 |
| 640 `wavesurfer.js` v8 (Major) | rot | nur Infrastruktur: Mutationsproben 3/4 mit „runner has received a shutdown signal“ (exit 143); alle Serien davor bestanden |
| 621 all-minor-patch | rot | mypy 2.4.0 meldet zwei neue Befunde: `scripts/coderabbit_riegel.py` (`no-any-return`) und `webtool/auth.py` (`arg-type`) |

## Die Bündel

Jedes offene Issue hat genau eine Primär-Disposition.

| Bündel | Issues | geteilter Prüfposten |
| --- | --- | --- |
| **1 Ernte fertiger Zweige** | 659, 553, 469 | Reviewkette je Zweig, lokaler pytest/vitest, CI; kein Messaufbau |
| **2 Electron-Paketlauf** | 520 | ein gepackter Windows-Lauf, der Empfang in Bugsink und eine node:test-Mutationsprobe |
| **3 Renovate-Runde** | 45 | Skill `renovate-pruefen`, CI, CodeRabbit-Einheiten |
| **4 ASR-Messstand (GPU)** | 665, 164, 666, 346 | ein GPU-Lauf am eingefrorenen 125-Datei-Manifest der Studie vom 06.10. |
| **5 Browser-Sitzung** | 661 | ein Dev-Server, Playwright und ein Browser-Beleg |
| **6 Korrektur-Treue** | 136, 137 | LLM-Läufe am echten Material |
| **7 Sperrprotokoll** | 210, 237 | eine Entwurfsentscheidung und die CI auf drei Systemen |
| **Wartend** | 36, 504, 512, 274, 276, 95, 288 | ein Auslöser außerhalb des Repos |

Kontrollsumme: 3 + 1 + 1 + 4 + 1 + 2 + 2 + 7 = **21**.

### Bündel 1 — Ernte fertiger Zweige

Fertige Arbeit verliert mit jedem Merge auf `master` an Wert, deshalb kommt dieses Bündel zuerst.
Jeder Zweig bekommt einen eigenen PR. Die PRs laufen nacheinander, weil das CodeRabbit-Kontingent
für das ganze Repo gilt und jeder Push eine Einheit kostet.

1. **PR 663** mergen, nachdem die drei Review-Kanäle gelesen sind. Damit ist der Oxlint-Teil von
   Nr. 659 erledigt; der PR-Text sagt selbst, dass die Electron-Tests offen bleiben.
2. **Nr. 659**, Zweig `fix/issue-659-node-test`, auf den neuen `master` rebasen. Die Kollision mit
   PR 663 betrifft mehr als eine Datei: PR 663 benennt die Testdatei des Riegels um und **entfernt das
   npm-Skript `test:lint`**. Im Zweig sind deshalb zwei Teile zu streichen oder umzubauen: der eigene
   Plan `scripts/mutationen/oxlint_riegel.json` (er doppelt PR 663s `oxlint-riegel.json`) und der Test
   `test_echter_oxlint_plan_testlauf_ist_startbar` (er setzt `test:lint` voraus). Auch das
   Fertig-wenn von Nr. 659 nennt `test:lint` wörtlich und wird neu gefasst; Ziel sind die
   Electron-Tests auf node:test. Es bleiben die node:test-Unterstützung in `scripts/mutation.py` und
   ein Mutationsplan für `electron/main.test.js`. Gemessen: `_direkte_kommando_teile` lehnt das
   npm-Skript `test:electron` ab, weil es `&&` enthält. Der Plan ruft den Läufer deshalb direkt auf,
   oder `mutation.py` lernt die Form. Mitfahrer an `scripts/mutation.py` und
   `scripts/mutationen_lauf.py` mit derselben Prüfung: T-044, T-058, T-079, T-080, T-082, T-084, T-208.
3. **Nr. 553**, Zweig `fix/issue-553-jest-dom-types`. Der Zweig wählt eine eigene Typdatei, weil
   es nach der installierten jest-dom 7.0.1 keine neuere Fassung gibt (`npm view`). Den Weg bestätigt
   Marcus beim Start.
4. **Nr. 469**, Zweig `docs/issue-469-symbol-references` (36 Dateien). Er überschneidet sich mit
   keinem anderen fertigen Zweig, wohl aber mit Bündel 4 (`transcribe.py`). Deshalb wird er **vor
   Bündel 4** gemergt; die Verweise werden vor dem Merge gegen `master` nachgeprüft.
5. Zweig `chore/t030-ruff-baseline` (entfernt fünf Baseline-Einträge, laut Commit-Text erledigte; ein
   ruff-Lauf steht aus), Mitfahrer T-203.

### Bündel 2 — Electron-Paketlauf (nach Schritt 1.2)

- **Nr. 520**, Zweig `fix/issue-520-abweisungsbudget`. Der Zweig folgt Richtung 1 aus dem Issue
  (Erstmeldungen je Abweisungsart reservieren). Die Richtung bestätigt Marcus beim Start. Der
  Mutationsplan aus Schritt 1.2 entsteht gegen `master`, der Zweig ändert aber `electron/main.js`
  und `electron/main.test.js`. Deshalb zieht Nr. 520 die Anker des Plans nach und ergänzt eine
  Mutation für die Reservierung je Art.
- **PR 664** (`@sentry/electron` v8): Die CI ist grün, ob der Transport im gepackten Lauf bei Bugsink
  ankommt, ist ungemessen.
- **electron 44.3.0 → 44.6.0** aus PR 621: `master` steht schon auf `^44`, es ist nur ein
  Minor-Sprung. Er läuft trotzdem im selben gepackten Lauf mit, weil dieser Lauf ohnehin stattfindet.
- **Baustand des Laufs:** `master` pinnt im `package-lock.json` electron 44.3.0 und `@sentry/electron`
  7.18.0. Ein Paket aus dem Zweig zu Nr. 520 allein würde also die **alten** Fassungen messen. Deshalb
  wird aus einem lokalen Integrationsstand gebaut: Zweig 520, PR 664 und PR 621 zusammengeführt.
  Gemergt wird danach jeder für sich.

### Bündel 3 — Renovate-Runde

- **PR 621**: die zwei mypy-2.4.0-Befunde auf `master` beheben und Renovate neu aufsetzen lassen.
  Gemergt wird erst nach dem Paketlauf aus Bündel 2. Mitfahrer: T-216 (jsdom-Regel) und T-217
  (mutmut 3.8, osv v2.6.0).
- **PR 637**: mergen.
- **PR 640**: den abgebrochenen Job neu starten; die Wellenform (Major-Sprung) wird im Browserlauf
  von Bündel 5 angesehen.
- **PR 652**: echt messen, ob `set_client_factory` in huggingface-hub 2.x noch existiert, dazu ein
  echter Modell-Download unter Windows über den TLS-Pfad aus Nr. 644.
- **Nr. 45** (Dashboard) zusammen mit T-013.
- **PR 658** bleibt rot bis Bündel 4b.

### Bündel 4 — ASR-Messstand (GPU, läuft im Hintergrund)

- **4a jetzt, nach Schritt 1.4:**
  - Nr. 665: `TRANSKRIBOR_MIX_SCHWELLE` auf 0,3 und auf 0 am Studien-Manifest messen. Danach
    entscheidet Marcus, ob die Schwelle sich ändert.
  - Nr. 164 (Sprache je Segment): dieselbe Stelle `_Sprachschwelle`. Das Messwerkzeug braucht die
    Fenstersprache ohnehin.
- **4b blockiert**, bis faster-whisper eine Fassung nach 1.2.1 veröffentlicht. SYSTRAN 1460 und 1495
  sind upstream gemergt, aber noch nicht released. Dann laufen Nr. 666, PR 658 und Nr. 346 in
  **einem** Regressionslauf.
- **Wo das Manifest liegt:** dauerhaft unter `~/.claude/upstream-repro/sprachwechsel-studie-2026-10-06/`,
  byte-gleich mit dem Original. Der Hash der Datei auf der Platte weicht vom eingefrorenen Wert ab,
  aber nur durch das CRLF beim Schreiben unter Windows (Messung unten).
- Der lokale Aufgabenordner der Studie wird mit Belegen geschlossen. Der Upstream-Kommentar wartet
  auf Marcus' Freigabe.

### Bündel 5 — Browser-Sitzung

- **Nr. 661**, Zweig `test/issue-661-dialog-lifecycle` (Test, e2e-Spec, Mutationsplan). Die CI fährt
  Playwright (`.github/workflows/test.yml`, `npm run test:e2e`). Mitfahrer an `webtool/frontend/e2e/`:
  T-127, T-128, T-153, T-154, T-212.
- In derselben Sitzung, je mit eigenem PR, die Punkte mit Wirkung für Nutzer:
  - T-123, T-124, T-125: Barrierefreiheit der Projektgalerie, `HomeGallery.tsx`
  - T-067, T-068, T-069: Abschlussmeldung und Job-Status
- Die Wellenform von PR 640 ansehen.

### Bündel 6 — Korrektur-Treue

Nr. 136 kommt vor Nr. 137, laut Kommentar vom 22.08. in Nr. 136. Mitfahrer an `webtool/correct.py`:
T-146, T-193, T-209 und T-188. T-188 misst den 409 im selben Messstand.

### Bündel 7 — Sperrprotokoll

Nr. 210, Nr. 237 und T-163. Vor dem Bau entscheidet Marcus, ob der Merker einen Herzschlag oder die
Prozess-Startzeit trägt, und ob Nr. 237 mit seinem eigenen Messaufbau (getrennte Netzfreigabe)
überhaupt gebaut wird.

### Wartend

| Issues | Auslöser |
| --- | --- |
| 36, 504, 512 (dazu T-019, T-020, T-166) | Marcus am Apple-Silicon-Rechner |
| 274, 276 | Referenzsatz aus Task 8 |
| 95 | Antwort von SignPath (seit 11.08. kein Eintrag im Issue) |
| 288 | torch 2.13 im cu128-Index (heute höchstens 2.11.0) |

Zwei Teile sind schon vorab entscheidbar:

- **Linux-Hälfte von Nr. 36** abtrennen. Laut Entscheidung vom 22.08. wird keine Linux-Hardware
  beschafft.
- **Nr. 504** schließen oder eingrenzen. Die Nachmessung vom 02.09. ergab mit torchcodec 0.16
  0 objc-Zeilen.

## Arbeit außerhalb der Issues

**A — Aufgabenindex bereinigen** (Entscheidung Marcus, 07.10.):

- die überholten Punkte mit Beleg abhaken
- die Zeilen mit cp1252-Bytes reparieren; sie bringen `todo-status.py` zum Absturz
- Befunde am Code-Guardian-Paket als ein Sammelentwurf; der Versand folgt erst nach Freigabe
- Punkte zu globalen Werkzeugen auf eine eigene Liste außerhalb des Repos
- Repo-Punkte ohne Wirkung fahren nur als Mitfahrer mit, wenn sie dieselben Dateien und dieselbe
  Prüfung haben wie ein Bündel; die übrigen werden mit Grund vertagt

Erledigt am 07.10. Der Index hat danach **50 offene Punkte statt 133**, und alle 50 tragen eine
Wirkung-Zeile: 2 S, 6 K, 2 R, 40 V. Die übrigen 83:

| Ergebnis | Zahl |
| --- | --- |
| mit Beleg erledigt | 19 |
| mit Grund verworfen | 15 |
| an das Code-Guardian-Paket übergeben (`fremd`) | 13 |
| an globale Werkzeuge übergeben (`fremd`) | 20 |
| ohne Wirkung vertagt | 16 |

Neu nummeriert wurden, als T-540 bis T-546, alle drei doppelt vergebenen IDs (T-071, T-094 und T-200)
sowie die vier Punkte ohne Nummer. Die Reservierungsablage
`.code-guardian-todo-ids` ist gesperrt, dieselbe Sandbox-Rechtelage wie bei den `.tmp-*`-Ordnern, und
gehört deshalb zu C.

**B — Entscheidungsrunde:** Die offenen Entscheidungspunkte aus dem Index werden in einer Runde
gesammelt vorgelegt, nicht einzeln je Bündel. Ein Sicherheitspunkt kommt zuerst.

**C — Aufräumen** (lokal; jede Löschung erst ansehen, dann freigeben lassen):

- Sicherungszweig und Stash
- Arbeitsbäume, deren Arbeit schon gemergt ist:
  - einer trägt noch 77 geänderte Dateien
  - zwei sind ausgeräumt und zeigen je rund 445 gelöschte Einträge
- 166 gesperrte `.tmp-*`-Ordner; dafür liegt ein Admin-Skript bereit. Ebenfalls gesperrt und dort
  nachzutragen: `.code-guardian-todo-ids`
- drei unversionierte Plandokumente
- fünf Zweige, deren Commits in keinem PR waren:
  - zwei Dialekt-Savepoints vom 17.09. Das Messwerkzeug `tools/speech_eval.py` ist auf `master`
    getrackt und hat dort drei spätere Fix-Commits; der Rest-Diff wird einmal angesehen
  - zwei kleine Test-Nachschübe, die schon auf origin liegen
  - ein Plan vom 23.08.

**D — Release:** nach Bündel 1 und 2 v0.58.3 über den Release-Skill (startet Marcus). Mitfahrer
T-136 und T-148 (Riegel in `release.yml`).

## Reihenfolge

0. B und PR 640 neu starten. Dafür ist kein Code nötig. A ist erledigt.
1. Bündel 1: PR 663 → 659 → 553 → 469 → t030.
2. Bündel 2, danach PR 621, dann Release v0.58.3.
3. Bündel 4a im Hintergrund (nach Schritt 1.4), parallel dazu Bündel 5.
4. Bündel 6, dann Bündel 7 (sobald Marcus über den Entwurf entschieden hat).
5. Die wartenden Issues erst, wenn ihr Auslöser eintritt.

## Verifikation

Gemessen am 07.10.2026; zu jedem Kommando steht das Ergebnis.

- `gh issue list --state open --limit 200 --json number` → 21 Nummern: 666, 665, 661, 659, 553, 520, 512,
  504, 469, 346, 288, 276, 274, 237, 210, 164, 137, 136, 95, 45, 36
- `gh pr list --state open --limit 200` → 664, 663, 658, 652, 640, 637, 621
- `gh issue view <n> --json state,stateReason,closedAt`:
  - 613 und 616 → CLOSED, COMPLETED, 2026-09-17T09:39Z
  - 615 → CLOSED, COMPLETED, 2026-09-17T08:06Z
  - 618 → CLOSED, COMPLETED, 2026-09-17T08:07Z
  - 619 → CLOSED, COMPLETED, 2026-09-18T18:41Z
  - 622 → CLOSED, COMPLETED, 2026-09-23T08:23Z
  - 519 → CLOSED, NOT_PLANNED, 2026-09-23T15:30Z
  - 530 → CLOSED, COMPLETED, 2026-09-24T15:29Z
  - 509 → CLOSED, COMPLETED, 2026-09-28T19:40Z
- `gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup`:
  - 663, 664, 652 und 637 → MERGEABLE/CLEAN
  - 658, 640 und 621 → MERGEABLE/UNSTABLE
  - die Ursachen der roten Checks über `gh run view --log-failed`, siehe Tabelle „Offene PRs“
- `git rev-list --count master..<zweig>` und `<zweig>..master` → +1/−0 für `fix/issue-659-node-test`,
  `fix/issue-553-jest-dom-types`, `docs/issue-469-symbol-references`, `fix/issue-520-abweisungsbudget`,
  `test/issue-661-dialog-lifecycle` und `chore/t030-ruff-baseline`. `git ls-remote --heads origin <zweig>`
  → 0 Zeilen, also nicht gepusht.
- `comm -12` über die Dateilisten (`git diff --name-only master...<zweig>`) des Zweigs zu Nr. 469 und
  der fünf übrigen fertigen Zweige, PR 663 eingeschlossen → keine gemeinsame Datei
- `git diff --name-only master...chore/oxlint-riegel-vitest` gegen den Zweig zu Nr. 659 → keine
  gemeinsame Datei, aber eine inhaltliche Kollision: `scripts/mutationen/oxlint-riegel.json` gegen
  `oxlint_riegel.json`; PR 663 entfernt `test:lint` aus `webtool/frontend/package.json`
- `mutation._direkte_kommando_teile(<test:electron aus package.json>)` → `None`. Kontrolle
  `"vitest run"` → `['vitest', 'run']`; Kontrolle `node scripts/testlauf.mjs electron/main.test.js`
  → wird zerlegt.
- `git describe --tags --abbrev=0 master` → v0.58.2 vom 2026-09-30; `git rev-list --count v0.58.2..master`
  → 14
- Aufgabenindex vor der Bereinigung:
  - awk-Zählung über die offenen Kopfzeilen → `offen=133 mit_Wirkung=0`
  - `todo-status.py --prioritaet` → `UnicodeDecodeError` (Byte 0xb7, Position 340522)
  - nach dem Reparieren von fünf cp1252-Zeilen: `OSError: [WinError 64]` bei `realpath` auf die
    UNC-Form einer `https://github.com/…`-URL (`todo-status.py:855`)
- Aufgabenindex nach der Bereinigung:
  - dieselbe awk-Zählung → `offen=50 mit_Wirkung=50`
  - `todo-status.py` läuft durch, SUMMARY `offen=50 … wirkung_s=2 wirkung_k=6 wirkung_r=2 wirkung_v=40
    ohne_wirkung=0`
  - die Befunde des Werkzeugs sinken von 44 auf 30; die restlichen betreffen alte, geschlossene Punkte,
    und keiner davon ist mehr eine Doppel-ID
  - Zeilenenden byteweise gezählt: das Bereinigungsskript ließ die 55 reinen LF-Zeilen unverändert.
    Die späteren Ein-Zeilen-Korrekturen mit dem Edit-Werkzeug haben dann die ganze Datei auf CRLF
    vereinheitlicht. Das ist harmlos, weil die Datei gitignoriert ist und ihre Leser jedes
    Zeilenende verstehen.
  - `todo-status.py --naechste-id` → `PermissionError` auf `.code-guardian-todo-ids`
- Studien-Manifest:
  - `sha256sum manifest.json` → `84cbf1d2…`
  - `tr -d '\r' < manifest.json | sha256sum` → `761cbc16…`, gleich dem eingefrorenen Wert
  - `cmp` mit dem Scratchpad-Original → byte-gleich
- `gh issue view 136 --json comments` → Kommentar vom 2026-08-22: „Reihenfolge bleibt: #136 vor #137.“
- `gh pr view 1460 -R SYSTRAN/faster-whisper` → MERGED am 05.10.; `gh pr view 1495 -R SYSTRAN/faster-whisper`
  → MERGED am 30.09.; `gh release list -R SYSTRAN/faster-whisper` → latest v1.2.1

## Hergeleitet, nicht nachgemessen

- Nr. 346 erst nach Nr. 666 zu messen, spart eine Doppelmessung, weil beide dieselbe Bibliothek
  betreffen.
- Die Qualität der fertigen Zweige ist unbekannt. Gelesen wurde nur der Diffstat; Tests und Reviews
  laufen erst in Bündel 1.
- Dass die Dialekt-Arbeit auf `master` angekommen ist, ist nur an `tools/speech_eval.py` und dessen
  späteren Fix-Commits festgemacht. Ob die Rest-Diffs der Savepoints etwas Neues enthalten, ist nicht
  geprüft; das Ansehen ist Teil von C.
- Die Zuordnung der Index-Punkte (überholt, Paketbefund, global, Mitfahrer, vertagt) stammt aus zwei
  lesenden Durchgängen von Subagenten. Kommando und Ergebnis je abgehaktem Punkt stammen aus ihren
  Berichten und stehen als Beleg-Zeile im Index. In dieser Sitzung wurden sie nicht einzeln nachgefahren.
- Die K-Wirkung von T-067, T-069 und T-146 ist am Code hergeleitet; gemessen wird sie erst im
  jeweiligen Bündel.
