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
#    daran scheitert die naive printf-Fassung ('%b' statt '%s'). Seit Task 3 traegt TAFEL
#    echte \n-Sequenzen und die Pruefung ist SCHARF: Mutationsprobe '%s'->'%b' vom
#    2026-08-21 belegt, dass sie dabei rot wird (vorher, mit dem Platzhalter ohne \n,
#    waere die Ausgabe bei '%b' byte-identisch gewesen — lief nur mit).
[ "$(printf '%s' "$aus" | wc -l)" -le 1 ] || { echo "FAIL: mehrzeilige Ausgabe" >&2; fehler=1; }

[ $fehler -eq 0 ] && echo "OK"
exit $fehler
