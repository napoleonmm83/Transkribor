#!/usr/bin/env bash
# Selbsttest fuer routing-sperre.sh — BEIDE Richtungen.
# Ein Waechter, der immer sperrt, ist derselbe Schaden spiegelverkehrt (#197).
set -u
cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}" || exit 1
H=.claude/hooks/routing-sperre.sh
fehler=0

lauf() { printf '%s' "$1" | bash "$H" >/dev/null 2>&1; echo $?; }
PR='{"tool_input":{"command":"gh pr create --fill"}}'

# Trap-Selbsttest ZUERST, isoliert in einem Wegwerfordner: die Wiederherstellung unten
# haengt an einem trap auf EXIT — der muss auch bei einem ABBRUCH mitten im Lauf feuern,
# nicht nur beim sauberen Skriptende. Ohne diese Probe waere der trap unten ungeprueft.
strap_tmp=$(mktemp -d)
: > "$strap_tmp/review-trapfang.md"
(
  cd "$strap_tmp" || exit 1
  itmp=$(mktemp -d)
  mv review-*.md "$itmp"/ 2>/dev/null
  trap 'mv "$itmp"/review-*.md . 2>/dev/null; rmdir "$itmp" 2>/dev/null' EXIT
  exit 1  # simulierter Abbruch mitten im Lauf, nicht das saubere Skriptende
)
[ -f "$strap_tmp/review-trapfang.md" ] \
  || { echo "FAIL: trap stellt bei einem Abbruch nicht wieder her" >&2; fehler=1; }
rm -rf "$strap_tmp"

# Aufraeumen, damit der Test nicht vom Zufall lebt: ein liegengebliebenes
# review-*.md aus echter Arbeit wuerde den Sperrfall gruen machen.
tmp=$(mktemp -d); mv review-*.md "$tmp"/ 2>/dev/null
# trap statt eines einzelnen Aufraeum-Aufrufs am Ende: bricht DIESER Testlauf dazwischen
# ab (Signal, ein frueher `exit`), blieben Marcus' echten Berichte sonst im Wegwerfordner
# liegen statt im Projektstamm — es sind echte Arbeitsergebnisse ohne Sicherung.
trap 'mv "$tmp"/review-*.md . 2>/dev/null; rmdir "$tmp" 2>/dev/null' EXIT

# 1. Kein Review -> sperrt
[ "$(lauf "$PR")" = "2" ] || { echo "FAIL: sperrt nicht ohne Review" >&2; fehler=1; }

# 2. Fluchtweg -> laesst durch
[ "$(lauf '{"tool_input":{"command":"KEIN_REVIEW=1 gh pr create --fill"}}')" = "0" ] \
  || { echo "FAIL: Fluchtweg wirkt nicht" >&2; fehler=1; }

# 3. Fremder Befehl -> laesst durch (der Waechter darf nicht ueberall zuschlagen)
[ "$(lauf '{"tool_input":{"command":"git status"}}')" = "0" ] \
  || { echo "FAIL: sperrt einen fremden Befehl" >&2; fehler=1; }

# 4. Blosse ERWAEHNUNG -> laesst durch (Befehlspositions-Anker; genau hier ist
#    kein-pauschales-add.sh beim ersten Einsatz aufgelaufen)
[ "$(lauf '{"tool_input":{"command":"echo gh pr create > notiz.md"}}')" = "0" ] \
  || { echo "FAIL: schlaegt bei blosser Erwaehnung an" >&2; fehler=1; }

# 5. Review vorhanden -> laesst durch (die Negativkontrolle)
touch review-selbsttest.md
[ "$(lauf "$PR")" = "0" ] || { echo "FAIL: sperrt TROTZ Review" >&2; fehler=1; }
rm -f review-selbsttest.md

# 6. KEIN_REVIEW=1 in einer Commit-Message (nicht als Praefix) -> sperrt TROTZDEM
#    (Fixture-Review, 2026-08-21: ein unangebundenes `grep -q 'KEIN_REVIEW=1'` fand die
#    Zeichenkette IRGENDWO im Roh-JSON und schaltete die Sperre versehentlich ab)
[ "$(lauf '{"tool_input":{"command":"git commit -m \"KEIN_REVIEW=1 rejected\" && gh pr create"}}')" = "2" ] \
  || { echo "FAIL: Commit-Message-Erwaehnung von KEIN_REVIEW=1 wirkt als Fluchtweg" >&2; fehler=1; }

