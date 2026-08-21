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
# BEKANNTE, BEWUSSTE Luecke (Fixture-Review, 2026-08-21): der Anker prueft eine Textposition
# im Roh-JSON, keine echte Shell-Auswertung. `bash -c "gh pr create"`, `sh -c '...'` und ein
# voller Pfad (`/usr/bin/gh pr create`) laufen deshalb OHNE Review durch. Die Ankerklasse
# `[;&|(]` absichtlich NICHT um `"` oder `/` erweitern: jedes zusaetzliche Zeichen dort erhoeht
# die Fehlalarmrate (echte Woerter, die zufaellig danebenstehen), und ein Waechter mit
# Fehlalarmen wird abgeschaltet — teurer als diese Luecke. Siehe Pruefung 6 im Selbsttest.
#
# Selbsttest:
#   bash .claude/hooks/routing-sperre.test.sh
#   echo '{"tool_input":{"command":"gh pr create"}}' | bash .claude/hooks/routing-sperre.sh; echo $?  # 2

cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}" || exit 0

roh=$(cat)

# Roh-JSON, ohne Parser: ein Waechter, der von einem Interpreter im PATH abhaengt, faellt
# STILL aus, sobald sich der PATH aendert — das war hier schon einmal der Fall (der Satz
# "python fehlt im Git-Bash-PATH, Exit 127" stand hier, uebernommen aus
# kein-pauschales-add.sh; nachgemessen am 2026-08-21 ist python inzwischen wieder im PATH).
# `grep` bleibt trotzdem die richtige Wahl, mit dem Grund, der traegt, nicht mit einer
# Momentaufnahme.
# Der Anker verlangt Befehlsposition: direkt hinter "command":" oder hinter einem
# Shell-Trenner, optional mit vorangestelltem KEIN_REVIEW=1. Ohne ihn schlaegt der Waechter
# auch bei Kommandos an, die den Text nur ERWAEHNEN.
printf '%s' "$roh" | grep -Eq '("command":[[:space:]]*"|[;&|(]|^)[[:space:]]*(KEIN_REVIEW=1[[:space:]]+)?gh[[:space:]]+pr[[:space:]]+create([[:space:]"]|$)' || exit 0

# Derselbe Anker wie oben, aber KEIN_REVIEW=1 ist hier PFLICHT statt optional — die
# Praefix-Gruppe muss unmittelbar vor "gh pr create" stehen. Ein blosses `grep -q
# 'KEIN_REVIEW=1'` (frueher hier) fand die Zeichenkette IRGENDWO im Roh-JSON und schaltete
# die Sperre auch dann ab, wenn KEIN_REVIEW=1 nur in einer Commit-Message oder einem
# Kommentar zufaellig genannt wurde (Fixture-Review, 2026-08-21).
printf '%s' "$roh" | grep -Eq '("command":[[:space:]]*"|[;&|(]|^)[[:space:]]*KEIN_REVIEW=1[[:space:]]+gh[[:space:]]+pr[[:space:]]+create([[:space:]"]|$)' && exit 0

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
