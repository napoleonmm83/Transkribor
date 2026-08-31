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
pruef "v0.10.0" "" "der naehere Tag gewinnt"

# Gleichstand: zwei Fassungen auf DEMSELBEN Commit. Dann entscheidet die Sortierung, und
# sie muss nach Version gehen, nicht alphabetisch — lexikografisch waere v0.9.1 groesser
# als v0.10.1, und die Auswahl haenge sonst an der Auflistungsreihenfolge.
git tag v0.9.1; git tag v0.10.1
pruef "v0.10.1" "" "Gleichstand: die hoehere Fassung gewinnt (Versionssortierung)"
git tag -d v0.9.1 >/dev/null; git tag -d v0.10.1 >/dev/null

git checkout -q -b seite
commit "feat: nur auf dem Zweig"; git tag v9.9.9
git checkout -q -
# `--merged` haelt den Zweig draussen — dieselbe Reichweite wie `describe` ueber die
# Vorfahren. Ohne das Flag gewaenne der hoechste Tag des ganzen Repos.
pruef "v0.10.0" "" "Tag auf unfusioniertem Zweig zaehlt nicht"

# ---- Repo 3: der hoehere Tag ist der AELTERE -----------------------------------
# Der eine Fall, der „naechstgelegen" von „hoechste Fassung" unterscheidet — und ohne ihn
# ist die Auswahl unbewacht: eine Fassung dieses Skripts mit `--sort=-v:refname | head -n 1`
# liess ALLE anderen Faelle gruen. Entsteht durch einen Vertipper oder einen von Hand
# gesetzten Tag (`on: push: tags: ['v*']` unterstuetzt das). `describe` verhaelt sich hier
# genauso, und genau deshalb steht diese Zeile hier: sie haelt fest, dass #472 nur den
# FILTER verschaerft hat und nicht die Auswahl.
# Hier ANNOTIERT getaggt, weil die echten Release-Tags es sind (`git tag -a`,
# release.yml) — die anderen Faelle oben nutzen leichtgewichtige, damit beide Sorten
# vorkommen.
neues_repo; R3="$W"
commit "chore: start";  git tag -a v2.0.0 -m v2.0.0   # zu hoch, aus Versehen
commit "fix: danach";   git tag -a v1.5.0 -m v1.5.0   # die richtige, aktuelle Fassung
pruef "v1.5.0" "" "der naechstgelegene gewinnt, auch wenn ein aelterer Tag hoeher ist"

cd /; rm -rf "$R1" "$R2" "$R3"
if [ "$FEHLER" = 0 ]; then echo "fassung: alle Faelle ok"; else echo "fassung: FEHLGESCHLAGEN"; fi
exit "$FEHLER"
