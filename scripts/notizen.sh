#!/bin/bash
# Liest und rotiert die Abschnitte von RELEASE-NOTIZEN.md.
#
# Eigene Datei statt einer Handvoll Zeilen im Workflow — aus demselben Grund wie bei
# versionshoehe.sh nebenan: `notizen.test.sh` prueft GENAU das, was im Release laeuft.
# Eine Kopie im Test wuerde irgendwann davon abweichen und waere dann schlimmer als kein Test.
# Hier wiegt das doppelt, denn was diese Zeilen ausgeben, LIEST DER NUTZER als Release-Text.
#
#   notizen.sh lesen    <datei> <abschnitt>
#       Gibt den Rumpf des Abschnitts aus (ohne Ueberschrift, ohne Leerzeilen am Rand).
#       `<abschnitt>` ist der ANFANG der Ueberschrift: "v0.49.1" findet "## v0.49.1 — 2026-08-28".
#       Nicht gefunden oder leer ⇒ leere Ausgabe, Rueckgabewert 0. Der Aufrufer entscheidet,
#       was ein leerer Abschnitt bedeutet — hier ist es kein Fehler.
#
#   notizen.sh fassungen <datei>
#       Listet die Fassungen in Dateireihenfolge (neuste zuerst), je nur "vX.Y.Z".
#       Ohne "## Unveröffentlicht" — das ist keine Fassung.
#
#   notizen.sh body <datei> <tag>
#       Der fertige Release-Text zu <tag>: dessen Abschnitt, plus jeden AELTEREN Abschnitt,
#       zu dem es kein veroeffentlichtes Release gibt (Stopp beim ersten, das eines hat).
#       Braucht `gh` auf dem PATH. Ohne eigenen Abschnitt: leere Ausgabe, Rueckgabewert 0 —
#       der Aufrufer nimmt dann seinen Rueckfall. Bei unklarer API-Antwort: Rueckgabewert 1.
#       Der Grund fuer diesen Unterbefehl ist derselbe wie fuer die ganze Datei: so prueft
#       notizen.test.sh GENAU die Logik, die im Release laeuft, statt eine Kopie davon.
#
#   notizen.sh ersatzliste <bereich>
#       Der Text, wenn NIEMAND eine Notiz geschrieben hat: die Commit-Titel im Bereich,
#       gefiltert nach demselben Typ-Satz wie versionshoehe.sh, mit einer Zeile davor, die
#       das Fehlen benennt. Den Bereich waehlt der Aufrufer — beim echten Release zeigt der
#       eben gesetzte Tag auf HEAD, beim Testbau nicht.
#
#   notizen.sh rotieren <datei> <version> <datum>
#       Verschiebt den Rumpf von "## Unveröffentlicht" unter eine neue Ueberschrift
#       "## <version> — <datum>" und laesst "## Unveröffentlicht" leer stehen.
#       Schreibt die Datei an Ort und Stelle. Ist der Abschnitt leer, entsteht KEIN
#       leerer Versionsabschnitt — ein Release ohne Notiz soll im Archiv nicht so aussehen,
#       als haette jemand eine geschrieben.
set -euo pipefail

# Ohne '## ' — die Ueberschrift baut `trifft` daraus, und der Name steht damit EINMAL.
UNVEROEFFENTLICHT='Unveröffentlicht'

