#!/bin/bash
# Traegt die Mindest-macOS-Version in eine `latest-mac.yml` ein (#536).
# Aufruf: bash scripts/macos-mindest.sh <latest-mac.yml> [package.json]
#
# WARUM es dieses Skript gibt: electron-builder schreibt kein solches Feld. Nachpruefbar mit
#   grep -rn "minimumSystemVersion" node_modules/app-builder-lib/out/publish/updateInfoBuilder.js
# (kein Treffer, gemessen an 26.15.3). Zum Vergleich: `macPackager.js` kennt das Feld sehr wohl,
# schreibt es aber nur ins Info.plist und nur, wenn man es konfiguriert. Ohne den Eintrag in der
# yml weiss der Mac-Zweig des Updaters nicht, dass eine Fassung auf diesem Rechner gar nicht
# startet, und bietet sie trotzdem an (#536).
#
# WARUM als Skript und nicht als Zeilen im Workflow: dieselbe Begruendung wie bei
# `versionshoehe.sh`, `notizen.sh` und `fassung.sh` — nur so prueft `macos-mindest.test.sh`
# genau das, was im Release laeuft. Und wie jene laeuft es an DREI Stellen: im `version`-Job,
# in der Bau-Matrix und in `test.yml`.
#
# WARUM `minimumMacosVersion` und nicht electron-updaters `minimumSystemVersion`: dessen
# Vergleich laeuft gegen `os.release()`, also gegen eine DARWIN-Version (macOS 13 = Darwin 22).
# In einer Datei, die Menschen beim Release lesen, waere das eine stehende Falle. Der Mac-Zweig
# des Updaters laeuft an electron-updater ohnehin vorbei (Auto-Update ist ohne Notarisierung
# tot), also gewinnt Lesbarkeit. Entscheidung Marcus, 2026-09-03.
set -u

YML="${1:-}"
PAKET="${2:-$(cd "$(dirname "$0")/.." && pwd)/package.json}"

[ -n "$YML" ] || { echo "Aufruf: $0 <latest-mac.yml> [package.json]" >&2; exit 2; }
[ -f "$YML" ]   || { echo "macos-mindest: $YML gibt es nicht" >&2; exit 1; }
[ -f "$PAKET" ] || { echo "macos-mindest: $PAKET gibt es nicht" >&2; exit 1; }

# Ueber `process.argv` statt in den JS-Quelltext interpoliert: ein Pfad mit Anfuehrungszeichen
# oder Backslash zerlegte sonst das Programm, statt gelesen zu werden.
#
# `readFileSync`, NICHT `require`: `require` verlangt bei einem relativen Pfad ein `./` und
# scheitert sonst mit „Cannot find module". Nachpruefbar in einem leeren Verzeichnis mit einer
# `p.json` darin:
#   node -e 'try{require(process.argv[1])}catch(e){console.log(e.message.split("\n")[0])}' p.json
# Der Aufrufer soll den Pfad aber schreiben duerfen, wie er will — `macos-mindest.test.sh`
# uebergibt genau solche relativen Pfade, der Fall ist also nicht theoretisch. Und der
# Fehlerkanal bleibt OFFEN: mit `2>/dev/null` sah ein Lesefehler aus wie „Feld fehlt", und
# genau daran ging die erste Fassung dieses Skripts in die Irre (Testfall 7b haelt es fest).
MELDUNG="$(mktemp)"
voll="$(node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String((((d.build||{}).mac||{}).minimumSystemVersion)||""))' "$PAKET" 2>"$MELDUNG")"
node_rc=$?
lesefehler="$(head -n 2 "$MELDUNG")"; rm -f "$MELDUNG"
[ "$node_rc" = 0 ] || { echo "macos-mindest: $PAKET liess sich nicht lesen: $lesefehler" >&2; exit 1; }

# Leer oder krumm ist ein ABBRUCH, kein stilles Weiterlaufen: ein Release ohne das Feld ist
# genau der Fehler, den dieses Skript verhindern soll — er faellt sonst erst dem Nutzer auf,
# dessen Mac die Fassung nicht startet.
case "$voll" in
  '' ) echo "macos-mindest: build.mac.minimumSystemVersion fehlt in $PAKET" >&2; exit 1 ;;
  *[!0-9.]* ) echo "macos-mindest: build.mac.minimumSystemVersion ist '$voll', erwartet Ziffern und Punkte" >&2; exit 1 ;;
esac
haupt="${voll%%.*}"
[ -n "$haupt" ] || { echo "macos-mindest: aus '$voll' laesst sich keine Hauptversion lesen" >&2; exit 1; }

zeile="minimumMacosVersion: $haupt"

# Erst die alte Zeile heraus, dann die neue ans Ende — idempotent, und es vertraegt eine Datei
# ohne abschliessenden Zeilenumbruch (ein blosses `>>` klebte die Zeile sonst an die letzte).
{ grep -v '^minimumMacosVersion:' "$YML"; printf '%s\n' "$zeile"; } > "$YML.neu" && mv -f "$YML.neu" "$YML"

# Die Probe aufs Exempel: `version` ist das Feld, an dem der Updater die Fassung erkennt. Waere
# es beim Umschreiben verlorengegangen, meldete der Mac-Zweig „latest-mac.yml ohne Version" —
# und wir haetten den Updater repariert, indem wir ihn kaputtmachen.
grep -q '^version:' "$YML" || { echo "macos-mindest: $YML hat nach dem Schreiben keine version-Zeile mehr" >&2; exit 1; }
grep -c '^minimumMacosVersion:' "$YML" | grep -qx 1 || { echo "macos-mindest: $YML traegt die Zeile nicht genau einmal" >&2; exit 1; }

echo "$zeile"
