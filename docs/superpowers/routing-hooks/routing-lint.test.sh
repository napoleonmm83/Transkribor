#!/usr/bin/env bash
# Selbsttest fuer routing-lint.sh — vor allem die ENGE der Skill-Ausloesung (Frage 4 im
# Rereview 2026-08-21): eine Plugin-Wurzel, git-Interna und ein Verzeichnis ohne Manifest
# duerfen einen Tafel-Eintrag nicht mehr bestaetigen.
#
# ISOLIERT IN EINER FIXTURE, nicht gegen Marcus' echtes ~/.claude: routing-lint.sh liest
# `$HOME/.claude/routing.md` und die Suchwurzeln `$HOME/.claude/plugins/cache`,
# `$HOME/.claude/skills` fest verdrahtet — nicht ueber CLAUDE_PROJECT_DIR umleitbar. Beide
# Variablen werden deshalb fuer den Testlauf auf dasselbe Wegwerfverzeichnis gelegt; das
# Skript selbst bleibt unangetastet und wird per ABSOLUTEM Pfad aufgerufen, damit die
# Wegwerf-cwd das Auffinden des Skripts nicht stoert.
set -u
H="E:/Git/Transkribor/.claude/hooks/routing-lint.sh"
fehler=0

FIX=$(mktemp -d)
trap 'rm -rf "$FIX"' EXIT
mkdir -p "$FIX/.claude/agents" \
         "$FIX/.claude/skills/echteskill" \
         "$FIX/.claude/skills/ohnemanifest" \
         "$FIX/.claude/plugins/cache/pluginX/commands" \
         "$FIX/.claude/plugins/cache/totewurzel" \
         "$FIX/.claude/plugins/cache/geklonesrepo/.git/hooks" \
         "$FIX/.claude/plugins/cache/geklonesrepo/.git/refs"
: > "$FIX/.claude/agents/agent-x.md"
: > "$FIX/.claude/skills/echteskill/SKILL.md"
: > "$FIX/.claude/plugins/cache/pluginX/commands/echtercommand.md"
# totewurzel: das Plugin-Wurzelverzeichnis selbst heisst wie ein Tafel-Eintrag, hat aber
# WEDER ein skills/<name>/-Manifest NOCH eine commands/<name>.md darunter — genau der alte
# Fehler (jede Plugin-Wurzel wurde vom blossen Namenstreffer bestaetigt).
: > "$FIX/.claude/plugins/cache/totewurzel/plugin.json"
# geklonesrepo/.git/{hooks,refs}: git-Interna aus einem der vollstaendigen Klone im
# Suchraum — kein Skill, aber vom alten `-name`-Treffer ebenso bestaetigt.

BASE="$FIX/.claude/routing.md"
cat > "$BASE" <<'EOF'
| Aufgabentyp | Wer | Modell · Effort | Pflicht-Skill |
|---|---|---|---|
| echt Verzeichnis+Manifest | `agent-x` | m | `echteskill` |
| echt Befehlsdatei | `agent-x` | m | `echtercommand` |
EOF

lauf() { HOME="$FIX" CLAUDE_PROJECT_DIR="$FIX" bash "$H" >/dev/null 2>&1; echo $?; }
# $1 = zu pruefender Name, angehaengt als eigene Tafelzeile; die Basiszeilen bleiben stehen
probe() {
  cp "$BASE" "$BASE.tmp"
  printf '| tote Zeile | `agent-x` | m | `%s` |\n' "$1" >> "$BASE.tmp"
  mv "$BASE.tmp" "$BASE"
  code=$(lauf)
  cp "$BASE.bak" "$BASE"
  echo "$code"
}
cp "$BASE" "$BASE.bak"

# 1. Saubere Fixture-Tafel -> Exit 0 (Positivkontrolle, ohne sie waeren 2-6 bedeutungslos)
[ "$(lauf)" = "0" ] || { echo "FAIL: saubere Fixture-Tafel meldet einen toten Skill" >&2; fehler=1; }

# 2. Plugin-Wurzel OHNE Manifest -> TOTER SKILL (der Kernbefund aus Frage 4)
[ "$(probe totewurzel)" = "1" ] \
  || { echo "FAIL: Plugin-Wurzel ohne skills/- oder commands/-Manifest wird noch bestaetigt" >&2; fehler=1; }

# 3-4. git-Interna aus einem Klon -> TOTER SKILL
[ "$(probe hooks)" = "1" ] \
  || { echo "FAIL: git-Interna 'hooks' wird noch bestaetigt" >&2; fehler=1; }
[ "$(probe refs)" = "1" ] \
  || { echo "FAIL: git-Interna 'refs' wird noch bestaetigt" >&2; fehler=1; }

# 5. skills/<name>/ OHNE SKILL.md/skill.md -> TOTER SKILL (Namensgleichheit reicht nicht
#    mehr, das Manifest ist Pflicht)
[ "$(probe ohnemanifest)" = "1" ] \
  || { echo "FAIL: skills/<name>/ ohne Manifest wird noch bestaetigt" >&2; fehler=1; }

# 6. Echter Skill (Verzeichnis + Manifest) -> weiterhin sauber (Gegenprobe zu 2/3/4/5: die
#    Verengung darf keinen echten Eintrag mitreissen)
[ "$(probe echteskill)" = "0" ] \
  || { echo "FAIL: echter Skill (Verzeichnis+Manifest) wird nicht mehr erkannt" >&2; fehler=1; }

# 7. Echte Befehlsdatei -> weiterhin sauber
[ "$(probe echtercommand)" = "0" ] \
  || { echo "FAIL: echte Befehlsdatei (commands/<name>.md) wird nicht mehr erkannt" >&2; fehler=1; }

[ $fehler -eq 0 ] && echo "OK"
exit $fehler
