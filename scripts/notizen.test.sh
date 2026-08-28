#!/bin/bash
# Prueft notizen.sh an einer echten Notizdatei in einem Wegwerf-Verzeichnis.
# Aufruf: bash scripts/notizen.test.sh
set -u
SKRIPT="$(cd "$(dirname "$0")" && pwd)/notizen.sh"

W="$(mktemp -d)"; cd "$W" || exit 1
FEHLER=0

pruef() {  # pruef <erwartet> <ist> <name>
  if [ "$1" = "$2" ]; then echo "  ok   $3"
  else
    echo "  FEHL $3"
    echo "       erwartet: $(printf '%s' "$1" | head -3 | tr '\n' '|')"
    echo "       bekommen: $(printf '%s' "$2" | head -3 | tr '\n' '|')"
    FEHLER=1
  fi
}

frisch() {  # legt die Beispieldatei neu an
  cat > NOTIZEN.md <<'EOF'
# Release-Notizen

Erklaerender Vorspann, der nicht mitwandern darf.

## Unveröffentlicht

**Neu**
- Eine Zeile mit Umlauten: Grösse, Änderung, `Backticks` und *Sternchen*.

**Behoben**
- Zweite Zeile.

## v0.49.1 — 2026-08-28

**Neu**
- Alte Zeile.

## v0.48.1 — 2026-08-27

**Behoben**
- Noch aeltere Zeile.
EOF
}

echo "— lesen —"
frisch
pruef "$(printf '**Neu**\n- Alte Zeile.')" "$(bash "$SKRIPT" lesen NOTIZEN.md v0.49.1)" \
  "Archivabschnitt per Praefix (Datum muss nicht mitgetippt werden)"

pruef "$(printf '**Neu**\n- Eine Zeile mit Umlauten: Grösse, Änderung, `Backticks` und *Sternchen*.\n\n**Behoben**\n- Zweite Zeile.')" \
  "$(bash "$SKRIPT" lesen NOTIZEN.md 'Unveröffentlicht')" \
  "Unveroeffentlicht: innere Leerzeile bleibt, Umlaute unveraendert"

pruef "" "$(bash "$SKRIPT" lesen NOTIZEN.md v9.9.9)" "unbekannter Abschnitt ⇒ leer"

# Der Praefix-Treffer darf nicht zu grosszuegig sein: "v0.4" ist KEIN Abschnitt.
pruef "" "$(bash "$SKRIPT" lesen NOTIZEN.md v0.4)" "Praefix trifft nur ganze Ueberschriften"

# Der Workflow liest beim Testbau mit TAG=vX.Y.Z-buildN. Trifft das einen Versionsabschnitt,
# bekaeme ein Testbau den Text einer fremden Fassung — und Weg 2 (`## Unveröffentlicht`)
# waere nie erreichbar, also auch die Pruefbarkeit dieser Mechanik nicht.
pruef "" "$(bash "$SKRIPT" lesen NOTIZEN.md v0.49.1-build42)"   "ein Testbau-Tag (vX.Y.Z-buildN) trifft KEINEN Versionsabschnitt"

pruef "" "$(bash "$SKRIPT" lesen gibt-es-nicht.md v0.49.1)" "fehlende Datei ⇒ leer, kein Fehler"
bash "$SKRIPT" lesen gibt-es-nicht.md v0.49.1 >/dev/null 2>&1
pruef "0" "$?" "fehlende Datei ⇒ Rueckgabewert 0"

echo "— fassungen —"
frisch
pruef "$(printf '%s\n' 'v0.49.1' 'v0.48.1')" "$(bash "$SKRIPT" fassungen NOTIZEN.md)" \
  "Fassungen in Dateireihenfolge, nur der Versionsteil"
pruef "0" "$(bash "$SKRIPT" fassungen NOTIZEN.md | grep -c 'Unveröffentlicht')" \
  "'Unveröffentlicht' ist KEINE Fassung und steht nicht in der Liste"
pruef "" "$(bash "$SKRIPT" fassungen gibt-es-nicht.md)" "fehlende Datei ⇒ leere Liste"

