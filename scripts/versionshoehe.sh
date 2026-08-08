#!/bin/bash
# Wie hoch muss die Version steigen? Liest die Commit-Typen seit <ref> (Conventional
# Commits) und gibt major | minor | patch | "" aus. Leer heisst: nichts zu veroeffentlichen.
#
# Eigene Datei statt einer Handvoll Zeilen im Workflow, damit versionshoehe.test.sh GENAU
# das prueft, was auch laeuft — eine Kopie im Test wuerde irgendwann davon abweichen und
# waere dann schlimmer als kein Test. Die Entscheidung ist es wert: eine faelschlich als
# major veroeffentlichte Version bekommt man nicht zurueck.
set -euo pipefail

seit="${1:?Aufruf: versionshoehe.sh <ref>}"
log="$(git log --format='%s%n%b' "$seit"..HEAD)"

if   grep -qE '^[a-z]+(\([^)]*\))?!:|^BREAKING CHANGE' <<< "$log"; then echo major
elif grep -qE '^feat(\([^)]*\))?:'                     <<< "$log"; then echo minor
elif grep -qE '^(fix|perf)(\([^)]*\))?:'               <<< "$log"; then echo patch
else echo ""; fi
