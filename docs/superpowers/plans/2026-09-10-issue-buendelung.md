# Bündelungsplan 2026-09-10 — Übersicht und Neuordnung

> **Kein Implementierungsplan.** Triage: welche Bündel es gibt, welches als nächstes
> läuft, was blockiert bleibt. Jedes Bündel bekommt seinen eigenen Plan, wenn es dran
> ist. Nachfolger von `docs/superpowers/plans/2026-09-05-issue-buendelung.md`
> (dazwischen: `2026-09-09-buendel-l.md`, der Plan zu Bündel L); Kriterium
> unverändert: **geteilte Prüfkosten, nicht Themenähnlichkeit**.

## Context — warum dieser Plan

Der Vorgängerplan vom 2026-09-05 beschreibt eine Issue-Menge, die es so nicht mehr
gibt. Fertig seitdem — Issues zu, nachgesehen bzw. nicht mehr in der offenen Liste:

| Bündel | Issues | Geliefert durch |
|---|---|---|
| **J** (Vertragstest-Ernte) | #554 · #564–#568 | PR #572/#573, #564 per #575 (2026-09-05/06) |
| **K** (Verlorene Aufnahmen) | #557 · #560 · #561 | PR #577/#578/#580 (2026-09-06) |
| **L** (Renovate-/Reviewketten-Werkzeug) | #555 · #556 · #539 · #593 | PR #598/#596 (2026-09-08/09); #555/#556/#593 von Hand geschlossen |
| **Flaky-CI** (nicht im 09-05-Plan) | #569 · #558 · #597 · #576 | PR #599 (2026-09-09); #576 extern geschlossen |
| **C1** | #530 (b) · #541 | PR #601/#600 (2026-09-09) |

Dazu **drei Issues, die in keinem Plan stehen** — alle nach dem 05.09. entstanden:
betroffen sind #591, #574 und #604. Dieser Plan ordnet sie ein und benennt,
welches Bündel als nächstes läuft.

**Zensus, gemessen am 2026-09-10:** `gh issue list --state open --limit 200` →
**25** (24 echte + #45, das Renovate-Dashboard, das kein Issue ist).
**0 offene PRs.** Die Zahlen im Kopf sind der Stand ihrer Zeile — wer daraus etwas
ableitet, zählt vorher nach.

## Das Kriterium (unverändert)

Gebündelt wird nach **geteilten Prüfkosten**, nicht nach Themenähnlichkeit
(`aehnlichkeit-ist-keine-kopplung`). Teure Posten: Browser-Sitzung · gepackter
Electron-Lauf · CodeRabbit-Kontingent (je Commit, repo-weit) · Mac-Hardware ·
Messstand (Wegwerf-Projekt + uvicorn + echter Job) · Marcus' Entscheidungen.

## Bestandsaufnahme — alle 25, jede Nummer eine Primär-Disposition

| Paket | Issues | Zustand / geteilter Kostenposten |
|---|---|---|
| **M (NEU)** | #591 + #574 | Verfolgung II: `jobPhases`-Cluster + eine Verfolgungs-Messung. **Nächstes, heute fahrbar.** |
| **C2** | #530(c) → #519 → #520 | gepackter Electron-Lauf (`electron/main.js`, `bericht.js`). **Blockiert auf Marcus' Bau-Secret-Entscheidung.** |
| **D** | #423 → #515 | Browser-Sitzung + `design-beweis`. Bedingung vor dem Bau klären. |
| **E (Mac)** | #36 · #504 · #512 (Querverweis #530, zählt bei C2: gepackter Bugsink-Lauf auf macOS) | Mac-Hardware; ein M1-Durchgang bewegt 4 Punkte. **Blockiert auf Marcus.** |
| **F** | #210 + #237 | `sperre.py`-Reviewdurchgang + Lock-Konkurrenz-Prüfstand. Später. |
| **G** | #136 → #137, #164 blockiert | **Kette, kein Bündel** — teilen keinen Kostenposten. |
| **H** | #274 + #276 | **Blockiert** auf den Referenzsatz aus Task 8 (Marcus). |
| **Einzel** | #604 · #509 · #346 · #553 · #288 · #95 · #469 · #45 | Dispositionen unten. |

Handzählung: M 2 + C2 3 + D 2 + E 3 + F 2 + G 3 + H 2 + Einzel 8 = **25**.
(#530 hat seine Primär-Disposition bei C2; der macOS-Beleg-Anteil in E ist ein
Querverweis, kein zweiter Zählpunkt — dieselbe Konvention wie im 09-05-Plan.)

---

## M — Verfolgung II (#591 + #574) ▶ NÄCHSTES

- **#591** — `[scope+]`-Reannoncement lässt „durch" über eine Nur-Audio-Aufnahme
  wieder auf: `useActiveJob.tsx` (`mergePhases`), `jobs.py` (`[scope+]`-Zweig
  discardt `entfernt`, lässt `gesehen` stehen), `jobPhases.ts` (`schonDurch`).
  Bot-Befund major, ausdrücklich **hergeleitet und nie ausgeführt** — die
  Reproduktion am Messstand gehört an den Anfang des Bündels.
- **#574** — `ohneKommentare` in `jobPhases.vertrag.test.ts` kennt keine
  Regex-Literale: ein `/…/` mit Anführungszeichen öffnet den Zeichenketten-Modus,
  und die Ernte kann echten Code als Zeichenkette **verstecken** — die Wache kann
  über Fixtures Erfolg melden, ohne sie angesehen zu haben. 17 Regex-Literale mit
  Anführungszeichen in drei der sechs geernteten Dateien (Zensus im Issue).

**Warum zusammen:** derselbe Datei-Cluster (`jobPhases.ts`,
`jobPhases.vertrag.test.ts`, `useActiveJob.tsx`), dieselbe vitest-Suite — und #574
ist ein **Loch in genau dem Wächter, der über #591s Fix-Fläche wacht**. Das ist das
J-vor-K-Argument in kleiner Form: erst dem Wächter die Blindecke nehmen, dann die
Verfolgungslogik ändern. #591s Beweis braucht den Messstand (Wegwerf-Projekt,
echter Lauf, zweites Fenster); #574s Beweis ist ein vitest-Fixture-Test und fährt
auf demselben Aufbau mit.