# 7. KEIN_REVIEW=1 in einem Kommentar vor dem Befehl (nicht als Praefix) -> sperrt TROTZDEM
[ "$(lauf '{"tool_input":{"command":"echo note about KEIN_REVIEW=1; gh pr create"}}')" = "2" ] \
  || { echo "FAIL: Kommentar-Erwaehnung von KEIN_REVIEW=1 wirkt als Fluchtweg" >&2; fehler=1; }

# 8. `bash -c "gh pr create"` -> laesst durch (BEKANNTE, BEWUSSTE Luecke, siehe Kommentar in
#    routing-sperre.sh: der Anker prueft eine Textposition, keine echte Shell-Auswertung.
#    Die Ankerklasse wird NICHT erweitert, weil das die Fehlalarmrate erhoeht — diese Probe
#    haelt die Grenze fest, statt sie unausgesprochen zu lassen)
[ "$(lauf '{"tool_input":{"command":"bash -c \"gh pr create\""}}')" = "0" ] \
  || { echo "FAIL: bash -c wird jetzt erfasst - Kommentar in routing-sperre.sh nachziehen" >&2; fehler=1; }

# 9. `GH_TOKEN=abc123 gh pr create` -> sperrt (Fixture-Review Runde 2, 2026-08-21: ein
#    Umgebungs-Praefix ist die normale Schreibweise desselben Befehls und hebelte bisher die
#    ERKENNUNG selbst aus, nicht nur den Fluchtweg — die Detektions-Regex kam nie bei "gh" an)
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN=abc123 gh pr create"}}')" = "2" ] \
  || { echo "FAIL: Umgebungs-Praefix umgeht die Erkennung" >&2; fehler=1; }

# 10. Ein zweites Umgebungs-Praefix -> sperrt ebenso (keine Zufallstreffer auf GH_TOKEN)
[ "$(lauf '{"tool_input":{"command":"GIT_PAGER=cat gh pr create"}}')" = "2" ] \
  || { echo "FAIL: GIT_PAGER-Praefix umgeht die Erkennung" >&2; fehler=1; }

# 11. `GH_TOKEN=x KEIN_REVIEW=1 gh pr create` -> laesst durch (bewusste Entscheidung: der
#     Fluchtweg wirkt, wenn KEIN_REVIEW=1 das LETZTE Praefix vor "gh" ist, auch wenn ihm
#     andere Zuweisungen vorausgehen -- siehe Kommentar in routing-sperre.sh)
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN=x KEIN_REVIEW=1 gh pr create"}}')" = "0" ] \
  || { echo "FAIL: Fluchtweg wirkt nicht mehr mit vorangestelltem Umgebungs-Praefix" >&2; fehler=1; }
# NICHT schaerfen (Fixture-Review Runde 3, 2026-08-21): ein stderr-basierter Nachweis, DASS
# der Durchlass ueber den Fluchtweg lief (statt weil der Haupttreffer gar nicht matcht), waere
# nachgerechnet WIRKUNGSLOS — beide Durchlasspfade sind still, nur der Sperr-Pfad schreibt auf
# stderr. Ein Debug-Marker im Skript nur fuer diesen einen Test waere Ueberbau; da Test 9/10/12
# dieselbe Mutation (Zuweisungsgruppe entfernt) bereits rot erkennen, geht dabei kein Schutz
# verloren. Absichtlich so belassen — nicht als Luecke „reparieren".

# 12. `xKEIN_REVIEW=1 gh pr create` -> sperrt (ein Praefix AN der Variable ist eine ANDERE
#     Variable; der Fluchtweg darf nicht ueber einen Namensteiltreffer ausloesen)
[ "$(lauf '{"tool_input":{"command":"xKEIN_REVIEW=1 gh pr create"}}')" = "2" ] \
  || { echo "FAIL: xKEIN_REVIEW=1 wird faelschlich als Fluchtweg erkannt" >&2; fehler=1; }

# 13. `KEIN_REVIEW=1 GH_TOKEN=x gh pr create` (Reihenfolge vertauscht) -> sperrt (Umkehrung
#     von Test 11: der Fluchtweg wirkt nur als LETZTES Praefix vor "gh", nicht irgendwo in der
#     Zuweisungskette — die Entscheidung war bisher nur beschrieben, nicht festgeschrieben)
[ "$(lauf '{"tool_input":{"command":"KEIN_REVIEW=1 GH_TOKEN=x gh pr create"}}')" = "2" ] \
  || { echo "FAIL: Fluchtweg wirkt auch NICHT als letztes Praefix - Entscheidung gebrochen" >&2; fehler=1; }

