# Routing in diesem Repo — was hier liegt und was woanders

Die Modell- und Skill-Routing-Tafel selbst lebt in einem eigenen Repo:
**[napoleonmm83/claude-routing](https://github.com/napoleonmm83/claude-routing)** (privat).
Dort stehen die globale Tafel, sechs Agentendefinitionen, der `UserPromptSubmit`-Hook, der
Drift-Lint, sowie Spec und Plan mit allen Messungen.

Hier liegt nur, was **in Transkribor** wirkt.

## Die `gh pr create`-Sperre

`routing-sperre.sh` hält `gh pr create` an, wenn auf dem Branch kein `review-*.md` neuer ist als
der Abzweigpunkt von master. Damit erzwingt sie **Stufe 1** der Reviewkette aus `CLAUDE.md`
(„`superpowers:requesting-code-review` ZUERST, dann CodeRabbit") — CodeRabbit braucht den PR und
ist an dieser Stelle nicht prüfbar.

Fünf Dinge, die man nicht aus dem Skript liest:

- **Sie hängt an ZWEI Werkzeugen**, `Bash` und `PowerShell`. Das war lange nicht so, und der Fehler
  war teuer: ein Zensus über alle Sitzungstranskripte ergab **23 von 187** echten `gh pr create`
  über PowerShell — 12 %, und PowerShell ist auf diesem Rechner die *primäre* Shell. Wer den Hook
  verdrahtet, verdrahtet beide.
- **Der Fluchtweg hat zwei Formen**, weil die Shells sich unterscheiden:
  `KEIN_REVIEW=1 gh pr create …` (Bash) und `$env:KEIN_REVIEW=1; gh pr create …` (PowerShell).
  Beide sind **eng an das Vorkommen gebunden** — steht etwas dazwischen, sperrt sie. Ein
  Fluchtweg, der irgendwo im Text stehen darf, ist kein Fluchtweg, sondern ein Loch; das hat eine
  eigene Fix-Runde gekostet.
- **Sie prüft Roh-JSON mit `grep`, nie mit einem Interpreter.** Nicht weil ein Interpreter fehlte
  — sondern weil ein Wächter, der von einem Interpreter im PATH abhängt, **still** ausfällt,
  sobald sich der PATH ändert. Genau das ist hier belegt passiert (siehe #324).
- **Bewusst offen:** `bash -c "gh pr create"`, `sh -c`, voller Pfad. Die Ankerklasse dafür zu
  erweitern kostet Fehlalarme, und ein Wächter mit Fehlalarmen wird abgeschaltet. Sie ist gegen
  **Vergessen** gebaut, nicht gegen Absicht — wer sie umgehen will, hat den Fluchtweg.
- **Bewusst in Kauf genommen:** eine Zeile, die mit `gh pr create` beginnt (Heredoc, mehrzeilige
  Commit-Message), wird gesperrt. Das ist der Preis dafür, dass mehrzeilige Befehle überhaupt
  erkannt werden — und die sind beim PR-Weg die Normalform, nicht die Ausnahme.

## Die zwei projektlokalen Agenten

`mutationsprobe` und `was-erlaubt-der-fix-neu` liegen in `.claude/agents/` und gehören zu den
Prüfregeln dieses Repos. Die globale Tafel nennt sie zwar, findet sie aber nur hier — siehe
[claude-routing#3](https://github.com/napoleonmm83/claude-routing/issues/3).

## Das Overlay

`routing-overlay.md` ist der Spiegel von `.claude/routing.md`: es ergänzt die globale Tafel um
Transkribors Kette (Reviewreihenfolge, Mutationsprobe, `befund`, `release`, Browser-Beleg) und
**schlägt** sie bei gleichem Aufgabentyp.

## Warum das hier nur Spiegel sind

`.claude/` ist in diesem Repo absichtlich untracked (`kein-pauschales-add.sh` nennt den Grund),
und das Remote ist öffentlich. Die produktiven Dateien liegen unter `.claude/hooks/` bzw.
`.claude/agents/`; was hier steht, ist die versionierte Kopie. **Wer eine Originaldatei ändert,
zieht den Spiegel nach** — es gibt keinen Automatismus dafür.
