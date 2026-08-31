#!/bin/bash
# Prueft fassung.sh gegen echte Tags in Wegwerf-Repos.
# Aufruf: bash scripts/fassung.test.sh
set -u
SKRIPT="$(cd "$(dirname "$0")" && pwd)/fassung.sh"

FEHLER=0
commit() { git commit -q --allow-empty -m "$1"; }
neues_repo() {
  W="$(mktemp -d)"; cd "$W" || exit 1
  git init -q .; git config user.email t@t; git config user.name t
}
pruef() {  # <erwartet> <ref oder leer> <name>
  if [ -n "$2" ]; then ist="$(bash "$SKRIPT" "$2")"; else ist="$(bash "$SKRIPT")"; fi
  if [ "$ist" = "$1" ]; then echo "  ok   $3 -> '${ist:-(nichts)}'"
  else echo "  FEHL $3 -> erwartet '$1', bekommen '$ist'"; FEHLER=1; fi
}

# ---- Repo 1: der Fall aus #472 ------------------------------------------------
neues_repo; R1="$W"
commit "chore: start";  git tag v1.0.0
commit "fix: etwas";    git tag v1.0.1-build7   # so heissen die Testbau-Releases
git tag modelle-v1                              # der Modell-Tag, den es wirklich gibt

# DER Fall: ein veroeffentlichter Testbau-Draft hinterlaesst `v<version>-build<N>`.
# `git describe --match 'v[0-9]*'` lieferte hier v1.0.1-build7 — und versionshoehe.sh
# rechnete ab einem Tag, der keine Fassung ist. Diese Zeile muss rot werden, wenn der
# strikte Ausdruck aus fassung.sh verschwindet.
pruef "v1.0.0" "" "Testbau-Tag v1.0.1-build7 zaehlt nicht als Fassung"

commit "feat: mehr";    git tag v2.0.0
pruef "v2.0.0" ""      "neue Fassung gewinnt"
# Das ref-Argument wirkt: HEAD^ traegt v2.0.0 nicht, uebrig bleibt v1.0.0 (v1.0.1-build7
# ist zwar Vorfahr, aber keine Fassung). Deckt die zweite Aufrufstelle ab, die mit
# HEAD bzw. HEAD^ kommt.
pruef "v1.0.0" "HEAD^" "ref-Argument schliesst den Tag auf HEAD aus"

# ---- Repo 2: Sortierung, Leerfall, unfusionierter Zweig -----------------------
neues_repo; R2="$W"
commit "chore: start"
pruef "" "" "kein Fassungs-Tag ⇒ leere Ausgabe"
# Und zwar OHNE Fehler: beide Aufrufstellen stehen unter `set -e` und behandeln den
# leeren Fall selbst. Ein Rueckgabewert != 0 wuerde den Release-Lauf abbrechen.
bash "$SKRIPT" >/dev/null 2>&1
rc=$?
if [ "$rc" = 0 ]; then echo "  ok   leerer Fall endet mit 0"
else echo "  FEHL leerer Fall endet mit $rc"; FEHLER=1; fi

git tag v0.9.0
commit "fix: weiter"; git tag v0.10.0
# Versionssortierung, nicht alphabetisch: lexikografisch waere v0.9.0 groesser.
pruef "v0.10.0" "" "v0.10.0 schlaegt v0.9.0 (Versionssortierung)"

git checkout -q -b seite
commit "feat: nur auf dem Zweig"; git tag v9.9.9
git checkout -q -
# `--merged` haelt den Zweig draussen — dieselbe Reichweite wie `describe` ueber die
# Vorfahren. Ohne das Flag gewaenne der hoechste Tag des ganzen Repos.
pruef "v0.10.0" "" "Tag auf unfusioniertem Zweig zaehlt nicht"

cd /; rm -rf "$R1" "$R2"
if [ "$FEHLER" = 0 ]; then echo "fassung: alle Faelle ok"; else echo "fassung: FEHLGESCHLAGEN"; fi
exit "$FEHLER"
