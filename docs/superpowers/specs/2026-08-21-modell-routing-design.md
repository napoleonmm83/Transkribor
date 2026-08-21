# Modell- und Skill-Routing für Claude Code — Design

**Datum:** 2026-08-21 · **Auftrag:** Marcus — „ein professionelles System oder einen
Orchestrator, der für die richtige Aufgabe immer das richtige Modell und den richtigen Skill
dazu auswählt."

Ein Teil dieses Systems liegt **ausserhalb des Repos** (`~/.claude/`), weil er für alle
Projekte gilt. Diese Spec ist die einzige zusammenhängende Beschreibung; sie liegt hier, weil
das Projekt-Overlay und die Sperre Repo-Artefakte sind.

## 1. Problem

Es gibt heute **keine** Regel, die Modell oder Skill an die Aufgabe bindet. Gemessen am
2026-08-21:

| Ort, an dem sie stehen müsste | Befund |
|---|---|
| `~/.claude/settings.json` | kein `model`-Schlüssel, nur `effortLevel: "xhigh"` |
| `.claude/agents/*.md` (2 Dateien) | `name`/`description`/`tools` — **kein** `model:` |
| `.claude/skills/*` (6 Skills) | kein `model:` in irgendeinem Frontmatter |
| `~/.claude/rules/`, alle vier `CLAUDE.md` | nichts zur Modellwahl |

Folge: alles läuft auf dem Sitzungsmodell. Die Opus/Sonnet-Stellen in `CLAUDE.md` betreffen die
**Korrektur-Pipeline der App** (`correct.py` → `claude -p --model …`), nicht die Werkzeugkette.

## 2. Gemessene Randbedingungen

Alles hier ist gemessen, nicht angenommen — wer etwas davon ändert, misst neu.

- **Skills können kein Modell setzen.** Zensus über ~200 `SKILL.md` im Plugin-Cache: null mit
  `model:` im Frontmatter (der einzige grep-Treffer war ein Codebeispiel in Zeile 456 von
  `vercel/ai-gateway`).
- **Agenten können es.** 18 von 39 Agentendateien setzen `model:` — Werte `inherit` (8),
  `sonnet` (5), `opus` (5).
- **Der Haupt-Loop kann sein Modell nicht wechseln.** Das entscheidet `/model` bzw.
  `settings.json`. Ein Router kann nur **delegieren** oder **beraten**.
- **Modelltabelle** (Skill `claude-api`, Cache-Stand 2026-06-24). Dies sind API-Preise, nicht
  die Abo-Rechnung; als **Gewicht** taugen sie, als Betrag nicht:

  | Modell | Input $/1M | Output $/1M | Kontext |
  |---|---:|---:|---|
  | Fable 5 | 10 | 50 | 1M — „most capable widely released model" |
  | Opus 5 | 5 | 25 | 1M |
  | Sonnet 5 | 3 | 15 | 1M |
  | Haiku 4.5 | 1 | 5 | **200K** |

- **Haiku hat 200K Kontext, nicht 1M.** Harte Routing-Bedingung: ein grosser Diff passt nicht
  hinein.
- **Subagent-Transkripte führen Modell UND Effort mit** — `"model":"claude-opus-5"` und
  `"effort":"xhigh"`, je 44 Vorkommen in einem Lauf. Damit ist Pinning **belegbar** (siehe §7.2).
- **`effort:` ist ein gültiger Frontmatter-Schlüssel, aber niemand benutzt ihn.** Beleg:
  Changelog Zeile 396 — *„Fixed the spinner's effort label in a subagent's transcript view
  showing the session's effort level instead of the subagent's own `effort:` setting"*. Im
  Zensus der 39 Agentendateien setzt ihn **null**mal jemand.
- **Das `Agent`-Werkzeug hat KEINEN `effort`-Parameter** — nur `model`. Effort kommt entweder
  aus der Agentendatei oder aus `opts.effort` eines Workflow-Laufs. **Architektonische Folge:**
  jede Tafelzeile, deren Effort vom Sitzungswert abweicht, **braucht eine eigene Agentendatei**;
  ein Ad-hoc-Aufruf kann sie nicht ausdrücken.
