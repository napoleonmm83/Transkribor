#!/bin/bash
# Welche Fassung ist die letzte? Gibt die HOECHSTE `vX.Y.Z` unter den von <ref>
# erreichbaren Tags aus.
#
#   fassung.sh [ref]        # Vorgabe: HEAD
#
# Kein Treffer ⇒ leere Ausgabe, Rueckgabewert 0. Was das bedeutet, entscheidet der
# Aufrufer — im version-Job ist es ein Abbruch ("den ersten Tag bitte von Hand setzen"),
# im veroeffentlichen-Job faellt der Bereich auf `HEAD` zurueck. Dieselbe Aufteilung wie
# bei `notizen.sh lesen`.
#
# Eigene Datei statt einer Zeile im Workflow-Rumpf, aus demselben Grund wie bei
# versionshoehe.sh und notizen.sh nebenan: fassung.test.sh prueft GENAU das, was im
# Release laeuft. Hier wiegt es besonders, denn dieser Wert waehlt den Bereich, aus dem
# versionshoehe.sh die naechste Versionsnummer rechnet — eine falsch berechnete Version
# bekommt man nach dem Veroeffentlichen nicht zurueck.
#
# WARUM NICHT `git describe --tags --abbrev=0 --match 'v[0-9]*'` (so stand es bis #472 an
# beiden Aufrufstellen): ein Glob kann „genau drei Zahlenglieder" nicht ausdruecken.
# `v0.50.0-build123` erfuellt auch ein verschaerftes `v[0-9]*.[0-9]*.[0-9]*` — und genau so
# heissen die Testbau-Releases (`veroeffentlichen`: `v<version>-build<Laufnummer>`).
# Solange so ein Bau ein Draft bleibt, entsteht kein Tag; wird er einmal veroeffentlicht,
# entsteht er, und ab da rechnete versionshoehe.sh still aus dem falschen Bereich —
# meist „nichts zu veroeffentlichen" oder eine zu kleine Stufe. `modelle-v1` faellt schon
# durch das alte Muster, ein kuenftiges `v2-modelle` nicht mehr. Der regulaere Ausdruck
# unten kann beides.
#
# DER PREIS, benannt: `describe --abbrev=0` liefert den NAECHSTGELEGENEN Tag, diese
# Auswahl die HOECHSTE Fassung unter den Vorfahren. Heute dasselbe Ergebnis (beide
# v0.50.1, nachgemessen). Sie fallen erst auseinander, wenn ein niedriger nummerierter Tag
# naeher an HEAD liegt als ein hoeherer — dann ist die hoechste Fassung die richtigere
# Antwort: aus dem naechstgelegenen wuerden sonst Commits erneut gezaehlt, die im hoeheren
# Release laengst drin sind.
set -euo pipefail

ref="${1:-HEAD}"

# `|| true` ist tragend, nicht Vorsicht: findet grep nichts, endet es mit 1, und
# `pipefail` machte daraus einen Abbruch statt der leeren Ausgabe, die beide
# Aufrufstellen erwarten. Es deckt zugleich einen unbrauchbaren <ref> ab (`HEAD^` in
# einem Repo mit einem einzigen Commit) — genau wie das `2>/dev/null || true` vorher.
# Anders als dort bleibt git's Meldung aber SICHTBAR: sie steht im Lauf-Protokoll,
# statt still verschluckt zu werden.
#
# `--merged` haelt Tags von unfusionierten Zweigen draussen — dieselbe Reichweite, die
# `describe` ueber die Vorfahren hatte.
git tag --merged "$ref" --sort=-v:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | head -n 1 || true