# 14. `gh pr create-branch` -> laesst durch (eigener Subbefehl, kein "gh pr create";
#     bislang nur manuell geprueft, jetzt als Regression festgehalten)
[ "$(lauf '{"tool_input":{"command":"gh pr create-branch --dry-run"}}')" = "0" ] \
  || { echo "FAIL: sperrt gh pr create-branch faelschlich" >&2; fehler=1; }

# 15. `=` im Fliesstext einer Commit-Message -> laesst durch (Fixture-Review Runde 3, 2026-08-21:
#     die Gefahr der erweiterten Wertklasse — "mit = und gh pr create" ist KEIN NAME=wert-Token,
#     weil "mit" nicht UNMITTELBAR von "=" gefolgt wird; die Zuweisungsgruppe darf hier nicht
#     bis zum echten "gh pr create" im Fliesstext durchgreifen)
[ "$(lauf '{"tool_input":{"command":"git commit -m \"irgendwas mit = und gh pr create im Text\""}}')" = "0" ] \
  || { echo "FAIL: Fliesstext mit '=' wird faelschlich als Zuweisungskette gelesen" >&2; fehler=1; }

# 16-17. Quotierter Wert schlaegt die Erkennung NICHT mehr (Fixture-Review Runde 3, 2026-08-21):
#     GH_TOKEN="abc123" gh pr create schluepfte durch, weil die alte Wertklasse am ersten `"`
#     abbrach. JSON-escaped (`\"…\"`), je mit und ohne eingebettetes Leerzeichen im Wert.
#     Die frueheren Pruefungen 18/19 (dieselben Faelle mit ROHEN, unescapten `"`) sind in
#     Runde 4 ERSATZLOS gestrichen: ihre Eingabe war kein gueltiges JSON — der Hook bekommt
#     ein `"` im Befehl immer als `\"`. Sie deckten also keine reale Eingabe, und die einzige
#     Regex-Alternative, die sie trug, war zugleich die einzige, die ueber die Feldgrenze
#     laufen konnte. Ersatz: Pruefung 26 sichert genau die Grenze, die dafuer eingezogen wurde.
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN=\"abc123\" gh pr create"}}')" = "2" ] \
  || { echo "FAIL: escaped-quotierter Wert (ohne Leerzeichen) umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN=\"abc 123\" gh pr create"}}')" = "2" ] \
  || { echo "FAIL: escaped-quotierter Wert (mit Leerzeichen) umgeht die Erkennung" >&2; fehler=1; }

# 18-20. Wertformen mit Leerraum, die KEINE Quotierung im JSON-Sinn sind (Fix-Runde 4).
#     Als Aufzaehlung von Shell-Syntax ist diese Klasse offen — deshalb begrenzt die Wertklasse
#     jetzt an der FELDGRENZE statt an einer Liste erlaubter Schreibweisen. Diese drei sind die
#     Stichprobe darauf, nicht die Liste.
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN='"'"'abc 123'"'"' gh pr create"}}')" = "2" ] \
  || { echo "FAIL: einfach quotierter Wert umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN=$(pass show gh) gh pr create"}}')" = "2" ] \
  || { echo "FAIL: Kommandosubstitution im Wert umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"GH_TOKEN=abc\\ 123 gh pr create"}}')" = "2" ] \
  || { echo "FAIL: backslash-escaptes Leerzeichen im Wert umgeht die Erkennung" >&2; fehler=1; }

# 21-23. JSON-Escapes, die fuer einen Shell-Trenner stehen (Fix-Runde 4). Pruefung 21 ist die
#     groesste und realistischste Luecke der ganzen Reihe: mehrzeilig IST die Normalform des
#     PR-Wegs (erst pushen, dann den PR aufmachen), und sie lief drei Runden lang durch.
[ "$(lauf '{"tool_input":{"command":"git push -u origin f\ngh pr create --fill"}}')" = "2" ] \
  || { echo "FAIL: mehrzeiliger Befehl (\\n) umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"git push -u origin f\rgh pr create --fill"}}')" = "2" ] \
  || { echo "FAIL: \\r als Trenner umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"git push\tgh pr create --fill"}}')" = "2" ] \
  || { echo "FAIL: \\t als Trenner umgeht die Erkennung" >&2; fehler=1; }