- **`UserPromptSubmit`-Injektionen akkumulieren.** Sie landen im Turn und bleiben in der
  Historie. Anthropics eigener ausgelieferter Hook (2 325 Zeilen) hält deshalb Sitzungszustand:
  `atomic_check_and_mark_warning(...)` — *„Returns True if this is the first time seeing this
  warning, False if it was already shown (should skip it)."* Eine 40-Zeilen-Tafel bei jedem
  Prompt wären ~500 Token × Turnzahl.
- **Der Ausgabevertrag ist JSON** — und der Weg ist seit 2026-08-21 **gemessen**, nicht mehr nur
  belegt: ein Hook, der
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<marker>"}}`
  schreibt, stellt `<marker>` wörtlich in den Kontext zu. Geprüft mit einem Platzhalter-Marker
  aus einer fremden Sitzung heraus. Ob nackter stdout **ebenfalls** reichen würde, ist weiterhin
  offen und für den Entwurf ohne Belang.
- **Der Hook greift auch in BEREITS LAUFENDEN Sitzungen**, nicht erst in neuen (gemessen
  2026-08-21: der Marker erschien im Kontext der laufenden Sitzung, die ihn eingerichtet hatte).
  Folge für die Bedienung: eine Änderung an der Tafel wirkt sofort — auch mitten in einer
  Arbeit, an der jemand gerade sitzt.
- **Die Akkumulation ist bestätigt.** Die fremde Sitzung berichtete unaufgefordert, der Marker
  „hängt an beiden deiner Nachrichten". Was §2 aus Anthropics Hook nur hergeleitet hatte, ist
  damit am eigenen System gemessen — die Entscheidung für fünf statt vierzig Zeilen steht auf
  einer Messung.
- **Der `model`-Parameter am `Agent`-Werkzeug wirkt** (gemessen 2026-08-21): zwei mit
  `model: sonnet` dispatchte Subagenten zeigen `claude-sonnet-5` im Transkript, nicht das
  Sitzungsmodell. **Zugleich die Negativkontrolle aus §7.2:** dieselben Agenten sind
  `general-purpose` ohne eigenes Frontmatter und zeigen `"effort":"xhigh"` — den Sitzungswert.
  Modell folgt dem Dispatch, Effort nicht. Ob `effort:` im Frontmatter greift, bleibt offen.
- **cwd ist im Hook nicht garantiert.** Der Referenz-Hook nutzt
  `os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())`; die vorhandenen Projekt-Hooks beginnen
  mit `cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}"`.
