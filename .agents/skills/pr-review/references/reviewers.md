# Briefings für die zwei parallelen Reviewer

Platzhalter durch ermittelte Pfade/vollständige Commit-IDs ersetzen.
Unterschiedliche task_name, beide fork_turns none. Keine Schreib-/Commit-/Push-
oder GitHub-Rechte delegieren; kein Modell aus Claude-Routing erzwingen.
Graph vor Quelltextsuche, dann nötige ganze Funktionen und Aufrufer lesen.

## A — Kontextreview, default-Agent

Dieser Arm erhält Auftrag, BASE, HEAD, Worktree, betroffene Dateien, relevante
Geschäftsregel und tatsächlichen Testnachweis. Bereits behobene und bewusst
nicht behobene Befunde nennen, ohne Sauberkeitsurteil vorzugeben. Briefing:

```text
Lies BASE..HEAD adversarial. Prüfe geänderte Funktionen und Aufrufer: Was
erlaubt der Fix NEU? Erst Verhalten prüfen, nicht Autor-Zusicherungen glauben.
Du bist rein lesend. Für jede Änderung: wann läuft sie jetzt, wann vorher,
welcher neue Ablauf ist möglich? Belege Probleme durch Ereignisreihenfolge
und Ausführung. Betroffene Dimensionen prüfen: Nebenläufigkeit, Identität
aufgeschobener Vorgänge, falsche Erfolgsmeldungen, Wiederanlegen gelöschter
Dateien, human_edited, Promptkonsistenz, Job-scope und Messaussagen.
Vollständiger Bericht: BASE/HEAD, gelesene Strecken, Datei/Stelle, Wirkung,
CONFIRMED oder SUSPECTED, Kommando-/Ausgabebeleg. Keine erfundenen Defekte.
Nicht ausgeführte/ungelesene Strecken nennen. Frist/Limit -> Teilbericht.
```

## B — kalter Review, cg-diff-reviewer

Dieser Arm erhält nur den vollständigen Diff und Trace-ID, dazu Zugriff auf
den read-only-Worktree für Gegenproben. BASE/HEAD besiegeln die Diff-Identität.
Kein Auftrag, Plan, Testergebnis, Kontextreview-Bericht oder Autorenurteil.

```text
Prüfe diesen Diff kalt auf Defekte. Lies nötigen Quellkontext und führe
gezielte Gegenproben aus, ohne etwas zu schreiben. Je Befund: Schwere,
Datei/Stelle, Code, Failure, Fix, ausgeführter Kommando-/Ausgabebeleg;
CONFIRMED und SUSPECTED unterscheiden. Verbleibende Fragen und ungelesene
Diffstrecken nennen. Keine Befunde ist zulässig. Vollständiger Textbericht
mit REVIEW-Schlusszeile an den Elternagenten zurückgeben.
```

## Berichte sichern

Beide Rückgaben unverändert getrennt im Aufgabenordner ablegen, etwa
`review-kontext-<head>.md`/`review-kalt-<head>.md`; Orchestrator schreibt sie.
Befunde gegen den Nachweis prüfen, Einordnung separat festhalten. Teilberichte
bekommen keinen CLEAN-Stempel. Fehlende Strecken nachbeauftragen; geänderter
HEAD entwertet das alte Urteil. Native Rückgaben ersetzen Claudes
SendMessage-/Transcript-Konvention und `superpowers:requesting-code-review`.
