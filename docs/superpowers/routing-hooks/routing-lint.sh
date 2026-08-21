#!/usr/bin/env bash
# Drift-Waechter ueber die Routing-Tafel: zeigt jeder genannte Agent und Skill noch irgendwohin?
#
# WARUM: die Tafel nennt ~15 Skills und 8 Agenten. Wird einer umbenannt, zeigt sie STILL ins
# Leere — dieselbe Klasse wie "eine fest verdrahtete Liste waere in drei Monaten falsch",
# die in CLAUDE.md dreimal steht. Ein Lauf, ein Exitcode.
#
# GRENZE, benannt: geprueft wird EXISTENZ (Verzeichnis- bzw. Dateiname unter den Plugin-/
# Skill-Pfaden), nicht ob der Skill aktiviert oder das Plugin eingeschaltet ist. Ein
# abgeschalteter Skill gilt hier als da. Ein Skill kann als Verzeichnis (skills/<name>/)
# ODER als Befehlsdatei (commands/<name>.md) existieren — gemessen an `coderabbit-review`,
# das nur als commands/coderabbit-review.md vorliegt, kein Verzeichnis ist.
#
# Zwei Namen sind darueber hinaus per Hand ausgenommen: `ctx7` ist ein CLI-Tool
# (~/.claude/rules/context7.md), kein Skill; `claude-api` ist ein eingebauter Skill dieser
# Umgebung ohne eigenes Verzeichnis unter ~/.claude. Beide am 2026-08-21 von Hand verifiziert
# (in der Skill-Liste der Sitzung vorhanden, auf der Platte nicht auffindbar) — das ist eine
# EXISTENZ-Ausnahme fuer zwei bekannte Faelle, keine Abschwaechung der Pruefung.
#
# FORM-PRUEFUNG, VORSORGLICH: reine Spaltenposition scheitert, sobald zwei Tabellen
# unterschiedlicher Breite in derselben Datei stehen — Spalte 3 ist dann mal "Wer", mal
# etwas anderes, und aus einem Eintrag wie "kein `model`-Schlüssel" wuerde der Scheinagent
# `model`. Diese Form kommt in DIESER Datei (nur eine Tabelle je Tafel) nicht vor — ungeprueft
# ist das nicht, es ist eine Haertung gegen eine Form, die in vergleichbaren Markdown-Dateien
# vorkommt. Deshalb wird jeder Treffer zusaetzlich gegen eine Namensform geprueft; was nicht
# wie ein Agent- oder Skill-Name aussieht, wird verworfen statt gemeldet.
#
# Selbsttest:
#   bash .claude/hooks/routing-lint.sh            # Exit 0, wenn die Tafel sauber ist
#   sed -i 's/`umsetzer`/`gibtsnicht`/' ~/.claude/routing.md && bash .claude/hooks/routing-lint.sh  # Exit 1

cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}" || exit 0
fehler=0

tafeln="$HOME/.claude/routing.md .claude/routing.md"

AGENT_RE='^[a-z][a-z0-9-]+$'
SKILL_RE='^[a-z][a-z0-9-]+(:[a-z][a-z0-9-]+)?$'

# Spalte 3 = "Wer", Spalte 5 = "Pflicht-Skill". Die Tabellenform ist der Vertrag;
# ein eigener Markdown-Parser waere mehr Code als die Sache wert.
namen() {  # $1 = Spaltennummer, $2 = Namensform-Regex
  for t in $tafeln; do
    [ -f "$t" ] || continue
    awk -F'|' -v c="$1" '/^\|/ {gsub(/^[ \t]+|[ \t]+$/,"",$c); print $c}' "$t"
  done | grep -o '`[^`]*`' | tr -d '`' | grep -Ex "$2" | sort -u
}

for a in $(namen 3 "$AGENT_RE"); do
  [ -f "$HOME/.claude/agents/$a.md" ] || [ -f ".claude/agents/$a.md" ] || {
    echo "TOTER AGENT in der Tafel: $a" >&2; fehler=1; }
done

for s in $(namen 5 "$SKILL_RE"); do
  # ctx7/claude-api existieren wirklich, sind aber nicht datei-/verzeichnisbasiert
  # auffindbar (siehe Kopfkommentar) — echte Ausnahme, kein Formfilter-Rest.
  case "$s" in ctx7|claude-api) continue ;; esac
  kurz="${s##*:}"    # 'superpowers:brainstorming' -> 'brainstorming'
  # `node_modules` ist AUSGESCHLOSSEN, und das ist keine Vorsichtsmassnahme: `-type d -name`
  # macht jedes gleichnamige Verzeichnis unter den drei Suchwurzeln zu einem gueltigen Skill,
  # und unter `~/.claude/skills/gstack/node_modules` liegen 207 npm-Pakete. Gemessen: `semver`
  # und `undici` — reine npm-Pakete, die kein Mensch je als Skill genannt hat — wurden vom
  # alten Aufruf mit je 1 Treffer BESTAETIGT, mit dem Ausschluss sind es 0. Ein Waechter, der
  # von einer Abhaengigkeit befriedigt wird, meldet gruen fuer einen toten Eintrag — das ist
  # schlimmer als kein Waechter. (Den Anlass, `playwright`, faengt der Ausschluss NICHT: das
  # loest zusaetzlich ueber sein Plugin-Wurzelverzeichnis auf. Deshalb steht es nicht mehr in
  # der Skill-Spalte der Tafel — ein MCP-Server ist kein Skill. Zwei Wege, zwei Fixes.)
  find "$HOME/.claude/plugins/cache" "$HOME/.claude/skills" ".claude/skills" \
       -maxdepth 6 -not -path '*/node_modules/*' \
       \( -type d -name "$kurz" -o -type f -name "$kurz.md" \) 2>/dev/null \
       | grep -q . || {
    echo "TOTER SKILL in der Tafel: $s" >&2; fehler=1; }
done

[ $fehler -eq 0 ] && echo "Tafel sauber."
exit $fehler
