---
name: pr-review
description: Führt die Transkribor-PR-Review-Kette mit Codex aus. Nach beauftragten Fixes, Features oder Änderungen an Arbeitsanweisungen vor Abschluss anwenden; auch für ausdrücklich beauftragte PR-Prüfungen. Veröffentlichung nur mit Push-/PR-Auftrag, reine Fragen oder nur lesende Aufträge veröffentlichen nichts.
---

# Transkribor: PR-Review mit Codex

Übernommen am 2026-10-13 aus der Review-Kette im lokalen `CLAUDE.md`. Dieser
Skill braucht weder Claude Code noch dessen Plugins. Die frühere zusätzliche
Codex-Plugin-Stufe und `codex review` bleiben ausgeschlossen; keine Aussage
über neu gemessenen Ertrag dieser alten Stufe.

## Freigabe und Vorbereitung

Die Freigabegrenze aus `AGENTS.md` bleibt erhalten: **Push und PR nur auf
ausdrücklichen Auftrag.** Ohne diesen endet die Aufgabe nach Commit und lokalen
Reviews. „Nur lokal“/„nicht pushen“ hat Vorrang. Merge, Release, fremde alte
Branches und Kundendaten sind nicht Teil eines Review- oder PR-Auftrags.
Die Review-Kette selbst läuft ohne erneute Rückfrage; vorhandene ausdrückliche
Freigaben werden nicht erneut abgefragt.

Arbeite im eigenen Branch/Worktree. Git immer mit `git -C <absoluter Pfad>`.
Ermittle Repo/Remote und Zielbranch aus dem Auftrag; normale Basis hier:
`origin/master`. Aktualisiere die Ref und halte Merge-Basis `BASE` sowie volle
Commit-ID `HEAD` im Reviewbericht fest. Ein sauberer Commit ist die Review-
Einheit. Kein Wechsel auf master, kein fremder WIP im staging. Review-Artefakte
im Hauptbaum unter `.code-guardian-evidence/<trace-id>/`, Wegwerfdateien unter
`.tmp-<name>/`. Die lokal ignorierte `AGENTS.md` wird im Repo versioniert;
beim staging dieser Datei ggf. `git add -f -- AGENTS.md`, keine Ignore-Regel ändern.

Fix lokal auf synthetischen Daten ausführen: Frontend im echten Browser,
Backend über den tatsächlichen Pfad, betroffene Electron-Paketpfade gepackt.
Passende Tests und Statik ausführen. Produktlogik bekommt eine Gegenprobe:
Fix entfernt -> genau der relevante Test rot. Mutationsplan committen unter
`scripts/mutationen/<thema>.json` mit `test,pfade,env,mutationen`; je Mutation
`id,datei,von,nach,rot`. `scripts/mutation.py` und
`scripts/test_mutationsplaene.py` wiederverwenden; Läufer nur pytest,
`vitest run` oder `playwright test`. Reine Anweisungstexte durch tatsächliche
Skill-Anwendung prüfen, keine künstlichen Wortlauttests schreiben.
Mutationen nur im eigenen sauberen Baum; Rücknahme bytegenau, keine fremden
Änderungen mit git checkout überschreiben. Mess-/Reviewagenten rein lesend.

Nutzersichtbare Produktänderungen: README und eine Zeile unter Unveröffentlicht
in `RELEASE-NOTIZEN.md` im selben PR nachziehen. Nur in CI prüfbare Wirkungen
bis zum Laufbeleg „hergeleitet, nicht gemessen“ nennen. Interne Anweisungs-/
Teständerungen brauchen keine Produkt-Release-Notiz.

## 1. Zwei native Reviews parallel

Lies [references/reviewers.md](references/reviewers.md). Starte Kontextreview
(default-Agent) und kalten `cg-diff-reviewer` im selben Zug, unterschiedliche
`task_name`, beide `fork_turns: "none"`, identischer Bereich `BASE..HEAD`.
Kein `/code-review`, kein Claude-Plugin und kein zusätzlicher CLI-Nachbau.

Berichte kommen vollständig als Text zurück. Der Orchestrator speichert beide
vor Abschluss; read-only-Prüfer müssen keine Datei schreiben. Idle/Timeout ohne
Ergebnis ist keine Prüfung. Fehlende Lesestrecken gezielt nachholen. Befunde
gegen Ausführungsbelege prüfen, Defekte beheben, betroffene Tests erneut fahren.
Ein neuer Commit erfordert beide Reviews gegen den neuen HEAD; alte Urteile
gelten nur für ihren besiegelten Stand. Guardian-Audits bleiben erforderlich.

## 2. CodeRabbit lokal, vor dem PR