**Ehrlich benannt (K-Lehre):** die Kopplung ist über Dateiverweise aus den
Issue-Texten belegt, der gemeinsame Mechanismus ist eine Lesart — am Bündelanfang
prüfen, nicht voraussetzen.

**Prüfkosten:** ein Messstand-Aufbau, ein `vitest run`, eine Reviewkette.
Kein Mac, kein Bau-Secret, keine offene Frage an Marcus.

*Namenshinweis: „M" wurde am 08.09. sessionsintern schon einmal für #581/#579
benutzt (beide erledigt, kein Plan-Dokument) — das hier ist ein anderes Bündel.*

---

## Unverändert aus den Vorgängerplänen (nur entstaubt)

- **C2** — die Reihenfolge ist eine Abhängigkeit, keine Vorliebe: #530 (c) baut den
  Bericht mit Vorschau und **entscheidet, ob #519 überhaupt noch ein eigenes Issue
  ist** (#519 zuerst gebaut wäre ein Weg, den #530c danach ersetzt). #520
  (Abweisungs-Deckel, anderer Mechanismus in derselben `main.js`) ist notfalls
  abspaltbar, falls die Bau-Secret-Entscheidung länger dauert.
- **D** — Bedingung vor dem Bau klären: #423 muss als Ergebnis einen
  Playwright-getriebenen Messlauf gegen das gebaute Bundle hinterlassen, sonst
  gewinnt #515 nichts und beide sind Einzelgänger. Das Werkzeug für #515s Messung
  existiert (Skill `design-beweis`).
- **E** — **geschrumpft, zwei Altbehauptungen widerlegt:** #536 ist zu
  (Mindest-macOS-Version, gemessen `gh issue view 536`), und der Linux-Icon-Rest
  liegt per `078a64b` auf master (`git merge-base --is-ancestor`, gemessen) — die
  „Lücke ohne Issue" des 09-03-Plans ist tot. Übrig: **#36** (zwingend `.dmg` per
  Finder; der Linux-Teil bleibt ohne VM offen, Entscheidung Marcus 2026-08-22),
  **#504** (fällt aus dem #36-Lauf gratis mit ab), **#512** (C0709, nicht C0761 —
  die Datei ist im Issue als ungeeignet benannt), **#530-Anteil** (gepackter
  Bugsink-Lauf auf macOS belegen).
- **F** — #210 bauen (der fadenfreie Weg macht die Fristschätzung überflüssig),
  #237 zuerst **messen**, nicht bauen — die Messung darf mit „nein" enden.
- **G** — #136 ist die Messung (nicht-deutsches Audio liegt vor, bestätigt
  2026-08-22) und entscheidet, ob #137 das richtige Problem löst; #164 hängt am
  Datenproblem (`faster_whisper.Segment` hat kein `language`).
- **H** — blockiert auf den Task-8-Referenzsatz; #276 ist seit dem 22.08. keine
  Entscheidung mehr (CC-BY-NC akzeptabel), sondern Messaufgabe.

---

## Einzelgänger, mit Disposition

