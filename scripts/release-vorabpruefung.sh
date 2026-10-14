#!/bin/bash
# Vorbedingungen vor Versionswechsel und Tag; beide Modi schreiben nichts.
# readme [README.md] | lauf <Commit-SHA> <Branch>
set -euo pipefail
fehler() { printf 'release-vorabpruefung: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  readme)
    datei="${2:-README.md}"
    [ -f "$datei" ] && [ -r "$datei" ] || fehler "README nicht lesbar: $datei"
    # Markdown-Hervorhebung und weiche Zeilenumbrueche aendern den Hinweis
    # fuer den Leser nicht. Lesefehler separat vom grep-Leerfall behandeln.
    if ! text="$(LC_ALL=C sed -E -e 's/ / /g' -e 's/ / /g' -e 's/&nbsp;/ /g' \
      -e 's/&#(0*160|0*8239|[xX]0*[aA]0|[xX]0*202[fF]);/ /g' \
      -e 's/^[[:blank:]]*>[[:blank:]>]*//' "$datei" | tr -d '*_`' | tr '\r\n' '  ')"; then
      fehler 'README konnte nicht normalisiert werden'
    fi
    rc=0
    # In C matcht -i nur ASCII. Die beiden UTF-8-Schreibweisen stehen deshalb
    # ausdruecklich daneben; eine Zeichenklasse [aä] zerlegt dort den Umlaut.
    treffer="$(LC_ALL=C grep -Eio 'n(ae|ä|Ä)chste[nr]?[[:space:]]+Fassung(en)?([[:space:][:punct:]]|„|“|”|«|»|‘|’|…|–|—|$)' <<< "$text")" || rc=$?
    case "$rc" in
      0) printf '%s\n' "$treffer" >&2; fehler 'README traegt noch einen Hinweis auf die naechste Fassung' ;;
      1) printf 'release-vorabpruefung: README ohne Platzhalter\n' ;;
      *) fehler 'README-Pruefung fehlgeschlagen' ;;
    esac
    ;;
  lauf)
    sha="${2:-}"; branch="${3:-}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fehler 'vollstaendige Commit-SHA fehlt'
    [[ -n "$branch" && "$branch" != *$'\n'* && "$branch" != *$'\t'* ]] || fehler 'Branch fehlt oder ist ungueltig'
    # Kein --status success: sonst koennte ein alter Erfolg einen neueren
    # laufenden oder fehlgeschlagenen Wiederholungslauf verdecken.
    if ! antwort="$(gh run list --workflow test.yml --commit "$sha" --branch "$branch" \
      --event push --limit 1 --json headSha,event,headBranch,status,conclusion \
      --jq 'if length == 0 then "" else .[0] | [.headSha, .event, .headBranch, .status, .conclusion] | @tsv end')"; then
      fehler 'Testlauf konnte nicht abgefragt werden'
    fi
    [ -n "$antwort" ] || fehler "kein Push-Testlauf fuer $sha auf $branch"
    [[ "$antwort" != *$'\n'* ]] || fehler 'mehrdeutige Testlauf-Antwort'
    # read/IFS wuerde leere TSV-Felder zusammenziehen. Nur die vollstaendige
    # positive Antwort darf freigeben, auch ihre Spaltenzahl muss stimmen.
    erwartet="$sha"$'\tpush\t'"$branch"$'\tcompleted\tsuccess'
    [[ "$antwort" = "$erwartet" ]] \
      || fehler 'Testlauf passt nicht zu Commit/Branch/Push oder ist nicht erfolgreich abgeschlossen'
    printf 'release-vorabpruefung: Tests fuer %s auf %s erfolgreich\n' "$sha" "$branch"
    ;;
  *) fehler 'Aufruf: release-vorabpruefung.sh readme [README.md] | lauf <Commit-SHA> <Branch>' ;;
esac
