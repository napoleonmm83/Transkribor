# Modell- und Skill-Routing — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jede Aufgabenart bekommt verlässlich ihr Modell, ihren Effort und ihren Pflicht-Skill —
erzwungen, wo die Harness es kann, und ehrlich benannt, wo sie es nicht kann.

**Architecture:** Eine Routing-Tafel als EINE Quelle (`~/.claude/routing.md` + Projekt-Overlay),
ein `UserPromptSubmit`-Hook, der eine 5-Zeilen-Kurzfassung einspielt, acht Agentendateien mit
festgenageltem `model:`/`effort:`, eine `PreToolUse`-Sperre an `gh pr create` und ein
Drift-Wächter, der prüft, dass die Tafel nicht ins Leere zeigt.

**Tech Stack:** Bash (Git-Bash unter Windows), Claude-Code-Hooks (JSON über stdout),
Agenten-Frontmatter (YAML), `node` für JSON-Validierung.

**Spec:** `docs/superpowers/specs/2026-08-21-modell-routing-design.md`

## Global Constraints

Wörtlich aus der Spec — gilt implizit für jede Task:

- **Hooks parsen Roh-JSON mit `grep`, nie mit einem Interpreter.** Für JSON-Validierung im Test:
  `node`.
  **Korrigiert am 2026-08-21:** hier stand „`python` liegt im Git-Bash-PATH dieses Rechners NICHT
  (Exit 127, gemessen)" — übernommen aus `.claude/hooks/kein-pauschales-add.sh`. **Die Messung ist
  abgelaufen:** `which python` → `/c/Python314/python`, Python 3.14.7, `python -c` läuft mit
  Exit 0. Der Satz war einmal richtig und trägt das Wort „gemessen", was jede Nachprüfung
  abgewürgt hat — ich habe ihn ungeprüft übernommen und in einen neuen Hook weitergereicht.
  **Die Entscheidung bleibt trotzdem**, mit dem Grund, der trägt: ein Wächter, der von einem
  Interpreter im PATH abhängt, fällt **still** aus, sobald sich der PATH ändert — und dass sich
  dieser PATH ändert, ist hier gerade belegt worden.
- **cwd ist im Hook nicht garantiert.** Projekt-Hooks beginnen mit
  `cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}"`.
- **`exit 2` sperrt, `exit 0` lässt durch.** Jeder Wächter braucht einen dokumentierten
  Fluchtweg — „ohne diesen Ausgang würde der Wächter beim ersten Refactoring weggeklickt".
- **Jeder Wächter wird in BEIDE Richtungen geprüft.** Ein Wächter, der immer sperrt, ist
  derselbe Schaden spiegelverkehrt.
- **Selbsttest-Zeilen in den Dateikopf** jedes Hooks, wie in `kein-pauschales-add.sh`.
- **`git add -A` ist im Repo gesperrt** — Dateien einzeln nennen.
- **Die Transkribor-README wird NICHT angefasst.** Sie beschreibt die App für ihre Nutzer;
  dieses System ändert daran nichts. (Der `readme-pflicht.sh`-Hook greift ohnehin nur bei
  `webtool/frontend/src/`, `webtool/app.py`, `electron/`.)
- **Modellwerte:** `fable`, `opus`, `sonnet`, `haiku`. **Effortwerte:** `low`, `medium`, `high`,
  `xhigh`, `max`.

## File Structure

| Datei | Verantwortung | Ort |
|---|---|---|
| `~/.claude/hooks/routing-tafel.sh` | Kurzfassung als `additionalContext` ausgeben | global |
| `~/.claude/routing.md` | DIE Quelle, Langfassung | global |
| `~/.claude/agents/{pruefer-gegnerisch,faktenpruefer,umsetzer,doku,browser-beleg,leichtgewicht}.md` | Das Ensemble, generischer Teil | global |
| `.claude/agents/{mutationsprobe,was-erlaubt-der-fix-neu}.md` | Ensemble, projekteigener Teil (nur ergänzen) | Repo |
| `.claude/routing.md` | Overlay: Transkribors Kette | Repo |
| `.claude/hooks/routing-sperre.sh` | `gh pr create` ohne Review anhalten | Repo |
| `.claude/hooks/routing-lint.sh` | Drift-Wächter über die Tafel | Repo |
| `~/.claude/settings.json` | `UserPromptSubmit` registrieren | global |
| `.claude/settings.json` | `PreToolUse` um die Sperre erweitern | Repo |

---

### Task 1: Der Zustellweg — klärt die einzige ungemessene Annahme

Die Spec (§2, §7.3) sagt ausdrücklich: ob nackter stdout als Kontext ankommt oder die
JSON-Form nötig ist, wurde **nicht gemessen**. Alles Weitere hängt daran. Deshalb zuerst, und
mit einem Marker statt der echten Tafel — ein Fehlschlag soll billig sein.

**Files:**
- Create: `~/.claude/hooks/routing-tafel.sh`
- Modify: `~/.claude/settings.json` (Abschnitt `hooks`)

**Interfaces:**
- Consumes: nichts
- Produces: ein Hook, der auf stdout genau ein JSON-Objekt der Form
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}`
  schreibt. Task 3 ersetzt `<text>` durch die echte Kurzfassung.

- [ ] **Step 1: Den Test schreiben (JSON-Gültigkeit + Form)**

`~/.claude/hooks/routing-tafel.test.sh`:

```bash
#!/usr/bin/env bash
# Selbsttest fuer routing-tafel.sh. Aufruf: bash routing-tafel.test.sh
set -u
H="$(dirname "$0")/routing-tafel.sh"
fehler=0

# 1. Ausgabe ist gueltiges JSON (nicht 'sieht so aus') — node, weil python im
#    Git-Bash-PATH fehlt (Exit 127, gemessen).
if ! bash "$H" </dev/null | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null; then
  echo "FAIL: Ausgabe ist kein gueltiges JSON" >&2; fehler=1
fi

