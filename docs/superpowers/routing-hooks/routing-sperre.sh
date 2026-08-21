#!/usr/bin/env bash
# PreToolUse(Bash) — haelt `gh pr create` an, wenn auf diesem Branch kein Subagent-Review liegt.
#
# CLAUDE.md macht das zur Regel ("Jeder Fix wird geprueft — Review UND Test, ohne Rueckfrage"),
# und die Begruendung ist gemessen: an einem einzigen Nachmittag liefen fuenf PRs mit gruener
# CI durch, drei echte Fehler steckten trotzdem drin. Eine Regel, die nur in Prosa steht,
# faellt weg — genau das ist mit der Bericht-in-eine-Datei-Konvention passiert.
#
# ERKANNT wird das Review an den 25 review-*.md im Projektstamm: eine Spur, die als
# Nebenprodukt echter Arbeit entsteht. Kein neuer Zustand, der driften koennte.
#
# NUR Stufe 1. CodeRabbit BRAUCHT den PR, kann hier also nicht geprueft werden; Mutationsprobe
# und lokaler Funktionstest sind an keinem Dateinamen erkennbar. Eine Stufe verlaesslich ist
# mehr wert als drei wackelige.
#
# Fluchtweg: `KEIN_REVIEW=1 gh pr create …`. Er MUSS existieren (sonst wird der Waechter beim
# ersten Mal weggeklickt) und deckt den bekannten Fall ab, dass der Subagent lief, aber idle
# ohne Bericht zurueckkam — dann steht der Bericht im Transkript statt auf der Platte.
#
# DER TRAGENDE GEDANKE (Fix-Runde 4): begrenzt wird an der FELDGRENZE, nicht am Wert. Drei
# Runden lang wurde die Wertklasse einer Zuweisung um je eine Schreibweise erweitert
# (unquotiert → quotiert → escaped-quotiert) — und Runde 4 war danach vorhersehbar, weil
# Shell-Syntax fuer Werte nicht abschliessend aufzaehlbar ist (`'a b'`, `$(pass show gh)`,
# `abc\ 123`, `${X:-y}`, …). Hier wird Roh-JSON gelesen: darin ist JEDES `"` des Befehls als
# `\"` escaped, ein UNESCAPTES `"` ist also exakt das Feldende.
#
# **Fuer den ANKER traegt dieser Gedanke, fuer den WERT trug er zu weit** (Fix-Runde 5).
# Runde 4 liess den Wert alles ausser einem unescapten `"` enthalten — damit frass er auch
# Leerraum, ganze Woerter und `#`-Kommentare, bis irgendwo `gh pr create` auftauchte.
# Gemessen sperrte danach `TRANSKRIBOR_YTDLP_UPDATE=0 pytest webtool/tests -q  # dann
# gh pr create` — eine Form, die CLAUDE.md ausdruecklich vorschreibt. Der Wert ist deshalb
# wieder EIN Shell-Wort (siehe bei `wert` unten); die Feldgrenze bleibt der Deckel darueber.
#
# Aus demselben Grund steht `\n`/`\r`/`\t` in der Ankerklasse: ein JSON-Escape, das fuer einen
# Shell-Trenner steht, IST einer. Diese Liste ist endlich (RFC 8259 zaehlt die Escapes
# abschliessend auf), im Gegensatz zur Shell-Wertsyntax. Der MEHRZEILIGE Befehl ist dabei kein
# Randfall, sondern die Normalform des PR-Wegs (`git push -u origin f` + Umbruch +
# `gh pr create --fill`) und lief bis Runde 4 ungeprueft durch. Rest-Luecke derselben Klasse:
# ein Unicode-Escape (U+000A als \\u000a geschrieben) statt \n — theoretisch moeglich, vom
# Bash-Werkzeug nie so erzeugt, deshalb benannt statt gebaut.
#
# BEKANNTE, BEWUSSTE Luecke: der Anker prueft eine Textposition im Roh-JSON, keine echte
# Shell-Auswertung. `bash -c "gh pr create"`, `sh -c '...'`, `env FOO=x gh pr create` und ein
# voller Pfad (`/usr/bin/gh pr create`) laufen deshalb OHNE Review durch. Die Ankerklasse
# absichtlich NICHT um `"` oder `/` erweitern: jedes zusaetzliche Zeichen dort erhoeht die
# Fehlalarmrate (echte Woerter, die zufaellig danebenstehen), und ein Waechter mit
# Fehlalarmen wird abgeschaltet — teurer als diese Luecke. Siehe Pruefung 8 im Selbsttest.
#
# ZWEI BENANNTE FEHLALARME — der Preis, beide klein und beide gemessen:
# 1. `git commit -m 'Doku: (FOO="a b" gh pr create erklaert)'` sperrt. Klammer als Anker,
#    danach ein Token der Form NAME=wert, danach die Phrase. Das ist KEIN Preis von Runde 4:
#    gemessen am Stand vor Runde 4 sperrte derselbe Befehl bereits (Exit 2) — er entstand mit
#    der Zuweisungsgruppe in Runde 2/3. Runde 4 behaelt ihn bei.
# 2. Ein mehrzeiliger Befehl, dessen ZWEITE Zeile mit `gh pr create` beginnt, ohne dass er ihn
#    ausfuehrt (Heredoc, das Doku schreibt), sperrt seit Runde 4. Das ist dieselbe Abwaegung,
#    die der Anker `;` seit jeher trifft: `git commit -m "erst dies; gh pr create danach"`
#    sperrt (gemessen), `"erst dies; und dann gh pr create"` nicht. Ein Zeilenumbruch ist ein
#    Trenner wie `;` — nur haeufiger. Fluchtweg in beiden Faellen: `KEIN_REVIEW=1` davor.
#    **Diese Gleichsetzung stimmte in Runde 4 NICHT, und der Unterschied war der Befund von
#    Runde 5:** der `;`-Anker duldet NULL dazwischenstehende Woerter, die damalige Wertklasse
#    unbegrenzt viele — der Heredoc-Fall war also nur ein Einzelfall einer viel groesseren
#    Klasse, nicht die Klasse. Seit der Wert wieder ein Wort ist, deckt sich beides.
#
# Umgebungs-Praefixe (`GH_TOKEN=x gh pr create`) sind dagegen KEINE Luecke, sondern die
# normale Schreibweise desselben Befehls — sie stehen deshalb in der Ankerklasse, nicht nur
# im Kommentar (Fixture-Review Runde 2, 2026-08-21: `GH_TOKEN=abc123 gh pr create` lief
# unerkannt durch, weil die Erkennung selbst nie bis zu "gh" vordrang). `zuweisungen*` deckt
# beliebig viele `NAME=wert`-Praefixe ab, inklusive KEIN_REVIEW=1 — der Fluchtweg-Check
# unten verlangt zusaetzlich, dass KEIN_REVIEW=1 das LETZTE Praefix vor "gh" ist
# (`GH_TOKEN=x KEIN_REVIEW=1 gh pr create` wirkt also, `KEIN_REVIEW=1 GH_TOKEN=x gh pr
# create` nicht) — eine bewusste, kleine Grenze statt eines Nebeneffekts. Ein Praefix AN der
# Variable (`xKEIN_REVIEW=1`) ist eine andere Variable und triggert nichts: die Zuweisungs-
# Gruppe verschluckt das ganze Token, das Literal `KEIN_REVIEW=1` findet dahinter keine
# zweite Gelegenheit.
#
# **Bis Runde 4 band das den Fluchtweg nur an eine BEFEHLSPOSITION, nicht an ein VORKOMMEN.**
# Der Runde-1-Fix („`KEIN_REVIEW=1` muss Praefix sein, nicht irgendwo im Text") galt damit nur
# so weit, wie es Ankerpositionen gab — und der `\n`-Anker aus Runde 4 machte eine neue
# auf: ein Heredoc, das `KEIN_REVIEW=1 gh pr create` bloss AUFSCHREIBT, gab ein echtes
# `gh pr create` in derselben Zeile frei (gemessen, Runde 5). Derselbe Befund wie Runde 1,
# ueber einen neuen Weg. Der Schnitt unten (`rest`) bindet den Fluchtweg jetzt an das
# Vorkommen, vor dem er wirklich steht — die Behauptung traegt erst seitdem unqualifiziert.
#
# Selbsttest:
#   bash .claude/hooks/routing-sperre.test.sh
#   echo '{"tool_input":{"command":"gh pr create"}}' | bash .claude/hooks/routing-sperre.sh; echo $?  # 2