# 24. Der Trenner NACH dem Befehl: steht `gh pr create` in der ERSTEN Zeile, folgt auf "create"
#     das `\` des JSON-Escapes — weder Leerraum noch `"` noch Zeilenende. Ohne den Backslash in
#     `ende` bliebe genau diese Haelfte des mehrzeiligen Falls offen.
[ "$(lauf '{"tool_input":{"command":"git push && gh pr create\necho fertig"}}')" = "2" ] \
  || { echo "FAIL: Befehl in der ersten Zeile eines mehrzeiligen Kommandos umgeht die Erkennung" >&2; fehler=1; }

# 25. Der Fluchtweg ueberlebt den neuen Anker (Gegenprobe zu 21): ein Waechter, der die Luecke
#     schliesst und dabei den Notausgang zumauert, wird beim ersten Mal weggeklickt.
[ "$(lauf '{"tool_input":{"command":"git push -u origin f\nKEIN_REVIEW=1 gh pr create --fill"}}')" = "0" ] \
  || { echo "FAIL: Fluchtweg wirkt nach einem Zeilenumbruch nicht" >&2; fehler=1; }

# 26. FELDGRENZE — der tragende Gedanke von Runde 4, und der Ersatz fuer die gestrichenen
#     Pruefungen 18/19. Der Befehl ist hier nur `FOO=x`; `gh pr create` steht in einem ANDEREN
#     JSON-Feld. Die Zuweisungs-Wertklasse darf das unescapte `"` dazwischen nicht ueberspringen.
#     Mutationsgeprueft: `[^"]` -> `.` macht daraus Exit 2 (gemessen), also einen Fehlalarm auf
#     einen Befehl, der die Phrase gar nicht enthaelt.
[ "$(lauf '{"tool_input":{"command":"FOO=x"},"beschreibung":" gh pr create"}')" = "0" ] \
  || { echo "FAIL: Zuweisungswert laeuft ueber die JSON-Feldgrenze" >&2; fehler=1; }

# 27. Der Fluchtweg gilt dem VORKOMMEN, nicht dem ganzen Aufruf (Fix-Runde 5). Ein Heredoc,
#     das `KEIN_REVIEW=1 gh pr create` nur AUFSCHREIBT, gab bis Runde 4 ein echtes
#     `gh pr create` in derselben Zeile frei — derselbe Befund wie Pruefung 6/7, nur ueber
#     die Zeilenanfangs-Position, die der `\n`-Anker aus Runde 4 neu erreichbar machte.
#     Realistisch: wer ueber dieses System schreibt, schreibt den Fluchtweg hin.
[ "$(lauf '{"tool_input":{"command":"cat > d.md <<'"'"'EOF'"'"'\nKEIN_REVIEW=1 gh pr create\nEOF\ngit push && gh pr create --fill"}}')" = "2" ] \
  || { echo "FAIL: erwaehnter Fluchtweg gibt einen ANDEREN gh pr create frei" >&2; fehler=1; }

