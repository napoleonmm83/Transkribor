#!/bin/bash
# Offline-Vertrag: echte Dateien und ein gh-Mock, ohne Token oder Netzwerk.
set -euo pipefail
SKRIPT="$(cd "$(dirname "$0")" && pwd)/release-vorabpruefung.sh"
W="$(mktemp -d)"
trap 'rm -f "$W/README.md" "$W/bin/gh" "$W/antwort" "$W/args"; rmdir "$W/bin" "$W"' EXIT
mkdir "$W/bin"
cat > "$W/bin/gh" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" > "$MOCK_ARGS"
cat "$MOCK_ANTWORT"
exit "${MOCK_RC:-0}"
EOF
chmod +x "$W/bin/gh"
export PATH="$W/bin:$PATH" MOCK_ANTWORT="$W/antwort" MOCK_ARGS="$W/args"
export MOCK_RC=0
SHA=0123456789abcdef0123456789abcdef01234567
FEHLER=0
pruef() {
  local erwartet="$1" name="$2" rc=0 aus
  shift 2
  aus="$(bash "$SKRIPT" "$@" 2>&1)" || rc=$?
  if [ "$rc" = "$erwartet" ]; then
    printf '  ok   %s\n' "$name"
  else
    printf '  FEHL %s: erwartet rc=%s, bekommen rc=%s\n%s\n' "$name" "$erwartet" "$rc" "$aus"
    FEHLER=1
  fi
}
for locale in C C.UTF-8; do
  for hinweis in 'ab der nächsten Fassung' 'ab der naechsten Fassung' 'AB DER NÄCHSTEN FASSUNG' 'AB DER NAECHSTEN FASSUNG'; do
    printf '%s\n' "$hinweis" > "$W/README.md"
    LC_ALL="$locale" pruef 1 "$locale: $hinweis" readme "$W/README.md"
  done
done
printf 'In dieser Fassung verfuegbar.\n' > "$W/README.md"
pruef 0 'README ohne Platzhalter' readme "$W/README.md"
printf 'ab der nächsten\nFassung\n' > "$W/README.md"
pruef 1 'umgebrochener Hinweis' readme "$W/README.md"
printf 'ab der **nächsten**\n**Fassung**\n' > "$W/README.md"
pruef 1 'hervorgehobener umgebrochener Hinweis' readme "$W/README.md"
printf 'Nächste Fassung\n' > "$W/README.md"
pruef 1 'nominativer Hinweis' readme "$W/README.md"
printf 'In naechster Fassung\n' > "$W/README.md"
pruef 1 'Hinweis ohne Artikel' readme "$W/README.md"
printf '> ab der nächsten\n> Fassung\n' > "$W/README.md"
pruef 1 'zitierter Hinweis' readme "$W/README.md"
printf 'in der nächsten Fassung\n' > "$W/README.md"
pruef 1 'geschuetztes Leerzeichen' readme "$W/README.md"
printf 'in der nächsten&nbsp;Fassung\n' > "$W/README.md"
pruef 1 'HTML-Leerzeichen' readme "$W/README.md"
printf 'Keine nächsten Fassungslosigkeiten\n' > "$W/README.md"
pruef 0 'anderes Wort mit Fassung-Praefix' readme "$W/README.md"
for ende in '“' '”' '»' '’' '…' '–' '—'; do
  printf '„ab der nächsten Fassung%s\n' "$ende" > "$W/README.md"
  pruef 1 'typografisches Satzzeichen' readme "$W/README.md"
done
pruef 1 'fehlende README' readme "$W/fehlt.md"
pruef 1 'Verzeichnis ist keine README' readme "$W"
for status in queued in_progress waiting pending requested; do
  printf '%s\tpush\tmaster\t%s\t\n' "$SHA" "$status" > "$W/antwort"
  pruef 1 "Lauf $status blockiert" lauf "$SHA" master
done
for urteil in failure cancelled skipped neutral timed_out action_required stale ''; do
  printf '%s\tpush\tmaster\tcompleted\t%s\n' "$SHA" "$urteil" > "$W/antwort"
  pruef 1 "Urteil ${urteil:-leer} blockiert" lauf "$SHA" master
done
: > "$W/antwort"
pruef 1 'kein Lauf blockiert' lauf "$SHA" master
printf '%s\tpush\tmaster\tcompleted\tsuccess\n' "$SHA" > "$W/antwort"
pruef 0 'abgeschlossener Erfolg' lauf "$SHA" master
for arg in --commit "$SHA" --branch master --event push --workflow test.yml --limit 1; do
  if ! grep -Fxq -- "$arg" "$W/args"; then echo "  FEHL gh-Argument fehlt: $arg"; FEHLER=1; fi
done
export MOCK_RC=1
pruef 1 'API-Fehler trotz Erfolgstext blockiert' lauf "$SHA" master
export MOCK_RC=0
for antwort in "fremd push master completed success" "$SHA pull_request master completed success" "$SHA push seite completed success"; do
  printf '%s\n' "$antwort" | tr ' ' '\t' > "$W/antwort"
  pruef 1 'fremder Lauf blockiert' lauf "$SHA" master
done
printf '%s\tpush\tmaster\tcompleted\tsuccess\n%s\tpush\tmaster\tcompleted\tsuccess\n' "$SHA" "$SHA" > "$W/antwort"
pruef 1 'mehrdeutige Antwort blockiert' lauf "$SHA" master
printf '%s\tpush\tmaster\t\tcompleted\tsuccess\n' "$SHA" > "$W/antwort"
pruef 1 'zusaetzliche leere TSV-Spalte blockiert' lauf "$SHA" master
printf '%s\tpush\tmaster\tcompleted\tsuccess\t\n' "$SHA" > "$W/antwort"
pruef 1 'leere TSV-Endspalte blockiert' lauf "$SHA" master
pruef 1 'ungueltiger Commit blockiert' lauf kurz master
pruef 1 'leerer Branch blockiert' lauf "$SHA" ''
pruef 1 'unbekannter Modus blockiert' unbekannt
if [ "$FEHLER" = 0 ]; then echo 'release-vorabpruefung: alle Faelle ok'; fi
exit "$FEHLER"