cd "${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}" || exit 0

roh=$(cat)

# Roh-JSON, ohne Parser: ein Waechter, der von einem Interpreter im PATH abhaengt, faellt
# STILL aus, sobald sich der PATH aendert — das war hier schon einmal der Fall (der Satz
# "python fehlt im Git-Bash-PATH, Exit 127" stand hier, uebernommen aus
# kein-pauschales-add.sh; nachgemessen am 2026-08-21 ist python inzwischen wieder im PATH).
# `grep` bleibt trotzdem die richtige Wahl, mit dem Grund, der traegt, nicht mit einer
# Momentaufnahme.
# Der Anker verlangt Befehlsposition: direkt hinter "command":" oder hinter einem
# Shell-Trenner, gefolgt von beliebig vielen `NAME=wert`-Praefixen. Ohne den Anker schlaegt
# der Waechter auch bei Kommandos an, die den Text nur ERWAEHNEN.
#
# Der WERT einer Zuweisung wird NICHT mehr aufgezaehlt, sondern an der Feldgrenze begrenzt
# (siehe „DER TRAGENDE GEDANKE" oben): alles ausser einem unescapten `"`, wobei ein escapter
# (`\"`) ausdruecklich dazugehoert. Damit decken sich `'a b'`, `$(pass show gh)`, `abc\ 123`
# und jede kuenftige Schreibweise ohne weitere Runde ab.
#
# Die frueheren drei Alternativen sind ersatzlos weg. Die eine davon, die ein UNESCAPTES `"`
# ueberspringen konnte (`"[^"]*"`), war zugleich die einzige, die ueber die Feldgrenze laufen
# konnte — und sie trug ausschliesslich zwei Selbsttests, deren Eingabe gar kein gueltiges
# JSON war (Fix-Runde 4).
#
# `ende` laesst neben Leerraum/`"`/Zeilenende auch einen Backslash zu: bei
# `gh pr create\ngit push` folgt auf `create` das `\` des JSON-Escapes, sonst bliebe genau
# der mehrzeilige Fall mit dem Befehl in der ERSTEN Zeile offen (gemessen).
anker='("command":[[:space:]]*"|[;&|(]|\\n|\\r|\\t|^)[[:space:]]*'
# Ein Wert ist EIN Shell-Wort. Leerraum darf nur INNERHALB einer Quotierung stehen —
# `\"…\"` (JSON-escaped), `'…'`, `$(…)` oder ein backslash-escaptes Leerzeichen (im Roh-JSON
# `\\` + Leerzeichen). Alles andere endet am ersten Leerraum.
#
# DER PREIS IST GEMESSEN, nicht geschaetzt: Werte, deren Leerraum in einer HIER NICHT
# aufgezaehlten Quotierung steckt, laufen jetzt wieder durch — `GH_TOKEN=`+Backticks,
# `GH_TOKEN=${T:-a b}` und ein `$( … \"…\" … )` mit Anfuehrungszeichen darin ergaben je
# Exit 0 (unter der permissiven Klasse aus Runde 4: Exit 2). Das ist der bewusste Tausch aus
# Runde 5: unbegrenztes Fressen kostete einen Fehlalarm auf `NAME=wert befehl … # text`,
# also auf der Form, die CLAUDE.md fuer Testlaeufe vorschreibt — ein Fehlalarm auf einem
# taeglichen Befehl ist teurer als eine Luecke bei einer exotischen Quotierung. Wer eine
# davon braucht: hier eine Alternative ergaenzen, nicht die Klasse wieder oeffnen.
wert='(\\"[^"]*\\"|'\''[^'\'']*'\''|\$\([^)"]*\)|\\\\[[:space:]]|[^"[:space:]])*'
zuweisungen="([A-Za-z_][A-Za-z0-9_]*=${wert}[[:space:]]+)*"
ende='([[:space:]"]|\\|$)'
treffer="${anker}${zuweisungen}gh[[:space:]]+pr[[:space:]]+create"

