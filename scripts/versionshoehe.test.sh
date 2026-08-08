#!/bin/bash
# Prueft versionshoehe.sh gegen echte Commits in einem Wegwerf-Repo.
# Aufruf: bash scripts/versionshoehe.test.sh
set -u
SKRIPT="$(cd "$(dirname "$0")" && pwd)/versionshoehe.sh"

W="$(mktemp -d)"; cd "$W" || exit 1
git init -q .; git config user.email t@t; git config user.name t

FEHLER=0
commit() { git commit -q --allow-empty -m "$1" ${2:+-m "$2"}; }
pruef() {
  ist="$(bash "$SKRIPT" v0)"
  if [ "$ist" = "$1" ]; then echo "  ok   $2 -> '${ist:-(nichts)}'"
  else echo "  FEHL $2 -> erwartet '$1', bekommen '$ist'"; FEHLER=1; fi
}

commit "chore: start"; git tag v0

commit "docs: readme"; commit "chore(ci): pin"
pruef "" "nur chore/docs"

commit "fix(setup): ffmpeg dort suchen, wo winget es hinlegt"
pruef "patch" "+ fix"

commit "feat(electron): Protokolldatei"
pruef "minor" "+ feat gewinnt gegen fix"

commit "feat(api)!: Endpunkt entfernt"
pruef "major" "+ feat! gewinnt gegen feat"

cd "$W" && git reset -q --hard v0
commit "fix: kleinigkeit" "BREAKING CHANGE: Format geaendert"
pruef "major" "BREAKING CHANGE im Rumpf schlaegt fix"

cd /; rm -rf "$W"
if [ "$FEHLER" = 0 ]; then echo "versionshoehe: alle Faelle ok"; else echo "versionshoehe: FEHLGESCHLAGEN"; fi
exit "$FEHLER"