# 28. Kein Fehlalarm auf `NAME=wert <befehl> … # <text mit gh pr create>` (Fix-Runde 5).
#     Genau die Form, die CLAUDE.md fuer Testlaeufe vorschreibt. Sie sperrte in Runde 4, weil
#     die Wertklasse dort ueber Leerraum hinweglief und alles bis zum naechsten
#     `gh pr create` verschluckte. Die sechs Erwaehnungsproben konnten das nicht finden:
#     allen fehlt ein `NAME=`-Token am Anfang.
[ "$(lauf '{"tool_input":{"command":"TRANSKRIBOR_YTDLP_UPDATE=0 pytest webtool/tests -q   # danach gh pr create"}}')" = "0" ] \
  || { echo "FAIL: Zuweisung + Befehl + Erwaehnung schlaegt faelschlich an" >&2; fehler=1; }

# 29. Ein echtes Vorkommen UNMITTELBAR hinter einem escapten. Haelt fest, warum der Fluchtweg
#     ueber einen SCHNITT laeuft und nicht ueber ein Zaehlen von Treffern gegen escapte
#     Treffer: `grep -o` findet nicht-ueberlappend, das `ende` des escapten Vorkommens frisst
#     den `\n`-Anker des naechsten — die Zaehl-Variante kommt hier auf 1 gegen 1 und laesst
#     durch (nachgebaut und gemessen: Exit 0, wo der Schnitt 2 liefert). Diese Pruefung ist
#     der Grund, diese Variante NICHT zu nehmen; sie wird von derselben Mutation rot wie 27.
[ "$(lauf '{"tool_input":{"command":"KEIN_REVIEW=1 gh pr create\ngh pr create"}}')" = "2" ] \
  || { echo "FAIL: escaptes Vorkommen gibt das direkt folgende echte frei" >&2; fehler=1; }

# 30. DIE ZWEITE SHELL. Die Systembeschreibung nennt PowerShell als PRIMAERE Shell, und
#     gemessen ueber alle Sitzungstranskripte liefen 23 von 187 `gh pr create` dieses Projekts
#     darueber — 12% aller PR-Eroeffnungen, zuletzt am 2026-08-15. Der Waechter hing bis zum
#     Abschlussreview allein am Matcher "Bash".
#     Was DIESE Pruefung zeigt: das Skript liest Roh-JSON und ist damit shell-AGNOSTISCH —
#     die reale PowerShell-Form (`Set-Location <pfad>; gh pr create …`, Backslashes im Pfad
#     als `\\` im JSON) trifft ueber den `;`-Anker. Was sie NICHT zeigt: dass der Hook bei
#     einem PowerShell-Aufruf auch AUFGERUFEN wird — das haengt am zweiten Matcher-Eintrag in
#     `.claude/settings.json`, den kein Selbsttest liest (bewusst offen gelassen, eigenes
#     Issue). Faellt der Eintrag heraus, bleibt diese Pruefung gruen.
[ "$(lauf '{"tool_input":{"command":"Set-Location E:\\Git\\Transkribor; gh pr create --base master --head feat/x"}}')" = "2" ] \
  || { echo "FAIL: reale PowerShell-Form umgeht die Erkennung" >&2; fehler=1; }

# 31-35. DER TRENNER NACH DEM BEFEHL, als KLASSE. Pruefung 24 stellte diese Frage und deckte
#     genau einen Fall ab (den Backslash). Alles andere lief durch: hinter `create` steht in
#     jeder der Pruefungen 1-29 entweder Leerraum, `"`, `\` oder das Zeilenende — die Luecke
#     konnte strukturell von keiner gefunden werden. Gemessen am Stand davor: `;`, `&&`, `|`
#     und `&` unmittelbar hinter `create` ergaben je Exit 0.
#     35 ist die frueher als „geparkt" gefuehrte Klammer-Luecke: sie war nie eine eigene
#     Klasse, sondern das `)`-Mitglied dieser. `$(gh pr create)` faellt mit derselben Zeile.
[ "$(lauf '{"tool_input":{"command":"gh pr create;echo x"}}')" = "2" ] \
  || { echo "FAIL: ; unmittelbar hinter create umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"gh pr create&&echo x"}}')" = "2" ] \
  || { echo "FAIL: && unmittelbar hinter create umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"gh pr create|cat"}}')" = "2" ] \
  || { echo "FAIL: | unmittelbar hinter create umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"gh pr create&"}}')" = "2" ] \
  || { echo "FAIL: & unmittelbar hinter create umgeht die Erkennung" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"$(gh pr create)"}}')" = "2" ] \
  || { echo "FAIL: Kommandosubstitution (die frueher geparkte Klammer) umgeht die Erkennung" >&2; fehler=1; }

# 36. GEGENPROBE zur erweiterten `ende`-Klasse — und der Grund, warum `-` NICHT darin steht.
#     Pruefung 14 deckt den Unterbefehl ohne Trenner ab; diese hier haengt einen echten
#     Trenner HINTER den Unterbefehl. Waere `ende` zu weit (etwa `[^[:alnum:]]`), schluege sie
#     auf `create-branch` an — ein Fehlalarm auf einem Befehl, der nichts eroeffnet, und ein
#     Waechter mit Fehlalarmen wird abgeschaltet.
[ "$(lauf '{"tool_input":{"command":"gh pr create-branch --dry-run; echo fertig"}}')" = "0" ] \
  || { echo "FAIL: create-branch mit nachfolgendem Trenner schlaegt faelschlich an" >&2; fehler=1; }