# 2. Die Felder heissen richtig — ein Tippfehler faellt sonst STILL aus.
aus=$(bash "$H" </dev/null)
printf '%s' "$aus" | grep -q '"hookEventName":"UserPromptSubmit"' || { echo "FAIL: hookEventName fehlt" >&2; fehler=1; }
printf '%s' "$aus" | grep -q '"additionalContext"'                || { echo "FAIL: additionalContext fehlt" >&2; fehler=1; }

# 3. Kein roher Zeilenumbruch im JSON-String — JSON verbietet ihn, und genau
#    daran scheitert die naive printf-Fassung.
[ "$(printf '%s' "$aus" | wc -l)" -le 1 ] || { echo "FAIL: mehrzeilige Ausgabe" >&2; fehler=1; }

[ $fehler -eq 0 ] && echo "OK"
exit $fehler
```

- [ ] **Step 2: Test laufen lassen — er MUSS scheitern**

Run: `bash ~/.claude/hooks/routing-tafel.test.sh`
Expected: FAIL, weil `routing-tafel.sh` noch nicht existiert (`bash: … No such file`).

- [ ] **Step 3: Den Hook schreiben**

`~/.claude/hooks/routing-tafel.sh`:

```bash
#!/usr/bin/env bash
# UserPromptSubmit — spielt die Routing-Kurzfassung als additionalContext ein.
#
# WARUM eine Kurzfassung und nicht die ganze Tafel: UserPromptSubmit-Injektionen
# landen im Turn und BLEIBEN in der Historie — sie ersetzen einander nicht, sie
# stapeln sich. Anthropics eigener ausgelieferter Hook haelt deshalb Sitzungszustand
# (atomic_check_and_mark_warning: "False if it was already shown"). Die volle Tafel
# waeren ~500 Token pro Turn; diese Fassung sind ~80.
#
# WARUM JSON und nicht nackter stdout: der einzige belegte Ausgabevertrag ist
# hookSpecificOutput.additionalContext. Ob stdout allein reicht, ist ungemessen —
# also nicht darauf bauen.
#
# Selbsttest:
#   bash ~/.claude/hooks/routing-tafel.test.sh    # OK
#   bash ~/.claude/hooks/routing-tafel.sh </dev/null | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'

cat >/dev/null    # stdin (das Hook-JSON) verwerfen; wir brauchen es nicht

# Die \n sind LITERAL (Backslash + n) und muessen es bleiben: JSON-Strings duerfen
# keinen rohen Zeilenumbruch enthalten. printf '%s' reicht sie unveraendert durch —
# %b wuerde sie expandieren und das JSON zerstoeren.
TAFEL='ROUTING-MARKER-TASK1 (Platzhalter, wird in Task 3 ersetzt)'

printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$TAFEL"
```

- [ ] **Step 4: Test laufen lassen — er MUSS bestehen**

Run: `bash ~/.claude/hooks/routing-tafel.test.sh`
Expected: `OK`, Exit 0.

- [ ] **Step 5: Hook registrieren**

In `~/.claude/settings.json`, im vorhandenen `hooks`-Objekt neben `SessionStart`/`SessionEnd`:

```json
"UserPromptSubmit": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "bash \"$HOME/.claude/hooks/routing-tafel.sh\"",
        "shell": "bash",
        "timeout": 5
      }
    ]
  }
]
```

Danach prüfen, dass die Datei gültiges JSON geblieben ist:
`node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json","utf8"))' && echo "settings.json ok"`

- [ ] **Step 6: MARCUS-GATE — im echten Lauf messen**

