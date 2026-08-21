#!/usr/bin/env bash
# Selbsttest fuer routing-sperre.sh — BEIDE Richtungen.
# Ein Waechter, der immer sperrt, ist derselbe Schaden spiegelverkehrt (#197).
set -u
cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}" || exit 1
H=.claude/hooks/routing-sperre.sh
fehler=0

lauf() { printf '%s' "$1" | bash "$H" >/dev/null 2>&1; echo $?; }
PR='{"tool_input":{"command":"gh pr create --fill"}}'

# Trap-Selbsttest ZUERST, isoliert in einem Wegwerfordner: die Wiederherstellung unten
# haengt an einem trap auf EXIT — der muss auch bei einem ABBRUCH mitten im Lauf feuern,
# nicht nur beim sauberen Skriptende. Ohne diese Probe waere der trap unten ungeprueft.
strap_tmp=$(mktemp -d)
: > "$strap_tmp/review-trapfang.md"
(
  cd "$strap_tmp" || exit 1
  itmp=$(mktemp -d)
  mv review-*.md "$itmp"/ 2>/dev/null
  trap 'mv "$itmp"/review-*.md . 2>/dev/null; rmdir "$itmp" 2>/dev/null' EXIT
  exit 1  # simulierter Abbruch mitten im Lauf, nicht das saubere Skriptende
)
[ -f "$strap_tmp/review-trapfang.md" ] \
  || { echo "FAIL: trap stellt bei einem Abbruch nicht wieder her" >&2; fehler=1; }
rm -rf "$strap_tmp"

# Aufraeumen, damit der Test nicht vom Zufall lebt: ein liegengebliebenes
# review-*.md aus echter Arbeit wuerde den Sperrfall gruen machen.
tmp=$(mktemp -d); mv review-*.md "$tmp"/ 2>/dev/null
# trap statt eines einzelnen Aufraeum-Aufrufs am Ende: bricht DIESER Testlauf dazwischen
# ab (Signal, ein frueher `exit`), blieben Marcus' echten Berichte sonst im Wegwerfordner
# liegen statt im Projektstamm — es sind echte Arbeitsergebnisse ohne Sicherung.
trap 'mv "$tmp"/review-*.md . 2>/dev/null; rmdir "$tmp" 2>/dev/null' EXIT

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

# 6. KEIN_REVIEW=1 in einer Commit-Message (nicht als Praefix) -> sperrt TROTZDEM
#    (Fixture-Review, 2026-08-21: ein unangebundenes `grep -q 'KEIN_REVIEW=1'` fand die
#    Zeichenkette IRGENDWO im Roh-JSON und schaltete die Sperre versehentlich ab)
[ "$(lauf '{"tool_input":{"command":"git commit -m \"KEIN_REVIEW=1 rejected\" && gh pr create"}}')" = "2" ] \
  || { echo "FAIL: Commit-Message-Erwaehnung von KEIN_REVIEW=1 wirkt als Fluchtweg" >&2; fehler=1; }

# 7. KEIN_REVIEW=1 in einem Kommentar vor dem Befehl (nicht als Praefix) -> sperrt TROTZDEM
[ "$(lauf '{"tool_input":{"command":"echo note about KEIN_REVIEW=1; gh pr create"}}')" = "2" ] \
  || { echo "FAIL: Kommentar-Erwaehnung von KEIN_REVIEW=1 wirkt als Fluchtweg" >&2; fehler=1; }

# 8. `bash -c "gh pr create"` -> laesst durch (BEKANNTE, BEWUSSTE Luecke, siehe Kommentar in
#    routing-sperre.sh: der Anker prueft eine Textposition, keine echte Shell-Auswertung.
#    Die Ankerklasse wird NICHT erweitert, weil das die Fehlalarmrate erhoeht — diese Probe
#    haelt die Grenze fest, statt sie unausgesprochen zu lassen)
[ "$(lauf '{"tool_input":{"command":"bash -c \"gh pr create\""}}')" = "0" ] \
  || { echo "FAIL: bash -c wird jetzt erfasst - Kommentar in routing-sperre.sh nachziehen" >&2; fehler=1; }

# 9. `GH_TOKEN=abc123 gh pr create` -> sperrt (Fixture-Review Runde 2, 2026-08-21: ein
#    Umgebungs-Praefix ist die normale Schreibweise desselben Befehls und hebelte bisher die
#    ERKENNUNG selbst aus, nicht nur den Fluchtweg — die Detektions-Regex kam nie bei "gh" an)
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN=abc123 gh pr create"}}')" = "2" ] \
  || { echo "FAIL: Umgebungs-Praefix umgeht die Erkennung" >&2; fehler=1; }

# 10. Ein zweites Umgebungs-Praefix -> sperrt ebenso (keine Zufallstreffer auf GH_TOKEN)
[ "$(lauf '{"tool_input":{"command":"GIT_PAGER=cat gh pr create"}}')" = "2" ] \
  || { echo "FAIL: GIT_PAGER-Praefix umgeht die Erkennung" >&2; fehler=1; }

# 11. `GH_TOKEN=x KEIN_REVIEW=1 gh pr create` -> laesst durch (bewusste Entscheidung: der
#     Fluchtweg wirkt, wenn KEIN_REVIEW=1 das LETZTE Praefix vor "gh" ist, auch wenn ihm
#     andere Zuweisungen vorausgehen -- siehe Kommentar in routing-sperre.sh)
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN=x KEIN_REVIEW=1 gh pr create"}}')" = "0" ] \
  || { echo "FAIL: Fluchtweg wirkt nicht mehr mit vorangestelltem Umgebungs-Praefix" >&2; fehler=1; }

# 12. `xKEIN_REVIEW=1 gh pr create` -> sperrt (ein Praefix AN der Variable ist eine ANDERE
#     Variable; der Fluchtweg darf nicht ueber einen Namensteiltreffer ausloesen)
[ "$(lauf '{"tool_input":{"command":"xKEIN_REVIEW=1 gh pr create"}}')" = "2" ] \
  || { echo "FAIL: xKEIN_REVIEW=1 wird faelschlich als Fluchtweg erkannt" >&2; fehler=1; }

[ $fehler -eq 0 ] && echo "OK"
exit $fehler