# 37-38. DER POWERSHELL-FLUCHTWEG (Fix-Runde 6, Rereview 2026-08-21). Die Bash-Form
#     `KEIN_REVIEW=1 gh pr create` ist in PowerShell ein CommandNotFound; `$env:KEIN_REVIEW=1`
#     sperrte bis hierher TROTZDEM, weil weder Zuweisungs- noch Ankerklasse `$env:` kennen —
#     der Waechter lief auf der primaeren Shell dieses Rechners ohne den Notausgang, den sein
#     eigener Kopfkommentar fuer zwingend erklaert. 37 ist die Positivprobe, 38 haelt dieselbe
#     Enge wie beim Bash-Praefix fest: NICHTS ausser `;` und Leerraum zwischen Fluchtweg und
#     Befehl, sonst wirkt er nicht (derselbe Massstab wie Pruefung 27 fuer die Bash-Form).
[ "$(lauf '{"tool_input":{"command":"$env:KEIN_REVIEW=1; gh pr create --fill"}}')" = "0" ] \
  || { echo "FAIL: PowerShell-Fluchtweg wirkt nicht" >&2; fehler=1; }
[ "$(lauf '{"tool_input":{"command":"$env:KEIN_REVIEW=1; echo hi; gh pr create --fill"}}')" = "2" ] \
  || { echo "FAIL: PowerShell-Fluchtweg wirkt auch MIT Text dazwischen - kein Loch geschlossen" >&2; fehler=1; }

# 39-40. DER NACHWEIS MUSS ZU DIESEM BRANCH GEHOEREN (CodeRabbit an PR #325). Der Anker war
#     der ABZWEIGPUNKT, und der liegt vor der Arbeit statt an ihrem Anfang — Berichte sind
#     untracked und ueberleben jeden Branchwechsel. Gemessen an diesem Repo am 2026-08-22:
#     6 liegende review-*.md waren neuer als die master-Spitze, jede frische Abzweigung waere
#     also ohne eigenes Review durchgelassen worden.
#     WEGWERF-REPO statt der echten Zeitstempel dieses Branches: die Probe soll auf jedem
#     Branch dasselbe messen, und sie braucht Daten, die hier niemand hat.
#     BEIDE Richtungen, und beide sind zugleich Mutationsanker:
#     39 wird rot, sobald wieder der Abzweigpunkt zaehlt (der Bericht von 01-02 liegt danach
#     im Fenster). 40 wird rot, sobald statt %aI wieder %cI zaehlt — das Commit traegt
#     bewusst ein spaeteres Committer-Datum (01-09), so wie es ein Rebase auf einen neueren
#     master hinterlaesst; der eigene Bericht von 01-04 fiele dann aus dem Fenster.
hookabs="$PWD/$H"
lauf_in() { printf '%s' "$2" | CLAUDE_PROJECT_DIR="$1" bash "$hookabs" >/dev/null 2>&1; echo $?; }
wr=$(mktemp -d)
(
  cd "$wr" || exit 1
  git init -q . && git symbolic-ref HEAD refs/heads/master
  GIT_AUTHOR_DATE="2020-01-01T00:00:00+00:00" GIT_COMMITTER_DATE="2020-01-01T00:00:00+00:00"     git -c user.email=t@t -c user.name=t commit -q --allow-empty -m basis
  git checkout -q -b feat
  GIT_AUTHOR_DATE="2020-01-03T00:00:00+00:00" GIT_COMMITTER_DATE="2020-01-09T00:00:00+00:00"     git -c user.email=t@t -c user.name=t commit -q --allow-empty -m arbeit
) >/dev/null 2>&1

touch -d "2020-01-02 00:00:00 +0000" "$wr/review-fremd.md"
[ "$(lauf_in "$wr" "$PR")" = "2" ]   || { echo "FAIL: ein Bericht von VOR dem ersten Commit dieses Branches gibt ihn frei" >&2; fehler=1; }

touch -d "2020-01-04 00:00:00 +0000" "$wr/review-eigen.md"
[ "$(lauf_in "$wr" "$PR")" = "0" ]   || { echo "FAIL: sperrt TROTZ eigenem Bericht (Committer-Datum statt Autor-Datum?)" >&2; fehler=1; }
rm -rf "$wr"

[ $fehler -eq 0 ] && echo "OK"
exit $fehler