| Issue | Disposition |
|---|---|
| **#604** | CodeRabbit-CI rot aus CLI-Zustand am wiederverwendeten Renovate-Branch. Trägt eine eigene kleine Entscheidung im Issue. **Mitfahrer T-015** (Aufgabenindex): dieselbe Gelegenheit — der nächste Renovate-PR belegt beide. |
| **#509** | `.weg`-Karenz im Mischbetrieb. **Vermutlich per Beleg schließbar:** das Fenster endet, wenn kein Erzeuger des alten Formats mehr läuft — seit PR #508 sind mehrere Releases raus. Erst Marcus' Installationslage klären, dann Fix oder Beleg-Schluss. |
| **#346** | BatchedInferencePipeline-Messung. GPU, ruhiges Fenster, auf diesem Rechner fahrbar; zwei Fallstricke stehen im Issue. |
| **#553** | jest-dom unter vitest 5. 0 betroffene Stellen, fällt laut auf (tsc). Bewusst auf jest-dom-Upstream warten; eigene `.d.ts` nur bei Bedarf. |
| **#288** | torch-CVE, bewusst getragen. Nichts zu tun; quartalsweise nachsehen. Schliesst sich selbst, sobald der cu128-Index eine Fixfassung führt. |
| **#95** | Certum-Signierung. Blockiert auf Beschaffung + eine Frage an Certum (SimplySign in GitHub Actions?). Braucht einen Besitzer. |
| **#469** | 61 Zeilenverweise → Symbole, Konfliktfläche über ~15 Dateien. **GANZ zuletzt, allein**, im Fenster ohne offene PRs. |
| **#45** | Renovate-Dashboard, kein Issue. |

---

## Reihenfolge

```text
M  (#591 + #574)                          ← NÄCHSTES: heute fahrbar, keine Entscheidung nötig
D  (#423 → #515)                          ← danach; beginnt mit der Bedingungs-Entscheidung
C2 (#530c → #519 → #520)                  ← sobald Marcus das Bau-Secret entscheidet (#520 notfalls vorziehen)
E  (Mac: #36 #504 #512 + 530-Beleg)       ← jederzeit, wenn Marcus am M1 ist — grösster Hebel je Sitzung
F  · G (Kette) · H (blockiert)            ← später bzw. blockiert
Einzel: #604 (nächster Renovate-PR) · #509 · #346 (ruhiges Fenster) · #553 · #288 · #95
#469                                      ← GANZ zuletzt, allein
```

**Nicht parallel:** nichts aktuell Offenes teilt Dateien mit M; C2 braucht die
gepackte Bau-Serie exklusiv; #469 gegen alles. Der CodeRabbit-Slot ist repo-weit —
zwei gleichzeitige PRs kosten einander Reviews.

## Was ausdrücklich NICHT gebündelt wird

- **#604 zu M** — verschiedene Stacks (CI-yaml/Riegel-Skript vs. Frontend-Hooks),
  kein geteilter Posten.
- **#509 zu irgendwas** — eigener PR (Entscheidung aus dem 09-03-Plan); teilt die
  Datei, nicht den Mechanismus.
- **#553 zu D** — Typ-Infrastruktur statt Verhalten; geteilt wäre nur ein
  tsc-Lauf, und das ist kein Bündelposten (war schon im 09-05-Plan der schwächste
  Mitfahrer und ist dort abgespalten worden).

## Verifikation dieses Plans

**Gemessen — Kommando → Ergebnis, alle am 2026-09-10 gefahren:**
- `gh issue list --state open --limit 200 --json number --jq length` → **25**
  (`--limit` ist Pflicht: ohne ihn deckelt `gh` bei 30) · `gh pr list --state
  open` → leere Liste (0 offene PRs).
- `gh issue view <n> --json state` für #541, #539, #536 → je CLOSED ·
  `git merge-base --is-ancestor 078a64b master` → rc 0 (der Linux-Icon-Fix liegt
  auf master).
- J geliefert durch #572/#573, **#564 durch #575** — Timeline je Issue: #554 und
  #565–#568 je 1 s nach Merge #573, #564 1 s nach Merge #575 (Schliessdaten
  09-05/09-06).
- K geliefert durch #577/#578/#580 (`gh pr view`, MERGED 2026-09-06, je Titel
  nennt #560/#557/#561); Flaky/C1 analog (#599, #600/#601). **L ehrlich:** #539
  durch #598 (Titel nennt es); #596 trägt KEINE Issue-Nummer im Titel, und
  #555/#556/#593 wurden am 09-09 **von Hand** geschlossen — zu ihren
  Schliesszeitpunkten gab es keinen Merge.
- Issue-Bodies von allen hier neugebündelten oder neu disponierten Issues gelesen
  (#530, #519, #520, #515, #423, #509, #591, #574, #553, #604, #36, #504, #512).

**Hergeleitet, hier NICHT nachgemessen — am Bündelanfang nachholen:**
- Ms gemeinsamer Mechanismus (oben als Lesart benannt).
- #591s Fall ist nie ausgeführt worden (steht so im Issue) — Reproduktion zuerst.
- C2s Bau-Secret-Bedarf stammt aus dem Sitzungs-Merker (09-09), nicht aus dem
  Issue-Text nachgelesen — am C2-Anfang verifizieren.
