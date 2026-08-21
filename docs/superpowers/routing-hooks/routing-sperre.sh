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
# Fehlalarmen wird abgeschaltet — teurer als diese Luecke. Siehe Pruefung 8 im Selbsttest.
#
# Umgebungs-Praefixe (`GH_TOKEN=x gh pr create`) sind dagegen KEINE Luecke, sondern die
# normale Schreibweise desselben Befehls — sie stehen deshalb in der Ankerklasse, nicht nur
# im Kommentar (Fixture-Review Runde 2, 2026-08-21: `GH_TOKEN=abc123 gh pr create` lief
# unerkannt durch, weil die Erkennung selbst nie bis zu "gh" vordrang). `zuweisungen*` deckt
# beliebig viele `NAME=wert`-Praefixe ab, inklusive KEIN_REVIEW=1 — der Fluchtweg-Check
# unten verlangt zusaetzlich, dass KEIN_REVIEW=1 das LETZTE Praefix vor "gh" ist
# (`GH_TOKEN=x KEIN_REVIEW=1 gh pr create` wirkt also, `KEIN_REVIEW=1 GH_TOKEN=x gh pr
# create` nicht) — eine bewusste, kleine Grenze statt eines Nebeneffekts. Ein Praefix AN der
# Variable (`xKEIN_REVIEW=1`) ist eine andere Variable und triggert nichts: die Zuweisungs-
# Gruppe verschluckt das ganze Token, das Literal `KEIN_REVIEW=1` findet dahinter keine
# zweite Gelegenheit.
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
# Shell-Trenner, gefolgt von beliebig vielen `NAME=wert`-Praefixen. Ohne den Anker schlaegt
# der Waechter auch bei Kommandos an, die den Text nur ERWAEHNEN.
#
# Der WERT einer Zuweisung ist entweder unquotiert (kein Leerraum, kein Anfuehrungszeichen)
# oder quotiert — und quotiert kommt in ZWEI Formen an, weil hier Roh-JSON gelesen wird, nicht
# die Kommandozeile: ein echtes `"` im Befehl steht im JSON als `\"` (Fixture-Review Runde 3,
# 2026-08-21: `GH_TOKEN="abc123" gh pr create` schlüpfte durch, weil die alte Wertklasse am
# ersten `"` abbrach und danach keine zweite Anker-Gelegenheit blieb). Beide Formen decken
# auch ein eingebettetes Leerzeichen im Wert ab (`GH_TOKEN="abc 123"`), ohne den Rest des
# Befehls zu verschlucken — die Wertklasse endet exakt am schliessenden Anfuehrungszeichen.
anker='("command":[[:space:]]*"|[;&|(]|^)[[:space:]]*'
wert='(\\"[^"]*\\"|"[^"]*"|[^[:space:]"]*)'
zuweisungen="([A-Za-z_][A-Za-z0-9_]*=${wert}[[:space:]]+)*"
printf '%s' "$roh" | grep -Eq "${anker}${zuweisungen}gh[[:space:]]+pr[[:space:]]+create([[:space:]\"]|\$)" || exit 0

# Derselbe Anker + dieselben fuehrenden Zuweisungen wie oben, aber KEIN_REVIEW=1 ist danach
# PFLICHT statt Teil der freien Gruppe — es muss das letzte Praefix vor "gh" sein. Ein
# blosses `grep -q 'KEIN_REVIEW=1'` (frueher hier) fand die Zeichenkette IRGENDWO im
# Roh-JSON und schaltete die Sperre auch dann ab, wenn KEIN_REVIEW=1 nur in einer
# Commit-Message oder einem Kommentar zufaellig genannt wurde (Fixture-Review Runde 1).
printf '%s' "$roh" | grep -Eq "${anker}${zuweisungen}KEIN_REVIEW=1[[:space:]]+gh[[:space:]]+pr[[:space:]]+create([[:space:]\"]|\$)" && exit 0

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
