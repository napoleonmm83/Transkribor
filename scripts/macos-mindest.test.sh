#!/bin/bash
# Prueft macos-mindest.sh gegen echte Dateien in einem Wegwerf-Verzeichnis.
# Aufruf: bash scripts/macos-mindest.test.sh
set -u
SKRIPT="$(cd "$(dirname "$0")" && pwd)/macos-mindest.sh"

W="$(mktemp -d)"; cd "$W" || exit 1
FEHLER=0

gleich() { # $1 Beschreibung, $2 ist, $3 erwartet
  if [ "$2" = "$3" ]; then echo "  ok   $1"
  else echo "  FEHL $1 -> erwartet '$3', bekommen '$2'"; FEHLER=1; fi
}

paket() { printf '%s\n' "$2" > "$1"; }
GUT='{"build":{"mac":{"minimumSystemVersion":"13.0"}}}'

# So sieht die Datei aus, die electron-builder ablegt — gekuerzt, aber mit den Feldern, auf die
# es ankommt: `version` liest der Updater, `files`/`path` sind die Nachbarn, die erhalten bleiben.
yml() {
  cat > "$1" <<'ENDE'
version: 0.53.0
files:
  - url: Transkribor-arm64.dmg
    sha512: abc
    size: 123456
path: Transkribor-arm64.dmg
sha512: abc
releaseDate: '2026-09-03T19:00:00.000Z'
ENDE
}

echo "macos-mindest.test.sh"

# 1 — der Normalfall: Feld fehlt, wird angehaengt, alles andere bleibt stehen
paket p1.json "$GUT"; yml y1.yml
aus="$(bash "$SKRIPT" y1.yml p1.json 2>&1)"; rc=$?
gleich "Normalfall: Exit" "$rc" "0"
gleich "Normalfall: Meldung" "$aus" "minimumMacosVersion: 13"
gleich "Normalfall: Zeile steht drin" "$(grep -c '^minimumMacosVersion: 13$' y1.yml)" "1"
gleich "Normalfall: version bleibt" "$(grep -c '^version: 0.53.0$' y1.yml)" "1"
gleich "Normalfall: files bleibt" "$(grep -c '^files:$' y1.yml)" "1"
# Die Vorlage hat 8 Zeilen, danach sind es 9. Die erste Fassung dieses Tests erwartete hier 8
# und war GRUEN, solange das Skript scheiterte — eine Erwartung, die den Fehlerfall nicht vom
# Erfolgsfall unterscheidet, prueft nichts.
gleich "Normalfall: Zeilenzahl waechst um genau 1" "$(wc -l < y1.yml | tr -d ' ')" "9"

# 2 — idempotent: zweimal laufen aendert nichts mehr
bash "$SKRIPT" y1.yml p1.json >/dev/null 2>&1
gleich "zweiter Lauf: weiterhin genau eine Zeile" "$(grep -c '^minimumMacosVersion:' y1.yml)" "1"
gleich "zweiter Lauf: Zeilenzahl unveraendert" "$(wc -l < y1.yml | tr -d ' ')" "9"

# 3 — eine ALTE Zahl wird ersetzt, nicht ergaenzt. Ohne das truege die Datei zwei Wahrheiten,
#     und welche der Updater liest, entschiede die Lesereihenfolge.
paket p3.json "$GUT"; yml y3.yml; printf 'minimumMacosVersion: 12\n' >> y3.yml
bash "$SKRIPT" y3.yml p3.json >/dev/null 2>&1
gleich "alte Zahl: genau eine Zeile" "$(grep -c '^minimumMacosVersion:' y3.yml)" "1"
gleich "alte Zahl: und zwar die neue" "$(grep -c '^minimumMacosVersion: 13$' y3.yml)" "1"

