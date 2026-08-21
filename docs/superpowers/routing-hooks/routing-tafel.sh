#!/usr/bin/env bash
# UserPromptSubmit — spielt die Routing-Kurzfassung als additionalContext ein.
#
# WARUM eine Kurzfassung und nicht die ganze Tafel: UserPromptSubmit-Injektionen
# landen im Turn und BLEIBEN in der Historie — sie ersetzen einander nicht, sie
# stapeln sich. Anthropics eigener ausgelieferter Hook haelt deshalb Sitzungszustand
# (atomic_check_and_mark_warning: "False if it was already shown"). Die volle Tafel
# waeren ~500 Token pro Turn.
#
# WAS DIESE FASSUNG KOSTET, gemessen 2026-08-21: 492 Zeichen. Gezaehlt wird der
# `additionalContext` — nur der landet im Turn:
#   bash routing-tafel.sh </dev/null | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(o.hookSpecificOutput.additionalContext.length)'
# `wc -c` auf die Ausgabe misst die GANZE JSON-Zeile samt Umbruch (584 Byte) und zaehlt damit
# die Huelle mit, die nie injiziert wird — so entstand die zwischenzeitliche Korrektur auf
# "584 Zeichen". Byte ist ausserdem nicht Zeichen: die Zeile hat 583 Byte und 578 Zeichen,
# der Kontext 497 Byte und 492 Zeichen (die `·` der Tafel sind zwei Byte).
# Hier stand davor "~80 Token": daneben, und ohne Messung. Bei ~4 Zeichen je Token sind es
# rund 120.
#
# WARUM JSON und nicht nackter stdout: der einzige belegte Ausgabevertrag ist
# hookSpecificOutput.additionalContext. Ob stdout allein reicht, ist ungemessen —
# also nicht darauf bauen.
#
# Selbsttest:
#   bash ~/.claude/hooks/routing-tafel.test.sh    # OK
#   bash ~/.claude/hooks/routing-tafel.sh </dev/null | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'

cat >/dev/null    # stdin (das Hook-JSON) verwerfen; wir brauchen es nicht

# Die \n sind LITERAL (Backslash + n) und muessen es bleiben: JSON-Strings duerfen
# keinen rohen Zeilenumbruch enthalten. printf '%s' reicht sie unveraendert durch —
# %b wuerde sie expandieren und das JSON zerstoeren.
TAFEL='ROUTING (Details: ~/.claude/routing.md + $CLAUDE_PROJECT_DIR/.claude/routing.md)\nVor der Arbeit: Typ bestimmen, Pflicht-Skill laden, dann delegieren oder Modellhinweis geben.\nReview+Faktencheck=fable · Fix-Nebenwirkung+Mutation=opus · Umsetzung/Doku/Browser=sonnet · Suche/Mechanik=haiku\nDer Haupt-Loop kann sein Modell nicht wechseln — passt es nicht, EINMAL sagen und weiterarbeiten.\nGrosse Arbeiten: ultracode auf Zuruf; Phasen-Modelle dabei NICHT weglassen. Datei-Overlay schlaegt Global.'

printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$TAFEL"