- **25 `review-*.md` im Projektstamm, alle untracked.** Die Konvention aus `CLAUDE.md` („Der
  Reviewer schreibt seinen Bericht in eine DATEI") wird gelebt — es gibt also bereits eine Spur,
  an der ein Wächter „hat ein Review stattgefunden?" beantworten kann, ohne neuen Zustand zu
  erfinden.

## 3. Zielbild

Marcus' Ziel ist ein Hybrid aus drei Achsen — sie widersprechen sich nicht:

1. **Prozesstreue** — der richtige Skill/Agent läuft, ohne dass er genannt wird.
2. **Kontingent** — das stärkste Modell nur dort, wo es nachweislich trägt.
3. **Qualität** — nirgends arbeitet unbemerkt ein zu schwaches Modell.

**Leitprinzip: Effort ist der feinere Regler als das Modell.** Das Modell setzt die Obergrenze
der *Fähigkeit*, der Effort das *Nachdenk-Budget*. Wo ein Fehler teuer ist, wird am Effort
gespart, nicht am Modell.

## 4. Architektur — fünf Bausteine

| # | Baustein | Rolle |
|---|---|---|
| 1 | `~/.claude/routing.md` | **DIE Quelle**, Langfassung. Wird nicht injiziert — gelesen, wenn geroutet wird. |
| 2 | `UserPromptSubmit`-Hook, JSON/`additionalContext` | **5 Zeilen** (~80 Token/Turn): Aufgabentypen + Verweis. |
| 3 | Das Ensemble: 8 Agentendateien (2 vorhanden, 6 neu) | `model:` **und** `effort:` festgenagelt, Begründung im Körper der Datei |
| 4 | `$CLAUDE_PROJECT_DIR/.claude/routing.md` | Overlay. **Datei schlägt Global** — dieselbe Rangfolge wie `projekt.py`. |
| 5 | `.claude/hooks/routing-sperre.sh`, `.claude/hooks/routing-lint.sh` | Sperre und Drift-Wächter (zwei Skripte, eine Rolle) |

### Das Ensemble

Aus §2 folgt: eine Tafelzeile mit abweichendem Effort **muss** eine Agentendatei sein. Damit
liegt die Zahl fest, sie ist keine Geschmacksfrage.

| Agentendatei | Modell · Effort | vorhanden? |
|---|---|---|
| `mutationsprobe` | opus · low | ja, ergänzen |
| `was-erlaubt-der-fix-neu` | opus · high | ja, ergänzen |
| `pruefer-gegnerisch` | fable · high | neu |
| `faktenpruefer` | fable · high | neu |
| `umsetzer` | sonnet · high | neu |
| `doku` | sonnet · high | neu |
| `browser-beleg` | sonnet · medium | neu |
| `leichtgewicht` | haiku · low | neu — Suche **und** Mechanik in einer Datei |

`leichtgewicht` fasst zwei Tafelzeilen zusammen, weil sie sich in Modell, Effort und Werkzeugen
nicht unterscheiden; zwei Dateien wären zwei Quellen für dieselbe Konfiguration. Der eingebaute
`Explore`-Agent wird dafür **nicht** benutzt: seine Werte sind nicht setzbar, er liefe also auf
dem Sitzungsmodell.

**Kein eigener Router-Skill.** Die Tafel steckt im Hook (deterministisch), die Tiefe in den
Agentendateien — dort, wo sie wirkt, und nur geladen, wenn der Agent läuft. Ein Skill dazwischen
wäre eine dritte Stelle, an der dasselbe steht.

## 5. Die Routing-Tafel

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
| Suchen / „wo steht X" | `leichtgewicht` | **haiku** · low | — |
| Testläufe, Formatieren, Mechanik | `leichtgewicht` | **haiku** · low | — |
| Browser-Beleg | `browser-beleg` | **sonnet** · medium | `playwright` |
| README / Doku im Hausstil | `doku` | **sonnet** · high | — |
| Bibliotheks-/API-Frage | Haupt-Loop | — | `find-docs` bzw. `ctx7` |
| Modell-/LLM-Frage | Haupt-Loop | — | `claude-api` |
| Fertig melden | Haupt-Loop | — | `superpowers:verification-before-completion` |

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

## 6. Die Sperre

`.claude/hooks/routing-sperre.sh` hält **`gh pr create`** an, wenn auf dem Branch kein
Subagent-Review liegt:

    basis=$(git log -1 --format=%cI "$(git merge-base master HEAD)")
    find . -maxdepth 1 -name 'review-*.md' -newermt "$basis" | grep -q . && exit 0

- **`create`, nicht `merge`:** die Hausregel lautet „Subagent ZUERST, dann CodeRabbit" — und
  CodeRabbit *braucht* den PR. Die Sperre kann nur Stufe 1 erzwingen und behauptet nicht mehr.
- **Fluchtweg `KEIN_REVIEW=1`.** Er muss existieren (Begründung aus `readme-pflicht.sh`: „Ohne
  diesen Ausgang würde der Wächter beim ersten Refactoring weggeklickt") und deckt den bekannten
  Fall „Subagent lief, ging aber idle ohne Bericht" ab.
- **Nicht gedeckt, benannt statt kaschiert:** CodeRabbit, Mutationsprobe, lokaler Funktionstest.
  Alle drei sind netzabhängig, langsam oder nicht an einem Dateinamen erkennbar. Eine Stufe
  verlässlich ist mehr wert als drei wackelige.
- Idiome der bestehenden Hooks werden übernommen: Roh-JSON ohne Parser (`python` liegt im
  Git-Bash-PATH **nicht**, gemessen), Befehlspositions-Anker, `exit 2` sperrt, Selbsttest im
  Dateikopf.

## 7. Verifikation

### 7.1 Sperre — mutationsgeprüft, beide Richtungen

| Fall | Erwartung |
|---|---|
| Kein `review-*.md` neuer als der Abzweig | `exit 2` |
| Eines vorhanden | `exit 0` |
| `KEIN_REVIEW=1` | `exit 0` |

Beide Richtungen sind Pflicht: ein Wächter, der immer sperrt, ist derselbe Schaden
spiegelverkehrt (Lehre aus #197, „ein Merker, der IMMER gesetzt ist, ist Daueralarm").
Mutation: `find`-Zeile raus → der Sperrfall muss rot werden.

### 7.2 Pinning — an der Platte gemessen

    grep -oh '"\(model\|effort\)":"[^"]*"' ~/.claude/projects/E--Git-Transkribor/*/subagents/agent-*.jsonl | sort | uniq -c

**Beide Achsen werden geprüft**, weil beide einzeln ausfallen können. Nach einem gegnerischen
Review muss dort `claude-fable-5` **und** `high` stehen. Steht `claude-opus-5`/`xhigh`, ist das
Pinning wirkungslos — sichtbar an keinem Test, nur hier.

**Zwei Negativkontrollen**, sonst misst man die Voreinstellung statt des Pinnings:
- Ein Agent **ohne** `model:`/`effort:` muss weiterhin die Sitzungswerte zeigen.
- `mutationsprobe` muss `opus` **und** `low` zeigen. Diese Zeile ist der schärfste Prüfstein des
  ganzen Entwurfs: Modell und Effort weichen dort in **entgegengesetzte** Richtungen vom
  Sitzungswert ab. Wird nur eine der beiden Achsen wirksam gesetzt, fällt genau hier auf,
  welche — bei jeder anderen Zeile bliebe es verborgen.

### 7.3 Hook-Injektion — nur im echten Lauf

`additionalContext` ist in keinem Unit-Test beobachtbar: Sitzung starten, triviale Frage,
prüfen ob die fünf Zeilen ankommen.

**Erledigt am 2026-08-21** mit einem Platzhalter-Marker (`ROUTING-MARKER-TASK1`): eine fremde
Sitzung gab ihn wörtlich wieder. Damit ist die letzte ungemessene Annahme des Entwurfs
geschlossen. Zwei Nebenbefunde stehen in §2 — der Hook greift auch in laufenden Sitzungen,
und die Akkumulation ist bestätigt.

Der Marker war **bewusst** ein Platzhalter statt der echten Tafel: hätte der Weg nicht
funktioniert, wären zwei Skripte verloren gewesen statt der halben Umsetzung.

### 7.4 Drift-Wächter

`routing-lint.sh`: jeder in der Tafel genannte Agent und Skill muss auflösbar sein. Die Tafel
nennt ~15 Skills; wird einer umbenannt, zeigt sie **still** ins Leere.

## 8. Was das System NICHT leistet

**Ob der Haupt-Loop richtig klassifiziert, ist nicht erzwingbar.** Die Harness kann Ausführung
erzwingen (Hook, gepinnte Agentendatei, Sperre), aber nicht Urteil. Messbar ist: dass die Tafel
ankommt, dass die Modelle greifen, dass die Sperre hält. Mehr verspricht das System nicht — eine
Zusicherung „der Router wählt immer richtig" wäre schärfer als der Code.

## 9. Verworfene Ansätze

- **Klassifizierer-Hook** (Hook ruft ein billiges Modell zur Einordnung): `claude -p`-Startup
  ist **7,7 s ohne MCP** (`CLAUDE.md`, gemessen) — ~8 s Wartezeit vor *jedem* Prompt, auch vor
  „ja, mach".
- **Eigener Workflow-Orchestrator (Stufe C):** Nachbau von `ultracode`. Siehe §5.
- **`/effort ultracode` dauerhaft:** hebt Ziel 2 auf, weil Kosten dort ausdrücklich kein
  Kriterium sind. Bewusster Tausch, nicht versehentlich.
- **`cat` der vollen Tafel bei jedem Prompt:** ~500 Token × Turnzahl, akkumulierend. Siehe §2.
