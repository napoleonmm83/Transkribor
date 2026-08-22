# Routing-Overlay: Transkribor

Ergänzt `~/.claude/routing.md`. Bei gleichem Aufgabentyp gewinnt diese Datei.

| Aufgabentyp | Wer | Modell · Effort | Pflicht-Skill |
|---|---|---|---|
| Nach JEDEM Fix, Stufe 1 | `pruefer-gegnerisch` | **fable** · high | `superpowers:requesting-code-review` |
| Nach JEDEM Fix, Stufe 2 | Haupt-Loop | — | `coderabbit:coderabbit-review` |
| Nach jedem Fix MIT Test | `mutationsprobe` | **opus** · low | — |
| Fix an Speicher-, Job- oder Prompt-Pfad | `was-erlaubt-der-fix-neu` | **opus** · high | — |
| Offener Punkt am Ende einer Arbeit | Haupt-Loop | — | `befund` |
| Release | Haupt-Loop | — | `release` |
| Sichtbare Änderung im Frontend | `browser-beleg` | **sonnet** · medium | — |

`mutationsprobe` braucht **drei** Eingaben: die geänderte Stelle, den Test, der sie absichern
soll, und den Testbefehl. Hier stand „nach jedem Test" — damit wurde ein Agent, der echten
Quelltext **editiert**, auch für Tests ohne Fix losgeschickt, denen zwei der drei Eingaben
fehlen (CodeRabbit an PR #325). Die Agentendatei sagte von Anfang an „nach jedem Fix mit Test";
die Tafel widersprach ihr.

## Reihenfolge, die nicht verhandelbar ist

`superpowers:requesting-code-review` **zuerst**, dann CodeRabbit. Begründung in `CLAUDE.md`:
CodeRabbits Kontingent ist knapp; es auf einen Diff zu verbrauchen, in dem noch
subagent-findbare Fehler stecken, verschenkt den einzigen fremden Blick.

## Was hier NICHT hingehört

Die Modellwahl der **App** (`correct.py` → `claude -p --model …`) ist eine Nutzereinstellung
und hat mit diesem Routing nichts zu tun.
