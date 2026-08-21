# Routing — welches Modell, welcher Skill

Diese Datei ist DIE Quelle. Der `UserPromptSubmit`-Hook spielt nur eine Kurzfassung ein;
alles Weitere steht hier. Das Projekt-Overlay (`$CLAUDE_PROJECT_DIR/.claude/routing.md`)
**schlägt diese Datei** bei gleichem Aufgabentyp.

Der Haupt-Loop kann sein eigenes Modell nicht wechseln. Passt es nicht zur Aufgabe, wird das
EINMAL gesagt („diese Arbeit ist mechanisch — `/model sonnet` wäre richtig") und dann
weitergearbeitet; die Entscheidung liegt beim Menschen.

## Die Routing-Tafel

| Aufgabentyp | Wer | Modell · Effort | Pflicht-Skill |
|---|---|---|---|
| Orchestrieren, planen, entwerfen | Haupt-Loop | (Sitzung) · xhigh | `superpowers:brainstorming` → `writing-plans` |
| Code mit Gesprächskontext | Haupt-Loop | (Sitzung) · xhigh | `superpowers:test-driven-development` |
| Abgegrenzte Umsetzung nach Spec | `umsetzer` | **sonnet** · high | — |
| Gegnerischer Review | `pruefer-gegnerisch` | **fable** · high | `superpowers:requesting-code-review` |
| „Was erlaubt der Fix NEU?" | `was-erlaubt-der-fix-neu` | **opus** · high | — |
| Faktenprüfung (Behauptung ↔ Code) | `faktenpruefer` | **fable** · high | — |
| Mutationsprobe | `mutationsprobe` | **opus · low** | — |
| Diagnose / Fehlersuche | Haupt-Loop | (Sitzung) · xhigh | `superpowers:systematic-debugging` |
| Suchen / „wo steht X" | `leichtgewicht` | **haiku** · — (siehe unten) | — |
| Testläufe, Formatieren, Mechanik | `leichtgewicht` | **haiku** · — (siehe unten) | — |
| Browser-Beleg | `browser-beleg` | **sonnet** · medium | — (siehe unten) |
| README / Doku im Hausstil | `doku` | **sonnet** · high | — |
| Bibliotheks-/API-Frage | Haupt-Loop | — | `find-docs` bzw. `ctx7` |
| Modell-/LLM-Frage | Haupt-Loop | — | `claude-api` |
| Fertig melden | Haupt-Loop | — | `superpowers:verification-before-completion` |

**`leichtgewicht` kennt kein `effort:`.** Haiku 4.5 wirft dabei nicht, es ignoriert das Feld
still (gemessen 2026-08-21: im Transkript fehlt `effort` ganz statt auf einem Wert zu stehen).
Die Zeile steuert also nur das Modell, nicht das Nachdenk-Budget — wer hier „low" liest,
verspricht mehr, als die Plattform hält. Deshalb steht in seinen beiden Zeilen oben **kein
Effort**, sondern ein Strich: der Satz stand hier, während die Tabelle drei Zeilen darüber
weiter „haiku · low" behauptete (Abschlussreview 2026-08-21).

**Browser-Beleg hat keinen Pflicht-Skill, und das ist kein Versehen.** Hier stand `playwright`
— das ist **kein Skill**, sondern ein MCP-Server (Plugin `playwright`, Werkzeuge
`mcp__plugin_playwright_playwright__browser_*`; im Plugin-Cache gemessen: kein `SKILL.md`,
kein `skills/`-Verzeichnis). Der Drift-Wächter bestätigte den Eintrag trotzdem, weil unter
`~/.claude/skills/gstack/node_modules/playwright` ein gleichnamiges npm-Paket liegt — eine
Bestätigung aus dem Nichts. Die Werkzeuge stehen jetzt dort, wo sie wirken: in der
`tools:`-Zeile von `browser-beleg.md`. Derselbe Kategorienfehler wie bei der `ctx7`-CLI.

### Die drei begründungspflichtigen Zeilen

**Fable 5 nur zweimal** — gegnerischer Review und Faktenprüfung. Beide sind gemessen die
ertragreichsten Stufen: PR #183 (fünf Befunde, die Bot, CLI und `/code-review` alle übersahen)
und die Fehlerklasse „Behauptung schärfer als der Code", die in `MEMORY.md` als *die häufigste
dieses Repos* geführt wird. Doppelter Opus-Preis dort, wo ein übersehener Befund am teuersten
ist; überall sonst wäre Fable Verschwendung.

**Mutationsprobe auf `opus · low`, nicht Sonnet.** Der Agent editiert echten Quelltext
(`mutationsprobe-kann-code-beschaedigen` hält fest, dass das schon passiert ist). Die Arbeit ist
kurz — die Ersparnis durch ein schwächeres Modell wäre klein, der Schaden einer kaputten
Rückspielung real. Fähigkeit behalten, am Effort sparen.

**Haiku nur für Suche und Mechanik**, mit benannter Decke: 200K Kontext.

### Grosse Arbeiten: `ultracode`, nicht ein Eigenbau

`ultracode` ist zweierlei (Changelog): das **Auslöser-Wort** für dynamische Multi-Agenten-Läufe
(umbenannt von `workflow`, Changelog-Zeile 1578) und eine **Effort-Stufe** (`/effort ultracode`,
Zeilen 748/1569) oberhalb `xhigh`.

Es löst Orchestrierung, aber **nicht** Routing: die Werkzeugbeschreibung sagt zu `opts.model`
ausdrücklich *„Default to omitting it — the agent inherits the main-loop model"* und
*„token cost is not a constraint"* — das Gegenteil einer Tafel, und frontal gegen Ziel 2.

**Entscheidung:** `effortLevel` bleibt `xhigh`; `ultracode` auf Zuruf bei PR-grossen Arbeiten.
Die Tafel liefert dann, was ultracode nicht mitbringt — die Phasen-Modelle, die **nicht**
weggelassen werden dürfen (der Default wäre „erben"). Ein eigener Workflow-Orchestrator entfällt
damit ersatzlos: er wäre ein Nachbau von etwas, das die Plattform liefert.

## Zwei Regeln zum Dispatch

**Beim Dispatch eines Routing-Agenten wird KEIN `model`-Parameter mitgegeben.** Die
Vorrangregel lautet (dokumentiert): `CLAUDE_CODE_SUBAGENT_MODEL` → **Aufruf-Parameter** →
Frontmatter → Sitzungsmodell. Der Parameter schlägt die Datei — wer beim Aufruf ein Modell
mitgibt, überschreibt genau die Quelle, die diese Tafel autoritativ machen soll. Ausnahme:
`general-purpose` hat kein Frontmatter-Modell, dort ist der Parameter der einzige Weg.

**Für `effort` gibt es keine Aufruf-Stufe.** Weder ein Parameter am `Agent`-Werkzeug noch ein
Env-Pendant zu `CLAUDE_CODE_SUBAGENT_MODEL` existiert dafür. Nur Frontmatter oder
Sitzungserbe — das Effort-Routing steht und fällt mit der Agentendatei.

**Fehlte `~/.claude/agents/` beim Sitzungsstart, gilt eine dort neu angelegte Datei in dieser
Sitzung NICHT** — und der Dispatch scheitert dabei nicht sichtbar, er ersetzt still: der
`subagent_type` löst unter seinem Namen auf, läuft aber auf dem Sitzungsmodell mit
Sitzungs-Effort. Abhilfe: die Sitzung neu starten, sobald das Verzeichnis neu angelegt wurde.