echo "— rotieren —"
frisch
bash "$SKRIPT" rotieren NOTIZEN.md v0.50.0 2026-08-29 >/dev/null 2>&1
pruef "" "$(bash "$SKRIPT" lesen NOTIZEN.md 'Unveröffentlicht')" \
  "nach der Rotation ist Unveroeffentlicht leer"
pruef "$(printf '**Neu**\n- Eine Zeile mit Umlauten: Grösse, Änderung, `Backticks` und *Sternchen*.\n\n**Behoben**\n- Zweite Zeile.')" \
  "$(bash "$SKRIPT" lesen NOTIZEN.md v0.50.0)" \
  "der Rumpf steht byte-genau unter der neuen Fassung"
pruef "$(printf '**Neu**\n- Alte Zeile.')" "$(bash "$SKRIPT" lesen NOTIZEN.md v0.49.1)" \
  "die aelteren Abschnitte bleiben unangetastet"
pruef "$(printf '## Unveröffentlicht\n## v0.50.0 — 2026-08-29\n## v0.49.1 — 2026-08-28\n## v0.48.1 — 2026-08-27')" \
  "$(grep '^## ' NOTIZEN.md)" "Reihenfolge: neu direkt unter Unveroeffentlicht"
pruef "1" "$(grep -c 'Erklaerender Vorspann' NOTIZEN.md)" "der Vorspann wandert nicht mit"

# Zweimal rotieren darf nicht doppelt einfuegen.
bash "$SKRIPT" rotieren NOTIZEN.md v0.51.0 2026-08-30 >/dev/null 2>&1
pruef "0" "$(grep -c '^## v0.51.0' NOTIZEN.md)" \
  "leerer Abschnitt ⇒ KEIN leerer Versionsabschnitt im Archiv"

echo "— Randfaelle —"
printf '# Titel\n\n## Unveröffentlicht\n' > LEER.md
bash "$SKRIPT" rotieren LEER.md v1.0.0 2026-09-01 >/dev/null 2>&1
pruef "0" "$?" "leere Notiz ist kein Fehler (Rueckgabewert 0)"
pruef "0" "$(grep -c '^## v1.0.0' LEER.md)" "und legt keinen Abschnitt an"

printf '# Titel\n\n## v1.0.0 — 2026-01-01\n\n- x\n' > OHNE.md
bash "$SKRIPT" rotieren OHNE.md v1.1.0 2026-09-01 >/dev/null 2>&1
pruef "0" "$?" "fehlendes 'Unveröffentlicht' ⇒ derselbe Ausstieg wie ein leerer Abschnitt"
pruef "$(printf '# Titel\n\n## v1.0.0 — 2026-01-01\n\n- x')" "$(cat OHNE.md)" \
  "die Datei bleibt dabei unveraendert"

# Ein Windows-Pfad in Backticks ist hier der Normalfall (die README schreibt staendig
# `projekte\<NAME>\audio\`). Ueber `awk -v` gereicht wuerde daraus "projekte", ein
# Zeilenumbruch, "eu", ein BEL-Zeichen, "udio" — die Rotation waere nicht byte-genau.
# Die Zeile steht als LITERAL in einer Variablen und geht per `printf '%s\n'` durch — nicht
# als Formatstring mit Escapes. Sonst haengt die Aussagekraft dieses Tests daran, dass beim
# naechsten Anfassen jemand `\\n` statt `\n` tippt, und ein Test ohne Backslashes im Rumpf
# waere hier stumm.
ZEILE='- Pfad `projekte\neu\audio` und ein `\t` bleiben stehen.'
printf '%s\n' '# Titel' '' '## Unveröffentlicht' '' '**Behoben**' "$ZEILE" > BS.md
bash "$SKRIPT" rotieren BS.md v2.0.0 2026-09-02 >/dev/null 2>&1
pruef "$(printf '%s\n' '**Behoben**' "$ZEILE")" \
  "$(bash "$SKRIPT" lesen BS.md v2.0.0)" \
  "Backslashes ueberleben die Rotation byte-genau"