# Die Ueberschrift wird per PRAEFIX getroffen, damit der Datumszusatz ("— 2026-08-28") nicht
# mitgetippt werden muss; ein Praefix-Treffer verlangt aber, dass danach Zeilenende oder ein
# Leerzeichen kommt — sonst faende "v0.4" auch "v0.49.1".
#
# Das Praedikat steht EINMAL und wird in beide awk-Programme gereicht. Leser und Schreiber
# duerfen nicht auseinanderfallen: solange `rotieren` exakt verglich und `_lesen` per Praefix,
# reichte EIN unsichtbares Leerzeichen hinter "## Unveröffentlicht", damit `_lesen` den Rumpf
# findet (also die "leer oder fehlt"-Wache nicht greift), `rotieren` die Ueberschrift aber nie
# trifft: Rueckgabewert 0, keine Meldung, kein neuer Abschnitt — und ab da rotiert das Archiv
# nie wieder, waehrend jedes Release alle aufgelaufenen Notizen erneut mitveroeffentlicht.
_TRIFFT='
function trifft(zeile, gesucht,   rest) {
  if (zeile !~ /^## /) return 0
  rest = substr(zeile, 4)
  return (rest == gesucht || index(rest, gesucht " ") == 1)
}'

# Rumpf eines Abschnitts ausgeben.
_lesen() {
  awk -v ziel="$2" "$_TRIFFT"'
    BEGIN { drin = 0 }
    {
      if ($0 ~ /^## /) { drin = trifft($0, ziel); next }
      if (drin) print
    }
  ' "$1" | awk '
    # Leerzeilen am Anfang und Ende weg, innere bleiben (sie trennen die drei Bloecke).
    { zeilen[NR] = $0 }
    END {
      a = 1; e = NR
      while (a <= e && zeilen[a] ~ /^[[:space:]]*$/) a++
      while (e >= a && zeilen[e] ~ /^[[:space:]]*$/) e--
      for (i = a; i <= e; i++) print zeilen[i]
    }
  '
}

# Die Fassungs-Ueberschriften in DATEIREIHENFOLGE, je nur der Versionsteil
# ("## v0.50.0 — 2026-08-29" ⇒ "v0.50.0"). Neuste zuerst, weil die Rotation oben einfuegt.
# `## Unveröffentlicht` ist bewusst NICHT dabei: das ist keine Fassung, und ein Aufrufer
# soll sie nicht versehentlich als eine behandeln.
_fassungen() {
  awk '/^## v/ { rest = substr($0, 4); sub(/[[:space:]].*$/, "", rest); print rest }' "$1"
}

# Gibt es zu einer Fassung ein veroeffentlichtes Release? Drei Antworten, und die dritte ist
# die wichtige: ein API-Fehler darf NICHT als „unveroeffentlicht" durchgehen, sonst haengt
# eine Netzstoerung wildfremde Abschnitte an den Release-Text. Ein DRAFT zaehlt als
# unveroeffentlicht — `gh release view` findet ihn, ein Nutzer nicht.
_release_zustand() {
  local aus
  if aus="$(gh release view "$1" --json isDraft --jq '.isDraft' 2>&1)"; then
    if [ "$aus" = "true" ]; then echo fehlt; else echo veroeffentlicht; fi
  elif echo "$aus" | grep -qiE "release not found|404"; then
    echo fehlt
  else
    echo "notizen.sh: gh release view $1 scheiterte: $aus" >&2
    echo fehler
  fi
}

case "${1:-}" in
  ersatzliste)
    # Der Text, wenn NIEMAND eine Notiz geschrieben hat: die Commit-Titel im Bereich,
    # ausdruecklich als Ersatz markiert. Absichtlich unschoen — die Luecke soll im Release
    # sichtbar sein, statt dass jemand sie Stunden spaeter von Hand nachtraegt (#466).
    #
    # DERSELBE Typ-Satz wie in scripts/versionshoehe.sh, nicht eine zweite, engere Liste.
    # Sonst driften die beiden beim naechsten Anfassen auseinander, und zwar in die teuerste
    # Richtung: versionshoehe hebt bei JEDEM Typ mit `!` auf major, ein Filter aus
    # `feat|fix|perf` faende einen `refactor!:`-Commit aber nicht — ein Hauptversionssprung
    # mit der Aenderungsliste „(keine)".
    #
    # Den BEREICH waehlt der Aufrufer, nicht dieses Skript: beim echten Release zeigt der eben
    # gesetzte Tag auf HEAD (also `HEAD^`), beim Testbau nicht. Das ist Wissen ueber den Lauf,
    # nicht ueber die Notizen.
    bereich="${2:?Aufruf: notizen.sh ersatzliste <bereich>}"
    typen='^- ([a-z]+(\([^)]*\))?!:|(feat|fix|perf)(\([^)]*\))?:)'
    liste="$(git log --format='- %s' "$bereich" | grep -E "$typen" || true)"
    # versionshoehe.sh liest `%s%n%b` und hebt auch bei `BREAKING CHANGE` im RUMPF; `%s`
    # allein sieht das nicht. `--grep` sucht die ganze Nachricht ab.
    rumpf="$(git log --format='- %s' --extended-regexp --grep='^BREAKING CHANGE' "$bereich" || true)"
    liste="$(printf '%s\n%s\n' "$liste" "$rumpf" | grep -v '^$' | awk '!gesehen[$0]++' || true)"
    printf '%s\n\n%s\n' \
      '_Für diese Fassung wurde keine Release-Notiz geschrieben. Ersatzweise die technische Liste der Änderungen:_' \
      "${liste:-_(keine)_}"
    ;;

  lesen)
    datei="${2:?Aufruf: notizen.sh lesen <datei> <abschnitt>}"
    abschnitt="${3:?Aufruf: notizen.sh lesen <datei> <abschnitt>}"
    [ -f "$datei" ] || exit 0          # keine Datei ist wie kein Abschnitt: leer, kein Fehler
    _lesen "$datei" "$abschnitt"
    ;;

  fassungen)
    datei="${2:?Aufruf: notizen.sh fassungen <datei>}"
    [ -f "$datei" ] || exit 0
    _fassungen "$datei"
    ;;

  body)
    datei="${2:?Aufruf: notizen.sh body <datei> <tag>}"
    tag="${3:?Aufruf: notizen.sh body <datei> <tag>}"
    [ -f "$datei" ] || exit 0
    eigen="$(_lesen "$datei" "$tag")"
    [ -n "$eigen" ] || exit 0        # kein eigener Abschnitt ⇒ der Aufrufer nimmt seinen Rueckfall

    ergebnis="$eigen"
    gesehen=0
    while read -r fassung; do
      [ -n "$fassung" ] || continue
      # Alles OBERHALB der eigenen Fassung ist neuer und geht uns nichts an.
      if [ "$gesehen" = 0 ]; then
        if [ "$fassung" = "$tag" ]; then gesehen=1; fi
        continue
      fi
      zustand="$(_release_zustand "$fassung")"
      if [ "$zustand" = "fehler" ]; then
        echo "notizen.sh: Zustand von $fassung unbekannt — Abbruch statt Raten." >&2
        exit 1
      fi
      [ "$zustand" = "fehlt" ] || break     # ab hier ist alles veroeffentlicht
      aelter="$(_lesen "$datei" "$fassung")"
      [ -n "$aelter" ] || continue
      echo "notizen.sh: haenge $fassung an — dazu gibt es kein Release." >&2
      ergebnis="$(printf '%s\n\n_aus %s — Markierung ohne Download_\n\n%s\n' \
                         "$ergebnis" "$fassung" "$aelter")"
    done <<< "$(_fassungen "$datei")"
    # `<<<` statt einer Pipe: eine Pipe liefe in einer Subshell, und das `exit 1` oben
    # beendete dann nur diese — der Aufrufer bekaeme einen halben Body mit Rueckgabewert 0.

    printf '%s\n' "$ergebnis"
    ;;

  rotieren)
    datei="${2:?Aufruf: notizen.sh rotieren <datei> <version> <datum>}"
    version="${3:?Aufruf: notizen.sh rotieren <datei> <version> <datum>}"
    datum="${4:?Aufruf: notizen.sh rotieren <datei> <version> <datum>}"
    [ -f "$datei" ] || { echo "notizen.sh: $datei gibt es nicht" >&2; exit 1; }

    # Ein leerer Rumpf deckt BEIDE Faelle ab: der Abschnitt ist leer, oder es gibt ihn gar
    # nicht — `_lesen` liefert in beiden Faellen nichts. Deshalb steht weiter unten KEIN
    # zweiter "nicht gefunden"-Zweig: er waere unerreichbar, und ein Waechter, den kein Test
    # rot bekommt, ist Dekoration (dieselbe Regel wie bei der Musik-Wache in webtool/).
    rumpf="$(_lesen "$datei" "$UNVEROEFFENTLICHT")"
    if [ -z "$rumpf" ]; then
      echo "notizen.sh: '## $UNVEROEFFENTLICHT' ist leer oder fehlt — nichts zu rotieren." >&2
      exit 0
    fi

    # Der Rumpf reist ueber die UMGEBUNG, nicht ueber `-v`: POSIX unterzieht einen
    # `-v`-Wert (und eine Operanden-Zuweisung ebenso) der Escape-Verarbeitung eines
    # String-Literals. Eine Notizzeile mit einem Windows-Pfad in Backticks — in diesem Repo
    # der Normalfall — kommt dann zerlegt heraus: aus `projekte\neu\audio` wird
    # "projekte", ein Zeilenumbruch, "eu", ein BEL-Zeichen, "udio" (gemessen). Die Rotation
    # waere damit alles andere als byte-genau, und genau das sichert sie zu.
    # `ENVIRON` wird nicht escape-verarbeitet. Ueberschrift und Datum bleiben bei `-v`:
    # dort steht eine Versionsnummer, kein Nutzertext.
    neu="$(mktemp)"
    rumpf="$rumpf" awk -v kopf="$UNVEROEFFENTLICHT" -v neuk="## $version — $datum" "$_TRIFFT"'
      BEGIN { drin = 0 }
      {
        if (trifft($0, kopf)) {
          print $0; print ""            # der leere Abschnitt bleibt fuer den naechsten PR stehen
          print neuk; print ""; print ENVIRON["rumpf"]; print ""
          drin = 1
          next
        }
        if (drin) {
          if ($0 ~ /^## /) { drin = 0 } # ab der naechsten Ueberschrift wieder normal kopieren
          else next                     # der alte Rumpf ist oben schon geschrieben
        }
        print
      }
    ' "$datei" > "$neu"

    # KEINE Leerzeilen-Glaettung mehr. Sie stand hier, um die Datei aufgeraeumt zu halten —
    # gemessen aendert sie an einer sauberen Datei aber NICHTS (identisches Ergebnis, kein
    # Diff), und am einzigen Fall, in dem sie wirkt, ist sie schaedlich: eine Doppel-Leerzeile
    # IM Notiztext wurde eingedampft. „Byte-genau" waere damit unwahr gewesen, und zwar
    # ausgerechnet an der Zusicherung, die dieses Skript traegt.
    mv "$neu" "$datei"
    ;;

  *)
    echo "Aufruf: notizen.sh lesen|rotieren …" >&2
    exit 2
    ;;
esac