Die vorhandene WSL-CLI läuft nicht im Windows-Worktree. Erzeuge mit Windows-Git
einen unabhängigen Clone unter `.tmp-pr-review-<name>/`:
`git -C <worktree> clone --no-hardlinks --no-checkout <worktree> <clone>`.
Kein `--shared`: Windows-Alternates sind für WSL ungeeignet. Checke im Clone den
geprüften HEAD auf einem eigenen Reviewbranch aus. Prüfe dort HEAD und BASE.
Nur getrackte Dateien kopieren: keine Kundendaten, Secrets, vollständigen
`.claude`-Verzeichnisse oder lokale `CLAUDE.md` in den Clone übernehmen.

Clone-Pfad mit `wslpath -u` in WSL übersetzen. `AGENTS.md` und Skill sind die
vollständige getrackte Review-Anweisung. Im Clone ausführen:

```sh
coderabbit review --agent --committed --base-commit "$BASE" \
  -c AGENTS.md .agents/skills/pr-review/SKILL.md
```

Über `wsl -d Ubuntu-22.04 -- bash -lc` starten, volle Ausgabe und Exitcode
sichern. Aufrufe mit Pfaden/Quoting zuerst als Skriptdatei schreiben. Vorhandene
Anmeldung verwenden; Schlüssel nie ausgeben oder committen. Kein
`--use-credits` ohne eigene Freigabe. Kontingent repo-weit: laufende Reviews
anderer Sessions berücksichtigen und keinen Limit-Retryloop starten.

Nicht allein rc0 glauben: Strukturierte Ausgabe muss einen tatsächlich
abgeschlossenen Review des gewünschten Diffs mit geprüften Dateien ausweisen.
`review_skipped`, Limit, Auth-/Werkzeugausfall oder fehlende Dateiabdeckung sind
fehlende Prüfungen. Befunde beheben; neuer HEAD erfordert lokale Reviews erneut.
Limits ohne Warten als übersprungen dokumentieren. Bei bestehendem PR-Auftrag
darf danach ein PR zur transparenten Übergabe entstehen, mit der fehlenden
Prüfung ausdrücklich im PR-Text. Bekannte kritische Defekte vorher beheben.

## 3. Bei PR-Auftrag: Push, PR und CI/Reviews

Ohne ausdrücklichen Push-/PR-Auftrag hier stoppen, lokale Ergebnisse berichten.
GitHub-Befehle im ursprünglichen Worktree ausführen, **nicht im Reviewclone**:
dessen origin zeigt auf ein lokales Repo. Vor Push HEAD/Branch gegen Berichte
prüfen. Nur eigenen Branch ohne force pushen. Prüfe, ob ein offener PR für
diesen Branch existiert: dann diesen aktualisieren. Ausschließlich wenn
keiner existiert, neu anlegen:
`gh pr create --base master --head <branch> --title <titel> --body-file <datei>`.
Der PR-Text beschreibt Problem, neue Wirkung, Tests, Commit-IDs und jede fehlende
Prüfung. Kein automatischer Merge. WIP bleibt lokal, außer ausdrücklich ein
Draft beauftragt ist. Bei anderem autorisierten Zielbranch --base anpassen.

CI dem PR-HEAD zuordnen (`gh pr view`, `gh run list`, `gh pr checks`). Ein einzelner
`gh pr checks <nr> --watch` darf warten; weiter Fortschritt melden. Während langer
laufender CI nicht nachpushen, sonst cancelt `test.yml` den Lauf. Die vorhandene
`.github/workflows/coderabbit.yml` bleibt der fremde Blick. Grüne CodeRabbit-
Checks können Limit/Skip bedeuten: vollständigen Bericht lesen, nicht nur Farbe.

Drei Kanäle vollständig lesen: PR-Kommentare samt Failed-checks-Tabelle,
`gh api --paginate repos/<owner>/<repo>/pulls/<nr>/reviews` und
`gh api --paginate repos/<owner>/<repo>/pulls/<nr>/comments`.
`python scripts/coderabbit_status.py <nr> --json` deckt Kommentare/Inline-Befunde
ab; Review-API separat lesen. Leere Reviewlisten erst nach Positivkontrolle
gegen einen bekannten Review-PR als belastbar werten. Widerlegte Inline-Befunde
mit Beleg am Kommentar beantworten (`gh api .../comments/<id>/replies
-F body=@<datei>`). Vorhandene Werkzeuge/CI nicht neu implementieren.

Übrig gebliebene Befunde/ausgefallene Prüfungen schriftlich festhalten. Bei
beauftragtem Folge-Issue erst Duplikate suchen; Fundstelle, Wirkung, Entdeckung
und prüfbares `Fertig-wenn:` nennen. Aktuelle CI-/Reviewresultate samt HEAD und
Lauf-ID nachtragen. Übersprungen ist nie bestanden. Gestapelte PRs vor Merge
des unteren umhängen; dieser Skill führt keinen Merge aus. Abschluss: Commit,
gegebenenfalls PR-Link, tatsächliche Prüfungen und offene Grenzen.