# Ein unsichtbares Leerzeichen hinter der Ueberschrift: `_lesen` findet den Rumpf per Praefix,
# also greift die "leer oder fehlt"-Wache NICHT. Verglich `rotieren` exakt, passierte gar
# nichts — Rueckgabewert 0, keine Meldung, und das Archiv rotierte nie wieder.
printf '# Titel\n\n## Unveröffentlicht \n\n- Eine Zeile.\n' > TS.md
bash "$SKRIPT" rotieren TS.md v3.0.0 2026-09-03 >/dev/null 2>&1
pruef "1" "$(grep -c '^## v3.0.0' TS.md)" "Ueberschrift mit Leerzeichen am Ende rotiert trotzdem"
pruef "- Eine Zeile." "$(bash "$SKRIPT" lesen TS.md v3.0.0)" "und der Rumpf landet unter der neuen Fassung"

# Hier stand bis zuletzt das GEGENTEIL: eine Leerzeilen-Glaettung samt Test darauf. Gemessen
# aendert sie an einer sauberen Datei gar nichts (identisches Ergebnis, kein Diff) und wirkt
# nur in dem einen Fall, in dem sie schadet — sie dampfte eine Doppel-Leerzeile IM Notiztext
# ein und machte damit die Zusage „byte-genau" unwahr.
printf '%s\n' '# Titel' '' '## Unveröffentlicht' '' '**Neu**' '- Eins.' '' '' \
  '- Zwei, nach zwei Leerzeilen.' '' '## v0.1.0 — 2026-01-01' '' '- alt' > GL.md
bash "$SKRIPT" rotieren GL.md v4.0.0 2026-09-04 >/dev/null 2>&1
pruef "$(printf '%s\n' '**Neu**' '- Eins.' '' '' '- Zwei, nach zwei Leerzeilen.')" \
  "$(bash "$SKRIPT" lesen GL.md v4.0.0)" \
  "eine Doppel-Leerzeile im Notiztext ueberlebt die Rotation"

# `lesen` auf eine fehlende Datei ist kein Fehler (oben geprueft), `rotieren` schon: dort
# waere es ein stiller Ausfall im Release-Lauf statt einer fehlenden Notiz.
bash "$SKRIPT" rotieren gibt-es-nicht.md v5.0.0 2026-09-05 >/dev/null 2>&1
pruef "1" "$?" "rotieren auf eine fehlende Datei ⇒ Rueckgabewert 1"

echo "— body (sammelt aus gescheiterten Laeufen ein) —"
# `gh` wird gefaelscht und nach VORNE in den PATH gelegt. Die Zustandstabelle kommt ueber die
# Umgebung; alles, was in keiner Liste steht, gilt als "release not found".
mkdir -p bin
cat > bin/gh <<'GHEOF'
#!/bin/bash
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  t="$3"
  case " ${VEROEFFENTLICHT:-} " in *" $t "*) echo false; exit 0;; esac
  case " ${DRAFTS:-} "          in *" $t "*) echo true;  exit 0;; esac
  case " ${APIFEHLER:-} "       in *" $t "*) echo "connection reset by peer" >&2; exit 1;; esac
  echo "release not found"; exit 1
fi
exit 0
GHEOF
chmod +x bin/gh
PATH="$PWD/bin:$PATH"; export PATH

printf '%s\n' '# Release-Notizen' '' '## Unveröffentlicht' '' \
  '## v0.52.0 — 2026-09-01' '' '**Neu**' '- Eigene Fassung.' '' \
  '## v0.51.0 — 2026-08-31' '' '**Behoben**' '- Aus dem ersten roten Bau.' '' \
  '## v0.50.0 — 2026-08-30' '' '**Behoben**' '- Aus dem zweiten roten Bau.' '' \
  '## v0.49.1 — 2026-08-28' '' '**Neu**' '- Laengst veroeffentlicht.' > BODY.md

angehaengt() { bash "$SKRIPT" body BODY.md v0.52.0 2>/dev/null | grep -c '^_aus ' || true; }

VEROEFFENTLICHT="v0.51.0" DRAFTS="" APIFEHLER="" ; export VEROEFFENTLICHT DRAFTS APIFEHLER
pruef "0" "$(angehaengt)" "Vorgaenger veroeffentlicht ⇒ nur der eigene Abschnitt"

