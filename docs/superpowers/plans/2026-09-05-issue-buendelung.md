# Bündelungsplan 2026-09-05 — die nächsten Gruppen

> **Kein Implementierungsplan.** Triage: welche Bündel es heute gibt, welches als
> nächstes läuft, was blockiert bleibt. Jedes Bündel bekommt seinen eigenen Plan,
> wenn es dran ist. Nachfolger von `docs/superpowers/plans/2026-09-03-issue-buendelung.md`,
> dessen Kriterium unverändert weitergilt.
>
> **Ablageort nach der Freigabe:** `docs/superpowers/plans/2026-09-05-issue-buendelung.md`.

**Stand, gemessen am 2026-09-05:** **38 offene Issues**, **0 offene PRs**, master nach dem
Merge von #571. Die Zahlen in diesem Kopf sind der Stand ihrer Zeile — wer daraus etwas
ableitet, zählt nach: `gh issue list --state open --json number --jq 'length'`.

---

## Context — warum dieser Plan

Der Vorgängerplan vom 2026-09-03 beschreibt eine Issue-Menge, die es so nicht mehr gibt:

| Behauptung des Vorgängers | Gemessen (`gh issue view <n> --json state`) |
|---|---|
| Bündel **A** offen (#523, #496) | **beide CLOSED** — PR #544 |
| Bündel **B** offen (#381, #382, #442) | **alle drei CLOSED** — PR #559, PR #562 |
| 27 offene Issues | **38** |
| PR #540 (vitest v5) offen, gehört vor die Bündel | **gemerged**, vitest **5.0.0** installiert |

**14 Issues sind seit dem 03.09. dazugekommen** und stehen in keinem Bündel:
Issues #553, #554, #555, #556, #557, #558, #560, #561, #564, #565, #566, #567, #568, #569.
Zwölf davon sind Reviewbefunde aus PR #559/#562/#563, also Arbeit, die dieser Rechner
heute fahren kann — kein Mac, keine Beschaffung.

Dieser Plan ordnet die 14 ein und benennt, welches Bündel als nächstes läuft.

## Das Kriterium (unverändert)

Gebündelt wird nach **geteilten Prüfkosten**, nicht nach Themenähnlichkeit
(`aehnlichkeit-ist-keine-kopplung`). Teure Posten: Browser-Sitzung · gepackter
Electron-Lauf · CodeRabbit-Kontingent (je **Commit**, repo-weit) · Mac-Hardware ·
Messstand (Wegwerf-Projekt + uvicorn + echter Job) · Marcus' Entscheidungen.

---

## J — Der Vertragstest der Protokollzeilen ▶ NÄCHSTES

**#564 + #565 + #566 + #567 + #568 + #554.** Mitfahrer: **#553**, **#569**.

**Warum zusammen — eine Datei, gemessen.** Fünf der sechs zeigen auf dieselbe Datei:

```text
webtool/frontend/jobPhases.vertrag.test.ts   1323 Zeilen, 83 KB
```

- **#564** ~90 Protokollzeilen liegen ausserhalb der Ernte
- **#565** kein Riegel gegen eine geweitete Formenmenge
- **#566** Template-Literale in geernteten Arrays werden übersprungen
- **#567** zwei Fixture-Zeilen ohne Erzeuger (`webtool/correct.py:233`, `webtool/fetch.py:589`)
- **#568** der Tabulator der `[diagnose]`-Formen ist ein Escape, kein Tabulator
- **#554** genau diese Datei wird von **keiner** tsconfig geprüft

Das sind fünf Löcher **im selben Erntemechanismus** plus die fehlende Typprüfung darüber.
Einzeln gebaut kostet dasselbe Werkzeug fünf CodeRabbit-Slots, und jeder Fix verschiebt die
Zeilennummern der anderen vier.

**#554 ist KEIN Einzeiler — der naheliegende Weg ist bereits tot gemessen.** Der Dateikopf
(Zeile 24–31) hält fest: `tsconfig.node.json` aufzunehmen zöge `src/lib/jobPhases.ts` samt
`./types` in das node-Projekt, **TS2835, nachgemessen**. `rollbalken.test.ts` steht dort und
ist ausdrücklich der **Gegenfall**, kein Präzedenzfall — es importiert nichts aus `src/`.
Der Fix braucht also einen dritten Projekt-Eintrag oder einen anderen Weg; das ist der Grund,
warum #554 in dieses Bündel gehört und nicht als Beiwerk mitläuft.

**Mitfahrer #553** (jest-dom unter vitest 5, TS2739 bei `.resolves`/`.rejects` mit Matcher):
derselbe `tsc -b`-Durchgang aus `npm run build`. Er liegt in vier Dateien unter `src/`
(`useFehlerberichte.test.tsx`, `useUpdate.test.tsx`, `api.test.ts`, `releases.test.ts`), die
`tsconfig.app.json` bereits prüft. **Er blockiert #554 nicht** — gemessen:
`grep -cE '\.(resolves|rejects)\b' jobPhases.vertrag.test.ts` = **0**.

**Mitfahrer #569** (`useActiveJob.test.tsx` kippt unter Volllast) ist die **schwächste
Kopplung dieses Bündels** und wird als erstes abgespalten: geteilt ist nur die
Frontend-Testsitzung, nicht die Datei und nicht der Mechanismus.

**Prüfkosten:** ein `npm run build` (tsc), ein `vitest run`, eine Mutationsprobe je
Zusicherung. **Kein Browser, kein Mac, kein Messstand, keine offene Frage an Marcus.**

**Abbruchregel:** braucht das Bündel eine zweite Reviewrunde, fallen in dieser Reihenfolge
raus: #569, dann #553, dann #567.

---

## K — Verlorene Aufnahmen in der Verfolgung ▶ NACH J

**#557 + #560 + #561.**

| Issue | Dateien laut Issue |
|---|---|
| **#557** URL-Import-Nachlauf ohne Vorgangsnummer (Rest von #381) | `webtool/app.py`, `jobs.py`, `useActiveJob.tsx` |
| **#560** Sammelupload verfolgt nur die letzte Aufnahme | `ProjectWorkspace.tsx:340`, `MaterialDialog.tsx:222` |
| **#561** Korrektur-Schlange verliert Aufnahmen an den Zeilendeckel | `webtool/jobs.py`, `jobPhases.ts` |

**Geteilt ist der teuerste Posten, und zwar buchstäblich derselbe Aufbau:** ein
Wegwerf-Projekt mit **mehreren** Aufnahmen, uvicorn, ein echter Lauf, eine Browser-Sitzung.
Für jede der drei muss genau das stehen; einmal aufgebaut trägt es alle drei.

**Warum NACH J, kausal statt thematisch.** K fasst **beide Seiten** des Vertrags an, den J
repariert — belegt an `jobPhases.vertrag.test.ts:89–96`: `QUELLEN` erntet `transcribe.py`,
`webtool/correct.py`, `webtool/fetch.py` (Druckseite, die #557 verändert), und die zweite
Richtung (`parserMuster`) prüft `jobPhases.ts` (Parserseite, die #561 verändert). Ein
Wächter mit fünf gemessenen Löchern lässt genau die Änderung durch, die er bewachen soll.

**Ehrlich benannt:** dass alle drei *derselbe* Mechanismus sind (die Verfolgung hängt an
EINER Aufnahme statt an allen), ist eine **Lesart der Issue-Texte, keine Messung am Code**.
Gemessen ist nur der geteilte Prüfstand. Wer K baut, prüft die Mechanismus-These zuerst —
trägt sie, ist es ein Fix der Klasse; trägt sie nicht, sind es drei Fixes auf einem Stand.

---

## L — Renovate- und Reviewketten-Werkzeug ▶ unabhängig, startet mit einer Frage

**#555 + #556 + #539.**

- **#555** `renovate-pruefen` gab **rc 0** für einen PR mit roter CI (`fehlendes-werkzeug-sieht-aus-wie-sauber`)
- **#556** Renovate-PRs bekommen **nie** ein CodeRabbit-Review — die vierte stille Ausfallart
- **#539** `renovate.json` hat keinen Test, drei Regeln mit stillem Ausfall

**Geteilter Prüfstand: ein echter Renovate-PR mit roter CI.** Den gibt es nicht auf Zuruf —
er muss abgewartet oder gestellt werden, und genau diese Beschaffung teilen sich alle drei.
Aufgabenindex **T-015** ist dieselbe Messung, **T-012** dasselbe Issue wie #539.

**#539 trägt eine offene Entscheidung** (Renovate als devDependency / Config-Validator /
bewusst ohne). Das Bündel beginnt also mit einer Frage an Marcus, nicht mit Arbeit — deshalb
steht es hier und nicht vor K.

---

## Unverändert aus dem Vorgängerplan

| Paket | Stand |
|---|---|
| **C1** #530 (b) Python-SDK · **C2** #530 (c) → #519 → #520 → #541 | unverändert; C2 braucht den gepackten Electron-Lauf |
| **D** #423 → #515 | Bedingung **vor** dem Bau klären (Playwright-Messlauf oder nicht) |
| **E** Mac-Fenster #36 · #504 · #512 · #530 (a) · Linux-Icon | **blockiert auf Marcus' M1** |
| **F** #210 (+ #237 als Messung) | später |
| **G** #136 → #137, #164 blockiert | Reihenfolge, kein Bündel |
| **H** #274 + #276 | blockiert auf dem Referenzsatz aus Task 8 |
| **I** #346 · #455 · #469 · #288 · #95 · #45 · #509 | Einzelgänger; **#469 ganz zuletzt, allein** |

## Was ausdrücklich NICHT gebündelt wird

- **#558** (`test_auth.py` sporadisch, 2 von 7 Läufen) neben #569: beides Flaky, aber
  **verschiedene Läufer, verschiedene Dateien, verschiedene Sprachen**. Gemeinsam ist die
  Methode, nicht der Prüfstand — nach dem Kriterium kein Bündel. #558 läuft einzeln; es ist
  eine Steuer auf jede andere Messung und gehört deshalb früh, nicht spät.
- **#567 zu #557/#561**, obwohl beide `webtool/fetch.py` nennen: #567 fasst die **Fixture**
  an, nicht den Erzeuger. Gleiche Datei, verschiedene Seite.

## Reihenfolge

```text
J  (#564 #565 #566 #567 #568 #554, Mitfahrer #553 #569)   ← NÄCHSTES, heute fahrbar
   └─ K (#557 + #560 + #561)        ← danach: J repariert den Waechter, den K beidseitig anfasst
L  (#555 + #556 + #539)             ← unabhaengig, beginnt mit der Frage zu #539
#558                                ← einzeln, frueh (Steuer auf jede Messung)
C1 · C2 · D · F · G · H             ← wie im Vorgaengerplan
E  (Mac)                            ← blockiert auf Marcus
#469                                ← ganz zuletzt, allein
```

**Was nicht parallel laufen darf:** J und K (beide fassen den `jobPhases`-Vertrag an) ·
K und C1 (beide die Subprozess-Einstiege) · #469 gegen alles. Der CodeRabbit-Slot ist
repo-weit — zwei gleichzeitige PRs kosten einander Reviews.

## Verifikation

**Verifikation dieses Plans:**

- **Die Zahl, gemessen:** `gh issue list --state open --limit 200 --json number --jq 'length'`
  → **38**. **`--limit` ist Pflicht, nicht Kosmetik:** ohne ihn deckelt `gh` bei **30** und
  antwortet `30` — eine Zahl, die wie ein Ergebnis aussieht und ein Deckel ist. Die erste
  Fassung dieser Zeile stand ohne `--limit` hier und hätte jeden Nachzähler in die Irre
  geführt; gefunden vom Bot, mit dem Lauf bestätigt.
- **Die Zuordnung, VON HAND gezählt** (kein Kommando prüft sie — das ist der ehrliche Stand):
  J 8 · K 3 · L 3 · C 4 · D 2 · E 3 · F 2 · G 3 · H 2 · I 7 · #558 1 = **38**.
  Jede Hauptnummer zählt einmal; #530 ist nach Teilpunkten auf zwei Pakete verteilt —
  #530 (b)/(c) in C, #530 (a) in E —, gezählt wird es bei C. Wer die Pakete umbaut, zählt
  neu; eine maschinelle Gegenprobe gibt es nicht.

**GEMESSEN — mit dem Kommando, das die Zahl erzeugt hat:**

| Aussage | Messung |
|---|---|
| 38 offene Issues, 0 offene PRs | `gh issue list --state open --limit 200 --json number --jq 'length'` · `gh pr list --state open` |
| A und B geschlossen | `gh issue view <n> --json state` für #523 #496 #381 #382 #442 → alle CLOSED |
| Fünf J-Issues zeigen auf **dieselbe** Datei | `gh issue view <n> --json body` je Issue, Dateiverweise ausgezogen → #564 #565 #566 #567 #568 nennen alle `webtool/frontend/jobPhases.vertrag.test.ts` |
| Datei 1323 Zeilen, 83 506 Byte | `wc -l` · `ls -la` |
| Vertragsdatei von keiner tsconfig erfasst | `tsconfig.app.json` include = `["src"]`, Datei liegt im Stamm; `tsconfig.node.json` include nennt `rollbalken.test.ts` namentlich |
| #553 blockiert #554 nicht | `grep -cE '\.(resolves\|rejects)\b'` auf die Vertragsdatei = **0** |
| #554 ist kein Einzeiler (TS2835) | Dateikopf `jobPhases.vertrag.test.ts:24–31` |
| J und K fassen **denselben** Vertrag an | `QUELLEN` in `jobPhases.vertrag.test.ts:89–96` erntet `webtool/fetch.py` und `webtool/correct.py`; die Gegenrichtung (`parserMuster`) prüft `jobPhases.ts` |
| vitest 5.0.0 installiert, #553 also live | `node -p` auf `node_modules/vitest/package.json` |

**HERGELEITET aus den Issue-Texten, hier NICHT nachgemessen** — wer daran arbeitet, misst zuerst:

- **dass J vor K laufen MUSS.** Gemessen ist der geteilte Vertrag (Zeile darüber), nicht die
  Reihenfolge. Der Schluss „ein Wächter mit Löchern lässt die Änderung durch, die er bewachen
  soll" ist ein Argument, kein Lauf — er wäre widerlegt, wenn K die geernteten Druckformen gar
  nicht anfasst;
- **was** die fünf Löcher in #564–#568 je sind (Ernte-Umfang, Formenmenge, Template-Literale,
  Escape-Tabulator) und ob sie noch bestehen;
- **#569**: Laufzahl und Fehlerausgabe des Volllast-Kippers liegen nicht vor;
- **der geteilte Prüfstand von K** — dass ein Aufbau alle drei trägt, ist aus den
  Dateiverweisen geschlossen, nicht durch einen Lauf belegt;
- **L komplett**: #555 (`rc 0`), #556 (`nie`) und #539 (`drei Regeln`) stehen ohne eigene
  Messung hier. Für #556 wäre das eine `gh api`-Abfrage über die Renovate-PRs, für #555 ein
  Lauf gegen einen roten PR — beides gehört an den Anfang von L, nicht in diesen Plan.

**Von Bündel J, bevor es als fertig gilt:**
1. `npm --prefix webtool/frontend run build` — der tsc-Lauf muss die Vertragsdatei jetzt
   erfassen (vorher: `tsconfig.app.json` include = `["src"]`, Datei liegt im Stamm).
2. `npm --prefix webtool/frontend test` — 920+ Tests grün.
3. **Mutationsprobe je neuer Zusicherung** über `scripts/mutation.py` (seit PR #571 im Repo):
   Loch zurückbauen ⇒ genau der neue Test rot. Für #565 ist die Mutation das **Weiten** der
   Formenmenge, nicht das Löschen — `mutiere-die-absicht-nicht-die-mechanik`.
4. Reviewkette in fester Reihenfolge: Subagent → CodeRabbit-CLI → PR.