# 4 — Datei ohne abschliessenden Zeilenumbruch. Ein blosses `>>` klebte die neue Zeile an die
#     letzte, und `path:` hiesse dann `path: Transkribor-arm64.dmgminimumMacosVersion: 13`.
paket p4.json "$GUT"; printf 'version: 0.53.0\npath: Transkribor-arm64.dmg' > y4.yml
bash "$SKRIPT" y4.yml p4.json >/dev/null 2>&1
gleich "ohne Zeilenumbruch: path bleibt heil" "$(grep -c '^path: Transkribor-arm64.dmg$' y4.yml)" "1"
gleich "ohne Zeilenumbruch: Zeile eigenstaendig" "$(grep -c '^minimumMacosVersion: 13$' y4.yml)" "1"

# 5 — nur die HAUPTversion wandert in die Datei: der Updater vergleicht macOS-Hauptversionen,
#     eine 13.5 dort waere eine Genauigkeit, die niemand einloest.
paket p5.json '{"build":{"mac":{"minimumSystemVersion":"14.5"}}}'; yml y5.yml
bash "$SKRIPT" y5.yml p5.json >/dev/null 2>&1
gleich "14.5 wird zu 14" "$(grep -c '^minimumMacosVersion: 14$' y5.yml)" "1"

# 6 — fehlt die Zahl in der package.json, ist das ein ABBRUCH. Stillschweigend weiterzulaufen
#     hiesse, genau die Datei zu veroeffentlichen, deren Fehlen #536 ausgemacht hat.
paket p6.json '{"build":{"mac":{}}}'; yml y6.yml
bash "$SKRIPT" y6.yml p6.json >/dev/null 2>&1; rc=$?
gleich "ohne minimumSystemVersion: Exit ungleich 0" "$([ "$rc" -ne 0 ] && echo ja || echo nein)" "ja"
gleich "ohne minimumSystemVersion: yml unangetastet" "$(grep -c '^minimumMacosVersion:' y6.yml)" "0"

# 7 — ein krummer Wert wird nicht geraten
paket p7.json '{"build":{"mac":{"minimumSystemVersion":"dreizehn"}}}'; yml y7.yml
bash "$SKRIPT" y7.yml p7.json >/dev/null 2>&1; rc=$?
gleich "krummer Wert: Exit ungleich 0" "$([ "$rc" -ne 0 ] && echo ja || echo nein)" "ja"

# 7b — kaputte package.json: der Lesefehler muss als LESEFEHLER herauskommen, nicht als
#      „Feld fehlt". Genau diese Verwechslung kostete beim Bauen dieses Skripts eine Runde,
#      weil der Fehlerkanal von node zugeklebt war.
printf '{"build":{"mac":{' > p7b.json; yml y7b.yml
aus="$(bash "$SKRIPT" y7b.yml p7b.json 2>&1)"; rc=$?
gleich "kaputte package.json: Exit ungleich 0" "$([ "$rc" -ne 0 ] && echo ja || echo nein)" "ja"
gleich "kaputte package.json: Meldung nennt das Lesen" "$(echo "$aus" | grep -c 'liess sich nicht lesen')" "1"

# 8 — fehlende yml ist ein Abbruch, keine neu angelegte Datei
paket p8.json "$GUT"
bash "$SKRIPT" gibtsnicht.yml p8.json >/dev/null 2>&1; rc=$?
gleich "fehlende yml: Exit ungleich 0" "$([ "$rc" -ne 0 ] && echo ja || echo nein)" "ja"
gleich "fehlende yml: wird nicht angelegt" "$([ -e gibtsnicht.yml ] && echo da || echo weg)" "weg"

# 9 — ohne Argument gibt es eine Aufrufhilfe, keinen stillen Erfolg
bash "$SKRIPT" >/dev/null 2>&1; rc=$?
gleich "ohne Argument: Exit ungleich 0" "$([ "$rc" -ne 0 ] && echo ja || echo nein)" "ja"

cd /; rm -rf "$W"
[ "$FEHLER" = 0 ] && echo "macos-mindest.test.sh: alles gruen" || echo "macos-mindest.test.sh: ROT"
exit "$FEHLER"