VEROEFFENTLICHT="v0.50.0"
pruef "1" "$(angehaengt)" "Vorgaenger ohne Release ⇒ sein Abschnitt haengt an"
pruef "$(printf '%s\n' '**Neu**' '- Eigene Fassung.' '' '_aus v0.51.0 — Markierung ohne Download_' '' '**Behoben**' '- Aus dem ersten roten Bau.')" \
  "$(bash "$SKRIPT" body BODY.md v0.52.0 2>/dev/null)" \
  "und zwar in dieser Reihenfolge, mit der Markierung dazwischen"

VEROEFFENTLICHT="v0.49.1"
pruef "2" "$(angehaengt)" "zwei ohne Release ⇒ beide, dann Stopp am veroeffentlichten"

VEROEFFENTLICHT="v0.50.0" DRAFTS="v0.51.0"
pruef "1" "$(angehaengt)" "ein DRAFT zaehlt als unveroeffentlicht — Nutzer sehen ihn nicht"

# Negativkontrolle: eine unklare API-Antwort darf NICHT als "unveroeffentlicht" durchgehen,
# sonst haengt eine Netzstoerung wildfremde Abschnitte an den Release-Text.
VEROEFFENTLICHT="" DRAFTS="" APIFEHLER="v0.51.0"
bash "$SKRIPT" body BODY.md v0.52.0 >/dev/null 2>&1
pruef "1" "$?" "API-Fehler ⇒ Rueckgabewert 1 statt eines geratenen Textes"
pruef "" "$(bash "$SKRIPT" body BODY.md v0.52.0 2>/dev/null)" "und KEIN halber Body auf stdout"
unset VEROEFFENTLICHT DRAFTS APIFEHLER

echo "— ersatzliste (wenn niemand eine Notiz geschrieben hat) —"
# Ein echtes Wegwerf-Repo: der Unterbefehl liest `git log`, eine Attrappe waere hier sinnlos.
mkdir -p rp && cd rp || exit 1
git init -q . && git config user.email t@t && git config user.name t
echo x > x && git add x && git commit -qm "chore: start" >/dev/null && git tag -a v1.0.0 -m v1.0.0
for f in "feat(a): neue Sache" "fix: behoben" "perf: schneller" "refactor!: umgebaut" \
         "chore(deps)!: gehoben" "chore: aufgeraeumt" "docs: Anleitung" "test: mehr Tests"; do
  git commit -q --allow-empty -m "$f"
done
git commit -q --allow-empty -m "docs: Umstellung" -m "BREAKING CHANGE: alles anders"

# Die Auswahl MUSS zu versionshoehe.sh passen. Faende sie einen `refactor!:`-Commit nicht,
# veroeffentlichte ein HAUPTversionssprung die Aenderungsliste „(keine)".
drin() { bash "$SKRIPT" ersatzliste v1.0.0..HEAD | grep -c -F -- "$1"; }
pruef "1" "$(drin 'feat(a): neue Sache')"   "feat steht drin"
pruef "1" "$(drin 'fix: behoben')"          "fix steht drin"
pruef "1" "$(drin 'perf: schneller')"       "perf steht drin"
pruef "1" "$(drin 'refactor!: umgebaut')"   "jeder Typ mit ! steht drin — sonst Hauptsprung mit leerer Liste"
pruef "1" "$(drin 'chore(deps)!: gehoben')" "auch mit Bereich vor dem !"
pruef "1" "$(drin 'docs: Umstellung')"      "BREAKING CHANGE im RUMPF wird gefunden"
pruef "0" "$(drin 'chore: aufgeraeumt')"    "reines Aufraeumen bleibt draussen"
pruef "0" "$(drin 'docs: Anleitung')"       "Doku bleibt draussen"
pruef "0" "$(drin 'test: mehr Tests')"      "Testarbeit bleibt draussen"
pruef "1" "$(bash "$SKRIPT" ersatzliste v1.0.0..HEAD | grep -c 'keine Release-Notiz geschrieben')" \
  "der Ersatz ist als Ersatz gekennzeichnet"
git tag -a v2.0.0 -m v2.0.0
pruef "1" "$(bash "$SKRIPT" ersatzliste v2.0.0..HEAD | grep -c '^_(keine)_$')" \
  "leerer Bereich ⇒ '(keine)' statt einer leeren Zeile"
cd "$W" || exit 1

cd /; rm -rf "$W"
[ "$FEHLER" = 0 ] && echo "alle Faelle ok" || echo "FEHLER"
exit "$FEHLER"