Diese Prüfung kann kein Test ersetzen (Spec §7.3). Marcus startet eine **neue** Sitzung,
stellt eine triviale Frage („wie spät ist es"), und Claude berichtet, ob
`ROUTING-MARKER-TASK1` im Kontext angekommen ist.

- **Kommt der Marker an:** weiter mit Task 2.
- **Kommt er NICHT an:** Task 1 hat ihren Zweck erfüllt — die JSON-Annahme ist widerlegt.
  Dann Fallback prüfen (nackter stdout statt JSON) und das Ergebnis in Spec §2 nachtragen.
  **Nicht weiterbauen, bevor das geklärt ist.**

- [ ] **Step 7: Commit**

Nur die Repo-Dateien sind versionierbar; `~/.claude/` liegt ausserhalb. Für diese Task gibt es
daher **keinen Commit** — stattdessen das Ergebnis von Step 6 in die Spec eintragen:

```bash
# nach erfolgreichem Step 6:
git add docs/superpowers/specs/2026-08-21-modell-routing-design.md
git commit -m "docs(routing): Zustellweg gemessen — additionalContext kommt an"
```

---

### Task 2: Das Ensemble — acht Agentendateien

**Files:**
- Create: `~/.claude/agents/pruefer-gegnerisch.md`, `faktenpruefer.md`, `umsetzer.md`,
  `doku.md`, `browser-beleg.md`, `leichtgewicht.md`
- Modify: `.claude/agents/mutationsprobe.md` (Frontmatter), `.claude/agents/was-erlaubt-der-fix-neu.md` (Frontmatter)

**Interfaces:**
- Consumes: nichts aus Task 1
- Produces: acht auflösbare `subagent_type`-Namen — `pruefer-gegnerisch`, `faktenpruefer`,
  `umsetzer`, `doku`, `browser-beleg`, `leichtgewicht`, `mutationsprobe`,
  `was-erlaubt-der-fix-neu`. Task 3 nennt genau diese Namen in der Tafel; Task 4 nicht.

- [ ] **Step 1: Die beiden vorhandenen ergänzen**

In `.claude/agents/mutationsprobe.md`, Frontmatter, nach `tools:` einfügen:

```yaml
model: opus
effort: low
```

In `.claude/agents/was-erlaubt-der-fix-neu.md`, ebenso:

```yaml
model: opus
effort: high
```

Der Körper beider Dateien bleibt **unangetastet**.

- [ ] **Step 2: Die Pinning-Messung fahren — VOR den sechs neuen Dateien**

Der Grund: `fable` und `effort:` sind in freier Wildbahn **unbelegt** (Zensus: 0 von 39
Agentendateien setzen `effort:`; die Werte in freier Wildbahn sind nur `inherit`/`sonnet`/
`opus`). Wenn das Frontmatter diese Werte nicht annimmt, sind sechs neue Dateien sechsmal
derselbe Fehler.

`mutationsprobe` ist dafür der schärfste Prüfstein (Spec §7.2): `opus · low` weicht in
**entgegengesetzte** Richtungen vom Sitzungswert (`xhigh`) ab. Greift nur eine der beiden
Achsen, sieht man hier, welche.

**MARCUS-GATE:** dafür muss genau ein Wegwerf-Subagent starten — in dieser Sitzung gilt
„Agent nur auf Aufforderung". Kurz bestätigen lassen, dann:

```
Agent(subagent_type: "mutationsprobe", prompt: "Antworte nur mit dem Wort BEREIT. Fasse keine Datei an.")
```

Danach messen:

```bash
neueste=$(ls -t ~/.claude/projects/E--Git-Transkribor/*/subagents/agent-*.jsonl | head -1)
grep -oh '"\(model\|effort\)":"[^"]*"' "$neueste" | sort | uniq -c
```

Expected: `"model":"claude-opus-5"` **und** `"effort":"low"`.

- **Beides stimmt:** weiter mit Step 3.
- **`effort` bleibt `xhigh`:** `effort:` wird im Frontmatter nicht gelesen. Fallback: Effort
  aus der Tafel streichen, nur `model:` pinnen, und die Spec §2/§3 korrigieren — das
  Leitprinzip „Effort ist der feinere Regler" ist dann tot und darf nicht stehenbleiben.
- **`model` stimmt nicht:** Alias wird nicht angenommen; Fallback ist der `model`-Parameter
  am `Agent`-Aufruf (dort ist `fable|opus|sonnet|haiku` als Enum belegt).

- [ ] **Step 3: Die sechs neuen Dateien schreiben**

`~/.claude/agents/pruefer-gegnerisch.md`:

```markdown
---
name: pruefer-gegnerisch
description: Gegnerischer Code-Review — liest einen Diff, um ihn zu WIDERLEGEN, nicht um ihn zu bestätigen. Nutze das nach jedem Fix und VOR CodeRabbit.
tools: Read, Bash, Grep, Glob
model: fable
effort: high
---

Du bestätigst nichts. Du suchst den Fall, in dem diese Änderung falsch ist.

## Auftrag

Der Auftraggeber nennt dir den Diff, die bereits behobenen Befunde (melde sie NICHT erneut)
und die bewusst nicht behobenen samt Begründung.

Drei Fragen, in dieser Reihenfolge:

1. **Was erlaubt der Fix NEU?** Der alte Zustand war nicht nur kaputt — er hat nebenbei etwas
   verhindert. Nimmt die Reparatur diesen Schutz mit?
2. **Ist eine Begründung schärfer als der Code?** Ein Kommentar, der mehr zusichert, als die
   Zeile darunter hält, ist ein Fehler — auch wenn der Code stimmt.
3. **Welche Zusicherung hat KEINE Abdeckung?** Ein Wächter, der auch ohne seine Logik grün
   bliebe, ist Dekoration.

## Warum dieses Modell

`fable` ist teuer (doppelter Opus-Preis) und steht deshalb an genau zwei Stellen. Diese ist
eine davon, gemessen: an PR #183 fand der gegnerische Review **fünf echte Punkte, die Bot,
CLI und `/code-review` alle übersehen hatten** — darunter zwei Wächter mit null Abdeckung.
Ein übersehener Befund ist der teuerste Posten dieses Repos; hier zu sparen spart am
falschen Ende.

`effort: high` statt `xhigh`, weil die Aufgabe scharf umrissen ist: ein Diff, drei Fragen.

## Bericht

Schreibe deinen Bericht als LETZTE Handlung nach `review-<thema>.md` im Projektstamm; erst
danach antworte. Der Rückgabewert ist der fragile Kanal — ein fertiger Bericht ist schon
einmal verlorengegangen, weil der Lauf nicht idle-frei zurückkam.
```

`~/.claude/agents/faktenpruefer.md`:

```markdown
---
name: faktenpruefer
description: Prüft Behauptungen gegen den Code — jede Aussage in einem Plan, Bericht oder Kommentar muss am Quelltext belegbar sein. Nutze das vor jedem Plan und vor jeder Fertigmeldung.
tools: Read, Bash, Grep, Glob
model: fable
effort: high
---

Du prüfst **Sätze**, nicht Code. Für jede Behauptung im vorgelegten Text beantwortest du:
steht das so im Quelltext, oder klingt es nur so?

## Auftrag

1. Zerlege den Text in einzelne, prüfbare Behauptungen.
2. Für jede: **gemessen** (mit Fundstelle `Datei:Zeile`), **hergeleitet** oder **unbelegt**.
3. Eine benannte URSACHE braucht eine Negativkontrolle: gibt es einen Fall, in dem die
   genannte Ursache vorlag und die Wirkung ausblieb? Findet sich einer, ist die Erklärung tot.

Melde ausdrücklich, was du NICHT prüfen konntest. Eine ungeprüfte Behauptung als „stimmt" zu
melden, ist schlimmer als sie offen zu lassen.

## Warum dieses Modell

Die zweite von zwei `fable`-Stellen. Grund: „eine Behauptung, die schärfer ist als der Code"
ist in `MEMORY.md` als **die häufigste Fehlerklasse dieses Repos** geführt. Ein Faktenprüfer,
der selbst zu ungenau liest, verdoppelt das Problem, statt es zu lösen.

## Bericht

Schreibe deinen Bericht als LETZTE Handlung nach `review-<thema>-fakten.md` im Projektstamm;
erst danach antworte.
```

`~/.claude/agents/umsetzer.md`:

```markdown
---
name: umsetzer
description: Setzt eine klar abgegrenzte Aufgabe nach Vorgabe um — eine Datei, ein Endpunkt, eine Funktion, mit Test. Nutze das, wenn die Entscheidung bereits gefallen ist und nur noch getippt werden muss.
tools: Read, Edit, Write, Bash, Grep, Glob
model: sonnet
effort: high
---

Du setzt um, was dir vorgegeben wurde. Du entwirfst nicht neu.

## Auftrag

1. Lies die genannten Dateien, bevor du etwas änderst.
2. **Test zuerst**, dann die Umsetzung. Der Test muss vorher rot sein — führe ihn aus und
   zeige die Fehlermeldung.
3. Halte dich an die Idiome der umgebenden Dateien: Kommentardichte, Benennung, Fehlerbehandlung.
4. Fällt dir unterwegs auf, dass die Vorgabe falsch ist: **melde es und halte an.** Du bist
   nicht beauftragt, den Entwurf zu reparieren.

## Warum dieses Modell

`sonnet` reicht, weil die schwere Arbeit — die Entscheidung — schon getroffen ist; die
Vorgabe ist die Spezifikation. `effort: high`, nicht `low`: Umsetzung ohne Nachdenken
produziert Code, der die Tests besteht und die Idiome verfehlt.
```

`~/.claude/agents/doku.md`:

```markdown
---
name: doku
description: Zieht README und Anleitungen im Hausstil nach — für Menschen ohne technischen Hintergrund, in ihren Worten, unter dem passenden Abschnitt. Nutze das, wenn sich für den Nutzer sichtbar etwas geändert hat.
tools: Read, Edit, Write, Bash, Grep, Glob
model: sonnet
effort: high
---

Du schreibst für jemanden ohne technischen Hintergrund.

## Auftrag

1. Lies zuerst die vorhandene Datei ganz — der Ton ist vorgegeben, nicht neu zu erfinden.
2. **Was bringt es dem Leser**, in seinen Worten, unter dem passenden Abschnitt. Nicht
   „neu in 0.12: `?sprecher=false` am SRT-Endpunkt".
3. Technisches gehört in „Für Entwickler" ans Ende.
4. **Was die Doku behauptet, muss stimmen.** Prüfe jede Zusicherung am Code, bevor du sie
   schreibst — eine falsche Zusage in der README kostet Vertrauen, das kein Fix zurückholt.

## Warum dieses Modell

`sonnet` mit `high`: Stiltreue über eine ganze Datei ist keine Mechanik, aber auch keine
Aufgabe, an der ein stärkeres Modell messbar besser wäre. Der teure Teil ist Punkt 4 — und
der ist Nachschlagen, nicht Denken.
```

`~/.claude/agents/browser-beleg.md`:

```markdown
---
name: browser-beleg
description: Prüft eine Frontend-Änderung im echten Browser und legt einen Beleg vor (Screenshot, vorher/nachher). Nutze das nach JEDEM sichtbaren Frontend-Fix, zusätzlich zu den Tests.
tools: Read, Bash, Grep, Glob
model: sonnet
effort: medium
---

Du beantwortest genau eine Frage: **tut es das im Browser auch?**

## Auftrag

1. Anwendung starten, die Stelle anfassen, den Beleg sichern.
2. **Auf einem Wegwerf-Projekt, nie auf echten Daten.** Der Editor speichert 800 ms nach der
   letzten Änderung von selbst — ein Klick zum Ausprobieren schreibt in echte Dateien.
3. Berichte, **was du gemessen hast**, nicht „läuft". Konntest du es nicht prüfen, sag das.

## Warum dieses Modell

`sonnet · medium`: die Arbeit ist Beobachten und Beschreiben, nicht Schliessen. Die
Begründung für den Agenten überhaupt ist gemessen — an PR #227 liefen 437 grüne Tests durch
drei Reviewrunden, und niemand hatte den Knopf je gedrückt; alle Tests liefen in jsdom gegen
eine Attrappe.
```

`~/.claude/agents/leichtgewicht.md`:

```markdown
---
name: leichtgewicht
description: Suchen und Mechanik — „wo steht X", Testläufe, Formatieren, Dateien zählen. Nutze das für alles, was Nachschlagen oder Ausführen ist und kein Urteil verlangt.
tools: Read, Bash, Grep, Glob
model: haiku
effort: low
---

Du schlägst nach und führst aus. Du entscheidest nichts.

## Auftrag

Antworte knapp und mit Fundstelle (`Datei:Zeile`). Findest du nichts, sag „nicht gefunden" —
rate nicht.

## Grenze — wichtig

**Dein Kontextfenster ist 200K, nicht 1M.** Ein grosser Diff oder eine lange Protokolldatei
passt nicht hinein. Merkst du, dass die Eingabe zu gross ist, brich ab und sag es, statt
einen Teil zu lesen und so zu antworten, als hättest du alles gesehen.

## Warum dieses Modell

`haiku · low` ist ein Fünftel des Opus-Preises. Beides zusammen in einer Datei, weil Suche
und Mechanik sich in Modell, Effort und Werkzeugen nicht unterscheiden — zwei Dateien wären
zwei Quellen für dieselbe Konfiguration.
```

- [ ] **Step 4: Auflösbarkeit prüfen**

```bash
for a in pruefer-gegnerisch faktenpruefer umsetzer doku browser-beleg leichtgewicht; do
  f=~/.claude/agents/$a.md
  [ -f "$f" ] || { echo "FEHLT: $a"; continue; }
  m=$(awk '/^---$/{n++;next} n==1 && /^model:/{print $2}' "$f")
  e=$(awk '/^---$/{n++;next} n==1 && /^effort:/{print $2}' "$f")
  echo "$a: model=$m effort=$e"
done
```

Expected: sechs Zeilen, jede mit gesetztem `model` und `effort`, keine `FEHLT`.

- [ ] **Step 5: Commit**

```bash
git add .claude/agents/mutationsprobe.md .claude/agents/was-erlaubt-der-fix-neu.md
git commit -m "feat(routing): Modell und Effort an den beiden Projekt-Agenten festnageln"
```

Die sechs globalen Dateien liegen ausserhalb des Repos und werden nicht committet — das ist
in der Spec §4 so vorgesehen. Als Sicherung eine Kopie nach `docs/superpowers/routing-agenten/`
legen und mitcommitten, damit sie bei einem Profilverlust nicht weg sind:

```bash
mkdir -p docs/superpowers/routing-agenten
cp ~/.claude/agents/*.md docs/superpowers/routing-agenten/
git add docs/superpowers/routing-agenten
git commit -m "docs(routing): Kopie der globalen Agentendateien als Sicherung"
```

---

### Task 3: Die Tafel — Quelle, Kurzfassung, Overlay, Drift-Wächter

**Files:**
- Create: `~/.claude/routing.md`, `.claude/routing.md`, `.claude/hooks/routing-lint.sh`
- Modify: `~/.claude/hooks/routing-tafel.sh` (Platzhalter aus Task 1 ersetzen)

**Interfaces:**
- Consumes: die acht Agentennamen aus Task 2
- Produces: `routing-lint.sh` mit Exit 0 (alles auflösbar) / Exit 1 (mindestens ein Name
  zeigt ins Leere). Task 4 hängt nicht davon ab.

- [ ] **Step 1: Den Drift-Wächter ZUERST schreiben (er ist der Test der Tafel)**

`.claude/hooks/routing-lint.sh`:

```bash
#!/usr/bin/env bash
# Drift-Waechter ueber die Routing-Tafel: zeigt jeder genannte Agent und Skill noch irgendwohin?
#
# WARUM: die Tafel nennt ~15 Skills und 8 Agenten. Wird einer umbenannt, zeigt sie STILL ins
# Leere — dieselbe Klasse wie "eine fest verdrahtete Liste waere in drei Monaten falsch",
# die in CLAUDE.md dreimal steht. Ein Lauf, ein Exitcode.
#
# GRENZE, benannt: geprueft wird EXISTENZ (Verzeichnis- bzw. Dateiname), nicht ob der Skill
# aktiviert oder das Plugin eingeschaltet ist. Ein abgeschalteter Skill gilt hier als da.
#
# Selbsttest:
#   bash .claude/hooks/routing-lint.sh            # Exit 0, wenn die Tafel sauber ist
#   sed -i 's/`umsetzer`/`gibtsnicht`/' ~/.claude/routing.md && bash .claude/hooks/routing-lint.sh  # Exit 1

cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}" || exit 0
fehler=0

tafeln="$HOME/.claude/routing.md .claude/routing.md"

# Spalte 3 = "Wer", Spalte 5 = "Pflicht-Skill". Die Tabellenform ist der Vertrag;
# ein eigener Markdown-Parser waere mehr Code als die Sache wert.
namen() {  # $1 = Spaltennummer
  for t in $tafeln; do
    [ -f "$t" ] || continue
    awk -F'|' -v c="$1" '/^\|/ {gsub(/^[ \t]+|[ \t]+$/,"",$c); print $c}' "$t"
  done | grep -o '`[^`]*`' | tr -d '`' | sort -u
}

for a in $(namen 3); do
  case "$a" in Haupt-Loop|—|"") continue ;; esac
  [ -f "$HOME/.claude/agents/$a.md" ] || [ -f ".claude/agents/$a.md" ] || {
    echo "TOTER AGENT in der Tafel: $a" >&2; fehler=1; }
done

for s in $(namen 5); do
  case "$s" in —|"") continue ;; esac
  kurz="${s##*:}"    # 'superpowers:brainstorming' -> 'brainstorming'
  find "$HOME/.claude/plugins/cache" "$HOME/.claude/skills" ".claude/skills" \
       -maxdepth 6 -type d -name "$kurz" 2>/dev/null | grep -q . || {
    echo "TOTER SKILL in der Tafel: $s" >&2; fehler=1; }
done

[ $fehler -eq 0 ] && echo "Tafel sauber."
exit $fehler
```

- [ ] **Step 2: Lint laufen lassen — er MUSS scheitern**

Run: `bash .claude/hooks/routing-lint.sh`
Expected: `Tafel sauber.` mit Exit 0 — **weil noch keine Tafel existiert und die Schleifen
leer laufen.** Das ist ein vacuous grün und genau die Sorte Test, die dieses Repo verbietet.
Deshalb Step 3 vor der echten Tafel: erst eine kaputte Tafel, die den Wächter rot macht.

- [ ] **Step 3: Den Wächter scharf stellen (Positivkontrolle)**

```bash
printf '| x | `gibtsnicht` | y | z |\n' > ~/.claude/routing.md
bash .claude/hooks/routing-lint.sh; echo "Exit: $?"
```

Expected: `TOTER AGENT in der Tafel: gibtsnicht`, Exit 1.
**Erst jetzt** ist belegt, dass der Wächter überhaupt etwas findet.

- [ ] **Step 4: Die echte Tafel schreiben**

`~/.claude/routing.md` — Inhalt ist die Tabelle aus Spec §5 samt der drei
begründungspflichtigen Absätze und dem `ultracode`-Abschnitt. Zusätzlich als erster Absatz:

```markdown
# Routing — welches Modell, welcher Skill

Diese Datei ist DIE Quelle. Der `UserPromptSubmit`-Hook spielt nur eine Kurzfassung ein;
alles Weitere steht hier. Das Projekt-Overlay (`$CLAUDE_PROJECT_DIR/.claude/routing.md`)
**schlägt diese Datei** bei gleichem Aufgabentyp.

Der Haupt-Loop kann sein eigenes Modell nicht wechseln. Passt es nicht zur Aufgabe, wird das
EINMAL gesagt („diese Arbeit ist mechanisch — `/model sonnet` wäre richtig") und dann
weitergearbeitet; die Entscheidung liegt beim Menschen.
```

- [ ] **Step 5: Das Overlay schreiben**

`.claude/routing.md`:

```markdown
# Routing-Overlay: Transkribor

Ergänzt `~/.claude/routing.md`. Bei gleichem Aufgabentyp gewinnt diese Datei.

| Aufgabentyp | Wer | Modell · Effort | Pflicht-Skill |
|---|---|---|---|
| Nach JEDEM Fix, Stufe 1 | `pruefer-gegnerisch` | **fable** · high | `superpowers:requesting-code-review` |
| Nach JEDEM Fix, Stufe 2 | Haupt-Loop | — | `coderabbit:coderabbit-review` |
| Nach jedem Test | `mutationsprobe` | **opus** · low | — |
| Fix an Speicher-, Job- oder Prompt-Pfad | `was-erlaubt-der-fix-neu` | **opus** · high | — |
| Offener Punkt am Ende einer Arbeit | Haupt-Loop | — | `befund` |
| Release | Haupt-Loop | — | `release` |
| Sichtbare Änderung im Frontend | `browser-beleg` | **sonnet** · medium | — |

## Reihenfolge, die nicht verhandelbar ist

`superpowers:requesting-code-review` **zuerst**, dann CodeRabbit. Begründung in `CLAUDE.md`:
CodeRabbits Kontingent ist knapp; es auf einen Diff zu verbrauchen, in dem noch
subagent-findbare Fehler stecken, verschenkt den einzigen fremden Blick.

## Was hier NICHT hingehört

Die Modellwahl der **App** (`correct.py` → `claude -p --model …`) ist eine Nutzereinstellung
und hat mit diesem Routing nichts zu tun.
```

- [ ] **Step 6: Lint gegen die echte Tafel**

Run: `bash .claude/hooks/routing-lint.sh`
Expected: `Tafel sauber.`, Exit 0.
Schlägt er an, ist entweder ein Agent aus Task 2 nicht angelegt oder ein Skillname falsch
geschrieben — beides ist genau der Fund, für den der Wächter gebaut ist.

- [ ] **Step 7: Die Kurzfassung in den Hook einsetzen**

In `~/.claude/hooks/routing-tafel.sh` die `TAFEL=`-Zeile ersetzen (die `\n` bleiben literal):

```bash
TAFEL='ROUTING (Details: ~/.claude/routing.md + $CLAUDE_PROJECT_DIR/.claude/routing.md)\nVor der Arbeit: Typ bestimmen, Pflicht-Skill laden, dann delegieren oder Modellhinweis geben.\nReview+Faktencheck=fable · Fix-Nebenwirkung+Mutation=opus · Umsetzung/Doku/Browser=sonnet · Suche/Mechanik=haiku\nDer Haupt-Loop kann sein Modell nicht wechseln — passt es nicht, EINMAL sagen und weiterarbeiten.\nGrosse Arbeiten: ultracode auf Zuruf; Phasen-Modelle dabei NICHT weglassen. Datei-Overlay schlaegt Global.'
```

- [ ] **Step 8: Hook-Test erneut laufen lassen**

Run: `bash ~/.claude/hooks/routing-tafel.test.sh`
Expected: `OK` — insbesondere muss Prüfung 3 (einzeilig) weiter halten; ein versehentlicher
echter Zeilenumbruch im String zerstört das JSON.

- [ ] **Step 9: Commit**

```bash
git add .claude/routing.md .claude/hooks/routing-lint.sh
cp ~/.claude/routing.md docs/superpowers/routing-agenten/routing.md
git add docs/superpowers/routing-agenten/routing.md
git commit -m "feat(routing): Tafel, Overlay und Drift-Waechter"
```

---

### Task 4: Die Sperre

**Files:**
- Create: `.claude/hooks/routing-sperre.sh`
- Modify: `.claude/settings.json` (`PreToolUse` → `Bash`-Matcher, dritter Eintrag)

**Interfaces:**
- Consumes: nichts
- Produces: einen `PreToolUse`-Hook, der bei `gh pr create` ohne frisches `review-*.md` mit
  Exit 2 abbricht.

- [ ] **Step 1: Den Test schreiben**

`.claude/hooks/routing-sperre.test.sh`:

```bash
#!/usr/bin/env bash
# Selbsttest fuer routing-sperre.sh — BEIDE Richtungen.
# Ein Waechter, der immer sperrt, ist derselbe Schaden spiegelverkehrt (#197).
set -u
cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}" || exit 1
H=.claude/hooks/routing-sperre.sh
fehler=0

lauf() { printf '%s' "$1" | bash "$H" >/dev/null 2>&1; echo $?; }
PR='{"tool_input":{"command":"gh pr create --fill"}}'

# Aufraeumen, damit der Test nicht vom Zufall lebt: ein liegengebliebenes
# review-*.md aus echter Arbeit wuerde den Sperrfall gruen machen.
tmp=$(mktemp -d); mv review-*.md "$tmp"/ 2>/dev/null

# 1. Kein Review -> sperrt
[ "$(lauf "$PR")" = "2" ] || { echo "FAIL: sperrt nicht ohne Review" >&2; fehler=1; }

# 2. Fluchtweg -> laesst durch
[ "$(lauf '{"tool_input":{"command":"KEIN_REVIEW=1 gh pr create --fill"}}')" = "0" ] \
  || { echo "FAIL: Fluchtweg wirkt nicht" >&2; fehler=1; }

# 3. Fremder Befehl -> laesst durch (der Waechter darf nicht ueberall zuschlagen)
[ "$(lauf '{"tool_input":{"command":"git status"}}')" = "0" ] \
  || { echo "FAIL: sperrt einen fremden Befehl" >&2; fehler=1; }

# 4. Blosse ERWAEHNUNG -> laesst durch (Befehlspositions-Anker; genau hier ist
#    kein-pauschales-add.sh beim ersten Einsatz aufgelaufen)
[ "$(lauf '{"tool_input":{"command":"echo gh pr create > notiz.md"}}')" = "0" ] \
  || { echo "FAIL: schlaegt bei blosser Erwaehnung an" >&2; fehler=1; }

# 5. Review vorhanden -> laesst durch (die Negativkontrolle)
touch review-selbsttest.md
[ "$(lauf "$PR")" = "0" ] || { echo "FAIL: sperrt TROTZ Review" >&2; fehler=1; }
rm -f review-selbsttest.md

mv "$tmp"/review-*.md . 2>/dev/null; rmdir "$tmp" 2>/dev/null
[ $fehler -eq 0 ] && echo "OK"
exit $fehler
```

- [ ] **Step 2: Test laufen lassen — er MUSS scheitern**

Run: `bash .claude/hooks/routing-sperre.test.sh`
Expected: FAIL bei Prüfung 1 (Skript existiert nicht → Exit ≠ 2).

- [ ] **Step 3: Die Sperre schreiben**

`.claude/hooks/routing-sperre.sh`:

```bash
#!/usr/bin/env bash
# PreToolUse(Bash) — haelt `gh pr create` an, wenn auf diesem Branch kein Subagent-Review liegt.
#
# CLAUDE.md macht das zur Regel ("Jeder Fix wird geprueft — Review UND Test, ohne Rueckfrage"),
# und die Begruendung ist gemessen: an einem einzigen Nachmittag liefen fuenf PRs mit gruener
# CI durch, drei echte Fehler steckten trotzdem drin. Eine Regel, die nur in Prosa steht,
# faellt weg — genau das ist mit der Bericht-in-eine-Datei-Konvention passiert.
#
# ERKANNT wird das Review an den 25 review-*.md im Projektstamm: eine Spur, die als
# Nebenprodukt echter Arbeit entsteht. Kein neuer Zustand, der driften koennte.
#
# NUR Stufe 1. CodeRabbit BRAUCHT den PR, kann hier also nicht geprueft werden; Mutationsprobe
# und lokaler Funktionstest sind an keinem Dateinamen erkennbar. Eine Stufe verlaesslich ist
# mehr wert als drei wackelige.
#
# Fluchtweg: `KEIN_REVIEW=1 gh pr create …`. Er MUSS existieren (sonst wird der Waechter beim
# ersten Mal weggeklickt) und deckt den bekannten Fall ab, dass der Subagent lief, aber idle
# ohne Bericht zurueckkam — dann steht der Bericht im Transkript statt auf der Platte.
#
# Selbsttest:
#   bash .claude/hooks/routing-sperre.test.sh
#   echo '{"tool_input":{"command":"gh pr create"}}' | bash .claude/hooks/routing-sperre.sh; echo $?  # 2

cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}" || exit 0

roh=$(cat)

# Roh-JSON, ohne Parser: `python` liegt im Git-Bash-PATH dieses Rechners NICHT (Exit 127,
# gemessen) — und ein Parser, der still ausfaellt, ist ein Waechter, der still ausfaellt.
# Der Anker verlangt Befehlsposition: direkt hinter "command":" oder hinter einem
# Shell-Trenner, optional mit vorangestelltem KEIN_REVIEW=1. Ohne ihn schlaegt der Waechter
# auch bei Kommandos an, die den Text nur ERWAEHNEN.
printf '%s' "$roh" | grep -Eq '("command":[[:space:]]*"|[;&|(]|^)[[:space:]]*(KEIN_REVIEW=1[[:space:]]+)?gh[[:space:]]+pr[[:space:]]+create([[:space:]"]|$)' || exit 0

printf '%s' "$roh" | grep -q 'KEIN_REVIEW=1' && exit 0

basis=$(git log -1 --format=%cI "$(git merge-base master HEAD 2>/dev/null)" 2>/dev/null)
# Kein Abzweigpunkt ermittelbar (kein git, kein master) -> durchlassen. Ein Waechter, der bei
# eigener Unsicherheit sperrt, blockiert Arbeit, ueber die er nichts weiss.
[ -n "$basis" ] || exit 0

find . -maxdepth 1 -name 'review-*.md' -newermt "$basis" 2>/dev/null | grep -q . && exit 0

echo 'Kein Subagent-Review auf diesem Branch: es liegt kein review-*.md, das neuer ist als der' >&2
echo 'Abzweigpunkt von master. CLAUDE.md verlangt superpowers:requesting-code-review ZUERST,' >&2
echo 'dann CodeRabbit — und CodeRabbit braucht den PR, kann hier also nicht geprueft werden.' >&2
echo 'Lief der Review und kam nur idle ohne Bericht zurueck: KEIN_REVIEW=1 gh pr create …' >&2
exit 2
```

- [ ] **Step 4: Test laufen lassen — er MUSS bestehen**

Run: `bash .claude/hooks/routing-sperre.test.sh`
Expected: `OK`, Exit 0.

- [ ] **Step 5: Mutationsprobe — wird der Test auch WIRKLICH rot?**

```bash
cp .claude/hooks/routing-sperre.sh /tmp/sperre.bak
sed -i "s|^find \. -maxdepth 1.*|true \&\& exit 0|" .claude/hooks/routing-sperre.sh
bash .claude/hooks/routing-sperre.test.sh; echo "Mutiert -> Exit: $?"
cp /tmp/sperre.bak .claude/hooks/routing-sperre.sh
bash .claude/hooks/routing-sperre.test.sh; echo "Zurueck -> Exit: $?"
```

Expected: mutiert → `FAIL: sperrt nicht ohne Review`, Exit 1. Zurück → `OK`, Exit 0.
Bleibt die Mutation grün, prüft der Test die Sperre nicht, sondern etwas anderes.

- [ ] **Step 6: Zweite Mutation — hält die Negativkontrolle?**

```bash
cp .claude/hooks/routing-sperre.sh /tmp/sperre.bak
sed -i "s|^find \. -maxdepth 1.*|false \&\& exit 0|" .claude/hooks/routing-sperre.sh
bash .claude/hooks/routing-sperre.test.sh; echo "Immer-Sperre -> Exit: $?"
cp /tmp/sperre.bak .claude/hooks/routing-sperre.sh
```

Expected: `FAIL: sperrt TROTZ Review`, Exit 1. Ohne diese Richtung wäre ein Wächter, der
alles sperrt, ein grüner Test — Daueralarm ist derselbe Schaden spiegelverkehrt.

- [ ] **Step 7: Hook registrieren**

In `.claude/settings.json`, `PreToolUse` → Matcher `Bash`, als dritter Eintrag neben
`kein-pauschales-add.sh` und `readme-pflicht.sh`:

```json
{
  "type": "command",
  "command": "cd \"${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}\" && bash .claude/hooks/routing-sperre.sh",
  "timeout": 10
}
```

Prüfen: `node -e 'JSON.parse(require("fs").readFileSync(".claude/settings.json","utf8"))' && echo ok`

- [ ] **Step 8: Am echten Befehl prüfen**

```bash
echo '{"tool_input":{"command":"gh pr create --fill"}}' | bash .claude/hooks/routing-sperre.sh; echo "Exit: $?"
```

Expected: die vierzeilige Meldung auf stderr, Exit 2 — **auf diesem Branch liegt bis hierhin
kein Review**, die Sperre muss also greifen. Das ist zugleich der Beleg, dass sie im echten
Ablauf wirkt und nicht nur im Test.

**Die Vorbedingung ist gemessen, nicht angenommen** (2026-08-21): Abzweigpunkt
`2026-08-21T17:01:03+02:00`, und `find . -maxdepth 1 -name 'review-*.md' -newermt "$basis"`
liefert **0** Treffer — die 25 vorhandenen Berichte stammen alle aus früheren Arbeiten.
Kommt hier trotzdem Exit 0, dann prüfen, ob inzwischen ein Review auf diesem Branch lief:

```bash
find . -maxdepth 1 -name 'review-*.md' -newermt "$(git log -1 --format=%cI "$(git merge-base master HEAD)")"
```

Ist die Liste nicht leer, ist Exit 0 **richtig** und die Sperre in Ordnung — dann ist die
Erwartung dieses Steps überholt, nicht der Wächter kaputt.

- [ ] **Step 9: Commit**

```bash
git add .claude/hooks/routing-sperre.sh .claude/hooks/routing-sperre.test.sh .claude/settings.json
git commit -m "feat(routing): Sperre an gh pr create, mutationsgeprueft in beide Richtungen"
```

---

### Task 5: Abnahme im echten Lauf

**Files:**
- Modify: `docs/superpowers/specs/2026-08-21-modell-routing-design.md` (Messergebnisse)
- Modify: `CLAUDE.md` (Zeiger auf das Overlay — **gitignoriert, nicht committen**)

**Interfaces:**
- Consumes: alles aus Task 1–4
- Produces: nichts, was Code liest — nur den Beleg, dass das System wirkt.

- [ ] **Step 1: Pinning beider fable-Agenten messen**

**MARCUS-GATE:** ein Wegwerf-Aufruf je Agent.

```
Agent(subagent_type: "pruefer-gegnerisch", prompt: "Antworte nur mit dem Wort BEREIT.")
Agent(subagent_type: "leichtgewicht",      prompt: "Antworte nur mit dem Wort BEREIT.")
```

```bash
for f in $(ls -t ~/.claude/projects/E--Git-Transkribor/*/subagents/agent-*.jsonl | head -2); do
  echo "--- $f"; grep -oh '"\(model\|effort\)":"[^"]*"' "$f" | sort -u
done
```

Expected: `claude-fable-5`/`high` und `claude-haiku-4-5`/`low`.
**Negativkontrolle:** ein Agent ohne `model:`/`effort:` (z. B. `general-purpose`) muss
weiterhin `claude-opus-5`/`xhigh` zeigen — sonst misst man die Sitzungsvoreinstellung statt
des Pinnings.

- [ ] **Step 2: Die Injektion im echten Lauf prüfen**

Neue Sitzung, triviale Frage. Erwartung: die fünf Zeilen der Kurzfassung sind im Kontext.
Marcus fragt „was steht in deiner Routing-Tafel?" — kommt die Antwort ohne Dateizugriff, ist
die Injektion belegt.

- [ ] **Step 3: Kosten messen statt schätzen**

Die Spec behauptet ~80 Token pro Turn. Nachrechnen:

```bash
bash ~/.claude/hooks/routing-tafel.sh </dev/null | wc -c
```

Zeichenzahl ÷ ~3,5 ≈ Token. Weicht es stark von 80 ab, wird die Zahl in Spec §4 **korrigiert**,
nicht die Schätzung verteidigt.

- [ ] **Step 4: Spec nachziehen**

In `docs/superpowers/specs/2026-08-21-modell-routing-design.md` §2 die drei bis dahin
ungemessenen Punkte durch Messwerte ersetzen: Zustellweg (Task 1 Step 6), `effort:`-Wirksamkeit
(Task 2 Step 2), `fable` im Frontmatter (Task 5 Step 1). Jeder Punkt bekommt das Datum.

- [ ] **Step 5: CLAUDE.md ergänzen (nicht committen — gitignoriert, #110)**

Ein kurzer Abschnitt, der auf `.claude/routing.md` zeigt und die drei Dinge nennt, die man
nicht aus dem Diff liest: dass `effort:` nur in Agentendateien setzbar ist (das `Agent`-Werkzeug
kennt den Parameter nicht), dass der Haupt-Loop sein Modell nicht wechseln kann, und dass
`ultracode` die Phasen-Modelle **nicht** von selbst setzt.

- [ ] **Step 6: Review-Kette auf diese Arbeit selbst anwenden**

Das System prüft sich hier zum ersten Mal an sich selbst:
1. `superpowers:requesting-code-review` über den Branch — mit `pruefer-gegnerisch`.
2. Dessen Bericht nach `review-modell-routing.md`.
3. Erst dann `gh pr create` — die Sperre aus Task 4 muss jetzt **durchlassen**. Tut sie es
   nicht, ist sie falsch gebaut, und das fällt genau im richtigen Moment auf.
4. CodeRabbit am PR.

- [ ] **Step 7: Offene Punkte als Issues**

Was am Ende offen bleibt, wird ein GitHub-Issue mit Fundstelle, Wirkung und Fundweg
(`befund`-Skill). Absehbare Kandidaten:
- Der Haupt-Loop klassifiziert unbeaufsichtigt (Spec §8) — messbar machen?
- `routing-lint.sh` prüft Existenz, nicht Aktivierung (Grenze im Kopf der Datei benannt).
- Die sechs globalen Agentendateien liegen ausserhalb der Versionskontrolle; die Kopie unter
  `docs/superpowers/routing-agenten/` kann von ihnen abweichen, ohne dass es jemand merkt.
