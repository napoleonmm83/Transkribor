## Arbeitsweise in diesem Repo: nie auf master, nie uncommittet liegen lassen

Hier arbeiten Codex und Claude Code parallel im selben Repo. Deshalb gilt:

1. **Arbeite nie direkt auf `master` im Haupt-Checkout `E:\Git\Transkribor`.**
   Lege zu Beginn jeder Aufgabe einen eigenen Branch in einem eigenen Arbeitsbaum an:
   `git -C E:\Git\Transkribor worktree add .worktrees/<aufgabe> -b <typ>/<aufgabe> origin/master`
   und arbeite nur dort.
2. **Beende jede Aufgabe mit einem Commit auf diesem Branch**, auch wenn sie noch
   nicht fertig ist (dann als WIP-Commit). Geprüfte, aber uncommittete Änderungen
   sind für die andere Seite unsichtbar und gehen beim nächsten Aufräumen verloren.
3. **Fertige beauftragte Arbeit nach der Review-Kette pushen und als PR anlegen.**
   Dauerhafte Nutzerfreigabe vom 2026-10-13. Codex führt dafür
   `.agents/skills/pr-review/SKILL.md` selbst aus. „Nur lokal“/„nicht pushen“
   hat Vorrang; WIP bleibt lokal. Merge und Release sind eigene Aufträge.
4. **Wegwerfordner** gehören nach `.tmp-<name>/` in den Repo-Stamm; die `.gitignore`
   schliesst sie aus. Sie sind nie ein Ablageort für Arbeit, die bleiben soll.

Warum (2026-10-01): Drei fertig geprüfte Codex-Aufgaben (T-006, T-031, T-032) lagen
uncommittet auf einem `master`, der 25 Commits hinter origin stand. Sie mussten von
Hand gesichert, gegen origin abgeglichen und nachträglich als PR #660 eingebracht
werden.

## Codex-PR-Review

Der versionierte Projektskill [pr-review](.agents/skills/pr-review/SKILL.md)
übernimmt die Review-Kette aus `CLAUDE.md` mit nativen Codex-Subagenten.
Er ist bei Fixes, Features und Änderungen an den Arbeitsanweisungen Pflicht.
Bei reinen Fragen oder einem ausdrücklich nur lesenden Auftrag entsteht kein PR.
Die frühere zusätzliche Plugin-Stufe `codex review` bleibt ausgeschlossen.
`CLAUDE.md` bleibt lokal; der Codex-Ablauf ist im Skill vollständig beschrieben.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph can provide structural context (callers, dependents,
and test coverage) and may reduce the need for file scanning.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