# Erst die Vorkommen HERAUSSCHNEIDEN, an denen KEIN_REVIEW=1 wirklich als Praefix steht,
# dann entscheidet die Erkennung ueber den REST. Zwei unabhaengige greps taten das nicht:
# der Fluchtweg-grep durfte an einem BELIEBIGEN Anker anschlagen und schaltete die Sperre
# damit fuer den GANZEN Aufruf ab (Fixture-Review Runde 5, gemessen: ein Heredoc, das
# `KEIN_REVIEW=1 gh pr create` nur AUFSCHREIBT, gab ein echtes `gh pr create` in derselben
# Zeile frei). Ersetzt wird durch ein Leerzeichen, nicht durch nichts: der Anker wird
# mitgeschnitten, und zwei zusammengeschobene Woerter koennten sonst einen neuen Treffer
# bilden. Nebenwirkung des Schnitts: die Erkennung laeuft jetzt auf `rest` statt auf `roh` —
# genau darin liegt die Bindung, die vorher fehlte.
rest=$(printf '%s' "$roh" | sed -E "s/${anker}${zuweisungen}KEIN_REVIEW=1[[:space:]]+gh[[:space:]]+pr[[:space:]]+create/ /g")
printf '%s' "$rest" | grep -Eq "${treffer}${ende}" || exit 0

basis=$(git log -1 --format=%cI "$(git merge-base master HEAD 2>/dev/null)" 2>/dev/null)
# Kein Abzweigpunkt ermittelbar (kein git, kein master) -> durchlassen. Ein Waechter, der bei
# eigener Unsicherheit sperrt, blockiert Arbeit, ueber die er nichts weiss.
[ -n "$basis" ] || exit 0

find . -maxdepth 1 -name 'review-*.md' -newermt "$basis" 2>/dev/null | grep -q . && exit 0

echo 'Kein Subagent-Review auf diesem Branch: es liegt kein review-*.md, das neuer ist als der' >&2
echo 'Abzweigpunkt von master. CLAUDE.md verlangt superpowers:requesting-code-review ZUERST,' >&2
echo 'dann CodeRabbit — und CodeRabbit braucht den PR, kann hier also nicht geprueft werden.' >&2
echo 'Lief der Review und kam nur idle ohne Bericht zurueck: KEIN_REVIEW=1 gh pr create …' >&2
exit 2
